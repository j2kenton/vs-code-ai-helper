import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pre-1.0.0 fixes register, Part 2 (item 15 hardening) — the last open item
 * in "Write Part 2 boundary tests": *"A nested acquisition in these paths
 * fails fast; if the local queue cannot detect that, a source-scan test
 * lists the callers instead."*
 *
 * It does NOT fail fast. `withTaskLock` (`src/state/taskStateStore.ts`)
 * queues every mutation for a given `tasksRoot` through
 * `withLocalMutationQueue` before it ever reaches the cross-process
 * `PrimarySessionLock` file. That queue is a promise chain keyed on
 * `tasksRoot`: a call registers `tail = previous.then(() => gate)` in the
 * module-level map, then `await`s `previous` before running its own
 * operation, and only resolves `gate` (unblocking whoever queued behind it)
 * from the `finally` after its OWN operation returns.
 *
 * A NESTED call to `withTaskLock` for the same `tasksRoot` — made from
 * *inside* an already-running `withTaskLock` operation for that same root —
 * therefore reads `previous` as the OUTER call's own still-pending `tail`,
 * and awaits it before doing anything else. That `tail` cannot resolve until
 * the outer operation's `finally` runs, which cannot happen until the outer
 * operation itself returns — but the outer operation is exactly what is
 * blocked, awaiting the inner call. Neither side can make progress: a
 * same-process deadlock, not a race the file lock ever gets a chance to
 * arbitrate (the inner call never reaches `PrimarySessionLock.acquire()` at
 * all). This is worse than "fails fast", and a live demonstration of it
 * would leave `PrimarySessionLock`'s heartbeat `setInterval` running forever
 * on the outer, never-released lock — hanging the test process rather than
 * merely failing an assertion — so it is analyzed here, not reproduced at
 * runtime. `taskStateStoreLocking.test.ts` covers the (safe, resolving)
 * inter-lock contention cases; this file exists because the reentrant case
 * cannot be proven the same way.
 *
 * Since the local queue cannot detect or reject its own reentrancy, the only
 * defense is the one the plan names: every production call site that can
 * reach a lock-acquiring stage-entry recovery/post-commit function must be
 * proven, by inspection, to run OUTSIDE any `withTaskLock`/`withMetaRootLock`
 * hold for that task — and a NEW call site added later must be forced to
 * re-earn that proof rather than silently inheriting it. This scan is that
 * proof, kept honest the same way `stageMutatorSourceScanV1.test.ts` keeps
 * its own one-door proof honest: an allowlist keyed by file plus a stable
 * snippet of the call's own source text (1.0 plan item 14 — NOT a line
 * number, so an unrelated edit elsewhere in the file never requires
 * updating every entry below it), each entry with a reason, that fails on a
 * call whose text is not on the allowlist (new, changed, or an unreviewed
 * second call in an already-allowlisted file) and on a listed entry that no
 * longer matches any call (a stale entry — the call itself changed or was
 * removed).
 *
 * Six functions are tracked. The first four are the direct lock-acquirers
 * (or a one-hop wrapper around one); the last two were added after the
 * 2026-09-23 review found that scanning only direct calls to those four
 * let a WRAPPER's own production callers go unverified — a caller of
 * `materializeCanonicalIfNeeded` or the exported `enterStageV1` inherits
 * the same reentrancy hazard as a direct caller of the function it wraps,
 * one or two hops further removed, and nothing had been scanning THOSE
 * call sites at all:
 *   - `recoverStageEntryJournalV1` and `recoverStageEntryJournalIfPresentV1`
 *     (`stageEntryJournalV1.ts`) — both acquire `withTaskLock` internally
 *     (Phase A's decide-and-maybe-rollback, and Phase C's journal cleanup).
 *   - `runStageEntryPostCommitV1` (`stageTransition.ts`) — acquires
 *     `withTaskLock` for a deferred plan-revision adoption write and for its
 *     own Phase C journal delete.
 *   - `prepareStageEntryV1` (`stageTransition.ts`) — not a lock-acquirer
 *     itself, but every call (unless `skipProactiveRecovery` is set) reaches
 *     `recoverStageEntryJournalIfPresentV1` in its own body, so a caller of
 *     THIS function inherits the same hazard one level removed. Its two
 *     "friendly pre-check" callers in `reviewActions.ts` are tracked here for
 *     that reason, alongside its own definition's internal call inside
 *     `enterStageOnceV1`.
 *   - `materializeCanonicalIfNeeded` (`implementationArtifactResolver.ts`) —
 *     unconditionally calls `recoverStageEntryJournalIfPresentV1` at its own
 *     head, so EVERY production caller of this function must itself be
 *     proven lock-free, not just its own internal call. It has exactly two
 *     production call sites, both in `reviewActions.ts`, both plain
 *     command/helper code with no covering lock anywhere in their call path.
 *   - `enterStageV1` (`stageTransition.ts`) — the exported front door.
 *     `enterStageOnceV1`'s body calls `prepareStageEntryV1` at its own head
 *     (unless `options.callerHoldsCoveringLock` suppresses the proactive
 *     recovery — see that option's doc comment), and a failed attempt's
 *     recovery-and-retry branch calls `recoverStageEntryJournalV1` directly.
 *     A caller of `enterStageV1` that already holds `withTaskLock` and does
 *     NOT pass `callerHoldsCoveringLock: true` would deadlock exactly like a
 *     direct caller of the functions above. Every production call site is
 *     tracked here; the one caller that can run from inside a held lock
 *     (`resumeTaskRowV1.ts`'s `executeResumeTaskV1`, via
 *     `taskActivationCoordinator`'s `skipTaskLock`) is verified to pass
 *     `callerHoldsCoveringLock: context.skipTaskLock === true`, not merely
 *     assumed safe.
 *
 * Every hit below was individually read in context and confirmed to run
 * after a covering lock (if any) had already released, before one is ever
 * acquired, or — for the two `enterStageV1` options above — with the
 * caller correctly declaring that it already holds one. See each allowlist
 * entry's reason, which names the evidence.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

const TRACKED_FUNCTIONS = [
  "recoverStageEntryJournalV1",
  "recoverStageEntryJournalIfPresentV1",
  "runStageEntryPostCommitV1",
  "prepareStageEntryV1",
  "materializeCanonicalIfNeeded",
  "enterStageV1",
] as const;

/**
 * Strips `//` and `/* *\/` comments while preserving newlines and string
 * contents, so a `//` inside a string (e.g. a URL) is never mistaken for a
 * comment start and a token split across lines still recovers the correct
 * line via character offset. Deliberately the same shape as
 * `stageMutatorSourceScanV1.test.ts`'s helper of the same name (duplicated,
 * not imported — every source-scan test in this codebase is self-contained
 * so its assumptions are auditable in one file).
 */
function stripCommentsPreservingLines(content: string): string {
  let result = "";
  let stringChar: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = i + 1 < content.length ? content[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        i++;
      } else {
        result += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (stringChar !== null) {
      result += ch;
      if (ch === "\\" && next !== "") {
        result += next;
        i++;
        continue;
      }
      if (ch === stringChar) {
        stringChar = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      result += ch;
      continue;
    }
    result += ch;
  }
  return result;
}

function buildLineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function lineForOffset(lineStartOffsets: number[], index: number): number {
  let lo = 0;
  let hi = lineStartOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStartOffsets[mid]! <= index) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

/**
 * Line numbers (1-based, ascending, deduplicated) of every CALL to `name` —
 * `name(` or `name\n  (`, i.e. excluding an `export {...}`/import list
 * mention or a bare reference with no immediately-following (possibly
 * multiline) open paren. A `function name(`/`async function name(`
 * declaration also matches this shape; declarations are excluded by the
 * caller via `DEFINITION_LINES` rather than here, so this stays one simple
 * pattern for both calls and declarations.
 */
function findCallLines(content: string, name: string): number[] {
  const stripped = stripCommentsPreservingLines(content);
  const lineStartOffsets = buildLineStartOffsets(stripped);
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  const lines = new Set<number>();
  for (const match of stripped.matchAll(pattern)) {
    lines.add(lineForOffset(lineStartOffsets, match.index));
  }
  return Array.from(lines).sort((a, b) => a - b);
}

/** See {@link AllowlistEntry.snippet}'s doc comment. */
const SNIPPET_MAX_CHARS = 160;

/** The character offset, within `text`, of the `(` at `openIndex`'s balanced close. -1 if unbalanced. */
function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Every call SITE to `name` (line plus a stable {@link AllowlistEntry.snippet}
 * — the call's own source text, `name` through its balanced closing paren,
 * normalized and capped), one per distinct line (mirrors {@link findCallLines}'s
 * dedupe-by-line behavior).
 */
function findCallSites(content: string, name: string): Array<{ line: number; snippet: string }> {
  const stripped = stripCommentsPreservingLines(content);
  const lineStartOffsets = buildLineStartOffsets(stripped);
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  const sites: Array<{ line: number; snippet: string }> = [];
  const seenLines = new Set<number>();
  for (const match of stripped.matchAll(pattern)) {
    const line = lineForOffset(lineStartOffsets, match.index);
    if (seenLines.has(line)) {
      continue;
    }
    seenLines.add(line);
    const openParen = match.index + match[0].length - 1;
    const close = findMatchingParen(stripped, openParen);
    const end = close === -1 ? Math.min(content.length, openParen + 200) : close + 1;
    const snippet = content.slice(match.index, end).replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS);
    sites.push({ line, snippet });
  }
  return sites;
}

interface AllowlistEntry {
  /**
   * A normalized (whitespace-collapsed) prefix of the call's own source text
   * — from the tracked function's name through its balanced closing paren,
   * capped at SNIPPET_MAX_CHARS — NOT a line number (1.0 plan item 14): an
   * unrelated edit elsewhere in the file no longer requires updating every
   * entry below it. An entry only goes stale when the call's own text
   * changes or is removed. When two distinct call sites in the same file
   * happen to share identical short text (e.g. two bare
   * `recoverStageEntryJournalV1(taskFolderUri)` calls), their entries
   * legitimately carry the same snippet — matching is by SET membership (N
   * occurrences require N matching entries), not a 1:1 site-to-entry
   * pairing, so this is still exact: a THIRD unreviewed occurrence of the
   * same text would still be caught as unallowlisted.
   */
  readonly snippet: string;
  readonly reason: string;
}

/**
 * Every allowlisted call-site for each tracked function, keyed first by
 * function name and then by path relative to `src/` (forward slashes). A
 * function's OWN declaration is included here too (with a reason explaining
 * it is the definition, not a call this scan cares about) so the declaration
 * itself does not need a separate exclusion mechanism — it is just another
 * allowlisted entry.
 */
const ALLOWLIST: ReadonlyMap<string, ReadonlyMap<string, readonly AllowlistEntry[]>> = new Map([
  [
    "recoverStageEntryJournalV1",
    new Map([
      [
        "utils/stageEntryJournalV1.ts",
        [
          { snippet: "recoverStageEntryJournalV1( taskFolderUri: vscode.Uri )", reason: "the function's own declaration" },
          {
            snippet: "recoverStageEntryJournalV1(taskFolderUri)",
            reason:
              "recoverStageEntryJournalIfPresentV1's delegation, after its own cheap lock-free existence " +
              "probe found a journal present — no lock is held at this point",
          },
        ],
      ],
      [
        "utils/stageTransition.ts",
        [
          {
            snippet: "recoverStageEntryJournalV1(taskFolderUri)",
            reason:
              "enterStageV1's own recover-and-retry-once path, reached only after enterStageOnceV1 has " +
              "already returned — its patchTaskProgressStrictV1/withTaskLock hold has released by the " +
              "time a rejection can propagate here",
          },
          {
            snippet: "recoverStageEntryJournalV1(taskFolderUri)",
            reason:
              "onCommitFailure, reached only after advanceStage's own patchTaskProgressStrictV1 call has " +
              "rejected — its withTaskLock hold releases before the rejection propagates to this catch " +
              "(see this call's own doc comment in stageTransition.ts). NOTE: this file has TWO calls " +
              "with this identical short text (this one and the recover-and-retry-once path above); " +
              "matching is by set membership (2 entries, 2 occurrences), not a 1:1 pairing — see " +
              "AllowlistEntry's doc comment.",
          },
        ],
      ],
    ]),
  ],
  [
    "recoverStageEntryJournalIfPresentV1",
    new Map([
      [
        "utils/stageEntryJournalV1.ts",
        [{ snippet: "recoverStageEntryJournalIfPresentV1( taskFolderUri: vscode.Uri )", reason: "the function's own declaration" }],
      ],
      [
        "utils/stageTransition.ts",
        [
          {
            snippet: "recoverStageEntryJournalIfPresentV1(taskFolderUri)",
            reason:
              "prepareStageEntryV1's own proactive-recovery call, at the very head of enterStageOnceV1 " +
              "(before advanceStage/patchTaskProgressStrictV1 ever acquires withTaskLock for this " +
              "transition) — see prepareStageEntryV1's own doc comment",
          },
        ],
      ],
      [
        "utils/reopenTask.ts",
        [
          {
            snippet: "recoverStageEntryJournalIfPresentV1(vscode.Uri.file(task.taskFolderPath))",
            reason:
              "reopenCompletedTask's own proactive recovery, run BEFORE activateTask ever acquires its " +
              "meta-root lock — see this call's own doc comment (review fix, 2026-09-23)",
          },
        ],
      ],
      [
        "utils/implementationArtifactResolver.ts",
        [
          {
            snippet: "recoverStageEntryJournalIfPresentV1(taskFolderUri)",
            reason:
              "materializeCanonicalIfNeeded's own proactive recovery — its doc comment records that " +
              "neither production caller of this function holds withTaskLock.",
          },
        ],
      ],
      [
        "commands/scheduleTaskResume.ts",
        [
          {
            snippet: "recoverStageEntryJournalIfPresentV1(vscode.Uri.file(task.taskFolderPath))",
            reason:
              "the activation sweep's per-task proactive recovery (armAll's recoverStageEntryJournalsV1) " +
              "— a best-effort loop over the inventory with no covering lock held around it",
          },
        ],
      ],
    ]),
  ],
  [
    "runStageEntryPostCommitV1",
    new Map([
      [
        "utils/stageTransition.ts",
        [{ snippet: "runStageEntryPostCommitV1( taskFolderUri: vscode.Uri, result: StageEntryPostCommitPayloadV1 )", reason: "the function's own declaration" }],
      ],
      [
        "utils/stageEntryJournalV1.ts",
        [
          {
            snippet:
              "runStageEntryPostCommitV1(taskFolderUri, { deferredPlanRevisionAdoption: deferredAdoption, journalTransitionId: transitionId, })",
            reason:
              "recoverAndReplayCommittedJournalV1's Phase B/C delegation, reached only after Phase A's " +
              "own withTaskLock hold (recoverStageEntryJournalPhaseAV1) has already returned",
          },
        ],
      ],
      [
        "utils/reopenTask.ts",
        [
          {
            snippet: "runStageEntryPostCommitV1(vscode.Uri.file(task.taskFolderPath), deferredPostCommit)",
            reason:
              "reopenCompletedTask's deferred post-commit work, run only after activateTask has returned " +
              "— its meta-root lock has released by this point",
          },
        ],
      ],
      [
        "actions/rows/nextStageRowV1.ts",
        [
          {
            snippet: "runStageEntryPostCommitV1(taskFolderUri, result)",
            reason:
              "executeNextStageV1, run only after enterStageV1's own patchTaskProgressStrictV1 call has " +
              "already returned",
          },
        ],
      ],
      [
        "actions/rows/resumeTaskRowV1.ts",
        [
          {
            snippet: "runStageEntryPostCommitV1(taskFolderUri, entryResult)",
            reason:
              "executeResumeTaskV1, guarded by `!context.skipTaskLock` — the one caller that sets " +
              "skipTaskLock (taskActivationCoordinator, via resumeTaskRowV1's own postCommitSink) hands " +
              "this work back to reopenTask.ts:213 instead, which is separately allowlisted above",
          },
        ],
      ],
      [
        "commands/setTaskStage.ts",
        [
          {
            snippet: "runStageEntryPostCommitV1(taskFolderUri, entryResult)",
            reason:
              "setTaskStage's own command body, run only after its enterStageV1 call has returned. " +
              "The CAS sourceStage fed to enterStageV1 is the caller's expectedSourceStage when supplied; " +
              "cancellation of the outgoing stage's operation is requested only via the post-commit " +
              "cancelRunningOperationsForTask call below, once enterStageV1 has already confirmed the " +
              "write landed.",
          },
        ],
      ],
      [
        "commands/planRevisionV1.ts",
        [
          {
            snippet: "runStageEntryPostCommitV1(folderUri, entryResult)",
            reason:
              "reviseChecklistChangeProposalConfirmed, run only after its enterStageV1 call has returned",
          },
        ],
      ],
      [
        "commands/reviewActions.ts",
        [
          {
            snippet: "runStageEntryPostCommitV1(ctx.folderUri, entryResult)",
            reason:
              "handleGenerateImplementationOutcomeV1, run only after its enterStageV1 call has returned.",
          },
          {
            snippet: "runStageEntryPostCommitV1(folderUri, implEntry)",
            reason:
              "executeImplementationRun, run only after its enterStageV1 call has returned.",
          },
        ],
      ],
    ]),
  ],
  [
    "prepareStageEntryV1",
    new Map([
      [
        "utils/stageTransition.ts",
        [
          {
            snippet:
              "prepareStageEntryV1( taskFolderUri: vscode.Uri, destinationStage: TaskStage, options?: { requireExistingArtifact?: boolean; /** * Set only by `enterStageOnceV1`",
            reason: "the function's own declaration",
          },
          {
            snippet:
              "prepareStageEntryV1(taskFolderUri, destinationStage, { requireExistingArtifact: kind === \"reopen\", skipProactiveRecovery: options.callerHoldsCoveringLock, })",
            reason:
              "enterStageOnceV1's own call, at the very head of the function, before advanceStage/ " +
              "patchTaskProgressStrictV1 ever acquires withTaskLock for this transition",
          },
        ],
      ],
      [
        "commands/reviewActions.ts",
        [
          {
            snippet: "prepareStageEntryV1(folderUri, next)",
            reason:
              "the score-based auto-advance's own 'friendly pre-check' (a real race is still caught by " +
              "enterStageV1's own CAS, per this call's own comment) — plain command-handler code, no " +
              "covering lock held.",
          },
          {
            snippet: "prepareStageEntryV1(resolved.folderUri, next)",
            reason:
              "manual Next Stage's own 'friendly pre-check', same shape as the entry above — plain " +
              "command-handler code, no covering lock held.",
          },
        ],
      ],
    ]),
  ],
  [
    "materializeCanonicalIfNeeded",
    new Map([
      [
        "utils/implementationArtifactResolver.ts",
        [
          {
            snippet: "materializeCanonicalIfNeeded( taskFolderUri: vscode.Uri )",
            reason: "the function's own declaration.",
          },
        ],
      ],
      [
        "commands/reviewActions.ts",
        [
          {
            snippet: "materializeCanonicalIfNeeded(folderUri)",
            reason:
              "buildApplyReviewPromptPartsV1, called only from applyImplementationReviewWithAI (its " +
              "own shrink loop) and from executeImplementationRun's source-review reconstruction branch " +
              "— both plain command-handler/helper code with no withTaskLock acquired anywhere earlier " +
              "in either call path.",
          },
          {
            snippet: "materializeCanonicalIfNeeded(resolved.folderUri)",
            reason:
              "runImplementationWithAI's runTrackedOperation callback — runTrackedOperation " +
              "(taskOperations.ts) never acquires withTaskLock itself, and nothing earlier in this " +
              "callback does either.",
          },
        ],
      ],
    ]),
  ],
  [
    "enterStageV1",
    new Map([
      [
        "utils/stageTransition.ts",
        [
          {
            snippet:
              "enterStageV1( taskFolderUri: vscode.Uri, sourceStage: TaskStage, destinationStage: TaskStage, isPaused: boolean, kind: TransitionKind, options: { optIn?: boolea",
            reason: "the function's own declaration",
          },
          {
            snippet: "enterStageV1(taskFolderUri, sourceStage, destinationStage, isPaused, kind, options, true)",
            reason:
              "the function's own single-retry recursion, reached only after recoverStageEntryJournalV1 " +
              "(already allowlisted above) has itself returned — its withTaskLock hold has " +
              "released by the time this recursive call runs, and `retrying=true` on the recursive call " +
              "prevents a second recovery/retry cycle",
          },
        ],
      ],
      [
        "actions/rows/nextStageRowV1.ts",
        [
          {
            snippet:
              "enterStageV1( taskFolderUri, input.expectedSourceStage, destinationStage, /* isPaused */ false, // Inert here: the transform below always overrides advanceStage",
            reason:
              "executeNextStageV1's own command body — plain row-execution code, no covering lock held; " +
              "callerHoldsCoveringLock is not needed here because this row is never invoked from inside " +
              "activateTaskLocked's meta-root lock",
          },
        ],
      ],
      [
        "actions/rows/resumeTaskRowV1.ts",
        [
          {
            snippet:
              "enterStageV1( taskFolderUri, sourceStage, input.selectedStage, /* isPaused */ false, // Inert: \"reopen\" is never AUTO_REVIEW_ELIGIBLE. \"reopen\", { deps: { patch",
            reason:
              "executeResumeTaskV1 — the one call site that CAN run from inside " +
              "activateTaskLocked's held meta-root lock (when context.skipTaskLock is set by " +
              "taskActivationCoordinator). Verified this call passes " +
              "`callerHoldsCoveringLock: context.skipTaskLock === true` (this function's own comment " +
              "above the call), which makes enterStageOnceV1 skip its internal proactive recovery and " +
              "makes enterStageV1's retry branch skip recoverStageEntryJournalV1 — the caller " +
              "(reopenCompletedTask, reopenTask.ts:116, already allowlisted above) already ran the " +
              "equivalent recovery itself, lock-free, before ever acquiring that lock",
          },
        ],
      ],
      [
        "commands/setTaskStage.ts",
        [
          {
            snippet:
              "enterStageV1( taskFolderUri, expectedSourceStage ?? task.progress.currentStage, newStage, false, kind, { optIn: AUTO_REVIEW_ELIGIBLE_KINDS.has(kind), } )",
            reason:
              "setTaskStage's own command body — plain command-handler code, no covering lock held. " +
              "See the runStageEntryPostCommitV1 entry above for the same file.",
          },
        ],
      ],
      [
        "commands/generatePlanWithAI.ts",
        [
          {
            snippet:
              "enterStageV1( taskFolderUri, sourceStage, destinationStage, /* isPaused */ false, // Inert: \"generate-plan\" is never AUTO_REVIEW_ELIGIBLE, so isPaused cannot af",
            reason:
              "handleGeneratePlanOutcomeV1's own outcome-handling body — plain command-handler code, " +
              "no covering lock held anywhere earlier in the function",
          },
        ],
      ],
      [
        "commands/planRevisionV1.ts",
        [
          {
            snippet:
              "enterStageV1( folderUri, sourceStage, \"plan\", /* isPaused */ false, // Inert: \"plan-revision\" is never AUTO_REVIEW_ELIGIBLE. \"plan-revision\", { transform: (curr",
            reason:
              "reviseChecklistChangeProposalConfirmed's own command body — plain command-handler code, " +
              "no covering lock held",
          },
        ],
      ],
      [
        "commands/reviewActions.ts",
        [
          {
            snippet: "enterStageV1( ctx.folderUri, \"impl\", \"impl\", false, \"generate-implementation\" )",
            reason:
              "handleGenerateImplementationOutcomeV1's own outcome-handling body (same function tracked " +
              "for runStageEntryPostCommitV1 above) — plain command-handler code, no " +
              "covering lock held anywhere earlier in the function.",
          },
          {
            snippet:
              "enterStageV1( folderUri, sourceStageBeforeImplEntry, \"impl\", /* isPaused */ false, // Inert: \"implementation-run\" is never AUTO_REVIEW_ELIGIBLE. \"implementation",
            reason:
              "executeImplementationRun's stage-entry branch (same function tracked for " +
              "runStageEntryPostCommitV1 above) — plain command-handler code, no " +
              "covering lock held anywhere earlier in the function.",
          },
        ],
      ],
    ]),
  ],
]);

function collectSourceFiles(dir: string, fileList: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "test-host") {
        continue;
      }
      collectSourceFiles(filePath, fileList);
    } else if (entry.name.endsWith(".ts")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

void describe("stage-entry recovery lock source scan (Part 2, item 15 hardening)", () => {
  void it("scans the real TypeScript sources", () => {
    assert.ok(fs.existsSync(SRC_DIR), `Expected source directory at ${SRC_DIR}`);
    assert.ok(
      collectSourceFiles(SRC_DIR).length > 20,
      "Expected to discover the extension's source files; the scan root is wrong."
    );
  });

  void it("self-test: the call finder can actually fail", () => {
    assert.deepStrictEqual(findCallLines('await recoverStageEntryJournalV1(uri);', "recoverStageEntryJournalV1"), [1]);
    assert.deepStrictEqual(
      findCallLines("// await recoverStageEntryJournalV1(uri);\nconst x = 1;", "recoverStageEntryJournalV1"),
      []
    );
    assert.deepStrictEqual(
      findCallLines("import { recoverStageEntryJournalV1 } from \"./x\";", "recoverStageEntryJournalV1"),
      []
    );
    // A token split across lines must still be caught, at the line the
    // identifier starts on — the same multiline guarantee the stage-mutator
    // scan relies on.
    assert.deepStrictEqual(
      findCallLines("await recoverStageEntryJournalV1\n  (uri);", "recoverStageEntryJournalV1"),
      [1]
    );
    // A second, unreviewed call landing on a NEW line must be detectable.
    assert.deepStrictEqual(
      findCallLines(
        "await runStageEntryPostCommitV1(a, b);\nawait runStageEntryPostCommitV1(c, d);",
        "runStageEntryPostCommitV1"
      ),
      [1, 2]
    );
  });

  for (const fn of TRACKED_FUNCTIONS) {
    void it(`every call to ${fn} sits at an allowlisted call site`, () => {
      const allowlist = ALLOWLIST.get(fn);
      assert.ok(allowlist, `No allowlist registered for tracked function ${fn}`);

      const newOrMoved: string[] = [];
      const stale: string[] = [];
      const seenAllowlistKeys = new Set<string>();

      for (const file of collectSourceFiles(SRC_DIR)) {
        const srcRelativeKey = path.relative(SRC_DIR, file).split(path.sep).join("/");
        const content = fs.readFileSync(file, "utf8");
        const sites = findCallSites(content, fn);
        const allowed = allowlist.get(srcRelativeKey) ?? [];
        if (allowlist.has(srcRelativeKey)) {
          seenAllowlistKeys.add(srcRelativeKey);
        }
        // Set-membership matching by snippet (not a 1:1 site<->entry
        // pairing, and never by line — see AllowlistEntry's doc comment):
        // each entry may satisfy at most one site, so N identically-texted
        // sites still require N entries.
        const claimedEntries = new Set<AllowlistEntry>();
        for (const site of sites) {
          const match = allowed.find(
            (entry) => !claimedEntries.has(entry) && site.snippet.includes(entry.snippet)
          );
          if (match) {
            claimedEntries.add(match);
          } else {
            newOrMoved.push(`${path.relative(REPO_ROOT, file)}:${site.line} :: ${site.snippet}`);
          }
        }
        for (const entry of allowed) {
          if (!claimedEntries.has(entry)) {
            stale.push(`${srcRelativeKey} ("${entry.reason}") snippet: ${entry.snippet}`);
          }
        }
      }
      for (const key of allowlist.keys()) {
        if (!seenAllowlistKeys.has(key)) {
          stale.push(`${key} (no file found at this src/-relative path — the allowlist key itself is stale)`);
        }
      }

      assert.deepStrictEqual(
        newOrMoved,
        [],
        `These calls to ${fn} are not on the allowlist (new, moved, or an unreviewed second ` +
          "call in an already-allowlisted file) — prove this call site runs outside any covering " +
          `withTaskLock/withMetaRootLock hold and add a reviewed entry, or remove the call: ` +
          newOrMoved.join(", ")
      );
      assert.deepStrictEqual(
        stale,
        [],
        `These ALLOWLIST entries for ${fn} no longer match any call site — the call's own text ` +
          "changed or the call was removed; update the entry's snippet (do not delete the entry " +
          "unless the call itself is gone): " +
          stale.join(", ")
      );
    });
  }

  void it("stable-key robustness: inserting unrelated lines elsewhere in a file does not break the allowlist scan (1.0 plan item 14)", () => {
    const original =
      'import { unrelated } from "./x";\n\nasync function caller(taskFolderUri: vscode.Uri) {\n  await runStageEntryPostCommitV1(taskFolderUri, entryResult);\n}\n';
    const withInsertedLines =
      'import { unrelated } from "./x";\n' +
      "// a completely unrelated comment inserted above the call\n".repeat(20) +
      '\nasync function caller(taskFolderUri: vscode.Uri) {\n  await runStageEntryPostCommitV1(taskFolderUri, entryResult);\n}\n';

    const originalSites = findCallSites(original, "runStageEntryPostCommitV1");
    const shiftedSites = findCallSites(withInsertedLines, "runStageEntryPostCommitV1");

    assert.equal(originalSites.length, 1);
    assert.equal(shiftedSites.length, 1);
    // The line moved (20 unrelated lines were inserted above the call)...
    assert.notEqual(originalSites[0]!.line, shiftedSites[0]!.line);
    // ...but the snippet — the actual matching key — did not.
    assert.equal(originalSites[0]!.snippet, shiftedSites[0]!.snippet);
  });
});
