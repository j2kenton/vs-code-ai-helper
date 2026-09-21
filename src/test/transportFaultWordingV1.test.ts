/**
 * v1 fixes 2, step 21 (shared wording, items 17/23/26/27/28): a clock limit, a
 * tool-round limit, a malformed request and an empty response are named for
 * what they are — never as the provider being unavailable, and never as "no
 * response arrived" when responses had arrived.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeTransportFaultClassV1 } from "../actions/taskActionCoordinatorV1";

const BANNED = [/temporarily unavailable/i, /before any response arrived/i];

void describe("describeTransportFaultClassV1 (step 21)", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["cliRunTimeout: no exit after 60m wall clock; stderr 0 byte(s)", /wall-clock time limit/],
    ["cliRunInactivityTimeout: no output for 15m", /inactivity watchdog/],
    ["copilotRequestTimedOut: round 4 exceeded the 300s wall-clock deadline", /time limit/],
    ["toolRoundLimitExceeded: used all 64 tool rounds without replying", /all of its tool rounds/],
    ["toolSessionResultBudgetExceeded", /reading budget/],
    ["copilotRequestFailed: 400 invalid_request_body", /malformed/],
    ["copilotRequestFailed: Copilot returned an empty response", /empty response/],
  ];

  for (const [evidence, expected] of cases) {
    void it(`names ${evidence.split(":")[0]} by its class`, () => {
      const phrase = describeTransportFaultClassV1(evidence);
      assert.match(phrase ?? "", expected);
      for (const banned of BANNED) {
        assert.doesNotMatch(phrase ?? "", banned);
      }
    });
  }

  void it("returns undefined for an unknown class, so the caller falls back to a neutral phrase", () => {
    assert.equal(describeTransportFaultClassV1("connectFailed"), undefined);
    assert.equal(describeTransportFaultClassV1(undefined), undefined);
  });
});
