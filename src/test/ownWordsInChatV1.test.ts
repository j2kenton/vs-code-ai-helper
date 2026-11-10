/**
 * review2 Step 43 (Part 9): "Answer in my own words…" is answered in Chat With AI's own message box. No pop-up; the
 * answer is a chat send that names the card, recorded under task.md's "## Owner decisions", and it starts no Chat
 * With AI round.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { after, afterEach, describe, it } from "node:test";
import {
  decodeAnswersDecisionV1,
  handOverOwnWordsTextV1,
  normalizeOwnWordsTextV1,
  OWN_WORDS_TYPE_HINT_V1,
  ownWordsArgOfOptionV1,
  ownWordsBannerTextV1,
  takeHandedOverOwnWordsTextV1,
} from "../utils/ownWordsAnswerV1";
import { answerOwnWordsFromChatV1, type OwnWordsChatAnswerDepsV1 } from "../utils/ownWordsChatAnswerV1";
import { postOwnerPlanDecisionCardV1, recordOwnerPlanDecisionV1 } from "../commands/ownerPlanDecisionCommandV1";
import { parseOwnerDecisionsNeededV1 } from "../utils/reviewReadiness";
import { decodeRelayedCommandArgV1 } from "../services/viewerForwardingV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function makeExtensionContext(): vscode.ExtensionContext {
  const memento = new FakeMemento();
  return {
    workspaceState: memento as unknown as vscode.Memento,
    globalState: memento as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

const REVIEW = [
  "Readiness: 6/10",
  "",
  "## Owner decisions needed",
  "",
  "### Step 6 admission-token owner decision",
  "- id: step-6-admission",
  "- what this part of the plan is for: Token hand-off during form submission.",
  "- what is undecided or went wrong: Simpler design built instead of token hand-off.",
  "- options:",
  "  - approve: Approve the simpler design — trade-off: simpler code.",
  "  - buildToken: Require token hand-off — trade-off: matches original plan.",
  "- recommendation: approve — simpler design.",
].join("\n");

async function ownWordsCard(folder: string): Promise<WorkflowDecisionV1> {
  __extensionContextV1TestOnly.set(makeExtensionContext());
  const block = parseOwnerDecisionsNeededV1(REVIEW)[0]!;
  const card = await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: "impl-high-review", block });
  assert.ok(card);
  return card;
}

void describe("review2 Step 43: the answer goes in the message box", () => {
  void it("labels the box 'Answering: <card title>' and cuts a long title", () => {
    assert.equal(ownWordsBannerTextV1("Step 22 acceptance line"), "Answering: Step 22 acceptance line");
    assert.ok(ownWordsBannerTextV1("x".repeat(400)).length < 140);
  });

  void it("the card's consequence says where to type", async () => {
    const card = await ownWordsCard(nodePath.join("/tmp", ".ensemble", "own-words-consequence"));
    const option = card.options.find((o) => o.optionId === "ownWords");
    assert.ok(option);
    assert.match(option.consequence, /Type your answer in the message box below/);
    assert.doesNotMatch(option.consequence, /pop-up|input box/i);
    assert.match(OWN_WORDS_TYPE_HINT_V1, /message box below/);
  });

  void it("recognises every own-words option, the rule option included, and no other", async () => {
    const card = await ownWordsCard(nodePath.join("/tmp", ".ensemble", "own-words-recognise"));
    const own = card.options.filter((o) => ownWordsArgOfOptionV1(o) !== undefined).map((o) => o.optionId);
    assert.deepEqual(own, ["ownWords"]);
    const plateau = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", { canonicalId: "c", taskFolderPath: "/t" }, {
      blockersCount: 1,
      primaryBlockerDescription: "A defect.",
      allBlockerDescriptions: ["A defect."],
      narrowedNote: "",
      progressNote: "",
      taskFixableCount: 1,
      hasSpecDefect: false,
      hasDeclinedBlocker: false,
      hasNonFixableBlocker: false,
      nextStageHasRun: false,
      clearingNote: "",
      dispatchModeEvidence: [],
      planItemsOpen: 0,
      narrowedBlockerRule: { blockerId: "b1", description: "A plan item's evidence settles a same-worded item.", fixes: 2 },
    });
    const rule = plateau.options.find((o) => o.optionId === "settleWithRule");
    assert.ok(rule && ownWordsArgOfOptionV1(rule) !== undefined, "Settle it with a rule takes a typed answer too");
  });

  void it("decodes the relayed field: two plain ids and nothing else", () => {
    assert.deepEqual(decodeAnswersDecisionV1({ decisionId: "d-1", optionId: "ownWords" }), { decisionId: "d-1", optionId: "ownWords" });
    assert.equal(decodeAnswersDecisionV1({ decisionId: "d 1", optionId: "ownWords" }), undefined);
    assert.equal(decodeAnswersDecisionV1({ decisionId: "d-1" }), undefined);
    assert.equal(decodeAnswersDecisionV1("x"), undefined);
    assert.deepEqual(
      decodeRelayedCommandArgV1("vs-code-ai-helper.chatWithStage", {
        message: "my answer",
        answersDecision: { decisionId: "d-1", optionId: "ownWords", extra: "dropped" },
      }),
      { message: "my answer", answersDecision: { decisionId: "d-1", optionId: "ownWords" } }
    );
    assert.deepEqual(decodeRelayedCommandArgV1("vs-code-ai-helper.nextStage", { answersDecision: { decisionId: "d", optionId: "o" } }), {});
  });

  void it("normalises the typed text", () => {
    assert.equal(normalizeOwnWordsTextV1("  keep   the\npop-ups  "), "keep the pop-ups");
    assert.equal(normalizeOwnWordsTextV1("x".repeat(2000)).length, 1000);
  });
});

void describe("review2 Step 43: the typed message answers the card and starts no chat round", () => {
  function deps(card: WorkflowDecisionV1 | undefined) {
    const log = { appended: [] as string[], resolved: [] as string[], warned: [] as string[] };
    const value: OwnWordsChatAnswerDepsV1 = {
      pending: card === undefined ? [] : [card],
      appendOwnerMessage: (text) => {
        log.appended.push(text);
        return Promise.resolve();
      },
      resolve: (decisionId, optionId) => {
        log.resolved.push(`${decisionId}:${optionId}`);
        return Promise.resolve({ ok: true });
      },
      warn: (text) => log.warned.push(text),
    };
    return { value, log };
  }

  void it("hands the text to the card's command and resolves the card", async () => {
    const folder = nodePath.join("/tmp", ".ensemble", "own-words-answer");
    const card = await ownWordsCard(folder);
    const { value, log } = deps(card);
    const result = await answerOwnWordsFromChatV1(
      { taskFolderPath: folder, answers: { decisionId: card.decisionId, optionId: "ownWords" }, text: "  Keep the   plan\n" },
      value
    );
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(log.appended, ["Keep the plan"], "the answer reads as said in the chat");
    assert.deepEqual(log.resolved, [`${card.decisionId}:ownWords`]);
    assert.equal(takeHandedOverOwnWordsTextV1(folder, "step-6-admission"), "Keep the plan", "handed over for the command");
    assert.equal(takeHandedOverOwnWordsTextV1(folder, "step-6-admission"), undefined, "and only once");
  });

  void it("refuses a card that is gone, an option that takes no text, another task's card and an empty message", async () => {
    const folder = nodePath.join("/tmp", ".ensemble", "own-words-refuse");
    const card = await ownWordsCard(folder);
    const cases = [
      { deps: deps(undefined), answers: { decisionId: card.decisionId, optionId: "ownWords" }, text: "x", folder },
      { deps: deps(card), answers: { decisionId: card.decisionId, optionId: "approve" }, text: "x", folder },
      { deps: deps(card), answers: { decisionId: card.decisionId, optionId: "ownWords" }, text: "x", folder: nodePath.join("/tmp", ".ensemble", "other") },
      { deps: deps(card), answers: { decisionId: card.decisionId, optionId: "ownWords" }, text: "   ", folder },
    ];
    for (const c of cases) {
      const result = await answerOwnWordsFromChatV1({ taskFolderPath: c.folder, answers: c.answers, text: c.text }, c.deps.value);
      assert.equal(result.accepted, false);
      assert.equal(c.deps.log.resolved.length, 0, "nothing is resolved");
      assert.equal(c.deps.log.warned.length, 1, "the owner is told why");
    }
  });
});

void describe("review2 Step 43: the typed answer is recorded and starts no chat round", () => {
  const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-own-words-"));
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
  });
  after(() => nodeFs.rmSync(ROOT, { recursive: true, force: true }));

  void it("the text handed over by the chat send is written to task.md under Owner decisions; chatWithStage is not called", async () => {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    const folder = nodePath.join(ROOT, ".ensemble", "own-words-recorded");
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nBuild it.\n", "utf8");
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), "# Plan\n\n- [ ] Step 6: Build it\n", "utf8");
    nodeFs.writeFileSync(
      nodePath.join(folder, "task-progress.json"),
      JSON.stringify({
        taskFolder: "own-words-recorded", currentStage: "impl-high-review", status: "active",
        createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
      }),
      "utf8"
    );
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const commands = vscode.commands as unknown as { executeCommand: (command: string, ...args: unknown[]) => unknown };
    const originalExecute = commands.executeCommand;
    const dispatched: string[] = [];
    commands.executeCommand = (command: string) => {
      dispatched.push(command);
      return Promise.resolve(true);
    };
    try {
      // What the chat send does just before the card's command runs.
      handOverOwnWordsTextV1(folder, "step-6-admission", "Keep the simpler design for Step 6");
      const result = await recordOwnerPlanDecisionV1({
        taskFolderPath: folder,
        stage: "impl-high-review",
        blockerId: "step-6-admission",
        optionId: "ownWords",
        optionLabel: "Answer in my own words",
        ownWords: true,
        blockerText: "Simpler design built instead of token hand-off.",
      });
      assert.equal(result.outcome, "done");
      const taskMd = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
      assert.match(taskMd, /## Owner decisions/i);
      assert.match(taskMd, /Owner's answer: Keep the simpler design for Step 6/);
      assert.ok(!dispatched.includes("vs-code-ai-helper.chatWithStage"), "no Chat With AI round");
      assert.ok(dispatched.includes("vs-code-ai-helper.resumeAndRerunReview"), "the promised review re-run starts");
    } finally {
      commands.executeCommand = originalExecute;
    }
  });
});

void describe("review2 Step 43: the command takes no pop-up", () => {
  void it("recordOwnerPlanDecisionV1 never calls showInputBox", () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "ownerPlanDecisionCommandV1.ts"), "utf8");
    assert.doesNotMatch(source, /showInputBox/);
  });

  void it("with no typed answer it records nothing, re-opens the card and says where to type", async () => {
    const win = vscode.window as unknown as { showInputBox?: () => never };
    const original = win.showInputBox;
    win.showInputBox = () => {
      throw new Error("a pop-up was opened");
    };
    try {
      const result = await recordOwnerPlanDecisionV1({
        taskFolderPath: nodePath.join("/tmp", ".ensemble", "own-words-no-text"),
        stage: "impl-high-review",
        blockerId: "step-6-admission",
        optionId: "ownWords",
        optionLabel: "Answer in my own words",
        ownWords: true,
      });
      assert.equal(result.outcome, "refused");
      assert.equal(result.reopenCard, true);
      assert.match(result.message ?? "", /message box below/);
    } finally {
      if (original === undefined) delete win.showInputBox;
      else win.showInputBox = original;
    }
  });
});
