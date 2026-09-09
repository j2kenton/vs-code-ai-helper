/**
 * Work-admission wiring for `resumeEditPreflightInteractionV1` (v1 fixes
 * item 1, Part 1a completion blocker, 2026-09-09 review): this Resume drive
 * — reached from `extension.ts`'s Chat interaction `resume` dispatcher for
 * every edit-capable action key (implementation.v1, fastForward.v1,
 * applyReviewEdit.v1, lint.v1) — can reach `coordinator.resumeAction` and, for
 * a sealed plan, `continueSealedEditExecutionV1`'s workspace mutation without
 * ever registering work admission or reconciling a watchdog-provenance pause.
 * Mirrors `generatePlanWithAIWorkAdmission.test.ts`'s busy/release coverage:
 * a durable admission marker already held for the task must refuse this
 * Resume with a busy diagnostic naming the real owner BEFORE the (task/
 * model-independent) §7.5 provider gate ever runs, and admission acquired at
 * entry must be released in `finally` on that same early-refusal path.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { resumeEditPreflightInteractionV1 } from "../commands/runEditActionV1";
import { IMPLEMENTATION_ACTION_KEY_V1 } from "../actions/rows/editPreflightRowsV1";
import { TaskInventory } from "../state/taskInventory";
import type { ChatViewProvider, ChatInteractionRefV1 } from "../views/chatView";
import {
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  hasLiveWorkAdmissionBestEffortV1,
} from "../state/workAdmissionV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-resume-edit-preflight-admission-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dummyChatViewProvider = {
  askInteraction: (): Promise<void> => {
    throw new Error("unexpected askInteraction call before admission settled");
  },
} as unknown as ChatViewProvider;

function makeRef(taskBindingId: string): ChatInteractionRefV1 {
  return {
    operationId: "op-under-test",
    interactionId: "interaction-under-test",
    taskBindingId,
    chatDocumentId: "chat-doc-under-test",
    sourceAttemptId: "attempt-under-test",
  };
}

void describe("resumeEditPreflightInteractionV1 work admission (v1 fixes item 1, Part 1a)", () => {
  void it("refuses with the busy diagnostic, naming the other owner, when durable admission is already held for the task — before the §7.5 provider gate ever runs", async () => {
    const taskFolderPath = makeTaskFolder("admission-busy");
    const taskBindingId = "binding-busy";

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    // The early admission peek is itself ONE legitimate synchronous
    // `getTaskByBindingId` lookup (it is how the folder to protect is known
    // at all, with zero I/O) — what must NOT happen is the function
    // proceeding past that early busy refusal into the §7.5 provider gate or
    // a SECOND ("authoritative") lookup inside the try block.
    let callCount = 0;
    const inventory = {
      getTaskByBindingId: (id: string) => {
        callCount += 1;
        if (callCount > 1) {
          throw new Error("unexpected second inventory access — must refuse on the early admission busy outcome first");
        }
        return id === taskBindingId
          ? ({ taskFolderPath } as unknown as ReturnType<TaskInventory["getTaskByBindingId"]>)
          : undefined;
      },
    } as unknown as TaskInventory;

    const cts = new vscode.CancellationTokenSource();
    try {
      const result = await resumeEditPreflightInteractionV1(
        inventory,
        dummyChatViewProvider,
        makeRef(taskBindingId),
        IMPLEMENTATION_ACTION_KEY_V1,
        "resume-idempotency-under-test",
        cts.token
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(
          result.reason,
          /someOtherConcurrentCommand/,
          "must name the actual blocking owner, not a generic 'task is busy' message"
        );
      }
      assert.equal(callCount, 1, "must refuse after exactly the one early admission-peek lookup");
    } finally {
      cts.dispose();
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
    }
  });

  void it("acquires admission for the resolvable taskBindingId before the §7.5 provider gate, and releases it on that gate's refusal", async () => {
    // No live admission held by anyone else here — this exercises the
    // early-acquire-then-release path (the §7.5 gate itself refuses next,
    // since no host/model plumbing is stubbed in this lightweight test), and
    // confirms the acquired marker does not leak past that early return.
    const taskFolderPath = makeTaskFolder("admission-then-gate-refusal");
    const taskBindingId = "binding-then-gate-refusal";

    const inventory = {
      getTaskByBindingId: (id: string) =>
        id === taskBindingId
          ? ({ taskFolderPath } as unknown as ReturnType<TaskInventory["getTaskByBindingId"]>)
          : undefined,
    } as unknown as TaskInventory;

    const cts = new vscode.CancellationTokenSource();
    try {
      const result = await resumeEditPreflightInteractionV1(
        inventory,
        dummyChatViewProvider,
        makeRef(taskBindingId),
        IMPLEMENTATION_ACTION_KEY_V1,
        "resume-idempotency-under-test",
        cts.token
      );

      assert.equal(result.ok, false);
      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at entry must be released in `finally`, even when a later setup gate refuses"
      );
    } finally {
      cts.dispose();
    }
  });

  void it("adopts a caller-presented admission-handoff token instead of racing its own genesis and refusing busy (2026-09-09 review completion blocker fix)", async () => {
    // Simulates chatView.ts's resumeInteraction: it acquires durable
    // admission for this task BEFORE its own first await (before this whole
    // Resume drive begins), then mints a single-use handoff token for
    // whichever handler ultimately resolves to. Presenting that token here
    // must let resumeEditPreflightInteractionV1 adopt the SAME live marker
    // rather than observing it on disk and refusing busy against itself.
    const taskFolderPath = makeTaskFolder("admission-handoff-adopt");
    const taskBindingId = "binding-handoff-adopt";

    const outer = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "chatResumeInteractionV1",
    });
    assert.equal(outer.outcome, "acquired");
    const handoffToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);

    const inventory = {
      getTaskByBindingId: (id: string) =>
        id === taskBindingId
          ? ({ taskFolderPath } as unknown as ReturnType<TaskInventory["getTaskByBindingId"]>)
          : undefined,
    } as unknown as TaskInventory;

    const cts = new vscode.CancellationTokenSource();
    try {
      const result = await resumeEditPreflightInteractionV1(
        inventory,
        dummyChatViewProvider,
        makeRef(taskBindingId),
        IMPLEMENTATION_ACTION_KEY_V1,
        "resume-idempotency-under-test",
        cts.token,
        handoffToken
      );

      // Adoption must succeed: the function proceeds past its own admission
      // step into the §7.5 provider gate, which refuses next since no
      // host/model plumbing is stubbed in this lightweight test — the SAME
      // shape as the no-contention case above, never the busy diagnostic a
      // colliding genesis would produce against the outer-held marker.
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.doesNotMatch(
          result.reason,
          /already has a stage action in progress/i,
          "a presented handoff token must adopt the outer marker, not collide with it"
        );
      }
    } finally {
      cts.dispose();
      if (outer.outcome === "acquired") {
        await outer.handle.release();
      }
    }
  });
});
