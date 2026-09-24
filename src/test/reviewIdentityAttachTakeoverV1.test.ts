/**
 * Source-level regression pin for the pre-1.0.0 fixes register, Part 4 Step 8
 * static audit's finding, so a future edit cannot silently drop or spread the
 * fix without a deliberate test change.
 *
 * `createProductionTaskActionCoordinatorV1` (`productionTaskActionRuntimeV1.ts`)
 * wraps every production coordinator with `withMalformedResultRetryV1`, which
 * retries a malformed text-mode result by calling `coordinator.executeAction`
 * again — a FRESH `operationId` each time — while the SAME `runReviewForFolder`
 * call still owns `reviewAttemptId` (the round-ledger row's `roundId`) for its
 * whole dispatch. Without `allowOperationTakeover: true`, that retry's own
 * `onAttemptAllocated` attach loses the identity race against its own
 * predecessor and fails `wrongOwner` — the review path reaching the exact
 * "row accumulates attempt ids under a losing operationId, no provider ever
 * invoked" shape item 11's 2026-09-20 addendum recorded for row `b7d3b317…`.
 *
 * The resumed-interaction call site uses `coordinator.resumeAction`, which
 * `withMalformedResultRetryV1` deliberately does NOT wrap (a Resume drive
 * reuses its ORIGINAL `operationId` rather than starting a fresh one — see
 * that wrapper's own doc comment) — so a `wrongOwner` there means a genuinely
 * different operation reached the row, and must keep failing closed. This
 * test pins that asymmetry: exactly the `executeAction`-based dispatch site
 * gets the takeover flag, and the `resumeAction`-based one never does.
 *
 * A full end-to-end drive of `runReviewForFolder` through a stubbed
 * malformed-then-clean provider round-trip is a much larger fixture than this
 * one, narrowly-scoped call-site fact needs; `attachCoordinatorIdentityToRoundV1`
 * itself already has full behavioral coverage for both the `wrongOwner` and
 * `allowOperationTakeover` cases in `roundLedgerV1.test.ts`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REVIEW_ACTIONS_PATH = path.join(REPO_ROOT, "src", "commands", "reviewActions.ts");

/** The exact call text this test pins, so a rename or reformat is a deliberate edit. */
const ATTACH_CALL = "attachCoordinatorIdentityToRoundTrackingDegradationV1(";

/**
 * Slice the source starting at `matchStart` and ending at the matching
 * top-level `)` — a small bracket-depth walk rather than a compiler
 * dependency, mirroring `scripts/verifyToastAllowlistV1.mjs`'s own
 * `splitTopLevelArgs` approach for the same reason (no TypeScript parse
 * needed just to read a fixed-shape call site).
 */
function sliceCall(text: string, matchStart: number): string {
  const openParenIndex = matchStart + ATTACH_CALL.length - 1;
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
    } else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(matchStart, i + 1);
      }
    }
  }
  throw new Error("unterminated call — reviewActions.ts source did not close the call's brackets");
}

function findAttachCalls(text: string): string[] {
  const calls: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const index = text.indexOf(ATTACH_CALL, searchFrom);
    if (index === -1) {
      break;
    }
    calls.push(sliceCall(text, index));
    searchFrom = index + ATTACH_CALL.length;
  }
  return calls;
}

void describe("reviewActions.ts — attachCoordinatorIdentityToRound takeover asymmetry", () => {
  const text = fs.readFileSync(REVIEW_ACTIONS_PATH, "utf8");
  const calls = findAttachCalls(text);

  void it("has exactly the two known review-round identity-attach call sites", () => {
    assert.equal(
      calls.length,
      2,
      "expected exactly runReviewForFolder's initial dispatch and the resumed-interaction " +
        "drive; a new call site must be classified by this same audit (Part 4 Step 8), not " +
        "silently left unclassified"
    );
  });

  void it(
    "grants allowOperationTakeover to exactly one call site (the executeAction-wrapped initial " +
      "dispatch, whose own malformed-result retry shares its round lease)",
    () => {
      const withTakeover = calls.filter((call) => call.includes("allowOperationTakeover: true"));
      const withoutTakeover = calls.filter((call) => !call.includes("allowOperationTakeover"));
      assert.equal(
        withTakeover.length,
        1,
        "exactly one review-round identity-attach call site must grant allowOperationTakeover"
      );
      assert.equal(
        withoutTakeover.length,
        1,
        "the resumed-interaction call site (coordinator.resumeAction, never wrapped by " +
          "withMalformedResultRetryV1) must keep failing closed on a genuine ownership conflict"
      );
    }
  );

  void it("the resumed-interaction call site (coordinator.resumeAction) is the one left failing closed", () => {
    const resumeCallIndex = text.indexOf("coordinator.resumeAction({");
    const attachIndex = text.indexOf(ATTACH_CALL, resumeCallIndex);
    assert.ok(
      resumeCallIndex !== -1 && attachIndex !== -1 && attachIndex > resumeCallIndex,
      "expected a coordinator.resumeAction({...}) call whose body contains an identity-attach call"
    );
    const call = sliceCall(text, attachIndex);
    assert.ok(
      !call.includes("allowOperationTakeover"),
      "the resumeAction-driven attach must not grant takeover — its operationId is always the " +
        "original one, so a mismatch there is a real ownership conflict, not this round's own retry"
    );
  });
});
