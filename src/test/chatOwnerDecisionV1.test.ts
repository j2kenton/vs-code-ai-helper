/**
 * bugs8 item 2 (Steps 9-12): an owner decision given in Chat With AI is recorded where rounds and reviews read it.
 * Replays the bugs7 message of 2026-11-11 18:16 (Israel time) on a fixture shaped like that task.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import {
  describeOwnerDecisionRecordResultV1,
  recordOwnerDecisionFromChatV1,
  replacePlainSubBulletTextV1,
  splitOwnerDecisionEnvelopesV1,
} from "../utils/chatOwnerDecisionV1";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-owner-decision-"));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const OLD_WORDING = "Fast Forward never moves into Publish: it stops at the end of High-Level Code Review.";
const NEW_WORDING = "Fast Forward carries on into Publish and stops at Commit & Push, which stays the owner's click.";

const TASK_MD = [
  "# Task",
  "",
  "## Task Description",
  "",
  "Make Fast Forward safe.",
  "",
  "## Owner decisions",
  "",
  "### 2026-11-11 — step-19-chain-boundary",
  "",
  "Blocker answered:",
  "> Step 19 chain boundary needs an owner decision.",
  "",
  "Owner's answer: Keep the plan (plan kept as written)",
  "",
  "## Draft with AI",
  "",
].join("\n");

const PLAN_FINAL_MD = [
  "# Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Step 18: Add the stage-ready card",
  "- [ ] Step 19: Fast Forward chain boundary",
  `  - ${OLD_WORDING}`,
  "- [ ] Step 20: Publish stays manual",
  "",
].join("\n");

const PLAN_MD = ["# Plan: bugs7", "", "## Step 19", "", `  - ${OLD_WORDING}`, "", "## Step 20", "", "Publish stays manual.", ""].join("\n");

/** The reply the owner's 18:16 message should now get from the model. */
const REPLY = [
  "Recording it.",
  "[[RECORD_OWNER_DECISION:step-19-chain-boundary]]",
  "Decision: Fast Forward does not stop before Publish. It carries on into Publish and stops at Commit & Push, which stays my click.",
  "Blocker: Step 19 chain boundary needs an owner decision.",
  `Plan-old: ${OLD_WORDING}`,
  `Plan-new: ${NEW_WORDING}`,
  "[[/RECORD_OWNER_DECISION]]",
].join("\n");

function makeTask(name: string): string {
  const folder = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  fs.writeFileSync(path.join(folder, "task.md"), TASK_MD);
  fs.writeFileSync(path.join(folder, "plan-final.md"), PLAN_FINAL_MD);
  fs.writeFileSync(path.join(folder, "plan.md"), PLAN_MD);
  return folder;
}

const checklistLines = (text: string): string[] => text.split("\n").filter((line) => /^\s*[-*]\s+\[[ xX]\]/.test(line));

void describe("bugs8 item 2: the owner-decision envelope", () => {
  void it("is split out of the reply, whatever else the reply says", () => {
    const { text, decisions } = splitOwnerDecisionEnvelopesV1(REPLY);
    assert.equal(text, "Recording it.");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.blockerId, "step-19-chain-boundary");
    assert.match(decisions[0]!.decision, /^Fast Forward does not stop before Publish\./);
    assert.equal(decisions[0]!.planOld, OLD_WORDING);
    assert.equal(decisions[0]!.planNew, NEW_WORDING);
  });

  void it("replay of the 18:16 message: task.md gains the replacement, the Step 19 sub-bullet changes, no checklist line or tick does", async () => {
    const folder = makeTask("replay");
    const { decisions } = splitOwnerDecisionEnvelopesV1(REPLY);
    const result = await recordOwnerDecisionFromChatV1(folder, decisions[0]!, undefined, "2026-11-11");

    assert.deepEqual(result.written, ["task.md", "plan-final.md", "plan.md"], JSON.stringify(result));
    assert.deepEqual(result.notWritten, []);

    const task = fs.readFileSync(path.join(folder, "task.md"), "utf8");
    assert.match(task, /### 2026-11-11 — step-19-chain-boundary \(superseded 2026-11-11\)/, "the earlier 'Keep the plan' entry is marked superseded");
    assert.match(task, /Owner's answer: Keep the plan \(plan kept as written\)/, "the earlier entry stays on record");
    assert.match(task, /Owner's answer: Fast Forward does not stop before Publish\. It carries on into Publish/, "task.md gained the replacement");
    assert.ok(task.indexOf("It carries on into Publish") < task.indexOf("## Draft with AI"), "the entry is under Owner decisions");

    const planFinal = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.ok(planFinal.includes(`  - ${NEW_WORDING}`), "the Step 19 sub-bullet carries the new wording");
    assert.ok(!planFinal.includes(OLD_WORDING), "the old wording is gone from plan-final.md");
    assert.deepEqual(checklistLines(planFinal), checklistLines(PLAN_FINAL_MD), "every checklist line and tick is unchanged");
    assert.equal(planFinal, PLAN_FINAL_MD.replace(OLD_WORDING, NEW_WORDING), "nothing else in plan-final.md changed");

    const plan = fs.readFileSync(path.join(folder, "plan.md"), "utf8");
    assert.equal(plan, PLAN_MD.replace(OLD_WORDING, NEW_WORDING), "plan.md is kept in step, not redrafted");
    assert.equal(describeOwnerDecisionRecordResultV1(result), "_Updated `task.md`, `plan-final.md`, `plan.md` for step-19-chain-boundary._");
  });

  void it("recording the same decision twice adds no second entry", async () => {
    const folder = makeTask("twice");
    const { decisions } = splitOwnerDecisionEnvelopesV1(REPLY);
    await recordOwnerDecisionFromChatV1(folder, decisions[0]!, undefined, "2026-11-11");
    const once = fs.readFileSync(path.join(folder, "task.md"), "utf8");
    const again = await recordOwnerDecisionFromChatV1(folder, decisions[0]!, undefined, "2026-11-11");
    assert.equal(fs.readFileSync(path.join(folder, "task.md"), "utf8"), once);
    assert.ok(again.notWritten.some((miss) => miss.file === "task.md"), "the repeat says task.md was not changed");
  });

  void it("a target that is a checklist line is refused: plan-final.md is unchanged and the reply names the refusal", async () => {
    const folder = makeTask("checklist");
    const result = await recordOwnerDecisionFromChatV1(
      folder,
      {
        blockerId: "step-19-chain-boundary",
        decision: "Step 19 is done differently.",
        planOld: "- [ ] Step 19: Fast Forward chain boundary",
        planNew: "- [x] Step 19: Fast Forward chain boundary",
      },
      undefined,
      "2026-11-11"
    );
    assert.equal(fs.readFileSync(path.join(folder, "plan-final.md"), "utf8"), PLAN_FINAL_MD, "plan-final.md was changed");
    assert.equal(fs.readFileSync(path.join(folder, "plan.md"), "utf8"), PLAN_MD, "plan.md was changed");
    assert.deepEqual(result.written, ["task.md"], "only task.md is written");
    const note = describeOwnerDecisionRecordResultV1(result);
    assert.match(note, /plan-final\.md was not changed: the text matched a checklist line/);
    assert.match(note, /Edit the matching sub-bullet in plan-final\.md by hand/);
    assert.ok(!/_Updated[^_]*plan-final\.md/.test(note), "the 'Updated' line must not list a file that was not written");
  });

  void it("missing, repeated or multi-line targets are refused with their reason", () => {
    assert.deepEqual(replacePlainSubBulletTextV1(PLAN_FINAL_MD, "no such wording", "x"), { ok: false, reason: "the existing wording was not found" });
    const twice = `${PLAN_FINAL_MD}  - ${OLD_WORDING}\n`;
    assert.deepEqual(replacePlainSubBulletTextV1(twice, OLD_WORDING, "x"), { ok: false, reason: "the existing wording matched 2 places" });
    assert.equal(replacePlainSubBulletTextV1(PLAN_FINAL_MD, OLD_WORDING, "a\nb").ok, false);
    assert.equal(replacePlainSubBulletTextV1(PLAN_FINAL_MD, "# Plan", "# Other").ok, false, "a heading is not a sub-bullet");
  });

  void it("a reply with no plan wording still records the decision and says plan-final.md was not changed", async () => {
    const folder = makeTask("nowording");
    const result = await recordOwnerDecisionFromChatV1(folder, { blockerId: "b-1", decision: "Skip the memory work." }, undefined, "2026-11-11");
    assert.deepEqual(result.written, ["task.md"]);
    assert.match(describeOwnerDecisionRecordResultV1(result), /plan-final\.md was not changed: the reply gave no old and new wording/);
    assert.equal(fs.readFileSync(path.join(folder, "plan-final.md"), "utf8"), PLAN_FINAL_MD);
  });
});

void describe("bugs8 item 2: the chat records an owner decision only after the owner confirms", () => {
  const read = (rel: string): string => fs.readFileSync(path.join(__dirname, "..", "..", "src", rel), "utf8");

  void it("promotion proposes the decision and never writes it", () => {
    const row = read("actions/rows/chatSendRowV1.ts");
    assert.ok(!row.includes("recordOwnerDecisionFromChatV1"), "promotion must not call the recorder");
    assert.match(row, /proposedOwnerDecisions: \[\.\.\.decisions\]/, "the decisions ride on the persisted message");
    assert.match(row, /nothing is written until you do/);
  });

  void it("the recorder runs only after the confirm dialog answered 'record'", () => {
    const source = read("commands/chatWithStage.ts");
    const start = source.indexOf("export async function dispatchProposedOwnerDecisionsV1");
    const body = source.slice(start, source.indexOf("export async function resumeChatSendInteractionV1", start));
    const ask = body.indexOf('decisionKey: "confirmChatOwnerDecision"');
    const guard = body.indexOf('confirmedOptionId !== "record"');
    const write = body.indexOf("recordOwnerDecisionFromChatV1(");
    assert.ok(ask >= 0 && guard > ask && write > guard, "ask, then refuse unless confirmed, then write");
    assert.match(source, /if \(dispatch\?\.proposedOwnerDecisions\)/, "the send path dispatches the proposals");
    assert.match(source, /if \(proposedOwnerDecisions\) \{/, "the resume path dispatches the proposals");
  });
});
