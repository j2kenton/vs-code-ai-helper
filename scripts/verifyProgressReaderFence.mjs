/**
 * Permissive-progress-reader import fence (plan §3.12 step 2,
 * verify:progress-reader-fence).
 *
 * The strict V1 progress stack must never sit on top of the permissive
 * legacy reader/writer: the coordinator, registry rows, lifecycle actions,
 * the creation reconciler/recovery, completed-task Resume, the field
 * policy, and the strict writers are prohibited from importing
 * `utils/taskProgressUtils` or its named V0 boundary
 * (`utils/legacyTaskProgressV0`). This verifier fails on any new or
 * remaining forbidden import inside the fenced module set.
 *
 * FAIL-CLOSED MECHANICS (implementation-review hardening):
 *
 * 1. Import extraction is TypeScript-AST-based, not line-based. Every
 *    module reference a fenced file can express is extracted from the
 *    parsed source: `import`/`import type` declarations (single-line or
 *    multiline), re-exports (`export { x } from`, `export * from`),
 *    `import x = require(...)`, CommonJS `require(...)` calls, and dynamic
 *    `import(...)` expressions. A `require`/dynamic-import whose specifier
 *    is not a string literal cannot be statically verified and is itself a
 *    fence failure inside a fenced file. A built-in detector self-test runs
 *    against adversarial fixtures (multiline import, type-only import,
 *    re-export, star re-export, require, dynamic import, import-equals) on
 *    every invocation before any real file is inspected, so a regression in
 *    the extractor fails the check rather than silently passing it.
 *
 * 2. The fence covers migrated-in-place consumer locations, not only the
 *    new V1 directories. Plan §3.12 step 3 migrates the existing lifecycle,
 *    creation, Resume, text-action, and helper modules in place; their
 *    paths are pinned in CONSUMER_LOCATIONS below. A location in that
 *    roster may import the permissive surface only while it still holds a
 *    `permissiveReaderConsumers` row in
 *    workflow-inventories/task-progress-fields-v1.json (whose
 *    exhaustiveness verify:task-progress-fields enforces). The moment a
 *    cohort migrates a location and its inventory row is removed, this
 *    fence arms for that path automatically — reintroducing a permissive
 *    import there fails without any edit to this script. An inventory row
 *    whose path is missing from CONSUMER_LOCATIONS is also a failure, so
 *    the roster cannot silently fall behind the inventory.
 *
 * Division of labor with verify:task-progress-fields: THAT check proves
 * every production consumer of the permissive surface is inventoried with a
 * migration cohort (the surface can only shrink deliberately); THIS check
 * proves the V1 replacement stack — and every already-migrated location —
 * is not a consumer. Both must be green.
 *
 * The V1 fence is defined by path patterns, not an allowlist of existing
 * files, so a V1 module added later (e.g. src/actions/taskActionRegistryV1)
 * is fenced from its first commit without touching this script.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(repoRoot, "src");
const WRAPPER_RELATIVE = "src/utils/legacyTaskProgressV0.ts";
const FIELDS_INVENTORY_RELATIVE = "workflow-inventories/task-progress-fields-v1.json";

/**
 * Repo-relative (posix) prefixes/patterns of the always-fenced V1 module
 * set — plan §3.12 step 2's list, expressed as the directories/files those
 * modules live in (or will live in when their cohorts land). A file
 * matching these patterns is fenced unconditionally and may never hold a
 * permissive-consumer inventory row.
 */
const FENCED_PATTERNS = [
  /^src\/actions\//, //                      coordinator, registry rows, orchestrator
  /^src\/prompts\//, //                      prompt contracts
  /^src\/services\/chat/, //                 Chat cohort V1 services (§5.5 transaction store, ...)
  /^src\/services\/taskProgress/, //         strict decoder/selector/writer/field policy
  /^src\/services\/workflow/, //             workflow file/lease/path/privacy stores
  /^src\/state\/taskCreationStartupReconcilerV1\.ts$/,
  /^src\/types\/chatInteractionTransactionV1\.ts$/,
  /^src\/types\/taskProgressFieldPolicyV1\.ts$/,
];

/**
 * Every current permissive-consumer location (the full
 * permissiveReaderConsumers roster of task-progress-fields-v1.json),
 * i.e. every module plan §3.12 step 3 may migrate IN PLACE — the
 * lifecycle commands and taskActivationCoordinator, the creation path
 * (startNewTask, taskInventory, extension activation, metaResourcesMigration),
 * completed-task Resume and its menus (resumeTask, reopenTask,
 * taskTreeProvider, taskStatusBar, viewArtifacts), the text-action
 * handlers, and the shared helpers (modelSelection, completionLint,
 * choosePublishScope, resolveTaskContext, stageTransition, ...).
 *
 * A path listed here is allowed to import the permissive surface only
 * while it retains a permissiveReaderConsumers inventory row; once its
 * cohort migrates it (row removed), the fence arms for it permanently.
 */
const CONSUMER_LOCATIONS = new Set([
  "src/commands/archiveTask.ts",
  "src/commands/chatWithStage.ts",
  "src/commands/choosePublishScope.ts",
  "src/commands/commitAndPushTask.ts",
  "src/commands/configureStepModels.ts",
  "src/commands/draftTaskWithAI.ts",
  "src/commands/generatePlanWithAI.ts",
  "src/commands/markTaskDone.ts",
  "src/commands/pauseTask.ts",
  "src/commands/pinTask.ts",
  "src/commands/renameTask.ts",
  "src/commands/resumeTask.ts",
  "src/commands/reviewActions.ts",
  "src/commands/runLintingFixes.ts",
  "src/commands/runPublishChecks.ts",
  "src/commands/scheduleTaskResume.ts",
  "src/commands/setTaskStage.ts",
  "src/commands/startNewTask.ts",
  "src/commands/viewArtifacts.ts",
  "src/extension.ts",
  "src/runners/runnerRegistry.ts",
  "src/state/legacyCreatingStartupGateV0.ts",
  "src/state/taskActivationCoordinator.ts",
  "src/state/taskInventory.ts",
  "src/utils/completionLint.ts",
  "src/utils/globalAssistantActions.ts",
  "src/utils/metaResourcesMigration.ts",
  "src/utils/modelSelection.ts",
  "src/utils/pickTaskFolder.ts",
  "src/utils/reopenTask.ts",
  "src/utils/resolveTaskContext.ts",
  "src/utils/reviewEscalation.ts",
  "src/utils/stageTransition.ts",
  "src/views/taskStatusBar.ts",
  "src/views/taskTreeProvider.ts",
  WRAPPER_RELATIVE,
]);

/**
 * Module basenames (extension-stripped final path segment) whose import is
 * a fence violation inside a fenced file.
 */
const FORBIDDEN_MODULE_NAMES = new Set(["taskProgressUtils", "legacyTaskProgressV0"]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** True when a module specifier resolves to a forbidden permissive module. */
function isForbiddenSpecifier(specifier) {
  const lastSegment = specifier.split("/").pop() ?? specifier;
  const bare = lastSegment.replace(/\.(js|mjs|cjs|ts|mts|cts)$/, "");
  return FORBIDDEN_MODULE_NAMES.has(bare);
}

/**
 * Extract every statically expressible module reference from a TypeScript
 * source: import declarations (any layout, incl. type-only), re-exports,
 * import-equals, require(...) calls, and dynamic import(...) calls.
 * References whose specifier is not a string literal are returned in
 * `unresolved` — a fenced file may not contain them, because the fence
 * cannot prove where they point.
 */
function collectModuleReferences(relativePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const references = [];
  const unresolved = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const record = (kind, node, specifierNode) => {
    if (specifierNode && ts.isStringLiteralLike(specifierNode)) {
      references.push({ kind, specifier: specifierNode.text, line: lineOf(node) });
    } else {
      unresolved.push({ kind, line: lineOf(node) });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      record("import", node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record("re-export", node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record("import-equals", node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "require") {
        record("require", node, node.arguments[0]);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        record("dynamic-import", node, node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { references, unresolved };
}

/**
 * Adversarial fixtures the extractor must catch. Each `forbidden` fixture
 * must yield exactly one forbidden reference of the expected kind; the
 * `clean` fixture must yield none (no basename over-matching); the
 * `nonLiteral` fixture must be reported as unresolved.
 */
const SELF_TEST_FIXTURES = [
  {
    name: "multiline named import",
    source: 'import {\n  readTaskProgress,\n  patchTaskProgress,\n} from "../utils/taskProgressUtils";\n',
    expectKind: "import",
  },
  {
    name: "single-line import",
    source: 'import { readTaskProgress } from "./taskProgressUtils";\n',
    expectKind: "import",
  },
  {
    name: "type-only import",
    source: 'import type { IncompleteTask } from "../utils/taskProgressUtils";\n',
    expectKind: "import",
  },
  {
    name: "wrapper import with .js extension",
    source: 'import {\n  LegacyTaskProgressReaderV0,\n} from "../utils/legacyTaskProgressV0.js";\n',
    expectKind: "import",
  },
  {
    name: "multiline named re-export",
    source: 'export {\n  readTaskProgress,\n} from "../utils/taskProgressUtils";\n',
    expectKind: "re-export",
  },
  {
    name: "star re-export",
    source: 'export * from "../utils/legacyTaskProgressV0";\n',
    expectKind: "re-export",
  },
  {
    name: "require call split across lines",
    source: 'const utils = require(\n  "../utils/taskProgressUtils"\n);\n',
    expectKind: "require",
  },
  {
    name: "dynamic import",
    source:
      'async function load() {\n  return await import(\n    "../utils/legacyTaskProgressV0"\n  );\n}\n',
    expectKind: "dynamic-import",
  },
  {
    name: "import-equals require",
    source: 'import utils = require("../utils/taskProgressUtils");\n',
    expectKind: "import-equals",
  },
  {
    name: "clean strict-stack import (no over-match)",
    source:
      'import { decode } from "../services/taskProgressDecoderV1";\nimport * as vscode from "vscode";\n',
    expectKind: null,
  },
  {
    name: "non-literal require specifier",
    source: 'const name = "../utils/taskProgressUtils";\nconst utils = require(name);\n',
    expectKind: "unresolved",
  },
];

/** Prove the extractor catches every fixture before trusting it on real files. */
function runDetectorSelfTest(failures) {
  for (const fixture of SELF_TEST_FIXTURES) {
    const { references, unresolved } = collectModuleReferences("self-test.ts", fixture.source);
    const forbidden = references.filter((ref) => isForbiddenSpecifier(ref.specifier));
    if (fixture.expectKind === "unresolved") {
      if (unresolved.length !== 1) {
        failures.push(
          `detector self-test "${fixture.name}": expected 1 unresolved (non-literal) reference, got ${unresolved.length}.`
        );
      }
    } else if (fixture.expectKind === null) {
      if (forbidden.length !== 0 || unresolved.length !== 0) {
        failures.push(
          `detector self-test "${fixture.name}": expected no forbidden/unresolved references, got ` +
            `${forbidden.length} forbidden / ${unresolved.length} unresolved.`
        );
      }
    } else if (forbidden.length !== 1 || forbidden[0].kind !== fixture.expectKind) {
      failures.push(
        `detector self-test "${fixture.name}": expected exactly one forbidden "${fixture.expectKind}" ` +
          `reference, got [${forbidden.map((ref) => ref.kind).join(", ") || "none"}].`
      );
    }
  }
}

function walkProductionSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test") continue;
      walkProductionSources(full, out);
    } else if (
      entry.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".d.ts") &&
      !/\.test\.ts$/.test(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Load the permissive-consumer roster from the live fields inventory. */
function loadRosteredPaths(failures) {
  const inventoryPath = path.join(repoRoot, FIELDS_INVENTORY_RELATIVE);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  } catch (error) {
    failures.push(
      `${FIELDS_INVENTORY_RELATIVE} could not be read/parsed (${error.message}) — the fence cannot ` +
        "determine which consumer locations are still legitimately permissive, so it fails closed."
    );
    return new Set();
  }
  const rows = parsed?.permissiveReaderConsumers;
  if (!Array.isArray(rows) || rows.length === 0) {
    failures.push(
      `${FIELDS_INVENTORY_RELATIVE} has no permissiveReaderConsumers rows — the fence fails closed ` +
        "rather than treating every consumer location as migrated."
    );
    return new Set();
  }
  const rostered = new Set();
  for (const row of rows) {
    if (typeof row?.path !== "string" || row.path.length === 0) {
      failures.push(`${FIELDS_INVENTORY_RELATIVE} contains a permissiveReaderConsumers row without a path.`);
      continue;
    }
    rostered.add(row.path);
    if (!CONSUMER_LOCATIONS.has(row.path)) {
      failures.push(
        `${row.path} is inventoried as a permissive consumer but is missing from this fence's ` +
          "CONSUMER_LOCATIONS roster — add it in the same change, so the fence arms when its cohort migrates."
      );
    }
  }
  return rostered;
}

/** The named V0 boundary must exist, wrap only taskProgressUtils, and export both surfaces. */
function verifyWrapper(failures, rosteredPaths) {
  const wrapperPath = path.join(repoRoot, WRAPPER_RELATIVE);
  if (!fs.existsSync(wrapperPath)) {
    failures.push(
      `${WRAPPER_RELATIVE} is missing — plan §3.12 step 1 requires the permissive utilities to be ` +
        "wrapped as LegacyTaskProgressReaderV0 / LegacyTaskProgressWriterV0."
    );
    return;
  }
  const wrapperText = fs.readFileSync(wrapperPath, "utf8");
  const { references, unresolved } = collectModuleReferences(WRAPPER_RELATIVE, wrapperText);
  const foreign = references.filter((ref) => {
    const lastSegment = ref.specifier.split("/").pop() ?? ref.specifier;
    return lastSegment.replace(/\.(js|mjs|cjs|ts|mts|cts)$/, "") !== "taskProgressUtils";
  });
  if (foreign.length > 0) {
    failures.push(
      `${WRAPPER_RELATIVE} must wrap utils/taskProgressUtils and nothing else, but references: ` +
        foreign.map((ref) => `${ref.specifier} (${ref.kind})`).join(", ")
    );
  }
  for (const entry of unresolved) {
    failures.push(
      `${WRAPPER_RELATIVE}:${entry.line} has a ${entry.kind} with a non-literal module specifier — ` +
        "the wrapper's imports must be statically verifiable."
    );
  }
  for (const requiredExport of ["LegacyTaskProgressReaderV0", "LegacyTaskProgressWriterV0"]) {
    if (!wrapperText.includes(`export const ${requiredExport}`)) {
      failures.push(`${WRAPPER_RELATIVE} does not export ${requiredExport}.`);
    }
  }
  if (!rosteredPaths.has(WRAPPER_RELATIVE)) {
    failures.push(
      `${WRAPPER_RELATIVE} has lost its permissiveReaderConsumers inventory row — the wrapper must ` +
        "stay inventoried (cohort cleanup) until the Cleanup cohort removes it with single-owner proof."
    );
  }
}

function main() {
  const failures = [];

  runDetectorSelfTest(failures);
  if (failures.length > 0) {
    // The extractor itself is broken; nothing downstream can be trusted.
    for (const failure of failures) {
      console.error(`✘ [progressReaderFence] ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  const rosteredPaths = loadRosteredPaths(failures);
  verifyWrapper(failures, rosteredPaths);

  const files = walkProductionSources(SRC_DIR);
  let fencedV1Count = 0;
  let armedLocationCount = 0;
  let trackedConsumerCount = 0;
  for (const file of files) {
    const relative = toPosix(path.relative(repoRoot, file));
    if (relative === WRAPPER_RELATIVE) {
      continue; // verified separately above
    }
    const isV1Module = FENCED_PATTERNS.some((pattern) => pattern.test(relative));
    const isConsumerLocation = CONSUMER_LOCATIONS.has(relative);
    const isRostered = rosteredPaths.has(relative);
    if (isV1Module && isRostered) {
      failures.push(
        `${relative} matches the fenced V1 module set but holds a permissiveReaderConsumers inventory ` +
          "row — a V1 module may never be an inventoried consumer of the legacy reader/writer."
      );
    }
    const fenced = isV1Module || (isConsumerLocation && !isRostered);
    if (!fenced) {
      if (isConsumerLocation) trackedConsumerCount++;
      continue;
    }
    if (isV1Module) fencedV1Count++;
    else armedLocationCount++;
    const { references, unresolved } = collectModuleReferences(
      relative,
      fs.readFileSync(file, "utf8")
    );
    for (const ref of references) {
      if (isForbiddenSpecifier(ref.specifier)) {
        failures.push(
          `${relative}:${ref.line} ${ref.kind} of "${ref.specifier}" reaches the permissive legacy ` +
            "progress reader/writer — fenced modules must use the strict progress stack (plan §3.12 step 2)."
        );
      }
    }
    for (const entry of unresolved) {
      failures.push(
        `${relative}:${entry.line} has a ${entry.kind} with a non-literal module specifier — the fence ` +
          "cannot statically verify it; fenced modules must use literal import specifiers."
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`✘ [progressReaderFence] ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `✓ progressReaderFence: detector self-test passed (${SELF_TEST_FIXTURES.length} fixtures); ` +
      `${fencedV1Count} fenced V1 module(s) and ${armedLocationCount} armed migrated location(s) verified ` +
      "free of permissive progress imports (incl. multiline/re-export/require/dynamic forms); " +
      `${trackedConsumerCount} inventoried legacy consumer location(s) deferred to verify:task-progress-fields; ` +
      "the V0 boundary wrapper is present and clean."
  );
}

main();
