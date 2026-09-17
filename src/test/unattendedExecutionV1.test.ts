/**
 * Relayed work runs unattended; everything else does not
 * (unattendedExecutionV1.ts).
 *
 * The scoping is the point: the runner drains relayed requests concurrently
 * and runs its own scheduled work alongside them, so a process-wide flag
 * silenced confirmations for work the user WAS driving, and leaked for good
 * whenever the relay's deadline abandoned a command that kept running
 * (verification review, 2026-09-17).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUnattendedExecutionV1, runUnattendedV1, unattendedRefusalV1 } from "../state/unattendedExecutionV1";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

void describe("unattendedExecutionV1", () => {
  void it("marks only the call tree it was opened around", async () => {
    assert.equal(isUnattendedExecutionV1(), false);
    await runUnattendedV1(async () => {
      assert.equal(isUnattendedExecutionV1(), true);
      await tick();
      assert.equal(isUnattendedExecutionV1(), true, "and it survives awaits inside that tree");
      await runUnattendedV1(async () => {
        await tick();
        assert.equal(isUnattendedExecutionV1(), true, "nestable");
      });
    });
    assert.equal(isUnattendedExecutionV1(), false);
  });

  void it("work running concurrently is unaffected — a local confirmation still asks", async () => {
    const observed: boolean[] = [];
    const local = (async (): Promise<void> => {
      await tick();
      observed.push(isUnattendedExecutionV1());
    })();
    await Promise.all([
      runUnattendedV1(async () => {
        await tick();
        observed.push(isUnattendedExecutionV1());
      }),
      local,
    ]);
    assert.deepEqual(observed.sort(), [false, true], "the local tree is never marked");
  });

  void it("an abandoned relayed command cannot leave the flag set for later work", async () => {
    // What the relay's deadline does: it stops waiting while `work` keeps
    // running. Nothing after that may inherit the mark.
    let release: (() => void) | undefined;
    const abandoned = runUnattendedV1(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await tick();
    assert.equal(isUnattendedExecutionV1(), false, "the abandoning caller is not marked");
    release!();
    await abandoned;
    assert.equal(isUnattendedExecutionV1(), false);
  });

  void it("says what was refused and where it can be answered", () => {
    const message = unattendedRefusalV1("Sending a ~300 KB prompt to Claude");
    assert.match(message, /Sending a ~300 KB prompt to Claude/);
    assert.match(message, /Nothing was changed/);
    assert.match(message, /runner's own screen/);
  });
});
