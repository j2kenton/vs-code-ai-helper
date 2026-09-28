/**
 * RC1 item 11: a stage action refused because the task is paused is a warning
 * carrying a Resume button for that exact task — not an info message.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  deactivateNotificationRouter,
  initNotificationRouter,
  type StatusSurface,
} from "../utils/notificationRouter";
import { showPausedTaskRefusalV1 } from "../utils/pausedTaskRefusalV1";

void describe("showPausedTaskRefusalV1 (RC1 item 11)", () => {
  void it("posts a warning whose Resume button targets this task's folder", () => {
    const entries: { message: string; level: string; actionCommand?: { command: string; title: string; args?: unknown[] } }[] = [];
    const surface: StatusSurface = {
      addEntry: (message, level, _filePath, _resultTargetUri, _sourceOperationId, actionCommand): void => {
        entries.push({ message, level, actionCommand });
      },
    };
    initNotificationRouter(surface);
    try {
      showPausedTaskRefusalV1("running a review", "/tmp/plans/task-a");
    } finally {
      deactivateNotificationRouter();
    }
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "warning");
    assert.match(entries[0]?.message ?? "", /"task-a" is paused\. Resume it before running a review\./);
    assert.deepEqual(entries[0]?.actionCommand, {
      command: "vs-code-ai-helper.resumeTask",
      title: "Resume",
      args: [{ taskFolderPath: "/tmp/plans/task-a" }],
    });
  });

  void it("no command in src still refuses a paused task with an info message", () => {
    const commandsDir = path.join(__dirname, "..", "..", "src", "commands");
    const offenders: string[] = [];
    for (const name of fs.readdirSync(commandsDir)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const source = fs.readFileSync(path.join(commandsDir, name), "utf8");
      if (/showInformation\(\s*["'`][^"'`]*is paused\. Resume it before/.test(source)) {
        offenders.push(name);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
