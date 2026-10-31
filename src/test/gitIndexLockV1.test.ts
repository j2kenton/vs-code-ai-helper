import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  buildIndexLockFailureDiagnosisV1,
  captureGitIndexLockSnapshotV1,
  describeIndexLockAgeV1,
  describeIndexLockSettlementV1,
  findLiveGitHolderV1,
  isStaleIndexLockFailureV1,
  resolveGitIndexLockPathV1,
  settleRoundGitIndexLockV1,
} from "../utils/gitIndexLockV1";
import {
  captureRoundGitStateV1,
  inspectRoundGitInterferenceV1,
  withRoundGitStateObservationV1,
} from "../utils/roundGitStateV1";

void describe("git index-lock observation and settlement (bugs3 Step 1)", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "git-index-lock-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Index Lock Test");
    fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-qm", "base");
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  void it("resolves the index-lock path through Git", async () => {
    const lockPath = await resolveGitIndexLockPathV1(root);
    assert.equal(lockPath, path.join(root, ".git", "index.lock"));
  });

  void it("captures absent, present and unknown lock states", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const absent = await captureGitIndexLockSnapshotV1(lockPath, new Date("2026-01-01T00:00:00Z"));
    assert.equal(absent.state, "absent");
    assert.equal(absent.observedAt, "2026-01-01T00:00:00.000Z");

    fs.writeFileSync(lockPath, "");
    const present = await captureGitIndexLockSnapshotV1(lockPath, new Date("2026-01-01T00:01:00Z"));
    assert.equal(present.state, "present");
    assert.equal(present.sizeBytes, 0);
    assert.ok(present.identity);
    fs.rmSync(lockPath);

    // A directory cannot be read as a lock: capture reports the reason, not a crash.
    const unknown = await captureGitIndexLockSnapshotV1(root, new Date("2026-01-01T00:02:00Z"));
    assert.equal(unknown.state, "unknown");
    assert.ok(unknown.reason);
  });

  void it("describes lock age in human terms", () => {
    assert.equal(describeIndexLockAgeV1(30_000), "30 second(s) old");
    assert.equal(describeIndexLockAgeV1(5 * 60_000), "5 minute(s) old");
    assert.equal(describeIndexLockAgeV1(10 * 60 * 60_000), "10 hour(s) old");
    assert.equal(describeIndexLockAgeV1(-1), "an unknown age");
  });

  void it("describes lock settlements for the round outcome", () => {
    assert.equal(describeIndexLockSettlementV1({ outcome: "none-observed" }), undefined);
    assert.match(describeIndexLockSettlementV1({ outcome: "removed", ageMs: 10 * 60 * 60_000 }) ?? "", /removed an abandoned index lock \(10 hour\(s\) old\)/);
    assert.match(describeIndexLockSettlementV1({ outcome: "preserved", reason: "pre-existing", ageMs: 30_000 }) ?? "", /already present before the round/);
    assert.match(describeIndexLockSettlementV1({ outcome: "preserved", reason: "live-holder", ageMs: 30_000, detail: "git process 42 is operating in this repository" }) ?? "", /live git process may still hold it/);
    assert.match(describeIndexLockSettlementV1({ outcome: "preserved", reason: "uncertain", ageMs: 30_000 }) ?? "", /owner could not be determined/);
  });

  void it("removes only a new, unchanged lock with no live writer", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.writeFileSync(lockPath, "");
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: root,
      indexLockPath: lockPath,
      before,
      after,
      inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
    });
    assert.equal(settlement.outcome, "removed");
    assert.equal(fs.existsSync(lockPath), false);
  });

  void it("preserves a pre-existing lock", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: root,
      indexLockPath: lockPath,
      before,
      after,
      inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
    });
    assert.equal(settlement.outcome, "preserved");
    if (settlement.outcome === "preserved") assert.equal(settlement.reason, "pre-existing");
    assert.equal(fs.existsSync(lockPath), true);
    fs.rmSync(lockPath);
  });

  void it("preserves a lock while a live git writer is discovered", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.writeFileSync(lockPath, "");
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: root,
      indexLockPath: lockPath,
      before,
      after,
      inspectLiveGitHolder: () => Promise.resolve({ known: true, live: true, detail: "git process 42 is operating in this repository" }),
    });
    assert.equal(settlement.outcome, "preserved");
    if (settlement.outcome === "preserved") assert.equal(settlement.reason, "live-holder");
    assert.equal(fs.existsSync(lockPath), true);
    fs.rmSync(lockPath);
  });

  void it("preserves a lock when liveness cannot be determined", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.writeFileSync(lockPath, "");
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: root,
      indexLockPath: lockPath,
      before,
      after,
      inspectLiveGitHolder: () => Promise.resolve({ known: false, live: false }),
    });
    assert.equal(settlement.outcome, "preserved");
    if (settlement.outcome === "preserved") assert.equal(settlement.reason, "uncertain");
    assert.equal(fs.existsSync(lockPath), true);
    fs.rmSync(lockPath);
  });

  void it("preserves a lock whose identity changed between observation and removal", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.writeFileSync(lockPath, "original");
    // Forge the after snapshot with a stale identity so the recheck (the real
    // file) cannot match it: this is the replacement race.
    const after = { ...(await captureGitIndexLockSnapshotV1(lockPath)), identity: "stale-identity" };
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: root,
      indexLockPath: lockPath,
      before,
      after,
      inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
    });
    assert.equal(settlement.outcome, "preserved");
    if (settlement.outcome === "preserved") assert.equal(settlement.reason, "replaced");
    assert.equal(fs.existsSync(lockPath), true);
    fs.rmSync(lockPath);
  });

  void it("preserves a replacement created during holder inspection", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.writeFileSync(lockPath, "round lock");
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: root,
      indexLockPath: lockPath,
      before,
      after,
      inspectLiveGitHolder: () => {
        fs.rmSync(lockPath);
        fs.writeFileSync(lockPath, "replacement with different identity");
        return Promise.resolve({ known: true, live: false });
      },
    });
    assert.equal(settlement.outcome, "preserved");
    if (settlement.outcome === "preserved") assert.equal(settlement.reason, "replaced");
    assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement with different identity");
    fs.rmSync(lockPath);
  });

  void it("recognizes a stale-lock Git failure", () => {
    assert.equal(isStaleIndexLockFailureV1("fatal: Unable to create '.git/index.lock': File exists."), true);
    assert.equal(isStaleIndexLockFailureV1("fatal: Unable to create '.git/index.lock': File exists.\nAnother git process seems to be running in this repository."), true);
    assert.equal(isStaleIndexLockFailureV1("error: failed to push some refs"), false);
    assert.equal(isStaleIndexLockFailureV1(""), false);
  });

  void it("replaces a stale-lock Git failure with an age-aware diagnosis", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const diagnosis = await buildIndexLockFailureDiagnosisV1({
      repositoryRoot: root,
      stderr: "fatal: Unable to create '.git/index.lock': File exists.",
    });
    assert.match(diagnosis, /index lock is present/);
    assert.match(diagnosis, /index\.lock/);
    assert.match(diagnosis, /remove/);
    fs.rmSync(lockPath);
  });

  void it("records the before-round lock snapshot and settles a newly appearing lock", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-index-lock-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Index Lock Test");
      fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
      git(task, "add", "tracked.txt");
      git(task, "commit", "-qm", "base");
      const lockPath = path.join(task, ".git", "index.lock");
      const { record } = await withRoundGitStateObservationV1(
        {
          taskFolderPath: task,
          roundId: "round-lock",
          operationId: "operation-lock",
          inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
        },
        () => {
          // A round's git child dies and leaves its index lock behind.
          fs.writeFileSync(lockPath, "");
          return Promise.resolve(undefined);
        }
      );
      assert.equal(record.before?.indexLock?.state, "absent");
      assert.equal(record.after?.indexLock?.state, "present");
      assert.ok(record.indexLockSettlement);
      assert.equal(record.indexLockSettlement.outcome, "removed");
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });

  void it("does not call an unknown baseline pre-existing, and says it could not be established", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    for (const before of [undefined, { state: "unknown" as const, observedAt: new Date().toISOString(), reason: "EACCES" }]) {
      const settlement = await settleRoundGitIndexLockV1({
        repositoryRoot: root,
        indexLockPath: lockPath,
        before,
        after,
        inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
      });
      assert.equal(settlement.outcome, "preserved");
      if (settlement.outcome === "preserved") assert.equal(settlement.reason, "baseline-unknown");
      assert.equal(fs.existsSync(lockPath), true);
      assert.match(describeIndexLockSettlementV1(settlement) ?? "", /could not be established whether it was there before the round/);
    }
    fs.rmSync(lockPath);
  });

  void it("reports an unreadable after-round lock as unobserved instead of 'no lock'", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    const unknownAfter = { state: "unknown" as const, observedAt: new Date().toISOString(), reason: "EACCES: permission denied" };
    for (const after of [unknownAfter, undefined]) {
      const settlement = await settleRoundGitIndexLockV1({ repositoryRoot: root, indexLockPath: lockPath, before, after });
      assert.equal(settlement.outcome, "unobserved");
      const text = describeIndexLockSettlementV1(settlement) ?? "";
      assert.match(text, /could not check whether the round left an index lock/);
      assert.ok(text.includes(lockPath));
    }
  });

  void it("treats a lock that was present before and is gone after as nothing to report", async () => {
    const lockPath = path.join(root, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.rmSync(lockPath);
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    const settlement = await settleRoundGitIndexLockV1({ repositoryRoot: root, indexLockPath: lockPath, before, after });
    assert.equal(settlement.outcome, "none-observed");
  });

  void it("gives age and concrete recovery guidance for every preserved outcome", () => {
    const lockPath = "/repo/.git/index.lock";
    const reasons = ["pre-existing", "baseline-unknown", "uncertain", "live-holder", "replaced", "removal-failed"] as const;
    for (const reason of reasons) {
      const text = describeIndexLockSettlementV1({ outcome: "preserved", reason, ageMs: 10 * 60 * 60_000, lockPath }) ?? "";
      assert.match(text, /10 hour\(s\) old/, reason);
      assert.ok(text.includes(lockPath), `${reason} names the lock path`);
      assert.match(text, /delete/, reason);
    }
  });

  void it("preserves the lock and reports removal-failed when the lock cannot be unlinked", async (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.skip("needs a POSIX non-root user to make unlink fail");
      return;
    }
    const gitDir = path.join(root, ".git");
    const lockPath = path.join(gitDir, "index.lock");
    const before = await captureGitIndexLockSnapshotV1(lockPath);
    fs.writeFileSync(lockPath, "");
    const after = await captureGitIndexLockSnapshotV1(lockPath);
    fs.chmodSync(gitDir, 0o500);
    try {
      const settlement = await settleRoundGitIndexLockV1({
        repositoryRoot: root,
        indexLockPath: lockPath,
        before,
        after,
        inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
      });
      assert.equal(settlement.outcome, "preserved");
      if (settlement.outcome === "preserved") assert.equal(settlement.reason, "removal-failed");
    } finally {
      fs.chmodSync(gitDir, 0o755);
      fs.rmSync(lockPath, { force: true });
    }
  });

  void it("resolves and settles the lock of a linked worktree whose .git is a file", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "git-index-lock-wt-"));
    fs.rmSync(worktree, { recursive: true });
    try {
      git(root, "worktree", "add", "-q", "-b", "lock-wt", worktree);
      assert.equal(fs.statSync(path.join(worktree, ".git")).isFile(), true);
      const lockPath = await resolveGitIndexLockPathV1(worktree);
      assert.equal(path.dirname(path.dirname(lockPath)), path.join(fs.realpathSync(root), ".git", "worktrees"));
      assert.equal(path.basename(lockPath), "index.lock");
      const before = await captureGitIndexLockSnapshotV1(lockPath);
      assert.equal(before.state, "absent");
      fs.writeFileSync(lockPath, "");
      const after = await captureGitIndexLockSnapshotV1(lockPath);
      const settlement = await settleRoundGitIndexLockV1({
        repositoryRoot: worktree,
        indexLockPath: lockPath,
        before,
        after,
        inspectLiveGitHolder: () => Promise.resolve({ known: true, live: false }),
      });
      assert.equal(settlement.outcome, "removed");
      assert.equal(fs.existsSync(lockPath), false);
      // The main repository's own lock path is unaffected.
      assert.notEqual(lockPath, path.join(root, ".git", "index.lock"));
    } finally {
      try {
        git(root, "worktree", "remove", "--force", worktree);
      } catch {
        fs.rmSync(worktree, { recursive: true, force: true });
      }
      try {
        git(root, "branch", "-D", "lock-wt");
      } catch {
        // ignore
      }
    }
  });
});

void describe("live git writer discovery is conservative (bugs3 Step 1)", () => {
  let base: string;
  let repo: string;
  let lockPath: string;
  let procRoot: string;

  const ownUid = process.getuid?.() ?? 0;
  let mountInfoPath: string;
  const addProcess = (
    pid: number,
    spec: {
      comm: string;
      cwd?: string;
      cmdline?: string;
      environ?: string;
      fdTargets?: string[];
      cwdUnreadable?: boolean;
      cmdlineUnreadable?: boolean;
      statusUnreadable?: boolean;
      uid?: number;
    }
  ): void => {
    const dir = path.join(procRoot, String(pid));
    fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
    const uid = spec.uid ?? ownUid;
    // A directory where a file is expected makes the read fail with EISDIR, which is not "the process exited".
    if (spec.statusUnreadable) fs.mkdirSync(path.join(dir, "status"));
    else fs.writeFileSync(path.join(dir, "status"), `Name:\t${spec.comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    fs.writeFileSync(path.join(dir, "comm"), `${spec.comm}\n`);
    if (spec.cmdlineUnreadable) fs.mkdirSync(path.join(dir, "cmdline"));
    else fs.writeFileSync(path.join(dir, "cmdline"), (spec.cmdline ?? spec.comm).split(" ").join("\0"));
    fs.writeFileSync(path.join(dir, "environ"), spec.environ ?? "PATH=/usr/bin\0");
    if (spec.cwdUnreadable) fs.writeFileSync(path.join(dir, "cwd"), "not a symlink");
    else fs.symlinkSync(spec.cwd ?? os.tmpdir(), path.join(dir, "cwd"));
    (spec.fdTargets ?? []).forEach((target, index) => fs.symlinkSync(target, path.join(dir, "fd", String(index + 3))));
  };

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "git-holder-scan-"));
    repo = path.join(base, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    lockPath = path.join(repo, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    repo = fs.realpathSync(repo);
    lockPath = path.join(repo, ".git", "index.lock");
    mountInfoPath = path.join(base, "mountinfo");
    fs.writeFileSync(mountInfoPath, "1 0 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n");
  });
  after(() => fs.rmSync(base, { recursive: true, force: true }));
  beforeEach(() => {
    procRoot = fs.mkdtempSync(path.join(base, "proc-"));
    addProcess(1, { comm: "systemd" });
    addProcess(2, { comm: "node", cwd: base });
  });

  const scan = (
    platform?: NodeJS.Platform,
    extra: { currentUid?: number; mountInfoPath?: string } = {}
  ): ReturnType<typeof findLiveGitHolderV1> =>
    findLiveGitHolderV1(repo, lockPath, { procRoot, mountInfoPath, platform: platform ?? "linux", ...extra });
  const linuxOnly = process.platform === "win32";

  void it("finds nothing live when every candidate process was examined", { skip: linuxOnly }, async () => {
    assert.deepEqual(await scan(), { known: true, live: false });
  });

  void it("finds a git process running in the repository, including a subdirectory", { skip: linuxOnly }, async () => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    addProcess(10, { comm: "git", cwd: path.join(repo, "src") });
    const result = await scan();
    assert.equal(result.live, true);
    assert.match(result.detail ?? "", /git process 10/);
  });

  void it("finds a git helper that names the repository on its command line from elsewhere", { skip: linuxOnly }, async () => {
    addProcess(11, { comm: "git-remote-https", cwd: base, cmdline: `git-remote-https origin ${repo}` });
    assert.equal((await scan()).live, true);
  });

  void it("finds a non-git writer that has the lock file open", { skip: linuxOnly }, async () => {
    addProcess(12, { comm: "libgit2-tool", cwd: base, fdTargets: [lockPath] });
    const result = await scan();
    assert.equal(result.live, true);
    assert.match(result.detail ?? "", /has the lock file open/);
  });

  void it("does not treat an unreadable process as evidence of absence", { skip: linuxOnly }, async () => {
    addProcess(13, { comm: "git", cwdUnreadable: true });
    const result = await scan();
    assert.equal(result.known, false);
    assert.equal(result.live, false);
    assert.match(result.detail ?? "", /could not be fully inspected/);
  });

  void it("does not treat a git process with an unreadable command line as evidence of absence", { skip: linuxOnly }, async () => {
    addProcess(15, { comm: "git", cwd: base, cmdlineUnreadable: true });
    const result = await scan();
    assert.equal(result.known, false);
    assert.match(result.detail ?? "", /could not be fully inspected/);
  });

  void it("does not treat a process whose ownership cannot be read as evidence of absence", { skip: linuxOnly }, async () => {
    addProcess(16, { comm: "node", statusUnreadable: true });
    assert.equal((await scan()).known, false);
  });

  void it("cannot rule out a git process redirected at the repository from elsewhere", { skip: linuxOnly }, async () => {
    addProcess(17, { comm: "git", cwd: base, cmdline: "git -C ../repo add ." });
    assert.equal((await scan()).known, false);
    fs.rmSync(path.join(procRoot, "17"), { recursive: true });
    addProcess(18, { comm: "git", cwd: base, environ: "GIT_DIR=../repo/.git\0" });
    assert.equal((await scan()).known, false);
  });

  void it("ignores processes owned by other users and git processes in unrelated repositories", { skip: linuxOnly }, async () => {
    addProcess(19, { comm: "git", cwd: repo, uid: ownUid + 1 });
    addProcess(20, { comm: "git", cwd: base, cmdline: "git status" });
    assert.deepEqual(await scan(), { known: true, live: false });
  });

  void it("does not claim to have seen another user's processes", { skip: linuxOnly }, async () => {
    const result = await scan(undefined, { currentUid: ownUid + 1 });
    assert.equal(result.known, false);
    assert.match(result.detail ?? "", /another user/);
  });

  void it("does not claim to have seen writers on a shared or unidentifiable filesystem", { skip: linuxOnly }, async () => {
    const shared = path.join(base, "mountinfo-nfs");
    const realBase = fs.realpathSync(base);
    fs.writeFileSync(shared, "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n40 1 0:40 / " + realBase + " rw - nfs4 server:/export rw\n");
    const nfs = await scan(undefined, { mountInfoPath: shared });
    assert.equal(nfs.known, false);
    assert.match(nfs.detail ?? "", /shared filesystem \(nfs4\)/);
    const unreadable = await scan(undefined, { mountInfoPath: path.join(base, "no-such-mountinfo") });
    assert.equal(unreadable.known, false);
    // Docker Desktop and similar bind mounts surface as FUSE.
    const fuse = path.join(base, "mountinfo-fuse");
    fs.writeFileSync(fuse, "1 0 8:1 / / rw - overlay overlay rw\n41 1 0:41 / " + realBase + " rw - fuse.grpcfuse grpcfuse rw\n");
    assert.equal((await scan(undefined, { mountInfoPath: fuse })).known, false);
  });

  void it("does not claim to have seen writers on a container volume or bind mount", { skip: linuxOnly }, async () => {
    const realBase = fs.realpathSync(base);
    // A Docker named volume: ext4, but only a subtree of the host filesystem is mounted here.
    const volume = path.join(base, "mountinfo-volume");
    fs.writeFileSync(volume, "1 0 8:1 / / rw - overlay overlay rw\n42 1 8:1 /var/lib/docker/volumes/work/_data " + realBase + " rw - ext4 /dev/sda1 rw\n");
    const result = await scan(undefined, { mountInfoPath: volume });
    assert.equal(result.known, false);
    assert.equal(result.live, false);
    assert.match(result.detail ?? "", /volume or bind mount \(\/var\/lib\/docker\/volumes\/work\/_data\)/);
    // A whole-filesystem mount (root "/") on the same type is still trusted.
    const whole = path.join(base, "mountinfo-whole");
    fs.writeFileSync(whole, "1 0 8:1 / / rw - overlay overlay rw\n42 1 8:2 / " + realBase + " rw - ext4 /dev/sdb1 rw\n");
    assert.equal((await scan(undefined, { mountInfoPath: whole })).known, true);
  });

  void it("reports unknown when process information is unavailable or the platform has no /proc", async () => {
    const missing = await findLiveGitHolderV1(repo, lockPath, { procRoot: path.join(base, "no-such-proc"), mountInfoPath, platform: "linux" });
    assert.equal(missing.known, false);
    const windows = await findLiveGitHolderV1(repo, lockPath, { platform: "win32" });
    assert.equal(windows.known, false);
    const mac = await findLiveGitHolderV1(repo, lockPath, { platform: "darwin" });
    assert.equal(mac.known, false);
    const noLock = await findLiveGitHolderV1(repo, undefined, { procRoot, mountInfoPath, platform: "linux" });
    assert.equal(noLock.known, false);
  });

  void it("re-inspects a circumstantial live-process finding, but never an open lock file", async () => {
    let calls = 0;
    const transient = await settleRoundGitIndexLockV1({
      repositoryRoot: repo,
      indexLockPath: lockPath,
      before: { state: "absent", observedAt: new Date().toISOString() },
      after: await captureGitIndexLockSnapshotV1(lockPath),
      retryDelayMs: 0,
      inspectLiveGitHolder: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? { known: true, live: true, circumstantial: true } : { known: true, live: false });
      },
    });
    assert.equal(transient.outcome, "removed");
    assert.equal(calls, 2);

    fs.writeFileSync(lockPath, "");
    calls = 0;
    const definitive = await settleRoundGitIndexLockV1({
      repositoryRoot: repo,
      indexLockPath: lockPath,
      before: { state: "absent", observedAt: new Date().toISOString() },
      after: await captureGitIndexLockSnapshotV1(lockPath),
      retryDelayMs: 0,
      inspectLiveGitHolder: () => {
        calls += 1;
        return Promise.resolve({ known: true, live: true, detail: "process 5 has the lock file open" });
      },
    });
    assert.equal(calls, 1);
    assert.equal(definitive.outcome, "preserved");
    assert.equal(fs.existsSync(lockPath), true);
  });

  void it("an unreadable inspection preserves a new lock end to end", { skip: linuxOnly }, async () => {
    addProcess(14, { comm: "git", cwdUnreadable: true });
    const settlement = await settleRoundGitIndexLockV1({
      repositoryRoot: repo,
      indexLockPath: lockPath,
      before: { state: "absent", observedAt: new Date().toISOString() },
      after: await captureGitIndexLockSnapshotV1(lockPath),
      inspectLiveGitHolder: (root, lock) => findLiveGitHolderV1(root, lock, { procRoot, mountInfoPath, platform: "linux" }),
    });
    assert.equal(settlement.outcome, "preserved");
    if (settlement.outcome === "preserved") assert.equal(settlement.reason, "uncertain");
    assert.equal(fs.existsSync(lockPath), true);
  });
});

void describe("interrupted-host index-lock recovery (bugs3 Step 1)", () => {
  const noLiveWriter = (): Promise<{ known: true; live: false }> => Promise.resolve({ known: true, live: false });
  let task: string;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: task, stdio: "ignore" });
  };
  const writeBeforeOnlyRecord = async (operationId: string, lockPresentBefore: boolean): Promise<void> => {
    const lock = path.join(task, ".git", "index.lock");
    if (lockPresentBefore) fs.writeFileSync(lock, "owner");
    const snapshot = await captureRoundGitStateV1({ repositoryRoot: task, taskFolderPath: task, roundId: "r", operationId });
    const folder = path.join(task, "round-git-state-v1");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, `${operationId}.json`),
      JSON.stringify({ version: 1, roundId: "r", operationId, taskFolderPath: task, repositoryRoot: task, before: snapshot })
    );
  };

  beforeEach(() => {
    task = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-interrupted-lock-")));
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Index Lock Test");
    fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
    git("add", "tracked.txt");
    git("commit", "-qm", "base");
  });
  afterEach(() => fs.rmSync(task, { recursive: true, force: true }));

  void it("removes a lock a killed round left, reports it once, and records the settlement", async () => {
    await writeBeforeOnlyRecord("op-killed", false);
    const lock = path.join(task, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const first = await inspectRoundGitInterferenceV1(task, { inspectLiveGitHolder: noLiveWriter });
    assert.equal(fs.existsSync(lock), false);
    assert.equal(first.indexLockNotices?.length, 1);
    assert.match(first.indexLockNotices?.[0] ?? "", /interrupted: removed an abandoned index lock/);
    const persisted = JSON.parse(fs.readFileSync(path.join(task, "round-git-state-v1", "op-killed.json"), "utf8")) as {
      after?: unknown;
      indexLockSettlement?: { outcome: string };
    };
    assert.ok(persisted.after);
    assert.equal(persisted.indexLockSettlement?.outcome, "removed");
    // The recovery already happened; a second inspection reports nothing and touches nothing.
    const second = await inspectRoundGitInterferenceV1(task, { inspectLiveGitHolder: noLiveWriter });
    assert.equal(second.indexLockNotices, undefined);
  });

  void it("keeps a lock that was already there before the interrupted round, with guidance", async () => {
    await writeBeforeOnlyRecord("op-owner-lock", true);
    const lock = path.join(task, ".git", "index.lock");
    const result = await inspectRoundGitInterferenceV1(task, { inspectLiveGitHolder: noLiveWriter });
    assert.equal(fs.existsSync(lock), true);
    assert.match(result.indexLockNotices?.[0] ?? "", /already present before the round/);
    assert.match(result.indexLockNotices?.[0] ?? "", /delete/);
  });

  void it("keeps the lock when a live git writer is found", async () => {
    await writeBeforeOnlyRecord("op-live-writer", false);
    const lock = path.join(task, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const result = await inspectRoundGitInterferenceV1(task, {
      inspectLiveGitHolder: () => Promise.resolve({ known: true, live: true, detail: "git process 7 is running in this repository" }),
    });
    assert.equal(fs.existsSync(lock), true);
    assert.match(result.indexLockNotices?.[0] ?? "", /live git process may still hold it/);
  });

  void it("leaves a still-running round untouched and never settles its lock", async () => {
    await writeBeforeOnlyRecord("op-running", false);
    const lock = path.join(task, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const result = await inspectRoundGitInterferenceV1(task, {
      liveOperationIds: new Set(["op-running"]),
      inspectLiveGitHolder: noLiveWriter,
    });
    assert.equal(fs.existsSync(lock), true);
    assert.equal(result.indexLockNotices, undefined);
    const persisted = JSON.parse(fs.readFileSync(path.join(task, "round-git-state-v1", "op-running.json"), "utf8")) as { after?: unknown };
    assert.equal(persisted.after, undefined);
  });

  void it("does not remove an interrupted round's lock while another round is still running", async () => {
    await writeBeforeOnlyRecord("op-killed-2", false);
    await writeBeforeOnlyRecord("op-other-live", false);
    const lock = path.join(task, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const result = await inspectRoundGitInterferenceV1(task, {
      liveOperationIds: new Set(["op-other-live"]),
      inspectLiveGitHolder: noLiveWriter,
    });
    assert.equal(fs.existsSync(lock), true);
    assert.match(result.indexLockNotices?.[0] ?? "", /another round in this task is still running/);
  });
});
