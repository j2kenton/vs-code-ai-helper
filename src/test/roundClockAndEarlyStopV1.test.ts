/**
 * bugs6 items 41 and 46 (Steps 12-16): the round prompt carries its clock, `date -u` is the one shell rule and is named
 * only where permitted, an early stop is flagged, and a step declined twice raises one card.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  appendRoundClockPolicyV1,
  buildRoundClockV1,
  formatUtcClockV1,
} from "../utils/roundClockV1";
import {
  resolveRoundShellCommandsV1,
  roundAdapterAllowsClockCommandV1,
} from "../utils/roundShellAllowlistV1";
import { claudeAllowedToolsValueV1 } from "../runners/providers";
import { isConversationEntryV1 } from "../views/chatTranscriptFilterV1";
import {
  describeEarlyStopChatLineV1,
  detectRoundEarlyStopV1,
  findRepeatedlyDeclinedStepV1,
  parseDeclinedStepsV1,
} from "../utils/roundEarlyStopV1";
import {
  buildDeclinedStepDecisionInputV1,
  DECLINED_STEP_GUIDANCE_FILE_V1,
  readDeclinedStepGuidanceV1,
  resolveDeclinedStepV1,
} from "../commands/declinedStepDecisionV1";
import { addNestedChecklistItemsV1, listUnsettledPlanItemsV1 } from "../utils/implementationChecklist";
import { formatRoundOutcomeMessageV1 } from "../utils/roundLedgerV1";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import type { RoundLedgerEntryV1 } from "../types/taskProgress";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

configureWorkflowPrivateStorageRootV1(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-clock-private-")));

const START = new Date("2026-11-07T19:36:00.000Z");
const PROMPTS = path.resolve(__dirname, "../../resources/prompts");

void describe("bugs6 item 41: the round prompt carries its clock", () => {
  void it("the clock runs 60 minutes from the start and is shown in UTC", () => {
    const clock = buildRoundClockV1(START, 4);
    assert.equal(formatUtcClockV1(clock.startedAt), "19:36 UTC");
    assert.equal(formatUtcClockV1(clock.budgetEndsAt), "20:36 UTC");
    // A lower configured backstop caps the stop the prompt names, so it is never later than the enforced one.
    assert.equal(formatUtcClockV1(buildRoundClockV1(START, 0.5).budgetEndsAt), "20:06 UTC");
  });

  void it("where the adapter may run `date -u`, the prompt names the start, the stop and the 10-minute rule", () => {
    const prompt = appendRoundClockPolicyV1("apply-impl-review-code.md", "BASE", {
      modelId: "claude-cli:claude-sonnet-5-5@high",
      now: START,
      backstopHours: 4,
    });
    assert.match(prompt, /started at 19:36 UTC/);
    assert.match(prompt, /time budget is 60 minutes and ends at 20:36 UTC/);
    assert.doesNotMatch(prompt, /hard stop/i);
    assert.match(prompt, /Run `date -u` to check the real time/);
    assert.match(prompt, /less than about 10 minutes left before 20:36 UTC/);
    assert.match(prompt, /never stop for time on a guess/);
  });

  void it("where the adapter gives no clock, the prompt says so and forbids stopping for time on a guess", () => {
    for (const modelId of ["codex-cli:gpt-6.1-sol@high", undefined]) {
      const prompt = appendRoundClockPolicyV1("run-implementation.md", "BASE", { modelId, now: START, backstopHours: 4 });
      assert.match(prompt, /started at 19:36 UTC/);
      assert.doesNotMatch(prompt, /Run `date -u`/);
      assert.match(prompt, /no way to read the clock/);
      assert.match(prompt, /do not stop for time on a guess/);
      assert.match(prompt, /Stop early only when every remaining step is blocked/);
      assert.match(prompt, /until the budget ends at 20:36 UTC/);
      assert.doesNotMatch(prompt, /hard stop|Ensemble end the round/i);
    }
  });

  void it("only the editing-round prompts carry the block", () => {
    assert.equal(appendRoundClockPolicyV1("review-impl-high.md", "BASE", { now: START }), "BASE");
  });

  void it("the Apply Review prompt carries the next-unblocked-step rule and the full-suite sentence", () => {
    const text = fs.readFileSync(path.join(PROMPTS, "apply-impl-review-code.md"), "utf8");
    assert.match(text, /When you decline or can't finish a step, record why under Remaining Blockers, then go on to the next step that nothing blocks\./);
    assert.match(text, /Stop early only when every remaining step is blocked, or when about 10 minutes are left\./);
    assert.match(text, /Rounds don't run the full suite because Publish Checks do/);
  });
});

void describe("bugs6 item 41: `date -u` is the one shell rule, exact and read-only", () => {
  void it("resolveRoundShellCommandsV1 returns exactly the one `date -u` rule, whatever the project", () => {
    assert.deepEqual(resolveRoundShellCommandsV1("/anything"), ["date -u"]);
    assert.deepEqual(resolveRoundShellCommandsV1(""), ["date -u"]);
  });

  void it("the Claude allow-list holds `Bash(date -u)` alone, with no wildcard form", () => {
    assert.equal(claudeAllowedToolsValueV1(["date -u"]), "Bash(date -u)");
    // Any other command keeps its two forms.
    assert.equal(claudeAllowedToolsValueV1(["pnpm run x"]), "Bash(pnpm run x),Bash(pnpm run x *)");
  });

  void it("only an adapter that reads the list is told it may run the clock", () => {
    assert.equal(roundAdapterAllowsClockCommandV1("claude-cli:sonnet@high"), true);
    assert.equal(roundAdapterAllowsClockCommandV1("codex-cli:gpt@high"), false);
    assert.equal(roundAdapterAllowsClockCommandV1("copilot-lm:x"), false);
    assert.equal(roundAdapterAllowsClockCommandV1(undefined), false);
  });
});

const MIN = 60_000;
const TIME_REPORT = [
  "## Remaining Blockers",
  "",
  "I stopped here because the round's time budget was nearly used up. Steps 26–30 change shared dispatch ordering, so I did not start them with so little time left.",
].join("\n");
const REPORT_032 = [
  "## Remaining Blockers",
  "",
  "- Part 6's dispatch: I stopped because `runReviewForFolder` is about 2,300 lines. That needs a full-suite run, which this round does not allow.",
  "- The remaining Part 8 steps, Part 9, Part 10 and the two verification items are unbuilt. Nothing in the code blocks them.",
].join("\n");

void describe("bugs6 item 46: the Apply Review prompt has one rule for stopping early", () => {
  void it("no older sentence tells the round to stop when work 'will not fit'; the 10-minute rule stands alone", () => {
    const prompt = fs.readFileSync(path.join(process.cwd(), "resources", "prompts", "apply-impl-review-code.md"), "utf8");
    assert.doesNotMatch(prompt, /will not fit in the budget/);
    assert.match(prompt, /Stop for time only when the round clock shows about 10 minutes or less left/);
    assert.match(prompt, /go on to the next step that nothing blocks/);
  });
});

void describe("bugs6 items 41 and 46: the early-stop flag is a visible chat line", () => {
  void it("the chat line carries the flag, is shown in the transcript, and the outcome-kind Ended line is not", () => {
    const flagged = detectRoundEarlyStopV1({ summary: TIME_REPORT, startedAtMs: 0, endedAtMs: 12 * MIN });
    assert.ok(flagged);
    const text = describeEarlyStopChatLineV1(flagged);
    assert.match(text, /stopped early: 12 of 60 minutes used/);
    assert.equal(isConversationEntryV1({ role: "assistant", text }), true);
    assert.equal(isConversationEntryV1({ role: "assistant", text, kind: "outcome" }), false);
  });

  void it("executeImplementationRun posts the line once per round, before each completed-round terminalize", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");
    assert.match(source, /text: describeEarlyStopChatLineV1\(flagged\)/);
    const calls = source.split("await postEarlyStopChatLineV1();").length - 1;
    assert.equal(calls, 2, "both completed-round exits post the flag before terminalizing the round");
    assert.match(source, /let earlyStopChatLinePosted = false;/);
  });
});

void describe("bugs6 items 41 and 46: an early stop is flagged", () => {
  void it("12 of 60 minutes with a time claim is flagged; 50 of 60 is not", () => {
    const flagged = detectRoundEarlyStopV1({ summary: TIME_REPORT, startedAtMs: 0, endedAtMs: 12 * MIN });
    assert.equal(flagged?.kind, "time-claim");
    assert.equal(flagged?.text, "stopped early: 12 of 60 minutes used");
    assert.equal(detectRoundEarlyStopV1({ summary: TIME_REPORT, startedAtMs: 0, endedAtMs: 50 * MIN }), undefined);
    assert.equal(detectRoundEarlyStopV1({ summary: TIME_REPORT, startedAtMs: 0, endedAtMs: 30 * MIN }), undefined, "half used is not early");
  });

  void it("phrases alone never flag: a round that says nothing about time or unblocked steps is not flagged", () => {
    assert.equal(
      detectRoundEarlyStopV1({ summary: "## Remaining Blockers\n\nNone.", startedAtMs: 0, endedAtMs: 3 * MIN }),
      undefined
    );
    assert.equal(detectRoundEarlyStopV1({ summary: TIME_REPORT, startedAtMs: Number.NaN, endedAtMs: 12 * MIN }), undefined);
  });

  void it("the 6-minute run 032 shape: unblocked steps left after 6 of 60 minutes", () => {
    const flagged = detectRoundEarlyStopV1({ summary: REPORT_032, startedAtMs: 0, endedAtMs: 6 * MIN });
    assert.equal(flagged?.kind, "unblocked-steps");
    assert.ok((flagged?.unblockedSteps ?? 0) >= 3);
    assert.match(flagged?.text ?? "", /^stopped after 6 of 60 minutes with \d+ unblocked steps left$/);
  });

  void it("the Ended line carries the flag", () => {
    const entry = {
      roundId: "r",
      stage: "impl-high-review",
      mode: "apply-review",
      state: "completed",
      startedAt: "2026-11-09T19:36:00.000Z",
      endedAt: "2026-11-09T19:42:00.000Z",
      attemptIds: ["a"],
      outcome: { filesChanged: ["src/a.ts"], stoppedEarly: "stopped after 6 of 60 minutes with 9 unblocked steps left" },
    } as unknown as RoundLedgerEntryV1;
    assert.match(formatRoundOutcomeMessageV1(entry), /stopped after 6 of 60 minutes with 9 unblocked steps left/);
  });
});

void describe("bugs6 item 46: steps declined twice raise one card", () => {
  void it("records the declined step with its reason and kind; a line that only says other steps are unblocked is not a decline", () => {
    const declined = parseDeclinedStepsV1(REPORT_032);
    assert.equal(declined.length, 1);
    assert.equal(declined[0]?.step, "Part 6");
    assert.equal(declined[0]?.kind, "full-suite");
    assert.match(declined[0]?.reason ?? "", /needs a full-suite run, which this round does not allow/);
  });

  const row = (kind: "full-suite" | "too-large" | "other", step = "Part 6") => ({
    declinedSteps: [{ step, kind, reason: "needs a full-suite run" }],
  });

  void it("two rounds raise it; one round, two different steps, or an 'other' reason do not", () => {
    assert.equal(findRepeatedlyDeclinedStepV1([row("full-suite"), row("full-suite")])?.step, "Part 6");
    assert.equal(findRepeatedlyDeclinedStepV1([row("full-suite")]), undefined);
    assert.equal(findRepeatedlyDeclinedStepV1([row("full-suite", "Part 6"), row("full-suite", "Part 7")]), undefined);
    assert.equal(findRepeatedlyDeclinedStepV1([row("other"), row("other")]), undefined);
    // One round that lists the same step twice is still one round.
    assert.equal(
      findRepeatedlyDeclinedStepV1([{ declinedSteps: [row("full-suite").declinedSteps[0]!, row("full-suite").declinedSteps[0]!] }]),
      undefined
    );
    assert.equal(findRepeatedlyDeclinedStepV1([row("full-suite"), row("full-suite")], new Set(["Part 6"])), undefined);
  });

  void it("the card names the step and the reason, and offers the three ways on with the right recommendation", () => {
    const folder = "/ws/.ensemble/2026-11-06_task_2";
    const input = buildDeclinedStepDecisionInputV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      found: { step: "Part 6", kind: "full-suite", reason: "needs a full-suite run", rounds: 2 },
    });
    assert.match(input.whatHappened, /declined Part 6/);
    assert.match(input.whatHappened, /needs a full-suite run/);
    assert.deepEqual(
      input.options.map((o) => o.label),
      ["Build it; Publish Checks run the full suite", "Split the step", "Defer it to an owner check", "Not now"]
    );
    assert.equal(input.recommendation.kind === "option" ? input.recommendation.optionId : "", "buildFullSuiteIsPublishChecks");
    const tooLarge = buildDeclinedStepDecisionInputV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      found: { step: "Part 6", kind: "too-large", reason: "about 2,300 lines", rounds: 2 },
    });
    assert.equal(tooLarge.recommendation.kind === "option" ? tooLarge.recommendation.optionId : "", "splitStep");
    assert.ok(input.gating);
  });
});

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Part 1",
  "",
  "- [ ] Part 6: dispatch the stage review before the follow-up",
  "- [ ] Part 7: write the notes",
  "- [x] Part 5: done already",
  "",
].join("\n");

void describe("bugs6 item 46: what each option does", () => {
  void it("addNestedChecklistItemsV1 adds indented sub-items under one open item and leaves the top-level count alone", () => {
    const before = listUnsettledPlanItemsV1(PLAN).filter((item) => !item.nested).length;
    const result = addNestedChecklistItemsV1(PLAN, "Part 6: dispatch the stage review before the follow-up", ["slice 1", "slice 2"]);
    assert.equal(result.added, 2);
    assert.match(result.content, /- \[ \] Part 6: dispatch the stage review before the follow-up\n {2}- \[ \] slice 1\n {2}- \[ \] slice 2\n- \[ \] Part 7/);
    assert.equal(listUnsettledPlanItemsV1(result.content).filter((item) => !item.nested).length, before);
    assert.equal(addNestedChecklistItemsV1(PLAN, "No such item", ["x"]).added, 0);
  });

  const withTask = async (run: (folder: string) => Promise<void>): Promise<void> => {
    const { folder } = makeOwnedTaskFolder("ensemble-declined-step-");
    // Bridge the vscode-stub file system onto the real disk for the duration of the test.
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = { ...fsObj };
    const notFound = (uri: vscode.Uri): Error => Object.assign(new Error(`ENOENT: ${uri.toString()}`), { code: "FileNotFound" });
    fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf), () => Promise.reject(notFound(uri)));
    fsObj.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, data);
    };
    try {
      fs.writeFileSync(path.join(folder, "plan-final.md"), PLAN, "utf8");
      await run(folder);
    } finally {
      Object.assign(fsObj, orig);
      safeRemoveDir(folder);
    }
  };
  const arg = (folder: string, action: "build" | "split" | "defer") => ({
    taskFolderPath: folder,
    stage: "impl-high-review" as const,
    step: "Part 6",
    action,
    reason: "needs a full-suite run",
  });

  void it("Build it: the next Apply Review prompt says the full suite is Publish Checks' job for that step", async () => {
    await withTask(async (folder) => {
      assert.equal(await readDeclinedStepGuidanceV1(folder), "");
      const result = await resolveDeclinedStepV1(arg(folder, "build"));
      assert.equal(result.outcome, "done");
      assert.equal(fs.readFileSync(path.join(folder, "plan-final.md"), "utf8"), PLAN, "the plan is not touched");
      assert.ok(fs.existsSync(path.join(folder, DECLINED_STEP_GUIDANCE_FILE_V1)));
      assert.match(await readDeclinedStepGuidanceV1(folder), /for Part 6, the full suite is Publish Checks' job/);
    });
  });

  void it("Split the step: two sub-items appear under the step and the item count is unchanged", async () => {
    await withTask(async (folder) => {
      const result = await resolveDeclinedStepV1(arg(folder, "split"));
      assert.equal(result.outcome, "done");
      const after = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
      assert.match(after, /Part 6, slice 1/);
      assert.match(after, /Part 6, slice 2/);
      assert.equal(listUnsettledPlanItemsV1(after).filter((item) => !item.nested).length, 2);
    });
  });

  void it("Defer it: the step's open item becomes an excluded owner hand-off", async () => {
    await withTask(async (folder) => {
      const result = await resolveDeclinedStepV1(arg(folder, "defer"));
      assert.equal(result.outcome, "done");
      const after = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
      assert.match(after, /Part 6: dispatch the stage review before the follow-up — Excluded by you: deferred to an owner check .*<!-- ensemble:excluded -->/);
      assert.match(after, /- \[ \] Part 7: write the notes\n/, "other steps are untouched");
    });
  });
});
