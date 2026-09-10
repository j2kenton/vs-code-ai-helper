/**
 * Route-completeness invariant (v1 fixes 2, Part 1a — "build derived
 * entry-point inventory of all watchdog-susceptible commands from package.json
 * contributions"; plan Verification: "route-completeness invariant across the
 * step-3 inventory").
 *
 * Asserts `WORK_ADMISSION_ROUTE_INVENTORY_V1` stays in exact 1:1
 * correspondence with `package.json`'s `contributes.commands` — every
 * contributed command has a classification, and no classification exists for
 * a command that is no longer contributed. This is what makes the inventory
 * "derived" rather than a hand-maintained snapshot that can silently drift:
 * a newly contributed command with no entry fails this test immediately,
 * exactly like the three genuinely unwired routes (draftTaskWithAI,
 * renameTaskWithAI, chatWithStage/respondToStageDecision) this round found by
 * a systematic pass that a hand-traced audit had missed.
 *
 * Also asserts every `delegatesTo` edge resolves (following the chain) to an
 * `admissionWired`, `delegatesDynamically`, or `notWatchdogSusceptible`
 * terminal — never a dangling id or a cycle — so the inventory itself cannot
 * silently regress into an unreachable classification.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  WORK_ADMISSION_ROUTE_INVENTORY_V1,
  WORK_ADMISSION_ROUTE_TERMINAL_KINDS_V1,
} from "../state/workAdmissionRouteInventoryV1";

const COMMAND_PREFIX_V1 = "vs-code-ai-helper.";

/** Reads package.json directly off disk rather than `require`-ing it, so
 * this test reflects the file's on-disk state exactly like the rest of the
 * build tooling, with no module-cache staleness risk. */
function readContributedCommandIdsV1(): readonly string[] {
  const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as {
    contributes?: { commands?: readonly { command?: unknown }[] };
  };
  const commands = parsed.contributes?.commands ?? [];
  return commands
    .map((entry) => entry.command)
    .filter((id): id is string => typeof id === "string" && id.startsWith(COMMAND_PREFIX_V1));
}

void describe("work admission route inventory (v1 fixes 2, Part 1a route-completeness invariant)", () => {
  void it("classifies every command contributed in package.json — no command is missing from the inventory", () => {
    const contributed = readContributedCommandIdsV1();
    const classified = new Set(
      Object.keys(WORK_ADMISSION_ROUTE_INVENTORY_V1).map((id) => `${COMMAND_PREFIX_V1}${id}`)
    );

    const missing = contributed.filter((id) => !classified.has(id));
    assert.deepEqual(
      missing,
      [],
      `every package.json-contributed command must have a WORK_ADMISSION_ROUTE_INVENTORY_V1 entry; ` +
        `missing: ${missing.join(", ")}`
    );
  });

  void it("has no stale entry for a command no longer contributed in package.json", () => {
    const contributed = new Set(readContributedCommandIdsV1());
    const stale = Object.keys(WORK_ADMISSION_ROUTE_INVENTORY_V1)
      .map((id) => `${COMMAND_PREFIX_V1}${id}`)
      .filter((id) => !contributed.has(id));

    assert.deepEqual(
      stale,
      [],
      `every WORK_ADMISSION_ROUTE_INVENTORY_V1 entry must name a command still contributed in package.json; ` +
        `stale: ${stale.join(", ")}`
    );
  });

  void it("resolves every delegatesTo chain to a terminal classification, with no dangling target and no cycle", () => {
    for (const [id, classification] of Object.entries(WORK_ADMISSION_ROUTE_INVENTORY_V1)) {
      if (classification.kind !== "delegatesTo") {
        continue;
      }
      const seen = new Set<string>([id]);
      let current: string = classification.to;
      const maxSteps = Object.keys(WORK_ADMISSION_ROUTE_INVENTORY_V1).length;
      for (let steps = 0; ; steps++) {
        assert.ok(
          steps < maxSteps,
          `delegatesTo chain starting at "${id}" did not terminate — likely a cycle`
        );
        assert.ok(
          !seen.has(current),
          `delegatesTo chain starting at "${id}" cycles back to "${current}"`
        );
        seen.add(current);
        const target = WORK_ADMISSION_ROUTE_INVENTORY_V1[current];
        assert.ok(
          target !== undefined,
          `"${id}" delegates to "${current}", which has no WORK_ADMISSION_ROUTE_INVENTORY_V1 entry`
        );
        if (target.kind !== "delegatesTo") {
          assert.ok(
            (WORK_ADMISSION_ROUTE_TERMINAL_KINDS_V1 as readonly string[]).includes(target.kind),
            `"${current}" (end of "${id}"'s delegatesTo chain) has an unrecognized terminal kind "${target.kind}"`
          );
          break;
        }
        current = target.to;
      }
    }
  });

  void it("every admissionWired and delegatesTo/delegatesDynamically entry carries non-empty evidence", () => {
    for (const [id, classification] of Object.entries(WORK_ADMISSION_ROUTE_INVENTORY_V1)) {
      if (classification.kind === "notWatchdogSusceptible") {
        assert.ok(classification.reason.trim().length > 0, `"${id}" must carry a non-empty reason`);
        continue;
      }
      assert.ok(
        classification.evidence.trim().length > 0,
        `"${id}" (${classification.kind}) must carry non-empty evidence`
      );
    }
  });
});
