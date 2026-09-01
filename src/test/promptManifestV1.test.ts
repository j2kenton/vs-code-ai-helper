import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, test } from "node:test";
import * as vscode from "vscode";
import { createHash } from "crypto";
import {
  buildPromptManifestV1,
  measureCanonicalActionInputBytesV1,
  measureCanonicalInputBytesV1,
  type OversizedInputAbortRecordV1,
  sizeBandV1,
  writeOversizedInputAbortRecordV1,
  writePromptManifestV1,
} from "../utils/promptManifestV1";
import { canonicalJsonByteLengthV1 } from "../types/structuredQuestionV1";

// ---------------------------------------------------------------------------
// buildPromptManifestV1 (item 17a/18 — Part 2 step 7)
// ---------------------------------------------------------------------------

const ROUND_ID = "0123456789abcdef0123456789abcdef";

void test("records templateName, per-variable byte size and sha256, and total prompt bytes", () => {
  const variables = { contextPack: "hello", plan: "world" };
  const prompt = "hello\n\nworld";
  const manifest = buildPromptManifestV1("run-implementation.md", variables, prompt, true, ROUND_ID);

  assert.equal(manifest.templateName, "run-implementation.md");
  assert.equal(manifest.totalPromptBytes, Buffer.byteLength(prompt, "utf8"));
  assert.equal(manifest.variables.length, 2);

  const contextPackEntry = manifest.variables.find((v) => v.name === "contextPack");
  assert.ok(contextPackEntry);
  assert.equal(contextPackEntry.bytes, Buffer.byteLength("hello", "utf8"));
  assert.equal(
    contextPackEntry.sha256,
    createHash("sha256").update("hello", "utf8").digest("hex")
  );

  const planEntry = manifest.variables.find((v) => v.name === "plan");
  assert.ok(planEntry);
  assert.equal(planEntry.bytes, Buffer.byteLength("world", "utf8"));
});

// ---------------------------------------------------------------------------
// measureCanonicalInputBytesV1 / sizeBandV1 (item 9 — Part 16 steps 41/44)
// ---------------------------------------------------------------------------

void test("measureCanonicalInputBytesV1 matches the same encoder totalCanonicalBytes uses", () => {
  const templateName = "review-impl-high.md";
  const prompt = "some assembled prompt text";
  assert.equal(
    measureCanonicalInputBytesV1(templateName, prompt),
    canonicalJsonByteLengthV1({ templateName, prompt })
  );
});

void test("measureCanonicalInputBytesV1 grows with the prompt's own length", () => {
  const short = measureCanonicalInputBytesV1("t.md", "x");
  const long = measureCanonicalInputBytesV1("t.md", "x".repeat(10_000));
  assert.ok(long > short);
});

// ---------------------------------------------------------------------------
// measureCanonicalActionInputBytesV1 (item 9 — Part 16 step 41, 2026-08-29
// review, completion blocker: "measures a synthetic prompt object rather
// than the actual validated transaction input")
// ---------------------------------------------------------------------------

void test("measureCanonicalActionInputBytesV1 matches canonicalJsonByteLengthV1 of the exact object given", () => {
  const actionInput = {
    prompt: "some assembled prompt text",
    targetLocator: { rootId: "root-1", relativePath: "impl-high-review.md" },
    baselineRevision: "rev-abc",
  };
  assert.equal(
    measureCanonicalActionInputBytesV1(actionInput),
    canonicalJsonByteLengthV1(actionInput)
  );
});

void test("measureCanonicalActionInputBytesV1 differs from wrapping in { templateName, prompt } — the defect this closes", () => {
  const prompt = "x".repeat(1000);
  const realShape = {
    prompt,
    targetLocator: { rootId: "root-1", relativePath: "impl-high-review.md" },
    publishFreshnessGuard: {
      taskFolderPath: "/tasks/t1",
      scopeFolderPath: "/tasks/t1",
      runId: "run-1",
      verifiedCommitSha: "deadbeef",
    },
  };
  const realBytes = measureCanonicalActionInputBytesV1(realShape);
  const syntheticBytes = measureCanonicalInputBytesV1("review-impl-high.md", prompt);
  // The real dispatched object carries targetLocator/publishFreshnessGuard
  // overhead the synthetic { templateName, prompt } wrapper has no way to
  // see — a probe measured the old way would silently under-report the size
  // the transaction store actually checks.
  assert.ok(realBytes > syntheticBytes);
});

void test("sizeBandV1 classifies below-25% as band 0", () => {
  assert.equal(sizeBandV1(0, 1000), 0);
  assert.equal(sizeBandV1(249, 1000), 0);
});

void test("sizeBandV1 classifies each quarter boundary", () => {
  assert.equal(sizeBandV1(250, 1000), 1);
  assert.equal(sizeBandV1(499, 1000), 1);
  assert.equal(sizeBandV1(500, 1000), 2);
  assert.equal(sizeBandV1(749, 1000), 2);
  assert.equal(sizeBandV1(750, 1000), 3);
  assert.equal(sizeBandV1(999, 1000), 3);
});

void test("sizeBandV1 classifies at-or-over the limit as band 4", () => {
  assert.equal(sizeBandV1(1000, 1000), 4);
  assert.equal(sizeBandV1(5000, 1000), 4);
});

void test("records the caller-allocated roundId verbatim", () => {
  const manifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
  assert.equal(manifest.roundId, ROUND_ID);
});

// Review fix, 2026-08-27 (Step 7, "coordinator-attempt identity"): the
// manifest must carry the coordinator's own per-attempt id when the caller
// has one, distinct from the round-grouping `roundId`.
void test("records the coordinator attemptId verbatim when supplied, alongside roundId", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "x" },
    "x",
    true,
    ROUND_ID,
    "attempt-abc123"
  );
  assert.equal(manifest.roundId, ROUND_ID);
  assert.equal(manifest.attemptId, "attempt-abc123");
});

void test("omits attemptId entirely when the caller supplies none (no coordinator attempt exists for this dispatch)", () => {
  const manifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
  assert.equal(manifest.attemptId, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(manifest, "attemptId"));
});

void test("totalCanonicalBytes matches canonicalJsonByteLengthV1 over templateName + the captured/dispatched prompt, and differs from totalPromptBytes", () => {
  const variables = { contextPack: "hello", plan: "world" };
  const prompt = "hello\n\nworld";
  const manifest = buildPromptManifestV1("run-implementation.md", variables, prompt, true, ROUND_ID);

  // Review blocker, 2026-08-26: this must measure the retained/dispatched
  // prompt text (what a reader can actually re-open via "Open Retained
  // Prompt"), not the pre-coordinator template variables — a Copilot-sealed
  // round's real dispatched text includes coordinator preamble/suffix
  // wrapping the variables never see.
  assert.equal(
    manifest.totalCanonicalBytes,
    canonicalJsonByteLengthV1({ templateName: "run-implementation.md", prompt })
  );
  // The canonical encoding adds JSON structural overhead (quotes, braces,
  // key names) on top of the raw dispatched-prompt bytes, so the two figures
  // are not expected to coincide — this manifest deliberately reports both.
  assert.notEqual(manifest.totalCanonicalBytes, manifest.totalPromptBytes);
});

void test("totalCanonicalBytes reflects the captured attempt input even when it differs from the template variables (Copilot sealed wrapping)", () => {
  // Simulates a Copilot-resolved round: the coordinator's captured prompt
  // (dispatchedPrompt) is longer than the raw template variables because it
  // includes the preamble/result-contract wrapping — see
  // `PromptManifestV1.promptCaptureComplete`'s doc comment.
  const variables = { plan: "short template variable text" };
  const dispatchedPrompt =
    "PREAMBLE\n\nshort template variable text\n\nRESULT CONTRACT SUFFIX";
  const manifest = buildPromptManifestV1(
    "apply-impl-review-code.md",
    variables,
    dispatchedPrompt,
    true,
    ROUND_ID
  );

  assert.equal(
    manifest.totalCanonicalBytes,
    canonicalJsonByteLengthV1({ templateName: "apply-impl-review-code.md", prompt: dispatchedPrompt })
  );
  assert.notEqual(
    manifest.totalCanonicalBytes,
    canonicalJsonByteLengthV1({ templateName: "apply-impl-review-code.md", variables })
  );
});

void test("multi-byte UTF-8 content is measured in bytes, not characters", () => {
  const text = "héllo wörld — 日本語";
  const manifest = buildPromptManifestV1("run-implementation.md", { plan: text }, text, true, ROUND_ID);
  const entry = manifest.variables.find((v) => v.name === "plan");
  assert.ok(entry);
  assert.equal(entry.bytes, Buffer.byteLength(text, "utf8"));
  assert.notEqual(entry.bytes, text.length);
});

void test("detects an '## Accepted Non-Goals' heading in any variable", () => {
  const manifest = buildPromptManifestV1(
    "apply-impl-review-code.md",
    { approvedPlan: "# Plan\n\nSome text", implementation: "## Accepted Non-Goals\n\nsome content" },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.acceptedNonGoals, true);
  assert.equal(manifest.planSections.humanVerificationHandoffs, false);
});

void test("detects a '## Human Verification Hand-offs' heading in any variable", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "## Human Verification Hand-offs\n\nsome content" },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.humanVerificationHandoffs, true);
  assert.equal(manifest.planSections.acceptedNonGoals, false);
});

void test("reports both plan sections false when neither heading is present", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "# Plan\n\nJust ordinary content, no special sections." },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.acceptedNonGoals, false);
  assert.equal(manifest.planSections.humanVerificationHandoffs, false);
});

void test("promptCaptureComplete records whether the retained text is what the provider actually received", () => {
  const cliManifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
  assert.equal(cliManifest.promptCaptureComplete, true);

  const copilotSealedManifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", false, ROUND_ID);
  assert.equal(copilotSealedManifest.promptCaptureComplete, false);
});

void test("a heading mentioned only in prose (not as a markdown heading) is not detected", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "This plan has no Accepted Non-Goals section and no Human Verification Hand-offs either." },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.acceptedNonGoals, false);
  assert.equal(manifest.planSections.humanVerificationHandoffs, false);
});

// ---------------------------------------------------------------------------
// writePromptManifestV1 — filename identity decoupled from the run log
// (review blocker, 2026-08-27, third pass: "keeping the last attempt
// unsuffixed" / "waits until after the run log is written"). Filenames are
// now derived purely from `manifest.roundId`/`manifest.attemptId`, never from
// a run log's basename — proven here against a real (temp-dir) directory,
// with no run log ever created.
// ---------------------------------------------------------------------------

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-prompt-manifest-"));

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  return {
    restore: (): void => {
      for (const key of ["writeFile", "createDirectory"]) {
        target[key] = orig[key];
      }
    },
  };
}

void describe("writePromptManifestV1 (Part 2 step 7 — filename identity)", () => {
  void it("names a single-attempt (no attemptId) manifest purely from roundId, with no run log involved", async () => {
    const bridge = installFsBridge();
    try {
      const runsDirUri = vscode.Uri.file(path.join(REAL_ROOT, "no_attempt_id"));
      const manifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
      const written = await writePromptManifestV1(runsDirUri, manifest, "x");
      assert.equal(path.basename(written.manifestUri.fsPath), `${ROUND_ID}.prompt-manifest.json`);
      assert.equal(path.basename(written.promptUri.fsPath), `${ROUND_ID}.prompt.txt`);
      assert.ok(fs.existsSync(written.manifestUri.fsPath));
      assert.ok(fs.existsSync(written.promptUri.fsPath));
    } finally {
      bridge.restore();
    }
  });

  void it("creates the runs/ directory when it does not already exist", async () => {
    const bridge = installFsBridge();
    try {
      const runsDirUri = vscode.Uri.file(path.join(REAL_ROOT, "fresh_task_never_had_a_run_log"));
      assert.ok(!fs.existsSync(runsDirUri.fsPath));
      const manifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
      await writePromptManifestV1(runsDirUri, manifest, "x");
      assert.ok(fs.existsSync(runsDirUri.fsPath));
    } finally {
      bridge.restore();
    }
  });

  void it("names EVERY captured attempt by its own attemptId — no unsuffixed 'last attempt' special case", async () => {
    const bridge = installFsBridge();
    try {
      const runsDirUri = vscode.Uri.file(path.join(REAL_ROOT, "multi_attempt"));
      const first = buildPromptManifestV1(
        "run-implementation.md",
        { plan: "primary" },
        "primary prompt",
        true,
        ROUND_ID,
        "attempt-primary"
      );
      const second = buildPromptManifestV1(
        "run-implementation.md",
        { plan: "secondary" },
        "secondary prompt",
        true,
        ROUND_ID,
        "attempt-secondary-LAST"
      );
      const writtenFirst = await writePromptManifestV1(runsDirUri, first, "primary prompt");
      const writtenLast = await writePromptManifestV1(runsDirUri, second, "secondary prompt");

      // The FIRST attempt is suffixed...
      assert.equal(
        path.basename(writtenFirst.promptUri.fsPath),
        `${ROUND_ID}.attempt-attempt-primary.prompt.txt`
      );
      // ...and so is the LAST attempt — no unsuffixed fallback filename for it.
      assert.equal(
        path.basename(writtenLast.promptUri.fsPath),
        `${ROUND_ID}.attempt-attempt-secondary-LAST.prompt.txt`
      );
      // Both files coexist on disk — the last attempt's write never
      // overwrote, and was never mistaken for, the first's.
      assert.ok(fs.existsSync(writtenFirst.promptUri.fsPath));
      assert.ok(fs.existsSync(writtenLast.promptUri.fsPath));
      assert.equal(
        fs.readFileSync(writtenFirst.promptUri.fsPath, "utf8"),
        "primary prompt"
      );
      assert.equal(
        fs.readFileSync(writtenLast.promptUri.fsPath, "utf8"),
        "secondary prompt"
      );
    } finally {
      bridge.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// writeOversizedInputAbortRecordV1 (item 9, Part 16 step 41 — 2026-08-29
// review, completion blocker: "... and persist exact drivers/dropped
// content"). A round that never dispatches has no `roundId` to key a prompt
// manifest to, so the exact driver breakdown shown in the transient error
// notification is persisted as a standalone record instead.
// ---------------------------------------------------------------------------

void describe("writeOversizedInputAbortRecordV1 (Part 16 step 41 — persisted abort diagnostics)", () => {
  void it("persists the driver breakdown to a file under the runs directory", async () => {
    const bridge = installFsBridge();
    try {
      const runsDirUri = vscode.Uri.file(path.join(REAL_ROOT, "oversized_abort_basic"));
      const uri = await writeOversizedInputAbortRecordV1(runsDirUri, {
        at: "2026-08-29T12:00:00.000Z",
        stage: "impl-high-review",
        path: "review",
        assembledCanonicalBytes: 300000,
        limitCanonicalBytes: 262144,
        driverBytes: { "task.md": 60900, "plan.md": 24500 },
        reductionApplied: { "context pack char budget": 2000 },
      });
      assert.ok(fs.existsSync(uri.fsPath));
      const persisted = JSON.parse(fs.readFileSync(uri.fsPath, "utf8")) as OversizedInputAbortRecordV1;
      assert.equal(persisted.stage, "impl-high-review");
      assert.equal(persisted.path, "review");
      assert.equal(persisted.assembledCanonicalBytes, 300000);
      assert.equal(persisted.limitCanonicalBytes, 262144);
      assert.deepEqual(persisted.driverBytes, { "task.md": 60900, "plan.md": 24500 });
      assert.deepEqual(persisted.reductionApplied, { "context pack char budget": 2000 });
    } finally {
      bridge.restore();
    }
  });

  void it("creates the runs/ directory when it does not already exist", async () => {
    const bridge = installFsBridge();
    try {
      const runsDirUri = vscode.Uri.file(path.join(REAL_ROOT, "oversized_abort_fresh_dir"));
      assert.ok(!fs.existsSync(runsDirUri.fsPath));
      await writeOversizedInputAbortRecordV1(runsDirUri, {
        at: "2026-08-29T12:00:00.000Z",
        stage: "impl",
        path: "apply-review",
        assembledCanonicalBytes: 400000,
        limitCanonicalBytes: 262144,
        driverBytes: { review: 200000 },
        reductionApplied: { "review char budget": 2000, "implementation notes char budget": 4000 },
      });
      assert.ok(fs.existsSync(runsDirUri.fsPath));
    } finally {
      bridge.restore();
    }
  });

  void it("names repeated aborts on the same task uniquely so they never overwrite each other", async () => {
    const bridge = installFsBridge();
    try {
      const runsDirUri = vscode.Uri.file(path.join(REAL_ROOT, "oversized_abort_repeated"));
      const first = await writeOversizedInputAbortRecordV1(runsDirUri, {
        at: "2026-08-29T12:00:00.000Z",
        stage: "impl-high-review",
        path: "review",
        assembledCanonicalBytes: 300000,
        limitCanonicalBytes: 262144,
        driverBytes: {},
        reductionApplied: {},
      });
      const second = await writeOversizedInputAbortRecordV1(runsDirUri, {
        at: "2026-08-29T12:05:00.000Z",
        stage: "impl-high-review",
        path: "review",
        assembledCanonicalBytes: 310000,
        limitCanonicalBytes: 262144,
        driverBytes: {},
        reductionApplied: {},
      });
      assert.notEqual(first.fsPath, second.fsPath);
      assert.ok(fs.existsSync(first.fsPath));
      assert.ok(fs.existsSync(second.fsPath));
    } finally {
      bridge.restore();
    }
  });
});
