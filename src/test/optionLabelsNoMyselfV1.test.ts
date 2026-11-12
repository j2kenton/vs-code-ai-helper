/**
 * bugs7 item 2: no option label reads as an instruction to the owner to do something by hand when clicking it does it.
 * A label with "myself" or "yourself" is only allowed where the click records nothing or opens something the owner
 * fills in (the owner really does the work).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

/** Labels whose click carries out nothing for the owner: it records nothing, or opens a form or file the owner uses. */
const ALLOWED_LABELS_V1: ReadonlySet<string> = new Set([
  "I'll look at it myself", // dispatches nothing; the owner looks at the failure
  "Fix it yourself first", // opens the plan file; the owner edits it
  "I'll paste it myself", // records nothing; the owner answers with what they find
  "I ran the tests myself", // opens the form where the owner says what they ran
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "test") out.push(...sourceFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

void describe("option labels do not tell the owner to do what a click does (bugs7 item 2)", () => {
  void it("every `label:` literal containing myself or yourself is on the allowlist", () => {
    const offenders: string[] = [];
    const found = new Set<string>();
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/\blabel:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\n]*)`)/g)) {
        const literal = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\'/g, "'").replace(/\\"/g, '"');
        if (!/\b(?:myself|yourself)\b/i.test(literal)) continue;
        found.add(literal);
        if (!ALLOWED_LABELS_V1.has(literal)) offenders.push(`${path.relative(SRC_ROOT, file)}: ${literal}`);
      }
    }
    assert.deepEqual(offenders, [], "a label that a click carries out must say what happens, not tell the owner to do it");
    // The allowlist stays honest: a label that no longer exists is removed from it.
    for (const allowed of ALLOWED_LABELS_V1) assert.ok(found.has(allowed), `allowlisted label no longer in source: ${allowed}`);
  });
});
