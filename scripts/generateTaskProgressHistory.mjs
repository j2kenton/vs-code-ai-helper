#!/usr/bin/env node
/**
 * Task-progress history inventory generator/verifier (plan §3.10,
 * `task-progress-history-v1.json` — the historical-family half of the strict
 * task-progress foundation; the per-field half lives in
 * task-progress-fields-v1.json / generateTaskProgressFieldInventory.mjs).
 *
 * The strict version selector (plan §3.10) needs an exhaustive, checked-in
 * answer to "which persisted shapes are supported legacy input": `absent
 * ensembleProgressVersion plus exactly one compatible historical family
 * means supported legacy input; exact integer 1 means V1; anything else
 * enters recovery`. This inventory IS that answer's evidence base.
 *
 * MECHANICAL ANCHORS (regenerated every run, never hand-edited):
 *  - the SHA-256 of the current `TaskProgress` interface declaration text
 *    (whitespace-normalized) — any change to the persisted shape invalidates
 *    the inventory until a human re-reviews the families and regenerates;
 *  - the field-name universe, read from task-progress-fields-v1.json (which
 *    generateTaskProgressFieldInventory.mjs itself verifies against the
 *    declaration) — every family must rule on every field, so a new
 *    persisted field can never sit outside the history contract.
 *
 * HUMAN-AUTHORED (preserved across --generate): the family definitions —
 * familyId, whether it is THE legacy default family (exactly one must be),
 * its version selector, its source evidence, and one rule per persisted
 * field. Missing rules are stubbed "pending:unassigned", which verification
 * rejects. `plannedFamilies` records not-yet-real families (V1) without
 * granting them supported-input status.
 *
 * USAGE
 *   node scripts/generateTaskProgressHistory.mjs             # verify
 *   node scripts/generateTaskProgressHistory.mjs --generate  # (re)write, preserving family definitions
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TYPES_PATH = path.join(repoRoot, "src", "types", "taskProgress.ts");
const FIELDS_PATH = path.join(repoRoot, "workflow-inventories", "task-progress-fields-v1.json");
const INVENTORY_PATH = path.join(repoRoot, "workflow-inventories", "task-progress-history-v1.json");

function fail(message) {
  console.error(`✘ [taskProgressHistory] ${message}`);
  process.exitCode = 1;
}

/** Whitespace-normalized declaration text + digest of the TaskProgress interface. */
function currentDeclarationDigest() {
  const sourceText = fs.readFileSync(TYPES_PATH, "utf8");
  const sourceFile = ts.createSourceFile(TYPES_PATH, sourceText, ts.ScriptTarget.Latest, true);
  let declarationText = null;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "TaskProgress") {
      declarationText = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!declarationText) {
    throw new Error("Could not find the TaskProgress interface in src/types/taskProgress.ts.");
  }
  return crypto.createHash("sha256").update(declarationText, "utf8").digest("hex");
}

function fieldNameUniverse() {
  if (!fs.existsSync(FIELDS_PATH)) {
    throw new Error(
      "workflow-inventories/task-progress-fields-v1.json does not exist — run verify:task-progress-fields first " +
        "(the history inventory rules over exactly that field universe)."
    );
  }
  const fields = JSON.parse(fs.readFileSync(FIELDS_PATH, "utf8")).fields || [];
  return fields.map((f) => f.name);
}

function validate(inventory, digest, fieldNames, record) {
  if (inventory.schemaVersion !== 1) {
    record(`schemaVersion must be 1, found ${JSON.stringify(inventory.schemaVersion)}.`);
  }
  if (inventory.currentDeclarationSha256 !== digest) {
    record(
      `currentDeclarationSha256 is stale (inventory: ${inventory.currentDeclarationSha256}; live: ${digest}). The ` +
        `persisted TaskProgress shape changed — re-review every family's field rules, then re-run with --generate.`
    );
  }
  const families = inventory.families || [];
  if (families.length === 0) {
    record("The inventory must define at least one historical family (plan §3.10).");
  }
  const legacyDefaults = families.filter((f) => f.legacyDefault === true);
  if (legacyDefaults.length !== 1) {
    record(
      `Exactly one family must carry legacyDefault: true (plan §3.10: "absent plus exactly one compatible historical ` +
        `family means supported legacy input"), found ${legacyDefaults.length}.`
    );
  }
  const seenIds = new Set();
  for (const family of families) {
    const label = `family ${JSON.stringify(family.familyId ?? "?")}`;
    if (typeof family.familyId !== "string" || family.familyId.length === 0) {
      record(`A family is missing its familyId.`);
    } else if (seenIds.has(family.familyId)) {
      record(`${label}: duplicate familyId.`);
    } else {
      seenIds.add(family.familyId);
    }
    for (const field of ["description", "versionSelector", "evidence"]) {
      if (typeof family[field] !== "string" || family[field].length === 0) {
        record(`${label}: "${field}" must be non-empty.`);
      }
    }
    const rules = family.fieldRules;
    if (typeof rules !== "object" || rules === null) {
      record(`${label}: missing fieldRules object.`);
      continue;
    }
    for (const name of fieldNames) {
      const rule = rules[name];
      if (typeof rule !== "string" || rule.length === 0) {
        record(`${label}: fieldRules.${name} must be a non-empty rule — every persisted field needs a per-family rule (plan §3.10).`);
      } else if (rule.startsWith("pending:")) {
        record(`${label}: fieldRules.${name} is still ${JSON.stringify(rule)} — assign it.`);
      }
    }
    for (const name of Object.keys(rules)) {
      if (!fieldNames.includes(name)) {
        record(`${label}: fieldRules.${name} names a field that is not in task-progress-fields-v1.json — remove the stale rule.`);
      }
    }
  }
  for (const planned of inventory.plannedFamilies || []) {
    const label = `planned family ${JSON.stringify(planned.familyId ?? "?")}`;
    for (const field of ["familyId", "versionSelector", "landsWithCohort"]) {
      if (typeof planned[field] !== "string" || planned[field].length === 0) {
        record(`${label}: "${field}" must be non-empty.`);
      }
    }
    if (seenIds.has(planned.familyId)) {
      record(`${label}: collides with a defined family — a planned family must not also be a supported family.`);
    }
  }
}

function main() {
  const generate = process.argv.includes("--generate");
  const digest = currentDeclarationDigest();
  const fieldNames = fieldNameUniverse();
  const failures = [];
  const record = (m) => { failures.push(m); fail(m); };

  const existing = fs.existsSync(INVENTORY_PATH)
    ? JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"))
    : { families: [], plannedFamilies: [] };

  if (generate) {
    const inventory = {
      schemaVersion: 1,
      description: existing.description ??
        "Task-progress historical-family inventory (plan §3.10). Mechanical anchors (declaration digest, field " +
        "universe) are regenerated by scripts/generateTaskProgressHistory.mjs --generate; family definitions are " +
        "human-authored and preserved. verify:task-progress-history fails on a stale declaration digest, a family " +
        "missing a rule for any persisted field, and anything other than exactly one legacy-default family.",
      currentDeclarationSha256: digest,
      fieldUniverseSource: "workflow-inventories/task-progress-fields-v1.json",
      families: (existing.families || []).map((family) => ({
        ...family,
        fieldRules: Object.fromEntries(
          fieldNames.map((name) => [name, family.fieldRules?.[name] ?? "pending:unassigned"])
        ),
      })),
      plannedFamilies: existing.plannedFamilies || [],
    };
    fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2) + "\n", "utf8");
    console.log(
      `✓ Wrote workflow-inventories/task-progress-history-v1.json: ${inventory.families.length} family(ies) over ` +
        `${fieldNames.length} persisted field(s); declaration digest ${digest.slice(0, 12)}…`
    );
    validate(inventory, digest, fieldNames, record);
    if (failures.length > 0) {
      fail(`${failures.length} check(s) still failing after regeneration (see above).`);
    }
    return;
  }

  if (!fs.existsSync(INVENTORY_PATH)) {
    fail("workflow-inventories/task-progress-history-v1.json does not exist. Run with --generate once, author the families, and commit it.");
    return;
  }
  validate(existing, digest, fieldNames, record);
  if (failures.length === 0) {
    console.log(
      `✓ taskProgressHistory: ${(existing.families || []).length} historical family(ies) verified over ` +
        `${fieldNames.length} persisted field(s) against the current TaskProgress declaration.`
    );
  } else {
    fail(`taskProgressHistory: ${failures.length} check(s) failed.`);
  }
}

main();
