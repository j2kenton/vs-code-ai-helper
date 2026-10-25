import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { appendOwnerEvidenceThenV1, appendOwnerEvidenceV1 } from "../utils/ownerEvidenceV1";

const folders: string[] = [];
async function fixture(contents: string): Promise<string> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-owner-evidence-"));
  folders.push(folder);
  await fs.writeFile(path.join(folder, "task.md"), contents);
  return folder;
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

void describe("appendOwnerEvidenceV1", () => {
  void it("adds a dated blocker quote and preserves large multiline output under an existing heading", async () => {
    const folder = await fixture("# Task\n\n## Owner evidence\n\nPrior note\n\n## Draft with AI\n\nDraft");
    const answer = `line one\n${"output ".repeat(12000)}\nline three`;
    await appendOwnerEvidenceV1(folder, "Owner evidence needed: run the check", answer, "2026-10-22");
    const result = await fs.readFile(path.join(folder, "task.md"), "utf8");
    assert.match(result, /## Owner evidence\n\n### 2026-10-22\n\nBlocker answered:\n> Owner evidence needed: run the check/);
    assert.ok(result.indexOf("Prior note") > result.indexOf("### 2026-10-22"));
    assert.ok(result.includes("\n```\n" + answer + "\n```"));
    assert.ok(result.indexOf("### 2026-10-22") < result.indexOf("## Draft with AI"));
  });

  void it("creates the heading before Draft with AI when absent and chooses a safe fence", async () => {
    const folder = await fixture("# Task\n\n## Draft with AI\n\nDraft");
    const answer = "first\n```\nsecond";
    await appendOwnerEvidenceV1(folder, "Owner evidence needed: inspect", answer, "2026-10-22");
    const result = await fs.readFile(path.join(folder, "task.md"), "utf8");
    assert.ok(result.indexOf("## Owner evidence") < result.indexOf("## Draft with AI"));
    assert.ok(result.includes("\n````\n" + answer + "\n````"));
  });

  void it("writes once before dispatching one review", async () => {
    const folder = await fixture("# Task\n\n## Draft with AI\n\nDraft");
    const order: string[] = [];
    await appendOwnerEvidenceThenV1(
      folder,
      "Owner evidence needed: inspect",
      "found it",
      async () => {
        order.push("review");
        const task = await fs.readFile(path.join(folder, "task.md"), "utf8");
        assert.match(task, /> Owner evidence needed: inspect/);
        assert.match(task, /found it/);
      },
      "2026-10-22"
    );
    order.push("done");
    assert.deepEqual(order, ["review", "done"]);
  });
});
