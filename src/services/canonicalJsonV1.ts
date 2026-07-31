/**
 * Canonical JSON V1 (plan §7.1) — the single serialization every §7 digest
 * is computed over (plan digests, observation-ledger digests, execution-
 * script digests, sealed-operation digests).
 *
 * Canonical form:
 *  - UTF-8 without BOM;
 *  - object keys sorted by UTF-16 code units;
 *  - minimal required string escaping (JSON's own mandatory set: `\"`,
 *    `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, remaining control characters as
 *    lowercase `\u00xx`) — exactly `JSON.stringify`'s string encoding;
 *  - schema-permitted integers only: every number must be a safe integer,
 *    never non-finite, never negative zero;
 *  - no duplicate keys (unrepresentable for plain objects, rejected for
 *    everything that is not a plain object/array), no insignificant
 *    whitespace.
 *
 * Anything that cannot be represented canonically THROWS
 * (`CanonicalJsonErrorV1`) rather than being silently dropped the way
 * `JSON.stringify` drops `undefined`/functions — a digest over a silently
 * reshaped value would verify content nobody actually wrote.
 *
 * `structuredQuestionV1.ts`'s `canonicalJsonTextV1` predates this module
 * and covers only the closed question/answer/transaction shapes; its
 * digests are load-bearing in persisted Chat transactions and must not
 * change, so the two deliberately remain separate (see that module's doc).
 */
import { createHash } from "crypto";

export class CanonicalJsonErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonErrorV1";
  }
}

function renderValue(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonErrorV1(`non-finite number at ${path}`);
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonErrorV1(`non-integer (or unsafe-integer) number at ${path}`);
      }
      if (Object.is(value, -0)) {
        throw new CanonicalJsonErrorV1(`negative zero at ${path}`);
      }
      return String(value);
    }
    case "object":
      break;
    default:
      throw new CanonicalJsonErrorV1(`unsupported ${typeof value} value at ${path}`);
  }

  const objectValue: object = value;
  if (seen.has(objectValue)) {
    throw new CanonicalJsonErrorV1(`circular reference at ${path}`);
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      const items = objectValue.map((item, index) => renderValue(item, `${path}[${index}]`, seen));
      return `[${items.join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonErrorV1(`non-plain object at ${path}`);
    }
    const record = objectValue as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const members = keys.map((key) => {
      const member = record[key];
      if (member === undefined) {
        throw new CanonicalJsonErrorV1(`undefined member at ${path}.${key}`);
      }
      return `${JSON.stringify(key)}:${renderValue(member, `${path}.${key}`, seen)}`;
    });
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/** Render a value as canonical JSON text. Throws `CanonicalJsonErrorV1` on unrepresentable input. */
export function canonicalJsonStringifyV1(value: unknown): string {
  return renderValue(value, "$", new Set());
}

/** Canonical UTF-8 bytes (no BOM) of a value. */
export function canonicalJsonBytesV1(value: unknown): Buffer {
  return Buffer.from(canonicalJsonStringifyV1(value), "utf8");
}

/** Lowercase-hex SHA-256 over a value's canonical bytes — every §7 digest uses this. */
export function sha256OfCanonicalJsonV1(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytesV1(value)).digest("hex");
}
