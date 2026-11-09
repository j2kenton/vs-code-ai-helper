/**
 * run1 Step 28: a held owner answer is checked while it holds the task's work-admission claim, so the status
 * re-read, the swap from held to dispatching and the claim are ordered against Pause. A refusal gives the claim
 * back and starts nothing.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  acquireWorkAdmissionV1,
  hasLiveWorkAdmissionBestEffortV1,
  runHeldDispatchUnderAdmissionV1,
  setWorkAdmissionRootOverrideForTestV1,
} from "../state/workAdmissionV1";
import { runWithHeldDispatchIdV1, type HeldDispatchGateV1 } from "../state/automationDispatchContextV1";

const admissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "held-gate-"));

void describe("run1 Step 28: the held-dispatch check runs under the work-admission claim", () => {
  before(() => {
    setWorkAdmissionRootOverrideForTestV1((folder) => path.join(admissionRoot, Buffer.from(folder).toString("hex")));
  });
  after(() => {
    setWorkAdmissionRootOverrideForTestV1(undefined);
    fs.rmSync(admissionRoot, { recursive: true, force: true });
  });

  void it("runs once, while the claim is held, and lets the dispatch go ahead when it returns nothing", async () => {
    const folder = path.join(admissionRoot, "tasks", "gate-ok");
    let secondOutcome: string | undefined;
    let runs = 0;
    const gate: HeldDispatchGateV1 = {
      ran: false,
      run: async () => {
        runs += 1;
        // Another start for the same task, while the gate runs, finds the claim taken.
        const other = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "other" });
        secondOutcome = other.outcome;
        if (other.outcome === "acquired") await other.handle.release();
        return undefined;
      },
    };
    const first = await runWithHeldDispatchIdV1(
      "dispatch-1",
      () => acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "advanceStage" }),
      gate
    );
    assert.equal(first.outcome, "acquired");
    assert.equal(secondOutcome, "busy", "the check ran while the claim was held");
    assert.equal(runs, 1);
    assert.equal(gate.ran, true);
    if (first.outcome === "acquired") await first.handle.release();
  });

  void it("a refusal gives the claim back, reports why, and starts nothing; the check is not run again", async () => {
    const folder = path.join(admissionRoot, "tasks", "gate-refused");
    let runs = 0;
    const gate: HeldDispatchGateV1 = {
      ran: false,
      run: () => {
        runs += 1;
        return Promise.resolve("the task is paused");
      },
    };
    const refused = await runWithHeldDispatchIdV1(
      "dispatch-2",
      async () => {
        const first = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "advanceStage" });
        // The same dispatch asking again does not re-run the check.
        const again = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "advanceStage" });
        return { first, again };
      },
      gate
    );
    assert.equal(refused.first.outcome, "writeFailed");
    assert.match(refused.first.outcome === "writeFailed" ? refused.first.error.message : "", /the task is paused/);
    assert.equal(runs, 1);
    assert.equal(refused.again.outcome, "acquired", "the refused claim was given back, so the task is free");
    if (refused.again.outcome === "acquired") await refused.again.handle.release();
  });

  void it("a start that is not a held dispatch is never checked", async () => {
    const folder = path.join(admissionRoot, "tasks", "no-gate");
    const result = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "x" });
    assert.equal(result.outcome, "acquired");
    if (result.outcome === "acquired") await result.handle.release();
  });

  void it("a command that takes no admission still runs with the claim held, the gate runs once before it, and the claim is released after", async () => {
    const folder = path.join(admissionRoot, "tasks", "dispatch-free-command");
    const order: string[] = [];
    let claimHeldInside: boolean | undefined;
    const gate: HeldDispatchGateV1 = {
      ran: false,
      run: () => {
        order.push("gate");
        return Promise.resolve(undefined);
      },
    };
    const outcome = await runHeldDispatchUnderAdmissionV1({
      taskFolderPath: folder,
      dispatchId: "d-free",
      commandId: "heldAnswer:free",
      gate,
      body: () => {
        order.push("command");
        claimHeldInside = hasLiveWorkAdmissionBestEffortV1(folder);
        return Promise.resolve("value");
      },
    });
    assert.deepEqual(order, ["gate", "command"]);
    assert.equal(claimHeldInside, true, "the dispatch holds the claim while the command runs");
    assert.equal(outcome.kind === "ran" ? outcome.value : undefined, "value");
    assert.equal(hasLiveWorkAdmissionBestEffortV1(folder), false, "the claim is released when the command ends");
  });

  void it("a command that takes admission itself joins the dispatch's claim instead of being refused against it", async () => {
    const folder = path.join(admissionRoot, "tasks", "dispatch-joins");
    const gate: HeldDispatchGateV1 = { ran: false, run: () => Promise.resolve(undefined) };
    let nested: string | undefined;
    const outcome = await runHeldDispatchUnderAdmissionV1({
      taskFolderPath: folder,
      dispatchId: "d-join",
      commandId: "heldAnswer:takes",
      gate,
      body: async () => {
        const inner = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "advanceStage" });
        nested = inner.outcome;
        if (inner.outcome === "acquired") await inner.handle.release();
        // The inner release does not give up the dispatch's claim while the command is still running.
        return hasLiveWorkAdmissionBestEffortV1(folder);
      },
    });
    assert.equal(nested, "acquired");
    assert.equal(outcome.kind === "ran" ? outcome.value : undefined, true, "the claim was still held after the inner release");
    assert.equal(hasLiveWorkAdmissionBestEffortV1(folder), false);
  });

  void it("another window's claim refuses the dispatch before the command or the gate runs", async () => {
    const folder = path.join(admissionRoot, "tasks", "dispatch-busy");
    const other = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "other" });
    assert.equal(other.outcome, "acquired");
    let ran = false;
    const outcome = await runHeldDispatchUnderAdmissionV1({
      taskFolderPath: folder,
      dispatchId: "d-busy",
      commandId: "heldAnswer:busy",
      gate: {
        ran: false,
        run: () => {
          ran = true;
          return Promise.resolve(undefined);
        },
      },
      body: () => {
        ran = true;
        return Promise.resolve("never");
      },
    });
    assert.equal(outcome.kind, "refused");
    assert.equal(ran, false, "neither the gate nor the command ran");
    if (other.outcome === "acquired") await other.handle.release();
  });

  void it("the gate declining refuses the dispatch, gives the claim back and starts nothing", async () => {
    const folder = path.join(admissionRoot, "tasks", "dispatch-declined");
    let commandRan = false;
    const outcome = await runHeldDispatchUnderAdmissionV1({
      taskFolderPath: folder,
      dispatchId: "d-declined",
      commandId: "heldAnswer:declined",
      gate: { ran: false, run: () => Promise.resolve("the task is paused") },
      body: () => {
        commandRan = true;
        return Promise.resolve(undefined);
      },
    });
    assert.equal(outcome.kind, "refused");
    assert.equal(commandRan, false);
    assert.equal(hasLiveWorkAdmissionBestEffortV1(folder), false);
  });
});
