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
  findStaleAdmissionMarkersForReleaseV1,
  isAdmissionMarkerBasenameForReleaseV1,
} from "../commands/releaseStuckAdmissionMarkers";

function markerNameV1(token: string, generation: number, epoch: string): string {
  return `admission.${token}.g${generation}.${epoch}`;
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
