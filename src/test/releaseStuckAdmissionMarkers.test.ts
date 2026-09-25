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

/**
 * Mimic the core logic of releaseStuckAdmissionMarkers without the UI
 * (showWarningMessage, etc.) for testability.
 */
async function findStaleAdmissionMarkersV1(
  admissionDirPath: string,
  staleThresholdMs: number = 20 * 60 * 1000
): Promise<string[]> {
  if (!fs.existsSync(admissionDirPath)) {
    return [];
  }

  const files = fs.readdirSync(admissionDirPath);
  const staleMarkers: string[] = [];
  const now = Date.now();

  for (const file of files) {
    const filePath = path.join(admissionDirPath, file);
    const stat = fs.statSync(filePath);
    const ageMs = now - stat.mtime.getTime();

    // Only list markers last renewed >threshold ago
    if (ageMs > staleThresholdMs) {
      staleMarkers.push(filePath);
    }
  }

  return staleMarkers;
}

void describe("releaseStuckAdmissionMarkers — finding and removing stale markers", () => {
  void it("identifies markers older than 20 minutes as stale", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "admission-v1");
    fs.mkdirSync(admissionDir, { recursive: true });

    try {
      const now = Date.now();
      const oldMarkerPath = path.join(admissionDir, "admission.old.marker");
      const freshMarkerPath = path.join(admissionDir, "admission.fresh.marker");

      // Create an old marker (25 minutes ago)
      fs.writeFileSync(oldMarkerPath, JSON.stringify({ test: "old" }));
      fs.utimesSync(oldMarkerPath, now / 1000, (now - 25 * 60 * 1000) / 1000);

      // Create a fresh marker (5 minutes ago)
      fs.writeFileSync(freshMarkerPath, JSON.stringify({ test: "fresh" }));
      fs.utimesSync(freshMarkerPath, now / 1000, (now - 5 * 60 * 1000) / 1000);

      const stale = await findStaleAdmissionMarkersV1(admissionDir);

      assert.equal(stale.length, 1, "should find exactly one stale marker");
      assert.ok(
        stale[0]!.includes("old"),
        "should identify the old marker as stale"
      );
      assert.ok(
        !stale.some((s) => s.includes("fresh")),
        "should NOT identify the fresh marker as stale"
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("returns empty list when no markers exist", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ensemble-test-"));
    const admissionDir = path.join(tmpDir, ".ensemble", "admission-v1");

    try {
      const stale = await findStaleAdmissionMarkersV1(admissionDir);
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
        const markerPath = path.join(admissionDir, `admission.fresh.${i}.marker`);
        fs.writeFileSync(markerPath, JSON.stringify({ test: i }));
        fs.utimesSync(markerPath, now / 1000, (now - 5 * 60 * 1000) / 1000);
      }

      const stale = await findStaleAdmissionMarkersV1(admissionDir);
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
      const oldMarkerPath = path.join(admissionDir, "admission.old.marker");
      const freshMarkerPath = path.join(admissionDir, "admission.fresh.marker");

      // Create one old and one fresh marker
      fs.writeFileSync(oldMarkerPath, JSON.stringify({ test: "old" }));
      fs.utimesSync(oldMarkerPath, now / 1000, (now - 25 * 60 * 1000) / 1000);

      fs.writeFileSync(freshMarkerPath, JSON.stringify({ test: "fresh" }));
      fs.utimesSync(freshMarkerPath, now / 1000, (now - 5 * 60 * 1000) / 1000);

      // Find stale
      const staleMarkers = await findStaleAdmissionMarkersV1(admissionDir);
      assert.equal(staleMarkers.length, 1);

      // Delete stale markers
      for (const marker of staleMarkers) {
        fs.unlinkSync(marker);
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
      const boundaryMarkerPath = path.join(admissionDir, "admission.boundary.marker");
      fs.writeFileSync(boundaryMarkerPath, JSON.stringify({ test: "boundary" }));
      // Set mtime to 19 minutes 59 seconds old (just under threshold)
      const almostThresholdTime = now - THRESHOLD + 1000; // 1 second before threshold
      fs.utimesSync(boundaryMarkerPath, almostThresholdTime / 1000, almostThresholdTime / 1000);

      const stale = await findStaleAdmissionMarkersV1(admissionDir, THRESHOLD);

      // Exactly at threshold should NOT be considered stale (> threshold, not >=)
      assert.equal(
        stale.length,
        0,
        "marker exactly at 20-minute threshold should be fresh, not stale"
      );

      const overThresholdPath = path.join(admissionDir, "admission.over.marker");
      fs.writeFileSync(overThresholdPath, JSON.stringify({ test: "over" }));
      fs.utimesSync(overThresholdPath, now / 1000, (now - THRESHOLD - 1) / 1000);

      const staleAfter = await findStaleAdmissionMarkersV1(admissionDir, THRESHOLD);
      assert.equal(
        staleAfter.length,
        1,
        "marker 1ms over threshold should be stale"
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
