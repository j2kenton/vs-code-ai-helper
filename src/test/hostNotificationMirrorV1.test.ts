/**
 * The runner's notifications reach a viewer (hostNotificationMirrorV1.ts):
 * appended by one side, followed by the other, from the moment it opened.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  appendMirroredNotificationV1,
  createNotificationMirrorTailV1,
  HOST_NOTIFICATION_MIRROR_FILENAME_V1,
  MirroredNotificationV1,
} from "../services/hostNotificationMirrorV1";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ensemble-mirror-"));
}

function entry(message: string, level: MirroredNotificationV1["level"] = "warning"): MirroredNotificationV1 {
  return { at: "2026-09-17T10:17:26.071Z", level, message };
}

void describe("hostNotificationMirrorV1", () => {
  void it("a viewer sees what the runner reports after it started following — not the runner's history", async () => {
    const dir = await tempDir();
    try {
      await appendMirroredNotificationV1(dir, entry("old news, before the viewer opened"));
      const seen: string[] = [];
      const tail = await createNotificationMirrorTailV1(dir, (entries) => seen.push(...entries.map((e) => e.message)));
      await appendMirroredNotificationV1(dir, entry("Fast Forward Review: a prior implementation round was rejected"));
      await appendMirroredNotificationV1(dir, entry("completed", "info"));
      await tail.poll();
      assert.deepEqual(seen, ["Fast Forward Review: a prior implementation round was rejected", "completed"]);
      await tail.poll();
      assert.equal(seen.length, 2, "an entry is delivered once");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("a line still being written is held back until it is complete; malformed lines are skipped", async () => {
    const dir = await tempDir();
    try {
      const seen: string[] = [];
      const tail = await createNotificationMirrorTailV1(dir, (entries) => seen.push(...entries.map((e) => e.message)));
      const file = path.join(dir, HOST_NOTIFICATION_MIRROR_FILENAME_V1);
      const line = JSON.stringify(entry("split across writes"));
      await fs.writeFile(file, `not json\n${line.slice(0, 10)}`);
      await tail.poll();
      assert.deepEqual(seen, []);
      await fs.appendFile(file, `${line.slice(10)}\n`);
      await tail.poll();
      assert.deepEqual(seen, ["split across writes"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("when the runner starts a fresh file, the viewer reads it from the beginning", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, HOST_NOTIFICATION_MIRROR_FILENAME_V1);
      await fs.writeFile(file, `${JSON.stringify(entry("a long line of earlier history ".repeat(4)))}\n`);
      const seen: string[] = [];
      const tail = await createNotificationMirrorTailV1(dir, (entries) => seen.push(...entries.map((e) => e.message)));
      // Rotation: the file is replaced by a shorter one.
      await fs.rm(file);
      await appendMirroredNotificationV1(dir, entry("after rotation"));
      await tail.poll();
      assert.deepEqual(seen, ["after rotation"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
