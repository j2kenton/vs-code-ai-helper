/**
 * Coverage for the §3.9 fallback-state decoder: only the existing per-stage
 * boolean map is valid — scalar booleans and unknown stage keys fail closed.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFallbackStateV1 } from "../types/fallbackStateV1";

void describe("fallbackStateV1", () => {
  void it("decodes absent input to an empty map and valid maps exactly", () => {
    assert.deepEqual(decodeFallbackStateV1(undefined), { ok: true, state: {} });
    assert.deepEqual(decodeFallbackStateV1({}), { ok: true, state: {} });
    assert.deepEqual(decodeFallbackStateV1({ impl: true, plan: false }), {
      ok: true,
      state: { impl: true, plan: false },
    });
  });

  void it("rejects scalar booleans — the historical whole-task flag cannot be mapped", () => {
    assert.equal(decodeFallbackStateV1(true).ok, false);
    assert.equal(decodeFallbackStateV1(false).ok, false);
  });

  void it("rejects non-map shapes, unknown stages, and non-boolean entries", () => {
    assert.equal(decodeFallbackStateV1(null).ok, false);
    assert.equal(decodeFallbackStateV1("impl").ok, false);
    assert.equal(decodeFallbackStateV1(["impl"]).ok, false);
    assert.equal(decodeFallbackStateV1({ "not-a-stage": true }).ok, false);
    assert.equal(decodeFallbackStateV1({ impl: "true" }).ok, false);
    assert.equal(decodeFallbackStateV1({ impl: 1 }).ok, false);
  });
});
