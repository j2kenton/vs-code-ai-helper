/**
 * Task-progress field inventory generator/verifier (plan §3.10 /
 * `task-progress-fields-v1.json`, and §3.12 step 1's permissive-reader
 * consumer baseline).
 *
 * Two jobs, one mechanical source of truth:
 *
 *  1. FIELDS — parses `src/types/taskProgress.ts` with the repository-pinned
 *     TypeScript compiler and extracts every property of the persisted
 *     `TaskProgress` interface (name, optionality, declared type text,
 *     declaration span). The checked-in inventory
 *     (`workflow-inventories/task-progress-fields-v1.json`) must contain
 *     exactly one row per property, and every row must carry the plan's
 *     policy attributes: a historical-family rule, a V1 decoder rule, and a
 *     lifecycle policy row (migration / nextStage.v1 / markTaskDone.v1 /
 *     reopen). Until the strict decoder and field-policy module land
 *     (Foundations cohort), a policy attribute may be an explicit
 *     `pending:<cohort>` marker — but it must be PRESENT and ATTRIBUTED, so
 *     no persisted field can silently sit outside the exhaustiveness
 *     contract. A field added to `TaskProgress` without an inventory row, or
 *     an inventory row whose field no longer exists, fails verification.
 *
 *  2. PERMISSIVE-READER CONSUMERS — scans production sources (src/**, tests
 *     excluded) for imports from `utils/taskProgressUtils` (the permissive
 *     legacy reader/writer §3.12 retires by cohort). The inventory must list
 *     every consumer file with its assigned migration cohort; a new consumer
 *     appearing without a row fails verification, so the permissive surface
 *     can only shrink deliberately.
 *
 *  3. FIXTURE PROVENANCE — every fixture under
 *     `test-fixtures/task-progress/<dir>/` must have a row (first table cell,
 *     backticked filename) in the matching `## <dir>/` section of
 *     `test-fixtures/task-progress/README.md`, and every row must name a
 *     fixture that still exists. The walk fails closed at its edges too: a
 *     root-level entry other than the README, and any non-`.json` entry
 *     (nested directory or stray file) inside a fixture directory, are
 *     errors — not skips — because either would otherwise be invisible to
 *     the provenance match. The README's rule — each fixture names the
 *     production writer whose persisted output it reproduces — is §3.10's
 *     checked-in evidence base; this check makes it self-policing instead of
 *     prose, so a fixture cannot be added or dropped without its provenance
 *     record moving with it. The walk itself is the shared gate in
 *     scripts/lib/fixtureProvenance.mjs, which the workflow-route,
 *     path-consumer, and production-source fixture trees also run.
 *
 * Run modes:
 *   node scripts/generateTaskProgressFieldInventory.mjs             # verify
 *   node scripts/generateTaskProgressFieldInventory.mjs --generate  # (re)write
 *
 * --generate preserves existing policy attributes and cohort assignments for
 * rows that still exist, and stubs new rows with explicit
 * "pending:unassigned" markers that verification then rejects — forcing a
 * human to assign the rule, never silently defaulting it.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { verifyFixtureProvenance } from "./lib/fixtureProvenance.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TYPES_PATH = path.join(repoRoot, "src", "types", "taskProgress.ts");
const UTILS_MODULE_SUFFIX = "utils/taskProgressUtils";
const INVENTORY_PATH = path.join(repoRoot, "workflow-inventories", "task-progress-fields-v1.json");
const SRC_DIR = path.join(repoRoot, "src");
const FIXTURES_DIR = path.join(repoRoot, "test-fixtures", "task-progress");

const KNOWN_COHORTS = new Set([
  "baseline", "safety", "lmIsolation", "runnerV1", "foundations", "privacy",
  "chat", "text1", "text2", "text3", "lifecycle", "creation", "resume",
  "edit", "git", "cleanup", "nonPlan",
]);

function fail(message) {
  console.error(`✘ [taskProgressFieldInventory] ${message}`);
  process.exitCode = 1;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Extract every property of the TaskProgress interface via the TS compiler. */
function extractTaskProgressFields() {
  const sourceText = fs.readFileSync(TYPES_PATH, "utf8");
  const sourceFile = ts.createSourceFile(TYPES_PATH, sourceText, ts.ScriptTarget.Latest, true);
  let fields = null;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "TaskProgress") {
      fields = node.members
        .filter((m) => ts.isPropertySignature(m) && m.name)
        .map((m) => {
          const start = sourceFile.getLineAndCharacterOfPosition(m.getStart(sourceFile));
          const end = sourceFile.getLineAndCharacterOfPosition(m.getEnd());
          return {
            name: m.name.getText(sourceFile),
            optional: Boolean(m.questionToken),
            typeText: m.type ? m.type.getText(sourceFile).replace(/\s+/g, " ") : "unknown",
            sourceSpan: `L${start.line + 1}-L${end.line + 1}`,
          };
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!fields || fields.length === 0) {
    throw new Error(`Could not find a non-empty TaskProgress interface in ${toPosix(path.relative(repoRoot, TYPES_PATH))}.`);
  }
  return fields;
}

/** Walk every production .ts file under src (tests and .d.ts excluded). */
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

/** Files importing the permissive reader/writer, with the symbols they import. */
function extractPermissiveConsumers() {
  const consumers = [];
  for (const file of walkProductionSources(SRC_DIR)) {
    const text = fs.readFileSync(file, "utf8");
    const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']*taskProgressUtils)["']/g;
    let match;
    const symbols = new Set();
    while ((match = importRe.exec(text)) !== null) {
      if (!match[2].endsWith(UTILS_MODULE_SUFFIX.split("/").pop())) continue;
      for (const raw of match[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) symbols.add(name);
      }
    }
    if (symbols.size > 0) {
      consumers.push({
        path: toPosix(path.relative(repoRoot, file)),
        imports: [...symbols].sort((a, b) => a.localeCompare(b)),
      });
    }
  }
  return consumers.sort((a, b) => a.path.localeCompare(b.path));
}

const POLICY_ATTRIBUTES = ["historicalFamilyRule", "v1DecoderRule", "lifecyclePolicy"];
const LIFECYCLE_COLUMNS = ["migration", "nextStage", "markTaskDone", "reopen"];

/**
 * A pending marker is "pending:<cohort>" optionally followed by an
 * explanatory note ("pending:foundations — why"). Returns the named cohort,
 * or null if the value is not a pending marker at all.
 */
function pendingCohortOf(value) {
  if (!value.startsWith("pending:")) return null;
  return value.slice("pending:".length).split(/[\s—]/, 1)[0];
}

function validateInventory(inventory, fields, consumers) {
  const failures = [];
  const record = (m) => { failures.push(m); fail(m); };

  if (inventory.schemaVersion !== 1) {
    record(`Inventory schemaVersion must be 1, found ${JSON.stringify(inventory.schemaVersion)}.`);
  }

  const rowsByName = new Map((inventory.fields || []).map((f) => [f.name, f]));
  for (const field of fields) {
    const row = rowsByName.get(field.name);
    if (!row) {
      record(`TaskProgress.${field.name} has no row in task-progress-fields-v1.json — every persisted field needs a declared type, optionality, historical-family rule, V1 decoder rule, and lifecycle policy row (plan §3.10).`);
      continue;
    }
    if (row.optional !== field.optional) {
      record(`TaskProgress.${field.name}: inventory says optional=${row.optional} but the declaration says optional=${field.optional}.`);
    }
    if (row.typeText !== field.typeText) {
      record(`TaskProgress.${field.name}: inventory typeText is stale (inventory: ${JSON.stringify(row.typeText)}; declaration: ${JSON.stringify(field.typeText)}). Re-run with --generate and re-review the field's rules.`);
    }
    for (const attribute of POLICY_ATTRIBUTES) {
      const value = row[attribute];
      if (attribute === "lifecyclePolicy") {
        if (typeof value !== "object" || value === null) {
          record(`TaskProgress.${field.name}: missing lifecyclePolicy object (${LIFECYCLE_COLUMNS.join("/")}).`);
          continue;
        }
        for (const column of LIFECYCLE_COLUMNS) {
          const cell = value[column];
          if (typeof cell !== "string" || cell.length === 0) {
            record(`TaskProgress.${field.name}: lifecyclePolicy.${column} must be a non-empty rule or an explicit "pending:<cohort>" marker.`);
          } else {
            const cohort = pendingCohortOf(cell);
            if (cohort !== null && !KNOWN_COHORTS.has(cohort)) {
              record(`TaskProgress.${field.name}: lifecyclePolicy.${column} pending marker names unknown cohort ${JSON.stringify(cohort)}.`);
            }
          }
        }
      } else if (typeof value !== "string" || value.length === 0) {
        record(`TaskProgress.${field.name}: ${attribute} must be a non-empty rule or an explicit "pending:<cohort>" marker.`);
      } else {
        const cohort = pendingCohortOf(value);
        if (cohort !== null && !KNOWN_COHORTS.has(cohort)) {
          record(`TaskProgress.${field.name}: ${attribute} pending marker names unknown cohort ${JSON.stringify(cohort)}.`);
        }
      }
    }
  }
  const fieldNames = new Set(fields.map((f) => f.name));
  for (const row of inventory.fields || []) {
    if (!fieldNames.has(row.name)) {
      record(`Inventory row "${row.name}" does not exist on the current TaskProgress declaration — remove the row or restore the field (stale rows hide real coverage gaps).`);
    }
  }

  const consumerRows = new Map((inventory.permissiveReaderConsumers || []).map((c) => [c.path, c]));
  for (const consumer of consumers) {
    const row = consumerRows.get(consumer.path);
    if (!row) {
      record(`${consumer.path} imports from utils/taskProgressUtils (the permissive legacy reader/writer) but has no consumer row — every permissive call site must be recorded with a migration cohort (plan §3.12 step 1).`);
      continue;
    }
    if (JSON.stringify(row.imports) !== JSON.stringify(consumer.imports)) {
      record(`${consumer.path}: recorded imports ${JSON.stringify(row.imports)} are stale (current: ${JSON.stringify(consumer.imports)}). Re-run with --generate and re-review the row.`);
    }
    if (typeof row.migrationCohort !== "string" || !KNOWN_COHORTS.has(row.migrationCohort)) {
      record(`${consumer.path}: consumer row must name a known migrationCohort (plan §3.12 / §8), found ${JSON.stringify(row.migrationCohort)}.`);
    }
    if (typeof row.purpose !== "string" || row.purpose.length === 0) {
      record(`${consumer.path}: consumer row must record its purpose (what it reads/writes progress for).`);
    }
  }
  const livePaths = new Set(consumers.map((c) => c.path));
  for (const row of inventory.permissiveReaderConsumers || []) {
    if (!livePaths.has(row.path)) {
      record(`Consumer row ${row.path} no longer imports from utils/taskProgressUtils — remove the row (stale rows hide real migrations).`);
    }
  }

  return failures;
}

/**
 * FIXTURE PROVENANCE (job 3, header comment): match fixtures on disk against
 * the provenance README's per-directory rows, both directions. The walk is
 * the shared scripts/lib/fixtureProvenance.mjs gate (same fail-closed edge
 * rules as before its extraction), also run by the workflow-route,
 * path-consumer, and production-source inventory scripts over their trees.
 */
function validateFixtureProvenance() {
  const failures = [];
  const record = (m) => { failures.push(m); fail(m); };
  verifyFixtureProvenance({
    repoRoot,
    fixturesDir: FIXTURES_DIR,
    fixtureFileRe: /\.json$/,
    fixtureFileDescription: ".json",
    layout: "subdirectories",
    record,
  });
  return failures;
}

function main() {
  const generate = process.argv.includes("--generate");
  const fields = extractTaskProgressFields();
  const consumers = extractPermissiveConsumers();

  const existing = fs.existsSync(INVENTORY_PATH)
    ? JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"))
    : { fields: [], permissiveReaderConsumers: [] };

  if (generate) {
    const existingFieldRows = new Map((existing.fields || []).map((f) => [f.name, f]));
    const existingConsumerRows = new Map(
      (existing.permissiveReaderConsumers || []).map((c) => [c.path, c])
    );
    const inventory = {
      schemaVersion: 1,
      description:
        "Exhaustive inventory of every persisted TaskProgress field (plan §3.10) and every production " +
        "consumer of the permissive legacy progress reader/writer in utils/taskProgressUtils (plan §3.12 " +
        "step 1). Mechanically regenerated by scripts/generateTaskProgressFieldInventory.mjs --generate; " +
        "policy attributes and cohort assignments are human-authored and preserved across regeneration. " +
        "verify:task-progress-fields fails on any TaskProgress field without a row, any stale row, any " +
        "missing/unattributed policy rule, and any unlisted permissive-reader consumer.",
      generatedFrom: "src/types/taskProgress.ts (TaskProgress interface) + production imports of utils/taskProgressUtils",
      fields: fields.map((field) => {
        const prior = existingFieldRows.get(field.name);
        return {
          name: field.name,
          optional: field.optional,
          typeText: field.typeText,
          sourceSpan: field.sourceSpan,
          historicalFamilyRule: prior?.historicalFamilyRule ?? "pending:unassigned",
          v1DecoderRule: prior?.v1DecoderRule ?? "pending:unassigned",
          lifecyclePolicy: prior?.lifecyclePolicy ?? {
            migration: "pending:unassigned",
            nextStage: "pending:unassigned",
            markTaskDone: "pending:unassigned",
            reopen: "pending:unassigned",
          },
        };
      }),
      permissiveReaderConsumers: consumers.map((consumer) => {
        const prior = existingConsumerRows.get(consumer.path);
        return {
          path: consumer.path,
          imports: consumer.imports,
          purpose: prior?.purpose ?? "",
          migrationCohort: prior?.migrationCohort ?? "unassigned",
        };
      }),
    };
    fs.mkdirSync(path.dirname(INVENTORY_PATH), { recursive: true });
    fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2) + "\n", "utf8");
    console.log(
      `✓ Wrote ${toPosix(path.relative(repoRoot, INVENTORY_PATH))}: ${inventory.fields.length} TaskProgress ` +
        `field row(s), ${inventory.permissiveReaderConsumers.length} permissive-reader consumer row(s). ` +
        "New rows carry pending/unassigned markers that verification rejects until a human assigns them."
    );
    const failures = [
      ...validateInventory(inventory, fields, consumers),
      ...validateFixtureProvenance(),
    ];
    if (failures.length > 0) {
      fail(`${failures.length} row(s) still need human-assigned rules/cohorts or provenance rows (see above).`);
    }
    return;
  }

  if (!fs.existsSync(INVENTORY_PATH)) {
    fail(
      `${toPosix(path.relative(repoRoot, INVENTORY_PATH))} does not exist. Run ` +
        '"node scripts/generateTaskProgressFieldInventory.mjs --generate", assign the stubbed rules, and commit it.'
    );
    return;
  }
  const failures = [
    ...validateInventory(existing, fields, consumers),
    ...validateFixtureProvenance(),
  ];
  if (failures.length === 0) {
    console.log(
      `✓ taskProgressFieldInventory: ${fields.length} TaskProgress field(s) and ${consumers.length} ` +
        "permissive-reader consumer(s) verified against workflow-inventories/task-progress-fields-v1.json; " +
        "task-progress fixture provenance rows match the fixtures on disk."
    );
  } else {
    fail(`taskProgressFieldInventory: ${failures.length} check(s) failed.`);
  }
}

main();
