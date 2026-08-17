/**
 * Coverage for workflowRuntimeServicesV1.ts's two-tier root registration
 * contract (plan §2.1/§3.9 — the implementation review's mutation-authority
 * blocker):
 *
 *  - `ensureWorkflowTaskFolderRootV1` grants task-folder mutation authority
 *    ONLY from validated persisted ownership + taskFolder: missing progress,
 *    ownership-free progress, an underivable binding, a dead workspace
 *    owner, an uncontained location (workspace open or not), and a
 *    mismatched caller-supplied binding all REFUSE.
 *  - `ensureWorkflowNonTaskStorageRootV1` is the separate, dedicated path
 *    for non-task storage (the Global Assistant's own folder):
 *    shape+containment trust with no ownership requirement — and a folder
 *    carrying task progress can never register through it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  configureWorkflowPrivateStorageRootV1,
  ensureWorkflowNonTaskStorageRootV1,
  ensureWorkflowTaskFolderRootV1,
  getProviderResultSpoolStoreV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  isWorkflowTaskFolderRootVerifiedV1,
  resetWorkflowRuntimeServicesForTestV1,
  resolveWorkflowAllocatedFsPathV1,
} from "../services/workflowRuntimeServicesV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { computeTaskBindingIdV1 } from "../types/taskBindingV1";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { fixtureOwnershipFor, makeOwnedTaskFolder } from "./taskFolderFixture";

function makeTaskFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-"));
}

/** Ownership-backed progress by default; override `ownership` for other shapes. */
function writeProgress(folder: string, overrides: Record<string, unknown> = {}): void {
  const progress = {
    taskFolder: path.basename(folder),
    currentStage: "impl",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    ownership: fixtureOwnershipFor(folder),
    ...overrides,
  };
  fs.writeFileSync(path.join(folder, TASK_PROGRESS_FILENAME), JSON.stringify(progress, null, 2));
}

/** Progress shaped exactly like a pre-ownership historical task's: decodable, but no `ownership`. */
function writeProgressWithoutOwnership(folder: string, overrides: Record<string, unknown> = {}): void {
  const progress = {
    taskFolder: path.basename(folder),
    currentStage: "impl",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    ...overrides,
  };
  fs.writeFileSync(path.join(folder, TASK_PROGRESS_FILENAME), JSON.stringify(progress, null, 2));
}

function installWorkspaceFoldersStub(roots: readonly string[]): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = roots.map((root, index) => ({
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index,
  }));
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig;
    },
  };
}

void describe("workflowRuntimeServicesV1 — task-folder root trust", () => {
  void it("refuses registration when no task-progress.json exists — missing progress is not a task folder", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /has no task-progress\.json/);
      // A refused folder registers no root at all.
      assert.equal(getWorkflowPathRegistryV1().registeredRoots().length, 0);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses registration when task-progress.json exists but is not a regular file (e.g. a directory), rather than treating it as absent", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      // A directory sitting where task-progress.json should be a regular
      // file is a read failure (EISDIR), not genuine absence — it must not
      // silently fall back to any weaker trust tier.
      fs.mkdirSync(path.join(folder, TASK_PROGRESS_FILENAME));
      assert.throws(
        () => ensureWorkflowTaskFolderRootV1(folder),
        /could not be read as a regular file/
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("clears a previously-verified root's state when a later call hits an unreadable (non-ENOENT) task-progress.json", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      writeProgress(folder, {});
      const rootId = ensureWorkflowTaskFolderRootV1(folder);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), true);
      fs.rmSync(path.join(folder, TASK_PROGRESS_FILENAME), { force: true });
      fs.mkdirSync(path.join(folder, TASK_PROGRESS_FILENAME));
      assert.throws(
        () => ensureWorkflowTaskFolderRootV1(folder),
        /could not be read as a regular file/
      );
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), false);
      assert.equal(getVerifiedTaskBindingIdV1(rootId), undefined);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("closes the stale-locator window: the shared file store refuses mutation through an already-registered root once re-verification fails", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      writeProgress(folder, {});
      const rootId = ensureWorkflowTaskFolderRootV1(folder);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), true);

      // A consumer captures a locator into this already-registered root
      // while it is still trusted, and can mutate through it.
      const locator = { rootId, relativePath: "chat-v1.json" };
      const fileStore = getWorkflowFileStoreV1();
      const created = await fileStore.createFileExclusive(locator, Buffer.from("{}"));
      assert.equal(created.kind, "ok");
      const createdRevision = (created as { kind: "ok"; value: { revision: string } }).value.revision;

      // The folder's progress now breaks re-verification (unreadable, not
      // merely absent) — `registerRoot` itself is one-time and would NOT by
      // itself withdraw trust from the already-registered root object.
      fs.rmSync(path.join(folder, TASK_PROGRESS_FILENAME), { force: true });
      fs.mkdirSync(path.join(folder, TASK_PROGRESS_FILENAME));
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /could not be read as a regular file/);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), false);

      // The SAME store instance and locator (the "stale captured locator" a
      // consumer might still be holding) must now refuse mutation, even
      // though the root itself was never re-registered.
      const rejected = await fileStore.replaceFileExact(locator, Buffer.from("{}"), createdRevision);
      assert.equal(rejected.kind, "unavailable");
      assert.equal((rejected as { code: string }).code, "workspaceRootUnsupported");

      // Reads through the same locator are unaffected — only mutation trust
      // was withdrawn.
      const read = await fileStore.readFileBounded(locator, 1024);
      assert.equal(read.kind, "ok");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses registration when progress carries no ownership binding — ownership-free progress gets no mutation trust", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      writeProgressWithoutOwnership(folder);
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /carries no ownership binding/);
      assert.equal(getWorkflowPathRegistryV1().registeredRoots().length, 0);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("accepts an ownership-backed folder with NO workspace open, containing against its own ownership.metaRoot", () => {
    resetWorkflowRuntimeServicesForTestV1();
    // The owned fixture's metaRoot is the folder's own parent, so the strict
    // containment check passes with no workspace open and no workspaceRoot
    // persisted — proving no-workspace operation is not a blanket refusal.
    const fixture = makeOwnedTaskFolder("ensemble-workflow-runtime-");
    try {
      const rootId = ensureWorkflowTaskFolderRootV1(fixture.folder);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), true);
      assert.equal(getVerifiedTaskBindingIdV1(rootId), fixture.bindingId);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("refuses an ownership-backed folder outside its ownership.metaRoot when NO workspace is open — containment is not skipped", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      // Ownership is otherwise valid, but its metaRoot points somewhere the
      // folder does not sit beneath; with no workspace open there is no
      // task-root candidate or workspace folder to contain it either.
      writeProgress(folder, {
        ownership: {
          metaRoot: path.join(os.tmpdir(), "ensemble-not-the-parent", ".ensemble"),
          projectRoot: path.join(os.tmpdir(), "ensemble-not-the-parent"),
          boundAt: "2026-07-01T09:00:00.000Z",
          state: "resolved",
        },
      });
      assert.throws(
        () => ensureWorkflowTaskFolderRootV1(folder),
        /not contained within its persisted ownership\.metaRoot, a configured task root, or any currently open workspace folder/
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses ownership-backed registration when a workspace is open but the folder is not contained anywhere recognized", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-ws-"));
    // Deliberately a SIBLING of workspaceRoot, not nested under it, under any
    // configured task-root candidate, or under any ownership.metaRoot.
    const uncontainedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-uncontained-"));
    writeProgress(uncontainedFolder, {
      ownership: {
        metaRoot: path.join(os.tmpdir(), "ensemble-not-the-parent", ".ensemble"),
        projectRoot: path.join(os.tmpdir(), "ensemble-not-the-parent"),
        boundAt: "2026-07-01T09:00:00.000Z",
        state: "resolved",
      },
    });
    const stub = installWorkspaceFoldersStub([workspaceRoot]);
    try {
      assert.throws(
        () => ensureWorkflowTaskFolderRootV1(uncontainedFolder),
        /not contained within its persisted ownership\.metaRoot, a configured task root, or any currently open workspace folder/
      );
    } finally {
      stub.restore();
      fs.rmSync(uncontainedFolder, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("refuses ownership-free registration even when the folder sits under an open workspace folder", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-ws-"));
    const nestedFolder = fs.mkdtempSync(path.join(workspaceRoot, "ensemble-workflow-runtime-"));
    writeProgressWithoutOwnership(nestedFolder);
    const stub = installWorkspaceFoldersStub([workspaceRoot]);
    try {
      // Containment alone never earns task-folder mutation trust: ownership
      // is REQUIRED regardless of physical location.
      assert.throws(() => ensureWorkflowTaskFolderRootV1(nestedFolder), /carries no ownership binding/);
    } finally {
      stub.restore();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("refuses registration when taskFolder does not self-name the folder (unchanged prior behavior)", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      writeProgress(folder, { taskFolder: "some-other-task-folder" });
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /does not decode as valid task progress/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("derives and exposes an ownership-backed binding id when ownership.workspaceRoot matches an open workspace folder", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-ws-"));
    // Nested under the open workspace root so the new containment check
    // (mirroring resolveTaskContext.ts's policy) passes — a real task folder
    // always sits beneath its owning workspace.
    const folder = fs.mkdtempSync(path.join(workspaceRoot, "ensemble-workflow-runtime-"));
    const stub = installWorkspaceFoldersStub([workspaceRoot]);
    try {
      const ownership = {
        metaRoot: path.join(workspaceRoot, ".ensemble"),
        projectRoot: workspaceRoot,
        workspaceRoot,
        boundAt: "2026-07-01T09:00:00.000Z",
        state: "resolved" as const,
      };
      writeProgress(folder, { ownership });
      const rootId = ensureWorkflowTaskFolderRootV1(folder);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), true);
      const bindingId = getVerifiedTaskBindingIdV1(rootId);
      assert.equal(bindingId, computeTaskBindingIdV1(ownership, path.basename(folder)));
    } finally {
      stub.restore();
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("refuses registration when ownership.workspaceRoot matches no currently open workspace folder", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    const otherOpenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-ws-"));
    const stub = installWorkspaceFoldersStub([otherOpenRoot]);
    try {
      writeProgress(folder, {
        ownership: {
          metaRoot: path.join(os.tmpdir(), "not-open", ".ensemble"),
          projectRoot: path.join(os.tmpdir(), "not-open"),
          workspaceRoot: path.join(os.tmpdir(), "not-open"),
          boundAt: "2026-07-01T09:00:00.000Z",
          state: "resolved",
        },
      });
      assert.throws(
        () => ensureWorkflowTaskFolderRootV1(folder),
        /does not match any currently open workspace folder/
      );
    } finally {
      stub.restore();
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(otherOpenRoot, { recursive: true, force: true });
    }
  });

  void it("refuses registration when ownership is recorded as unresolved (no stable binding exists)", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      writeProgress(folder, {
        ownership: {
          metaRoot: path.join(folder, ".."),
          projectRoot: path.join(folder, ".."),
          boundAt: "2026-07-01T09:00:00.000Z",
          state: "ownership-unresolved",
        },
      });
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /ownership binding could not be validated/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("registration is idempotent, but the progress check re-runs on every call", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      writeProgress(folder, {});
      const first = ensureWorkflowTaskFolderRootV1(folder);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(first), true);
      // Corrupting the file after registration must be caught on the very
      // next call, not silently trusted forever (the registry root id itself
      // stays stable — registerRoot is genuinely one-time — but the
      // verification it layers on top is not cached).
      fs.writeFileSync(path.join(folder, TASK_PROGRESS_FILENAME), "not valid json");
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /does not decode as valid task progress/);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(first), false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("accepts a caller-supplied binding that exactly matches the folder's freshly derived ownership binding", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const fixture = makeOwnedTaskFolder("ensemble-workflow-runtime-");
    try {
      const rootId = ensureWorkflowTaskFolderRootV1(fixture.folder, { bindingId: fixture.bindingId });
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), true);
      assert.equal(getVerifiedTaskBindingIdV1(rootId), fixture.bindingId);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("refuses a caller-supplied binding that does not match the folder (binding-to-folder mismatch), clearing prior state", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const fixture = makeOwnedTaskFolder("ensemble-workflow-runtime-");
    try {
      // First, register without an expectation so verified state exists.
      const rootId = ensureWorkflowTaskFolderRootV1(fixture.folder);
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), true);
      // A stale, foreign, or rebound claim must fail closed — and the
      // previously recorded verified/binding state must not survive it.
      assert.throws(
        () => ensureWorkflowTaskFolderRootV1(fixture.folder, { bindingId: "0".repeat(64) }),
        /does not match the caller-supplied task binding/
      );
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), false);
      assert.equal(getVerifiedTaskBindingIdV1(rootId), undefined);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });
});

void describe("workflowRuntimeServicesV1 — dedicated non-task storage roots", () => {
  void it("registers progress-free non-task storage, allocates its chat file, and reports no task verification", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      const rootId = ensureWorkflowNonTaskStorageRootV1(folder);
      assert.equal(getWorkflowPathRegistryV1().rootKind(rootId), "nonTaskStorage");
      // chat-v1.json allocation is legitimate for a non-task storage root…
      assert.doesNotThrow(() => getWorkflowPathRegistryV1().taskChatFile(rootId));
      // …but it never claims task verification or an ownership binding.
      assert.equal(isWorkflowTaskFolderRootVerifiedV1(rootId), false);
      assert.equal(getVerifiedTaskBindingIdV1(rootId), undefined);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses non-task registration for a folder carrying task progress — a task must use the strict path", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const fixture = makeOwnedTaskFolder("ensemble-workflow-runtime-");
    try {
      assert.throws(
        () => ensureWorkflowNonTaskStorageRootV1(fixture.folder),
        /carries task-progress\.json, which makes it a task folder/
      );
      assert.equal(getWorkflowPathRegistryV1().registeredRoots().length, 0);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("refuses non-task registration when the path is already registered as a task folder", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const fixture = makeOwnedTaskFolder("ensemble-workflow-runtime-");
    try {
      ensureWorkflowTaskFolderRootV1(fixture.folder);
      assert.throws(
        () => ensureWorkflowNonTaskStorageRootV1(fixture.folder),
        /already registered as a taskFolder root/
      );
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("refuses task registration when the path is already registered as non-task storage", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      ensureWorkflowNonTaskStorageRootV1(folder);
      // Even if task progress later appears in the folder, the kind guard
      // fires first — one path, one root kind, never two authorities.
      writeProgress(folder, {});
      assert.throws(() => ensureWorkflowTaskFolderRootV1(folder), /already registered as a nonTaskStorage root/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses task-only family allocation (creation sentinel) under a non-task root", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      const rootId = ensureWorkflowNonTaskStorageRootV1(folder);
      assert.throws(() => getWorkflowPathRegistryV1().creationSentinelFile(rootId), /taskFolder/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("revalidates progress-absence on every call: a folder that gains task progress is refused thereafter", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const folder = makeTaskFolder();
    try {
      ensureWorkflowNonTaskStorageRootV1(folder);
      writeProgress(folder, {});
      assert.throws(() => ensureWorkflowNonTaskStorageRootV1(folder), /carries task-progress\.json/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("workflowRuntimeServicesV1 — resolveWorkflowAllocatedFsPathV1", () => {
  void it("resolves a registry-vended locator to the absolute path under its registered root", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-workflow-runtime-ws-"));
    const folder = fs.mkdtempSync(path.join(workspaceRoot, "ensemble-workflow-runtime-"));
    const stub = installWorkspaceFoldersStub([workspaceRoot]);
    try {
      const ownership = {
        metaRoot: path.join(workspaceRoot, ".ensemble"),
        projectRoot: workspaceRoot,
        workspaceRoot,
        boundAt: "2026-07-01T09:00:00.000Z",
        state: "resolved" as const,
      };
      writeProgress(folder, { ownership });
      const rootId = ensureWorkflowTaskFolderRootV1(folder);
      const allocated = getWorkflowPathRegistryV1().taskChatFile(rootId);
      const resolved = resolveWorkflowAllocatedFsPathV1(allocated);
      assert.equal(resolved, path.join(path.resolve(folder), "chat-v1.json"));
    } finally {
      stub.restore();
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("throws for a locator naming an unregistered root — never silently invents a base path", () => {
    resetWorkflowRuntimeServicesForTestV1();
    assert.throws(
      () =>
        resolveWorkflowAllocatedFsPathV1({
          locator: { rootId: "not-a-registered-root", relativePath: "chat-v1.json" },
          classification: "chatPrivate",
        }),
      /not registered/
    );
  });
});

/**
 * REGRESSION GUARD for the 2026-08-06 stability fix — not incident evidence.
 *
 * The 2026-08-06 bug: the production coordinator never actually configured a
 * spool store, so a `malformedResult` settlement's recovery write
 * (taskActionCoordinatorV1.ts's preserveRejectedResultForRecoveryV1) was
 * silently a no-op regardless of the code that called it. This suite proves
 * the accessor resolves to a real, usable store under the registry's own
 * `provider-results` family directory once the private-storage root is
 * configured, stays undefined (rather than throwing) before that — every
 * consumer already treats a missing store as optional/best-effort — and that
 * the production coordinator wiring still passes it through `brokerOptions`.
 *
 * Scope limit, stated deliberately: these tests passed BEFORE the 2026-08-15
 * Copilot desc incident and would have kept passing throughout it. That
 * incident's missing spool was a settlement-time gap — `settleEnvelope`'s two
 * `contentSchemaMismatch` returns preserved nothing even with a correctly
 * wired store — so a green run here only guards the 2026-08-06 wiring fix
 * against regression. The evidence that the 2026-08-15 incident class is
 * fixed is taskActionCoordinatorV1.test.ts's settlement-origin preservation
 * tests ("preserves the rejected response when settlement rejects...").
 */
void describe("workflowRuntimeServicesV1 — getProviderResultSpoolStoreV1", () => {
  void it("is undefined before the private-storage root is configured", () => {
    resetWorkflowRuntimeServicesForTestV1();
    assert.equal(getProviderResultSpoolStoreV1(), undefined);
  });

  void it("resolves to a real store under workflow-runtime-v1/provider-results once configured", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-provider-spool-"));
    try {
      configureWorkflowPrivateStorageRootV1(privateRoot);
      const store = getProviderResultSpoolStoreV1();
      assert.ok(store, "expected a configured spool store");
      const correlation = {
        actionKey: "review.v1",
        operationId: allocateHex128IdV1(),
        attemptId: allocateHex128IdV1(),
        taskBindingId: "tb",
        chatDocumentId: "cd",
      };
      const reservationId = allocateHex128IdV1();
      const ref = await store.writeSpool(correlation, reservationId, Buffer.from("hello", "utf8"));
      const expectedPath = path.join(
        privateRoot,
        "workflow-runtime-v1",
        "provider-results",
        correlation.operationId,
        correlation.attemptId,
        reservationId,
        "result-v1.bin"
      );
      assert.equal(fs.readFileSync(expectedPath, "utf8"), "hello");
      assert.equal(ref.operationId, correlation.operationId);
    } finally {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });

  void it("returns the SAME store instance across calls (singleton, not re-created per access)", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-provider-spool-singleton-"));
    try {
      configureWorkflowPrivateStorageRootV1(privateRoot);
      assert.equal(getProviderResultSpoolStoreV1(), getProviderResultSpoolStoreV1());
    } finally {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });

  void it("is passed to the production coordinator's brokerOptions (the 2026-08-06 wiring)", () => {
    // Structural pin on the one line the 2026-08-06 fix added: an accessor
    // that resolves correctly but is never handed to the coordinator would
    // reintroduce the silent no-op this suite exists to prevent.
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "actions", "productionTaskActionRuntimeV1.ts"),
      "utf8"
    );
    assert.match(
      source,
      /brokerOptions:\s*\{\s*spoolStore:\s*getProviderResultSpoolStoreV1\(\)\s*\}/,
      "productionTaskActionRuntimeV1 must wire the provider-result spool store into brokerOptions"
    );
  });
});
