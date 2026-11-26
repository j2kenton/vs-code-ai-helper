/**
 * bugs6 item 41 (1.18 backport of 70e250a): the editing-round prompt carries its clock, `date -u` is allowed as one
 * exact rule, and the prompt names it only where the round's adapter may run it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  appendRoundClockPolicyV1,
  buildRoundClockV1,
  formatUtcClockV1,
  ROUND_PROMPT_BUDGET_MINUTES_V1,
} from "../utils/roundClockV1";
import { resolveRoundShellCommandsV1, roundAdapterAllowsClockCommandV1 } from "../utils/roundShellAllowlistV1";
import { claudeAllowedToolsValueV1 } from "../runners/providers";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { safeRemoveDir } from "./testFsUtils";

const START = new Date("2026-11-07T19:36:00.000Z");

void describe("bugs6 item 41: the round prompt carries its clock", () => {
  void it("the clock runs 60 minutes from the start and is shown in UTC", () => {
    const clock = buildRoundClockV1(START);
    assert.equal(formatUtcClockV1(clock.startedAt), "19:36 UTC");
    assert.equal(formatUtcClockV1(clock.budgetEndsAt), "20:36 UTC");
    assert.equal(clock.budgetMinutes, 60);
  });

  void it("the budget equals the CLI runner's own wall-clock limit, so the named end is never past the kill", () => {
    const runner = fs.readFileSync(path.join(process.cwd(), "src", "runners", "cliAgentRunner.ts"), "utf8");
    const match = /const RUN_TIMEOUT_MS = (\d+) \* (\d+) \* 1000;/.exec(runner);
    assert.ok(match, "RUN_TIMEOUT_MS is still declared as minutes * 60 * 1000");
    assert.equal(Number(match[1]) * Number(match[2]) / 60, ROUND_PROMPT_BUDGET_MINUTES_V1);
  });

  void it("where the adapter may run `date -u`, the prompt names the start, the end and the 10-minute rule", () => {
    const prompt = appendRoundClockPolicyV1("apply-impl-review-code.md", "BASE", {
      modelId: "claude-cli:claude-sonnet-5-5@high",
      now: START,
    });
    assert.match(prompt, /^BASE\n\n## Round clock\n/);
    assert.match(prompt, /started at 19:36 UTC/);
    assert.match(prompt, /time budget is 60 minutes and ends at 20:36 UTC/);
    assert.match(prompt, /Run `date -u` to check the real time/);
    assert.match(prompt, /less than about 10 minutes left before 20:36 UTC/);
    assert.match(prompt, /never stop for time on a guess/);
  });

  void it("where the adapter gives no clock, the prompt says so and forbids stopping for time on a guess", () => {
    for (const modelId of ["codex-cli:gpt-6.1-sol@high", "copilot-lm:gpt-5", undefined]) {
      const prompt = appendRoundClockPolicyV1("run-implementation.md", "BASE", { ...(modelId ? { modelId } : {}), now: START });
      assert.match(prompt, /started at 19:36 UTC/);
      assert.doesNotMatch(prompt, /Run `date -u`/);
      assert.match(prompt, /no way to read the clock/);
      assert.match(prompt, /do not stop for time on a guess/);
      assert.match(prompt, /Stop early only when every remaining step is blocked/);
      assert.match(prompt, /until the budget ends at 20:36 UTC/);
    }
  });

  void it("only the editing-round prompts carry the block", () => {
    for (const name of ["review-impl-high.md", "apply-review.md", "create-implementation.md", "final-fixes-code.md"]) {
      assert.equal(appendRoundClockPolicyV1(name, "BASE", { now: START }), "BASE", name);
    }
  });
});

void describe("bugs6 item 41: renderPromptTemplate appends the clock for the round's model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-clock-render-"));
  after(() => safeRemoveDir(root));
  const promptsDir = path.join(root, "resources", "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const name of ["apply-impl-review-code.md", "run-implementation.md", "review-impl-high.md"]) {
    fs.writeFileSync(path.join(promptsDir, name), `TEMPLATE ${name} {{x}}`, "utf8");
  }
  const extensionUri = vscode.Uri.file(root);
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  after(() => {
    fsApi.readFile = origReadFile;
  });
  fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> => new Uint8Array(await fs.promises.readFile(uri.fsPath));

  void it("an Apply Review on Claude Code is told to run `date -u`, before the Git policy", async () => {
    const prompt = await renderPromptTemplate(extensionUri, "apply-impl-review-code.md", { x: "1" }, {
      roundModelId: "claude-cli:sonnet@high",
    });
    assert.match(prompt, /^TEMPLATE apply-impl-review-code\.md 1/);
    assert.match(prompt, /## Round clock[\s\S]*Run `date -u`[\s\S]*## Git State Protection/);
  });

  void it("an Implementation round with no model named gets the no-clock rule", async () => {
    const prompt = await renderPromptTemplate(extensionUri, "run-implementation.md", { x: "1" });
    assert.match(prompt, /## Round clock/);
    assert.match(prompt, /no way to read the clock/);
  });

  void it("a review prompt has no clock", async () => {
    const prompt = await renderPromptTemplate(extensionUri, "review-impl-high.md", { x: "1" }, {
      roundModelId: "claude-cli:sonnet@high",
    });
    assert.doesNotMatch(prompt, /Round clock/);
  });
});

void describe("bugs6 item 41: `date -u` is one exact, read-only shell rule", () => {
  const roots: string[] = [];
  after(() => roots.forEach((root) => safeRemoveDir(root)));
  function projectWith(scripts: Record<string, string> | undefined): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-clock-allowlist-"));
    roots.push(root);
    if (scripts) {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts }), "utf8");
    }
    return root;
  }

  void it("resolveRoundShellCommandsV1 always lists `date -u`, beside the project's checks", () => {
    assert.ok(resolveRoundShellCommandsV1(projectWith(undefined)).includes("date -u"));
    const withChecks = resolveRoundShellCommandsV1(projectWith({ test: "node --test" }));
    assert.ok(withChecks.includes("date -u"));
    assert.ok(withChecks.some((command) => / run test$/.test(command)), withChecks.join(" | "));
  });

  void it("the Claude allow-list holds `Bash(date -u)` alone, with no wildcard form", () => {
    assert.equal(claudeAllowedToolsValueV1(["date -u"]), "Bash(date -u)");
    assert.equal(
      claudeAllowedToolsValueV1(["pnpm run test", "date -u"]),
      "Bash(pnpm run test),Bash(pnpm run test *),Bash(date -u)"
    );
  });

  void it("only an adapter that reads the list is told it may run the clock", () => {
    assert.equal(roundAdapterAllowsClockCommandV1("claude-cli:sonnet@high"), true);
    assert.equal(roundAdapterAllowsClockCommandV1("codex-cli:gpt@high"), false);
    assert.equal(roundAdapterAllowsClockCommandV1("copilot-lm:x"), false);
    assert.equal(roundAdapterAllowsClockCommandV1(undefined), false);
  });
});
