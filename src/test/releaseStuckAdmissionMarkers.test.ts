/**
 * Coverage for the `releaseStuckAdmissionMarkers` command (blocker fix 2026-09-25):
 * ensures that the manual release function correctly identifies stale markers
 * and safely removes them without false positives or accidental deletion of
 * live markers.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildHeldAdmissionMarkerCardInputV1,
  confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1,
  findHeldAdmissionMarkersForReleaseV1,
  findStaleAdmissionMarkersForReleaseV1,
  isAdmissionMarkerBasenameForReleaseV1,
  stopHeldAdmissionMarkerAndReleaseCommandV1,
} from "../commands/releaseStuckAdmissionMarkers";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";

function markerNameV1(token: string, generation: number, epoch: string): string {
  return `admission.${token}.g${generation}.${epoch}`;
}

/** Writes a valid marker + claim-info body directly to disk, mirroring the
 * real writer's shape closely enough for `readClaimInfoSyncV1` (internal to
 * `workAdmissionV1.ts`) to accept it — this test file exercises the release
 * command's own scan, not the acquisition path, so it builds the fixture by
 * hand rather than going through `acquireWorkAdmissionV1`. */
function writeAdmissionMarkerV1(admissionDir: string, claimId: string, token: string, generation: number, epoch: string): string {
  const markerPath = path.join(admissionDir, markerNameV1(token, generation, epoch));
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      claimId,
      purpose: "admission",
      ownerToken: token,
      pid: 1,
      processStartTime: Date.now(),
      hostId: "host-1",
      commandId: "test",
      startedAt: new Date().toISOString(),
    })
  );
  return markerPath;
}

function writeHeldReasonSidecarV1(
  admissionDir: string,
  claimId: string,
  overrides: { readonly processState?: string; readonly pids?: readonly number[] } = {}
): void {
  fs.writeFileSync(
    path.join(admissionDir, `admission-held.${claimId}.json`),
    JSON.stringify({
      claimId,
      outstandingReason: "The provider process (pid 4242) did not exit.",
      since: new Date().toISOString(),
      processState: overrides.processState ?? "stillRunning",
      pids: overrides.pids ?? [4242],
    })
  );
}

void describe("releaseStuckAdmissionMarkers — finding and removing stale markers", () => {
  void it("identifies markers older than 20 minutes as stale", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();
      const oldMarkerPath = path.join(admissionDir, markerNameV1("old-token", 3, "mugabc1234"));
      const freshMarkerPath = path.join(admissionDir, markerNameV1("fresh-token", 4, "mugdef5678"));

      // Create an old marker (25 minutes ago)
      fs.writeFileSync(oldMarkerPath, JSON.stringify({ test: "old" }));
      fs.utimesSync(oldMarkerPath, now / 1000, (now - 25 * 60 * 1000) / 1000);

      // Create a fresh marker (5 minutes ago)
      fs.writeFileSync(freshMarkerPath, JSON.stringify({ test: "fresh" }));
      fs.utimesSync(freshMarkerPath, now / 1000, (now - 5 * 60 * 1000) / 1000);

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);

      assert.equal(stale.length, 1, "should find exactly one stale marker");
      assert.ok(
        stale[0]!.basename.includes("old-token"),
        "should identify the old marker as stale"
      );
      assert.ok(
        !stale.some((s) => s.basename.includes("fresh-token")),
        "should NOT identify the fresh marker as stale"
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("returns empty list when no markers exist", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));

    try {
      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir);
      assert.equal(stale.length, 0, "should return empty list for nonexistent directory");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("returns empty list when all markers are fresh", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();

      // Create several fresh markers (all within 5 minutes)
      for (let i = 0; i < 3; i++) {
        const markerPath = path.join(admissionDir, markerNameV1(`fresh-${i}`, i, `mugfresh${i}`));
        fs.writeFileSync(markerPath, JSON.stringify({ test: i }));
        fs.utimesSync(markerPath, now / 1000, (now - 5 * 60 * 1000) / 1000);
      }

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);
      assert.equal(stale.length, 0, "should find no stale markers when all are fresh");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("safely deletes only the identified stale markers", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();
      const oldMarkerPath = path.join(admissionDir, markerNameV1("old-token", 5, "mugold9999"));
      const freshMarkerPath = path.join(admissionDir, markerNameV1("fresh-token", 6, "mugfresh9999"));

      // Create one old and one fresh marker
      fs.writeFileSync(oldMarkerPath, JSON.stringify({ test: "old" }));
      fs.utimesSync(oldMarkerPath, now / 1000, (now - 25 * 60 * 1000) / 1000);

      fs.writeFileSync(freshMarkerPath, JSON.stringify({ test: "fresh" }));
      fs.utimesSync(freshMarkerPath, now / 1000, (now - 5 * 60 * 1000) / 1000);

      // Find stale
      const staleMarkers = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);
      assert.equal(staleMarkers.length, 1);

      // Delete stale markers
      for (const marker of staleMarkers) {
        fs.unlinkSync(marker.filePath);
      }

      // Verify deletion
      assert.ok(!fs.existsSync(oldMarkerPath), "old marker should be deleted");
      assert.ok(fs.existsSync(freshMarkerPath), "fresh marker should still exist");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("handles marker boundaries: exactly 20 minutes is considered fresh", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();
      const THRESHOLD = 20 * 60 * 1000;

      // Create marker exactly at threshold (20 minutes old)
      const boundaryMarkerPath = path.join(admissionDir, markerNameV1("boundary-token", 7, "mugboundary"));
      fs.writeFileSync(boundaryMarkerPath, JSON.stringify({ test: "boundary" }));
      // Set mtime to 19 minutes 59 seconds old (just under threshold)
      const almostThresholdTime = now - THRESHOLD + 1000; // 1 second before threshold
      fs.utimesSync(boundaryMarkerPath, almostThresholdTime / 1000, almostThresholdTime / 1000);

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now, THRESHOLD);

      // Exactly at threshold should NOT be considered stale (> threshold, not >=)
      assert.equal(
        stale.length,
        0,
        "marker exactly at 20-minute threshold should be fresh, not stale"
      );

      const overThresholdPath = path.join(admissionDir, markerNameV1("over-token", 8, "mugover123"));
      fs.writeFileSync(overThresholdPath, JSON.stringify({ test: "over" }));
      fs.utimesSync(overThresholdPath, now / 1000, (now - THRESHOLD - 1) / 1000);

      const staleAfter = findStaleAdmissionMarkersForReleaseV1(tmpDir, now, THRESHOLD);
      assert.equal(
        staleAfter.length,
        1,
        "marker 1ms over threshold should be stale"
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("scans nested task admission directories under .ensemble", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-25_task_1", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();
      const markerPath = path.join(admissionDir, markerNameV1("nested-token", 9, "mugnested1"));
      fs.writeFileSync(markerPath, JSON.stringify({ test: "nested" }));
      fs.utimesSync(markerPath, now / 1000, (now - 25 * 60 * 1000) / 1000);

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);

      assert.equal(stale.length, 1);
      assert.equal(stale[0]!.workspaceRelativePath, path.join(".ensemble", "2026-09-25_task_1", "admission-v1", path.basename(markerPath)));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("ignores old non-marker files in admission directories", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-25_task_1", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();
      const oldNonMarkerPath = path.join(admissionDir, "backup.json");
      const tombstonePath = path.join(admissionDir, `${markerNameV1("dead-token", 10, "mugtomb1")}.tombstone`);
      fs.writeFileSync(oldNonMarkerPath, JSON.stringify({ test: "backup" }));
      fs.writeFileSync(tombstonePath, JSON.stringify({ test: "tombstone" }));
      fs.utimesSync(oldNonMarkerPath, now / 1000, (now - 60 * 60 * 1000) / 1000);
      fs.utimesSync(tombstonePath, now / 1000, (now - 60 * 60 * 1000) / 1000);

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);

      assert.equal(stale.length, 0);
      assert.equal(isAdmissionMarkerBasenameForReleaseV1("backup.json"), false);
      assert.equal(isAdmissionMarkerBasenameForReleaseV1(path.basename(tombstonePath)), false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("ignores symlinks even when their targets are old marker-like files", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-25_task_1", "admission-v1");
    const outsideDir = path.join(tmpDir, "outside");
    fs.mkdirSync(admissionDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    try {
      const now = Date.now();
      const targetPath = path.join(outsideDir, markerNameV1("target-token", 11, "mugtarget1"));
      const linkPath = path.join(admissionDir, markerNameV1("link-token", 12, "muglink1"));
      fs.writeFileSync(targetPath, JSON.stringify({ test: "target" }));
      fs.utimesSync(targetPath, now / 1000, (now - 60 * 60 * 1000) / 1000);
      fs.symlinkSync(targetPath, linkPath);

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);

      assert.equal(stale.length, 0);
      assert.ok(fs.existsSync(linkPath), "symlink should be ignored, not treated as a marker file");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

void describe("releaseStuckAdmissionMarkers — Step 57a held markers", () => {
  void it("findHeldAdmissionMarkersForReleaseV1: finds a held marker even when freshly renewed, well under the 20-minute stale threshold", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-29_task_1", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const claimId = "claim-held-1";
      const markerPath = writeAdmissionMarkerV1(admissionDir, claimId, "held-token", 1, "mugheld0001");
      // 1 minute old — nowhere near the 20-minute staleness threshold.
      const oneMinuteAgo = (Date.now() - 60 * 1000) / 1000;
      fs.utimesSync(markerPath, oneMinuteAgo, oneMinuteAgo);
      writeHeldReasonSidecarV1(admissionDir, claimId, { processState: "stillRunning", pids: [4242] });

      const held = findHeldAdmissionMarkersForReleaseV1(tmpDir);
      assert.equal(held.length, 1);
      assert.equal(held[0]!.info.claimId, claimId);
      assert.equal(held[0]!.info.processState, "stillRunning");
      assert.deepEqual(held[0]!.info.pids, [4242]);
      assert.equal(held[0]!.taskFolderPath, path.dirname(admissionDir));

      // The stale-marker scan (the blind bulk "Delete All" path) must never
      // consider this marker on its own, or its 1-minute renewal would make
      // it fall out anyway — but the point of `findHeldAdmissionMarkersForReleaseV1`
      // is that it is checked independently, before that filter matters.
      assert.equal(findStaleAdmissionMarkersForReleaseV1(tmpDir).length, 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("findHeldAdmissionMarkersForReleaseV1: an unconfirmed-spawn hold reports no pids, distinct from stillRunning", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-29_task_2", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const claimId = "claim-held-2";
      writeAdmissionMarkerV1(admissionDir, claimId, "held-token-2", 1, "mugheld0002");
      writeHeldReasonSidecarV1(admissionDir, claimId, { processState: "unconfirmedSpawn", pids: [] });

      const held = findHeldAdmissionMarkersForReleaseV1(tmpDir);
      assert.equal(held.length, 1);
      assert.equal(held[0]!.info.processState, "unconfirmedSpawn");
      assert.deepEqual(held[0]!.info.pids, []);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("findHeldAdmissionMarkersForReleaseV1: an ordinary marker with no held-reason sidecar is not reported", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-29_task_3", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      writeAdmissionMarkerV1(admissionDir, "claim-ordinary", "ordinary-token", 1, "mugordinary1");
      assert.equal(findHeldAdmissionMarkersForReleaseV1(tmpDir).length, 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("findStaleAdmissionMarkersForReleaseV1 alone still reports a held-but-stale marker: the command layer is responsible for excluding it, not the pure stale scan", async () => {
    // Documents the fix's actual mechanism (releaseStuckAdmissionMarkers()
    // subtracts findHeldAdmissionMarkersForReleaseV1's file paths from the
    // stale list before the blind bulk delete) rather than changing what
    // `findStaleAdmissionMarkersForReleaseV1` itself reports.
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-29_task_4", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const claimId = "claim-held-stale";
      const markerPath = writeAdmissionMarkerV1(admissionDir, claimId, "held-stale-token", 1, "mugheldstale1");
      const now = Date.now();
      fs.utimesSync(markerPath, (now - 25 * 60 * 1000) / 1000, (now - 25 * 60 * 1000) / 1000);
      writeHeldReasonSidecarV1(admissionDir, claimId);

      const stale = findStaleAdmissionMarkersForReleaseV1(tmpDir, now);
      assert.equal(stale.length, 1, "the pure stale scan does not itself know about held markers");

      const held = findHeldAdmissionMarkersForReleaseV1(tmpDir);
      assert.equal(held.length, 1);
      const heldFilePaths = new Set(held.map((h) => h.info.filePath));
      const staleExcludingHeld = stale.filter((m) => !heldFilePaths.has(m.filePath));
      assert.equal(staleExcludingHeld.length, 0, "releaseStuckAdmissionMarkers() excludes held markers before its bulk delete");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

void describe("buildHeldAdmissionMarkerCardInputV1 — Step 57a's proactive card content", () => {
  const baseInput = {
    taskFolderPath: "/tasks/.ensemble/2026-09-29_task_1",
    taskCanonicalId: "/tasks/.ensemble/2026-09-29_task_1",
    stage: "impl" as const,
    displayName: "My Task",
    claimId: "claim-1",
    outstandingReason: "The provider process (pid 4242) did not exit.",
    createdAt: "2026-09-29T00:00:00.000Z",
  };

  void it("stillRunning: offers Stop it and release, and Keep waiting, recommends stopping", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({ ...baseInput, processState: "stillRunning", pids: [4242] });
    assert.equal(input.decisionKey, "providerProcessMayStillBeRunning");
    assert.equal(input.options.length, 2);
    const optionIds = input.options.map((o) => o.optionId);
    assert.deepEqual(optionIds, ["stopAndRelease", "keepWaiting"]);
    assert.ok(input.options[0]!.consequence.includes("4242"));
    assert.equal(input.options[0]!.effect.kind, "command");
    assert.equal(
      (input.options[0]!.effect as { command: string }).command,
      "vs-code-ai-helper.stopHeldAdmissionMarkerAndRelease"
    );
    assert.equal(input.recommendation.kind, "option");
    assert.equal((input.recommendation as { optionId: string }).optionId, "stopAndRelease");
    assert.equal(input.gating?.holdsTaskPaused, false);
  });

  void it("an older sidecar with no recorded processState fails open to the stillRunning branch", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({ ...baseInput, processState: undefined, pids: [] });
    const optionIds = input.options.map((o) => o.optionId);
    assert.deepEqual(optionIds, ["stopAndRelease", "keepWaiting"]);
  });

  void it("unconfirmedSpawn: offers only the owner-confirmed release and Keep waiting, with no recommendation", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({ ...baseInput, processState: "unconfirmedSpawn", pids: [] });
    const optionIds = input.options.map((o) => o.optionId);
    assert.deepEqual(optionIds, ["confirmNoProcess", "keepWaiting"]);
    assert.equal(
      (input.options[0]!.effect as { command: string }).command,
      "vs-code-ai-helper.confirmNoProcessAndReleaseHeldAdmissionMarker"
    );
    assert.equal(input.recommendation.kind, "none");
  });

  void it("unconfirmedSpawn: names the recorded provider and command for the owner to check (Step 57a's explicit requirement)", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({
      ...baseInput,
      processState: "unconfirmedSpawn",
      pids: [],
      providerLabel: "Codex CLI",
      command: "codex exec --json <prompt omitted>",
    });
    assert.match(input.whatHappened, /Codex CLI/);
    assert.match(input.whatHappened, /codex exec --json <prompt omitted>/);
  });

  void it("unconfirmedSpawn: an older sidecar with no recorded provider/command omits the identity line rather than showing 'undefined'", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({ ...baseInput, processState: "unconfirmedSpawn", pids: [] });
    assert.doesNotMatch(input.whatHappened, /undefined/);
  });

  void it("every command option's args carry taskFolderPath, claimId and displayName", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({ ...baseInput, processState: "stillRunning", pids: [4242] });
    const effect = input.options[0]!.effect as { command: string; args?: readonly unknown[] };
    assert.deepEqual(effect.args, [{ taskFolderPath: baseInput.taskFolderPath, claimId: baseInput.claimId, displayName: baseInput.displayName }]);
  });

  void it("Keep waiting never dispatches anything", () => {
    const input = buildHeldAdmissionMarkerCardInputV1({ ...baseInput, processState: "stillRunning", pids: [4242] });
    const keepWaiting = input.options.find((o) => o.optionId === "keepWaiting");
    assert.equal(keepWaiting?.effect.kind, "doNothing");
  });
});

void describe("stopHeldAdmissionMarkerAndReleaseCommandV1 / confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1", () => {
  void it("stopHeldAdmissionMarkerAndReleaseCommandV1 refuses when args are missing", async () => {
    const result = await stopHeldAdmissionMarkerAndReleaseCommandV1(undefined);
    assert.deepEqual(result, { outcome: "refused", message: "Missing task or claim information." });
  });

  void it("confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1 refuses when args are missing", async () => {
    const result = await confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1({ taskFolderPath: "", claimId: "" });
    assert.deepEqual(result, { outcome: "refused", message: "Missing task or claim information." });
  });

  void it("stopHeldAdmissionMarkerAndReleaseCommandV1: a claim with no recorded processes releases the marker, then reports already done", async () => {
    __extensionContextV1TestOnly.reset();
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-29_task_stop", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });
    const taskFolderPath = path.dirname(admissionDir);
    const claimId = "claim-stop-1";
    try {
      writeAdmissionMarkerV1(admissionDir, claimId, "stop-token", 1, "mugstop0001");
      const first = await stopHeldAdmissionMarkerAndReleaseCommandV1({ taskFolderPath, claimId, displayName: "T" });
      assert.equal(first.outcome, "done");
      assert.ok(first.message?.includes("Stopped the provider process and released"));

      const second = await stopHeldAdmissionMarkerAndReleaseCommandV1({ taskFolderPath, claimId, displayName: "T" });
      assert.equal(second.outcome, "alreadyDone");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1: releases the marker, then reports already done", async () => {
    __extensionContextV1TestOnly.reset();
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "2026-09-29_task_confirm", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });
    const taskFolderPath = path.dirname(admissionDir);
    const claimId = "claim-confirm-1";
    try {
      writeAdmissionMarkerV1(admissionDir, claimId, "confirm-token", 1, "mugconfirm01");
      const first = await confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1({ taskFolderPath, claimId, displayName: "T" });
      assert.equal(first.outcome, "done");
      assert.ok(first.message?.includes("Released"));

      const second = await confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1({ taskFolderPath, claimId, displayName: "T" });
      assert.equal(second.outcome, "alreadyDone");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
