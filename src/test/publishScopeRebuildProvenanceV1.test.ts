/**
 * RC3 item 10 (Step 6), 2026-09-30 review completion blocker: a refused
 * Publish scope rebuild must retain and log WHY each source was skipped (the
 * ledger's own reason plus the specific baseline failure), not collapse them
 * into the single fixed notification sentence. Exercises the real exported
 * `rebuildPublishImplReviewFilesV1` / `describePublishScopeRebuildForLogV1`
 * against a real git repo — no VS Code extension host needed beyond the
 * `workspace.fs.readFile` override for the baseline sidecar.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  describePublishScopeRebuildForLogV1,
  PUBLISH_SCOPE_REFUSAL_REASON_V1,
  rebuildPublishImplReviewFilesV1,
} from "../commands/reviewActions";
import type { ImplReviewLedgerRowV1 } from "../utils/implReviewFileSelection";
import { MAX_ROUND_LEDGER_ENTRIES } from "../types/taskProgress";

const { workspace } = vscode;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
}

const tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const IMPL_ROW: ImplReviewLedgerRowV1 = {
  roundId: "round-live",
  mode: "implementation",
  state: "open",
  // Deliberately no `outcome` — a live row never carries one, which is
  // exactly the case that makes the ledger unavailable here (see
  // `resolveLedgerImplReviewFilesV1`'s doc comment).
};

void describe("rebuildPublishImplReviewFilesV1 refusal provenance", () => {
  let originalReadFile: typeof workspace.fs.readFile;

  before(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- saved for restoration only, never called unbound
    originalReadFile = workspace.fs.readFile;
  });

  afterEach(() => {
    workspace.fs.readFile = originalReadFile;
  });

  function stubBaselineSidecar(content: string | undefined): void {
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      if (uri.fsPath.endsWith(".impl-baseline-commit") && content !== undefined) {
        return Promise.resolve(new TextEncoder().encode(content));
      }
      return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
    };
  }

  void it("names the ledger's own reason plus a missing sidecar, never the fixed notification text, in skipReasons", async () => {
    stubBaselineSidecar(undefined);
    const workspaceRoot = mkTmp("ensemble-publish-scope-nosidecar-");
    initRepo(workspaceRoot);
    const folderUri = vscode.Uri.file(mkTmp("ensemble-publish-scope-task-"));

    const result = await rebuildPublishImplReviewFilesV1(folderUri, vscode.Uri.file(workspaceRoot), [IMPL_ROW]);
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.equal(result.reason, PUBLISH_SCOPE_REFUSAL_REASON_V1);
    assert.equal(result.skipReasons.length, 2);
    assert.match(result.skipReasons[0]!, /ledger skipped: round round-live \(implementation\) is still open/);
    assert.match(result.skipReasons[1]!, /baseline skipped: sidecar missing/);

    const log = describePublishScopeRebuildForLogV1(result);
    assert.match(log, /Refused: Publish review was not run/);
    assert.match(log, /Skipped sources:/);
    assert.match(log, /ledger skipped: round round-live/);
    assert.match(log, /baseline skipped: sidecar missing/);
  });

  void it("names the ledger's own reason plus 'not a git repository' when the workspace has no repo", async () => {
    const baselineSha = "a".repeat(40);
    stubBaselineSidecar(baselineSha);
    const workspaceRoot = mkTmp("ensemble-publish-scope-norepo-"); // no `git init`
    const folderUri = vscode.Uri.file(mkTmp("ensemble-publish-scope-task-"));

    const result = await rebuildPublishImplReviewFilesV1(folderUri, vscode.Uri.file(workspaceRoot), []);
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.equal(result.reason, PUBLISH_SCOPE_REFUSAL_REASON_V1);
    assert.equal(result.skipReasons.length, 2);
    assert.match(result.skipReasons[0]!, /ledger skipped: no implementation-mode rounds recorded/);
    assert.match(result.skipReasons[1]!, /baseline skipped: this workspace is not inside a git repository/);
  });

  void it("names the ledger's own reason plus the git failure when the baseline SHA does not resolve", async () => {
    const badSha = "b".repeat(40); // well-formed but never committed
    stubBaselineSidecar(badSha);
    const workspaceRoot = mkTmp("ensemble-publish-scope-badsha-");
    initRepo(workspaceRoot);
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "a\n");
    git(workspaceRoot, "add", "a.ts");
    git(workspaceRoot, "commit", "-q", "-m", "initial");
    const folderUri = vscode.Uri.file(mkTmp("ensemble-publish-scope-task-"));

    const result = await rebuildPublishImplReviewFilesV1(folderUri, vscode.Uri.file(workspaceRoot), []);
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.equal(result.reason, PUBLISH_SCOPE_REFUSAL_REASON_V1);
    assert.equal(result.skipReasons.length, 2);
    assert.match(result.skipReasons[1]!, new RegExp(`baseline skipped: git diff against ${badSha} failed`));
  });

  void it("an established ledger result never needs baseline provenance, and the log carries no skip section", async () => {
    const settledRow: ImplReviewLedgerRowV1 = {
      roundId: "round-done",
      mode: "implementation",
      state: "completed",
      outcome: { filesChanged: ["src/a.ts"] },
    };
    const workspaceRoot = mkTmp("ensemble-publish-scope-ledgerok-");
    const folderUri = vscode.Uri.file(mkTmp("ensemble-publish-scope-task-"));

    const result = await rebuildPublishImplReviewFilesV1(folderUri, vscode.Uri.file(workspaceRoot), [settledRow]);
    assert.equal(result.kind, "established");
    if (result.kind !== "established") return;
    assert.equal(result.source, "ledger");
    assert.deepEqual(result.files, ["src/a.ts"]);

    const log = describePublishScopeRebuildForLogV1(result);
    assert.match(log, /Source: round ledger\. 1 file\(s\)\./);
    assert.ok(!log.includes("Skipped sources"));
  });

  void it("an established baseline result's note still carries the ledger's own skip reason", async () => {
    const workspaceRoot = mkTmp("ensemble-publish-scope-baselineok-");
    initRepo(workspaceRoot);
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "a\n");
    git(workspaceRoot, "add", "a.ts");
    git(workspaceRoot, "commit", "-q", "-m", "baseline");
    const baselineSha = git(workspaceRoot, "rev-parse", "HEAD").trim();
    // A file changed by the first implementation round before any review
    // marker existed: a tracked file edited (and, as a round would, staged)
    // after the baseline commit, so it only shows up via `git diff --name-only
    // <baselineSha>`, never via the untracked/`git ls-files --others` half
    // that "b.ts" below exercises. The plan's baseline-rebuild acceptance
    // criterion asks for both a first-round file AND an untracked file in the
    // same rebuild (2026-09-30 review, Step 6 test-matrix gap: this test
    // previously checked only the untracked half).
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "a-edited-by-first-round\n");
    git(workspaceRoot, "add", "a.ts");
    fs.writeFileSync(path.join(workspaceRoot, "b.ts"), "b\n");
    stubBaselineSidecar(baselineSha);
    const folderUri = vscode.Uri.file(mkTmp("ensemble-publish-scope-task-"));

    const result = await rebuildPublishImplReviewFilesV1(folderUri, vscode.Uri.file(workspaceRoot), []);
    assert.equal(result.kind, "established");
    if (result.kind !== "established") return;
    assert.equal(result.source, "baseline");
    assert.ok(result.note?.includes("no implementation-mode rounds recorded"));
    // "a.ts" is a tracked file changed (and staged) since the baseline commit
    // — the first-round-file half, visible only through `git diff --name-only`.
    // "b.ts" was never `git add`ed — an untracked file, only visible through
    // `listChangedFilesSinceShaV1`'s `git ls-files --others --exclude-standard`
    // call. Asserting both here (not just at the lower
    // `listChangedFilesSinceShaV1` unit-test level) proves both paths survive
    // all the way through the actual `rebuildPublishImplReviewFilesV1` caller
    // the Publish dispatch uses (2026-09-30 review, Step 6 test-matrix gap).
    assert.deepEqual(result.files, ["a.ts", "b.ts"]);

    const log = describePublishScopeRebuildForLogV1(result);
    assert.match(log, /Source: task-start baseline diff\./);
    assert.match(log, /Notes: ledger skipped: no implementation-mode rounds recorded/);
  });

  void it("a ledger at the retention cap is never trusted and falls through to the baseline diff, with the cap reason logged (plan Step 6: 'a ledger at MAX_ROUND_LEDGER_ENTRIES with its first implementation round evicted falls through to the baseline diff and the round log says why')", async () => {
    const workspaceRoot = mkTmp("ensemble-publish-scope-cap-");
    initRepo(workspaceRoot);
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "a\n");
    git(workspaceRoot, "add", "a.ts");
    git(workspaceRoot, "commit", "-q", "-m", "baseline");
    const baselineSha = git(workspaceRoot, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(workspaceRoot, "b.ts"), "b\n");
    stubBaselineSidecar(baselineSha);
    const folderUri = vscode.Uri.file(mkTmp("ensemble-publish-scope-task-"));

    // A ledger at the cap is untrusted regardless of content
    // (resolveLedgerImplReviewFilesV1's "never trusted, whatever it
    // contains" rule): the round ledger evicts its oldest terminal rows once
    // MAX_ROUND_LEDGER_ENTRIES is reached with no truncation record, so a
    // ledger this long can never prove its first implementation round (the
    // one most likely evicted) was not missed.
    const paddedLedger: ImplReviewLedgerRowV1[] = Array.from({ length: MAX_ROUND_LEDGER_ENTRIES }, (_, i) => ({
      roundId: `pad-${i}`,
      mode: "implementation",
      state: "completed",
      outcome: { filesChanged: [] },
    }));

    const result = await rebuildPublishImplReviewFilesV1(folderUri, vscode.Uri.file(workspaceRoot), paddedLedger);
    assert.equal(result.kind, "established");
    if (result.kind !== "established") return;
    assert.equal(result.source, "baseline", "a capped ledger must never be treated as established — the baseline diff must be used instead");
    assert.ok(result.note?.includes("retention cap"), `expected the cap reason in the note, got: ${result.note}`);

    const log = describePublishScopeRebuildForLogV1(result);
    assert.match(log, /Source: task-start baseline diff\./);
    assert.match(log, /Notes: .*retention cap/);
  });
});
