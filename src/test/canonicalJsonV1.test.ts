/**
 * Coverage for Canonical JSON V1 (plan §7.1): byte-exact rendering pins,
 * key sorting, minimal escaping, integer-only numbers, and the rejection
 * set (non-finite, -0, non-integers, undefined members, cycles, non-plain
 * objects, unsupported primitives). Digest stability is pinned so a future
 * serialization change cannot silently re-digest every sealed plan.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CanonicalJsonErrorV1,
  canonicalJsonBytesV1,
  canonicalJsonStringifyV1,
  sha256OfCanonicalJsonV1,
} from "../services/canonicalJsonV1";

void describe("canonicalJsonV1", () => {
  void it("sorts object keys by UTF-16 code units, recursively, with no whitespace", () => {
    assert.equal(
      canonicalJsonStringifyV1({ b: 1, a: { z: true, y: [2, { d: null, c: "x" }] } }),
      '{"a":{"y":[2,{"c":"x","d":null}],"z":true},"b":1}'
    );
  });

  void it("uses JSON's minimal escaping with lowercase control escapes", () => {
    assert.equal(
      canonicalJsonStringifyV1({ s: 'a"b\\c\n\té' }),
      '{"s":"a\\"b\\\\c\\n\\t\\u0001é"}'
    );
  });

  void it("accepts safe integers and rejects every other number shape", () => {
    assert.equal(canonicalJsonStringifyV1([0, -5, 9007199254740991]), "[0,-5,9007199254740991]");
    assert.throws(() => canonicalJsonStringifyV1(1.5), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1(Number.NaN), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1(Number.POSITIVE_INFINITY), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1(-0), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1(9007199254740992), CanonicalJsonErrorV1);
  });

  void it("rejects undefined members, functions, symbols, bigints, cycles, and non-plain objects", () => {
    assert.throws(() => canonicalJsonStringifyV1({ a: undefined }), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1({ a: () => 1 }), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1({ a: Symbol("x") }), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1({ a: 1n }), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonStringifyV1(new Date()), CanonicalJsonErrorV1);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalJsonStringifyV1(cyclic), CanonicalJsonErrorV1);
  });

  void it("allows the same object to appear twice without a cycle (diamond sharing)", () => {
    const shared = { k: 1 };
    assert.equal(canonicalJsonStringifyV1([shared, shared]), '[{"k":1},{"k":1}]');
  });

  void it("emits UTF-8 bytes without a BOM and pins the digest of a fixed document", () => {
    const bytes = canonicalJsonBytesV1({ a: "é" });
    assert.notEqual(bytes[0], 0xef, "no BOM");
    // Pinned digest: sha256 of '{"a":1,"b":[true,null,"x"]}'.
    assert.equal(
      sha256OfCanonicalJsonV1({ b: [true, null, "x"], a: 1 }),
      "eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1"
    );
  });
});
