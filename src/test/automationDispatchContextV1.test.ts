/**
 * An automated run never opens a modal (RC1 item 3, automationDispatchContextV1.ts).
 *
 * The scoped context is opened by the command entry for an invocation carrying
 * the exact `automationDispatch: true` marker; each confirmation site asks it
 * and takes its non-destructive default instead of awaiting a click.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  describeAutomationDefaultV1,
  isAutomationDispatchContextV1,
  runAsAutomationDispatchV1,
  withAutomationDispatchContextV1,
} from "../state/automationDispatchContextV1";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

void describe("automationDispatchContextV1", () => {
  void it("marks only the call tree it was opened around, across awaits", async () => {
    assert.equal(isAutomationDispatchContextV1(), false);
    await runAsAutomationDispatchV1(async () => {
      assert.equal(isAutomationDispatchContextV1(), true);
      await tick();
      assert.equal(isAutomationDispatchContextV1(), true);
    });
    assert.equal(isAutomationDispatchContextV1(), false);
  });

  void it("the command wrapper opens the context only for the exact literal marker", () => {
    const seen: boolean[] = [];
    const wrapped = withAutomationDispatchContextV1((_arg?: unknown) => {
      seen.push(isAutomationDispatchContextV1());
    });
    wrapped({ automationDispatch: true });
    wrapped({ automationDispatch: "true" });
    wrapped({ taskFolderPath: "x" });
    wrapped(undefined);
    assert.deepEqual(seen, [true, false, false, false]);
  });

  void it("names what was defaulted and how", () => {
    const text = describeAutomationDefaultV1("Sending a prompt", "declined");
    assert.match(text, /no human attached/);
    assert.match(text, /Sending a prompt/);
    assert.match(text, /declined/);
  });

  void describe("command entry points", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");

    void it("every command that composes a review runs an automation dispatch inside the context", () => {
      for (const id of [
        "runReviewWithAI",
        "applyReviewWithAI",
        "applyReviewEditWithAI",
        "fastForwardReviewWithAI",
        "runImplementationWithAI",
        "generateImplementationWithAI",
      ]) {
        assert.ok(
          source.includes(`forwardInViewerV1("vs-code-ai-helper.${id}", withAutomationDispatchContextV1(`),
          `${id} must open the automation context for an automationDispatch invocation`
        );
      }
    });

    void it("the implementation pre-run prompts and the unchanged-tree guard consult the context", () => {
      const preRunStart = source.indexOf("if (!options.skipPreRunSafetyCheck) {");
      assert.ok(preRunStart >= 0);
      const preRun = source.slice(preRunStart, preRunStart + 4000);
      assert.match(preRun, /isAutomationDispatchContextV1\(\)/);
      assert.match(source, /options\.automationDispatch \|\| isAutomationDispatchContextV1\(\)/);
    });
  });
});
