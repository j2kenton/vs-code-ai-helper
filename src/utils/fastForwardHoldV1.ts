/**
 * bugs4 item 25 (Step 23): the pure decisions behind "Fast Forward obeys its own
 * cards". The loop in `reviewScoreLoop.ts` calls these through hooks that
 * `fastForwardReviewWithAI` supplies; keeping them here lets the rules be tested
 * without a VS Code host.
 */
import type { RoundLedgerEntryV1 } from "../types/taskProgress";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import type { FastForwardHoldV1 } from "./reviewScoreLoop";

/**
 * A card raised since this Fast Forward run started that waits on the owner. The
 * run stops dispatching until it is answered, dismissed or Fast Forward is stopped.
 * Cards from before the run are not this run's to wait on, and an optional card
 * (a notice with a button) never holds the run.
 *
 * @param isBlocking `isBlockingDecisionV1` (injected so this stays host-free).
 */
export function findBlockingDecisionSinceRunStartV1(
  pending: readonly WorkflowDecisionV1[],
  runStartedAtMs: number,
  isBlocking: (decision: WorkflowDecisionV1) => boolean
): string | undefined {
  for (const decision of pending) {
    if (decision.state !== "pending") {
      continue;
    }
    const createdMs = Date.parse(decision.createdAt);
    if (Number.isNaN(createdMs) || createdMs < runStartedAtMs) {
      continue;
    }
    if (!isBlocking(decision)) {
      continue;
    }
    const headline = decision.whatHappened.trim().split(/\r?\n/)[0] ?? "";
    return headline.length > 0 ? headline : decision.decisionKey;
  }
  return undefined;
}

/**
 * Whether the most recent Apply Review started since the run began ended terminal
 * with a known, empty change list. An unknown list (no `filesChanged`) is not
 * "changed nothing": that stays conservative and does not stop the run.
 */
export function latestApplyReviewChangedNothingV1(
  ledger: readonly RoundLedgerEntryV1[] | undefined,
  runStartedAtMs: number
): boolean {
  const rows = (ledger ?? []).filter((row) => {
    const startedMs = Date.parse(row.startedAt);
    return row.mode === "apply-review" && !Number.isNaN(startedMs) && startedMs >= runStartedAtMs;
  });
  const latest = rows.at(-1);
  if (!latest || latest.state === "scheduled" || latest.state === "open") {
    return false;
  }
  const files = latest.outcome?.filesChanged;
  return Array.isArray(files) && files.length === 0;
}

/**
 * Whether a plan item's test requirement can only be met by a run the owner does by hand: a Docker
 * drill, or a command that needs a live Postgres. Editing rounds are refused `docker` and have no
 * database, so no round can produce that report. Deliberately narrow; an unclear item is not owner-only.
 */
export function isOwnerOnlyTestRunItemV1(itemText: string): boolean {
  return /\bdocker\b|--require-postgres\b|\bowner[- ]run\b|\bruns? (?:it )?by hand\b/i.test(itemText);
}

/**
 * bugs4 item 11 (Step 23): whether the only thing holding a plan open is test evidence that an
 * editing round cannot produce. Then dispatching one more Apply Review is wasted provider time:
 * the last editing round's test commands were refused with nothing changed since, or the project
 * offers no targeted test command a round can run. Returns the reason, or undefined when a round
 * could still make progress (unticked items remain, or some provisional item needs no test run).
 *
 * Conservative on purpose: any unticked item, or any provisional item that is not test-dependent,
 * keeps the normal path. The test-evidence rule itself is untouched.
 */
export function unproducibleTestEvidenceHoldV1(input: {
  readonly uncheckedCount: number;
  readonly provisional: readonly { readonly testDependent: boolean; readonly text?: string }[];
  readonly lastRoundTestsRefused: boolean;
  /** True when the project exposes a targeted test command a round could run. */
  readonly hasAllowedTestCommand: boolean;
  /** True when files changed since the round that reported the refusal. */
  readonly changedSinceRefusal?: boolean;
}): string | undefined {
  if (input.uncheckedCount > 0 || input.provisional.length === 0) {
    return undefined;
  }
  if (!input.provisional.every((item) => item.testDependent)) {
    return undefined;
  }
  const count = input.provisional.length;
  const items = `${count} built ${count === 1 ? "item is" : "items are"} waiting only for a passing test report`;
  if (input.provisional.every((item) => item.text !== undefined && isOwnerOnlyTestRunItemV1(item.text))) {
    return (
      `${items}, and every one needs a test run only you can do (a Docker or live-database run that an ` +
      "editing round is refused). Run it yourself and record the run, or settle the items by decision"
    );
  }
  if (input.lastRoundTestsRefused && input.changedSinceRefusal !== true) {
    return (
      `${items}, and the last editing round's test commands were refused, so another round cannot produce ` +
      "that evidence. Allow the test command, run it yourself and record the run, or settle the items by decision"
    );
  }
  if (!input.hasAllowedTestCommand) {
    return (
      `${items}, and this project offers no targeted test command a round can run. ` +
      "Run the tests yourself and record the run, or settle the items by decision"
    );
  }
  return undefined;
}

/** The chat line for a Fast Forward that stopped on purpose, with the reason and the way on. */
export function describeFastForwardHoldV1(hold: FastForwardHoldV1, stageName: string, attempts: number): string {
  const rounds = `${attempts} round${attempts === 1 ? "" : "s"} dispatched`;
  switch (hold.kind) {
    case "pending-decision":
      return (
        `Fast Forward (${stageName}) is waiting for your answer: "${hold.detail}". ` +
        `Nothing more is dispatched until you answer or dismiss that card (${rounds}).`
      );
    case "no-change-decision":
      return (
        `Fast Forward (${stageName}) stopped: the last Apply Review changed no files and raised a decision ` +
        `("${hold.detail}"). Re-reviewing the same tree would only repeat it. Answer that card to continue (${rounds}).`
      );
    case "test-evidence-unproducible":
      return (
        `Fast Forward (${stageName}) stopped: ${hold.detail}. ` +
        `Another Apply Review would change nothing, so none was dispatched (${rounds}). ` +
        "The open items and the ways on are in the decision card that follows."
      );
    case "evidence-gap":
      return (
        `Fast Forward (${stageName}) stopped: ${hold.detail}. ` +
        `No Apply Review was dispatched for it, because another round cannot produce a test report that counts (${rounds}). ` +
        "The items and the ways on are in the decision card that follows."
      );
    case "standing-blockers":
      return (
        `Fast Forward (${stageName}) stopped: every remaining blocker is one another round cannot clear ` +
        `(${hold.detail}). Spending a round on them alone would repeat the same result (${rounds}). ` +
        "The question is on the decision card that follows."
      );
    case "partial-scope":
      return (
        `Fast Forward (${stageName}) stopped: ${hold.detail}. ` +
        `Reviewing the same list again would repeat that, so no round was dispatched (${rounds}). ` +
        "The way on is the decision card that follows: add the missing files, or accept the gap."
      );
    case "progress-gate":
      return (
        `Fast Forward (${stageName}) stopped: ${hold.detail}. ` +
        `Nothing more is dispatched until you answer the "This isn't moving" card (${rounds}).`
      );
    case "clean-review":
      return (
        `Fast Forward (${stageName}) stopped: ${hold.detail}. ` +
        `It follows the clean-review path instead of dispatching another round (${rounds}).`
      );
  }
}
