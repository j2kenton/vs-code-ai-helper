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
 * its own one-door proof honest: an exact-line allowlist, each entry with a
 * reason, that fails on a hit at any OTHER line (new, moved, or an
 * unreviewed second call in an already-allowlisted file) and on a listed
 * line that no longer matches anything (a stale entry).
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

interface AllowlistEntry {
  readonly line: number;
  readonly reason: string;
}

/**
 * Every allowlisted call-site line for each tracked function, keyed first by
 * function name and then by path relative to `src/` (forward slashes). A
 * function's OWN declaration line is included here too (with a reason
 * explaining it is the definition, not a call this scan cares about) so the
 * declaration itself does not need a separate exclusion mechanism — it is
 * just another allowlisted line.
 */
const ALLOWLIST: ReadonlyMap<string, ReadonlyMap<string, readonly AllowlistEntry[]>> = new Map([
  [
    "recoverStageEntryJournalV1",
    new Map([
      [
        "utils/stageEntryJournalV1.ts",
        [
          { line: 561, reason: "the function's own declaration" },
          {
            line: 593,
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
            line: 811,
            reason:
              "enterStageV1's own recover-and-retry-once path, reached only after enterStageOnceV1 has " +
              "already returned — its patchTaskProgressStrictV1/withTaskLock hold has released by the " +
              "time a rejection can propagate here",
          },
          {
            line: 1094,
            reason:
              "onCommitFailure, reached only after advanceStage's own patchTaskProgressStrictV1 call has " +
              "rejected — its withTaskLock hold releases before the rejection propagates to this catch " +
              "(see this call's own doc comment in stageTransition.ts)",
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
        [{ line: 586, reason: "the function's own declaration" }],
      ],
      [
        "utils/stageTransition.ts",
        [
          {
            line: 562,
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
            line: 116,
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
            line: 1170,
            reason:
              "materializeCanonicalIfNeeded's own proactive recovery — its doc comment records that " +
              "neither production caller of this function holds withTaskLock. (Line moved 1102 -> 1170: " +
              "this round's fix for the no-op continuation (item 16 / Part 4 step 10) shifted the whole " +
              "function, net +68 lines.)",
          },
        ],
      ],
      [
        "commands/scheduleTaskResume.ts",
        [
          {
            line: 1022,
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
        [{ line: 1210, reason: "the function's own declaration" }],
      ],
      [
        "utils/stageEntryJournalV1.ts",
        [
          {
            line: 540,
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
            line: 213,
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
            line: 291,
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
            line: 261,
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
            line: 493,
            reason:
              "setTaskStage's own command body, run only after its enterStageV1 call has returned. " +
              "(Line moved 297 -> 371 -> 405 -> 401 -> 416 -> 455 -> 491 -> 495 -> 493: this round's fix for the narrowed stale-" +
              "Advance-card blocker c2453680-fe42-461b-9652-1f87445cb9d3-0 — the CAS sourceStage fed to " +
              "enterStageV1 is now the caller's expectedSourceStage when supplied, and the !entryResult.ready " +
              "branch grew the CAS-mismatch/already-there disambiguation this fix required — added doc " +
              "comment and branching above the enterStageV1 call, net; then a further-narrowing round " +
              "inserted a fresh pre-cancel re-read and its own CAS-mismatch/already-there branching above " +
              "the cancelRunningOperationsForTask call, above the enterStageV1 call, net; then a round " +
              "closed the remaining cancel-before-CAS race structurally instead of narrowing it again — " +
              "removing that pre-cancel re-read entirely and moving cancelRunningOperationsForTask to run " +
              "only after enterStageV1 has committed the transition, net -4 lines; then a round closed the " +
              "reviewer's completion blocker on THAT reordering (dispatching brand-new automated work for " +
              "the destination stage while the outgoing stage's operation was not confirmed to have actually " +
              "stopped) by adding an explanatory comment block above the cancelRunningOperationsForTask call " +
              "and gating the shouldAutoReview dispatch below on cancelResult.ok, net +15 lines; then this " +
              "round closed the reviewer's next completion blocker on THAT gate (a second, independent " +
              "cancelRunningOperationsForTask call made by resumeAndSetTaskStageV1 after this one could not " +
              "observe a forced end this call had already recorded, since the operation row is gone by the " +
              "time a second call could see it) by depositing this call's own cancelResult into an " +
              "optional caller-supplied box (`cancelResultOutV1`) instead of leaving the caller to guess — " +
              "added the deposit plus its doc comment above and beside this call site, net +24 lines; then " +
              "a round's fix for the narrowed completion blocker 906d1f21-e807-48d3-9468-62856cdc7e7a-0 " +
              "added an `additionalBeforeWrite` option (requesting cancellation from inside the locked " +
              "write, before the new stage's bytes landed) plus its doc comment above the enterStageV1 " +
              "call, net +24 lines; then this round reverted that option as architecturally unsafe (a " +
              "failed write could leave a genuinely unrelated operation cancelled for a transition that " +
              "never committed) — cancellation is requested only via the post-commit " +
              "cancelRunningOperationsForTask call below, once enterStageV1 has already confirmed the " +
              "write landed — replacing both comment blocks and removing the additionalBeforeWrite option, " +
              "net -2 lines.)",
          },
        ],
      ],
      [
        "commands/planRevisionV1.ts",
        [
          {
            line: 283,
            reason:
              "reviseChecklistChangeProposalConfirmed, run only after its enterStageV1 call has returned",
          },
        ],
      ],
      [
        "commands/reviewActions.ts",
        [
          {
            line: 9573,
            reason:
              "handleGenerateImplementationOutcomeV1, run only after its enterStageV1 call has returned. " +
              "(Line moved 9518 -> 9519 -> 9573: this round's fix for the no-op continuation (item 16 / " +
              "Part 4 step 10) added a writeRunLog call earlier in the file, shifting this line by 54.)",
          },
          {
            line: 11913,
            reason:
              "executeImplementationRun, run only after its enterStageV1 call has returned. " +
              "(Line moved 11858 -> 11859 -> 11913: same shift as above.)",
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
          { line: 506, reason: "the function's own declaration" },
          {
            line: 849,
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
            line: 4367,
            reason:
              "the score-based auto-advance's own 'friendly pre-check' (a real race is still caught by " +
              "enterStageV1's own CAS, per this call's own comment) — plain command-handler code, no " +
              "covering lock held. (Line moved 4363 -> 4364 -> 4367: this round's fix for the no-op " +
              "continuation (item 16 / Part 4 step 10) shifted this line by 3.)",
          },
          {
            line: 9195,
            reason:
              "manual Next Stage's own 'friendly pre-check', same shape as line 4367 — plain " +
              "command-handler code, no covering lock held. (Line moved 9140 -> 9141 -> 9195: same shift " +
              "as above, plus this round's writeRunLog addition.)",
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
            line: 1160,
            reason:
              "the function's own declaration. (Line moved 1092 -> 1160: this round's fix for the no-op " +
              "continuation (item 16 / Part 4 step 10) shifted the whole function, net +68 lines.)",
          },
        ],
      ],
      [
        "commands/reviewActions.ts",
        [
          {
            line: 8442,
            reason:
              "buildApplyReviewPromptPartsV1, called only from applyImplementationReviewWithAI (its " +
              "own shrink loop) and from executeImplementationRun's source-review reconstruction branch " +
              "— both plain command-handler/helper code with no withTaskLock acquired anywhere earlier " +
              "in either call path. (Line moved 8387 -> 8388 -> 8442: this round's fix for the no-op " +
              "continuation (item 16 / Part 4 step 10) shifted this line by 54.)",
          },
          {
            line: 12884,
            reason:
              "runImplementationWithAI's runTrackedOperation callback — runTrackedOperation " +
              "(taskOperations.ts) never acquires withTaskLock itself, and nothing earlier in this " +
              "callback does either. (Line moved 12720 -> 12740 -> 12774 -> 12884: this round's own fix " +
              "for the no-op-continuation completion blocker (2026-09-24 review, narrowed) added a " +
              "canonicalExistedBeforeMaterialize existence check, with an explanatory comment, above this " +
              "call, net +110.)",
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
          { line: 775, reason: "the function's own declaration" },
          {
            line: 812,
            reason:
              "the function's own single-retry recursion, reached only after recoverStageEntryJournalV1 " +
              "(line 811, already allowlisted above) has itself returned — its withTaskLock hold has " +
              "released by the time this recursive call runs, and `retrying=true` on the recursive call " +
              "prevents a second recovery/retry cycle",
          },
        ],
      ],
      [
        "actions/rows/nextStageRowV1.ts",
        [
          {
            line: 215,
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
            line: 149,
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
            line: 370,
            reason:
              "setTaskStage's own command body — plain command-handler code, no covering lock held. " +
              "(Line moved 267 -> 313 -> 347 -> 312 -> 341 -> 365 -> 370: a round's fix for the narrowed " +
              "completion blocker 906d1f21-e807-48d3-9468-62856cdc7e7a-0 added an `additionalBeforeWrite` " +
              "option (requesting cancellation of the outgoing stage's operation atomically inside the " +
              "locked commit, before the new stage's bytes land) plus its doc comment above this call, " +
              "net +24 lines; then this round reverted that option as architecturally unsafe and replaced " +
              "the doc comment explaining why cancellation is requested post-commit instead, net +5 lines; " +
              "see the runStageEntryPostCommitV1 entry above for the same file.)",
          },
        ],
      ],
      [
        "commands/generatePlanWithAI.ts",
        [
          {
            line: 650,
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
            line: 226,
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
            line: 9554,
            reason:
              "handleGenerateImplementationOutcomeV1's own outcome-handling body (same function tracked " +
              "for runStageEntryPostCommitV1 at line 9573 above) — plain command-handler code, no " +
              "covering lock held anywhere earlier in the function. (Line moved 9499 -> 9500 -> 9554: " +
              "this round's fix for the no-op continuation (item 16 / Part 4 step 10) shifted this line " +
              "by 54.)",
          },
          {
            line: 11900,
            reason:
              "executeImplementationRun's stage-entry branch (same function tracked for " +
              "runStageEntryPostCommitV1 at line 11913 above) — plain command-handler code, no " +
              "covering lock held anywhere earlier in the function. (Line moved 11845 -> 11846 -> 11900: " +
              "this round's own fix for the no-op-continuation completion blocker (2026-09-24 review, " +
              "narrowed) shifted this line by 54.)",
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
    void it(`every call to ${fn} sits at an allowlisted exact line`, () => {
      const allowlist = ALLOWLIST.get(fn);
      assert.ok(allowlist, `No allowlist registered for tracked function ${fn}`);

      const newOrMoved: string[] = [];
      const stale: string[] = [];
      const seenAllowlistKeys = new Set<string>();

      for (const file of collectSourceFiles(SRC_DIR)) {
        const srcRelativeKey = path.relative(SRC_DIR, file).split(path.sep).join("/");
        const content = fs.readFileSync(file, "utf8");
        const actualLines = new Set(findCallLines(content, fn));
        const allowed = allowlist.get(srcRelativeKey) ?? [];
        if (allowlist.has(srcRelativeKey)) {
          seenAllowlistKeys.add(srcRelativeKey);
        }
        const allowedLines = new Set(allowed.map((entry) => entry.line));
        for (const line of actualLines) {
          if (!allowedLines.has(line)) {
            newOrMoved.push(`${path.relative(REPO_ROOT, file)}:${line}`);
          }
        }
        for (const entry of allowed) {
          if (!actualLines.has(entry.line)) {
            stale.push(`${path.relative(REPO_ROOT, file)}:${entry.line} ("${entry.reason}")`);
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
        `These calls to ${fn} are not on the exact-line allowlist (new, moved, or an unreviewed second ` +
          "call in an already-allowlisted file) — prove this call site runs outside any covering " +
          `withTaskLock/withMetaRootLock hold and add a reviewed entry, or remove the call: ` +
          newOrMoved.join(", ")
      );
      assert.deepStrictEqual(
        stale,
        [],
        `These ALLOWLIST entries for ${fn} no longer match anything at their recorded line — the call ` +
          "moved or was removed; update the line number (do not delete the entry unless the call itself " +
          "is gone): " +
          stale.join(", ")
      );
    });
  }
});
