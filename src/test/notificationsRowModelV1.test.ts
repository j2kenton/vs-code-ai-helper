/**
 * bugs5 Step 26 (item 6): the Notifications row names only a model that is running, and says so while a
 * review runs its checks before any model starts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { candidateInvocationMessageV1 } from "../utils/dispatchModelChainV1";
import { describeOperationModelSegmentV1 } from "../utils/operationModelSegmentV1";
import { TaskOperationRegistry } from "../utils/taskOperations";

const read = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, "..", "..", "src", ...parts), "utf8");

void describe("bugs5 Step 26: the row's model segment", () => {
  void it("names no model and says the checks are running while a review runs its checks", () => {
    assert.equal(
      describeOperationModelSegmentV1({
        modelId: undefined,
        activity: "6 checks running · pnpm run test (+5) · 2/12 complete",
      }),
      "checks running; model not started yet"
    );
  });

  void it("names no model at all when nothing is known yet", () => {
    assert.equal(describeOperationModelSegmentV1({ modelId: undefined, activity: "starting" }), undefined);
  });

  void it("names the model once one is reported", () => {
    const segment = describeOperationModelSegmentV1({
      modelId: "claude-cli:claude-opus-5-5@high",
      activity: "reviewing",
    });
    assert.ok(segment && /Opus|opus/.test(segment), `got ${segment}`);
  });
});

void describe("bugs5 Step 26: a round start clears the previous round's model", () => {
  void it("the registry accepts setModel(undefined) and the root row then has no model", () => {
    const registry = new TaskOperationRegistry();
    const handle = registry.begin("/tmp/task-step26", { label: "Fast Forward Review", kind: "fast-forward" } as never);
    assert.ok(handle);
    registry.setModel(handle.id, "claude-cli:claude-sonnet-5-5@high");
    assert.equal(registry.getTaskOperations("/tmp/task-step26")[0]?.modelId, "claude-cli:claude-sonnet-5-5@high");
    registry.setModel(handle.id, undefined);
    assert.equal(registry.getTaskOperations("/tmp/task-step26")[0]?.modelId, undefined);
    registry.end(handle, "succeeded");
  });

  void it("review and generate-implementation starts clear the model before their first await", () => {
    const source = read("commands", "reviewActions.ts");
    const review = source.indexOf('const stageToken = options.operation?.reportActivity("starting"');
    assert.ok(review > 0);
    assert.ok(source.indexOf("options.operation?.setModel?.(undefined)", review) - review < 600);
    const impl = source.indexOf('const stageToken = op?.reportActivity("starting"');
    assert.ok(impl > 0);
    assert.ok(source.indexOf("op?.setModel?.(undefined)", impl) - impl < 400);
  });

  void it("the status row builds its model segment through describeOperationModelSegmentV1", () => {
    assert.match(read("views", "statusView.ts"), /describeOperationModelSegmentV1\(/);
  });
});

void describe("bugs5 Step 26: a backup takeover says why", () => {
  void it("adds the previous candidate's failure to the backup message", () => {
    assert.equal(
      candidateInvocationMessageV1(
        "High-Level Code Review",
        "claude-cli:claude-opus-5-5@high",
        "Claude Code",
        true,
        "Antigravity quota reached, resets in 6 d 11 h"
      ),
      "Backup started for High-Level Code Review: Claude Code — claude-cli:claude-opus-5-5@high. " +
        "The previous model did not serve it: Antigravity quota reached, resets in 6 d 11 h."
    );
  });

  void it("leaves the first candidate's message unchanged, and a backup with no known cause plain", () => {
    assert.equal(
      candidateInvocationMessageV1("implementation", "a:b", "A", false, "ignored"),
      "Running implementation with A — a:b."
    );
    assert.equal(candidateInvocationMessageV1("implementation", "a:b", "A", true), "Backup started for implementation: A — a:b.");
  });

  void it("the coordinator passes the first fallback reason to the observer", () => {
    assert.match(read("actions", "taskActionCoordinatorV1.ts"), /previousFailure: firstFallbackReasonV1/);
  });
});
