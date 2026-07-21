/**
 * Unit test: DISCLAIMER.md, SECURITY.md, and README.md hand-quote each CLI
 * provider's permission flags (e.g. "--permission-mode acceptEdits" for
 * edit mode, "--permission-mode plan" for text mode). Nothing previously
 * bound those quotes to providers.ts's actual buildArgs output, so a future
 * flag change could leave a doc describing a permission model the code no
 * longer implements — in either direction: edit-mode grants (DISCLAIMER.md,
 * SECURITY.md) or text-mode restrictions (README.md).
 *
 * This is a plain Node test (no VS Code API) and runs in the unit suite.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { test } from "node:test";
import { CLI_PROVIDERS, type CliProviderDefinition } from "../runners/providers";

// Which flag name each provider's edit mode uses to grant permissions.
// Adding a CLI_PROVIDERS entry without a matching line here fails the test
// below instead of silently leaving that provider unchecked.
const EDIT_MODE_FLAG_NAMES: Readonly<Record<string, string>> = {
  "claude-cli": "--permission-mode",
  "codex-cli": "--sandbox",
  "gemini-cli": "--approval-mode",
  "kiro-cli": "--trust-all-tools",
  "antigravity-cli": "--dangerously-skip-permissions",
  "opencode-cli": "--agent",
};

// Which flag name each provider's text mode uses to stay read-only, quoted
// in README.md's provider table/notes. gemini-cli is deliberately absent:
// its text mode passes no permission flag at all — verified 2026-07-20 by
// direct testing that its default agent has no write/shell tools available
// (see its buildArgs comment in providers.ts) — so README has nothing to
// quote for it. antigravity-cli uses the SAME bypass flag in both modes
// (there is no separate read-only flag to quote), which is itself the
// point of its README note, so it's included here too.
const TEXT_MODE_FLAG_NAMES: Readonly<Partial<Record<string, string>>> = {
  "claude-cli": "--permission-mode",
  "codex-cli": "--sandbox",
  "kiro-cli": "--trust-tools",
  "antigravity-cli": "--dangerously-skip-permissions",
  "opencode-cli": "--agent",
};

function resolveProjectFile(fileName: string): string {
  // At compile time this file is at src/test/; at runtime (compiled) it is
  // at out/test/. Walk up from __dirname to find the project root.
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = nodePath.join(dir, fileName);
    if (nodeFs.existsSync(candidate)) {
      return candidate;
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `${fileName} not found in project root (searched up to 5 levels from __dirname)`
  );
}

/**
 * The literal text a doc should quote for this provider's permission flag
 * in the given mode, e.g. "--sandbox workspace-write" for a flag that
 * takes a value, or just "--trust-all-tools" for a standalone one. Reads
 * the flag's value (if any) from buildArgs's actual output rather than
 * hardcoding it a second time; for standalone flags there is no value to
 * read, so this instead confirms buildArgs still emits that exact flag —
 * either way, a real check against live code, not just the flag-name map.
 */
function permissionFlagText(
  def: CliProviderDefinition,
  mode: "text" | "edit",
  flagNames: Readonly<Partial<Record<string, string>>>
): string {
  const flagName = flagNames[def.id];
  assert.ok(
    flagName,
    `${def.id} has no ${mode}-mode entry in the flag-name map — add one so this guard keeps covering every provider (or document why it's deliberately absent, as gemini-cli's text mode is).`
  );
  const args = def.buildArgs(mode, undefined, undefined, {
    promptFile: "/tmp/prompt.txt",
  });
  const index = args.indexOf(flagName);
  assert.ok(
    index !== -1,
    `${def.id}'s ${mode}-mode buildArgs no longer includes "${flagName}" — ` +
      "update the flag-name map above (and the docs that quote it) to match the real flag."
  );
  const nextArg = args[index + 1];
  const takesValue = nextArg !== undefined && !nextArg.startsWith("-");
  return takesValue ? `${flagName} ${nextArg}` : flagName;
}

/**
 * Asserts docContent quotes flagText as a whole flag, not merely as a
 * substring of a longer one. A plain `.includes()` would let a doc that
 * quotes "--trust-all-tools-v2" satisfy a check for "--trust-all-tools" —
 * the boundary check requires the character on each side (if any) not be
 * part of the same flag/value token (word character or hyphen).
 */
function assertDocQuotesFlag(
  docContent: string,
  docLabel: string,
  defId: string,
  flagText: string
): void {
  const escaped = flagText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
  assert.ok(
    pattern.test(docContent),
    `${docLabel} does not quote ${defId}'s actual flag "${flagText}" as a whole flag — ` +
      "buildArgs changed without updating the doc, or the doc only quotes it as part of a longer string."
  );
}

void test("DISCLAIMER.md and SECURITY.md quote each provider's actual edit-mode permission flag", () => {
  const disclaimer = nodeFs.readFileSync(
    resolveProjectFile("DISCLAIMER.md"),
    "utf8"
  );
  const security = nodeFs.readFileSync(resolveProjectFile("SECURITY.md"), "utf8");

  for (const def of CLI_PROVIDERS) {
    const flagText = permissionFlagText(def, "edit", EDIT_MODE_FLAG_NAMES);
    assertDocQuotesFlag(disclaimer, "DISCLAIMER.md", def.id, flagText);
    assertDocQuotesFlag(security, "SECURITY.md", def.id, flagText);
  }
});

void test("README.md and SECURITY.md quote each provider's actual text-mode permission flag", () => {
  // Both docs make the same "text mode stays read-only via this flag"
  // claim (README's provider table/notes, SECURITY.md's implementation-run
  // section) — checking only one previously let the other drift silently;
  // opencode's SECURITY.md caveat about --agent plan's narrower exception
  // is exactly the kind of claim this guard exists to keep honest.
  const readme = nodeFs.readFileSync(resolveProjectFile("README.md"), "utf8");
  const security = nodeFs.readFileSync(resolveProjectFile("SECURITY.md"), "utf8");

  for (const def of CLI_PROVIDERS) {
    if (!(def.id in TEXT_MODE_FLAG_NAMES)) {
      continue;
    }
    const flagText = permissionFlagText(def, "text", TEXT_MODE_FLAG_NAMES);
    assertDocQuotesFlag(readme, "README.md", def.id, flagText);
    assertDocQuotesFlag(security, "SECURITY.md", def.id, flagText);
  }
});
