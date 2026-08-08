import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTimeHHmm } from "../utils/timeFormat";

void describe("formatTimeHHmm", () => {
  void it("formats a fixed local time as zero-padded 24-hour HH:mm", () => {
    assert.equal(formatTimeHHmm(new Date(2024, 0, 1, 13, 5)), "13:05");
  });

  void it("zero-pads single-digit hour and minute", () => {
    assert.equal(formatTimeHHmm(new Date(2024, 0, 1, 3, 9)), "03:09");
  });

  void it("renders midnight as 00, not 24", () => {
    assert.equal(formatTimeHHmm(new Date(2024, 0, 1, 0, 0)), "00:00");
  });
});
