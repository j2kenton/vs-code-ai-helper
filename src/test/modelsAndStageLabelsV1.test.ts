/**
 * bugs6 items 3, 22 and 23 (Steps 17-24): stage names with their group, the empty-stage warning, the retry message that
 * names the last-changed stage, `openAiModels` returning a result, and the skipped-backup helpers.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  __resetLastModelChangeForTestV1,
  describeEmptyStageWarningV1,
  describeNoModelConfiguredV1,
  getLastModelChangeV1,
  recordModelSettingsSaveV1,
  stageGroupLabelV1,
  stagesLeftWithoutEnabledModelV1,
} from "../utils/modelStageLabelsV1";
import { openAiModelsV1, type OpenAiModelsDepsV1 } from "../commands/openAiModelsV1";
import {
  describeSkippedBackupsV1,
  describeTurnOnFallbackConsequenceV1,
  findBackupsSkippedByNeverSwitchV1,
  withFallbackOnV1,
} from "../commands/turnOnFallbackAndRetryV1";
import type { ModelSettings } from "../utils/modelFallback";

const SETTINGS_VIEW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/views/settingsView.ts"), "utf8");

void describe("bugs6 item 3: stages are named with their group", () => {
  void it("the Plan and Implementation review stages differ by more than one word", () => {
    const plan = stageGroupLabelV1("plan-high-review");
    const impl = stageGroupLabelV1("impl-high-review");
    assert.equal(plan, "Plan › High-Level Review");
    assert.equal(impl, "Implementation › High-Level Code Review");
    const planWords = new Set(plan.split(/\s+/));
    const differing = impl.split(/\s+/).filter((word) => !planWords.has(word));
    assert.ok(differing.length > 1, `the labels differ by ${differing.join(", ")}`);
    assert.equal(stageGroupLabelV1("impl-low-review"), "Implementation › Low-Level Code Review");
    assert.equal(stageGroupLabelV1("publish"), "Publish");
  });

  void it("AI Models sends the group labels as the stage names, selects the focused stage and names it", () => {
    assert.match(SETTINGS_VIEW_SOURCE, /stageNames: \{ \.\.\.STAGE_DISPLAY_NAMES, \.\.\.STAGE_GROUP_LABELS_V1 \}/);
    assert.match(SETTINGS_VIEW_SOURCE, /row\.classList\.add\('selected-stage'\)/);
    assert.match(SETTINGS_VIEW_SOURCE, /'Opened for ' \+ \(stageDisplayNames\[message\.stage\] \|\| message\.stage\)/);
  });

  void it("a switched-on backup under an unticked Fall back box shows the note", () => {
    assert.match(SETTINGS_VIEW_SOURCE, /Backup models are used only for second opinions, not when the first model runs out/);
    assert.match(SETTINGS_VIEW_SOURCE, /function refreshFallbackOffNote\(stageRow\)/);
  });
});

const ENABLED: ModelSettings = {
  "impl-high-review": { primary: "kimi-cli:k3", strategy: "never-switch" },
};

void describe("bugs6 item 3: saving a stage with no enabled model warns first", () => {
  void it("disabling a stage's last model, or switching every model off, is caught", () => {
    const disabled: ModelSettings = { "impl-high-review": { primary: "kimi-cli:k3", primaryEnabled: false, strategy: "never-switch" } };
    assert.deepEqual(stagesLeftWithoutEnabledModelV1(ENABLED, disabled), ["impl-high-review"]);
    const cleared: ModelSettings = { "impl-high-review": { strategy: "never-switch" } };
    assert.deepEqual(stagesLeftWithoutEnabledModelV1(ENABLED, cleared), ["impl-high-review"]);
    const allOff: ModelSettings = {
      "impl-high-review": { primary: "a", primaryEnabled: false, backups: ["b"], backupsEnabled: [false], strategy: "never-switch" },
    };
    assert.deepEqual(stagesLeftWithoutEnabledModelV1({}, allOff), ["impl-high-review"]);
  });

  void it("a stage with one enabled model, or a stage that was never configured, is not flagged", () => {
    const oneBackup: ModelSettings = {
      "impl-high-review": { primary: "a", primaryEnabled: false, backups: ["b"], strategy: "never-switch" },
    };
    assert.deepEqual(stagesLeftWithoutEnabledModelV1(ENABLED, oneBackup), []);
    assert.deepEqual(stagesLeftWithoutEnabledModelV1({}, {}), []);
  });

  void it("the warning names the stage with its group", () => {
    assert.equal(
      describeEmptyStageWarningV1(["impl-high-review"]),
      "Implementation › High-Level Code Review would have no enabled model; its next round will fail."
    );
  });

  void it("the save handler asks first and only saves on 'Save anyway'", () => {
    assert.match(SETTINGS_VIEW_SOURCE, /stagesLeftWithoutEnabledModelV1\(previousSettings, data\.settings\)/);
    assert.match(SETTINGS_VIEW_SOURCE, /choice !== "Save anyway"/);
  });
});

void describe("bugs6 item 3: the retry names the stage and the last-changed stage", () => {
  beforeEach(() => __resetLastModelChangeForTestV1());

  void it("a model enabled on Plan › High-Level Review is named when Implementation › High-Level Code Review has none", () => {
    const previous: ModelSettings = { "impl-high-review": { primary: "kimi-cli:k3", primaryEnabled: false, strategy: "never-switch" } };
    const next: ModelSettings = {
      ...previous,
      "plan-high-review": { primary: "devpass-cli:llmgateway-devpass/glm-5.3@high", strategy: "never-switch" },
    };
    recordModelSettingsSaveV1(previous, next, new Date("2026-11-01T18:27:22.000Z"));
    const last = getLastModelChangeV1();
    assert.equal(last?.stage, "plan-high-review");
    const text = describeNoModelConfiguredV1("impl-high-review", last, () => "GLM 5.3");
    assert.match(
      text,
      /GLM 5\.3 was just enabled on Plan › High-Level Review; did you mean Implementation › High-Level Code Review\?/
    );
    assert.match(text, /Open Implementation › High-Level Code Review in AI Models/);
  });

  void it("with no earlier change, or a change on the same stage, it still names the stage and the way to open it", () => {
    assert.match(describeNoModelConfiguredV1("impl-high-review", undefined), /No model is enabled for Implementation › High-Level Code Review\./);
    assert.doesNotMatch(
      describeNoModelConfiguredV1("impl-high-review", { stage: "impl-high-review", modelId: "x", at: "t" }),
      /did you mean/
    );
  });
});

function makeDeps(visibleAfter: "focus" | "reveal" | "never", resolvedAtStart: boolean): {
  deps: OpenAiModelsDepsV1;
  calls: string[];
} {
  const calls: string[] = [];
  let visible = false;
  let resolved = resolvedAtStart;
  const deps: OpenAiModelsDepsV1 = {
    focusView: () => {
      calls.push("focus");
      if (visibleAfter === "focus" || (visibleAfter === "reveal" && calls.includes("reveal"))) {
        visible = true;
        resolved = true;
      }
      return Promise.resolve();
    },
    revealContainer: () => {
      calls.push("reveal");
      return Promise.resolve();
    },
    isVisible: () => visible,
    hasResolved: () => resolved,
    focusStage: (stage) => calls.push(`focusStage:${stage}`),
    sleep: () => Promise.resolve(),
  };
  return { deps, calls };
}

void describe("bugs6 item 22: openAiModels always ends with AI Models visible, or says why not", () => {
  void it("collapsed under an expanded Chat, or never opened in this window: one focus is enough", async () => {
    for (const resolvedAtStart of [true, false]) {
      const { deps, calls } = makeDeps("focus", resolvedAtStart);
      const result = await openAiModelsV1(deps, "impl-high-review", { firstWaitMs: 0, secondWaitMs: 0 });
      assert.equal(result.opened, true);
      assert.equal(result.outcome, "done");
      assert.deepEqual(calls, ["focus", "focusStage:impl-high-review"]);
    }
  });

  void it("hidden from the container, or the container moved to the secondary side bar: the container is revealed and focus asked again", async () => {
    const { deps, calls } = makeDeps("reveal", true);
    const result = await openAiModelsV1(deps, "impl-high-review", { firstWaitMs: 0, secondWaitMs: 0 });
    assert.equal(result.opened, true);
    assert.deepEqual(calls, ["focus", "reveal", "focus", "focusStage:impl-high-review"]);
  });

  void it("a view that never resolves returns opened: false with a reason, a refused outcome and the way that works", async () => {
    const { deps, calls } = makeDeps("never", false);
    const result = await openAiModelsV1(deps, "impl-high-review", { firstWaitMs: 0, secondWaitMs: 0 });
    assert.equal(result.opened, false);
    assert.equal(result.outcome, "refused");
    assert.match(result.reason ?? "", /did not load/);
    assert.match(result.message ?? "", /AI Models could not be shown \(the AI Models section did not load in this window\)/);
    assert.match(result.message ?? "", /View: Open View…/);
    assert.match(result.message ?? "", /Implementation › High-Level Code Review/);
    assert.ok(!calls.some((call) => call.startsWith("focusStage")), "focusStage is sent only to a visible view");
  });

  void it("a focus request that never settles does not hang the command", async () => {
    const { deps } = makeDeps("never", true);
    const hanging: OpenAiModelsDepsV1 = { ...deps, focusView: () => new Promise<never>(() => undefined), sleep: () => Promise.resolve() };
    const result = await openAiModelsV1(hanging, undefined, { firstWaitMs: 0, secondWaitMs: 0, focusTimeoutMs: 0 });
    assert.equal(result.opened, false);
    assert.match(result.reason ?? "", /not visible/);
  });

  void it("the command awaits the focus and returns the result; the Palette run shows a notification when nothing opened", () => {
    const extensionSource = fs.readFileSync(path.resolve(__dirname, "../../src/extension.ts"), "utf8");
    assert.match(extensionSource, /async \(stage\?: TaskStage\): Promise<OpenAiModelsResultV1>/);
    assert.match(extensionSource, /openAiModelsV1\(/);
    assert.match(extensionSource, /if \(!result\.opened && stage === undefined && result\.message !== undefined\)/);
  });
});

void describe("bugs6 item 23: the skipped backup and the setting change", () => {
  const NEVER_SWITCH = { primary: "codex-cli:gpt-6.1-sol@high", backups: ["claude-cli:claude-opus-5-5@high"], strategy: "never-switch" as const };

  void it("names a switched-on backup the stop did not try, only under never-switch", () => {
    assert.deepEqual(findBackupsSkippedByNeverSwitchV1(NEVER_SWITCH, ["codex-cli:gpt-6.1-sol@high"]), ["claude-cli:claude-opus-5-5@high"]);
    assert.deepEqual(findBackupsSkippedByNeverSwitchV1({ ...NEVER_SWITCH, strategy: "switch-to-backup" }, ["codex-cli:gpt-6.1-sol@high"]), []);
    assert.deepEqual(
      findBackupsSkippedByNeverSwitchV1(NEVER_SWITCH, ["codex-cli:gpt-6.1-sol@high", "claude-cli:claude-opus-5-5@high"]),
      [],
      "a backup that was tried is not skipped"
    );
    assert.deepEqual(
      findBackupsSkippedByNeverSwitchV1({ ...NEVER_SWITCH, backupsEnabled: [false] }, ["codex-cli:gpt-6.1-sol@high"]),
      [],
      "a switched-off backup is not skipped"
    );
    assert.deepEqual(findBackupsSkippedByNeverSwitchV1(NEVER_SWITCH, ["x"], () => true), [], "a disabled provider is not skipped");
  });

  void it("the sentence and the option text say which setting changes", () => {
    assert.equal(
      describeSkippedBackupsV1("impl-high-review", ["Claude Opus 5.5"]),
      "Claude Opus 5.5 is a backup but 'Fall back to backup models' is off for Implementation › High-Level Code Review, so it was not tried."
    );
    assert.match(
      describeTurnOnFallbackConsequenceV1("impl-high-review", ["Claude Opus 5.5"]),
      /turns on "Fall back to backup models" for Implementation › High-Level Code Review \(it is off now\)\..*runs on Claude Opus 5\.5/
    );
  });

  void it("the option's write turns the box on for that stage only", () => {
    const settings: ModelSettings = {
      "impl-high-review": NEVER_SWITCH,
      "plan-high-review": { primary: "x", strategy: "never-switch" },
    };
    const next = withFallbackOnV1(settings, "impl-high-review");
    assert.equal(next?.["impl-high-review"]?.strategy, "switch-to-backup");
    assert.equal(next?.["plan-high-review"]?.strategy, "never-switch");
    assert.equal(withFallbackOnV1({}, "impl-high-review"), undefined);
  });
});
