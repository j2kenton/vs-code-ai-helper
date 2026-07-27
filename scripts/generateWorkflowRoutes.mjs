#!/usr/bin/env node
/**
 * Workflow route inventory generator/verifier (plan §1.2, Executable Order
 * step 1).
 *
 * ARCHITECTURE (mirrors resolveProductionSourceUniverse.mjs)
 * ----------------------------------------------------------
 *  - `workflow-route-pregate-v1.json` is the IMMUTABLE pre-gate route
 *    surface, generated exactly once by
 *    scripts/generatePregateWorkflowInventoryBaselines.mjs against the
 *    commit predating this plan's changes, and never written by this script.
 *    Every route added, removed, or mechanically changed since that snapshot
 *    (compared through the span-independent stability projection in
 *    scripts/lib/workflowRouteScan.mjs, so pure line drift never counts)
 *    must carry a pregateAddedRoute / pregateRemovedRoute /
 *    pregateModifiedRoute annotation in workflow-route-annotations-v1.json
 *    with matching stability digests — undocumented drift from the immutable
 *    baseline fails closed, and `--generate` refuses to run while it exists,
 *    so regeneration can never launder unannotated changes into the
 *    checked-in baseline.
 *  - `workflow-route-baseline-v1.json` is the regenerable, currently
 *    accepted AND CLASSIFIED inventory: the mechanical surface is extracted
 *    with the repository-pinned TypeScript compiler and can never be
 *    hand-edited (verification diffs it against the live scan); the
 *    classification columns the plan requires per concrete route row are
 *    human-authored, preserved across `--generate`, and stubbed with
 *    explicit "pending:unassigned" markers that verification rejects.
 *  - `workflow-route-live-v1.json` is regenerated unconditionally every run.
 *
 * SOURCE-UNIVERSE ANCHORING (plan §1.1): the scan consumes the exact file
 * list of workflow-production-source-baseline-v1.json — never a filesystem
 * walk — so it cannot independently expand or filter the production source
 * universe.
 *
 * CONCRETE ROUTE ROWS (plan §1.2): one classified row per registered
 * command, webview message root, internal executeCommand edge (the
 * scheduler / auto-advance / follow-up / wrapper edges, each with an
 * explicit edgeRole), provider-boundary call site (resolveRunnerForModel /
 * runImplementationForModel — the only two provider-invocation paths), and
 * legacy output destination (outputFile/outputFileUri protocol bindings —
 * the provider-to-writer edges, each with an explicit artifactClass).
 *
 * FAIL-CLOSED RULES (plan §1.2)
 *  - A `registerCommand` call whose command ID is not a string literal fails
 *    unconditionally ("unresolved computed command IDs").
 *  - The same command ID registered from two different call sites fails
 *    ("ambiguous callbacks").
 *  - An `executeCommand` call whose command argument is not a string literal
 *    is a dynamic dispatch site and fails unless covered by an annotation in
 *    workflow-route-annotations-v1.json carrying the full §1.5 evidence set
 *    whose recorded span still matches the live span.
 *  - An internal edge or tree-item binding that targets an unregistered
 *    command ID fails unless annotated as "unregisteredCommandTarget".
 *  - A contributed command with no registration, or a menu entry referencing
 *    an uncontributed command, fails.
 *  - A row whose targetActionKey names a question/edit-capable action family
 *    must mechanically carry that family's legacy AI gate call in its
 *    declared gate file, proving gate placement rather than asserting it.
 *  - Every registry target the plan's route table requires
 *    (REQUIRED_TARGET_ACTION_KEYS) must appear on at least one concrete
 *    route ROW — a mechanical gate call alone never satisfies coverage.
 *  - A removed route (workflow-route-removals-v1.json) fails if it
 *    reappears in the live scan.
 *  - Unannotated drift from the immutable pre-gate snapshot fails.
 *
 * USAGE
 *   node scripts/generateWorkflowRoutes.mjs             # verify everything
 *   node scripts/generateWorkflowRoutes.mjs --generate  # (re)write baseline, preserving classification
 *   node scripts/generateWorkflowRoutes.mjs --live         # live-scan checks only (mechanical surface + baseline/pregate drift)
 *   node scripts/generateWorkflowRoutes.mjs --annotations  # annotation coverage/staleness checks only
 *   node scripts/generateWorkflowRoutes.mjs --removals     # removal-evidence checks only
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import {
  scanWorkflowRouteSurface,
  scanSourceFileForRoutes,
  buildMechanicalRouteRows,
  routeKeyOf,
  routeStabilitySha256,
  toPosix,
  COMMAND_ID_PREFIX,
} from "./lib/workflowRouteScan.mjs";
import {
  readUniverseTsFiles,
  resolveUniverseFiles,
  verifyUniverseDigestPortabilityFixture,
  verifyRecordedUniverseProvenance,
} from "./lib/inventoryUniverse.mjs";
import { verifyFixtureProvenance } from "./lib/fixtureProvenance.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const packageJson = require(path.join(repoRoot, "package.json"));

const INVENTORY_DIR = path.join(repoRoot, "workflow-inventories");
const BASELINE_PATH = path.join(INVENTORY_DIR, "workflow-route-baseline-v1.json");
const LIVE_PATH = path.join(INVENTORY_DIR, "workflow-route-live-v1.json");
const PREGATE_PATH = path.join(INVENTORY_DIR, "workflow-route-pregate-v1.json");
const ANNOTATIONS_PATH = path.join(INVENTORY_DIR, "workflow-route-annotations-v1.json");
const REMOVALS_PATH = path.join(INVENTORY_DIR, "workflow-route-removals-v1.json");
const SOURCE_UNIVERSE_PATH = path.join(INVENTORY_DIR, "workflow-production-source-baseline-v1.json");

const KNOWN_COHORTS = new Set([
  "baseline", "safety", "lmIsolation", "runnerV1", "foundations", "privacy",
  "chat", "text1", "text2", "text3", "lifecycle", "creation", "resume",
  "edit", "git", "cleanup", "nonPlan",
]);

/** Edge roles for internalEdge rows (plan §1.2's scheduler/auto-advance/follow-up/tree classification). */
const KNOWN_EDGE_ROLES = new Set([
  "scheduler", "autoAdvance", "followUp", "wrapperDelegation", "uiNavigation", "userPromptAction", "recovery",
]);

/** Destination classes for writerEdge rows. */
const KNOWN_ARTIFACT_CLASSES = new Set([
  "taskArtifact", "runsLog", "stagedTemp", "resultEcho", "globalStorage",
]);

const PREGATE_ROUTE_ANNOTATION_KINDS = new Set([
  "pregateAddedRoute", "pregateRemovedRoute", "pregateModifiedRoute",
]);

/**
 * Registry targets the plan's §1.2 route table requires to be present on at
 * least one concrete route row. "none" (a pure-UI/non-product route) never
 * satisfies a required target, and neither does a bare gate call — coverage
 * comes from classified rows only.
 */
const REQUIRED_TARGET_ACTION_KEYS = [
  "draft.v1",
  "generatePlan.v1",
  "generateImplementation.v1",
  "review.v1",
  "applyReview.v1",
  "fastForward.v1",
  "implementation.v1",
  "applyCurrentStage.v1",
  "lint.v1",
  "chatSend.v1",
  "commitPush.v1",
  "nextStage.v1",
  "markTaskDone.v1",
  "resumeTask.v1",
  "taskCreationLifecycle.v1",
];

/**
 * targetActionKey -> the legacy AI gate route id (legacyAiActionSafetyGateV0)
 * that must be mechanically present in the row's declared gate file. Targets
 * not listed here are non-AI routes and carry gateLocation "none" with a
 * rationale in their descriptive fields.
 */
const GATE_ROUTE_ID_BY_TARGET = new Map([
  ["draft.v1", "draft.v1"],
  ["generatePlan.v1", "generatePlan.v1"],
  ["review.v1", "review.v1"],
  ["applyReview.v1", "applyReview.v1"],
  ["fastForward.v1", "fastForward.v1"],
  ["generateImplementation.v1", "generateImplementation.v1"],
  ["implementation.v1", "implementation.v1"],
  ["applyCurrentStage.v1", "applyCurrentStage.v1"],
  ["lint.v1", "lint.v1"],
  ["chatSend.v1", "chatSend.v1"],
  ["commitPush.v1", "commitPushMetadata.v1"],
]);

const TARGET_ACTION_KEY_RE = /^[a-z][A-Za-z0-9]*\.v1$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Classification columns per row kind. Command/webview roots keep the plan's
 * full route-row contract; edge rows carry the fields that are meaningful
 * for an edge (role/destination class, description, target, gate, cohort).
 */
const CLASSIFICATION_FIELDS_BY_KIND = {
  command: ["entrypoint", "earliestRead", "providerEdge", "writerEdge", "targetActionKey", "gateLocation", "migrationCohort"],
  webviewMessage: ["entrypoint", "earliestRead", "providerEdge", "writerEdge", "targetActionKey", "gateLocation", "migrationCohort"],
  internalEdge: ["edgeRole", "description", "targetActionKey", "gateLocation", "migrationCohort"],
  providerEdge: ["description", "targetActionKey", "gateLocation", "migrationCohort"],
  writerEdge: ["description", "artifactClass", "targetActionKey", "gateLocation", "migrationCohort"],
};

function fail(message) {
  console.error(`✘ [workflowRoutes] ${message}`);
  process.exitCode = 1;
}

function isPendingMarker(value) {
  return typeof value === "string" && value.startsWith("pending:");
}

function loadJsonIfExists(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

function validateAnnotationEntry(entry, record) {
  const label = `${entry.annotationKind}:${entry.routeKey ?? entry.path ?? entry.commandId ?? "?"}`;
  for (const field of ["annotationKind", "planSection", "rationale", "owner", "cohort", "expiryCohort"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      record(`Route annotation ${label} is missing required field "${field}" (workflow-route-annotation-v1.schema.json).`);
    }
  }
  if (!KNOWN_COHORTS.has(entry.cohort)) {
    record(`Route annotation ${label} has unknown cohort ${JSON.stringify(entry.cohort)}.`);
  }
  if (!KNOWN_COHORTS.has(entry.expiryCohort)) {
    record(`Route annotation ${label} has unknown expiryCohort ${JSON.stringify(entry.expiryCohort)}.`);
  }
  const evidence = entry.evidence;
  if (typeof evidence !== "object" || evidence === null) {
    record(`Route annotation ${label} is missing its required "evidence" object.`);
  } else {
    for (const field of ["symbol", "sourceSpan", "edgeKind", "targetActionKey"]) {
      if (typeof evidence[field] !== "string" || evidence[field].length === 0) {
        record(`Route annotation ${label} must carry evidence.${field} (plan §1.5 evidence contract).`);
      }
    }
    if (PREGATE_ROUTE_ANNOTATION_KINDS.has(entry.annotationKind)) {
      if (typeof entry.routeKey !== "string" || entry.routeKey.length === 0) {
        record(`Route annotation ${label} must carry the exact routeKey of the drifted row.`);
      }
      if (
        (entry.annotationKind === "pregateAddedRoute" || entry.annotationKind === "pregateModifiedRoute") &&
        !SHA256_RE.test(evidence.liveStabilitySha256 || "")
      ) {
        record(`Route annotation ${label} must carry evidence.liveStabilitySha256 (stability digest of the live row it was reviewed against).`);
      }
      if (
        (entry.annotationKind === "pregateRemovedRoute" || entry.annotationKind === "pregateModifiedRoute") &&
        !SHA256_RE.test(evidence.pregateStabilitySha256 || "")
      ) {
        record(`Route annotation ${label} must carry evidence.pregateStabilitySha256 (stability digest of the pre-gate row).`);
      }
    }
  }
  return label;
}

/**
 * Diffs the live mechanical route surface against the immutable pre-gate
 * snapshot through the span-independent stability projection, requiring a
 * recorded annotation with matching digests for every added, removed, or
 * changed route (plan §1.2 immutable-baseline architecture). Reports through
 * `record`; the caller decides whether the failures block `--generate`.
 */
function verifyPregateDrift({ liveRows, annotations, record }) {
  if (!fs.existsSync(PREGATE_PATH)) {
    record(
      `No immutable pre-gate route snapshot found at ${toPosix(path.relative(repoRoot, PREGATE_PATH))}. Run ` +
        `"node scripts/generatePregateWorkflowInventoryBaselines.mjs" once (against the frozen pre-gate commit) to ` +
        `establish it, then commit the result. This snapshot is never regenerated by this script.`
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
    label: `Immutable pre-gate route snapshot ${toPosix(path.relative(repoRoot, PREGATE_PATH))}`,
    record,
  });
  const liveByKey = new Map(liveRows.map((r) => [routeKeyOf(r), r]));
  const pregateByKey = new Map((pregate.routes || []).map((r) => [routeKeyOf(r), r]));

  const pregateEntries = (annotations?.annotations || []).filter((a) => PREGATE_ROUTE_ANNOTATION_KINDS.has(a.annotationKind));
  const byKindKey = new Map(pregateEntries.map((e) => [`${e.annotationKind}:${e.routeKey}`, e]));
  const usedAnnotationKeys = new Set();

  const requireDigest = (entry, label, field, expected) => {
    const actual = entry?.evidence?.[field];
    if (SHA256_RE.test(actual || "") && actual !== expected) {
      record(
        `Route annotation ${label} carries stale evidence: its ${field} (${actual}) does not match the currently ` +
          `computed stability digest (${expected}). Re-review the drift and update the annotation.`
      );
    }
  };

  for (const [key, row] of liveByKey) {
    const pre = pregateByKey.get(key);
    if (!pre) {
      const annotationKey = `pregateAddedRoute:${key}`;
      const entry = byKindKey.get(annotationKey);
      if (!entry) {
        record(
          `Route ${key} exists in the live surface but not in the immutable pre-gate snapshot and has no ` +
            `"pregateAddedRoute" annotation in ${toPosix(path.relative(repoRoot, ANNOTATIONS_PATH))} — every route added ` +
            `since the pre-gate snapshot requires recorded evidence (cohort + rationale + owner + stability digest).`
        );
      } else {
        usedAnnotationKeys.add(annotationKey);
        requireDigest(entry, annotationKey, "liveStabilitySha256", routeStabilitySha256(row));
      }
    } else if (routeStabilitySha256(pre) !== routeStabilitySha256(row)) {
      const annotationKey = `pregateModifiedRoute:${key}`;
      const entry = byKindKey.get(annotationKey);
      if (!entry) {
        record(
          `Route ${key} mechanically changed since the immutable pre-gate snapshot (span-independent stability digest ` +
            `differs: pre-gate ${routeStabilitySha256(pre)}, live ${routeStabilitySha256(row)}) but has no ` +
            `"pregateModifiedRoute" annotation — every mechanical route change (gate installed, edge/menu/binding ` +
            `changed, registration moved) requires recorded evidence.`
        );
      } else {
        usedAnnotationKeys.add(annotationKey);
        requireDigest(entry, annotationKey, "pregateStabilitySha256", routeStabilitySha256(pre));
        requireDigest(entry, annotationKey, "liveStabilitySha256", routeStabilitySha256(row));
      }
    }
  }
  for (const [key, pre] of pregateByKey) {
    if (!liveByKey.has(key)) {
      const annotationKey = `pregateRemovedRoute:${key}`;
      const entry = byKindKey.get(annotationKey);
      if (!entry) {
        record(
          `Route ${key} existed in the immutable pre-gate snapshot but is gone from the live surface and has no ` +
            `"pregateRemovedRoute" annotation — every route removed since the pre-gate snapshot requires recorded evidence.`
        );
      } else {
        usedAnnotationKeys.add(annotationKey);
        requireDigest(entry, annotationKey, "pregateStabilitySha256", routeStabilitySha256(pre));
      }
    }
  }
  for (const entry of pregateEntries) {
    const annotationKey = `${entry.annotationKind}:${entry.routeKey}`;
    if (!usedAnnotationKeys.has(annotationKey)) {
      record(`Route annotation ${annotationKey} matches no current pre-gate drift — remove the stale annotation.`);
    }
  }
}

function verifyAgainstScan({ scan, roots, baseline, annotations, removals, record, scope }) {
  const checkLive = scope.all || scope.live;
  const checkAnnotations = scope.all || scope.annotations;
  const checkRemovals = scope.all || scope.removals;

  // --- mechanical fail-closed rules -------------------------------------
  if (checkLive) {
    for (const unresolved of scan.unresolvedRegistrations) {
      record(
        `Unresolved computed command ID at ${unresolved.path}#${unresolved.span}: registerCommand(${unresolved.expressionText}, …). ` +
          `Every command registration must use a string-literal ID (plan §1.2).`
      );
    }
    const registrationsById = new Map();
    for (const registration of scan.commandRegistrations) {
      if (!registrationsById.has(registration.commandId)) registrationsById.set(registration.commandId, []);
      registrationsById.get(registration.commandId).push(registration);
    }
    for (const [commandId, sites] of registrationsById) {
      if (sites.length > 1) {
        record(
          `Command ${commandId} is registered from ${sites.length} call sites (${sites
            .map((s) => `${s.path}#${s.span}`)
            .join(", ")}) — ambiguous callback (plan §1.2).`
        );
      }
    }
    for (const commandId of scan.contributedCommands) {
      if (!registrationsById.has(commandId)) {
        record(`Contributed command ${commandId} (package.json contributes.commands) has no registerCommand call in production sources.`);
      }
    }
    for (const [commandId] of scan.menuReferences) {
      if (!scan.contributedCommands.has(commandId)) {
        record(`Menu contribution references command ${commandId}, which is not in package.json contributes.commands.`);
      }
    }
    // Every internal edge / tree binding must target a registered command,
    // unless annotated as a known unregistered target (e.g. auto-registered
    // view `.focus` commands).
    const annotatedUnregisteredTargets = new Set(
      (annotations?.annotations || [])
        .filter((a) => a.annotationKind === "unregisteredCommandTarget")
        .map((a) => a.commandId)
    );
    const edgeLikeTargets = [
      ...scan.commandEdges.map((e) => ({ commandId: e.commandId, where: `${e.path}#${e.span}` })),
      ...scan.commandReferences.map((r) => ({ commandId: r.commandId, where: `${r.path}#${r.span}` })),
    ];
    for (const target of edgeLikeTargets) {
      if (!registrationsById.has(target.commandId) && !annotatedUnregisteredTargets.has(target.commandId)) {
        record(
          `Internal reference to unregistered command ${target.commandId} at ${target.where}. Register it or record an ` +
            `"unregisteredCommandTarget" annotation with rationale in workflow-route-annotations-v1.json.`
        );
      }
    }

    // --- immutable pre-gate drift accounting -----------------------------
    verifyPregateDrift({ liveRows: roots, annotations, record });
  }

  // --- baseline row coverage + classification ----------------------------
  if (checkLive) {
    if (!baseline) {
      record(`No baseline found at ${toPosix(path.relative(repoRoot, BASELINE_PATH))}. Run with --generate once, classify the stubbed rows, and commit it.`);
    } else {
      const baselineRows = new Map((baseline.routes || []).map((r) => [routeKeyOf(r), r]));
      const liveKeys = new Set(roots.map((r) => routeKeyOf(r)));
      for (const root of roots) {
        const key = routeKeyOf(root);
        const row = baselineRows.get(key);
        if (!row) {
          record(`${key} exists in the live scan but has no baseline row — re-run with --generate and classify the new route (plan §1.2).`);
          continue;
        }
        for (const mechanicalField of Object.keys(root)) {
          if (JSON.stringify(row[mechanicalField]) !== JSON.stringify(root[mechanicalField])) {
            record(
              `${key}: baseline mechanical field "${mechanicalField}" is stale (baseline: ${JSON.stringify(row[mechanicalField])}; ` +
                `live: ${JSON.stringify(root[mechanicalField])}). Re-run with --generate and re-review the row.`
            );
          }
        }
        const classificationFields = CLASSIFICATION_FIELDS_BY_KIND[root.kind] ?? [];
        for (const field of classificationFields) {
          const value = row[field];
          if (typeof value !== "string" || value.length === 0) {
            record(`${key}: classification field "${field}" must be a non-empty value (plan §1.2 route-row contract).`);
            continue;
          }
          if (field === "migrationCohort" && !KNOWN_COHORTS.has(value)) {
            record(`${key}: migrationCohort ${JSON.stringify(value)} is not a known cohort (plan §8).`);
          }
          if (field === "targetActionKey" && value !== "none" && !TARGET_ACTION_KEY_RE.test(value)) {
            record(`${key}: targetActionKey ${JSON.stringify(value)} must be "none" or match ${TARGET_ACTION_KEY_RE}.`);
          }
          if (field === "edgeRole" && !KNOWN_EDGE_ROLES.has(value)) {
            record(`${key}: edgeRole ${JSON.stringify(value)} is not a known edge role (${[...KNOWN_EDGE_ROLES].join(", ")}).`);
          }
          if (field === "artifactClass" && !KNOWN_ARTIFACT_CLASSES.has(value)) {
            record(`${key}: artifactClass ${JSON.stringify(value)} is not a known destination class (${[...KNOWN_ARTIFACT_CLASSES].join(", ")}).`);
          }
          if (isPendingMarker(value)) {
            record(`${key}: classification field "${field}" is still ${JSON.stringify(value)} — assign it before the inventory can verify.`);
          }
        }
        // Gate-placement proof for question/edit-capable targets, on every
        // row kind that carries such a target.
        const gateRouteId = GATE_ROUTE_ID_BY_TARGET.get(row.targetActionKey);
        if (gateRouteId) {
          if (typeof row.gateLocation !== "string" || row.gateLocation === "none") {
            record(`${key}: targetActionKey ${row.targetActionKey} is a gated AI action family but gateLocation is ${JSON.stringify(row.gateLocation)}.`);
          } else {
            const gatePresent = scan.gateCalls.some(
              (g) => g.path === row.gateLocation && g.routeId === gateRouteId
            );
            if (!gatePresent) {
              record(
                `${key}: gateLocation ${row.gateLocation} does not mechanically contain a legacy AI gate call for route id ` +
                  `${JSON.stringify(gateRouteId)} (assertLegacyAiRouteAllowedV0/isLegacyAiRouteDisabledV0).`
              );
            }
          }
        }
      }
      for (const [key] of baselineRows) {
        if (!liveKeys.has(key)) {
          record(`Baseline row ${key} no longer exists in the live scan — remove the row or record it in workflow-route-removals-v1.json.`);
        }
      }
      // Required registry-target coverage (plan §1.2's table). Coverage
      // comes from classified route rows ONLY — a mechanical gate call
      // without a row can never satisfy a required target (a gate proves a
      // route is disabled, not that the route surface accounts for it).
      const presentTargets = new Set((baseline.routes || []).map((r) => r.targetActionKey));
      for (const required of REQUIRED_TARGET_ACTION_KEYS) {
        if (!presentTargets.has(required)) {
          record(
            `Required registry action key ${JSON.stringify(required)} appears on no concrete route row (plan §1.2 route table).`
          );
        }
      }
    }
  }

  // --- annotations -------------------------------------------------------
  if (checkAnnotations) {
    const entries = annotations?.annotations || [];
    const byDynamicKey = new Map();
    for (const entry of entries) {
      validateAnnotationEntry(entry, record);
      if (entry.annotationKind === "dynamicCommandDispatch") {
        byDynamicKey.set(`${entry.path}#${entry.expressionText}`, entry);
      } else if (entry.annotationKind === "unregisteredCommandTarget") {
        if (typeof entry.commandId !== "string" || !entry.commandId.startsWith(COMMAND_ID_PREFIX)) {
          record(`unregisteredCommandTarget annotation must carry the exact extension commandId, found ${JSON.stringify(entry.commandId)}.`);
        }
      } else if (!PREGATE_ROUTE_ANNOTATION_KINDS.has(entry.annotationKind)) {
        record(`Route annotation has unknown annotationKind ${JSON.stringify(entry.annotationKind)}.`);
      }
    }
    for (const dispatch of scan.dynamicDispatches) {
      const key = `${dispatch.path}#${dispatch.expressionText}`;
      const entry = byDynamicKey.get(key);
      if (!entry) {
        record(
          `Dynamic command dispatch at ${dispatch.path}#${dispatch.span} (executeCommand(${dispatch.expressionText}, …)) has no ` +
            `"dynamicCommandDispatch" annotation — dynamic dispatch fails closed without recorded §1.5 evidence (plan §1.2/§1.5).`
        );
      } else if (entry.evidence?.sourceSpan !== dispatch.span) {
        record(
          `Dynamic-dispatch annotation for ${key} carries stale evidence.sourceSpan ${JSON.stringify(entry.evidence?.sourceSpan)} ` +
            `(live: ${dispatch.span}). Re-review the site and update the annotation.`
        );
      }
      byDynamicKey.delete(key);
    }
    for (const [key] of byDynamicKey) {
      record(`Dynamic-dispatch annotation ${key} matches no live dispatch site — remove the stale annotation.`);
    }
    // Annotations cannot replace an early gate (plan §1.5): an annotation's
    // evidence.edgeKind may never claim to gate a provider route.
    for (const entry of entries) {
      if (entry.evidence?.edgeKind === "gateReplacement") {
        record(`Route annotation ${entry.routeKey ?? entry.path ?? entry.commandId} claims edgeKind "gateReplacement" — annotations cannot replace an early gate (plan §1.5).`);
      }
    }
  }

  // --- removals ----------------------------------------------------------
  if (checkRemovals) {
    const removalEntries = removals?.removals || [];
    for (const removal of removalEntries) {
      const label = `removal:${removal.commandId ?? removal.path ?? "?"}`;
      for (const field of ["rationale", "removedInCohort", "sourceEvidence"]) {
        if (typeof removal[field] !== "string" || removal[field].length === 0) {
          record(`${label} is missing required field "${field}" (workflow-route-removal-v1.schema.json).`);
        }
      }
      if (typeof removal.commandId === "string") {
        const returned = scan.commandRegistrations.some((r) => r.commandId === removal.commandId);
        if (returned) {
          record(`${label}: removed route ${removal.commandId} has returned to the live scan — a removed route requires a verifier that fails if it returns (plan §1.5).`);
        }
      }
    }
  }
}

/**
 * Extractor self-test against the checked-in fixtures
 * (test-fixtures/workflow-routes/**). Runs on EVERY invocation (verify and
 * generate): if the AST extractor ever regresses — stops seeing literal
 * registrations, provider-boundary calls, or output destinations; stops
 * flagging computed IDs or dynamic dispatch — the whole inventory run fails
 * before any real result is trusted.
 */
function runExtractorSelfTest(record) {
  const fixtureDir = path.join(repoRoot, "test-fixtures", "workflow-routes");
  const literal = scanSourceFileForRoutes(repoRoot, path.join(fixtureDir, "literalRoutes.fixture.ts"));
  const expectLiteral = [
    [literal.commandRegistrations.length === 1 && literal.commandRegistrations[0].commandId === "vs-code-ai-helper.fixture.alpha",
      "exactly one literal registration (vs-code-ai-helper.fixture.alpha)"],
    [literal.unresolvedRegistrations.length === 0, "no unresolved registrations in the literal fixture"],
    [literal.commandEdges.length === 1 && literal.commandEdges[0].commandId === "vs-code-ai-helper.beta",
      "exactly one internal literal edge (vs-code-ai-helper.beta; setContext excluded)"],
    [literal.dynamicDispatches.length === 1 && literal.dynamicDispatches[0].expressionText === "someCommand",
      "exactly one dynamic dispatch (someCommand)"],
    [literal.webviewMessageHandlers.length === 1, "exactly one webview message handler root"],
    [literal.gateCalls.length === 1 && literal.gateCalls[0].routeId === "draft.v1" && literal.gateCalls[0].gateKind === "throwing",
      "exactly one throwing gate call (draft.v1)"],
    [literal.commandReferences.length === 1 && literal.commandReferences[0].commandId === "vs-code-ai-helper.gamma",
      "exactly one literal command-property binding (vs-code-ai-helper.gamma)"],
    [literal.providerBoundaryCalls.length === 1 && literal.providerBoundaryCalls[0].callee === "resolveRunnerForModel",
      "exactly one provider-boundary call (resolveRunnerForModel; type-position typeof excluded)"],
    [literal.legacyOutputDestinations.length === 2 &&
      literal.legacyOutputDestinations.every((s) => s.propertyName === "outputFile"),
      "exactly two legacy output destinations (one property assignment + one shorthand; the interface member and outputFilePath excluded)"],
  ];
  for (const [passed, what] of expectLiteral) {
    if (!passed) {
      record(`Extractor self-test failed on literalRoutes.fixture.ts: expected ${what}.`);
    }
  }
  const computed = scanSourceFileForRoutes(repoRoot, path.join(fixtureDir, "computedRegistration.fixture.ts"));
  if (computed.commandRegistrations.length !== 0 || computed.unresolvedRegistrations.length !== 1) {
    record(
      "Extractor self-test failed on computedRegistration.fixture.ts: a computed command ID must be reported as an " +
        "unresolved registration (fail-closed, plan §1.2), never as a concrete route."
    );
  }
}

function main() {
  const argv = process.argv.slice(2);
  const generate = argv.includes("--generate");
  const scope = {
    live: argv.includes("--live"),
    annotations: argv.includes("--annotations"),
    removals: argv.includes("--removals"),
  };
  scope.all = !scope.live && !scope.annotations && !scope.removals;

  const failures = [];
  const record = (message) => {
    failures.push(message);
    fail(message);
  };
  runExtractorSelfTest(record);
  // Fixture-provenance gate (plan §3.10's checked-in evidence-base rule,
  // extended to this tree per the implementation review): every extractor
  // self-test fixture must carry a README row recording the extraction rule
  // it pins, bidirectionally and fail-closed, on every verify and generate
  // run — so a fixture cannot be added or dropped without its record.
  verifyFixtureProvenance({
    repoRoot,
    fixturesDir: path.join(repoRoot, "test-fixtures", "workflow-routes"),
    fixtureFileRe: /\.fixture\.ts$/,
    fixtureFileDescription: ".fixture.ts",
    layout: "flat",
    record,
  });
  // sourceUniverseSha256 provenance must be checkout-line-ending-independent
  // (implementation-review blocker): prove it from the checked-in fixture
  // before any inventory evidence is written or compared.
  verifyUniverseDigestPortabilityFixture(record);

  // --- resolve the scan's file list from the §1.1 source universe --------
  let universe;
  try {
    universe = readUniverseTsFiles(SOURCE_UNIVERSE_PATH);
  } catch (e) {
    record(String(e.message ?? e));
    if (failures.length > 0) fail(`workflowRoutes: ${failures.length} check(s) failed.`);
    return;
  }
  const scanFiles = resolveUniverseFiles(repoRoot, universe.files, record);

  const scan = scanWorkflowRouteSurface({ repoRoot, files: scanFiles, packageJson });
  const roots = buildMechanicalRouteRows(scan);

  const annotations = loadJsonIfExists(ANNOTATIONS_PATH);
  const removals = loadJsonIfExists(REMOVALS_PATH);
  const baseline = loadJsonIfExists(BASELINE_PATH);

  // The live inventory is regenerated unconditionally, every run, for diffing.
  const live = {
    schemaVersion: 1,
    generatedBy: "scripts/generateWorkflowRoutes.mjs",
    description:
      "Mechanically extracted workflow route surface of the current working tree (plan §1.2): command registrations, " +
      "contribution/menu references, internal executeCommand edges, dynamic dispatch sites, webview message roots, " +
      "tree-item command bindings, provider-boundary call sites, legacy output destinations, and per-file " +
      "legacy-AI-gate calls — every edge a concrete route row. Scanned over the exact §1.1 production source " +
      "universe (never a filesystem walk). Regenerated every run; classification lives in " +
      "workflow-route-baseline-v1.json; the immutable pre-gate reference is workflow-route-pregate-v1.json. Known " +
      "mechanical bound: tree-item/status-row command bindings are collected only when the bound command ID is a " +
      "string literal — dynamically bound commands are enforced at their executeCommand dispatch sites instead " +
      "(dynamicDispatches, which fail closed without an annotation). sourceUniverseSha256 is the CANONICAL " +
      "(line-ending-independent) digest of the source-universe JSON, so provenance is identical across LF and CRLF " +
      "checkouts.",
    sourceUniverse: "workflow-inventories/workflow-production-source-baseline-v1.json",
    sourceUniverseSha256: universe.universeSha256,
    routeCount: roots.length,
    routes: roots,
    dynamicDispatches: scan.dynamicDispatches,
    unresolvedRegistrations: scan.unresolvedRegistrations,
    commandEdges: scan.commandEdges,
    providerBoundaryCalls: scan.providerBoundaryCalls,
    legacyOutputDestinations: scan.legacyOutputDestinations,
    gateCalls: scan.gateCalls,
  };
  fs.mkdirSync(INVENTORY_DIR, { recursive: true });
  fs.writeFileSync(LIVE_PATH, JSON.stringify(live, null, 2) + "\n", "utf8");

  if (generate) {
    // `--generate` can never launder undocumented pre-gate drift into the
    // checked-in baseline: it refuses to write while the live surface has
    // unannotated drift from the immutable snapshot (same contract as
    // resolveProductionSourceUniverse.mjs --generate).
    const pregateFailures = [];
    verifyPregateDrift({
      liveRows: roots,
      annotations,
      record: (message) => {
        pregateFailures.push(message);
        fail(message);
      },
    });
    if (failures.length > 0 || pregateFailures.length > 0) {
      console.error(
        `✘ Refusing to (re)write ${toPosix(path.relative(repoRoot, BASELINE_PATH))}: ` +
          `${failures.length + pregateFailures.length} check(s) above failed (extractor self-test, source-universe ` +
          `resolution, or undocumented pre-gate drift). Fix them before regenerating the baseline.`
      );
      process.exitCode = 1;
      return;
    }
    const existingRows = new Map(((baseline || {}).routes || []).map((r) => [routeKeyOf(r), r]));
    const routes = roots.map((root) => {
      const prior = existingRows.get(routeKeyOf(root));
      const row = { ...root };
      for (const field of CLASSIFICATION_FIELDS_BY_KIND[root.kind] ?? []) {
        row[field] = prior?.[field] ?? "pending:unassigned";
      }
      return row;
    });
    const inventory = {
      schemaVersion: 1,
      description:
        "Workflow route inventory (plan §1.2): one classified row per concrete route — registered commands, webview " +
        "message roots, internal executeCommand edges (edgeRole-classified scheduler/auto-advance/follow-up/wrapper " +
        "edges), provider-boundary call sites (resolveRunnerForModel/runImplementationForModel), and legacy output " +
        "destinations (artifactClass-classified provider-to-writer edges). Mechanical fields are regenerated by " +
        "scripts/generateWorkflowRoutes.mjs --generate over the exact §1.1 source universe and cannot be hand-edited " +
        "(verification diffs them against the live scan); the classification fields are human-authored and preserved " +
        "across regeneration. The immutable pre-gate reference lives in workflow-route-pregate-v1.json — " +
        "verification (and --generate itself) fails on any drift from it that lacks a pregateAddedRoute/" +
        "pregateRemovedRoute/pregateModifiedRoute annotation, on any unclassified/stale/missing row, any " +
        "unresolved/ambiguous registration, any unannotated dynamic dispatch, and any required registry target with " +
        "no concrete route row.",
      routes,
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(inventory, null, 2) + "\n", "utf8");
    console.log(
      `✓ Wrote ${toPosix(path.relative(repoRoot, BASELINE_PATH))}: ${routes.length} route row(s). New rows carry ` +
        `"pending:unassigned" classification markers that verification rejects until a human assigns them.`
    );
    verifyAgainstScan({ scan, roots, baseline: inventory, annotations, removals, record, scope: { all: true } });
    if (failures.length > 0) {
      fail(`${failures.length} check(s) still failing after regeneration (see above).`);
    }
    return;
  }

  verifyAgainstScan({ scan, roots, baseline, annotations, removals, record, scope });
  if (failures.length === 0) {
    console.log(
      `✓ workflowRoutes: ${roots.length} route row(s) (${scan.commandRegistrations.length} command(s), ` +
        `${scan.webviewMessageHandlers.length} webview root(s), ${scan.commandEdges.length} internal edge(s), ` +
        `${scan.providerBoundaryCalls.length} provider-boundary call(s), ${scan.legacyOutputDestinations.length} ` +
        `output destination(s)), ${scan.dynamicDispatches.length} annotated dynamic dispatch site(s), ` +
        `${scan.gateCalls.length} gate call(s) verified against the baseline and the immutable pre-gate snapshot.`
    );
  } else {
    fail(`workflowRoutes: ${failures.length} check(s) failed.`);
  }
}

main();
