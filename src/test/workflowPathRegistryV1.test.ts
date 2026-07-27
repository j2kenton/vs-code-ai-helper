/**
 * Coverage for the §2.1 workflow path registry (Privacy cohort):
 *  1. root registration enforces the §1.8 root shape rules, unique ids, and
 *     declared root kinds;
 *  2. every allocation family vends the exact plan §2.1 locator, validated
 *     against the shared relative-path rules and cross-checked against the
 *     §2.2 privacy classifier's classification;
 *  3. malformed identities and wrong-kind roots are refused — there is no
 *     API surface that accepts a caller-supplied relative path;
 *  4. vended locators are directly consumable by workflowFileStoreV1.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  createWorkflowPathRegistryV1,
  WorkflowPathRegistryErrorV1,
} from "../services/workflowPathRegistryV1";
import { createWorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import { validateWorkflowRelativePathV1 } from "../services/workflowPathSafetyV1";
import { CHAT_HISTORY_FILENAME } from "../utils/chatHistoryConstants";

const HEX_A = "a".repeat(32);
const HEX_B = "b".repeat(32);
const HEX_C = "c".repeat(32);

function makeRegistry(): ReturnType<typeof createWorkflowPathRegistryV1> {
  const registry = createWorkflowPathRegistryV1();
  registry.registerRoot({
    rootId: "task",
    fsPath: path.resolve("fixture-task-folder"),
    kind: "taskFolder",
    trustedForMutation: true,
  });
  registry.registerRoot({
    rootId: "storage",
    fsPath: path.resolve("fixture-private-storage"),
    kind: "privateStorage",
    trustedForMutation: true,
  });
  registry.registerRoot({
    rootId: "meta",
    fsPath: path.resolve("fixture-meta-root"),
    kind: "metaRoot",
    trustedForMutation: true,
  });
  return registry;
}

void describe("workflowPathRegistryV1", () => {
  void it("registers roots with kinds and rejects duplicates and unsupported shapes", () => {
    const registry = makeRegistry();
    assert.equal(registry.rootKind("task"), "taskFolder");
    assert.equal(registry.rootKind("storage"), "privateStorage");
    assert.equal(registry.rootKind("meta"), "metaRoot");
    assert.equal(registry.rootKind("unknown"), undefined);
    assert.equal(registry.registeredRoots().length, 3);

    assert.throws(
      () =>
        registry.registerRoot({
          rootId: "task",
          fsPath: path.resolve("elsewhere"),
          kind: "taskFolder",
          trustedForMutation: true,
        }),
      WorkflowPathRegistryErrorV1
    );
    assert.throws(
      () =>
        registry.registerRoot({
          rootId: "relative",
          fsPath: "not/absolute",
          kind: "taskFolder",
          trustedForMutation: true,
        }),
      WorkflowPathRegistryErrorV1
    );
    assert.throws(
      () =>
        registry.registerRoot({
          rootId: "unc",
          fsPath: "//host/share/root",
          kind: "privateStorage",
          trustedForMutation: true,
        }),
      WorkflowPathRegistryErrorV1
    );
  });

  void it("vends the exact plan §2.1 locators with their §2.2 classifications", () => {
    const registry = makeRegistry();

    const chat = registry.taskChatFile("task");
    assert.deepEqual(chat, {
      locator: { rootId: "task", relativePath: CHAT_HISTORY_FILENAME },
      classification: "chatPrivate",
    });

    const sentinel = registry.creationSentinelFile("task");
    assert.deepEqual(sentinel, {
      locator: { rootId: "task", relativePath: ".ensemble-creation-sentinel-v1.json" },
      classification: "workflowControl",
    });

    const runtimeRoot = registry.workflowRuntimeDir("storage");
    assert.deepEqual(runtimeRoot, {
      locator: { rootId: "storage", relativePath: "workflow-runtime-v1" },
      classification: "workflowControl",
    });

    const transactionFamily = registry.chatTransactionsFamilyDir("storage");
    assert.deepEqual(transactionFamily, {
      locator: { rootId: "storage", relativePath: "workflow-runtime-v1/chat-transactions" },
      classification: "chatPrivate",
    });

    const transaction = registry.chatTransactionDir("storage", HEX_A);
    assert.deepEqual(transaction, {
      locator: { rootId: "storage", relativePath: `workflow-runtime-v1/chat-transactions/${HEX_A}` },
      classification: "chatPrivate",
    });

    const transactionFile = registry.chatTransactionFile("storage", HEX_A);
    assert.deepEqual(transactionFile, {
      locator: {
        rootId: "storage",
        relativePath: `workflow-runtime-v1/chat-transactions/${HEX_A}/transaction-v1.json`,
      },
      classification: "chatPrivate",
    });

    const invocationClaimFile = registry.chatTransactionResumeInvocationClaimFile("storage", HEX_A);
    assert.deepEqual(invocationClaimFile, {
      locator: {
        rootId: "storage",
        relativePath: `workflow-runtime-v1/chat-transactions/${HEX_A}/resume-invocation-claim-v1.json`,
      },
      classification: "chatPrivate",
    });

    const recovery = registry.chatRecoveryDir("storage", HEX_A, HEX_B);
    assert.deepEqual(recovery, {
      locator: { rootId: "storage", relativePath: `workflow-runtime-v1/chat-recovery/${HEX_A}/${HEX_B}` },
      classification: "chatPrivate",
    });

    const spool = registry.providerResultSpoolDir("storage", HEX_A, HEX_B, HEX_C);
    assert.deepEqual(spool, {
      locator: {
        rootId: "storage",
        relativePath: `workflow-runtime-v1/provider-results/${HEX_A}/${HEX_B}/${HEX_C}`,
      },
      classification: "transientProviderData",
    });

    const editRun = registry.editRunDir("storage", HEX_A);
    assert.deepEqual(editRun, {
      locator: { rootId: "storage", relativePath: `workflow-runtime-v1/edit-runs/${HEX_A}` },
      classification: "workflowControl",
    });

    const leases = registry.leasesDir("storage");
    assert.deepEqual(leases, {
      locator: { rootId: "storage", relativePath: "workflow-runtime-v1/leases" },
      classification: "workflowControl",
    });

    const intents = registry.creationIntentsDir("meta");
    assert.deepEqual(intents, {
      locator: { rootId: "meta", relativePath: "creation-intents-v1" },
      classification: "workflowControl",
    });

    // Every vended locator passes the shared §1.8 relative-path rules.
    for (const allocated of [
      chat,
      sentinel,
      runtimeRoot,
      transactionFamily,
      transaction,
      transactionFile,
      invocationClaimFile,
      recovery,
      spool,
      editRun,
      leases,
      intents,
    ]) {
      assert.equal(validateWorkflowRelativePathV1(allocated.locator.relativePath).ok, true);
    }
  });

  void it("refuses unknown roots, wrong-kind roots, and malformed identities", () => {
    const registry = makeRegistry();

    assert.throws(() => registry.taskChatFile("unknown"), WorkflowPathRegistryErrorV1);
    // Wrong kind: chat files live only in task folders, spools only in
    // private storage, creation intents only under the meta root.
    assert.throws(() => registry.taskChatFile("storage"), WorkflowPathRegistryErrorV1);
    assert.throws(() => registry.creationSentinelFile("meta"), WorkflowPathRegistryErrorV1);
    assert.throws(
      () => registry.providerResultSpoolDir("task", HEX_A, HEX_B, HEX_C),
      WorkflowPathRegistryErrorV1
    );
    assert.throws(() => registry.leasesDir("meta"), WorkflowPathRegistryErrorV1);
    assert.throws(() => registry.creationIntentsDir("storage"), WorkflowPathRegistryErrorV1);

    assert.throws(() => registry.workflowRuntimeDir("task"), WorkflowPathRegistryErrorV1);
    assert.throws(() => registry.chatTransactionsFamilyDir("meta"), WorkflowPathRegistryErrorV1);
    assert.throws(() => registry.chatTransactionFile("task", HEX_A), WorkflowPathRegistryErrorV1);
    assert.throws(
      () => registry.chatTransactionResumeInvocationClaimFile("task", HEX_A),
      WorkflowPathRegistryErrorV1
    );

    // Malformed identities: wrong length, uppercase, traversal, empty.
    assert.throws(() => registry.chatTransactionDir("storage", "abc"), WorkflowPathRegistryErrorV1);
    assert.throws(() => registry.chatTransactionFile("storage", "abc"), WorkflowPathRegistryErrorV1);
    assert.throws(
      () => registry.chatTransactionResumeInvocationClaimFile("storage", "abc"),
      WorkflowPathRegistryErrorV1
    );
    assert.throws(
      () => registry.chatTransactionDir("storage", HEX_A.toUpperCase()),
      WorkflowPathRegistryErrorV1
    );
    assert.throws(() => registry.chatTransactionDir("storage", "../escape"), WorkflowPathRegistryErrorV1);
    assert.throws(() => registry.chatRecoveryDir("storage", HEX_A, ""), WorkflowPathRegistryErrorV1);
    assert.throws(
      () => registry.providerResultSpoolDir("storage", HEX_A, HEX_B, "not-hex"),
      WorkflowPathRegistryErrorV1
    );
    assert.throws(() => registry.editRunDir("storage", `${HEX_A}0`), WorkflowPathRegistryErrorV1);
  });

  void it("vends locators directly consumable by workflowFileStoreV1", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-"));
    try {
      const registry = createWorkflowPathRegistryV1();
      registry.registerRoot({
        rootId: "storage",
        fsPath: tempRoot,
        kind: "privateStorage",
        trustedForMutation: true,
      });
      const store = createWorkflowFileStoreV1(registry.registeredRoots());
      const leases = registry.leasesDir("storage");

      // Nonrecursive mkdir: the runtime root does not exist yet, so the
      // leases directory cannot be created implicitly (plan §1.8).
      const missingParent = await store.createDirectory(leases.locator);
      assert.deepEqual(missingParent, { kind: "failed", code: "parentMissing" });

      fs.mkdirSync(path.join(tempRoot, "workflow-runtime-v1"));
      const created = await store.createDirectory(leases.locator);
      assert.deepEqual(created, { kind: "ok", value: undefined });
      assert.equal(fs.statSync(path.join(tempRoot, "workflow-runtime-v1", "leases")).isDirectory(), true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
