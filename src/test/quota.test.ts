import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isQuotaError } from "../utils/quota";

void describe("isQuotaError", () => {
  void it("classifies genuine quota/rate-limit phrasing as quota errors", () => {
    assert.strictEqual(isQuotaError("You have exceeded your current quota"), true);
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later"), true);
    assert.strictEqual(isQuotaError("Your usage limit has been reached"), true);
    assert.strictEqual(isQuotaError("Insufficient credits for this request"), true);
  });

  void it("does not classify unrelated 'exceeded' errors as quota errors", () => {
    // A bare "exceeded" marker previously caused these to false-positive as
    // quota exhaustion even though they're unrelated failure modes.
    assert.strictEqual(isQuotaError("Maximum context length exceeded"), false);
    assert.strictEqual(
      isQuotaError("Codex prompt is too large for this CLI mode (500 bytes; max 400 bytes exceeded)"),
      false
    );
    assert.strictEqual(isQuotaError("Buffer size exceeded while reading stdout"), false);
  });

  void it("returns false for undefined or unrelated messages", () => {
    assert.strictEqual(isQuotaError(undefined), false);
    assert.strictEqual(isQuotaError("command not found"), false);
  });
});
