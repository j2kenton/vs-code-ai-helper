/**
 * Sandbox lifecycle composition (plan Part 5): server-side binding
 * reachability, teardown routed through the attempt protocol (a duplicate
 * destroy is structurally impossible, and a user-managed workspace is never
 * destroyed), and the SPLIT-LINEAGE source acquisition — clone and checkout
 * as separate attempt lineages so a crash landing between the two recovers
 * onto the PINNED ref instead of silently adopting the default branch (the
 * previous review's suggestion 7 scenario).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecordingEventSinkV1 } from "../../ensemble-engine/src/engineEventsV1";
import { createEngineGateMachineryV1 } from "../../ensemble-engine/src/gateMachineryV1";
import {
  createInMemorySandboxClientV1,
  InMemorySandboxClientOptionsV1,
  SandboxCommandRequestV1,
} from "../../ensemble-engine/src/sandboxClientV1";
import {
  createGitCheckoutEffectV1,
  SandboxExecutionContextV1,
} from "../../ensemble-engine/src/sandboxExecutionV1";
import {
  acquireTaskSourceV1,
  SANDBOX_TEARDOWN_STEP_ID_V1,
  teardownTaskSandboxV1,
  validateBindingReachabilityV1,
} from "../src/sandboxLifecycleV1";
import { createControlPlaneStoreV1 } from "../src/storeV1";
import { makeBinding } from "./helpersV1";

const PINNED_SHA = "a".repeat(40);

function makeMachinery(store = createControlPlaneStoreV1()) {
  return createEngineGateMachineryV1({
    taskId: "task-1",
    ownerId: "owner-a",
    workerId: "w1",
    sink: createRecordingEventSinkV1(),
    gateStore: store.gates,
    attemptStore: store.attempts,
    leaseStore: store.leases,
  });
}

/** Simulates git inside the fake sandbox: clone materializes .git; checkout writes HEAD. */
function gitSimulation(options?: {
  readonly failCheckout?: () => boolean;
}): InMemorySandboxClientOptionsV1["onCommand"] {
  return (request: SandboxCommandRequestV1, client) => {
    if (request.argv[0] === "git" && request.argv[1] === "clone") {
      const root = request.argv[request.argv.length - 1] as string;
      client.addDirectory(request.sandboxId, `${root}/.git`);
      client.addFile(request.sandboxId, `${root}/.git/HEAD`, "ref: refs/heads/main\n");
      return { exitCode: 0, stdoutTail: "", stderrTail: "" };
    }
    if (request.argv[0] === "git" && request.argv.includes("checkout")) {
      if (options?.failCheckout?.() === true) {
        throw new Error("crash between clone and checkout");
      }
      const root = request.argv[2] as string;
      const ref = request.argv[request.argv.length - 1] as string;
      client.addFile(request.sandboxId, `${root}/.git/HEAD`, `${ref}\n`);
      return { exitCode: 0, stdoutTail: "", stderrTail: "" };
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  };
}

test("binding reachability is fail-closed", async () => {
  const client = createInMemorySandboxClientV1();
  const binding = makeBinding("owner-a");
  assert.deepEqual(await validateBindingReachabilityV1(client, binding), { ok: true });

  const down = {
    ...client,
    resolveRealPath: (): Promise<string | undefined> => Promise.reject(new Error("down")),
  };
  const unreachable = await validateBindingReachabilityV1(down, binding);
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.ok ? "" : unreachable.code, "sandboxUnreachable");
});

test("teardown runs through the attempt protocol exactly once; policies gate BEFORE any record", async () => {
  const store = createControlPlaneStoreV1();
  const machinery = makeMachinery(store);
  const client = createInMemorySandboxClientV1();
  client.addDirectory("sbx-1", "/workspace");

  // A user-managed workspace is NEVER destroyed — and no attempt record is
  // ever written for the refusal.
  const skipped = await teardownTaskSandboxV1(machinery, {
    binding: makeBinding("owner-a"),
    client,
  });
  assert.equal(skipped.kind, "skipped");
  assert.equal((await store.attempts.listForGate(SANDBOX_TEARDOWN_STEP_ID_V1)).length, 0);
  assert.equal(client.destroyedSandboxIds.length, 0);

  const ephemeral: SandboxExecutionContextV1 = {
    binding: makeBinding("owner-a", {
      lifecycle: "task-owned-ephemeral",
      cleanup: "destroy-on-completion",
    }),
    client,
  };
  const ran = await teardownTaskSandboxV1(machinery, ephemeral);
  assert.equal(ran.kind, "ran");
  assert.equal(ran.kind === "ran" ? ran.result.kind : "", "executed");
  assert.deepEqual(client.destroyedSandboxIds, ["sbx-1"]);

  // Re-driving the same step: the terminal attempt record blocks a second
  // destroy (attempt-recorded, per the review's composition-hygiene note).
  const replay = await teardownTaskSandboxV1(machinery, ephemeral);
  assert.equal(replay.kind === "ran" ? replay.result.kind : "", "alreadyExecuted");
  assert.deepEqual(client.destroyedSandboxIds, ["sbx-1"]);
});

test("split-lineage gitClone acquisition: two steps, two attempt keys, exactly one command each", async () => {
  const store = createControlPlaneStoreV1();
  const machinery = makeMachinery(store);
  const client = createInMemorySandboxClientV1({ onCommand: gitSimulation() });
  const context: SandboxExecutionContextV1 = {
    binding: makeBinding("owner-a", {
      source: { kind: "gitClone", repoUrl: "https://example.com/repo.git", ref: PINNED_SHA },
      lifecycle: "task-owned-ephemeral",
      cleanup: "retain",
    }),
    client,
  };

  const result = await acquireTaskSourceV1(machinery, context);
  assert.equal(result.acquired, true);
  assert.equal(result.steps.length, 2);
  assert.equal(client.executedCommands.length, 2);
  const cloneKey = client.executedCommands[0]?.attemptKey;
  const checkoutKey = client.executedCommands[1]?.attemptKey;
  assert.ok(cloneKey !== undefined && checkoutKey !== undefined);
  assert.notEqual(cloneKey, checkoutKey, "clone and checkout ride SEPARATE attempt lineages");
  assert.equal(client.readFile("sbx-1", "/workspace/.git/HEAD"), `${PINNED_SHA}\n`);

  // Re-driving acquires nothing twice.
  const replay = await acquireTaskSourceV1(machinery, context);
  assert.equal(replay.acquired, true);
  assert.equal(client.executedCommands.length, 2);
});

test("suggestion-7 scenario: a crash between clone and checkout recovers onto the PINNED ref, no duplicate clone", async () => {
  const store = createControlPlaneStoreV1();
  const machinery = makeMachinery(store);
  let crashNext = true;
  const client = createInMemorySandboxClientV1({
    onCommand: gitSimulation({ failCheckout: () => crashNext }),
  });
  const context: SandboxExecutionContextV1 = {
    binding: makeBinding("owner-a", {
      source: { kind: "gitClone", repoUrl: "https://example.com/repo.git", ref: PINNED_SHA },
      lifecycle: "task-owned-ephemeral",
      cleanup: "retain",
    }),
    client,
  };

  // First drive: the clone lands, then the process dies inside checkout.
  await assert.rejects(acquireTaskSourceV1(machinery, context));
  assert.equal(client.executedCommands.length, 1);
  assert.equal(client.readFile("sbx-1", "/workspace/.git/HEAD"), "ref: refs/heads/main\n");

  // Recovery drive: the clone step is adopted (own lineage, own reconcile)
  // and ONLY the checkout re-issues — the sandbox ends on the pinned ref.
  crashNext = false;
  const recovered = await acquireTaskSourceV1(machinery, context);
  assert.equal(recovered.acquired, true);
  const cloneCommands = client.executedCommands.filter((entry) => entry.argv[1] === "clone");
  const checkoutCommands = client.executedCommands.filter((entry) =>
    entry.argv.includes("checkout")
  );
  assert.equal(cloneCommands.length, 1, "the clone never re-runs");
  assert.equal(checkoutCommands.length, 1, "the checkout ran exactly once overall");
  assert.equal(client.readFile("sbx-1", "/workspace/.git/HEAD"), `${PINNED_SHA}\n`);
});

test("the checkout observable-state probe: .git/HEAD proves or disproves a sha checkout; branch refs stay unknown", async () => {
  const client = createInMemorySandboxClientV1({ commandLookup: "unavailable" });
  client.addDirectory("sbx-1", "/workspace/.git");
  const contextFor = (ref: string): SandboxExecutionContextV1 => ({
    binding: makeBinding("owner-a", {
      source: { kind: "gitClone", repoUrl: "https://example.com/repo.git", ref },
    }),
    client,
  });

  client.addFile("sbx-1", "/workspace/.git/HEAD", `${PINNED_SHA}\n`);
  const effect = createGitCheckoutEffectV1(contextFor(PINNED_SHA));
  assert.equal(await effect.reconcile?.("f".repeat(64)), "executed");

  client.addFile("sbx-1", "/workspace/.git/HEAD", "ref: refs/heads/main\n");
  assert.equal(await effect.reconcile?.("f".repeat(64)), "notExecuted");

  const branchEffect = createGitCheckoutEffectV1(contextFor("main"));
  assert.equal(await branchEffect.reconcile?.("f".repeat(64)), "unknown");
});
