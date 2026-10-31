import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { describeIndexLockSettlementV1 } from "../utils/gitIndexLockV1";
import { inspectRoundGitInterferenceV1, withRoundGitStateObservationV1 } from "../utils/roundGitStateV1";

type ObservationRecord = Awaited<ReturnType<typeof withRoundGitStateObservationV1>>["record"];
type Inspector = () => Promise<{ known: boolean; live: boolean; detail?: string }>;

void describe("round wrapper settles the lock on every ending path (bugs3 Step 1)", () => {
  const noLiveWriter: Inspector = () => Promise.resolve({ known: true, live: false });
  let task: string;
  let lock: string;
  let operationCounter = 0;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: task, stdio: "ignore" });
  };
  const observe = async (
    run: () => Promise<unknown>,
    inspectLiveGitHolder: Inspector = noLiveWriter
  ): Promise<{ record: ObservationRecord; thrown?: unknown }> => {
    operationCounter += 1;
    let observed: ObservationRecord | undefined;
    let thrown: unknown;
    try {
      const { record } = await withRoundGitStateObservationV1(
        { taskFolderPath: task, roundId: "r", operationId: `op-${operationCounter}`, inspectLiveGitHolder, lockRetryDelayMs: 0 },
        run,
        (record) => {
          observed = record;
        }
      );
      observed = record;
    } catch (error) {
      thrown = error;
    }
    assert.ok(observed, "the observation is reported even when the round threw");
    return { record: observed, thrown };
  };
  const describeSettlement = (record: ObservationRecord): string =>
    describeIndexLockSettlementV1(record.indexLockSettlement ?? { outcome: "none-observed" }) ?? "";

  beforeEach(() => {
    task = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-round-wrapper-lock-")));
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Index Lock Test");
    fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
    git("add", "tracked.txt");
    git("commit", "-qm", "base");
    lock = path.join(task, ".git", "index.lock");
  });
  afterEach(() => fs.rmSync(task, { recursive: true, force: true }));

  void it("settles a successful round without changing unrelated staged entries", async () => {
    fs.writeFileSync(path.join(task, "owner.txt"), "owner work\n");
    git("add", "owner.txt");
    const stagedBefore = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: task, encoding: "utf8" });
    const { record, thrown } = await observe(() => {
      fs.writeFileSync(lock, "");
      return Promise.resolve("success");
    });
    assert.equal(thrown, undefined);
    assert.equal(record.indexLockSettlement?.outcome, "removed");
    assert.match(describeSettlement(record), /removed an abandoned index lock/);
    assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: task, encoding: "utf8" }), stagedBefore);
  });

  void it("removes a lock left by a failed round and still rethrows the failure", async () => {
    const { record, thrown } = await observe(() => {
      fs.writeFileSync(lock, "");
      return Promise.reject(new Error("provider failed"));
    });
    assert.match(String(thrown), /provider failed/);
    assert.equal(record.indexLockSettlement?.outcome, "removed");
    assert.equal(fs.existsSync(lock), false);
    const persisted = JSON.parse(fs.readFileSync(path.join(task, "round-git-state-v1", `${record.operationId}.json`), "utf8")) as {
      indexLockSettlement?: { outcome: string };
    };
    assert.equal(persisted.indexLockSettlement?.outcome, "removed");
  });

  void it("removes a lock left by a cancelled round", async () => {
    const { record, thrown } = await observe(() => {
      fs.writeFileSync(lock, "");
      const cancelled = new Error("The operation was aborted");
      cancelled.name = "AbortError";
      return Promise.reject(cancelled);
    });
    assert.equal((thrown as Error).name, "AbortError");
    assert.equal(record.indexLockSettlement?.outcome, "removed");
    assert.equal(fs.existsSync(lock), false);
  });

  void it("keeps a lock the owner placed before the round, with its age and what to do", async () => {
    fs.writeFileSync(lock, "owner");
    const { record } = await observe(() => Promise.resolve(undefined));
    assert.equal(fs.existsSync(lock), true);
    const text = describeSettlement(record);
    assert.match(text, /already present before the round/);
    assert.match(text, /old\)/);
    assert.ok(text.includes(lock));
  });

  void it("keeps a new lock while inspection cannot rule out a live writer, and reports it", async () => {
    const { record } = await observe(
      () => {
        fs.writeFileSync(lock, "");
        return Promise.resolve(undefined);
      },
      () => Promise.resolve({ known: false, live: false, detail: "1 process(es) could not be fully inspected" })
    );
    assert.equal(fs.existsSync(lock), true);
    assert.equal(record.indexLockSettlement?.outcome, "preserved");
    assert.match(describeSettlement(record), /owner could not be determined/);
  });

  void it("reports nothing when the round leaves no lock", async () => {
    const { record } = await observe(() => Promise.resolve(undefined));
    assert.equal(record.indexLockSettlement?.outcome, "none-observed");
  });

  void it("settles a round that refused to start: nothing to remove, and an owner's lock is kept", async () => {
    // A refusal (busy, no model, failed preflight) resolves without ever invoking git.
    const refused = await observe(() => Promise.resolve(false));
    assert.equal(refused.thrown, undefined);
    assert.equal(refused.record.indexLockSettlement?.outcome, "none-observed");

    fs.writeFileSync(lock, "owner");
    const refusedWithOwnerLock = await observe(() => Promise.resolve(false));
    assert.equal(fs.existsSync(lock), true, "a refusal never deletes a lock the round did not create");
    assert.match(describeSettlement(refusedWithOwnerLock.record), /already present before the round/);
  });

  void it("settles a round that refused by throwing before it ran anything", async () => {
    const { record, thrown } = await observe(() => Promise.reject(new Error("no model is configured for this stage")));
    assert.match(String(thrown), /no model is configured/);
    assert.equal(record.indexLockSettlement?.outcome, "none-observed");
  });

  void it("removes a lock only once: a second observation of the same settled round finds none", async () => {
    const first = await observe(() => {
      fs.writeFileSync(lock, "");
      return Promise.resolve("done");
    });
    assert.equal(first.record.indexLockSettlement?.outcome, "removed");
    const second = await observe(() => Promise.resolve("done"));
    assert.equal(second.record.indexLockSettlement?.outcome, "none-observed", "the removed lock is not reported again");
  });

  void it("still removes a new lock when the broader before-round capture failed", async () => {
    fs.writeFileSync(path.join(task, ".git", "index"), "not an index");
    const { record } = await observe(() => {
      fs.writeFileSync(lock, "");
      return Promise.resolve(undefined);
    });
    assert.equal(record.before, undefined, "the broader capture failed");
    assert.ok(record.unavailableReason);
    assert.equal(record.indexLockBefore?.state, "absent");
    assert.equal(record.indexLockSettlement?.outcome, "removed");
    assert.equal(fs.existsSync(lock), false);
  });

  void it("still reports a pre-existing lock, with age and guidance, when the broader capture failed", async () => {
    fs.writeFileSync(path.join(task, ".git", "index"), "not an index");
    fs.writeFileSync(lock, "owner");
    const { record } = await observe(() => Promise.resolve(undefined));
    assert.equal(record.before, undefined);
    assert.equal(fs.existsSync(lock), true);
    const text = describeSettlement(record);
    assert.match(text, /already present before the round/);
    assert.match(text, /delete/);
  });

  void it("recovers a killed round whose only before-round evidence is the lock observation", async () => {
    const folder = path.join(task, "round-git-state-v1");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "op-lock-only.json"),
      JSON.stringify({
        version: 1,
        roundId: "r",
        operationId: "op-lock-only",
        taskFolderPath: task,
        repositoryRoot: task,
        indexLockBefore: { state: "absent", observedAt: new Date().toISOString() },
      })
    );
    fs.writeFileSync(lock, "");
    const first = await inspectRoundGitInterferenceV1(task, { inspectLiveGitHolder: noLiveWriter });
    assert.equal(fs.existsSync(lock), false);
    assert.match(first.indexLockNotices?.[0] ?? "", /interrupted: removed an abandoned index lock/);
    const second = await inspectRoundGitInterferenceV1(task, { inspectLiveGitHolder: noLiveWriter });
    assert.equal(second.indexLockNotices, undefined);
  });

  void it("does not settle or report a lock twice when the round already settled it before its after-capture failed", async () => {
    const folder = path.join(task, "round-git-state-v1");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "op-already-settled.json"),
      JSON.stringify({
        version: 1,
        roundId: "r",
        operationId: "op-already-settled",
        taskFolderPath: task,
        repositoryRoot: task,
        indexLockBefore: { state: "absent", observedAt: new Date().toISOString() },
        indexLockSettlement: { outcome: "preserved", reason: "uncertain", lockPath: lock },
        unavailableReason: "could not capture the after-round Git state",
      })
    );
    fs.writeFileSync(lock, "");
    const result = await inspectRoundGitInterferenceV1(task, { inspectLiveGitHolder: noLiveWriter });
    assert.equal(result.indexLockNotices, undefined);
    assert.equal(fs.existsSync(lock), true, "the earlier uncertain settlement is not overridden");
  });
});
