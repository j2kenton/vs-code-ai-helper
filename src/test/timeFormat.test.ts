import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTimeHHmm, formatTimestampForDisplay } from "../utils/timeFormat";

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

void describe("formatTimestampForDisplay", () => {
  const now = new Date(2026, 7, 11, 14, 30); // 2026-08-11 14:30 local

  void it("shows HH:mm for a timestamp on the same calendar day", () => {
    assert.equal(formatTimestampForDisplay(new Date(2026, 7, 11, 9, 5), now), "09:05");
  });

  void it("shows YYYY-MM-DD for yesterday, even minutes across midnight", () => {
    assert.equal(formatTimestampForDisplay(new Date(2026, 7, 10, 23, 59), now), "2026-08-10");
  });

  void it("zero-pads month and day in the date form", () => {
    assert.equal(formatTimestampForDisplay(new Date(2026, 0, 2, 12, 0), now), "2026-01-02");
  });

  void it("compares calendar days, not 24-hour windows", () => {
    // 20 hours earlier but still the previous calendar day → date form.
    const lateYesterday = new Date(2026, 7, 10, 18, 30);
    assert.equal(formatTimestampForDisplay(lateYesterday, now), "2026-08-10");
    // Same day at 00:01 → time form.
    assert.equal(formatTimestampForDisplay(new Date(2026, 7, 11, 0, 1), now), "00:01");
  });

  void it("shows the date for a future calendar day too", () => {
    assert.equal(formatTimestampForDisplay(new Date(2026, 7, 12, 8, 0), now), "2026-08-12");
  });
});
