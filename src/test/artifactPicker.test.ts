/**
 * Pure coverage for `prepareArtifactPicker` (wf10 item 21): every
 * task-listing picker must render `displayName` as the label with the
 * folder id as description, not the raw folder id as the whole label.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareArtifactPicker } from "../utils/artifactPicker";

interface FakeUri {
  value: string;
  toString(): string;
}

function uri(value: string): FakeUri {
  return { value, toString: () => value };
}

void describe("prepareArtifactPicker — displayName as label, folder id as description", () => {
  void it("uses displayName as the label and folderName as the description when displayName is present", () => {
    const { items } = prepareArtifactPicker({
      tasks: [{ folderName: "2026-08-21_task_4", folderUri: uri("a"), displayName: "september referral contest" }],
      hasPlanMap: new Map(),
      mode: "viewTask",
    });
    assert.deepEqual(items, [
      { label: "september referral contest", description: "2026-08-21_task_4", task: items[0]!.task },
    ]);
  });

  void it("falls back to folderName as the label with no description when displayName is absent", () => {
    const { items } = prepareArtifactPicker({
      tasks: [{ folderName: "2026-08-21_task_4", folderUri: uri("a") }],
      hasPlanMap: new Map(),
      mode: "viewTask",
    });
    assert.equal(items[0]!.label, "2026-08-21_task_4");
    assert.equal(items[0]!.description, undefined, "must not duplicate the label as its own description");
  });

  void it("carries displayName through the viewPlan filter unchanged", () => {
    const withPlan = uri("with-plan");
    const hasPlanMap = new Map([[withPlan.toString(), true]]);
    const { items } = prepareArtifactPicker({
      tasks: [
        { folderName: "task-with-plan", folderUri: withPlan, displayName: "Friendly Name" },
        { folderName: "task-without-plan", folderUri: uri("without-plan"), displayName: "Other Name" },
      ],
      hasPlanMap,
      mode: "viewPlan",
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.label, "Friendly Name");
    assert.equal(items[0]!.description, "task-with-plan");
  });
});
