/**
 * bugs5 Step 11 (optional part of item 2): warn once per session, only for runs over five minutes,
 * only when auto-update is not switched off.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoUpdateMayRestartExtensionsV1, shouldWarnAboutAutoUpdateV1 } from "../utils/autoUpdateWarningV1";

void describe("shouldWarnAboutAutoUpdateV1 (bugs5 Step 11)", () => {
  void it("warns for a long run with auto-update on or unset", () => {
    for (const autoUpdateSetting of [true, undefined, "onlyEnabledExtensions"]) {
      assert.equal(shouldWarnAboutAutoUpdateV1({ expectedMinutes: 20, autoUpdateSetting, alreadyWarned: false }), true);
    }
  });

  void it("does not warn when auto-update is off", () => {
    assert.equal(autoUpdateMayRestartExtensionsV1(false), false);
    assert.equal(shouldWarnAboutAutoUpdateV1({ expectedMinutes: 20, autoUpdateSetting: false, alreadyWarned: false }), false);
  });

  void it("does not warn for a short run, or twice in one session", () => {
    assert.equal(shouldWarnAboutAutoUpdateV1({ expectedMinutes: 5, autoUpdateSetting: true, alreadyWarned: false }), false);
    assert.equal(shouldWarnAboutAutoUpdateV1({ expectedMinutes: undefined, autoUpdateSetting: true, alreadyWarned: false }), false);
    assert.equal(shouldWarnAboutAutoUpdateV1({ expectedMinutes: 20, autoUpdateSetting: true, alreadyWarned: true }), false);
  });
});
