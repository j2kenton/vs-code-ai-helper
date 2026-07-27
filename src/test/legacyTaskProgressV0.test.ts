/**
 * Proof that the §3.12 step-1 wrapper changes NO behavior: every member of
 * the named V0 boundary is the original permissive function by reference.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LegacyTaskProgressReaderV0,
  LegacyTaskProgressWriterV0,
} from "../utils/legacyTaskProgressV0";
import {
  createTaskProgress,
  findAllTasks,
  findIncompleteTasks,
  patchTaskProgress,
  readTaskProgress,
  writeTaskProgress,
} from "../utils/taskProgressUtils";

void describe("legacyTaskProgressV0", () => {
  void it("re-exports the permissive reader surface by reference", () => {
    assert.equal(LegacyTaskProgressReaderV0.readTaskProgress, readTaskProgress);
    assert.equal(LegacyTaskProgressReaderV0.findAllTasks, findAllTasks);
    assert.equal(LegacyTaskProgressReaderV0.findIncompleteTasks, findIncompleteTasks);
  });

  void it("re-exports the permissive writer surface by reference", () => {
    assert.equal(LegacyTaskProgressWriterV0.writeTaskProgress, writeTaskProgress);
    assert.equal(LegacyTaskProgressWriterV0.patchTaskProgress, patchTaskProgress);
    assert.equal(LegacyTaskProgressWriterV0.createTaskProgress, createTaskProgress);
  });
});
