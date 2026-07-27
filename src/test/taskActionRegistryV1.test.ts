/**
 * Coverage for the central task-action registry (plan §3.8):
 *  - every row rule fail-closes at construction (key format, route
 *    ownership, eligibility, provider limits, content-type/mode pairing,
 *    permitted-kind rules, follow-up references);
 *  - lookups by action key and by route are fail-closed on unknown ids;
 *  - a route is owned by exactly one row.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTaskActionRegistryV1,
  LifecycleTaskActionRowV1,
  ProviderTaskActionRowV1,
  TaskActionRegistryErrorV1,
} from "../actions/taskActionRegistryV1";
import { MAX_NORMAL_RESPONSE_BYTES_V1 } from "../types/agentExecutionV1";

function providerRow(overrides: Partial<ProviderTaskActionRowV1> = {}): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: "generatePlan.v1",
    routes: ["vs-code-ai-helper.generatePlanWithAI"],
    eligibility: { statuses: ["active"], stages: ["plan"] },
    requiresTaskOperationLease: true,
    progressLabel: "Generating plan…",
    providerMode: "text",
    maxResponseBytes: 1024 * 1024,
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    resumeSemantics: "sameOperation",
    validateInput: (input) => ({ ok: true, input }),
    buildPrompt: () => "prompt",
    promoteCompletedContent: () => Promise.resolve("completed"),
    loggingPolicy: { channel: "action.generatePlan", includeResultMetrics: true },
    ...overrides,
  };
}

function lifecycleRow(overrides: Partial<LifecycleTaskActionRowV1> = {}): LifecycleTaskActionRowV1 {
  return {
    kind: "lifecycle",
    actionKey: "nextStage.v1",
    routes: ["vs-code-ai-helper.nextStage"],
    eligibility: { statuses: ["active"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: "Advancing stage…",
    validateInput: (input) => ({ ok: true, input }),
    execute: () =>
      Promise.resolve({ kind: "failed", code: "notImplemented", retryable: false } as const),
    loggingPolicy: { channel: "action.nextStage", includeResultMetrics: false },
    ...overrides,
  };
}

void describe("taskActionRegistryV1", () => {
  void it("resolves rows by action key and by route", () => {
    const registry = createTaskActionRegistryV1([providerRow(), lifecycleRow()]);
    assert.equal(registry.rowForActionKey("generatePlan.v1").actionKey, "generatePlan.v1");
    assert.equal(
      registry.rowForRoute("vs-code-ai-helper.nextStage").actionKey,
      "nextStage.v1"
    );
    assert.equal(registry.hasActionKey("generatePlan.v1"), true);
    assert.equal(registry.hasActionKey("draft.v1"), false);
    assert.deepEqual([...registry.actionKeys()].sort(), ["generatePlan.v1", "nextStage.v1"]);
  });

  void it("fail-closes lookups for unknown keys and unowned routes", () => {
    const registry = createTaskActionRegistryV1([providerRow()]);
    assert.throws(() => registry.rowForActionKey("draft.v1"), TaskActionRegistryErrorV1);
    assert.throws(() => registry.rowForRoute("vs-code-ai-helper.unknown"), TaskActionRegistryErrorV1);
  });

  void it("rejects malformed action keys and duplicate keys", () => {
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ actionKey: "GeneratePlan.v1" })]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ actionKey: "generatePlan" })]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow(),
          providerRow({ routes: ["vs-code-ai-helper.other"] }),
        ]),
      TaskActionRegistryErrorV1
    );
  });

  void it("rejects rows without routes, statuses, or a progress label, and duplicate routes", () => {
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ routes: [] })]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({ eligibility: { statuses: [], stages: "anyStage" } }),
        ]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({ eligibility: { statuses: ["active"], stages: [] } }),
        ]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ progressLabel: "" })]),
      TaskActionRegistryErrorV1
    );
    // The same route owned by two rows is a construction failure.
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow(),
          lifecycleRow({ routes: ["vs-code-ai-helper.generatePlanWithAI"] }),
        ]),
      TaskActionRegistryErrorV1
    );
  });

  void it("bounds provider response limits to the mode ceiling", () => {
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({ maxResponseBytes: MAX_NORMAL_RESPONSE_BYTES_V1 + 1 }),
        ]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ maxResponseBytes: 0 })]),
      TaskActionRegistryErrorV1
    );
  });

  void it("requires provider rows to permit \"completed\" with a unique kind list", () => {
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ permittedResultKinds: [] })]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({ permittedResultKinds: ["questions", "failed"] }),
        ]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({ permittedResultKinds: ["completed", "completed"] }),
        ]),
      TaskActionRegistryErrorV1
    );
  });

  void it("enforces content-type/mode pairing and the no-questions-during-edit rule", () => {
    // A text content type requires text mode.
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ providerMode: "preflight" })]),
      TaskActionRegistryErrorV1
    );
    // preflight-plan.v1 requires preflight mode.
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({ completedContentType: "preflight-plan.v1" }),
        ]),
      TaskActionRegistryErrorV1
    );
    // Edit execution must not permit questions (plan §7.6).
    assert.throws(
      () =>
        createTaskActionRegistryV1([
          providerRow({
            providerMode: "edit",
            completedContentType: "edit-execution.v1",
            permittedResultKinds: ["completed", "questions"],
          }),
        ]),
      TaskActionRegistryErrorV1
    );
    // The valid edit pairing constructs.
    const registry = createTaskActionRegistryV1([
      providerRow({
        providerMode: "edit",
        completedContentType: "edit-execution.v1",
        permittedResultKinds: ["completed", "cancelled", "failed"],
      }),
    ]);
    assert.equal(registry.rowForActionKey("generatePlan.v1").kind, "provider");
  });

  void it("validates follow-up references after the whole row set registers", () => {
    assert.throws(
      () => createTaskActionRegistryV1([providerRow({ followUpActionKey: "review.v1" })]),
      TaskActionRegistryErrorV1
    );
    assert.throws(
      () =>
        createTaskActionRegistryV1([providerRow({ followUpActionKey: "generatePlan.v1" })]),
      TaskActionRegistryErrorV1
    );
    // Order-independence: the follow-up may be declared before its target row.
    const registry = createTaskActionRegistryV1([
      providerRow({ followUpActionKey: "nextStage.v1" }),
      lifecycleRow(),
    ]);
    assert.equal(
      registry.rowForActionKey("generatePlan.v1").followUpActionKey,
      "nextStage.v1"
    );
  });
});
