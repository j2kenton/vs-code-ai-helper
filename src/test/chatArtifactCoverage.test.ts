/**
 * Guard: every task artifact that carries answerable content must reach Chat
 * With AI's context.
 *
 * This exists because the same regression has now happened twice, both times
 * silently, both times to this one function:
 *
 *  - The `plan-final.md` → `impl-summary.md` split moved the run summary out
 *    from under the artifact chat was reading, so chat lost the ability to
 *    answer anything about what the last implementation round did.
 *  - The `publish-review.md` → `publish-checks.md` split moved the Completion
 *    Checks and Scope Check sections out from under the Publish stage artifact,
 *    so "why did the checks fail?" started being answered from the reviewer's
 *    verdict — which can be several commits stale.
 *
 * Both were found by review after the fact. A grep does not catch them:
 * `readStageArtifactsForChat` reaches its stage artifact through
 * `STAGE_ARTIFACT_FILENAMES[targetStage]`, an indirect table lookup, so
 * searching the codebase for a filename literal reports no consumers.
 *
 * The coverage set below is therefore derived from OBSERVED BEHAVIOUR — write
 * every artifact, call the real function, see which ones come back — and then
 * compared against a declared expectation. A new artifact constant lands in
 * neither set and fails the exhaustiveness test until someone classifies it.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { readStageArtifactsForChat } from "../commands/chatWithStage";
import * as taskProgressModule from "../types/taskProgress";
import {
  CONTEXT_PACK_FILENAME,
  IMPLEMENTATION_FILENAME,
  IMPLEMENTATION_SUMMARY_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
  LOW_LEVEL_PLAN_FILENAME,
  PLAN_FILENAME,
  PUBLISH_CHECKS_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_ORDER,
  TASK_DESCRIPTION_FILENAME,
  TASK_FILENAME,
  TASK_PROGRESS_FILENAME,
  TaskStage,
} from "../types/taskProgress";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-chat-coverage-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Every artifact filename the task folder can hold, DERIVED from the
 * taskProgress module's own exports rather than transcribed.
 *
 * The first version of this list was hand-maintained, with a comment arguing
 * that forgetting to extend it "is itself a visible omission in review". That
 * is exactly the mechanism whose failure caused this file to exist: both
 * artifact splits were visible omissions in review, and both shipped. A
 * transcribed list makes the exhaustiveness tests below pass vacuously for
 * precisely the artifact nobody remembered — the only case they are for.
 *
 * Reading the module's exports means a new `export const X_FILENAME` enters
 * this set the moment it is declared, with no second place to remember.
 */
const ALL_TASK_ARTIFACTS: readonly string[] = [
  ...new Set([
    ...(Object.entries(taskProgressModule) as Array<[string, unknown]>)
      .filter(
        (entry): entry is [string, string] =>
          /_FILENAME$/.test(entry[0]) && typeof entry[1] === "string"
      )
      .map(([, filename]) => filename),
    // STAGE_ARTIFACT_FILENAMES can name a file no `*_FILENAME` constant does
    // (the review artifacts are inline string literals), so it is a second
    // derivation source, not a duplicate of the first.
    ...STAGE_ORDER.map((stage) => STAGE_ARTIFACT_FILENAMES[stage]).filter(
      (name): name is string => name !== undefined
    ),
  ]),
];

/**
 * Artifacts deliberately NOT loaded here, each with the reason. An entry
 * removed from this list without being covered fails the exhaustiveness test.
 */
const DELIBERATELY_NOT_IN_CHAT_CONTEXT: ReadonlyMap<string, string> = new Map([
  [
    TASK_PROGRESS_FILENAME,
    "machine state, not prose — the stage/status it holds is already in the prompt header",
  ],
  [
    CONTEXT_PACK_FILENAME,
    "generateContextPack is passed separately by the caller; loading it here would duplicate it",
  ],
  [
    TASK_DESCRIPTION_FILENAME,
    "legacy filename superseded by task.md",
  ],
  [
    LEGACY_IMPLEMENTATION_FILENAME,
    "legacy filename materialized into plan-final.md before any stage reads it",
  ],
  [
    LOW_LEVEL_PLAN_FILENAME,
    "folded into plan-final.md at the implementation stage",
  ],
  [
    PUBLISH_CHECKS_FILENAME,
    "legacy pre-unification artifact, frozen on disk once written: its Completion Checks/Scope " +
      "Check sections are now spliced directly into publish-review.md (STAGE_ARTIFACT_FILENAMES.publish) " +
      "and re-read live from there, so this file is never opened directly (plan item 17, step 20) — " +
      "re-reading it here would surface content stuck at the moment of the artifact-unification " +
      "upgrade as if it were current",
  ],
]);

function seedFolder(name: string): { folder: string; sentinelFor: (file: string) => string } {
  const folder = nodePath.join(ROOT, name);
  nodeFs.mkdirSync(folder, { recursive: true });
  const sentinelFor = (file: string): string => `SENTINEL_CONTENT_FOR_${file.replace(/\W/g, "_")}`;
  for (const file of ALL_TASK_ARTIFACTS) {
    nodeFs.writeFileSync(nodePath.join(folder, file), `${sentinelFor(file)}\n`, "utf8");
  }
  return { folder, sentinelFor };
}

/** Back workspace.fs.readFile with the real disk for the duration of a call. */
function installRealFs(): { restore: () => void } {
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = fs.readFile;
  fs.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  return {
    restore: (): void => {
      fs.readFile = orig;
    },
  };
}

/** Union of every artifact surfaced across every stage. */
async function observeCoverage(): Promise<{
  covered: Set<string>;
  perStage: Map<TaskStage, string>;
}> {
  const { folder, sentinelFor } = seedFolder("coverage");
  const covered = new Set<string>();
  const perStage = new Map<TaskStage, string>();
  const fs = installRealFs();
  try {
    for (const stage of STAGE_ORDER) {
      const context = await readStageArtifactsForChat(vscode.Uri.file(folder), stage);
      perStage.set(stage, context);
      for (const file of ALL_TASK_ARTIFACTS) {
        if (context.includes(sentinelFor(file))) {
          covered.add(file);
        }
      }
    }
  } finally {
    fs.restore();
  }
  return { covered, perStage };
}

void describe("chat artifact coverage — every answerable artifact reaches chat", () => {
  void it("actually derives the artifact set (a broken derivation must not pass silently)", () => {
    // Everything below is only as strong as this list. If the derivation ever
    // yields nothing — a renamed export convention, a changed module shape —
    // every coverage assertion would pass over an empty set and report health
    // while checking nothing. Pin a floor and a known sample so that failure
    // is loud rather than green.
    for (const known of [
      TASK_FILENAME,
      PLAN_FILENAME,
      IMPLEMENTATION_FILENAME,
      IMPLEMENTATION_SUMMARY_FILENAME,
      PUBLISH_CHECKS_FILENAME,
      TASK_PROGRESS_FILENAME,
      STAGE_ARTIFACT_FILENAMES.publish ?? "publish-review.md",
      STAGE_ARTIFACT_FILENAMES["impl-high-review"] ?? "impl-high-review.md",
    ]) {
      assert.ok(
        ALL_TASK_ARTIFACTS.includes(known),
        `${known} must be discovered by the derivation, not missing from it`
      );
    }
    assert.ok(
      ALL_TASK_ARTIFACTS.length >= 10,
      `expected the derivation to find at least 10 artifacts, found ${ALL_TASK_ARTIFACTS.length}`
    );
  });

  void it("classifies every task artifact as either loaded or deliberately excluded", async () => {
    const { covered } = await observeCoverage();
    const unclassified = ALL_TASK_ARTIFACTS.filter(
      (file) => !covered.has(file) && !DELIBERATELY_NOT_IN_CHAT_CONTEXT.has(file)
    );
    assert.deepEqual(
      unclassified,
      [],
      "These artifacts reach no chat context and have no recorded reason. Either load them in " +
        "readStageArtifactsForChat, or add them to DELIBERATELY_NOT_IN_CHAT_CONTEXT with why. " +
        "Silently leaving one out is how the plan-final.md and publish-review.md splits each " +
        "broke Chat With AI without a single test failing."
    );
  });

  void it("does not claim coverage for an artifact recorded as excluded", async () => {
    // Keeps the exclusion list honest in the other direction: an artifact that
    // starts being loaded should lose its excuse, not keep it.
    const { covered } = await observeCoverage();
    const contradictions = [...DELIBERATELY_NOT_IN_CHAT_CONTEXT.keys()].filter((file) =>
      covered.has(file)
    );
    assert.deepEqual(
      contradictions,
      [],
      "These are loaded into chat context but still listed as deliberately excluded"
    );
  });

  void it("surfaces the unified publish-review.md, and never the legacy publish-checks.md, at the Publish stage", async () => {
    // The regression this file was originally written for (chat at Publish
    // seeing only the reviewer's verdict, stale relative to the checks) was
    // fixed by moving the checks INTO publish-review.md rather than reading a
    // second file (plan item 17, step 20's artifact-unification reversal).
    // publish-checks.md is now frozen legacy — asserting its absence here
    // guards the opposite regression: re-reading it would surface content
    // stuck at the moment of the upgrade as if it were the current report.
    const { perStage } = await observeCoverage();
    const publishContext = perStage.get("publish") ?? "";
    assert.ok(
      !publishContext.includes(PUBLISH_CHECKS_FILENAME),
      "the legacy publish-checks.md must not be read directly any more"
    );
    assert.ok(
      publishContext.includes(STAGE_ARTIFACT_FILENAMES.publish ?? "publish-review.md"),
      "the unified publish-review.md artifact — now carrying the checks sections too — must still be there"
    );
  });

  void it("surfaces the implementation summary at the implementation review stages", async () => {
    // The first instance of this regression, pinned so it cannot come back.
    const { perStage } = await observeCoverage();
    for (const stage of ["impl", "impl-high-review", "impl-low-review"] as const) {
      assert.ok(
        (perStage.get(stage) ?? "").includes(IMPLEMENTATION_SUMMARY_FILENAME),
        `${stage} chat context must include ${IMPLEMENTATION_SUMMARY_FILENAME}`
      );
    }
  });

  void it("never reads the same file twice when the stage artifact is the plan", async () => {
    const { perStage } = await observeCoverage();
    const planContext = perStage.get("plan") ?? "";
    const occurrences = planContext.split(`### ${PLAN_FILENAME}`).length - 1;
    assert.equal(occurrences, 1, "plan.md must appear exactly once at the plan stage");
  });
});
