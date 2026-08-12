/**
 * Sandbox execution integration tests (plan Part 4d, acceptance criteria 5
 * and 6 at the engine level).
 *
 * Covers: strict argv quoting and attempt-key marker threading, the Part 3
 * path-confinement rule end-to-end (lexical rejection of `..`/absolute
 * paths, symlinks resolved via the provider filesystem API then checked —
 * including a symlinked binding root), gated sandbox commands running under
 * the full 4c protocol (attempt persisted before the command, marker on the
 * command, reconciliation by marker and by observable clone state, the
 * indeterminate re-offer), source acquisition for both binding modes,
 * teardown per cleanup policy, and the source scan asserting the engine
 * itself never evals or shells out anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxBindingV1 } from "../../ensemble-contract/src/sandboxBindingV1";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { createRecordingEventSinkV1 } from "../src/engineEventsV1";
import {
  createInMemoryExecutionAttemptStoreV1,
  EngineExecutionAttemptStoreV1,
  ExecutionAttemptRecordV1,
} from "../src/executionAttemptStoreV1";
import { createEngineGateMachineryV1, EngineGateMachineryV1 } from "../src/gateMachineryV1";
import {
  buildMarkedSandboxCommandV1,
  createInMemorySandboxClientV1,
  InMemorySandboxClientOptionsV1,
  InMemorySandboxClientV1,
  quotePosixShellArgV1,
  SANDBOX_ATTEMPT_KEY_MARKER_V1,
} from "../src/sandboxClientV1";
import {
  createSandboxCommandEffectV1,
  createSourceAcquisitionEffectV1,
  resolveConfinedSandboxPathV1,
  SandboxExecutionContextV1,
  teardownSandboxPerPolicyV1,
} from "../src/sandboxExecutionV1";

const TASK_ID = "task-4d-demo";
const OWNER_ID = "user-owner-1";
const SANDBOX_ID = "sbx-test";
const ROOT = "/workspace/repo";

function binding(overrides?: Partial<SandboxBindingV1>): SandboxBindingV1 {
  return {
    bindingId: "binding-1",
    ownerUserId: OWNER_ID,
    provider: "e2b",
    sandboxId: SANDBOX_ID,
    source: { kind: "gitClone", repoUrl: "https://example.com/repo.git", ref: "main" },
    workingDirectoryRoot: ROOT,
    lifecycle: "task-owned-ephemeral",
    cleanup: "destroy-on-completion",
    ...overrides,
  };
}

function contextWith(options?: {
  readonly client?: InMemorySandboxClientOptionsV1;
  readonly binding?: Partial<SandboxBindingV1>;
}): SandboxExecutionContextV1 & { readonly client: InMemorySandboxClientV1 } {
  const client = createInMemorySandboxClientV1(options?.client);
  return { binding: binding(options?.binding), client };
}

function machineryWith(attemptStore?: EngineExecutionAttemptStoreV1): EngineGateMachineryV1 & {
  readonly sink: ReturnType<typeof createRecordingEventSinkV1>;
} {
  const sink = createRecordingEventSinkV1();
  const machinery = createEngineGateMachineryV1({
    taskId: TASK_ID,
    ownerId: OWNER_ID,
    workerId: "worker-a",
    sink,
    ...(attemptStore !== undefined ? { attemptStore } : {}),
  });
  return Object.assign(machinery, { sink });
}

/** An attempt store whose next `complete` throws (crash boundary 3). */
function completeCrashingStore(): {
  readonly store: EngineExecutionAttemptStoreV1;
  armCrash(): void;
} {
  const inner = createInMemoryExecutionAttemptStoreV1();
  let crash = false;
  return {
    armCrash(): void {
      crash = true;
    },
    store: {
      begin: (input) => inner.begin(input),
      complete(
        attemptKey: string,
        state: "succeeded" | "failed",
        outcomeCode?: string
      ): Promise<ExecutionAttemptRecordV1> {
        if (crash) {
          crash = false;
          return Promise.reject(new Error("injected crash: before the outcome persisted"));
        }
        return inner.complete(attemptKey, state, outcomeCode);
      },
      markIndeterminate: (attemptKey) => inner.markIndeterminate(attemptKey),
      read: (attemptKey) => inner.read(attemptKey),
      listForGate: (gateId) => inner.listForGate(gateId),
      listOpenForTask: (taskId) => inner.listOpenForTask(taskId),
    },
  };
}

// ─── Quoting and marker threading ───────────────────────────────────────────

test("argv is strictly quoted and the attempt-key marker prefixes every command", () => {
  assert.equal(quotePosixShellArgV1("plain"), "'plain'");
  assert.equal(quotePosixShellArgV1("has spaces"), "'has spaces'");
  assert.equal(quotePosixShellArgV1("a'b"), "'a'\\''b'");
  assert.equal(quotePosixShellArgV1("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.throws(() => quotePosixShellArgV1("nul\0byte"));

  const key = "ab".repeat(32);
  const command = buildMarkedSandboxCommandV1(["echo", "hi there; $HOME"], key);
  assert.equal(command, `${SANDBOX_ATTEMPT_KEY_MARKER_V1}='${key}' 'echo' 'hi there; $HOME'`);

  assert.throws(() => buildMarkedSandboxCommandV1([], key));
  assert.throws(() => buildMarkedSandboxCommandV1(["echo"], "NOT-A-KEY"));
});

// ─── Path confinement under the Part 3 symlink rule ─────────────────────────

test("lexical escapes are rejected: .., absolute paths, and nonexistent paths fail closed", async () => {
  const context = contextWith();
  context.client.addDirectory(SANDBOX_ID, ROOT);

  const dotdot = await resolveConfinedSandboxPathV1(context, "../outside.txt");
  assert.ok(!dotdot.ok && dotdot.code === "pathOutsideBindingRoot");
  const absolute = await resolveConfinedSandboxPathV1(context, "/etc/passwd");
  assert.ok(!absolute.ok && absolute.code === "pathOutsideBindingRoot");
  const missing = await resolveConfinedSandboxPathV1(context, "no-such-file.txt");
  assert.ok(!missing.ok && missing.code === "pathOutsideBindingRoot");

  // allowMissingLeaf permits a NEW file whose parent exists inside the root.
  const newFile = await resolveConfinedSandboxPathV1(context, "new-file.txt", {
    allowMissingLeaf: true,
  });
  assert.ok(newFile.ok);
  assert.equal(newFile.realAbsolutePath, `${ROOT}/new-file.txt`);
});

test("symlinks are resolved via the provider API then checked: escapes rejected, internal links allowed", async () => {
  const context = contextWith();
  context.client.addDirectory(SANDBOX_ID, ROOT);
  context.client.addFile(SANDBOX_ID, "/etc/passwd", "root:x:0:0");
  context.client.addSymlink(SANDBOX_ID, `${ROOT}/link.txt`, "/etc/passwd");
  context.client.addFile(SANDBOX_ID, `${ROOT}/actual/file.txt`, "data");
  context.client.addSymlink(SANDBOX_ID, `${ROOT}/inner`, `${ROOT}/actual`);

  const escape = await resolveConfinedSandboxPathV1(context, "link.txt");
  assert.ok(!escape.ok && escape.code === "symlinkEscapesBindingRoot");

  // A new file UNDER an escaping symlinked directory is also rejected.
  context.client.addSymlink(SANDBOX_ID, `${ROOT}/outdir`, "/etc");
  const nested = await resolveConfinedSandboxPathV1(context, "outdir/new.txt", {
    allowMissingLeaf: true,
  });
  assert.ok(!nested.ok && nested.code === "symlinkEscapesBindingRoot");

  // A DANGLING escaping symlink is indistinguishable from a missing
  // directory through the provider API: fail closed, never reconstruct the
  // path around it.
  context.client.addSymlink(SANDBOX_ID, `${ROOT}/dangle`, "/nonexistent/dir");
  const dangling = await resolveConfinedSandboxPathV1(context, "dangle/new.txt", {
    allowMissingLeaf: true,
  });
  assert.ok(!dangling.ok && dangling.code === "pathOutsideBindingRoot");

  const internal = await resolveConfinedSandboxPathV1(context, "inner/file.txt");
  assert.ok(internal.ok);
  assert.equal(internal.realAbsolutePath, `${ROOT}/actual/file.txt`);
});

test("a symlinked binding root is resolved first and confinement is checked against its real target", async () => {
  const context = contextWith();
  context.client.addDirectory(SANDBOX_ID, "/data/real");
  context.client.addFile(SANDBOX_ID, "/data/real/a.txt", "content");
  context.client.addSymlink(SANDBOX_ID, ROOT, "/data/real");

  const resolved = await resolveConfinedSandboxPathV1(context, "a.txt");
  assert.ok(resolved.ok);
  assert.equal(resolved.realAbsolutePath, "/data/real/a.txt");
});

// ─── Gated sandbox commands under the 4c protocol ───────────────────────────

async function approveGate(machinery: EngineGateMachineryV1, summary: string): Promise<string> {
  const gate = await machinery.openGate({ summary });
  const decided = await machinery.decide({
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  return gate.gateId;
}

test("an approved gate executes exactly one marked command in the confined cwd via the provider API", async () => {
  const context = contextWith();
  context.client.addDirectory(SANDBOX_ID, ROOT);
  const machinery = machineryWith();
  const gateId = await approveGate(machinery, "run the test suite");

  const effect = createSandboxCommandEffectV1(context, { argv: ["npm", "test"] });
  const resumed = await machinery.resumeApproved(gateId, effect);
  assert.equal(resumed.kind, "executed");
  assert.ok(resumed.kind === "executed");
  assert.deepEqual(resumed.outcome, { status: "succeeded", code: "exit0" });

  assert.equal(context.client.executedCommands.length, 1);
  const command = context.client.executedCommands[0]!;
  assert.equal(command.sandboxId, SANDBOX_ID);
  assert.equal(command.cwd, ROOT);
  assert.equal(command.attemptKey, resumed.attemptKey);
  assert.ok(command.commandText.startsWith(`${SANDBOX_ATTEMPT_KEY_MARKER_V1}='`));
  assert.ok(command.commandText.endsWith("'npm' 'test'"));

  // Driving resumption again never re-executes.
  const again = await machinery.resumeApproved(gateId, effect);
  assert.equal(again.kind, "alreadyExecuted");
  assert.equal(context.client.executedCommands.length, 1);
});

test("an escaping cwd refuses before anything reaches the sandbox", async () => {
  const context = contextWith();
  context.client.addDirectory(SANDBOX_ID, ROOT);
  const machinery = machineryWith();
  const gateId = await approveGate(machinery, "run somewhere it should not");

  const effect = createSandboxCommandEffectV1(context, {
    argv: ["ls"],
    cwdRelative: "../other",
  });
  const resumed = await machinery.resumeApproved(gateId, effect);
  assert.ok(resumed.kind === "executed");
  assert.deepEqual(resumed.outcome, { status: "failed", code: "pathOutsideBindingRoot" });
  assert.equal(context.client.executedCommands.length, 0);
});

test("approved file changes apply inside the root; an escaping change path refuses the whole effect", async () => {
  const context = contextWith();
  context.client.addDirectory(SANDBOX_ID, ROOT);
  context.client.addDirectory(SANDBOX_ID, `${ROOT}/src`);
  context.client.addFile(SANDBOX_ID, `${ROOT}/old.txt`, "stale");
  const machinery = machineryWith();

  const applyGate = await approveGate(machinery, "apply the reviewed diff");
  const apply = createSandboxCommandEffectV1(context, {
    argv: [],
    applyChanges: [
      { path: "src/new.ts", oldText: null, newText: "export const x = 1;\n" },
      { path: "old.txt", oldText: "stale", newText: null },
    ],
  });
  const applied = await machinery.resumeApproved(applyGate, apply);
  assert.ok(applied.kind === "executed");
  assert.deepEqual(applied.outcome, { status: "succeeded", code: "appliedChangesOnly" });
  assert.equal(context.client.readFile(SANDBOX_ID, `${ROOT}/src/new.ts`), "export const x = 1;\n");
  assert.equal(context.client.readFile(SANDBOX_ID, `${ROOT}/old.txt`), undefined);

  // A change routed through an escaping symlink refuses before any write or
  // command: nothing lands outside the root.
  context.client.addDirectory(SANDBOX_ID, "/etc");
  context.client.addSymlink(SANDBOX_ID, `${ROOT}/evil`, "/etc");
  const escapeGate = await approveGate(machinery, "apply an escaping diff");
  const escaping = createSandboxCommandEffectV1(context, {
    argv: ["npm", "test"],
    applyChanges: [{ path: "evil/hosts", oldText: null, newText: "pwned" }],
  });
  const refused = await machinery.resumeApproved(escapeGate, escaping);
  assert.ok(refused.kind === "executed");
  assert.deepEqual(refused.outcome, { status: "failed", code: "symlinkEscapesBindingRoot" });
  assert.equal(context.client.readFile(SANDBOX_ID, "/etc/hosts"), undefined);
  assert.equal(context.client.executedCommands.length, 0);
});

// ─── Source acquisition per binding mode ────────────────────────────────────

test("gitClone acquisition runs clone + checkout as one marked attempt, exactly once per step", async () => {
  const context = contextWith();
  const machinery = machineryWith();
  const effect = createSourceAcquisitionEffectV1(context);

  const acquired = await machinery.runUngatedEffect("source-acquisition", effect);
  assert.equal(acquired.kind, "executed");
  assert.ok(acquired.kind === "executed");
  assert.deepEqual(acquired.outcome, { status: "succeeded", code: "sourceAcquired" });

  assert.equal(context.client.executedCommands.length, 2);
  const [clone, checkout] = context.client.executedCommands;
  assert.deepEqual(clone!.argv, ["git", "clone", "--", "https://example.com/repo.git", ROOT]);
  assert.deepEqual(checkout!.argv, ["git", "-C", ROOT, "checkout", "--detach", "main"]);
  assert.equal(clone!.attemptKey, acquired.attemptKey);
  assert.equal(checkout!.attemptKey, acquired.attemptKey);

  // Re-driving the step never re-clones.
  const replay = await machinery.runUngatedEffect("source-acquisition", effect);
  assert.equal(replay.kind, "alreadyExecuted");
  assert.equal(context.client.executedCommands.length, 2);
});

test("crash after the clone ran but before the outcome persisted: recovery adopts via the marker ledger, no duplicate clone", async () => {
  const context = contextWith();
  const crashing = completeCrashingStore();
  const machinery = machineryWith(crashing.store);
  const effect = createSourceAcquisitionEffectV1(context);

  crashing.armCrash();
  await assert.rejects(
    () => machinery.runUngatedEffect("source-acquisition", effect),
    /before the outcome persisted/
  );
  assert.equal(context.client.executedCommands.length, 2);

  const recovered = await machinery.runUngatedEffect("source-acquisition", effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "reconciledAdoptedOutcome");
  assert.equal(context.client.executedCommands.length, 2);
});

test("gitClone reconciliation falls back to observable state when the marker query is unavailable", async () => {
  // The provider cannot answer marker queries, but the clone's own artifact
  // (<root>/.git) proves execution.
  const context = contextWith({ client: { commandLookup: "unavailable" } });
  const crashing = completeCrashingStore();
  const machinery = machineryWith(crashing.store);
  const effect = createSourceAcquisitionEffectV1(context);

  crashing.armCrash();
  await assert.rejects(() => machinery.runUngatedEffect("source-acquisition", effect));
  context.client.addDirectory(SANDBOX_ID, `${ROOT}/.git`);

  const recovered = await machinery.runUngatedEffect("source-acquisition", effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "reconciledAdoptedOutcome");
  assert.equal(context.client.executedCommands.length, 2);
});

test("an unprovable clone attempt goes indeterminate and re-enters the gate flow; re-approval re-runs under a new key", async () => {
  // Root exists (so "notExecuted" cannot be proven), marker queries are
  // unavailable, and no .git exists: genuinely indeterminate.
  let crashNext = true;
  const context = contextWith({
    client: {
      commandLookup: "unavailable",
      onCommand: () => {
        if (crashNext) {
          crashNext = false;
          throw new Error("injected crash: transport died mid-command");
        }
        return undefined;
      },
    },
  });
  context.client.addDirectory(SANDBOX_ID, ROOT);
  const machinery = machineryWith();
  const effect = createSourceAcquisitionEffectV1(context);

  await assert.rejects(() => machinery.runUngatedEffect("source-acquisition", effect));
  assert.equal(context.client.executedCommands.length, 0);

  const recovered = await machinery.runUngatedEffect("source-acquisition", effect);
  assert.equal(recovered.kind, "indeterminate");
  assert.ok(recovered.kind === "indeterminate");
  assert.equal(context.client.executedCommands.length, 0);

  // Explicit re-approval of the re-offer gate re-runs as a NEW attempt.
  await machinery.decide({
    gateId: recovered.reofferGateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  const rerun = await machinery.resumeApproved(recovered.reofferGateId, effect);
  assert.equal(rerun.kind, "executed");
  assert.ok(rerun.kind === "executed");
  assert.notEqual(rerun.attemptKey, recovered.attemptKey);
  assert.equal(context.client.executedCommands.length, 2);
});

test("attachExisting verifies the user-managed path contains the binding root, side-effect-free", async () => {
  const attach = { kind: "attachExisting", path: "/workspace" } as const;
  const good = contextWith({ binding: { source: attach, lifecycle: "user-managed-persistent", cleanup: "retain" } });
  good.client.addDirectory(SANDBOX_ID, ROOT);
  const verified = await createSourceAcquisitionEffectV1(good).execute("ab".repeat(32));
  assert.deepEqual(verified, { status: "succeeded", code: "attachedExisting" });
  assert.equal(good.client.executedCommands.length, 0);

  const missing = contextWith({ binding: { source: attach } });
  const noTarget = await createSourceAcquisitionEffectV1(missing).execute("ab".repeat(32));
  assert.deepEqual(noTarget, { status: "failed", code: "attachTargetMissing" });

  const disjoint = contextWith({
    binding: { source: { kind: "attachExisting", path: "/elsewhere" } },
  });
  disjoint.client.addDirectory(SANDBOX_ID, ROOT);
  disjoint.client.addDirectory(SANDBOX_ID, "/elsewhere");
  const outside = await createSourceAcquisitionEffectV1(disjoint).execute("ab".repeat(32));
  assert.deepEqual(outside, { status: "failed", code: "rootOutsideAttachedPath" });
});

// ─── Teardown per cleanup policy ────────────────────────────────────────────

test("teardown destroys only a task-owned ephemeral sandbox with destroy-on-completion", async () => {
  const destroy = contextWith();
  assert.deepEqual(await teardownSandboxPerPolicyV1(destroy), { destroyed: true });
  assert.deepEqual(destroy.client.destroyedSandboxIds, [SANDBOX_ID]);

  const retain = contextWith({ binding: { cleanup: "retain" } });
  const kept = await teardownSandboxPerPolicyV1(retain);
  assert.equal(kept.destroyed, false);
  assert.deepEqual(retain.client.destroyedSandboxIds, []);

  // Defense in depth: a user-managed workspace is never destroyed even if a
  // (contract-invalid) record carries the destroy policy.
  const userManaged = contextWith({
    binding: { lifecycle: "user-managed-persistent", cleanup: "destroy-on-completion" },
  });
  const untouched = await teardownSandboxPerPolicyV1(userManaged);
  assert.equal(untouched.destroyed, false);
  assert.deepEqual(userManaged.client.destroyedSandboxIds, []);
});

// ─── The engine never executes anything itself (criterion 6) ────────────────

test("no child-process, eval, or Function-constructor usage exists anywhere in the engine sources", () => {
  // Tests run compiled from out-test; walk up to the package root that holds
  // the TypeScript sources.
  let packageRoot = __dirname;
  while (!existsSync(join(packageRoot, "src", "sandboxClientV1.ts"))) {
    const parent = join(packageRoot, "..");
    assert.notEqual(parent, packageRoot, "could not locate the engine src directory");
    packageRoot = parent;
  }
  const srcDir = join(packageRoot, "src");
  const forbidden = [
    /\bchild_process\b/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /\bexecSync\b/,
    /\bspawnSync\b/,
    /\bspawn\s*\(/,
    /\bexecFile\b/,
  ];
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 20, "expected the full engine source list");
  for (const name of files) {
    const text = readFileSync(join(srcDir, name), "utf8");
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(text),
        `${name} matches forbidden execution pattern ${String(pattern)}`
      );
    }
  }
});
