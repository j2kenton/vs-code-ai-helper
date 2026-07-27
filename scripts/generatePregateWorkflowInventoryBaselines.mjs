#!/usr/bin/env node
/**
 * One-time generator for the IMMUTABLE pre-gate route and path-consumer
 * snapshots (plan "Repository-contained Phase 0" + §1.2 + §2.3: "The
 * immutable baselines are not regenerated after production changes. Separate
 * live inventories must account for every baseline row as gated, migrated,
 * or removed with checked-in evidence.").
 *
 * Same architecture as generatePregateProductionSourceBaseline.mjs, and
 * chained to its output: this script reads the frozen pre-gate production
 * source universe (workflow-production-source-pregate-v1.json), checks out
 * its exact recorded commit into an isolated `git worktree` (never the
 * working tree), digest-verifies every listed source file against the frozen
 * snapshot (binding the three pre-gate artifacts together), and runs the
 * SAME mechanical scans the live generators use
 * (scripts/lib/workflowRouteScan.mjs, workflowPathConsumerScan.mjs) against
 * that historical tree with the CURRENT repo's TypeScript tooling.
 *
 * The outputs are the frozen reference points every later route/consumer
 * addition, removal, or mechanical change must be justified against
 * (pregateAddedRoute / pregateRemovedRoute / pregateModifiedRoute
 * annotations in workflow-route-annotations-v1.json; pregateAddedConsumer /
 * pregateRemovedConsumer / pregateModifiedConsumer annotations in
 * workflow-path-consumer-annotations-v1.json). Drift is detected through the
 * span-independent stability projections in the scan libs, so pure line
 * drift never demands evidence while every semantic change (a gate
 * installed, an edge added, an fs call site added) always does.
 *
 * This script REFUSES to overwrite an existing pre-gate snapshot. The files
 * are immutable once written; if one is ever legitimately wrong, delete it
 * explicitly and re-run rather than adding a force flag here.
 *
 * USAGE
 * -----
 *   node scripts/generatePregateWorkflowInventoryBaselines.mjs
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { sha256OfFile, fileMatchesRecordedSha256 } from "./lib/productionSourceScan.mjs";
import { scanWorkflowRouteSurface, buildMechanicalRouteRows, toPosix } from "./lib/workflowRouteScan.mjs";
import { scanPathConsumers } from "./lib/workflowPathConsumerScan.mjs";
import { readUniverseTsFiles } from "./lib/inventoryUniverse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const INVENTORY_DIR = path.join(repoRoot, "workflow-inventories");
const SOURCE_PREGATE_PATH = path.join(INVENTORY_DIR, "workflow-production-source-pregate-v1.json");
const ROUTE_PREGATE_PATH = path.join(INVENTORY_DIR, "workflow-route-pregate-v1.json");
const CONSUMER_PREGATE_PATH = path.join(INVENTORY_DIR, "workflow-path-consumer-pregate-v1.json");

function git(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function main() {
  for (const existing of [ROUTE_PREGATE_PATH, CONSUMER_PREGATE_PATH]) {
    if (fs.existsSync(existing)) {
      console.error(
        `✘ ${toPosix(path.relative(repoRoot, existing))} already exists. The pre-gate snapshots are immutable — ` +
          `delete the file explicitly first if you are certain it must be regenerated (this should essentially never happen).`
      );
      process.exitCode = 1;
      return;
    }
  }
  if (!fs.existsSync(SOURCE_PREGATE_PATH)) {
    console.error(
      `✘ ${toPosix(path.relative(repoRoot, SOURCE_PREGATE_PATH))} does not exist. Generate the immutable pre-gate ` +
        `production-source snapshot first (scripts/generatePregateProductionSourceBaseline.mjs) — the route and ` +
        `path-consumer pre-gate scans consume its exact file universe and commit.`
    );
    process.exitCode = 1;
    return;
  }

  const sourcePregate = JSON.parse(fs.readFileSync(SOURCE_PREGATE_PATH, "utf8"));
  const resolvedSha = sourcePregate.pregateGitSha;
  if (typeof resolvedSha !== "string" || !/^[0-9a-f]{40}$/.test(resolvedSha)) {
    console.error(`✘ ${toPosix(path.relative(repoRoot, SOURCE_PREGATE_PATH))} carries no valid pregateGitSha.`);
    process.exitCode = 1;
    return;
  }
  // universeSha256 is the CANONICAL (line-ending-independent) digest of the
  // frozen universe JSON (scripts/lib/inventoryUniverse.mjs), so a snapshot
  // written today records checkout-portable provenance. The two existing
  // immutable snapshots predate canonical digesting and recorded the raw
  // checkout-byte digest; downstream verification therefore compares their
  // recorded sourceUniverseSha256 through the tolerant line-ending matcher
  // (verifyRecordedUniverseProvenance), never strict equality.
  const { files: universeTsFiles, universeSha256, fileDigests } = readUniverseTsFiles(SOURCE_PREGATE_PATH);
  console.log(
    `Generating pre-gate route + path-consumer snapshots from ${sourcePregate.pregateGitRef} (${resolvedSha}), ` +
      `${universeTsFiles.length} source file(s) in the frozen universe...`
  );

  const worktreePath = path.join(os.tmpdir(), `ensemble-pregate-inv-${process.pid}-${resolvedSha.slice(0, 12)}`);
  fs.rmSync(worktreePath, { recursive: true, force: true });

  // core.autocrlf=false: check the historical tree out with verbatim blob
  // bytes (LF), matching the digests the frozen production-source snapshot
  // records — a CRLF smudge at checkout time would otherwise fail the
  // digest-binding check on every file.
  git(["-c", "core.autocrlf=false", "worktree", "add", "--detach", "--force", worktreePath, resolvedSha]);
  try {
    // Bind this scan to the frozen source snapshot: every universe file must
    // exist in the historical tree with exactly the digest the immutable
    // production-source snapshot recorded for it.
    const absFiles = [];
    for (const rel of universeTsFiles) {
      const abs = path.join(worktreePath, rel);
      if (!fs.existsSync(abs)) {
        throw new Error(`${rel} is listed in the frozen pre-gate universe but does not exist at ${resolvedSha}.`);
      }
      const recorded = fileDigests.get(rel);
      // The frozen production-source snapshot predates canonical digesting
      // and recorded raw checkout bytes (a mix of CRLF-form and LF-form
      // rows, per the generating machine's checkout profile). Line endings
      // change neither the AST scan nor its line-based spans, so the binding
      // uses the shared tolerant matcher: the recorded digest must match the
      // historical file under some single-EOL representation — anything else
      // is a genuine content mismatch.
      if (recorded && !fileMatchesRecordedSha256(abs, recorded)) {
        throw new Error(
          `${rel} at ${resolvedSha} has canonical digest ${sha256OfFile(abs)}, and no line-ending projection of its ` +
            `content matches the frozen pre-gate universe's recorded digest ${recorded} — the two snapshots would ` +
            `not describe the same tree; refusing to write.`
        );
      }
      absFiles.push(abs);
    }

    const historicalPackageJson = JSON.parse(fs.readFileSync(path.join(worktreePath, "package.json"), "utf8"));

    const scan = scanWorkflowRouteSurface({ repoRoot: worktreePath, files: absFiles, packageJson: historicalPackageJson });
    const routeRows = buildMechanicalRouteRows(scan);
    const routePregate = {
      schemaVersion: 1,
      generatedBy: "scripts/generatePregateWorkflowInventoryBaselines.mjs",
      description:
        "IMMUTABLE pre-gate workflow route surface, frozen at the commit that predates this plan's own changes and " +
        "mechanically extracted with the same scan rules as the live inventory (command roots, webview roots, " +
        "internal edges, provider-boundary calls, legacy output destinations). Never regenerated by " +
        "generateWorkflowRoutes.mjs. Every route added, removed, or mechanically changed (span-independent " +
        "stability digest) since this snapshot must be recorded in workflow-route-annotations-v1.json.",
      pregateGitRef: sourcePregate.pregateGitRef,
      pregateGitSha: resolvedSha,
      sourceUniverse: "workflow-inventories/workflow-production-source-pregate-v1.json",
      sourceUniverseSha256: universeSha256,
      routeCount: routeRows.length,
      routes: routeRows,
      dynamicDispatches: scan.dynamicDispatches,
      unresolvedRegistrations: scan.unresolvedRegistrations,
      gateCalls: scan.gateCalls,
    };

    const consumers = scanPathConsumers({ repoRoot: worktreePath, files: absFiles });
    const consumerPregate = {
      schemaVersion: 1,
      generatedBy: "scripts/generatePregateWorkflowInventoryBaselines.mjs",
      description:
        "IMMUTABLE pre-gate non-AI path-consumer surface, frozen at the commit that predates this plan's own " +
        "changes and mechanically extracted with the same per-call-site scan rules as the live inventory. Never " +
        "regenerated by generateWorkflowPathConsumers.mjs. Every consumer added, removed, or whose per-signal " +
        "call-site profile changed since this snapshot must be recorded in " +
        "workflow-path-consumer-annotations-v1.json.",
      pregateGitRef: sourcePregate.pregateGitRef,
      pregateGitSha: resolvedSha,
      sourceUniverse: "workflow-inventories/workflow-production-source-pregate-v1.json",
      sourceUniverseSha256: universeSha256,
      consumerCount: consumers.length,
      consumers,
    };

    fs.mkdirSync(INVENTORY_DIR, { recursive: true });
    fs.writeFileSync(ROUTE_PREGATE_PATH, JSON.stringify(routePregate, null, 2) + "\n", "utf8");
    fs.writeFileSync(CONSUMER_PREGATE_PATH, JSON.stringify(consumerPregate, null, 2) + "\n", "utf8");
    console.log(
      `✓ Wrote immutable pre-gate snapshots: ${routeRows.length} route row(s) to ` +
        `${toPosix(path.relative(repoRoot, ROUTE_PREGATE_PATH))}, ${consumers.length} consumer row(s) to ` +
        `${toPosix(path.relative(repoRoot, CONSUMER_PREGATE_PATH))}`
    );
  } finally {
    git(["worktree", "remove", "--force", worktreePath]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
