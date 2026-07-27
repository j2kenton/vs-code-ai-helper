#!/usr/bin/env node
/**
 * Non-AI path-consumer inventory generator/verifier (plan §2.3, Executable
 * Order step 1 / cohort "Privacy" prerequisite).
 *
 * Inventories every PRODUCTION module that can discover, read, copy, log,
 * attach, back up, stage, or serialize task/workflow paths — the consumers
 * the privacy classifier (plan §2.2, WorkflowPrivacyClassifierV1) must cover
 * before Chat-private data moves into the task folder.
 *
 * ARCHITECTURE (mirrors resolveProductionSourceUniverse.mjs)
 * ----------------------------------------------------------
 *  - `workflow-path-consumer-pregate-v1.json` is the IMMUTABLE pre-gate
 *    consumer surface, generated exactly once by
 *    scripts/generatePregateWorkflowInventoryBaselines.mjs and never written
 *    by this script. Every consumer added or removed since that snapshot —
 *    and every consumer whose per-signal call-site profile changed (counted
 *    through the span-independent stability projection, so pure line drift
 *    never counts while a new fs/child_process/workspace.fs site always
 *    does) — must carry a pregateAddedConsumer / pregateRemovedConsumer /
 *    pregateModifiedConsumer annotation in
 *    workflow-path-consumer-annotations-v1.json with matching stability
 *    digests. `--generate` refuses to run while undocumented drift exists.
 *  - `workflow-path-consumer-baseline-v1.json` is the regenerable,
 *    currently-accepted AND CLASSIFIED inventory; the live file is
 *    regenerated unconditionally every run.
 *
 * MECHANICAL ANCHOR: the scan consumes the exact TypeScript file list of the
 * §1.1 production source universe (workflow-production-source-baseline-v1.json)
 * — never a filesystem walk, so a module the shipping bundle does not reach
 * can never enter the inventory (plan §1.1: the source-universe file cannot
 * be independently expanded or filtered). Each consumer row records every
 * concrete CALL SITE (compiler-derived span + enclosing symbol) for its
 * signals:
 *   - an import/require of node:fs / fs (or their promises subpath);
 *   - an import/require of node:child_process / child_process (spawned
 *     processes can be handed workspace paths and can write anywhere — every
 *     such consumer is UNRESOLVED DYNAMIC path consumption and requires a
 *     "dynamicPathConsumption" annotation carrying §1.5-style evidence, or
 *     verification fails closed);
 *   - each `workspace.fs` property access (the VS Code filesystem API).
 * The candidate list and call sites cannot be hand-edited; verification
 * re-derives them every run. The CLASSIFICATION columns the plan requires
 * per row (sink categories, path source, expected handling, classifier
 * call) are human-authored, preserved across `--generate`, and stubbed with
 * explicit "pending:unassigned" markers that verification rejects.
 *
 * `classifierCall` records how the row interacts with the shared privacy
 * classifier (src/services/workflowPrivacyClassifierV1.ts, landed with the
 * Privacy cohort — plan §2.2). Rows whose migration cohort has wired the
 * call record the actual call site; rows still awaiting their own cohort
 * keep "pending:privacy — <expected call site>" markers, which are accepted
 * for THIS column only (each consumer's wiring lands with the cohort that
 * migrates the consumer — plan §8), but must still name the cohort.
 *
 * USAGE
 *   node scripts/generateWorkflowPathConsumers.mjs             # verify
 *   node scripts/generateWorkflowPathConsumers.mjs --generate  # (re)write, preserving classification
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { toPosix } from "./lib/workflowRouteScan.mjs";
import {
  extractPathConsumerCallSites,
  scanPathConsumers,
  consumerStabilitySha256,
} from "./lib/workflowPathConsumerScan.mjs";
import { verifyFixtureProvenance } from "./lib/fixtureProvenance.mjs";
import {
  readUniverseTsFiles,
  resolveUniverseFiles,
  verifyUniverseDigestPortabilityFixture,
  verifyRecordedUniverseProvenance,
} from "./lib/inventoryUniverse.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const INVENTORY_DIR = path.join(repoRoot, "workflow-inventories");
const BASELINE_PATH = path.join(INVENTORY_DIR, "workflow-path-consumer-baseline-v1.json");
const LIVE_PATH = path.join(INVENTORY_DIR, "workflow-path-consumer-live-v1.json");
const PREGATE_PATH = path.join(INVENTORY_DIR, "workflow-path-consumer-pregate-v1.json");
const ANNOTATIONS_PATH = path.join(INVENTORY_DIR, "workflow-path-consumer-annotations-v1.json");
const SOURCE_UNIVERSE_PATH = path.join(INVENTORY_DIR, "workflow-production-source-baseline-v1.json");

/**
 * Sink categories from plan §2.3's enumeration. Every row's sinkCategories
 * must be a non-empty subset.
 */
const KNOWN_SINK_CATEGORIES = new Set([
  "contextPack",
  "taskScan",
  "backupCopy",
  "logAttachment",
  "gitStaging",
  "folderEnumeration",
  "providerPromptAttachment",
  "artifactReadWrite",
  "stateStore",
  "processSpawn",
  "diagnostics",
  "uiNavigation",
]);

const KNOWN_COHORTS = new Set([
  "baseline", "safety", "lmIsolation", "runnerV1", "foundations", "privacy",
  "chat", "text1", "text2", "text3", "lifecycle", "creation", "resume",
  "edit", "git", "cleanup", "nonPlan",
]);

const PREGATE_CONSUMER_ANNOTATION_KINDS = new Set([
  "pregateAddedConsumer", "pregateRemovedConsumer", "pregateModifiedConsumer",
]);

const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  console.error(`✘ [workflowPathConsumers] ${message}`);
  process.exitCode = 1;
}

const HUMAN_FIELDS = ["sinkCategories", "pathSource", "expectedHandling", "classifierCall", "migrationCohort"];

function loadJsonIfExists(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

/** Structural validation of every annotation entry (plan §1.5-style evidence contract, applied to §2.3). */
function validateAnnotations(annotations, record) {
  const entries = annotations?.annotations || [];
  for (const entry of entries) {
    const label = `${entry.annotationKind}:${entry.path ?? "?"}`;
    for (const field of ["annotationKind", "path", "planSection", "rationale", "owner", "cohort", "expiryCohort"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        record(`Path-consumer annotation ${label} is missing required field "${field}" (workflow-path-consumer-annotation-v1.schema.json).`);
      }
    }
    if (!KNOWN_COHORTS.has(entry.cohort)) {
      record(`Path-consumer annotation ${label} has unknown cohort ${JSON.stringify(entry.cohort)}.`);
    }
    if (!KNOWN_COHORTS.has(entry.expiryCohort)) {
      record(`Path-consumer annotation ${label} has unknown expiryCohort ${JSON.stringify(entry.expiryCohort)}.`);
    }
    if (entry.annotationKind !== "dynamicPathConsumption" && !PREGATE_CONSUMER_ANNOTATION_KINDS.has(entry.annotationKind)) {
      record(`Path-consumer annotation ${label} has unknown annotationKind ${JSON.stringify(entry.annotationKind)}.`);
    }
    const evidence = entry.evidence;
    if (typeof evidence !== "object" || evidence === null) {
      record(`Path-consumer annotation ${label} is missing its required "evidence" object.`);
      continue;
    }
    for (const field of ["symbol", "sourceSpan", "edgeKind", "targetActionKey"]) {
      if (typeof evidence[field] !== "string" || evidence[field].length === 0) {
        record(`Path-consumer annotation ${label} must carry evidence.${field} (plan §1.5 evidence contract).`);
      }
    }
    if (
      (entry.annotationKind === "pregateAddedConsumer" || entry.annotationKind === "pregateModifiedConsumer") &&
      !SHA256_RE.test(evidence.liveStabilitySha256 || "")
    ) {
      record(`Path-consumer annotation ${label} must carry evidence.liveStabilitySha256.`);
    }
    if (
      (entry.annotationKind === "pregateRemovedConsumer" || entry.annotationKind === "pregateModifiedConsumer") &&
      !SHA256_RE.test(evidence.pregateStabilitySha256 || "")
    ) {
      record(`Path-consumer annotation ${label} must carry evidence.pregateStabilitySha256.`);
    }
  }
  return entries;
}

/**
 * Every consumer that can spawn a process is unresolved dynamic path
 * consumption (plan §2.3: "Unresolved dynamic path consumption fails
 * verification") — it must carry a "dynamicPathConsumption" annotation whose
 * evidence.sourceSpan still matches a live child_process call site.
 */
function verifyDynamicConsumptionAnnotations({ consumers, entries, record }) {
  const dynamicEntriesByPath = new Map(
    entries.filter((e) => e.annotationKind === "dynamicPathConsumption").map((e) => [e.path, e])
  );
  const spawnCapable = consumers.filter((c) => c.signals.includes("import:child_process"));
  for (const consumer of spawnCapable) {
    const entry = dynamicEntriesByPath.get(consumer.path);
    if (!entry) {
      record(
        `${consumer.path} imports child_process (spawned processes consume paths the scanner cannot resolve) but has ` +
          `no "dynamicPathConsumption" annotation in ${toPosix(path.relative(repoRoot, ANNOTATIONS_PATH))} — unresolved ` +
          `dynamic path consumption fails closed without recorded §1.5 evidence (plan §2.3).`
      );
      continue;
    }
    dynamicEntriesByPath.delete(consumer.path);
    const liveSpans = consumer.callSites.filter((s) => s.signal === "import:child_process").map((s) => s.span);
    if (entry.evidence?.sourceSpan && !liveSpans.includes(entry.evidence.sourceSpan)) {
      record(
        `dynamicPathConsumption annotation for ${consumer.path} carries stale evidence.sourceSpan ` +
          `${JSON.stringify(entry.evidence.sourceSpan)} (live child_process site span(s): ${liveSpans.join(", ")}). ` +
          `Re-review the site and update the annotation.`
      );
    }
  }
  for (const [stalePath] of dynamicEntriesByPath) {
    record(`dynamicPathConsumption annotation for ${stalePath} matches no live child_process consumer — remove the stale annotation.`);
  }
}

/**
 * Diffs the live consumer surface against the immutable pre-gate snapshot
 * through the span-independent stability projection (per-signal call-site
 * counts), requiring a recorded annotation with matching digests for every
 * added, removed, or changed consumer.
 */
function verifyPregateDrift({ consumers, entries, record }) {
  if (!fs.existsSync(PREGATE_PATH)) {
    record(
      `No immutable pre-gate consumer snapshot found at ${toPosix(path.relative(repoRoot, PREGATE_PATH))}. Run ` +
        `"node scripts/generatePregateWorkflowInventoryBaselines.mjs" once to establish it, then commit the result. ` +
        `This snapshot is never regenerated by this script.`
    );
    return;
  }
  const pregate = JSON.parse(fs.readFileSync(PREGATE_PATH, "utf8"));
  // Provenance binding: the immutable snapshot records which source-universe
  // JSON it was scanned from and that file's digest at generation time. The
  // recorded digest predates canonical digesting (raw checkout bytes), so
  // the comparison goes through the tolerant line-ending matcher — a genuine
  // content change to the frozen universe file fails; a checkout with a
  // different EOL profile does not.
  verifyRecordedUniverseProvenance({
    rootDir: repoRoot,
    sourceUniverse: pregate.sourceUniverse,
    sourceUniverseSha256: pregate.sourceUniverseSha256,
    label: `Immutable pre-gate consumer snapshot ${toPosix(path.relative(repoRoot, PREGATE_PATH))}`,
    record,
  });
  const liveByPath = new Map(consumers.map((c) => [c.path, c]));
  const pregateByPath = new Map((pregate.consumers || []).map((c) => [c.path, c]));
  const byKindPath = new Map(
    entries.filter((e) => PREGATE_CONSUMER_ANNOTATION_KINDS.has(e.annotationKind)).map((e) => [`${e.annotationKind}:${e.path}`, e])
  );
  const used = new Set();

  const requireDigest = (entry, label, field, expected) => {
    const actual = entry?.evidence?.[field];
    if (SHA256_RE.test(actual || "") && actual !== expected) {
      record(
        `Path-consumer annotation ${label} carries stale evidence: its ${field} (${actual}) does not match the ` +
          `currently computed stability digest (${expected}). Re-review the drift and update the annotation.`
      );
    }
  };

  for (const [consumerPath, consumer] of liveByPath) {
    const pre = pregateByPath.get(consumerPath);
    if (!pre) {
      const key = `pregateAddedConsumer:${consumerPath}`;
      const entry = byKindPath.get(key);
      if (!entry) {
        record(
          `${consumerPath} is a path consumer in the live surface but not in the immutable pre-gate snapshot and has ` +
            `no "pregateAddedConsumer" annotation — every consumer added since the pre-gate snapshot requires recorded evidence.`
        );
      } else {
        used.add(key);
        requireDigest(entry, key, "liveStabilitySha256", consumerStabilitySha256(consumer));
      }
    } else if (consumerStabilitySha256(pre) !== consumerStabilitySha256(consumer)) {
      const key = `pregateModifiedConsumer:${consumerPath}`;
      const entry = byKindPath.get(key);
      if (!entry) {
        record(
          `${consumerPath}'s per-signal call-site profile changed since the immutable pre-gate snapshot ` +
            `(stability digest differs: pre-gate ${consumerStabilitySha256(pre)}, live ${consumerStabilitySha256(consumer)}) ` +
            `but has no "pregateModifiedConsumer" annotation — every new/removed filesystem or process call site since ` +
            `the pre-gate snapshot requires recorded evidence.`
        );
      } else {
        used.add(key);
        requireDigest(entry, key, "pregateStabilitySha256", consumerStabilitySha256(pre));
        requireDigest(entry, key, "liveStabilitySha256", consumerStabilitySha256(consumer));
      }
    }
  }
  for (const [consumerPath, pre] of pregateByPath) {
    if (!liveByPath.has(consumerPath)) {
      const key = `pregateRemovedConsumer:${consumerPath}`;
      const entry = byKindPath.get(key);
      if (!entry) {
        record(
          `${consumerPath} was a path consumer in the immutable pre-gate snapshot but shows no signal in the live ` +
            `surface (or left the production source universe) and has no "pregateRemovedConsumer" annotation.`
        );
      } else {
        used.add(key);
        requireDigest(entry, key, "pregateStabilitySha256", consumerStabilitySha256(pre));
      }
    }
  }
  for (const entry of entries) {
    if (!PREGATE_CONSUMER_ANNOTATION_KINDS.has(entry.annotationKind)) continue;
    const key = `${entry.annotationKind}:${entry.path}`;
    if (!used.has(key)) {
      record(`Path-consumer annotation ${key} matches no current pre-gate drift — remove the stale annotation.`);
    }
  }
}

function validate(baseline, consumers, record) {
  const rows = new Map((baseline.consumers || []).map((c) => [c.path, c]));
  for (const consumer of consumers) {
    const row = rows.get(consumer.path);
    if (!row) {
      record(
        `${consumer.path} shows filesystem/process signals (${consumer.signals.join(", ")}) but has no consumer row — ` +
          `every production path consumer must be recorded with sink categories, path source, expected handling, and ` +
          `a migration cohort (plan §2.3). Re-run with --generate and classify the new row.`
      );
      continue;
    }
    for (const mechanicalField of ["signals", "callSites"]) {
      if (JSON.stringify(row[mechanicalField]) !== JSON.stringify(consumer[mechanicalField])) {
        record(
          `${consumer.path}: recorded ${mechanicalField} are stale (baseline: ${JSON.stringify(row[mechanicalField])}; ` +
            `live: ${JSON.stringify(consumer[mechanicalField])}). Re-run with --generate and re-review the row.`
        );
      }
    }
    if (!Array.isArray(row.sinkCategories) || row.sinkCategories.length === 0) {
      record(`${consumer.path}: sinkCategories must be a non-empty array of known categories (plan §2.3).`);
    } else {
      for (const category of row.sinkCategories) {
        if (!KNOWN_SINK_CATEGORIES.has(category)) {
          record(`${consumer.path}: unknown sink category ${JSON.stringify(category)}.`);
        }
      }
    }
    for (const field of ["pathSource", "expectedHandling", "classifierCall", "migrationCohort"]) {
      const value = row[field];
      if (typeof value !== "string" || value.length === 0) {
        record(`${consumer.path}: classification field "${field}" must be non-empty (plan §2.3 row contract).`);
        continue;
      }
      if (value.startsWith("pending:")) {
        // classifierCall is the one column allowed to stay pending: the
        // classifier module exists (Privacy cohort), but each consumer's
        // call is wired by the cohort that migrates the consumer (plan §8),
        // and the marker must name the privacy contract explicitly.
        // Everything else must be assigned now.
        const named = value.slice("pending:".length).split(/[\s—]/, 1)[0];
        if (field !== "classifierCall") {
          record(`${consumer.path}: classification field "${field}" is still ${JSON.stringify(value)} — assign it.`);
        } else if (named !== "privacy") {
          record(`${consumer.path}: classifierCall pending marker must name the privacy cohort ("pending:privacy — …"), found ${JSON.stringify(value)}.`);
        }
      }
      if (field === "migrationCohort" && !value.startsWith("pending:") && !KNOWN_COHORTS.has(value)) {
        record(`${consumer.path}: migrationCohort ${JSON.stringify(value)} is not a known cohort (plan §8).`);
      }
    }
  }
  const livePaths = new Set(consumers.map((c) => c.path));
  for (const [rowPath] of rows) {
    if (!livePaths.has(rowPath)) {
      record(`Consumer row ${rowPath} no longer shows any filesystem/process signal — remove the stale row.`);
    }
  }
}

/**
 * Extractor self-test against the checked-in fixtures
 * (test-fixtures/workflow-path-consumers/**). Runs on every invocation: the
 * positive fixture must yield exactly the three signal kinds as three
 * concrete call sites with spans and enclosing symbols, and the clean
 * fixture (a non-fs `.fs` property name plus a node:path import) must yield
 * none — so the extractor can neither under- nor over-match silently.
 */
function runExtractorSelfTest(record) {
  const fixtureDir = path.join(repoRoot, "test-fixtures", "workflow-path-consumers");
  const positive = extractPathConsumerCallSites(path.join(fixtureDir, "fsConsumer.fixture.ts"));
  const positiveKinds = [...new Set(positive.map((s) => s.signal))].sort();
  if (JSON.stringify(positiveKinds) !== JSON.stringify(["import:child_process", "import:fs", "workspace.fs"])) {
    record(
      `Extractor self-test failed on fsConsumer.fixture.ts: expected signal kinds ["import:child_process","import:fs","workspace.fs"], ` +
        `got ${JSON.stringify(positiveKinds)}.`
    );
  }
  if (positive.length !== 3 || positive.some((s) => !/^L\d+-L\d+$/.test(s.span) || typeof s.enclosingSymbol !== "string")) {
    record(
      `Extractor self-test failed on fsConsumer.fixture.ts: expected exactly three call sites, each with a compiler span ` +
        `and enclosing symbol, got ${JSON.stringify(positive)}.`
    );
  }
  const negative = extractPathConsumerCallSites(path.join(fixtureDir, "clean.fixture.ts"));
  if (negative.length !== 0) {
    record(`Extractor self-test failed on clean.fixture.ts: expected no call sites, got ${JSON.stringify(negative)}.`);
  }
}

function main() {
  const generate = process.argv.includes("--generate");
  const failures = [];
  const record = (m) => { failures.push(m); fail(m); };
  runExtractorSelfTest(record);
  // Fixture-provenance gate (plan §3.10's checked-in evidence-base rule,
  // extended to this tree per the implementation review): every extractor
  // self-test fixture must carry a README row recording the extraction rule
  // it pins, bidirectionally and fail-closed, on every verify and generate
  // run — so a fixture cannot be added or dropped without its record.
  verifyFixtureProvenance({
    repoRoot,
    fixturesDir: path.join(repoRoot, "test-fixtures", "workflow-path-consumers"),
    fixtureFileRe: /\.fixture\.ts$/,
    fixtureFileDescription: ".fixture.ts",
    layout: "flat",
    record,
  });
  // sourceUniverseSha256 provenance must be checkout-line-ending-independent
  // (implementation-review blocker): prove it from the checked-in fixture
  // before any inventory evidence is written or compared.
  verifyUniverseDigestPortabilityFixture(record);

  let universe;
  try {
    universe = readUniverseTsFiles(SOURCE_UNIVERSE_PATH);
  } catch (e) {
    record(String(e.message ?? e));
    fail(`workflowPathConsumers: ${failures.length} check(s) failed.`);
    return;
  }
  const scanFiles = resolveUniverseFiles(repoRoot, universe.files, record);
  const consumers = scanPathConsumers({ repoRoot, files: scanFiles });

  const annotations = loadJsonIfExists(ANNOTATIONS_PATH);
  const annotationEntries = validateAnnotations(annotations, record);

  const live = {
    schemaVersion: 1,
    generatedBy: "scripts/generateWorkflowPathConsumers.mjs",
    description:
      "Mechanically derived production path-consumer surface of the current working tree (plan §2.3): every module of " +
      "the §1.1 production source universe importing node fs/child_process or touching the vscode workspace.fs API, " +
      "with every concrete call site (compiler span + enclosing symbol). Scanned over the exact source-universe file " +
      "list — never a filesystem walk. Regenerated every run; classification lives in " +
      "workflow-path-consumer-baseline-v1.json; the immutable pre-gate reference is " +
      "workflow-path-consumer-pregate-v1.json. Known mechanical bound: modules that only pass path STRINGS to another " +
      "module (no fs/process API of their own) are covered transitively by the consumer module they call — the " +
      "classifier enforcement point (plan §2.2) sits at the API-touching module. sourceUniverseSha256 is the CANONICAL " +
      "(line-ending-independent) digest of the source-universe JSON, so provenance is identical across LF and CRLF " +
      "checkouts.",
    sourceUniverse: "workflow-inventories/workflow-production-source-baseline-v1.json",
    sourceUniverseSha256: universe.universeSha256,
    consumerCount: consumers.length,
    consumers,
  };
  fs.mkdirSync(INVENTORY_DIR, { recursive: true });
  fs.writeFileSync(LIVE_PATH, JSON.stringify(live, null, 2) + "\n", "utf8");

  verifyDynamicConsumptionAnnotations({ consumers, entries: annotationEntries, record });
  verifyPregateDrift({ consumers, entries: annotationEntries, record });

  const existing = loadJsonIfExists(BASELINE_PATH) ?? { consumers: [] };

  if (generate) {
    if (failures.length > 0) {
      console.error(
        `✘ Refusing to (re)write ${toPosix(path.relative(repoRoot, BASELINE_PATH))}: ${failures.length} check(s) above ` +
          `failed (extractor self-test, source-universe resolution, missing dynamic-consumption evidence, or ` +
          `undocumented pre-gate drift). Fix them before regenerating the baseline.`
      );
      process.exitCode = 1;
      return;
    }
    const prior = new Map((existing.consumers || []).map((c) => [c.path, c]));
    const inventory = {
      schemaVersion: 1,
      description:
        "Non-AI path-consumer inventory (plan §2.3): one classified row per production module that can discover, " +
        "read, copy, log, attach, back up, stage, or serialize task/workflow paths. The mechanical columns " +
        "(`signals`, per-call-site `callSites` with compiler spans) are regenerated by " +
        "scripts/generateWorkflowPathConsumers.mjs --generate over the exact §1.1 source universe and diffed against " +
        "the live scan; sinkCategories, pathSource, expectedHandling, classifierCall, and migrationCohort are " +
        "human-authored and preserved across regeneration. The immutable pre-gate reference lives in " +
        "workflow-path-consumer-pregate-v1.json; drift from it requires annotations in " +
        "workflow-path-consumer-annotations-v1.json, child_process consumers require dynamicPathConsumption " +
        "annotations, and verify:workflow-path-consumers fails on any unclassified, stale, or missing row and on any " +
        "unknown sink category or cohort.",
      consumers: consumers.map((consumer) => {
        const previous = prior.get(consumer.path);
        return {
          path: consumer.path,
          signals: consumer.signals,
          callSites: consumer.callSites,
          sinkCategories: previous?.sinkCategories ?? [],
          pathSource: previous?.pathSource ?? "pending:unassigned",
          expectedHandling: previous?.expectedHandling ?? "pending:unassigned",
          classifierCall: previous?.classifierCall ?? "pending:privacy — call site to be assigned with the classifier (plan §2.2)",
          migrationCohort: previous?.migrationCohort ?? "pending:unassigned",
        };
      }),
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(inventory, null, 2) + "\n", "utf8");
    console.log(
      `✓ Wrote ${toPosix(path.relative(repoRoot, BASELINE_PATH))}: ${inventory.consumers.length} consumer row(s). ` +
        `New rows carry pending markers that verification rejects until classified.`
    );
    validate(inventory, consumers, record);
    if (failures.length > 0) {
      fail(`${failures.length} row(s) still need classification (see above).`);
    }
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    fail(`${toPosix(path.relative(repoRoot, BASELINE_PATH))} does not exist. Run with --generate once, classify the rows, and commit it.`);
    return;
  }
  validate(existing, consumers, record);
  if (failures.length === 0) {
    console.log(
      `✓ workflowPathConsumers: ${consumers.length} production path consumer(s) (${consumers.reduce((n, c) => n + c.callSites.length, 0)} ` +
        `call site(s)) verified against the checked-in inventory and the immutable pre-gate snapshot.`
    );
  } else {
    fail(`workflowPathConsumers: ${failures.length} check(s) failed.`);
  }
}

main();
