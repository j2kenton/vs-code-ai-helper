/**
 * Task-list ordering contract: strictly newest-to-oldest by the parsed task
 * ID (creation date, then per-day task number) — never by raw string compare
 * alone, and never influenced by task status.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareTasksNewestFirst,
  parseTaskOrderKey,
} from "../state/taskInventory";

void describe("parseTaskOrderKey", () => {
  void it("parses the generated folder-name convention", () => {
    assert.deepEqual(parseTaskOrderKey("2026-07-08_task_12"), {
      date: "2026-07-08",
      num: 12,
    });
  });

  void it("returns undefined for names outside the convention", () => {
    assert.equal(parseTaskOrderKey("my-renamed-folder"), undefined);
    assert.equal(parseTaskOrderKey("task_3"), undefined);
  });
});

void describe("compareTasksNewestFirst", () => {
  void it("orders newer dates first", () => {
    const names = ["2026-07-01_task_1", "2026-07-10_task_1", "2026-07-05_task_1"];
    names.sort(compareTasksNewestFirst);
    assert.deepEqual(names, [
      "2026-07-10_task_1",
      "2026-07-05_task_1",
      "2026-07-01_task_1",
    ]);
  });

  void it("orders same-day tasks by numeric task number, not string compare", () => {
    const names = ["2026-07-08_task_2", "2026-07-08_task_10", "2026-07-08_task_1"];
    names.sort(compareTasksNewestFirst);
    assert.deepEqual(names, [
      "2026-07-08_task_10",
      "2026-07-08_task_2",
      "2026-07-08_task_1",
    ]);
  });

  void it("sorts conventional IDs ahead of non-conventional names", () => {
    const names = ["zzz-custom", "2026-07-08_task_1"];
    names.sort(compareTasksNewestFirst);
    assert.deepEqual(names, ["2026-07-08_task_1", "zzz-custom"]);
  });
});
