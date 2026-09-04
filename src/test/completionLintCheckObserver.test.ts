/**
 * Coverage for the opt-in per-check `onCheckEvent` observer added to
 * `collectCompletionLint`'s options (Notifications in-flight visibility,
 * plan Part III). The observer is purely observational: these tests prove
 * it never changes scheduling, concurrency, or `commandsRun`, and that it
 * correctly reports the real concurrency this function already has —
 * multiple commands within one `Promise.all` batch run genuinely
 * concurrently, while the root/explicit batch and the monorepo-member batch
 * remain two SEQUENTIAL batches (the member batch only starts once the root
 * batch's own `Promise.all` has fully resolved), matching
 * `collectCompletionLint`'s real control flow rather than the aggregated,
 * illustrative "everything overlaps" reading of the worked example.
 *
 * Uses the same real-spawn-against-a-temp-dir pattern as the sibling
 * completionLint*.test.ts files (see completionLintMonorepo.test.ts) rather
 * than mocking `spawn`.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import { collectCompletionLint, CompletionCheckDescriptor } from "../utils/completionLint";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-completionlint-observer-test-"));
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  nodeFs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

interface RecordedEvent {
  type: "planned" | "started" | "settled" | "batchBoundary";
  command?: string;
  total?: number;
  at: number;
}

function recordingObserver(t0: number): {
  events: RecordedEvent[];
  onCheckEvent: {
    planned(total: number): void;
    started(d: CompletionCheckDescriptor): void;
    settled(d: CompletionCheckDescriptor): void;
    batchBoundary(): void;
  };
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    onCheckEvent: {
      planned: (total) => events.push({ type: "planned", total, at: Date.now() - t0 }),
      started: (d) => events.push({ type: "started", command: d.command, at: Date.now() - t0 }),
      settled: (d) => events.push({ type: "settled", command: d.command, at: Date.now() - t0 }),
      batchBoundary: () => events.push({ type: "batchBoundary", at: Date.now() - t0 }),
    },
  };
}

void describe("collectCompletionLint — onCheckEvent observer", () => {
  void it("reports exactly one started and one settled per configured check, each settled following its own started", async () => {
    const dir = nodePath.join(TEST_ROOT, "pairing");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: {
        lint: 'node -e "process.exit(0)"',
        "check-types": 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(1)"',
      },
    });
    const rec = recordingObserver(Date.now());

    await collectCompletionLint(dir, [], { onCheckEvent: rec.onCheckEvent });

    for (const command of ["npm run lint", "npm run check-types", "npm run test"]) {
      const starts = rec.events.filter((e) => e.type === "started" && e.command === command);
      const settles = rec.events.filter((e) => e.type === "settled" && e.command === command);
      assert.equal(starts.length, 1, `${command} must report started exactly once`);
      assert.equal(settles.length, 1, `${command} must report settled exactly once`);
      const startedIdx = rec.events.indexOf(starts[0]!);
      const settledIdx = rec.events.indexOf(settles[0]!);
      assert.ok(settledIdx > startedIdx, `${command}'s settled must be reported after its own started`);
    }
  });

  void it("keeps multiple checks within the SAME Promise.all batch running concurrently (overlapping active windows)", async () => {
    const dir = nodePath.join(TEST_ROOT, "batch-concurrency");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: {
        // Both sleep for the same duration — if the batch ran sequentially,
        // check-types's `started` would only ever land after lint's
        // `settled`; run concurrently, both `started` events land first.
        lint: 'node -e "setTimeout(() => process.exit(0), 150)"',
        "check-types": 'node -e "setTimeout(() => process.exit(0), 150)"',
      },
    });
    const rec = recordingObserver(Date.now());

    await collectCompletionLint(dir, [], { onCheckEvent: rec.onCheckEvent });

    const lintStarted = rec.events.find((e) => e.type === "started" && e.command === "npm run lint")!;
    const typesStarted = rec.events.find((e) => e.type === "started" && e.command === "npm run check-types")!;
    const lintSettled = rec.events.find((e) => e.type === "settled" && e.command === "npm run lint")!;
    const typesSettled = rec.events.find((e) => e.type === "settled" && e.command === "npm run check-types")!;

    assert.ok(lintStarted && typesStarted && lintSettled && typesSettled);
    // Both starts must land well before either settles — proof the two
    // 150ms sleeps ran concurrently rather than back to back (which would
    // take >=300ms total and interleave differently).
    assert.ok(typesStarted.at < lintSettled.at, "check-types must start before lint settles (concurrent, not sequential)");
    assert.ok(lintStarted.at < typesSettled.at, "lint must start before check-types settles (concurrent, not sequential)");
  });

  void it("reports the TRUE grand total via planned() before any check starts, and runs the root/explicit and monorepo-member batches as two SEQUENTIAL Promise.all passes", async () => {
    const dir = nodePath.join(TEST_ROOT, "batch-sequencing");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      workspaces: ["packages/*"],
      scripts: { lint: 'node -e "process.exit(0)"' },
    });
    writeJson(nodePath.join(dir, "packages", "member", "package.json"), {
      name: "member",
      scripts: { lint: 'node -e "process.exit(0)"' },
    });
    const rec = recordingObserver(Date.now());

    await collectCompletionLint(dir, [], { onCheckEvent: rec.onCheckEvent });

    const planned = rec.events.find((e) => e.type === "planned")!;
    const rootStarted = rec.events.find((e) => e.type === "started" && e.command === "npm run lint")!;
    const rootSettled = rec.events.find((e) => e.type === "settled" && e.command === "npm run lint")!;
    const memberStarted = rec.events.find((e) => e.type === "started" && e.command?.includes("packages/member"))!;
    assert.ok(planned && rootStarted && rootSettled && memberStarted);

    // The true combined total is known and reported before the FIRST check
    // of any batch starts — this is the fix for the defect where the root
    // batch alone rendered a completed-looking total before it grew once the
    // member batch was found. Root count is 2 (configured `lint` plus the
    // unconditionally-run `check-types`, per the conventional candidate
    // list's existing filter), member count is 1 (`lint`, the only script
    // the member package configures) — total 3.
    assert.equal(planned.total, 3, "planned() must report the true combined total across both batches");
    assert.ok(planned.at <= rootStarted.at, "planned() must fire before the root batch's own first started() call");

    assert.ok(
      memberStarted.at >= rootSettled.at,
      "the monorepo member pass must only start once the root pass's own Promise.all has fully resolved"
    );

    // The explicit batchBoundary signal (added to fix an accumulator defect
    // where "starting next batch" was inferred from the active set emptying
    // out — indistinguishable from the true end of the whole pass) must
    // still fire exactly once, at the real transition point between the root
    // batch settling and the member batch's own checks starting — it no
    // longer carries a count (planned() already delivered the true total),
    // it only marks the moment in time.
    const boundaries = rec.events.filter((e) => e.type === "batchBoundary");
    assert.equal(boundaries.length, 1, "batchBoundary must fire exactly once for a two-batch (monorepo) run");
    assert.ok(boundaries[0]!.at >= rootSettled.at, "batchBoundary must fire only after the root batch has fully settled");
    assert.ok(boundaries[0]!.at <= memberStarted.at, "batchBoundary must fire before the member batch's checks start");
  });

  void it("never fires batchBoundary for a single-batch (non-monorepo) run, and planned() reports the root-only total", async () => {
    const dir = nodePath.join(TEST_ROOT, "no-batch-boundary");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { lint: 'node -e "process.exit(0)"' },
    });
    const rec = recordingObserver(Date.now());

    await collectCompletionLint(dir, [], { onCheckEvent: rec.onCheckEvent });

    const planned = rec.events.find((e) => e.type === "planned")!;
    assert.ok(planned, "planned() must still fire for a single-batch run");
    // Root count is 2 (configured `lint` plus the unconditionally-run
    // `check-types`, per the conventional candidate list's existing filter).
    assert.equal(planned.total, 2, "planned() must report the root-only total when there is no monorepo member batch");

    assert.equal(
      rec.events.filter((e) => e.type === "batchBoundary").length,
      0,
      "a single-batch run must never claim a next batch is coming"
    );
  });

  void it("never changes scheduling, ordering, or commandsRun/failedChecks/passed when an observer is attached", async () => {
    const dir = nodePath.join(TEST_ROOT, "no-behavior-change");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: {
        lint: 'node -e "process.exit(0)"',
        "check-types": 'node -e "process.exit(1)"',
      },
    });

    const withoutObserver = await collectCompletionLint(dir, []);
    const withObserver = await collectCompletionLint(dir, [], {
      onCheckEvent: { started: () => undefined, settled: () => undefined },
    });

    assert.deepStrictEqual(withObserver.commandsRun, withoutObserver.commandsRun);
    assert.deepStrictEqual(
      withObserver.failedChecks.map((c) => c.command),
      withoutObserver.failedChecks.map((c) => c.command)
    );
    assert.equal(withObserver.passed, withoutObserver.passed);
    assert.equal(withObserver.issueCount, withoutObserver.issueCount);
  });

  void it("is a no-op when no observer is supplied (checkPublishPreflight / commit-push callers never pass one)", async () => {
    const dir = nodePath.join(TEST_ROOT, "no-observer");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { lint: 'node -e "process.exit(0)"' },
    });
    await assert.doesNotReject(collectCompletionLint(dir, []));
  });

  void it("runCompletionLint (the commit/push and Publish-Checks-command entry point) has no way to pass an observer", () => {
    // `runCompletionLint` — used by runPublishChecks.ts (commit/push),
    // publishPreflight.ts's persisted-preflight branch, and
    // runLintingFixes.ts — takes only `(folderUri, relevantFiles?)` and
    // forwards to `collectCompletionLintPreview` with no `onCheckEvent`.
    // This is a structural (not just conventional) guarantee: there is no
    // parameter through which one of those callers COULD publish activity,
    // matching the plan's requirement that only the workflow completion-
    // stage caller in reviewActions.ts wires the observer.
    const source = nodeFs.readFileSync(
      nodePath.join(process.cwd(), "src", "utils", "completionLint.ts"),
      "utf8"
    );
    assert.match(
      source,
      /export async function runCompletionLint\(folderUri: vscode\.Uri, relevantFiles\?: readonly string\[\]\): Promise<CompletionLintResult> \{\s*const result = await collectCompletionLintPreview\(folderUri, relevantFiles, \{ allowScopePrompt: true \}\);/,
      "runCompletionLint must take no onCheckEvent-shaped option and must not forward one to collectCompletionLintPreview"
    );

    const preflightSource = nodeFs.readFileSync(
      nodePath.join(process.cwd(), "src", "utils", "publishPreflight.ts"),
      "utf8"
    );
    assert.ok(
      !preflightSource.includes("onCheckEvent"),
      "checkPublishPreflight must not reference onCheckEvent at all"
    );
  });
});
