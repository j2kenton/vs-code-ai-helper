/**
 * run1 Step 17: the owning host's process probe. A dead pid is reported at once, settles the round
 * once after 10 s when nothing else did, never settles ahead of report recovery, and a viewer never
 * probes at all.
 */
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { PROCESS_PROBE_SETTLE_AFTER_MS_V1, ProcessProbeV1 } from "../utils/processProbeV1";

function harness(options: { ownsProcess?: boolean; canSettle?: () => boolean } = {}) {
  let t = 0;
  let alive = true;
  const events: string[] = [];
  const probe = new ProcessProbeV1({
    pid: 1234,
    ownsProcess: options.ownsProcess ?? true,
    canSettle: options.canSettle ?? (() => true),
    onGone: () => events.push("gone"),
    onSettle: () => events.push("settle"),
    isAlive: () => alive,
    now: () => t,
  });
  return {
    probe,
    events,
    advance: (ms: number) => (t += ms),
    kill: () => (alive = false),
  };
}

void describe("ProcessProbeV1 (run1 Step 17)", () => {
  void it("a live process is never reported or settled", () => {
    const h = harness();
    h.probe.check();
    h.advance(60_000);
    h.probe.check();
    assert.deepEqual(h.events, []);
  });

  void it("a dead pid with nothing else settling is reported at once and settles exactly once within 10 s", () => {
    const h = harness();
    h.kill();
    h.probe.check();
    assert.deepEqual(h.events, ["gone"], "the row stops saying running at the first probe");
    h.advance(PROCESS_PROBE_SETTLE_AFTER_MS_V1 - 1);
    h.probe.check();
    assert.deepEqual(h.events, ["gone"], "not before the wait is over");
    h.advance(1);
    h.probe.check();
    h.advance(5_000);
    h.probe.check();
    assert.deepEqual(h.events, ["gone", "settle"], "settled once");
  });

  void it("a dead pid during report recovery does not settle before the recovery does", () => {
    let recovering = true;
    const h = harness({ canSettle: () => !recovering });
    h.kill();
    h.probe.check();
    h.advance(PROCESS_PROBE_SETTLE_AFTER_MS_V1 + 30_000);
    h.probe.check();
    assert.deepEqual(h.events, ["gone"], "recovery owns the settlement");
    recovering = false;
    h.probe.check();
    assert.deepEqual(h.events, ["gone", "settle"]);
  });

  void it("a probe stopped by another settlement never settles", () => {
    const h = harness();
    h.kill();
    h.probe.check();
    h.probe.stop();
    h.advance(PROCESS_PROBE_SETTLE_AFTER_MS_V1 * 2);
    h.probe.check();
    assert.deepEqual(h.events, ["gone"]);
  });

  void it("a viewer-side probe never checks, reports or settles", () => {
    const h = harness({ ownsProcess: false });
    h.kill();
    h.probe.check();
    h.advance(PROCESS_PROBE_SETTLE_AFTER_MS_V1 * 3);
    h.probe.check();
    assert.deepEqual(h.events, []);
  });

  void it("notices a process killed by hand, with the real pid check", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(function(){},1000)"], { stdio: "ignore" });
    const pid = child.pid;
    assert.ok(pid !== undefined);
    const events: string[] = [];
    const probe = new ProcessProbeV1({
      pid,
      ownsProcess: true,
      canSettle: () => true,
      onGone: () => events.push("gone"),
      onSettle: () => events.push("settle"),
    });
    probe.check();
    assert.deepEqual(events, []);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    probe.check();
    assert.deepEqual(events, ["gone"]);
  });
});
