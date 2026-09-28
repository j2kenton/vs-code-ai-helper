/**
 * RC1 item 9 (f3 Part 9): the stalled card reads the round ledger and says
 * which of two different things happened — the last round FINISHED and nothing
 * was queued after it, or rounds were LOST leading into the stall — and names
 * the action Resume will run.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildStalledTaskEscalationDecisionV1 } from "../commands/scheduleTaskResume";
import type { RoundLedgerEntryV1, RoundLedgerStateV1, TaskProgress } from "../types/taskProgress";
import {
  describeStalledActiveTaskEscalationV1,
  isStalledActivePauseReasonV1,
  readStalledRoundReadingV1,
  STALLED_ACTIVE_TASK_FINISHED_PAUSE_REASON_V1,
  STALLED_ACTIVE_TASK_LOST_PAUSE_REASON_V1,
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  stalledActivePauseReasonForReadingV1,
} from "../utils/taskWatchdogV1";

function row(
  n: number,
  state: RoundLedgerStateV1,
  outcome?: RoundLedgerEntryV1["outcome"]
): RoundLedgerEntryV1 {
  const at = new Date(Date.UTC(2026, 8, 20, 10, n)).toISOString();
  return {
    roundId: `round-${n}`,
    attemptIds: [],
    stage: "impl-high-review",
    mode: "review",
    startedAt: at,
    state,
    endedAt: state === "scheduled" || state === "open" ? undefined : at,
    outcome,
  };
}

function progressWith(rows: RoundLedgerEntryV1[]): TaskProgress {
  return {
    taskFolder: "t",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    roundLedger: rows,
  } as TaskProgress;
}

void describe("stalled card readings (RC1 item 9)", () => {
  void it("reads a completed last round as 'finished' with its score and blocker count", () => {
    const reading = readStalledRoundReadingV1(
      progressWith([row(1, "failed"), row(2, "completed", { score: 8, reviewerBlockers: 2, mechanicalBlockers: 1 })])
    );
    assert.deepEqual(reading, {
      kind: "finished",
      stage: "impl-high-review",
      mode: "review",
      score: 8,
      blockers: 3,
    });
    const text = describeStalledActiveTaskEscalationV1("Task A", reading);
    assert.match(text, /last round \(review at impl-high-review\) finished \(score 8\/10, 3 blockers\)/);
    assert.match(text, /Nothing broke/);
    assert.doesNotMatch(text, /consecutive rounds/);
  });

  void it("reads trailing lost rounds as 'lost' with the consecutive count, ignoring older completed rounds", () => {
    const reading = readStalledRoundReadingV1(
      progressWith([row(1, "completed"), row(2, "failed"), row(3, "interrupted"), row(4, "rejected")])
    );
    assert.deepEqual(reading, { kind: "lost", consecutive: 3, lastState: "rejected", stage: "impl-high-review" });
    const text = describeStalledActiveTaskEscalationV1("Task A", reading);
    assert.match(text, /was stalled — 3 consecutive rounds at impl-high-review ended without finishing \(last: rejected\)/);
    assert.doesNotMatch(text, /Nothing broke/);
  });

  void it("orders rows by their end time, not their array position", () => {
    const reading = readStalledRoundReadingV1(progressWith([row(3, "completed"), row(1, "failed")]));
    assert.equal(reading.kind, "finished");
  });

  void it("keeps the generic wording when the ledger has nothing terminal or the last round was cancelled", () => {
    for (const rows of [[], [row(1, "open")], [row(1, "completed"), row(2, "cancelled")]]) {
      const reading = readStalledRoundReadingV1(progressWith(rows));
      assert.deepEqual(reading, { kind: "none" });
      assert.match(
        describeStalledActiveTaskEscalationV1("Task A", reading),
        /^⚠️ "Task A" was stalled — active with nothing running, owed, or scheduled\. Paused with an escalation/
      );
    }
  });

  void it("puts both readings and the next action on the posted card", () => {
    const target = {
      canonicalId: "task-id",
      taskFolderPath: "/tmp/task",
      stage: "impl-high-review" as const,
      taskName: "Task A",
    };
    const plan = { kind: "run-review" as const, label: "Resume and run the review again (Copilot)" };

    const finished = buildStalledTaskEscalationDecisionV1(
      false,
      target,
      plan,
      progressWith([row(1, "completed", { score: 9, reviewerBlockers: 0 })])
    );
    assert.match(finished.whatHappened, /finished \(score 9\/10, 0 blockers\)/);
    assert.match(finished.whatHappened, /The obvious next step: Resume and run the review again \(Copilot\)/);

    const lost = buildStalledTaskEscalationDecisionV1(
      false,
      target,
      plan,
      progressWith([row(1, "failed"), row(2, "failed")])
    );
    assert.match(lost.whatHappened, /2 consecutive rounds/);

    // A blocked plan has no runnable next action to name; the precondition is
    // already on the card, so no "obvious next step" sentence is added.
    const blocked = buildStalledTaskEscalationDecisionV1(
      false,
      target,
      { kind: "blocked", precondition: "the summary is unusable." },
      progressWith([row(1, "failed")])
    );
    assert.doesNotMatch(blocked.whatHappened, /obvious next step/);
  });

  void it("persists a different pause reason for a finished round than for lost rounds", () => {
    const finished = stalledActivePauseReasonForReadingV1(
      readStalledRoundReadingV1(progressWith([row(1, "completed", { score: 9 })]))
    );
    const lost = stalledActivePauseReasonForReadingV1(readStalledRoundReadingV1(progressWith([row(1, "failed")])));
    const generic = stalledActivePauseReasonForReadingV1(readStalledRoundReadingV1(progressWith([])));
    assert.equal(finished, STALLED_ACTIVE_TASK_FINISHED_PAUSE_REASON_V1);
    assert.equal(lost, STALLED_ACTIVE_TASK_LOST_PAUSE_REASON_V1);
    assert.equal(generic, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);
    assert.match(finished, /Nothing broke/);
    assert.match(lost, /something broke/);
    assert.equal(new Set([finished, lost, generic]).size, 3);
    for (const reason of [finished, lost, generic]) {
      assert.equal(isStalledActivePauseReasonV1(reason), true);
    }
    assert.equal(isStalledActivePauseReasonV1("Paused by the user."), false);
    assert.equal(isStalledActivePauseReasonV1(undefined), false);
  });
});
