#!/usr/bin/env node
/**
 * Publish guard: fails if the packaged extension would contain private or
 * development-only files.
 *
 * WHY THIS EXISTS
 * ---------------
 * v0.53.0 renamed the task meta folder `plans/` -> `.ensemble/`. `.gitignore`
 * was updated; `.vscodeignore` was not. vsce ignores `.gitignore` entirely
 * whenever a `.vscodeignore` exists, so the protection evaporated with no
 * error and seven published versions (0.53.0 - 0.56.1) shipped ~82 MB of task
 * run logs — full AI prompts, context packs with verbatim source excerpts, and
 * absolute local paths — to the marketplace.
 *
 * The failure mode was silent, so the fix is a check that is NOT silent.
 *
 * DESIGN NOTE
 * -----------
 * Task-root names are parsed out of src/utils/taskRoot.ts rather than
 * duplicated here. That is the entire point: renaming DEFAULT_TASK_ROOT again
 * must trip this guard, not bypass it. If the constants cannot be found, this
 * script FAILS rather than assuming there is nothing to exclude — a guard that
 * silently passes when it can't do its job is how the original bug shipped.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

/** Upper bound on packaged files. Currently ~120; 250 leaves room to grow
 *  while still catching an explosion (the leaking builds packaged 1,927). */
const MAX_FILES = 250;

const TASK_ROOT_CONSTANTS = [
  "DEFAULT_TASK_ROOT",
  "LEGACY_DEFAULT_TASK_ROOT",
  "LEGACY_TASK_ROOT",
];

function readTaskRoots() {
  const sourcePath = path.join(repoRoot, "src", "utils", "taskRoot.ts");
  let source;
  try {
    source = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read ${sourcePath} to determine which task-root folders must be excluded.\n` +
        `Original error: ${error.message}`
    );
  }

  const roots = [];
  for (const name of TASK_ROOT_CONSTANTS) {
    const match = source.match(
      new RegExp(`${name}\\s*(?::[^=]+)?=\\s*["']([^"']+)["']`)
    );
    if (!match) {
      throw new Error(
        `Could not find ${name} in src/utils/taskRoot.ts.\n` +
          `This guard derives the excluded folder names from that file so a rename cannot\n` +
          `silently bypass it. If the constant was renamed or removed, update\n` +
          `TASK_ROOT_CONSTANTS in scripts/verify-package-contents.js to match.`
      );
    }
    roots.push(match[1]);
  }
  return roots;
}

function listPackagedFiles() {
  // execSync (single command string) rather than execFileSync with shell:true,
  // which Node flags under DEP0190 because argv is concatenated unescaped.
  // There is no interpolated input here, but the safe form costs nothing.
  const stdout = execSync("npx --no-install vsce ls", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0);
}

function buildRules(taskRoots) {
  const rules = taskRoots.map((root) => ({
    label: `task meta folder "${root}" (contains AI prompts and run logs)`,
    test: (file) => file === root || file.startsWith(`${root}/`),
  }));

  rules.push(
    {
      label: 'author working notes ("notes/")',
      test: (file) => file.startsWith("notes/"),
    },
    {
      label: 'design and verification docs ("docs/")',
      test: (file) => file.startsWith("docs/"),
    },
    {
      label: "test sources and stubs",
      test: (file) =>
        file.startsWith("test-stubs/") ||
        file.startsWith("dist/test/") ||
        /\.test\.[cm]?[jt]s$/.test(file),
    },
    {
      label: 'package manager store (".pnpm-store/")',
      test: (file) => file.startsWith(".pnpm-store/"),
    },
    {
      label: "stray root implementation artifact",
      test: (file) => file === "plan-final.md",
    }
  );

  return rules;
}

function main() {
  const taskRoots = readTaskRoots();
  const files = listPackagedFiles();

  if (files.length === 0) {
    throw new Error(
      "`vsce ls` returned no files. Refusing to treat an empty listing as a pass."
    );
  }

  const rules = buildRules(taskRoots);
  const violations = [];
  for (const rule of rules) {
    const matched = files.filter(rule.test);
    if (matched.length > 0) {
      violations.push({ label: rule.label, matched });
    }
  }

  const overCount = files.length > MAX_FILES;

  if (violations.length === 0 && !overCount) {
    console.log(
      `Package contents OK: ${files.length} files, no private or development-only paths.`
    );
    console.log(`Task roots checked: ${taskRoots.join(", ")}`);
    return;
  }

  console.error("\nPACKAGE CONTENTS CHECK FAILED\n");

  for (const violation of violations) {
    console.error(`  ${violation.matched.length} file(s) from ${violation.label}:`);
    for (const file of violation.matched.slice(0, 5)) {
      console.error(`    - ${file}`);
    }
    if (violation.matched.length > 5) {
      console.error(`    ... and ${violation.matched.length - 5} more`);
    }
    console.error("");
  }

  if (overCount) {
    console.error(
      `  Packaged file count ${files.length} exceeds the ${MAX_FILES} ceiling.\n` +
        `  Either something new is being included, or raise MAX_FILES deliberately.\n`
    );
  }

  console.error("Fix .vscodeignore and re-run before publishing.");
  console.error(
    "Reminder: vsce ignores .gitignore whenever .vscodeignore exists — adding an\n" +
      "entry to .gitignore alone will NOT exclude it from the package.\n"
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`\nPACKAGE CONTENTS CHECK ERRORED\n\n${error.message}\n`);
  process.exit(1);
}
