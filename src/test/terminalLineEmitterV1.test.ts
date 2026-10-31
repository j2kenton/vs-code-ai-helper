/**
 * bugs3 Step 3: one terminal "Ended" line per operation, whichever writer
 * (round ledger or operation observer) reaches it first.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { OperationEndedLineTrackerV1, recordOperationTerminalOutcomeV1 } from "../utils/operationEndedLineV1";
import {
  claimTerminalLineV1,
  ledgerOwnsTerminalLineV1,
  operationSpokeTerminalLineV1,
  releaseLedgerTerminalLineV1,
  releaseOperationTerminalLineV1,
  reserveLedgerTerminalLineV1,
  resetTerminalLinesV1,
} from "../utils/terminalLineEmitterV1";

void describe("terminal line emitter registry (bugs3 Step 3)", () => {
  beforeEach(() => resetTerminalLinesV1());

  void it("lets the observer speak once and refuses a duplicate delivery", () => {
    assert.equal(claimTerminalLineV1("op-1", "operation"), true);
    assert.equal(claimTerminalLineV1("op-1", "operation"), false);
  });

  void it("keeps the observer silent once the ledger has claimed the operation", () => {
    assert.equal(claimTerminalLineV1("op-2", "ledger"), true);
    assert.equal(ledgerOwnsTerminalLineV1("op-2"), true);
    assert.equal(claimTerminalLineV1("op-2", "operation"), false);
    assert.equal(claimTerminalLineV1("op-2", "ledger"), false);
  });

  void it("keeps the observer silent while the ledger has only reserved the line", () => {
    reserveLedgerTerminalLineV1("op-3");
    assert.equal(claimTerminalLineV1("op-3", "operation"), false);
    assert.equal(claimTerminalLineV1("op-3", "ledger"), true);
  });

  void it("refuses the ledger once the observer has already posted the operation's line", () => {
    assert.equal(claimTerminalLineV1("op-obs", "operation"), true);
    assert.equal(operationSpokeTerminalLineV1("op-obs"), true);
    assert.equal(claimTerminalLineV1("op-obs", "ledger"), false);
  });

  void it("gives the ledger claim back when its message did not land, so repair can post it", () => {
    assert.equal(claimTerminalLineV1("op-rel", "ledger"), true);
    releaseLedgerTerminalLineV1("op-rel");
    assert.equal(ledgerOwnsTerminalLineV1("op-rel"), false);
    assert.equal(operationSpokeTerminalLineV1("op-rel"), false);
    assert.equal(claimTerminalLineV1("op-rel", "ledger"), true);
  });

  void it("gives the observer claim back when its message did not save, so the ledger can still post", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "op-save", label: "Plan" });
    const line = tracker.ended({ id: "op-save", label: "Plan", state: "failed", endReasonV1: "every model failed" });
    assert.ok(line);
    // Terminalization and repair are refused while the observer holds the claim ...
    assert.equal(claimTerminalLineV1("op-save", "ledger"), false);
    // ... the chat write failed, so the claim is released ...
    releaseOperationTerminalLineV1("op-save");
    assert.equal(operationSpokeTerminalLineV1("op-save"), false);
    // ... and the ledger posts the missing line exactly once.
    assert.equal(claimTerminalLineV1("op-save", "ledger"), true);
    assert.equal(claimTerminalLineV1("op-save", "ledger"), false);
  });

  void it("releasing an observer claim never takes back a ledger claim", () => {
    assert.equal(claimTerminalLineV1("op-keep", "ledger"), true);
    releaseOperationTerminalLineV1("op-keep");
    assert.equal(ledgerOwnsTerminalLineV1("op-keep"), true);
  });

  void it("treats separate operations independently", () => {
    assert.equal(claimTerminalLineV1("op-a", "operation"), true);
    assert.equal(claimTerminalLineV1("op-b", "operation"), true);
  });

  void it("the observer posts nothing for an operation whose ledger line was already written", () => {
    // The ledger terminalized first and the command never recorded `ledgerSpeaks`.
    claimTerminalLineV1("op-4", "ledger");
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "op-4", label: "Plan" });
    assert.equal(tracker.ended({ id: "op-4", label: "Plan", state: "succeeded" }), undefined);
  });

  void it("two observers (a reload, a second chat view) cannot both post the same operation's line", () => {
    const first = new OperationEndedLineTrackerV1();
    const second = new OperationEndedLineTrackerV1();
    first.register({ id: "op-5", label: "Apply Review" });
    second.register({ id: "op-5", label: "Apply Review" });
    const ended = { id: "op-5", label: "Apply Review", state: "failed" as const, endReasonV1: "every model failed" };
    assert.equal(first.ended(ended), "Ended Apply Review — failed: every model failed.");
    assert.equal(second.ended(ended), undefined);
  });

  void it("a recorded ledgerSpeaks outcome reserves the line and covers a same-label parent", () => {
    recordOperationTerminalOutcomeV1("child-6", { state: "failed", reason: "quota", ledgerSpeaks: true });
    assert.equal(ledgerOwnsTerminalLineV1("child-6"), true);
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "root-6", label: "Apply Review" });
    tracker.register({ id: "child-6", label: "Apply Review", parentId: "root-6" });
    assert.equal(tracker.ended({ id: "child-6", label: "Apply Review", parentId: "root-6", state: "succeeded" }), undefined);
    assert.equal(tracker.ended({ id: "root-6", label: "Apply Review", state: "succeeded" }), undefined);
  });
});
