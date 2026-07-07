/**
 * Unit test: DISCLAIMER_VERSION in src/legal/disclaimerVersion.ts must
 * match the "Version: N" line in DISCLAIMER.md.
 *
 * This test is a plain Node test (no VS Code API) and runs in the unit suite.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";

void test("DISCLAIMER_VERSION matches Version line in DISCLAIMER.md", () => {
  // Resolve DISCLAIMER.md relative to the project root (two levels up from
  // src/test/ where this compiled test file's source lives).
  // At compile time, this file is at src/test/disclaimerVersion.test.ts;
  // at runtime (compiled), it is at out/test/disclaimerVersion.test.js.
  // We walk up to find the project root by looking for DISCLAIMER.md.
  let dir = __dirname;
  let disclaimerPath: string | undefined;
  for (let i = 0; i < 5; i++) {
    const candidate = nodePath.join(dir, "DISCLAIMER.md");
    if (nodeFs.existsSync(candidate)) {
      disclaimerPath = candidate;
      break;
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  assert.ok(disclaimerPath, "DISCLAIMER.md not found in project root (searched up to 5 levels from __dirname)");

  const content = nodeFs.readFileSync(disclaimerPath, "utf8");

  // Look for a line matching "**Version: N**" or "Version: N" (handles
  // both bold and plain formatting).
  const match = content.match(/^\*{0,2}Version:\s*(\d+)\*{0,2}\s*$/m);
  assert.ok(
    match,
    `DISCLAIMER.md does not contain a "Version: N" line. ` +
      `Expected a line like "**Version: 1**" or "Version: 1".`
  );

  const docVersion = parseInt(match[1]!, 10);
  assert.equal(
    DISCLAIMER_VERSION,
    docVersion,
    `DISCLAIMER_VERSION (${DISCLAIMER_VERSION}) does not match ` +
      `the version in DISCLAIMER.md (${docVersion}). ` +
      `Update one of them to keep them in sync.`
  );
});
