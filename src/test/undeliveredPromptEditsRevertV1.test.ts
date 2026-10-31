/**
 * bugs3 Step 6: edits made after a provider never received its prompt are
 * reverted only on request, only for paths that were clean before the round,
 * and only while they still match what was offered.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe as nodeDescribe, it as nodeIt, type TestContext } from "node:test";
import { describeUndeliveredPromptEditsV1 } from "../utils/clinePromptReceiptV1";
import {
  captureRevertBaselineHeadV1,
  describeUndeliveredRevertOutcomeV1,
  findOpenUndeliveredPromptEditsRecordV1,
  fingerprintRevertTargetsV1,
  isSafeRevertPathV1,
  readUndeliveredPromptEditsRecordsV1,
  recordUndeliveredPromptEditsV1,
  revertUndeliveredPromptEditsV1,
  scopeUndeliveredPromptEditsV1,
  settleUndeliveredPromptEditsRecordV1,
  UNDELIVERED_PROMPT_EDITS_RECORD_FILE_V1,
  type UndeliveredRevertIoV1,
} from "../utils/undeliveredPromptEditsRevertV1";
import {
  offerUndeliveredPromptEditsRevertInChatV1,
  revertUndeliveredPromptEditsConfirmedV1,
} from "../commands/undeliveredPromptEditsOfferV1";

const describe = (name: string, body: () => void): void => void nodeDescribe(name, body);
const it = (name: string, body: (t: TestContext) => unknown): void => void nodeIt(name, body as (t: TestContext) => void);

interface IoCalls {
  readonly calls: string[];
}

function fakeIo(options: {
  fingerprints?: Record<string, string>;
  inHead?: readonly string[];
  inIndex?: Record<string, boolean | undefined>;
  restoreOk?: boolean;
  unstageOk?: boolean;
  removeOk?: boolean;
  root?: string | undefined;
  /** The index entry per path as git reports it; "absent" when not listed. */
  indexStates?: Record<string, string | undefined>;
  /** Paths whose staged content differs from HEAD. */
  stagedDiffersFromHead?: readonly string[];
}): UndeliveredRevertIoV1 & IoCalls {
  const calls: string[] = [];
  return {
    calls,
    indexState: (_root, rel) =>
      Promise.resolve(options.indexStates !== undefined && rel in options.indexStates ? options.indexStates[rel] : "absent"),
    indexDiffersFromHead: (_root, rel) => Promise.resolve(options.stagedDiffersFromHead?.includes(rel) ?? false),
    gitRoot: () => Promise.resolve("root" in options ? options.root : "/repo"),
    fingerprint: (_root, rel) => Promise.resolve(options.fingerprints?.[rel] ?? "absent"),
    inHead: (_root, rel) => Promise.resolve(options.inHead?.includes(rel) ?? false),
    inIndex: (_root, rel) =>
      Promise.resolve(options.inIndex !== undefined && rel in options.inIndex ? options.inIndex[rel] : false),
    restoreFromHead: (_root, rel) => {
      calls.push(`restore:${rel}`);
      return Promise.resolve(options.restoreOk ?? true);
    },
    unstage: (_root, rel) => {
      calls.push(`unstage:${rel}`);
      return Promise.resolve(options.unstageOk ?? true);
    },
    remove: (_root, rel) => {
      calls.push(`remove:${rel}`);
      return Promise.resolve(options.removeOk ?? true);
    },
  };
}

void describe("scoping the edits of a round that never got its prompt (bugs3 Step 6)", () => {
  it("offers only paths that were clean before the round and keeps the rest apart", () => {
    const scope = scopeUndeliveredPromptEditsV1({
      cwd: "/repo",
      filesChanged: ["src/a.ts", "src/b.ts", "src/c.ts"],
      dirtyBefore: new Set(["src/b.ts"]),
    });
    assert.deepEqual(scope.revertable, ["src/a.ts", "src/c.ts"]);
    assert.deepEqual(scope.keptApart, ["src/b.ts"]);
  });

  it("rejects unsafe paths", () => {
    for (const bad of ["", "/etc/passwd", "../outside", "a/../../b", ".git/config", ".GIT/hooks/x", "C:\\x", "a\0b", "."]) {
      assert.equal(isSafeRevertPathV1(bad), false, JSON.stringify(bad));
    }
    assert.equal(isSafeRevertPathV1("src/utils/gitIndexLockV1.ts"), true);
    assert.equal(isSafeRevertPathV1("src\\win\\file.ts"), true);
  });

  it("the notice says which files the offer covers and which were already modified", () => {
    const text = describeUndeliveredPromptEditsV1({
      providerLabel: "Cline CLI",
      filesChanged: ["src/a.ts", "src/b.ts"],
      filesChangedUnknown: false,
      scope: { revertable: ["src/a.ts"], keptApart: ["src/b.ts"] },
    });
    assert.match(text ?? "", /The 1 file\(s\) that were unmodified before the round can be reverted from the choice below/);
    assert.match(text ?? "", /1 of them \(src\/b\.ts\) were already modified before the round/);
    assert.doesNotMatch(text ?? "", /git restore/);
  });

  it("the notice says nothing can be offered when every file was already modified", () => {
    const text = describeUndeliveredPromptEditsV1({
      providerLabel: "Cline CLI",
      filesChanged: ["src/b.ts"],
      filesChangedUnknown: false,
      scope: { revertable: [], keptApart: ["src/b.ts"] },
    });
    assert.match(text ?? "", /None of them can be offered for revert here/);
  });
});

void describe("reverting the offered edits (bugs3 Step 6)", () => {
  it("restores a path HEAD knows and removes one it does not", async () => {
    const io = fakeIo({ fingerprints: { "a.ts": "f1", "new.ts": "f2" }, inHead: ["a.ts"] });
    const outcome = await revertUndeliveredPromptEditsV1(
      "/repo",
      [
        { path: "a.ts", fingerprint: "f1" },
        { path: "new.ts", fingerprint: "f2" },
      ],
      io
    );
    assert.deepEqual(outcome.restored, ["a.ts"]);
    assert.deepEqual(outcome.deleted, ["new.ts"]);
    assert.deepEqual(io.calls, ["restore:a.ts", "remove:new.ts"]);
  });

  it("leaves a path alone when its content changed after the offer", async () => {
    const io = fakeIo({ fingerprints: { "a.ts": "edited-by-owner" }, inHead: ["a.ts"] });
    const outcome = await revertUndeliveredPromptEditsV1("/repo", [{ path: "a.ts", fingerprint: "f1" }], io);
    assert.deepEqual(outcome.changedSince, ["a.ts"]);
    assert.deepEqual(io.calls, []);
    assert.match(describeUndeliveredRevertOutcomeV1(outcome), /Nothing was reverted\. Left alone because they changed after the offer/);
  });

  it("leaves a path alone when the owner staged different content after the offer", async () => {
    const io = fakeIo({ fingerprints: { "a.ts": "f1" }, inHead: ["a.ts"], indexStates: { "a.ts": "100644 newblob 0\ta.ts" } });
    const outcome = await revertUndeliveredPromptEditsV1(
      "/repo",
      [{ path: "a.ts", fingerprint: "f1", indexState: "absent" }],
      io
    );
    assert.deepEqual(outcome.changedSince, ["a.ts"]);
    assert.deepEqual(io.calls, [], "the staged work is not restored away");
  });

  it("reverts when the index entry is exactly as offered", async () => {
    const staged = "100644 blob 0\tnew.ts";
    const io = fakeIo({ fingerprints: { "new.ts": "f2" }, inIndex: { "new.ts": true }, indexStates: { "new.ts": staged } });
    const outcome = await revertUndeliveredPromptEditsV1("/repo", [{ path: "new.ts", fingerprint: "f2", indexState: staged }], io);
    assert.deepEqual(outcome.deleted, ["new.ts"]);
    assert.deepEqual(io.calls, ["unstage:new.ts", "remove:new.ts"]);
  });

  it("an offer without a recorded index entry is judged against HEAD, and unreadable state is not assumed clean", async () => {
    const stagedLegacy = fakeIo({ fingerprints: { "a.ts": "f1" }, inHead: ["a.ts"], stagedDiffersFromHead: ["a.ts"] });
    const first = await revertUndeliveredPromptEditsV1("/repo", [{ path: "a.ts", fingerprint: "f1" }], stagedLegacy);
    assert.deepEqual(first.changedSince, ["a.ts"]);
    assert.deepEqual(stagedLegacy.calls, []);

    const unreadable = fakeIo({ fingerprints: { "a.ts": "f1" }, inHead: ["a.ts"] });
    unreadable.indexDiffersFromHead = () => Promise.resolve(undefined);
    const second = await revertUndeliveredPromptEditsV1("/repo", [{ path: "a.ts", fingerprint: "f1" }], unreadable);
    assert.deepEqual(second.changedSince, ["a.ts"]);
    assert.deepEqual(unreadable.calls, []);
  });

  it("never deletes after a git failure", async () => {
    const restoreFails = fakeIo({ fingerprints: { "a.ts": "f1" }, inHead: ["a.ts"], restoreOk: false });
    const first = await revertUndeliveredPromptEditsV1("/repo", [{ path: "a.ts", fingerprint: "f1" }], restoreFails);
    assert.deepEqual(first.failed, ["a.ts"]);
    assert.deepEqual(restoreFails.calls, ["restore:a.ts"]);

    const indexUnknown = fakeIo({ fingerprints: { "n.ts": "f" }, inIndex: { "n.ts": undefined } });
    const second = await revertUndeliveredPromptEditsV1("/repo", [{ path: "n.ts", fingerprint: "f" }], indexUnknown);
    assert.deepEqual(second.failed, ["n.ts"]);
    assert.deepEqual(indexUnknown.calls, []);

    const unstageFails = fakeIo({ fingerprints: { "n.ts": "f" }, inIndex: { "n.ts": true }, unstageOk: false });
    const third = await revertUndeliveredPromptEditsV1("/repo", [{ path: "n.ts", fingerprint: "f" }], unstageFails);
    assert.deepEqual(third.failed, ["n.ts"]);
    assert.deepEqual(unstageFails.calls, ["unstage:n.ts"]);
  });

  it("unstages a file the round staged before removing it", async () => {
    const io = fakeIo({ fingerprints: { "n.ts": "f" }, inIndex: { "n.ts": true } });
    const outcome = await revertUndeliveredPromptEditsV1("/repo", [{ path: "n.ts", fingerprint: "f" }], io);
    assert.deepEqual(outcome.deleted, ["n.ts"]);
    assert.deepEqual(io.calls, ["unstage:n.ts", "remove:n.ts"]);
  });

  it("refuses unsafe paths and does nothing when git cannot name the repository", async () => {
    const io = fakeIo({ fingerprints: { "../x": "f" } });
    const unsafe = await revertUndeliveredPromptEditsV1("/repo", [{ path: "../x", fingerprint: "f" }], io);
    assert.deepEqual(unsafe.failed, ["../x"]);
    assert.deepEqual(io.calls, []);

    const noRoot = fakeIo({ root: undefined });
    const none = await revertUndeliveredPromptEditsV1("/repo", [{ path: "a.ts", fingerprint: "f" }], noRoot);
    assert.deepEqual(none.failed, ["a.ts"]);
    assert.deepEqual(noRoot.calls, []);
  });

  it("the command refuses malformed arguments and a revert that changed nothing", async () => {
    const bad = await revertUndeliveredPromptEditsConfirmedV1({ cwd: 3 });
    assert.equal(bad.outcome, "refused");
    const empty = await revertUndeliveredPromptEditsConfirmedV1({ cwd: os.tmpdir(), targets: [] });
    assert.equal(empty.outcome, "refused");
  });
});

void describe("reverting in a real repository (bugs3 Step 6)", () => {
  function git(cwd: string, ...args: string[]): void {
    cp.execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  }

  it("restores a tracked file, removes a created one, and spares a file the owner changed later", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ens-undelivered-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(dir, "init", "-q");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
    fs.writeFileSync(path.join(dir, "later.txt"), "original\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");

    // What the round did.
    fs.writeFileSync(path.join(dir, "tracked.txt"), "model edit\n");
    fs.writeFileSync(path.join(dir, "later.txt"), "model edit\n");
    fs.mkdirSync(path.join(dir, "made"));
    fs.writeFileSync(path.join(dir, "made", "new.txt"), "created\n");
    git(dir, "add", "made/new.txt");

    const targets = await fingerprintRevertTargetsV1(dir, ["tracked.txt", "later.txt", "made/new.txt", "../escape.txt"]);
    assert.deepEqual(
      targets.map((target) => target.path),
      ["tracked.txt", "later.txt", "made/new.txt"]
    );

    // The owner edits one of them after the offer.
    fs.writeFileSync(path.join(dir, "later.txt"), "owner edit\n");

    const outcome = await revertUndeliveredPromptEditsV1(dir, targets);
    assert.deepEqual(outcome.restored, ["tracked.txt"]);
    assert.deepEqual(outcome.deleted, ["made/new.txt"]);
    assert.deepEqual(outcome.changedSince, ["later.txt"]);
    assert.deepEqual(outcome.failed, []);
    assert.equal(fs.readFileSync(path.join(dir, "tracked.txt"), "utf8"), "original\n");
    assert.equal(fs.readFileSync(path.join(dir, "later.txt"), "utf8"), "owner edit\n");
    assert.equal(fs.existsSync(path.join(dir, "made", "new.txt")), false);
    const status = cp.execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
    assert.doesNotMatch(status, /new\.txt/);
  });
});

void describe("baseline-bound revert and the durable offer record (bugs3 Step 6)", () => {
  function git(cwd: string, ...args: string[]): string {
    return cp
      .execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      })
      .toString();
  }

  function repo(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ens-undelivered-rec-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(dir, "init", "-q");
    fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  }

  function scratchFolder(t: TestContext, label: string): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), `ens-undelivered-${label}-`));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    return folder;
  }

  it("refuses the whole revert once HEAD has moved since the offer", async (t) => {
    const dir = repo(t);
    fs.writeFileSync(path.join(dir, "a.txt"), "model edit\n");
    const targets = await fingerprintRevertTargetsV1(dir, ["a.txt"]);
    const baseline = await captureRevertBaselineHeadV1(dir);
    assert.match(baseline ?? "", /^[0-9a-f]{40}$/);
    git(dir, "commit", "-q", "-am", "owner commit");
    const outcome = await revertUndeliveredPromptEditsV1(dir, targets, undefined, baseline);
    assert.equal(outcome.baselineMoved, true);
    assert.deepEqual(outcome.restored, []);
    assert.deepEqual(outcome.changedSince, ["a.txt"]);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "model edit\n");
    assert.match(describeUndeliveredRevertOutcomeV1(outcome), /HEAD moved/);
  });

  it("reverts as before while HEAD still matches the baseline", async (t) => {
    const dir = repo(t);
    fs.writeFileSync(path.join(dir, "a.txt"), "model edit\n");
    const targets = await fingerprintRevertTargetsV1(dir, ["a.txt"]);
    const baseline = await captureRevertBaselineHeadV1(dir);
    const outcome = await revertUndeliveredPromptEditsV1(dir, targets, undefined, baseline);
    assert.deepEqual(outcome.restored, ["a.txt"]);
    assert.equal(outcome.baselineMoved, undefined);
  });

  it("keeps one open record, supersedes an older one and settles by id", (t) => {
    const folder = scratchFolder(t, "folder");
    assert.equal(findOpenUndeliveredPromptEditsRecordV1(folder), undefined);
    const base = {
      providerLabel: "Cline CLI",
      cwd: folder,
      revertable: [{ path: "a.txt", fingerprint: "sha256:1" }],
      keptApart: ["b.txt"],
    };
    const first = recordUndeliveredPromptEditsV1(folder, { ...base, at: "2026-10-30T10:00:00.000Z" });
    const second = recordUndeliveredPromptEditsV1(folder, { ...base, at: "2026-10-30T11:00:00.000Z" });
    assert.notEqual(first.id, second.id);
    assert.equal(findOpenUndeliveredPromptEditsRecordV1(folder)?.id, second.id);
    assert.deepEqual(
      readUndeliveredPromptEditsRecordsV1(folder).map((entry) => entry.status),
      ["superseded", "open"]
    );
    assert.equal(settleUndeliveredPromptEditsRecordV1(folder, first.id, "kept"), false);
    assert.equal(settleUndeliveredPromptEditsRecordV1(folder, second.id, "reverted"), true);
    assert.equal(settleUndeliveredPromptEditsRecordV1(folder, second.id, "kept"), false);
    assert.equal(findOpenUndeliveredPromptEditsRecordV1(folder), undefined);
  });

  it("reads a damaged record file as no record", (t) => {
    const folder = scratchFolder(t, "bad");
    const file = path.join(folder, UNDELIVERED_PROMPT_EDITS_RECORD_FILE_V1);
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readUndeliveredPromptEditsRecordsV1(folder), []);
    fs.writeFileSync(file, JSON.stringify({ version: 1, records: [{ id: 1 }, null] }));
    assert.deepEqual(readUndeliveredPromptEditsRecordsV1(folder), []);
  });

  it("the command reverts once, settles the record, and refuses a second answer", async (t) => {
    const dir = repo(t);
    const folder = scratchFolder(t, "task");
    fs.writeFileSync(path.join(dir, "a.txt"), "model edit\n");
    const targets = await fingerprintRevertTargetsV1(dir, ["a.txt"]);
    const baselineHead = await captureRevertBaselineHeadV1(dir);
    const record = recordUndeliveredPromptEditsV1(folder, {
      at: "2026-10-30T10:00:00.000Z",
      providerLabel: "Cline CLI",
      cwd: dir,
      ...(baselineHead !== undefined ? { baselineHead } : {}),
      revertable: targets,
      keptApart: [],
    });
    const args = { cwd: dir, targets, action: "revert", taskFolderPath: folder, recordId: record.id, baselineHead };
    const first = await revertUndeliveredPromptEditsConfirmedV1(args);
    assert.equal(first.outcome, "done");
    assert.equal(readUndeliveredPromptEditsRecordsV1(folder)[0]?.status, "reverted");
    const second = await revertUndeliveredPromptEditsConfirmedV1(args);
    assert.equal(second.outcome, "refused");
    assert.match(second.message ?? "", /already answered/);
  });

  it("keep settles the record without touching a file", async (t) => {
    const dir = repo(t);
    const folder = scratchFolder(t, "keep");
    fs.writeFileSync(path.join(dir, "a.txt"), "model edit\n");
    const targets = await fingerprintRevertTargetsV1(dir, ["a.txt"]);
    const record = recordUndeliveredPromptEditsV1(folder, {
      at: "2026-10-30T10:00:00.000Z",
      providerLabel: "Cline CLI",
      cwd: dir,
      revertable: targets,
      keptApart: [],
    });
    const result = await revertUndeliveredPromptEditsConfirmedV1({
      cwd: dir,
      targets,
      action: "keep",
      taskFolderPath: folder,
      recordId: record.id,
    });
    assert.equal(result.outcome, "done");
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "model edit\n");
    assert.equal(readUndeliveredPromptEditsRecordsV1(folder)[0]?.status, "kept");
  });
});

void describe("a delivery failure with nothing to offer is still recorded (bugs3 Step 6)", () => {
  function scratch(t: TestContext, label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ens-undelivered-${label}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("records edits that were all pre-existing work as a settled record, and posts no card", async (t) => {
    const dir = scratch(t, "cwd");
    const folder = scratch(t, "preexisting");
    const posted = await offerUndeliveredPromptEditsRevertInChatV1(
      { canonicalId: folder, taskFolderPath: folder, stage: "impl" } as never,
      "Cline CLI",
      { cwd: dir, revertable: [], keptApart: ["a.txt"] }
    );
    assert.equal(posted, false, "nothing is revertable, so no card is posted");
    const records = readUndeliveredPromptEditsRecordsV1(folder);
    assert.equal(records.length, 1, "the delivery failure is still kept apart from ordinary quarantined edits");
    assert.equal(records[0]?.status, "kept");
    assert.deepEqual(records[0]?.keptApart, ["a.txt"]);
    assert.deepEqual(records[0]?.revertable, []);
    assert.equal(findOpenUndeliveredPromptEditsRecordV1(folder), undefined, "no open offer is left behind");
  });

  it("uses the targets and baseline the runner read at the round boundary instead of reading again", async (t) => {
    const dir = scratch(t, "cwd3");
    const folder = scratch(t, "boundary");
    // The scope carries its own fingerprints and baseline; a card is posted without
    // consulting the (non-git) working folder for either.
    await offerUndeliveredPromptEditsRevertInChatV1(
      { canonicalId: folder, taskFolderPath: folder, stage: "impl" } as never,
      "Cline CLI",
      {
        cwd: dir,
        revertable: ["a.txt"],
        keptApart: [],
        baselineHead: "round-start-head",
        targets: [{ path: "a.txt", fingerprint: "sha256:round-end", indexState: "absent" }],
      }
    );
    const record = findOpenUndeliveredPromptEditsRecordV1(folder);
    assert.equal(record?.baselineHead, "round-start-head");
    assert.deepEqual(record?.revertable, [{ path: "a.txt", fingerprint: "sha256:round-end", indexState: "absent" }]);
  });

  it("writes nothing when the round changed nothing", async (t) => {
    const dir = scratch(t, "cwd2");
    const folder = scratch(t, "nochange");
    await offerUndeliveredPromptEditsRevertInChatV1(
      { canonicalId: folder, taskFolderPath: folder, stage: "impl" } as never,
      "Cline CLI",
      { cwd: dir, revertable: [], keptApart: [] }
    );
    assert.equal(readUndeliveredPromptEditsRecordsV1(folder).length, 0);
  });
});
