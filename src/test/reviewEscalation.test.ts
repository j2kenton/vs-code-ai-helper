/**
 * Coverage for escalateReviewToHuman's three write guards:
 *  - Terminal-status guard: a task the user already completed/archived must
 *    never be forced back to "paused" by an escalation decision computed
 *    against an earlier, now-stale snapshot.
 *  - Stage CAS: only pause when the task is still on the stage the
 *    escalation is about — if it already advanced (or was reverted)
 *    elsewhere, applying a stale escalation would pause it with a reason
 *    naming a stage it isn't on anymore.
 *  - Attempt CAS: only pause when `reviewAttemptId` still matches the round
 *    that decided to escalate. claimReviewAttempt overwrites this field at
 *    the START of every review round, same stage or not — so this catches
 *    the specific cross-window race the stage CAS alone cannot: window B
 *    claims a NEW attempt on the SAME stage while window A's escalation is
 *    still mid-flight (e.g. inside its own second-opinion AI call), and
 *    that new attempt publishes without advancing. `currentStage` never
 *    changes, so only the attempt id distinguishes "still window A's round"
 *    from "window B already superseded it".
 *
 * All three guards return the pre-existing `current` unchanged from inside
 * the patchTaskProgress callback, which patchTaskProgress's own
 * unchanged-value detection treats as "decline the write" (see
 * taskProgressUtils.ts) — so these tests assert the write never lands, not
 * just that no error is thrown.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { escalateReviewToHuman } from "../utils/reviewEscalation";
import { handleReviewRoutingOutcome } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { TaskProgress } from "../types/taskProgress";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { ReviewBlocker } from "../utils/reviewReadiness";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): void {
  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
    uri: vscode.Uri
  ): Promise<Uint8Array> => {
    // Review-fix regression (2026-08-25): production writes go through
    // `writeAtomic`, which always hits the real filesystem, bypassing this
    // stub entirely (see `readProgress`'s doc comment above, which already
    // reads real disk first for exactly this reason). A test that performs
    // TWO sequential `patchTaskProgressStrictV1` writes to the same folder
    // (e.g. `handleReviewRoutingOutcome`'s history-append followed by
    // `escalateReviewToHuman`'s own pause write) previously had its SECOND
    // read see only the stale, originally-seeded mem-store snapshot — never
    // the first write's real-disk result — so the second write silently
    // clobbered the first one's changes when it spread the stale `current`.
    // Reading real disk first here, exactly like `readProgress` already does,
    // keeps every read inside a test consistent with every write.
    if (fs.existsSync(uri.fsPath)) {
      return Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
    }
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile = (
    uri: vscode.Uri,
    data: Uint8Array
  ): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-escalation-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolderUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(TEST_ROOT, ".ensemble", name));
}

function seedProgress(store: MemStore, folderUri: vscode.Uri, progress: TaskProgress): void {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  // The strict patch (§3.12 cutover) validates taskFolder self-names the
  // folder — fixtures must agree with the directory they are seeded into,
  // or every write declines for the wrong reason.
  const named: TaskProgress = { ...progress, taskFolder: path.basename(folderUri.fsPath) };
  store.set(uri.toString(), JSON.stringify(named, null, 2));
}

function readProgress(store: MemStore, folderUri: vscode.Uri): TaskProgress {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  // writeTaskProgress persists via writeAtomic, which always hits the real
  // filesystem (bypassing the vscode.workspace.fs stub above) — so once
  // escalateReviewToHuman's patchTaskProgress call actually writes, the
  // real file on disk is the current state, not the seeded mem-store
  // snapshot. Mirrors taskProgressUtils.test.ts's readStoredProgress.
  if (fs.existsSync(uri.fsPath)) {
    return JSON.parse(fs.readFileSync(uri.fsPath, "utf8")) as TaskProgress;
  }
  return JSON.parse(store.get(uri.toString())!) as TaskProgress;
}

function baseProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

void describe("escalateReviewToHuman — terminal-status guard", () => {
  for (const terminalStatus of ["completed", "archived"] as const) {
    void it(`does not pause a ${terminalStatus} task`, async () => {
      const store = new Map<string, string>();
      installMemStore(store);
      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const folderUri = makeTaskFolderUri(`terminal-${terminalStatus}`);
      seedProgress(store, folderUri, baseProgress({ status: terminalStatus, reviewAttemptId: "attempt-1" }));

      try {
        const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
        // The return value IS the contract callers rely on: handleReviewRoutingOutcome
        // (reviewActions.ts) uses it to decide whether to suppress its own
        // auto-publish/auto-advance blocks. Before this fix, all three call
        // sites reported `{ escalated: true }` unconditionally regardless of
        // whether any of the three write guards below actually declined —
        // producing a round that published the review, recorded nothing,
        // said nothing, and advanced nothing.
        assert.strictEqual(escalated, false, "a declined write must be reported as not escalated");
        const after = readProgress(store, folderUri);
        assert.strictEqual(after.status, terminalStatus, "status must not be forced to paused");
        assert.strictEqual(after.escalation, undefined, "no escalation should be recorded either");
      } finally {
        deactivateNotificationRouter();
      }
    });
  }

  void it("still pauses an active task on the same stage with a matching attempt id (sanity check the guards aren't overbroad)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("active-still-pauses");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));

    try {
      const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
      assert.strictEqual(escalated, true, "an applied write must be reported as escalated");
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "paused");
      assert.strictEqual(after.escalation?.kind, "plateau");
      assert.strictEqual(after.escalation?.stage, "impl-high-review");
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("escalateReviewToHuman — stage CAS", () => {
  void it("does not pause when the task has already advanced past the stage the escalation is about", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("already-advanced");
    // Escalation decided against "impl-high-review", but by write time the
    // task has already moved on to "impl-low-review" (e.g. a concurrent
    // manual advance while the second-opinion AI call was still running).
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-low-review", reviewAttemptId: "attempt-1" }));

    try {
      const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
      assert.strictEqual(escalated, false);
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "active", "must not pause a task that has moved to a different stage");
      assert.strictEqual(after.escalation, undefined);
      assert.strictEqual(after.currentStage, "impl-low-review", "stage itself must be untouched");
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("escalateReviewToHuman — attempt CAS (cross-window race)", () => {
  void it("does not pause when a newer attempt has already claimed the SAME stage", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("newer-attempt-same-stage");
    // Window A decided to escalate for "attempt-A" on impl-high-review.
    // By write time (e.g. after A's own second-opinion AI call finished),
    // window B has already claimed and published a NEWER attempt on the
    // SAME stage — currentStage never changed, so the stage CAS alone
    // would not catch this.
    seedProgress(store, folderUri, baseProgress({
      status: "active",
      currentStage: "impl-high-review",
      reviewAttemptId: "attempt-B",
    }));

    try {
      const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck (window A)", "attempt-A");
      assert.strictEqual(escalated, false);
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "active", "must not pause a task a newer attempt already superseded");
      assert.strictEqual(after.escalation, undefined);
      assert.strictEqual(after.reviewAttemptId, "attempt-B", "window B's attempt id must survive untouched");
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("declines when the task has no recorded reviewAttemptId at all (ambiguous — treat as stale)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("no-attempt-id");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review" }));

    try {
      await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-A");
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "active");
      assert.strictEqual(after.escalation, undefined);
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("escalateReviewToHuman — records secondOpinionAttempted", () => {
  void it("persists secondOpinionAttempted when passed true", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("second-opinion-attempted-true");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-1" }));

    try {
      await escalateReviewToHuman(folderUri, "impl-high-review", "reviewer-disagreement", "disagree", "attempt-1", undefined, true);
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.escalation?.secondOpinionAttempted, true);
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("defaults secondOpinionAttempted to false for a direct escalation", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("second-opinion-attempted-default");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-1" }));

    try {
      await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.escalation?.secondOpinionAttempted, false);
    } finally {
      deactivateNotificationRouter();
    }
  });
});

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(TEST_ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

// wf10 item 7b — the plateau escalation is rebuilt as a WorkflowDecisionV1
// (quoted blocker, taskFixableCount/progress evidence, one ranked
// recommendation) whenever the caller supplies `reviewPlateauEvidence`,
// instead of the old plain chat question naming only the reason taxonomy.
void describe("escalateReviewToHuman — reviewPlateauEvidence posts a WorkflowDecisionV1", () => {
  void it("quotes the blocker verbatim and recommends advancing when nothing is task-fixable and the next stage hasn't run", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-advance");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));
    // impl-low-review.md deliberately left unseeded — "hasn't run yet".

    const blockers: ReviewBlocker[] = [
      { category: "review-confidence", resolver: "environmental", description: "The five live-AWS acceptance checks remain unexecuted" },
    ];

    try {
      const escalated = await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content: "Readiness: 8/10\n\n<!-- progress: 6/6 -->\n", blockers, taskFixableCount: 0 }
      );
      assert.strictEqual(escalated, true);

      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision, "a reviewPlateauEscalation decision must be posted");
      // The taxonomy of resolver kinds must never stand in for the actual
      // blocker text (item 7b, rule 1).
      assert.match(decision.whatHappened, /The five live-AWS acceptance checks remain unexecuted/);
      assert.doesNotMatch(decision.whatHappened, /environmental, unverifiable, a spec defect/);
      assert.match(decision.whyUserNeeded, /6 of 6 plan steps verified/);
      assert.match(decision.whyUserNeeded, /0 of the 1 remaining blocker/);
      assert.strictEqual(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.strictEqual(decision.recommendation.optionId, "advance");
      }
      assert.ok(
        decision.options.some((o) => o.optionId === "advance" && o.label === "Advance to Low-Level Code Review"),
        "must offer advancing to the next stage in STAGE_ORDER, named by its display name"
      );
      assert.ok(decision.gating?.holdsTaskPaused, "a plateau decision genuinely holds the task paused");

      // Review-narrowed blocker 57e9485f-…-1: "what clears this" must derive
      // the concrete action from the blocker's OWN resolver class, not
      // restate the whole non-task-fixable taxonomy every time.
      const clearsThis = decision.evidence?.find((e) => e.label === "What clears this");
      assert.ok(clearsThis);
      assert.match(clearsThis.detail, /infrastructure, sandbox, or OS-level fix/);
      assert.doesNotMatch(clearsThis.detail, /a human decision, an external system, or a toolchain step/);

      // The plain chat-question fallback must NOT also have fired.
      assert.strictEqual(
        surface.entries.some((e) => e.message.includes("Automated review iteration is stuck")),
        false,
        "the WorkflowDecisionV1 path replaces the plain chat question, it does not add to it"
      );
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, new architectural blocker): the ORIGINAL
  // version of this test asserted the opposite — that a recorded
  // `blockerSupersessions` entry suppressed the plateau decision even when
  // `evidence.blockers` is a FRESH review round's own finding. The review
  // correctly flagged that as unsafe: a supersession records that one
  // now-stale review artifact was resolved via chat, not a permanent verdict
  // on the blocker's text. A later, independent review round re-finding the
  // identically-worded blocker is strictly newer evidence than the chat
  // resolution and must never be silently masked by it — that is exactly how
  // a genuinely still-live blocker could vanish from history and routing
  // forever. `postReviewPlateauDecisionV1`'s `evidence.blockers` is always a
  // just-published round's own output (see `ReviewPlateauEvidenceV1`'s doc
  // comment), so this now asserts the decision DOES post, quoting the
  // blocker, despite the (stale, inapplicable) supersession on record.
  void it("still posts the plateau decision for a fresh review's blocker even when an older supersession recorded identical text", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-superseded");
    seedProgress(
      store,
      folderUri,
      baseProgress({
        status: "active",
        currentStage: "impl-high-review",
        reviewAttemptId: "attempt-1",
        blockerSupersessions: [
          {
            stage: "impl-high-review",
            blockerDescription: "The five live-AWS acceptance checks remain unexecuted",
            supersededAt: "2026-08-24T00:00:00.000Z",
            planRelPath: "plan.md",
          },
        ],
      })
    );

    const blockers: ReviewBlocker[] = [
      { category: "review-confidence", resolver: "environmental", description: "The five live-AWS acceptance checks remain unexecuted" },
    ];

    try {
      await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content: "Readiness: 8/10\n\n<!-- progress: 6/6 -->\n", blockers, taskFixableCount: 0 }
      );

      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(
        decision,
        "a fresh review's own blocker must post the plateau decision — a stale supersession must not mask it"
      );
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, new architectural blocker): companion to the
  // test above, exercising the actual production entry point
  // (`handleReviewRoutingOutcome`, reviewActions.ts) end to end. Previously
  // this asserted the round's own blocker was filtered out of
  // `reviewScoreHistory` and the task never paused, purely because an OLDER
  // supersession happened to share its text. That let a genuinely-still-live
  // blocker disappear from the durable record permanently, since a filtered
  // blocker was never even persisted for a later round to notice had
  // reappeared. It now asserts the opposite: this round's blocker is
  // persisted to history untouched and the task DOES escalate — a stale
  // supersession never suppresses fresh review output.
  void it("handleReviewRoutingOutcome still escalates on a fresh review's blocker even when an older supersession recorded identical text", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("routing-outcome-superseded");
    seedProgress(
      store,
      folderUri,
      baseProgress({
        status: "active",
        currentStage: "impl-high-review",
        reviewAttemptId: "attempt-superseded",
        blockerSupersessions: [
          {
            stage: "impl-high-review",
            blockerDescription: "the owner must approve a complete tie policy",
            supersededAt: "2026-08-24T00:00:00.000Z",
            planRelPath: "plan.md",
          },
        ],
      })
    );

    const content = [
      "Readiness: 6/10",
      "",
      "<!-- blockers:start -->",
      "- [architectural] [environmental] the owner must approve a complete tie policy",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-superseded",
        content,
        score: 6,
        threshold: 8,
      });
      assert.strictEqual(
        escalated,
        true,
        "an environmental-only blocker set escalates immediately regardless of an older, inapplicable supersession"
      );

      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "paused", "the task must pause on this round's own live blocker");
      assert.strictEqual(
        after.reviewScoreHistory?.[0]?.blockers?.length ?? 0,
        1,
        "this round's own blocker must be carried into the persisted review-score history, not silently dropped"
      );
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("recommends keeping iteration going when a task-fixable blocker remains", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-keep-iterating");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));

    const blockers: ReviewBlocker[] = [
      { category: "completion", resolver: "task-fixable", description: "The retry loop still swallows the second failure" },
    ];

    try {
      await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content: "Readiness: 5/10\n", blockers, taskFixableCount: 1 }
      );
      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision);
      assert.strictEqual(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.strictEqual(decision.recommendation.optionId, "keepIterating");
      }

      // Regression: a review flagged that "Keep iterating" dispatched plain
      // resumeTask (which only clears the pause) while its consequence text
      // claimed it "reruns" the stage. It must dispatch the command that
      // actually does both.
      const keepIterating = decision.options.find((o) => o.optionId === "keepIterating");
      assert.ok(keepIterating);
      assert.deepEqual(keepIterating.effect, {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndRerunReview",
        args: [{ taskFolderPath: folderUri.fsPath }],
      });

      // Regression: gating.detail previously said every option except "I'll
      // handle it myself" resumes or advances immediately — false for
      // "Reconsider the requirement itself", which is also doNothing. The
      // detail must name BOTH paused-and-dispatch-nothing options, not
      // imply only one exists.
      assert.match(decision.gating!.detail, /I'll handle it myself/);
      assert.match(decision.gating!.detail, /Reconsider the requirement itself/);
      assert.match(decision.gating!.detail, /leave|leaves/);
      const reconsiderRequirement = decision.options.find((o) => o.optionId === "reconsiderRequirement");
      assert.ok(reconsiderRequirement);
      assert.deepEqual(reconsiderRequirement.effect, { kind: "doNothing" });

      // Item 7b rule 5: name what would clear the blocker.
      assert.ok(
        decision.evidence?.some((e) => e.label === "What clears this"),
        "must name what would clear the blocker"
      );
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("derives a distinct clearing action per blocker resolver class (needs-toolchain vs environmental)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-needs-toolchain");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));

    const blockers: ReviewBlocker[] = [
      { category: "completion", resolver: "needs-toolchain", description: "The generated client is stale — run the codegen step" },
    ];

    try {
      await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content: "Readiness: 6/10\n", blockers, taskFixableCount: 0 }
      );
      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision);
      const clearsThis = decision.evidence?.find((e) => e.label === "What clears this");
      assert.ok(clearsThis);
      // Different resolver, different concrete action — not the generic
      // taxonomy, and not the environmental wording either.
      assert.match(clearsThis.detail, /build\/codegen\/toolchain step/);
      assert.doesNotMatch(clearsThis.detail, /infrastructure, sandbox, or OS-level fix/);
      assert.doesNotMatch(clearsThis.detail, /a human decision, an external system, or a toolchain step/);
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("derives an owner-decision clearing action for an environmental blocker naming the owner, not the generic infra/sandbox wording", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-owner-decision");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "plan-high-review", reviewAttemptId: "attempt-1" }));

    const blockers: ReviewBlocker[] = [
      {
        category: "architectural",
        resolver: "environmental",
        description: "the owner must approve a complete tie policy, including equal final-entry timestamps, that guarantees the promised outcome",
      },
    ];

    try {
      await escalateReviewToHuman(
        folderUri,
        "plan-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content: "Readiness: 7/10\n", blockers, taskFixableCount: 0 }
      );
      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision);
      const clearsThis = decision.evidence?.find((e) => e.label === "What clears this");
      assert.ok(clearsThis);
      // This is an owner-approval blocker, not an infrastructure/sandbox/OS
      // defect — the review flagged the old blanket wording as false here.
      assert.match(clearsThis.detail, /owner decision/);
      assert.match(clearsThis.detail, /stage chat/);
      assert.doesNotMatch(clearsThis.detail, /infrastructure, sandbox, or OS-level fix/);
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("derives an external-status clearing action for a third-party-pending environmental blocker, naming a quoted command", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-external-status");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));

    const blockers: ReviewBlocker[] = [
      {
        category: "review-confidence",
        resolver: "environmental",
        description:
          "Both submitted v3 templates remain PENDING at Meta — poll with `npm run check-competition-template-status`",
      },
    ];

    try {
      await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content: "Readiness: 6/10\n", blockers, taskFixableCount: 0 }
      );
      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision);
      const clearsThis = decision.evidence?.find((e) => e.label === "What clears this");
      assert.ok(clearsThis);
      assert.match(clearsThis.detail, /external system/);
      assert.match(clearsThis.detail, /`npm run check-competition-template-status`/);
      assert.doesNotMatch(clearsThis.detail, /infrastructure, sandbox, or OS-level fix/);
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (Step 27, 2026-08-25): the blocker line itself may not
  // quote a command, but the SAME review round's own markdown can name the
  // clearing command elsewhere (a "How to verify" / evidence section) — this
  // must still be found and named, not just a command quoted inline on the
  // blocker's own one-line description.
  void it("derives an external-status clearing action from a command named elsewhere in the same review, not just inline on the blocker", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-external-status-elsewhere");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));

    const blockers: ReviewBlocker[] = [
      {
        category: "review-confidence",
        resolver: "environmental",
        description: "Both submitted v3 templates remain PENDING at Meta.",
      },
    ];
    const content =
      "Readiness: 6/10\n\n" +
      "## How to verify\n\n" +
      "Poll the submitted v3 templates' current status at Meta with " +
      "`npm run check-competition-template-status`.\n";

    try {
      await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content, blockers, taskFixableCount: 0 }
      );
      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision);
      const clearsThis = decision.evidence?.find((e) => e.label === "What clears this");
      assert.ok(clearsThis);
      assert.match(clearsThis.detail, /external system/);
      assert.match(
        clearsThis.detail,
        /`npm run check-competition-template-status`/,
        "the command must be found even though it is not quoted inline on the blocker's own description"
      );
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, narrowed task-fixable blocker
  // 57e9485f-…-1): the two tests above prove discovery from the blocker line
  // and the SAME review round's markdown; this proves discovery from the
  // approved PLAN (`plan.md`) when neither the blocker nor this round's
  // review content names a command at all — the review's own complaint was
  // that command discovery "still cannot discover a known clearing command
  // from the plan."
  void it("derives an external-status clearing action from a command named only in the approved plan", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folderUri = makeTaskFolderUri("plateau-decision-external-status-plan");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));
    store.set(
      vscode.Uri.joinPath(folderUri, "plan.md").toString(),
      "# Plan\n\n## Verification\n\nPoll the submitted v3 templates' current status at Meta with " +
        "`npm run check-competition-template-status`.\n"
    );

    const blockers: ReviewBlocker[] = [
      {
        category: "review-confidence",
        resolver: "environmental",
        description: "Both submitted v3 templates remain PENDING at Meta.",
      },
    ];
    // This round's own review markdown names no command at all — only the
    // plan does, so this only passes if the plan is actually consulted.
    const content = "Readiness: 6/10\n";

    try {
      await escalateReviewToHuman(
        folderUri,
        "impl-high-review",
        "plateau",
        "stuck",
        "attempt-1",
        undefined,
        false,
        undefined,
        { content, blockers, taskFixableCount: 0 }
      );
      const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = decisionStore
        .listPending()
        .find((d) => d.decisionKey === "reviewPlateauEscalation");
      assert.ok(decision);
      const clearsThis = decision.evidence?.find((e) => e.label === "What clears this");
      assert.ok(clearsThis);
      assert.match(clearsThis.detail, /external system/);
      assert.match(
        clearsThis.detail,
        /`npm run check-competition-template-status`/,
        "the command must be found in the approved plan even though neither the blocker nor this round's review names one"
      );
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });
});
