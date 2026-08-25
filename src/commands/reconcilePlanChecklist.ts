import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  getCanonicalImplementationUri,
  readPlanOfRecordV1,
} from "../utils/implementationArtifactResolver";
import { readTextIfExists, statIfExists, writeTextFile } from "../utils/fileUtils";
import {
  listUncheckedChecklistItemTextsV1,
  filterUncheckedPlanItemsV1,
  normalizeChecklistItemTextV1,
  mergeChecklistProgressV1,
  MergeChecklistProgressResultV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1, parseReadiness } from "../utils/reviewReadiness";
import { IMPL_REVIEW_STAGES, STAGE_ARTIFACT_FILENAMES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { WorkflowDecisionEvidenceItemV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { getExtensionContextV1 } from "../utils/extensionContextV1";
import { ChatTarget } from "../views/chatView";
import { buildSyntheticVerifiedCompleteSummaryV1 } from "./applyReviewerVerifiedTicks";

type ReconcileArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; decisionId?: string };

function normalizeArg(
  arg: ReconcileArg | undefined
): { canonicalId?: string; taskFolderPath?: string; decisionId?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  // Explicit ids first, and the tree-node branch guarded: a dispatcher can
  // hand over a partial `task` carrying only `progress`, which an unguarded
  // `arg.task.folderUri.fsPath` turns into a TypeError.
  const explicit = arg as { canonicalId?: string; taskFolderPath?: string; decisionId?: string };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      decisionId: explicit.decisionId,
    };
  }
  if ("task" in arg && arg.task?.folderUri) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  return undefined;
}

/**
 * Evidence the system already holds for a checklist-reconciliation decision
 * (case 4 — module doc comment on `reconcilePlanChecklist`): for each of the
 * implementation review stages, whether its `## Verified Complete` list (via
 * the SAME text-matching tolerance `applyReviewerVerifiedTicks.ts` already
 * uses — `parseReviewVerifiedCompleteV1` + `filterUncheckedPlanItemsV1` —
 * deliberately not a second normaliser) names any of the plan's currently
 * unticked items, plus the review's own readiness score, plus (when the
 * caller has one in scope) the outcome of merging the triggering round's own
 * summary against the plan via `mergeChecklistProgressV1` — the claim the
 * round itself made, separate from what the review later verified. Round-window
 * file mtimes are omitted: no durable field records the boundary of the round
 * that set the latch, and fabricating one would be worse than the honest
 * evidence this function does hold (risk note, plan.md). The round-summary
 * claim is the same shape of honesty: shown when the caller has it in scope
 * (the two reviewActions.ts call sites that already computed it for THIS
 * round), stated as unavailable otherwise (e.g. the command invoked directly
 * from the task tree, with no round in scope) — never fabricated.
 */
/**
 * Renders the triggering round's own `mergeChecklistProgressV1` outcome as
 * an evidence-block line, or states plainly that none is available for this
 * invocation. Never recomputed here from a stale summary — the caller passes
 * whatever it already computed for the SAME round the decision is about, or
 * nothing at all.
 */
function describeRoundSummaryChecklistClaimV1(
  claim: MergeChecklistProgressResultV1 | undefined
): string {
  if (!claim) {
    return "Not available for this invocation — no triggering round's summary was in scope.";
  }
  switch (claim.kind) {
    case "no-report":
      return "The triggering round's summary echoed no checklist at all.";
    case "unchanged":
      return "The triggering round's summary echoed the checklist with no new ticks.";
    case "no-match":
      return claim.unmatchedSample.length > 0
        ? `The triggering round claimed ${claim.unmatchedSample.length} tick(s) that matched no plan item ` +
          `text:\n${claim.unmatchedSample.map((text) => `- ${text}`).join("\n")}`
        : "The triggering round claimed tick(s) that matched no plan item text.";
    case "merged":
      return claim.retroactiveTicks && claim.retroactiveTicks.length > 0
        ? `The triggering round's summary landed ${claim.retroactiveTicks.length} tick(s) with evidence:\n` +
          claim.retroactiveTicks.map((tick) => `- ${tick.itemText} — ${tick.evidence}`).join("\n")
        : "The triggering round's summary landed new tick(s) against the checklist.";
    default:
      return "Not available for this invocation — no triggering round's summary was in scope.";
  }
}

/**
 * Scans every implementation-review stage artifact for this task and returns
 * the currently-unchecked plan items each one names as verified complete
 * (via `parseReviewVerifiedCompleteV1` + `filterUncheckedPlanItemsV1` — the
 * same text-matching tolerance `applyReviewerVerifiedTicks.ts` already uses,
 * deliberately not a second normaliser). `coveredItems` is deduplicated by
 * `normalizeChecklistItemTextV1` and carries the plan-of-record's own raw
 * item text, so it can be fed straight into
 * `buildSyntheticVerifiedCompleteSummaryV1` / `mergeChecklistProgressV1` for
 * ticking, or reported to a human as evidence. Shared by
 * `gatherReconcileEvidenceV1` (human-facing evidence) and
 * `runAutomaticChecklistReconciliationV1` (the bounded automatic pass) so
 * the two can never disagree about what the reviews on file actually cover.
 */
async function computeReviewVerifiedCoverageV1(
  folderUri: vscode.Uri,
  planOfRecord: string
): Promise<{
  coveredItems: string[];
  perStage: { stage: TaskStage; readiness?: string; matches: string[]; hasArtifact: boolean }[];
}> {
  const coveredKeys = new Set<string>();
  const coveredItems: string[] = [];
  const perStage: { stage: TaskStage; readiness?: string; matches: string[]; hasArtifact: boolean }[] = [];
  for (const stage of IMPL_REVIEW_STAGES) {
    const filename = STAGE_ARTIFACT_FILENAMES[stage];
    if (!filename) continue;
    const content = await readTextIfExists(vscode.Uri.joinPath(folderUri, filename));
    if (content === undefined) {
      perStage.push({ stage, matches: [], hasArtifact: false });
      continue;
    }
    const readiness = parseReadiness(content);
    const verified = parseReviewVerifiedCompleteV1(content);
    const matches = filterUncheckedPlanItemsV1(planOfRecord, verified.items);
    for (const item of matches) {
      const key = normalizeChecklistItemTextV1(item);
      if (!coveredKeys.has(key)) {
        coveredKeys.add(key);
        coveredItems.push(item);
      }
    }
    perStage.push({ stage, readiness: readiness.label, matches, hasArtifact: true });
  }
  return { coveredItems, perStage };
}

async function gatherReconcileEvidenceV1(
  folderUri: vscode.Uri,
  planOfRecord: string,
  pendingImplReviewFiles: readonly string[] | undefined,
  roundSummaryChecklistClaim: MergeChecklistProgressResultV1 | undefined,
  pendingOperationEvidence?: readonly PendingOperationEvidenceItemV1[]
): Promise<{ evidence: WorkflowDecisionEvidenceItemV1[]; allUncheckedCovered: boolean; coveredItemsCount: number }> {
  const evidence: WorkflowDecisionEvidenceItemV1[] = [];
  const unchecked = listUncheckedChecklistItemTextsV1(planOfRecord, Number.MAX_SAFE_INTEGER);
  evidence.push({
    label: "Unchecked plan items",
    detail:
      unchecked.total === 0
        ? "None — the checklist already shows every item complete."
        : `${unchecked.total} item(s) unticked:\n${unchecked.items.map((item) => `- ${item}`).join("\n")}`,
  });

  evidence.push({
    label: "pendingImplReviewFiles",
    detail:
      pendingImplReviewFiles !== undefined && pendingImplReviewFiles.length > 0
        ? `${pendingImplReviewFiles.length} file(s) changed by a round whose checklist state was not recorded:\n${pendingImplReviewFiles.map((f) => `- ${f}`).join("\n")}`
        : "None recorded.",
  });

  evidence.push({
    label: "Round-summary checklist claims",
    detail: describeRoundSummaryChecklistClaimV1(roundSummaryChecklistClaim),
  });

  // Plan Part 4, "Surface evidence for explicit human attestation": tier-2
  // (applied-operation) candidates are never ticked automatically (EIGHTH
  // review round), so this is the ONLY place they become visible to the
  // human who can attest them — by hand, in plan-final.md, or by re-running
  // this same round's evidence through `applyReviewerVerifiedTicks` once a
  // review names them verified complete.
  if (pendingOperationEvidence !== undefined && pendingOperationEvidence.length > 0) {
    evidence.push({
      label: "Applied-operation evidence (pending human attestation, not ticked automatically)",
      detail:
        `${pendingOperationEvidence.length} unticked item(s) have lexical corroboration from this round's own ` +
        `applied operations — not a reviewer's judgement, so none of these were ticked:\n` +
        pendingOperationEvidence.map(({ item, evidence: itemEvidence }) => `- ${item} — ${itemEvidence}`).join("\n"),
    });
  }

  const { coveredItems, perStage } = await computeReviewVerifiedCoverageV1(folderUri, planOfRecord);
  const coveredKeys = new Set(coveredItems.map((item) => normalizeChecklistItemTextV1(item)));
  // Tier-1 candidates, aggregated across every review stage and deduplicated
  // (`coveredItems`) — surfaced the same way tier 2's evidence is above, so a
  // reader sees both candidate tiers without cross-referencing the per-stage
  // verdicts below. NINTH review round: this is the evidence backing the
  // "Apply N Reviewer-Verified Tick(s)" option `postReconcilePlanChecklistDecisionV1`
  // adds when `coveredItems.length > 0` — never ticked here, only listed.
  if (coveredItems.length > 0) {
    evidence.push({
      label: "Review-verified evidence (pending explicit selection, not ticked automatically)",
      detail:
        `${coveredItems.length} unticked item(s) are named verified complete by an implementation review ` +
        `already on file:\n${coveredItems.map((item) => `- ${item}`).join("\n")}`,
    });
  }
  for (const entry of perStage) {
    if (!entry.hasArtifact) {
      evidence.push({ label: `${STAGE_DISPLAY_NAMES[entry.stage]} verdict`, detail: "No review artifact found." });
      continue;
    }
    evidence.push({
      label: `${STAGE_DISPLAY_NAMES[entry.stage]} verdict`,
      detail:
        `Readiness: ${entry.readiness}. ` +
        (entry.matches.length > 0
          ? `Names ${entry.matches.length} of the unticked item(s) above as verified complete:\n${entry.matches.map((item) => `- ${item}`).join("\n")}`
          : "Names none of the currently unticked items as verified complete."),
    });
  }

  const allUncheckedCovered = unchecked.total > 0 && unchecked.items.every((item) => coveredKeys.has(normalizeChecklistItemTextV1(item)));
  return { evidence, allUncheckedCovered, coveredItemsCount: coveredItems.length };
}

/**
 * Outcome of `runAutomaticChecklistReconciliationV1`. Deliberately narrow —
 * see the function's own doc comment for why each kind is or is not safe to
 * exempt a round from `checklistProgressUnreliable`.
 */
/**
 * A tier-2 (applied-operation) candidate: the pass's guards all passed, but
 * this is lexical corroboration, not a reviewer's judgement (see
 * `runAutomaticChecklistReconciliationV1`'s doc comment) — 2026-08-21 EIGHTH
 * review round, the architectural blocker that persisted through seven prior
 * hardening rounds of the guards themselves: no amount of guard-tightening
 * changes what KIND of evidence a lexical match is, so tier 2 no longer
 * writes `[x]` on its own strength at all. It is surfaced here as a candidate
 * for explicit human attestation instead (plan Part 4, "Changes from previous
 * plan": "Lexical operation evidence is advisory only, regardless of
 * confidence").
 */
export interface PendingOperationEvidenceItemV1 {
  readonly item: string;
  readonly evidence: string;
}

export type AutomaticChecklistReconciliationOutcomeV1 =
  | {
      /**
       * Evidence was found — tier 1 (`reviewVerifiedItems`, a review already
       * on file names the item verified complete) and/or tier 2
       * (`pendingOperationEvidenceItems`, lexical corroboration from this
       * round's own applied operations). Neither tier writes plan-final.md
       * or ticks anything here (2026-08-21 NINTH review round — see this
       * function's own doc comment): even tier-1 evidence, which an earlier
       * revision auto-merged on the strength of the reviewer's own
       * judgement, is now surfaced only as a candidate for explicit human
       * selection, applied through `applyReconciliationReviewVerifiedTicksV1`
       * (which reuses `applyReviewerVerifiedTicks.ts`'s own merge
       * primitives) — never automatically.
       */
      readonly kind: "candidatesFound";
      readonly reviewVerifiedItems: readonly string[];
      readonly pendingOperationEvidenceItems: readonly PendingOperationEvidenceItemV1[];
      /** Other unticked items this pass cannot rule unrelated to this round's changes, covered by neither tier. */
      readonly unresolvedOverlap: readonly string[];
    }
  | { readonly kind: "nothingCovered" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Extracts inline-code-span file-path-looking tokens from a checklist item's
 * text (e.g. `` `src/commands/reconcilePlanChecklist.ts:247-257` `` or
 * `` `runAutomaticChecklistReconciliationV1` `` — only the former counts).
 * A candidate is treated as a path when it contains a path separator or ends
 * in a recognized source/doc extension (optionally followed by a `:line` or
 * `:start-end` locator), so an ordinary identifier or CLI flag quoted in the
 * same style (`` `mergeChecklistProgressV1` ``, `` `--fix` ``) is not
 * mistaken for one. Returned paths are normalized (backslashes to slashes,
 * a leading `./` stripped, any trailing `:line` locator stripped, lower-
 * cased) for comparison via `filePathsOverlapV1`.
 */
function extractInlineFilePathsV1(itemText: string): string[] {
  const paths: string[] = [];
  const codeSpanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeSpanRe.exec(itemText)) !== null) {
    const candidate = match[1];
    if (candidate === undefined) {
      continue;
    }
    const looksLikePath =
      /[\\/]/.test(candidate) ||
      /\.(ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml|ps1|sh|mts|cts)(:\d+(-\d+)?)?$/i.test(candidate);
    if (looksLikePath) {
      paths.push(
        candidate
          .replace(/\\/g, "/")
          .replace(/^\.\//, "")
          .replace(/:\d+(-\d+)?$/, "")
          .toLowerCase()
      );
    }
  }
  return paths;
}

/**
 * True when two normalized paths (from `extractInlineFilePathsV1` or a
 * round's own `changedPaths`, both lower-cased and slash-normalized) name
 * the same file, allowing one side to be a path-suffix of the other — a
 * plan item naming `reconcilePlanChecklist.ts` should match a round's
 * `src/commands/reconcilePlanChecklist.ts`, but must not match
 * `oldReconcilePlanChecklist.ts` via a naive substring check.
 */
function filePathsOverlapV1(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const segmentsA = a.split("/");
  const segmentsB = b.split("/");
  const [shorter, longer] = segmentsA.length <= segmentsB.length ? [segmentsA, segmentsB] : [segmentsB, segmentsA];
  return longer.slice(longer.length - shorter.length).join("/") === shorter.join("/");
}

/**
 * True when a checklist item's own text reads as a removal — the ONLY
 * circumstance under which a `deleteFile`-only operation receipt is allowed
 * to satisfy tier 2 (see `runAutomaticChecklistReconciliationV1`'s doc
 * comment, "Kind-vs-intent"). Deliberately a narrow, explicit word list
 * rather than an inferred classifier: a false negative here just leaves an
 * item unresolved (safe), while a false positive would let a delete receipt
 * satisfy an addition/fix requirement (the exact failure this guard exists
 * to prevent).
 */
function itemImpliesDeletionV1(itemText: string): boolean {
  return /\b(delete[sd]?|deleting|remov(?:e[sd]?|ing)|drop(?:s|ped|ping)?|strip(?:s|ped|ping)?|eliminat(?:e[sd]?|ing))\b/i.test(
    itemText
  );
}

/**
 * Items excluded from tier 2 because a path they name is shared with at
 * least one OTHER currently-unticked item (see "Exclusivity" in
 * `runAutomaticChecklistReconciliationV1`'s doc comment) — a receipt at a
 * shared path cannot be attributed to just one of the items naming it, so
 * the whole group is excluded, symmetrically, rather than guessing a winner.
 */
function computeTier2AmbiguousItemsV1(
  itemsWithPaths: readonly { item: string; paths: readonly string[] }[]
): Set<string> {
  const ambiguous = new Set<string>();
  for (let i = 0; i < itemsWithPaths.length; i++) {
    for (let j = i + 1; j < itemsWithPaths.length; j++) {
      const a = itemsWithPaths[i]!;
      const b = itemsWithPaths[j]!;
      const overlaps = a.paths.some((pa) => b.paths.some((pb) => filePathsOverlapV1(pa, pb)));
      if (overlaps) {
        ambiguous.add(a.item);
        ambiguous.add(b.item);
      }
    }
  }
  return ambiguous;
}

/**
 * Common words in a checklist item's own boilerplate ("Add the X in `path`")
 * that carry no evidentiary weight for `extractContentCheckTokensV1` — kept
 * deliberately short: a false inclusion here just discards a weak token
 * (safe), while a false exclusion could let unrelated content trivially
 * satisfy corroboration.
 */
const CONTENT_CHECK_STOPWORDS_V1 = new Set([
  "add", "adds", "added", "adding", "the", "a", "an", "to", "in", "for", "and", "or", "of", "with",
  "this", "that", "these", "those", "its", "it", "on", "as", "by", "is", "are", "was", "were",
  "should", "must", "will", "not", "no", "use", "uses", "used", "using", "via", "when", "then",
  "also", "so", "if", "which", "from", "into", "file", "new", "create", "creates", "created",
  "creating", "fix", "fixes", "fixed", "fixing", "update", "updates", "updated", "updating",
  "implement", "implements", "implemented", "implementing", "make", "makes", "making", "ensure",
  "ensures", "ensuring", "each", "every", "any", "all", "one", "here", "there", "than", "only",
]);

function escapeRegExpLiteralV1(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Content-check tokens for tier 2's content-corroboration guard (2026-08-21
 * THIRD and FOURTH review rounds — see `SealedAppliedOperationV1.contentExcerpt`'s
 * doc comment for why this exists): tokens that, if ALL found in what this
 * round's covering operation(s) actually wrote, corroborate that the item's
 * own described requirement — not just SOME change at the right path, and not
 * just ONE word from the item's own text — is what landed. Combines explicit
 * non-path backtick identifiers (the item quoting a specific symbol/export/
 * flag name is the strongest available signal) WITH significant plain words
 * from the item's own prose, stripped of code spans and common boilerplate
 * (`CONTENT_CHECK_STOPWORDS_V1`) — the FOURTH review round's finding was that
 * returning identifier tokens alone (e.g. just `resolver` for "Add the
 * `resolver` export") let content mentioning the identifier without its
 * accompanying requirement word ("export") still satisfy the guard, so both
 * kinds of token are now required together. An item reduced to zero tokens
 * (all boilerplate, or a code span too short to be meaningful) has nothing
 * left to corroborate against and is handled by the caller as "cannot be
 * verified", never as "nothing to check, so anything satisfies it".
 */
function extractContentCheckTokensV1(itemText: string): string[] {
  const identifierTokens: string[] = [];
  const codeSpanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeSpanRe.exec(itemText)) !== null) {
    const candidate = match[1];
    if (candidate === undefined) {
      continue;
    }
    const looksLikePath =
      /[\\/]/.test(candidate) ||
      /\.(ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml|ps1|sh|mts|cts)(:\d+(-\d+)?)?$/i.test(candidate);
    if (!looksLikePath && candidate.trim().length > 0) {
      identifierTokens.push(candidate.trim());
    }
  }
  const withoutCodeSpans = itemText.replace(/`[^`]*`/g, " ");
  const words = withoutCodeSpans
    .split(/[^A-Za-z0-9_]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !CONTENT_CHECK_STOPWORDS_V1.has(word.toLowerCase()));
  return Array.from(new Set([...identifierTokens, ...words]));
}

/**
 * Case-insensitive markers that, when they appear on a line of a content
 * excerpt, make that whole line inadmissible as tier-2 corroboration
 * (2026-08-21 FIFTH review round — the blocker persisted even with
 * whole-token, all-tokens-required matching, because none of that examines
 * whether the matched line describes completed work or explicitly-flagged
 * FUTURE work: the review's own cited counter-example,
 * `// TODO: export resolver after migration`, contains both content-check
 * tokens for "Add the `resolver` export" as genuine standalone words, on a
 * line that is itself a marker that the export has NOT happened yet). A line
 * carrying one of these markers is self-describing as unfinished, so a token
 * found only there is evidence AGAINST completion, not for it.
 *
 * Deliberately a narrow, explicit marker list rather than stripping every
 * comment or string outright: this codebase's own legitimate positive-tick
 * fixtures corroborate an item's tokens via an ordinary comment or a test
 * description string (see `automaticChecklistReconciliation.test.ts`'s
 * "ticks items from this round's own applied-operation evidence..." case) —
 * comments and strings are not categorically non-evidential the way a line
 * that says "not done yet" is. A false negative here just leaves an item
 * unresolved (safe, per this file's stated design philosophy — see
 * `CONTENT_CHECK_STOPWORDS_V1`'s doc comment); a false positive would let a
 * stated-intent line satisfy corroboration, which is exactly the failure
 * this guard exists to prevent.
 *
 * Widened in the SIXTH review round to close the reviewer's own literal
 * illustrative counter-example (`const note = 'resolver export pending';`,
 * which named no prior marker at all) with the same narrow-explicit-list
 * discipline: `pending`, `planned`, `upcoming`, `stub`, `placeholder`,
 * `scaffold`, `outstanding`, and `in\s+progress` are, like the original set,
 * words whose presence on a line is evidence AGAINST that line describing
 * finished work, not merely correlated with it. This closes the review's
 * cited example directly but is explicitly NOT this round's whole answer —
 * the EIGHTH review round's structural fix (tier 2 no longer writes `[x]`
 * at all — see `runAutomaticChecklistReconciliationV1`'s doc comment) is
 * what the review itself pointed at ("review-verified postconditions") and
 * does not depend on guessing the next word.
 */
const CONTENT_CHECK_INCOMPLETENESS_MARKERS_V1 =
  /\b(TODO|FIXME|XXX|TBD|WIP|unimplemented|not\s+yet\s+implemented|not\s+implemented|pending|planned|upcoming|stub|placeholder|scaffold|outstanding|in\s+progress)\b/i;

/**
 * Drops every line of a content excerpt that carries an explicit
 * incompleteness marker (`CONTENT_CHECK_INCOMPLETENESS_MARKERS_V1`) before it
 * is used as tier 2's corroboration haystack. Each dropped line is replaced
 * with a blank line (never spliced out) so tokens on adjacent lines do not
 * get spuriously joined into a new word.
 */
function stripIncompletenessMarkedLinesV1(text: string): string {
  return text
    .split("\n")
    .map((line) => (CONTENT_CHECK_INCOMPLETENESS_MARKERS_V1.test(line) ? "" : line))
    .join("\n");
}

/**
 * True when EVERY one of an item's content-check tokens appears
 * (case-insensitively, on a whole-token boundary) in the concatenated
 * `contentExcerpt` of the operation(s) that cover the item's path(s), AFTER
 * any line carrying an explicit incompleteness marker is dropped
 * (`stripIncompletenessMarkedLinesV1`) — see `extractContentCheckTokensV1`
 * and `SealedAppliedOperationV1.contentExcerpt`. A `deleteFile` step never
 * carries an excerpt and is intentionally excluded from `coveringOperations`
 * by the caller before this runs (kind-vs-intent already governs deletion
 * coverage on kind alone). Returns false — never ticked, per this function's
 * own contract — when there is nothing to check (no tokens) or nothing to
 * check it against (no excerpt on any covering operation, or an excerpt whose
 * only matching lines were dropped as incompleteness-marked).
 *
 * Three hardening changes across the THIRD, FOURTH, and FIFTH review rounds,
 * all closing variations of the same cited counter-example ("Add the
 * `resolver` export" ticked by content that never actually adds it):
 *  - ALL tokens must match, not just one — so an excerpt has to corroborate
 *    every distinct concept the item names (the identifier AND the verb/noun
 *    describing what must happen to it), not just whichever single word
 *    happens to occur.
 *  - Matching uses a `\b`-bounded regex, not `String.includes` — a naive
 *    substring check treats `resolverStatus` as containing `resolver`, which
 *    is exactly the false positive the FOURTH round flagged. Word-boundary
 *    matching requires the token to be a standalone identifier/word in the
 *    excerpt, not a fragment of a longer one.
 *  - A line carrying an explicit incompleteness marker (`TODO`, `FIXME`, ...)
 *    is dropped before matching (FIFTH round) — content that self-describes
 *    as not-yet-done is evidence against completion, not corroboration of it,
 *    even when it happens to name every token the item requires.
 */
function tier2ContentEvidenceSatisfiedV1(
  tokens: readonly string[],
  coveringOperations: readonly { contentExcerpt?: string }[]
): boolean {
  if (tokens.length === 0) {
    return false;
  }
  const haystack = stripIncompletenessMarkedLinesV1(
    coveringOperations
      .map((op) => op.contentExcerpt)
      .filter((excerpt): excerpt is string => excerpt !== undefined)
      .join("\n")
  );
  if (haystack.trim().length === 0) {
    return false;
  }
  return tokens.every((token) => new RegExp(`\\b${escapeRegExpLiteralV1(token)}\\b`, "i").test(haystack));
}

/**
 * EIGHTH review round: tier 2 no longer writes anything to the plan of
 * record at all (see `runAutomaticChecklistReconciliationV1`'s doc comment),
 * so there is no plan-visible section for a tier-2 candidate to be paired
 * with — the candidate itself, surfaced through
 * `PendingOperationEvidenceItemV1` and the round log, IS the "not yet
 * verified" flag. The plan.md marker `<!-- ensemble:auto-reconciled-pending-review -->`
 * this file used to append to plan-final.md, and the
 * `appendAutoReconciledPendingReviewNoteV1` function that wrote it, are
 * retired along with the tier-2 auto-tick they existed to flag.
 */

/**
 * The bounded automatic reconciliation pass (workflow 8, item 2 / plan Part
 * 4): runs after a sealed edit round completes with no checklist echo to
 * merge (`summaryIsSynthetic`), and gathers two sources of HARD evidence —
 * never this round's own diff, prose, or stated intent (there isn't any;
 * that absence is exactly why this pass exists) — for a human to act on.
 * **This pass never writes plan-final.md and never ticks anything itself**
 * (2026-08-21 NINTH review round, the persisting Part 4 architectural
 * blocker after the EIGHTH round closed it for tier 2 alone): an earlier
 * revision auto-merged tier-1 evidence on the strength of the reviewer's own
 * judgement, on the theory that a reviewer's verification needed no further
 * confirmation. The review held that this reintroduced exactly the harm the
 * plan's own narrowing decision named for tier 2 — "semantic completion
 * cannot be proved from lexical evidence" applies equally to "an unticked
 * item happens to text-match something a review's `## Verified Complete`
 * block names", since that match is still made by this pass's own text
 * comparison, not by a human reading the review and the plan side by side.
 * Both tiers are now candidates only, surfaced through this function's
 * return value, the round log (`buildChecklistMergeDiagnosticsNoteV1`), and
 * the reconciliation evidence surface (`gatherReconcileEvidenceV1` /
 * `postReconcilePlanChecklistDecisionV1`) for explicit human selection.
 * Selected tier-1 candidates are applied through
 * `applyReconciliationReviewVerifiedTicksV1`, which reuses the SAME merge
 * primitives (`buildSyntheticVerifiedCompleteSummaryV1` +
 * `mergeChecklistProgressV1`) `applyReviewerVerifiedTicks.ts` already uses,
 * rather than a second ticking mechanism. Tier 2 has no such promotion path
 * at all — see below.
 *
 *  - **Tier 1 — review-verified.** Does an implementation review already on
 *    file (`computeReviewVerifiedCoverageV1`) name any of the plan's
 *    currently-unticked items as verified complete? Highest confidence: a
 *    reviewer judged the actual RESULT correct, not just that something
 *    happened — but still only a candidate here; see above.
 *  - **Tier 2 — applied-operation (candidate only, EIGHTH review round).**
 *    Did this round's OWN applied operations — the sealed pipeline's
 *    per-step receipts (`appliedOperations`: kind + `path` + an optional
 *    `contentExcerpt` of what the step wrote, for every
 *    `createFile`/`replaceFile`/`patchFile`/`deleteFile` it actually
 *    applied, NEVER a bare `changedPaths` entry, which can include
 *    attribution-only paths with no structured receipt behind them — see
 *    `ImplementationRunResult.appliedOperations`'s own doc comment) —
 *    fully cover EVERY inline file path (`extractInlineFilePathsV1`) an
 *    unticked item names? An item with no inline path, or with even ONE
 *    named path this round did not touch, does not qualify: partial or
 *    absent evidence stays unresolved, never a candidate. Earlier revisions
 *    of this pass let a qualifying item write `[x]` directly — after seven
 *    rounds hardening the guards below against successive false-positive
 *    counter-examples, the review held that no amount of guard-tightening
 *    changes what KIND of evidence a lexical path+content match is: it
 *    proves a specific KIND of change landed at a specific path, never that
 *    a human or reviewer judged the result correct. Plan Part 4's own
 *    revision settled this: "Lexical operation evidence is advisory only,
 *    regardless of confidence." So a qualifying item is now returned as a
 *    `PendingOperationEvidenceItemV1` candidate — visible in the round log
 *    and through the reconciliation evidence surface — and `plan-final.md`
 *    is never written for it. Only explicit human attestation may promote a
 *    candidate to a tick.
 *
 *    Three further guards, added across two later review rounds because
 *    "an operation touched every path the item names" is still not "the
 *    item's own requirement is what got done":
 *      - **Exclusivity** (2026-08-21 SECOND review round). A path shared by
 *        more than one currently-unticked item is ambiguous — a single
 *        `patchFile` receipt at that path cannot tell which of several
 *        requirements naming the same file it actually satisfied, so EVERY
 *        item sharing that path is excluded from tier 2 entirely
 *        (`computeTier2AmbiguousItemsV1`), not just the one this pass happens
 *        to look at first. This is symmetric: it removes the whole group,
 *        never picks a "winner".
 *      - **Kind-vs-intent** (2026-08-21 SECOND review round). An item's paths
 *        can be "covered" purely by `deleteFile` receipts, which prove
 *        removal, not addition or repair — ticking an "Add X" or "Fix Y" item
 *        from a delete receipt alone would be exactly backwards. When every
 *        operation touching an item's path(s) is a `deleteFile`, the item's
 *        own text must read as a removal (`itemImpliesDeletionV1` —
 *        "delete"/"remove"/"drop"/"strip"/"eliminate" and their inflections)
 *        or it does not qualify.
 *      - **Content corroboration** (2026-08-21 THIRD review round, hardened
 *        again in a FOURTH round — the blocker persisted even with the two
 *        guards above, because neither one examines what a covering
 *        operation actually WROTE: "a unique item qualifies when every
 *        referenced path has any applied operation" is still just a
 *        path-and-kind receipt, not evidence the specific requirement
 *        landed). For any non-deletion coverage, ALL of the item's own
 *        content-check tokens (`extractContentCheckTokensV1` — every quoted,
 *        non-path identifier from the item's own text, UNION its significant
 *        plain words, not identifiers alone) must each be found, on a whole-
 *        token boundary, in the covering operation(s)' own `contentExcerpt` —
 *        the actual text that step introduced
 *        (`SealedAppliedOperationV1.contentExcerpt`), not the whole file and
 *        not this round's diff. The FOURTH round closed two remaining false
 *        ticks the THIRD round's single-token, substring-only check still
 *        allowed: a receipt whose content merely contains an item's
 *        identifier as a SUBSTRING of a longer word (e.g. `resolverStatus`
 *        satisfying a token `resolver`), and a receipt that mentions the
 *        identifier alone without the requirement word describing what must
 *        happen to it (e.g. a non-exported `resolver` symbol satisfying "Add
 *        the `resolver` export" with no `export` keyword anywhere). A FIFTH
 *        round closed a third remaining false tick: a receipt whose content
 *        names every required token, but only on a line that itself declares
 *        the work unfinished (e.g. `// TODO: export resolver after
 *        migration` satisfying both `resolver` and `export`) — a line
 *        carrying an explicit incompleteness marker
 *        (`CONTENT_CHECK_INCOMPLETENESS_MARKERS_V1` — `TODO`/`FIXME`/`XXX`/
 *        `TBD`/`WIP`/"not (yet) implemented") is dropped
 *        (`stripIncompletenessMarkedLinesV1`) before token matching, so
 *        stated future intent can no longer stand in for the requirement
 *        actually landing. An item reduced to zero tokens, or covered only by
 *        operations with no excerpt, or whose excerpt is missing even one
 *        required token once incompleteness-marked lines are dropped, has
 *        nothing (or incomplete) corroboration and does NOT qualify — the
 *        original behavior (path+kind alone is proof) is exactly the
 *        false-tick this guard closes, so "cannot verify" must resolve the
 *        same way as "verified false": unticked.
 *    Any guard failing leaves the item exactly where it already was
 *    (unticked, unresolved) — never a different, weaker kind of tick.
 *
 * `changedPaths` — the SAME round's own attributed change set the caller
 * already computed (`attributedFilesChanged` in reviewActions.ts) — is used,
 * independently of `appliedOperations`, to keep the NEGATIVE side honest
 * (2026-08-21 review finding, extended for the mixed case, extended again
 * for the pathless case): every plan item still unticked after BOTH tiers
 * above have been applied is scanned for an inline file-path reference — an
 * item is treated as "cannot be ruled unrelated to this round" in EITHER of
 * two cases: its referenced path(s) overlap `changedPaths`
 * (`filePathsOverlapV1`), OR it names no file path at all (a pathless item
 * is exempt from this check only when the round changed NO files at all —
 * see the earlier revision's reasoning, unchanged here). If no unticked item
 * is left unresolved after both tiers, `"nothingCovered"` is an affirmative,
 * checked negative. If some item IS left unresolved, the round plausibly
 * advanced exactly that work but neither tier can confirm it, so the pass
 * must not claim it can rule the item out.
 *
 * Three outcomes. **None of them ever exempts the round from
 * `checklistProgressUnreliable` on its own** (2026-08-21 NINTH review round —
 * see `computeSyntheticRoundChecklistLatchV1`, which no longer reads this
 * function's outcome at all): a synthetic round that changed files always
 * latches, and only an explicit human attestation
 * (`reconcilePlanChecklistConfirmedV1`, "Mark reconciled") clears it. This
 * pass exists purely to make the evidence for that human decision visible
 * and actionable, never to make the decision itself:
 *  - `"candidatesFound"` — tier 1 and/or tier 2 found evidence.
 *    `reviewVerifiedItems` (tier 1) and `pendingOperationEvidenceItems`
 *    (tier 2) are both candidates only; neither is ticked or written here.
 *    `unresolvedOverlap` carries any OTHER unticked item this pass cannot
 *    rule unrelated to `changedPaths` and that neither tier covers.
 *  - `"nothingCovered"` — the scan completed, neither tier found anything,
 *    AND every unticked item is one this pass can affirmatively rule
 *    unrelated to this round. An honest, checked negative — still requires
 *    explicit human attestation to clear the latch (plan Part 4: "never
 *    auto-exempt"), but is reported as a negative rather than a failure so
 *    the human sees an honest "found nothing" instead of an error.
 *  - `"unavailable"` — the plan has no checklist, or an unticked item cannot
 *    be ruled unrelated to this round's changes and is not covered by tier 1
 *    or a tier-2 candidate. The pass could not complete its check.
 */
export async function runAutomaticChecklistReconciliationV1(
  folderUri: vscode.Uri,
  changedPaths: readonly string[],
  appliedOperations?: readonly { kind: string; path: string; contentExcerpt?: string }[]
): Promise<AutomaticChecklistReconciliationOutcomeV1> {
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || plan.text === undefined) {
    return { kind: "unavailable", reason: "plan-final.md has no implementation checklist to reconcile against." };
  }

  const normalizedChangedPaths = changedPaths.map((p) => p.replace(/\\/g, "/").toLowerCase());
  // Per-step evidence (kind + path + a content excerpt when the step wrote
  // one — see this function's own doc comment: tier 2's positive coverage
  // AND the "unavailable" reason enrichment both read from this, never from
  // `changedPaths` alone (which carries no operation kind and can include
  // attribution-only paths).
  const normalizedOperations = (appliedOperations ?? []).map((op) => ({
    kind: op.kind,
    path: op.path.replace(/\\/g, "/").toLowerCase(),
    contentExcerpt: op.contentExcerpt,
  }));
  const describeOperationKindsForItem = (item: string): string | undefined => {
    if (normalizedOperations.length === 0) {
      return undefined;
    }
    const itemPaths = extractInlineFilePathsV1(item);
    if (itemPaths.length === 0) {
      return undefined;
    }
    const kinds = new Set<string>();
    for (const itemPath of itemPaths) {
      for (const operation of normalizedOperations) {
        if (filePathsOverlapV1(itemPath, operation.path)) {
          kinds.add(operation.kind);
        }
      }
    }
    return kinds.size > 0 ? Array.from(kinds).sort().join("/") : undefined;
  };
  // Tier 2 positive coverage (see the function's own doc comment): an
  // unticked item qualifies ONLY when it names at least one inline file path
  // and EVERY path it names was touched by an applied operation this round.
  // `excludeKeys` (normalized item text) drops any item tier 1 already found
  // a candidate for — this pass never merges tier 1 into the plan text
  // anymore, so exclusion is done by key here rather than by re-scanning
  // post-merge text.
  const computeAppliedOperationCoverage = (
    planText: string,
    excludeKeys: ReadonlySet<string>
  ): { item: string; evidence: string }[] => {
    if (normalizedOperations.length === 0) {
      return [];
    }
    const unchecked = listUncheckedChecklistItemTextsV1(planText, Number.MAX_SAFE_INTEGER);
    const itemsWithPaths = unchecked.items
      .filter((item) => !excludeKeys.has(normalizeChecklistItemTextV1(item)))
      .map((item) => ({ item, paths: extractInlineFilePathsV1(item) }))
      .filter((entry) => entry.paths.length > 0);
    // Exclusivity guard — see "Exclusivity" in this function's doc comment:
    // a path named by more than one currently-unticked item cannot be
    // attributed to just one of them from a receipt alone.
    const ambiguousItems = computeTier2AmbiguousItemsV1(itemsWithPaths);
    const covered: { item: string; evidence: string }[] = [];
    for (const { item, paths: itemPaths } of itemsWithPaths) {
      if (ambiguousItems.has(item)) {
        continue;
      }
      const coveringKinds = new Set<string>();
      for (const itemPath of itemPaths) {
        for (const operation of normalizedOperations) {
          if (filePathsOverlapV1(itemPath, operation.path)) {
            coveringKinds.add(operation.kind);
          }
        }
      }
      const fullyCovered = itemPaths.every((itemPath) =>
        normalizedOperations.some((operation) => filePathsOverlapV1(itemPath, operation.path))
      );
      if (!fullyCovered) {
        continue;
      }
      // Kind-vs-intent guard — see this function's doc comment: a
      // deleteFile-only receipt proves removal, not addition or repair, so
      // it may only satisfy an item whose own text reads as a removal.
      const onlyDeletions = coveringKinds.size > 0 && [...coveringKinds].every((kind) => kind === "deleteFile");
      if (onlyDeletions && !itemImpliesDeletionV1(item)) {
        continue;
      }
      // Content-corroboration guard (2026-08-21 THIRD review round — see
      // `tier2ContentEvidenceSatisfiedV1`'s doc comment): path+kind coverage
      // alone proves an operation landed at the right file, never that its
      // CONTENT is what the item actually asked for. A deletion-only receipt
      // skips this — there is no new content to excerpt from a removal, and
      // the guard above already confirmed the item's own text reads as one.
      // Otherwise, the item's own content-check tokens must be found in the
      // covering operation(s)' excerpted content; no tokens, or no excerpt to
      // check them against, leaves the item unresolved rather than ticked.
      if (!onlyDeletions) {
        const coveringOperations = normalizedOperations.filter(
          (operation) =>
            operation.kind !== "deleteFile" &&
            itemPaths.some((itemPath) => filePathsOverlapV1(itemPath, operation.path))
        );
        const tokens = extractContentCheckTokensV1(item);
        if (!tier2ContentEvidenceSatisfiedV1(tokens, coveringOperations)) {
          continue;
        }
      }
      const kinds = describeOperationKindsForItem(item);
      covered.push({
        item,
        evidence:
          `candidate, pending human attestation — this round's own applied operations (${kinds}) touched ` +
          "every file this item references, and the item's own described content was found in what those " +
          "operations wrote; this is lexical corroboration, not a reviewer's judgement, so it has NOT been " +
          "ticked automatically",
      });
    }
    return covered;
  };
  // An item this pass CANNOT rule unrelated to this round: either its own
  // inline path(s) overlap `changedPaths`, or it names no path at all (so
  // there is nothing to pattern-match against, and treating that absence as
  // proof of unrelatedness would be a false safety — see the function's own
  // doc comment). Only meaningful when this round changed at least one file;
  // with no changed files there is nothing to correlate against, so every
  // item is trivially ruled unrelated. `excludeKeys` drops items already
  // reported as a tier-1 or tier-2 candidate — those are not "unresolved",
  // they already have evidence riding with them.
  const findOverlappingUnticked = (planText: string, excludeKeys: ReadonlySet<string>): string[] => {
    if (normalizedChangedPaths.length === 0) {
      return [];
    }
    const unchecked = listUncheckedChecklistItemTextsV1(planText, Number.MAX_SAFE_INTEGER);
    return unchecked.items.filter((item) => {
      if (excludeKeys.has(normalizeChecklistItemTextV1(item))) {
        return false;
      }
      const itemPaths = extractInlineFilePathsV1(item);
      if (itemPaths.length === 0) {
        return true;
      }
      return itemPaths.some((itemPath) =>
        normalizedChangedPaths.some((changedPath) => filePathsOverlapV1(itemPath, changedPath))
      );
    });
  };

  // Tier 1: review-verified coverage — highest-confidence evidence, but a
  // CANDIDATE only (see this function's own doc comment, NINTH review round):
  // never merged or written here. Explicit human selection promotes it to a
  // tick via `applyReconciliationReviewVerifiedTicksV1`.
  const { coveredItems: reviewVerifiedItems } = await computeReviewVerifiedCoverageV1(folderUri, plan.text);
  const reviewVerifiedKeys = new Set(reviewVerifiedItems.map((item) => normalizeChecklistItemTextV1(item)));

  // Tier 2: applied-operation coverage, evaluated against whichever items are
  // NOT already a tier-1 candidate. Never calls `mergeChecklistProgressV1` and
  // never writes plan-final.md — a lexical match is advisory evidence for a
  // human to attest, not authority to write `[x]` (plan Part 4, "the
  // automatic pass itself never promotes a candidate, regardless of lexical
  // confidence").
  const pendingOperationEvidenceItems = computeAppliedOperationCoverage(plan.text, reviewVerifiedKeys);

  if (reviewVerifiedItems.length > 0 || pendingOperationEvidenceItems.length > 0) {
    const candidateKeys = new Set([
      ...reviewVerifiedKeys,
      ...pendingOperationEvidenceItems.map((c) => normalizeChecklistItemTextV1(c.item)),
    ]);
    return {
      kind: "candidatesFound",
      reviewVerifiedItems,
      pendingOperationEvidenceItems,
      unresolvedOverlap: findOverlappingUnticked(plan.text, candidateKeys),
    };
  }

  const relatedUnticked = findOverlappingUnticked(plan.text, new Set());
  if (relatedUnticked.length > 0) {
    // Enriched with what actually happened to the overlapping file(s) this
    // round, when applied-operation evidence is available — a human reading
    // this reason can see "patchFile" vs "deleteFile" vs "createFile" instead
    // of just "a file changed". These items reached this branch precisely
    // BECAUSE tier 2 could not fully cover them (partial coverage, or no
    // operation evidence at all), so this is enrichment of an unresolved
    // reason, never a decided outcome.
    const describedSample = relatedUnticked
      .slice(0, 3)
      .map((item) => {
        const kinds = describeOperationKindsForItem(item);
        return kinds ? `"${item}" (${kinds} this round)` : `"${item}"`;
      })
      .join(", ");
    return {
      kind: "unavailable",
      reason:
        `${relatedUnticked.length} unticked plan item(s) cannot be ruled unrelated to this round's changes ` +
        `(referencing a file this round changed, or naming no file at all), but no review on file verifies ` +
        `them complete, and this round's applied-operation evidence does not fully cover every file they ` +
        `reference: ${describedSample}`,
    };
  }

  return { kind: "nothingCovered" };
}

/**
 * Clear a task's `checklistProgressUnreliable` latch after the user has brought
 * `plan-final.md`'s checkboxes back in line with the tree.
 *
 * The latch is set under two conditions (workflow 3 continuation, second
 * item — the widened trigger): (1) a round changes files without its
 * checklist state being recorded — a runner-authored summary (the sealed
 * edit pipeline returns verified receipts, not prose) or a rejected one; or
 * (2) a completed round changes NO files and lands no new checklist ticks
 * (a sterile round) immediately after the most recent qualifying-stage
 * review scored at or above the auto-advance threshold with zero blockers —
 * proof the checklist's own counts are under-reporting finished work, even
 * though nothing here can point at which lines are wrong. Those completions
 * can never be recovered automatically: no later round knows what an
 * unrecorded round did, and inferring it would tick items nobody verified.
 * So the counts stay understated until a human fixes them (or a later
 * round's own prose claim resolves them — see `hasPlanItemChecklistClaimV1`
 * / `mergeChecklistProgressV1`, the other, automatic exit from this same
 * state), and while they are understated the completeness gate stands down
 * rather than hold a finished plan short of its total.
 *
 * **Classification: case 4** (module header, workflowDecisionV1.ts) — the
 * system genuinely cannot make this judgement: ticking a box cannot be
 * distinguished from ticking the LAST box, so no file-watch heuristic can
 * tell a partial edit from a finished reconciliation. Confirming is the user
 * asserting the checklist now matches the work, which stays a human decision.
 * What changes here is the blindness around it: this function now posts a
 * `WorkflowDecisionV1` carrying the evidence the system DOES hold
 * (`gatherReconcileEvidenceV1`) instead of a blind confirmation modal, and
 * only recommends "Mark reconciled" when that evidence covers every
 * outstanding item.
 */
export type ReconcileDecisionPostResultV1 =
  | { readonly kind: "posted" }
  | { readonly kind: "noChecklist" }
  | { readonly kind: "noContext" };

/**
 * Builds the evidence and posts the `reconcilePlanChecklist` decision for an
 * already-resolved task. Pulled out of the `reconcilePlanChecklist` command
 * so the checklist-latch call sites in reviewActions.ts (which already have
 * `folderUri` and a freshly-patched `TaskProgress` in hand from the round
 * they just finished writing) can post the SAME decision directly, without
 * going through `resolveTaskContext`/`vscode.commands.executeCommand` — a
 * command dispatch from deep inside the round-completion write path would
 * require the command to be registered in every caller, which unit-test
 * harnesses that only stub the write path do not do.
 */
export async function postReconcilePlanChecklistDecisionV1(
  folderUri: vscode.Uri,
  canonicalId: string,
  taskFolderPath: string,
  progress: {
    currentStage: TaskStage;
    displayName?: string;
    pendingImplReviewFiles?: string[];
    /**
     * The recorded reason `checklistProgressUnreliable` was set
     * (`TaskProgress.checklistProgressUnreliableReason`), if any — the
     * stronger discriminating fact the reconciliation decision cites instead
     * of only the weaker "N items unticked" count (task PART 5). Optional in
     * this narrowed parameter shape because every current caller may pass
     * either a full `TaskProgress` (which may or may not carry it, depending
     * on when the latch was set) or a hand-built object; absence renders an
     * explicit "not recorded" statement below rather than silence.
     */
    checklistProgressUnreliableReason?: string;
  },
  roundSummaryChecklistClaim?: MergeChecklistProgressResultV1,
  pendingOperationEvidence?: readonly PendingOperationEvidenceItemV1[]
): Promise<ReconcileDecisionPostResultV1> {
  // Reads durable bytes, saving the user's unsaved ticks first — the shared
  // resolver owns that rule so this command and the completeness gate can
  // never disagree about what the plan says.
  const plan = await readPlanOfRecordV1(folderUri);
  const counted = plan.counts;
  // Nothing to reconcile against. Clearing the latch here would report that
  // completeness gating is restored while readPlanOfRecordV1 keeps returning no
  // counts and the gate stays down — telling the user a safety net is back when
  // it is not, which is the failure this whole mechanism exists to prevent.
  if (!plan.hasChecklist || !counted || plan.text === undefined) {
    return { kind: "noChecklist" };
  }

  const { evidence, allUncheckedCovered, coveredItemsCount } = await gatherReconcileEvidenceV1(
    folderUri,
    plan.text,
    progress.pendingImplReviewFiles,
    roundSummaryChecklistClaim,
    pendingOperationEvidence
  );

  // wf10 item 6c: `coveredItemsCount === 0` is TWO unrelated situations —
  // (a) unticked items exist but no review vouches for them (the "no basis
  // to recommend" message below is true), or (b) there are no unticked items
  // AT ALL, so there is nothing for any review to vouch for in the first
  // place and the message is false. Observed live 2026-08-21 on jester task
  // 3: the panel printed "plan-final.md currently reads 75/75 items
  // complete, with 0 outstanding" directly above "At least one unticked item
  // is not named as verified complete" — self-contradictory two lines apart.
  // Case (b) is exactly where "Mark reconciled" is unambiguously safe:
  // nothing is outstanding, so re-arming the gate cannot let unfinished work
  // advance. Split the branch so that case is recommended instead of
  // silently falling into the "no basis" wording meant for case (a).
  const noUncheckedItemsRemain = counted.remaining === 0;

  // NINTH review round: tier-1 (review-verified) evidence is a candidate for
  // explicit selection, never an automatic tick (see
  // `runAutomaticChecklistReconciliationV1`'s doc comment) — so whenever any
  // exists, the actionable recommendation is to apply it (monotonic, and
  // text-matched against the plan of record exactly like
  // `applyReviewerVerifiedTicks` already is), not to blindly mark reconciled
  // while leaving verified-complete items sitting unticked.
  const recommendation: WorkflowDecisionRecommendationV1 =
    coveredItemsCount > 0
      ? {
          kind: "option",
          optionId: "applyVerifiedTicks",
          reasoning:
            `${coveredItemsCount} unticked item(s) are named verified complete by an implementation review ` +
            "already on file — applying records that verification as ticks, which cannot untick or misapply " +
            "anything." +
            (allUncheckedCovered
              ? " This covers every currently outstanding item, so reconciling afterward is safe too."
              : ""),
        }
      : noUncheckedItemsRemain
        ? {
            kind: "option",
            optionId: "reconcile",
            reasoning:
              `plan-final.md currently reads ${counted.checked}/${counted.total} items complete, with 0 ` +
              "outstanding — the checklist is fully accounted for, so there is nothing left for any review " +
              "to vouch for. Marking reconciled simply confirms that and restores completeness gating.",
          }
        : {
            kind: "none",
            reasoning:
              "At least one unticked item is not named as verified complete by any implementation review " +
              "on file — the system has no basis to recommend reconciling until you have checked it yourself.",
          };

  const target: ChatTarget = {
    canonicalId,
    taskFolderPath,
    stage: progress.currentStage,
    taskName: progress.displayName,
  };

  // Pre-generated so it can be embedded in the "reconcile" option's own
  // command args: the confirmed-execution side looks this decision back up
  // by id to compare plan-final.md's mtime against the decision's
  // `createdAt`, preserving the at-write byte-freshness guard the old modal
  // had (module doc comment on `reconcilePlanChecklistConfirmedV1`) without
  // caching the plan's CONTENT into args — only the reference travels.
  const decisionId = crypto.randomUUID();

  const decision = await postWorkflowDecisionV1(
    {
      decisionId,
      decisionKey: "reconcilePlanChecklist",
      taskCanonicalId: canonicalId,
      stage: progress.currentStage,
      whatHappened:
        `This task's plan checklist is flagged unreliable: plan-final.md currently reads ` +
        `${counted.checked}/${counted.total} items complete, with ${counted.remaining} outstanding, but a ` +
        "round changed work the checklist could not record, so its counts may understate what is actually done.",
      whyUserNeeded:
        "Ticking a box cannot be distinguished from ticking the LAST box, so no automatic check can tell a " +
        "partial edit from a finished reconciliation — only a human confirming the checklist now matches the " +
        "work can safely restore the completeness gate. " +
        // The stronger discriminating fact (task PART 5): WHY the counts were
        // distrusted in the first place, not only how many items are still
        // unticked. Absence is stated explicitly rather than silently
        // omitted — no write path populates this yet (see
        // TaskProgress.checklistProgressUnreliableReason's doc comment), so
        // every current record legitimately renders the "not recorded" case.
        (progress.checklistProgressUnreliableReason
          ? `Recorded reason the checklist was flagged unreliable: ${progress.checklistProgressUnreliableReason}`
          : "Recorded reason the checklist was flagged unreliable: not recorded (older record) — this task " +
            "was latched before that reason was captured, so judge the existing ticks on their own merits " +
            "rather than assuming they are trustworthy."),
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail:
          "This does not resume the task by itself. The completeness gate only affects automatic stage " +
          "advancement — if this task is currently paused, that pause comes from something else entirely " +
          "(check for a separate escalation/decision); answering this alone will not resume it.",
      },
      options: [
        ...(coveredItemsCount > 0
          ? [
              {
                optionId: "applyVerifiedTicks",
                label: `Apply ${coveredItemsCount} Reviewer-Verified Tick${coveredItemsCount === 1 ? "" : "s"}`,
                consequence:
                  `Ticks ${coveredItemsCount} item(s) in plan-final.md that an implementation review already ` +
                  "on file names verified complete. Does not by itself clear the unreliable-checklist flag — " +
                  "run this again afterward (or mark reconciled directly) once every outstanding item is " +
                  "accounted for.",
                effect: {
                  kind: "command" as const,
                  command: "vs-code-ai-helper.applyReconciliationReviewVerifiedTicksConfirmed",
                  args: [{ taskFolderPath, canonicalId }],
                },
              },
            ]
          : []),
        {
          optionId: "reconcile",
          label: "Mark reconciled",
          consequence:
            "Clears the unreliable-checklist flag. Plan completeness will gate stage advancement again from " +
            "these counts, so an item left unticked will hold the task open, and one ticked in error can let " +
            "unfinished work advance.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.reconcilePlanChecklistConfirmed",
            args: [{ taskFolderPath, canonicalId, decisionId }],
          },
        },
        {
          optionId: "notYet",
          label: "Not yet — keep the gate down",
          consequence: noUncheckedItemsRemain
            ? // No unticked items exist at all (case b above) — instructing
              // the user to "tick the missed items" would send them looking
              // for something that is not there (jester task 3: the 7
              // remaining boxes at the time all carried `ensemble:excluded`
              // and were deliberately outside the count).
              "Does nothing. Completeness stays stood down until you mark reconciled — there is nothing " +
              "unticked left to tick; every remaining box (if any) is deliberately excluded from the count."
            : "Does nothing. Completeness stays stood down until you tick the missed items in plan-final.md " +
              "and run this again, or a candidate above is applied.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation,
      evidence,
    },
    target
  );
  return decision ? { kind: "posted" } : { kind: "noContext" };
}

export async function reconcilePlanChecklist(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ReconcileArg
): Promise<void> {
  // Activation-order barrier (plan §1.4) — same rationale as pinTask.
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  // The store is what makes this reachable from the Command Palette, which
  // passes no argument: without it resolveTaskContext has nothing to fall back
  // on and always returns undefined, so the command contributed to fix a false
  // promise was itself unusable from the surface it was advertised on.
  const resolved = await resolveTaskContext(
    inventory,
    normalizeArg(explicitArg),
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (!resolved.progress.checklistProgressUnreliable) {
    NotificationRouter.showInformation(
      "This task's plan checklist is already treated as a complete record."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const result = await postReconcilePlanChecklistDecisionV1(
    folderUri,
    resolved.canonicalId,
    resolved.taskFolderPath,
    resolved.progress
  );
  if (result.kind === "noChecklist") {
    NotificationRouter.showWarning(
      "plan-final.md has no implementation checklist to reconcile, so completeness cannot gate " +
        "this task. Generate or restore the checklist first, then run this again."
    );
  } else if (result.kind === "noContext") {
    NotificationRouter.showWarning(
      "Could not post the checklist-reconciliation decision to Chat With AI (no active extension context)."
    );
  }
}

/**
 * Executes the "Mark reconciled" option chosen for a `reconcilePlanChecklist`
 * decision (case 4). Re-derives everything fresh rather than trusting
 * anything carried in the decision's args — a decision may sit for hours, so
 * the byte-exact freshness guard the old modal used (comparing plan-final.md
 * against a snapshot captured moments before the modal closed) is replaced by
 * an mtime check against the decision's own `createdAt`: when a `decisionId`
 * is present in args (the normal dispatch path — see the option's `effect`
 * in `postReconcilePlanChecklistDecisionV1`), the decision is looked back up
 * from the store and plan-final.md's on-disk mtime is compared against when
 * the decision was posted. This still never caches the plan's CONTENT into
 * args (architecture note, plan.md) — only the decision's own id, a routing
 * reference, travels; the comparison re-reads both sides fresh.
 */
export async function reconcilePlanChecklistConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ReconcileArg
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const normalized = normalizeArg(explicitArg);
  const resolved = await resolveTaskContext(
    inventory,
    normalized,
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (!resolved.progress.checklistProgressUnreliable) {
    NotificationRouter.showInformation(
      "This task's plan checklist is already treated as a complete record."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const planUri = getCanonicalImplementationUri(folderUri);
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    NotificationRouter.showWarning(
      "plan-final.md could not be read, so there is nothing to reconcile against."
    );
    return;
  }

  if (normalized?.decisionId) {
    const context = getExtensionContextV1();
    const decision = context && new WorkflowDecisionStoreV1(context.workspaceState).get(normalized.decisionId);
    if (decision) {
      const stat = await statIfExists(planUri);
      if (stat && stat.mtime > Date.parse(decision.createdAt)) {
        NotificationRouter.showWarning(
          "plan-final.md changed since this decision was posted, so the evidence it showed may be stale. " +
            "Re-check plan-final.md and run this again."
        );
        return;
      }
    }
  }

  let raced = false;
  await patchTaskProgressStrictV1(folderUri, (current) => {
    if (current.updatedAt !== resolved.progress.updatedAt) {
      raced = true;
      return current;
    }
    return { ...current, checklistProgressUnreliable: undefined };
  });
  if (raced) {
    NotificationRouter.showWarning(
      "The task changed while this was being applied — a round may have landed work the checklist " +
        "does not record. Re-check plan-final.md and run this again."
    );
    return;
  }
  await inventory.refresh();
  NotificationRouter.showInformation(
    "Plan checklist marked as reconciled — completeness now gates advancement again."
  );
}

export type ApplyReconciliationTicksResultV1 =
  | { readonly kind: "applied"; readonly count: number }
  | { readonly kind: "noCandidates" }
  | { readonly kind: "noChecklist" };

/**
 * Applies every currently-unticked plan item an implementation review
 * already on file names verified complete (tier 1, `computeReviewVerifiedCoverageV1`
 * — the SAME evidence `runAutomaticChecklistReconciliationV1` surfaces as a
 * candidate, never auto-merged there, see its doc comment). Re-derives
 * everything fresh from disk, exactly like
 * `applyReviewerVerifiedTicksConfirmedV1` does and for the same reason
 * (module doc comment there): both files may have changed since the operator
 * saw the evidence, and re-deriving is simpler and safer than an
 * abort-on-race check because the merge is monotonic and text-matched.
 *
 * Deliberately reuses `buildSyntheticVerifiedCompleteSummaryV1` +
 * `mergeChecklistProgressV1` — the exact primitives `applyReviewerVerifiedTicks.ts`
 * already uses to turn a reviewer's `## Verified Complete` list into ticks —
 * rather than a second ticking mechanism (plan Part 4: "reuse that path, do
 * not build a second one"). The only difference from
 * `applyReviewerVerifiedTicksConfirmedV1` is scope: that command applies one
 * review stage's own list; this applies the union across every stage
 * (`computeReviewVerifiedCoverageV1`'s own dedup), which is what the
 * reconciliation evidence surface shows the operator as a single count.
 *
 * Never clears `checklistProgressUnreliable` by itself — ticking evidence and
 * attesting the checklist is now a complete record are deliberately separate
 * explicit acts (plan Part 4: "the explicit human confirmation is deliberate
 * and correct"), so a partial or rejected selection here leaves the latch
 * exactly where it was.
 */
export async function applyReconciliationReviewVerifiedTicksV1(
  folderUri: vscode.Uri
): Promise<ApplyReconciliationTicksResultV1> {
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || plan.text === undefined) {
    return { kind: "noChecklist" };
  }
  const { coveredItems } = await computeReviewVerifiedCoverageV1(folderUri, plan.text);
  if (coveredItems.length === 0) {
    return { kind: "noCandidates" };
  }
  const evidence =
    "verified complete by an implementation review already on file — applied via explicit operator " +
    "selection (Ensemble: Apply Reviewer-Verified Ticks)";
  const synthetic = buildSyntheticVerifiedCompleteSummaryV1(coveredItems, evidence);
  const merged = mergeChecklistProgressV1(plan.text, synthetic);
  if (merged.kind !== "merged") {
    return { kind: "noCandidates" };
  }
  await writeTextFile(getCanonicalImplementationUri(folderUri), merged.content);
  return { kind: "applied", count: coveredItems.length };
}

/**
 * Executes the "Apply N Reviewer-Verified Tick(s)" option chosen for a
 * `reconcilePlanChecklist` decision (`postReconcilePlanChecklistDecisionV1`).
 * Same argument shape as `reconcilePlanChecklistConfirmedV1` (task ids only —
 * no `decisionId` freshness check here, since the underlying merge is
 * monotonic and text-matched and re-derives from disk regardless, exactly
 * like `applyReviewerVerifiedTicksConfirmedV1`).
 */
export async function applyReconciliationReviewVerifiedTicksConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ReconcileArg
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const resolved = await resolveTaskContext(
    inventory,
    normalizeArg(explicitArg),
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const result = await applyReconciliationReviewVerifiedTicksV1(folderUri);
  if (result.kind === "noChecklist") {
    NotificationRouter.showWarning(
      "plan-final.md has no implementation checklist to tick, so there is nothing to apply."
    );
    return;
  }
  if (result.kind === "noCandidates") {
    NotificationRouter.showInformation(
      "No implementation review on file currently names an unticked plan item as verified complete."
    );
    return;
  }
  await inventory.refresh();
  NotificationRouter.showInformation(
    `Applied ${result.count} reviewer-verified tick(s) to plan-final.md.`
  );
}

export function registerReconcilePlanChecklistCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.reconcilePlanChecklist",
      (arg?: ReconcileArg) => reconcilePlanChecklist(inventory, currentTaskStore, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.reconcilePlanChecklistConfirmed",
      (arg?: ReconcileArg) => reconcilePlanChecklistConfirmedV1(inventory, currentTaskStore, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReconciliationReviewVerifiedTicksConfirmed",
      (arg?: ReconcileArg) => applyReconciliationReviewVerifiedTicksConfirmedV1(inventory, currentTaskStore, arg)
    )
  );
}
