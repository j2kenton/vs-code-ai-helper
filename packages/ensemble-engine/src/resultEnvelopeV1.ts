/**
 * Strict AI result-envelope parser (plan Part 4b port of
 * `src/types/aiResultEnvelope.ts`, the consumer side of the
 * `ensemble.aiResultContract.v1` frame whose prompt fragment lives in
 * `@ensemble/core`'s `aiResultContractV1.ts`).
 *
 * The provider dispatch layer parses every raw model response through this
 * module before anything is promoted into the task loop: exactly one
 * `<<<ENSEMBLE_AI_RESULT_V1>>>` frame (last occurrence wins — see the
 * scan-from-the-end rationale below), one line of strict JSON (duplicate
 * keys, depth/member/value limits enforced by a from-scratch parser), a full
 * correlation echo checked BEFORE any content decoding, and closed-union
 * content decoding with byte ceilings. Parity with the extension parser is
 * proven by a dual-decode corpus in tests/providerDispatch.test.ts that runs
 * the same inputs through `src/types/aiResultEnvelope.ts` and this port and
 * requires identical accept/reject outcomes.
 */
import { createHash } from "crypto";
import {
  ActionCorrelationV1,
  correlationMatchesV1,
  isActionCorrelationV1,
} from "../../ensemble-core/src/actionCorrelationV1";
import {
  StructuredQuestionV1,
  decodeStructuredQuestionsV1,
} from "../../ensemble-core/src/structuredQuestionV1";

export interface MarkdownArtifactCompletedV1 {
  readonly contentType: "markdown-artifact.v1";
  readonly schemaVersion: 1;
  /** Bounded Markdown for task, plan, review, and implementation artifacts. */
  readonly markdown: string;
}

export interface ChatMessageCompletedV1 {
  readonly contentType: "chat-message.v1";
  readonly schemaVersion: 1;
  /** Bounded assistant Chat text. */
  readonly text: string;
}

export interface CommitMetadataCompletedV1 {
  readonly contentType: "commit-metadata.v1";
  readonly schemaVersion: 1;
  /** Conventional-Commits subject line, <=72 chars. */
  readonly subject: string;
  readonly body?: string;
}

export type ParentChainLinkV1 =
  | { readonly kind: "observed"; readonly observationId: string }
  | { readonly kind: "createdByStep"; readonly stepId: string };

export type PreflightOperationKindV1 =
  | "createFile"
  | "replaceFile"
  | "createDirectory"
  | "deleteFile"
  | "deleteEmptyDirectory";

export interface PreflightOperationV1 {
  readonly stepId: string;
  readonly kind: PreflightOperationKindV1;
  readonly rootId: string;
  readonly relativePath: string;
  readonly targetObservationId: string;
  readonly parentChain: readonly ParentChainLinkV1[];
  /** Present only for createFile/replaceFile. */
  readonly contentBase64?: string;
  readonly decodedByteLength?: number;
  readonly contentSha256?: string;
}

export interface PreflightPlanCompletedV1 {
  readonly contentType: "preflight-plan.v1";
  readonly schemaVersion: 1;
  readonly requestDigest: string;
  readonly rootBindingId: string;
  readonly operations: readonly PreflightOperationV1[];
}

export interface EditExecutionCompletedV1 {
  readonly contentType: "edit-execution.v1";
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly receiptIds: readonly string[];
}

/** Closed union — no `unknown` completed content ever reaches a consumer. */
export type CompletedContentV1 =
  | MarkdownArtifactCompletedV1
  | ChatMessageCompletedV1
  | CommitMetadataCompletedV1
  | PreflightPlanCompletedV1
  | EditExecutionCompletedV1;

export type AiResultEnvelopeV1 =
  | {
      readonly version: 1;
      readonly correlation: ActionCorrelationV1;
      readonly kind: "completed";
      readonly content: CompletedContentV1;
    }
  | {
      readonly version: 1;
      readonly correlation: ActionCorrelationV1;
      readonly kind: "questions";
      readonly questions: readonly StructuredQuestionV1[];
    }
  | {
      readonly version: 1;
      readonly correlation: ActionCorrelationV1;
      readonly kind: "cancelled";
      readonly reason?: "provider" | "user";
    }
  | {
      readonly version: 1;
      readonly correlation: ActionCorrelationV1;
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface MalformedAiResultV1 {
  readonly kind: "malformed";
  readonly code:
    | "invalidFrame"
    | "invalidJson"
    | "invalidEnvelope"
    | "contentSchemaMismatch"
    | "resultCorrelationMismatch"
    | "resultLimitExceeded";
  readonly raw: string;
  readonly reason: string;
}

export type AiResultParseOutcomeV1 = AiResultEnvelopeV1 | MalformedAiResultV1;

export const FRAME_START_V1 = "<<<ENSEMBLE_AI_RESULT_V1>>>";
export const FRAME_END_V1 = "<<<END_ENSEMBLE_AI_RESULT_V1>>>";

const MAX_NORMAL_COMPLETION_BYTES_V1 = 4 * 1024 * 1024;
const MAX_PREFLIGHT_BYTES_V1 = 16 * 1024 * 1024;
const MAX_FAILURE_MESSAGE_BYTES_V1 = 8 * 1024;
const MAX_COMMIT_SUBJECT_LENGTH_V1 = 72;

const MAX_JSON_DEPTH_V1 = 32;
const MAX_JSON_VALUES_V1 = 100_000;
const MAX_CONTAINER_MEMBERS_V1 = 4_096;

const MAX_PREFLIGHT_OPERATIONS_V1 = 128;
const MAX_PREFLIGHT_FILE_BYTES_V1 = 2 * 1024 * 1024;
const MAX_PREFLIGHT_AGGREGATE_WRITE_BYTES_V1 = 8 * 1024 * 1024;
const PREFLIGHT_OP_KINDS_V1 = new Set<string>([
  "createFile",
  "replaceFile",
  "createDirectory",
  "deleteFile",
  "deleteEmptyDirectory",
]);

const FAILURE_CODE_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Bounded printable-ASCII stable identifier (question/option/step IDs). */
const STABLE_ID_PATTERN_V1 = /^[\x21-\x7E]{1,128}$/;
const LONE_SURROGATE_PATTERN_V1 =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Trailing characters that cannot change the meaning of an already-complete
 * JSON value: surplus closing brackets and whitespace, nothing else. Kept
 * byte-identical to the extension's copy in `src/types/aiResultEnvelope.ts`.
 */
const INERT_TRAILING_PATTERN_V1 = /^[\s\]}]{1,8}$/;

/** Notified when JSON parsed only because inert trailing bytes were ignored. */
export type InertTrailingObserverV1 = (inertTrailing: string) => void;

let inertTrailingObserverV1: InertTrailingObserverV1 | undefined;

/**
 * Wire a sink for the recovery above, so the tolerance is visible in logs
 * rather than silent. Optional by design: this module stays dependency-light,
 * so it reports through a seam instead of importing a logger. The embedding
 * application wires it once; tests assert on it. Ported from the extension's
 * `src/types/aiResultEnvelope.ts`, which wires it in `activate()`.
 */
export function setInertTrailingObserverV1(observer: InertTrailingObserverV1 | undefined): void {
  inertTrailingObserverV1 = observer;
}

/** Report, never affect. A throwing observer must not change parse behaviour. */
function recordInertTrailingV1(inertTrailing: string): void {
  try {
    inertTrailingObserverV1?.(inertTrailing);
  } catch {
    // Observation is a side channel; parsing correctness cannot depend on it.
  }
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID_PATTERN_V1.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(
  code: MalformedAiResultV1["code"],
  raw: string,
  reason: string
): MalformedAiResultV1 {
  return { kind: "malformed", code, raw, reason };
}

// ---------------------------------------------------------------------------
// Strict JSON parser: rejects duplicate keys, enforces depth/value/member
// limits, and (being a from-scratch recursive-descent parser over the JSON
// grammar) naturally rejects comments, trailing commas, and bare
// NaN/Infinity.
// ---------------------------------------------------------------------------

interface StrictJsonParseOk {
  readonly ok: true;
  readonly value: unknown;
  /** Inert surplus ignored after a COMPLETE value — see INERT_TRAILING_PATTERN_V1. */
  readonly inertTrailing: string;
}
interface StrictJsonParseErr {
  readonly ok: false;
  readonly reason: string;
}
type StrictJsonParseResult = StrictJsonParseOk | StrictJsonParseErr;

class StrictJsonError extends Error {}

function parseStrictJsonV1(text: string): StrictJsonParseResult {
  let i = 0;
  let valueCount = 0;
  const len = text.length;

  function fail(reason: string): never {
    throw new StrictJsonError(reason);
  }

  function countValue(): void {
    valueCount++;
    if (valueCount > MAX_JSON_VALUES_V1) {
      fail(`exceeded ${MAX_JSON_VALUES_V1} aggregate JSON values`);
    }
  }

  function skipWs(): void {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        i++;
      } else {
        break;
      }
    }
  }

  function parseString(): string {
    if (text[i] !== "\"") {
      fail("expected a string");
    }
    i++;
    let result = "";
    while (i < len) {
      const c = text[i]!;
      if (c === "\"") {
        i++;
        return result;
      }
      if (c === "\\") {
        i++;
        const esc = text[i];
        switch (esc) {
          case "\"":
            result += "\"";
            i++;
            break;
          case "\\":
            result += "\\";
            i++;
            break;
          case "/":
            result += "/";
            i++;
            break;
          case "b":
            result += "\b";
            i++;
            break;
          case "f":
            result += "\f";
            i++;
            break;
          case "n":
            result += "\n";
            i++;
            break;
          case "r":
            result += "\r";
            i++;
            break;
          case "t":
            result += "\t";
            i++;
            break;
          case "u": {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              fail("invalid \\u escape sequence");
            }
            result += String.fromCharCode(parseInt(hex, 16));
            i += 5;
            break;
          }
          default:
            fail(`invalid escape character: \\${String(esc)}`);
        }
        continue;
      }
      const code = text.charCodeAt(i);
      if (code < 0x20) {
        fail("control character in string literal");
      }
      result += c;
      i++;
    }
    fail("unterminated string literal");
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") {
      i++;
    }
    if (text[i] === "0") {
      i++;
    } else if (text[i] !== undefined && text[i]! >= "1" && text[i]! <= "9") {
      while (text[i] !== undefined && text[i]! >= "0" && text[i]! <= "9") {
        i++;
      }
    } else {
      fail("invalid number literal");
    }
    if (text[i] === ".") {
      i++;
      if (!(text[i] !== undefined && text[i]! >= "0" && text[i]! <= "9")) {
        fail("invalid number literal (missing fractional digits)");
      }
      while (text[i] !== undefined && text[i]! >= "0" && text[i]! <= "9") {
        i++;
      }
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") {
        i++;
      }
      if (!(text[i] !== undefined && text[i]! >= "0" && text[i]! <= "9")) {
        fail("invalid number literal (missing exponent digits)");
      }
      while (text[i] !== undefined && text[i]! >= "0" && text[i]! <= "9") {
        i++;
      }
    }
    return Number(text.slice(start, i));
  }

  function parseArray(depth: number): unknown[] {
    i++; // '['
    const result: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return result;
    }
    for (;;) {
      const value = parseValue(depth + 1);
      result.push(value);
      if (result.length > MAX_CONTAINER_MEMBERS_V1) {
        fail(`array exceeds ${MAX_CONTAINER_MEMBERS_V1} members`);
      }
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      fail("expected ',' or ']' in array");
    }
    return result;
  }

  function parseObject(depth: number): Record<string, unknown> {
    i++; // '{'
    // Object.create(null) so a key literally named "__proto__" becomes an
    // own enumerable property instead of silently reassigning the prototype.
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    skipWs();
    if (text[i] === "}") {
      i++;
      return result;
    }
    const seenKeys = new Set<string>();
    let memberCount = 0;
    for (;;) {
      skipWs();
      const key = parseString();
      if (seenKeys.has(key)) {
        fail(`duplicate object key: ${key}`);
      }
      seenKeys.add(key);
      skipWs();
      if (text[i] !== ":") {
        fail("expected ':' after object key");
      }
      i++;
      const value = parseValue(depth + 1);
      result[key] = value;
      memberCount++;
      if (memberCount > MAX_CONTAINER_MEMBERS_V1) {
        fail(`object exceeds ${MAX_CONTAINER_MEMBERS_V1} members`);
      }
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      fail("expected ',' or '}' in object");
    }
    return result;
  }

  function parseValue(depth: number): unknown {
    countValue();
    if (depth > MAX_JSON_DEPTH_V1) {
      fail(`exceeded max JSON depth of ${MAX_JSON_DEPTH_V1}`);
    }
    skipWs();
    if (i >= len) {
      fail("unexpected end of JSON input");
    }
    const c = text[i];
    if (c === "{") {
      return parseObject(depth);
    }
    if (c === "[") {
      return parseArray(depth);
    }
    if (c === "\"") {
      return parseString();
    }
    if (c === "-" || (c! >= "0" && c! <= "9")) {
      return parseNumber();
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    fail(`unexpected token at position ${i}`);
  }

  try {
    const value = parseValue(0);
    skipWs();
    if (i !== len) {
      // Ported from `src/types/aiResultEnvelope.ts` (2026-08-17): a COMPLETE
      // value followed only by surplus closers/whitespace is recoverable.
      // Three of the four providers in the spool corpus emit one extra `}`
      // after an otherwise perfect envelope, discarding 9-13KB of finished
      // work over one character. Safe because the value is already whole:
      // truncation fails inside parseValue, and `{`, `[`, a digit, a quote or
      // a letter all fall outside the inert set and still reject.
      const rest = text.slice(i);
      if (!INERT_TRAILING_PATTERN_V1.test(rest)) {
        return { ok: false, reason: `unexpected trailing content at position ${i}` };
      }
      return { ok: true, value, inertTrailing: rest };
    }
    return { ok: true, value, inertTrailing: "" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof StrictJsonError ? error.message : String(error),
    };
  }
}

/** Same encoding check the extension exports for frameless-content callers. */
export function hasLoneSurrogateV1(text: string): boolean {
  return LONE_SURROGATE_PATTERN_V1.test(text);
}

// ---------------------------------------------------------------------------
// Content decoders
// ---------------------------------------------------------------------------

interface ContentDecodeOk {
  readonly ok: true;
  readonly content: CompletedContentV1;
}
interface ContentDecodeErr {
  readonly ok: false;
  readonly reason: string;
}
type ContentDecodeResult = ContentDecodeOk | ContentDecodeErr;

function rejectUnknownFields(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  contentType: string
): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return `${contentType} has unknown field: ${key}`;
    }
  }
  return undefined;
}

function decodeMarkdownArtifact(raw: Record<string, unknown>): ContentDecodeResult {
  if (typeof raw.markdown !== "string") {
    return { ok: false, reason: "markdown-artifact.v1 is missing a string \"markdown\" field" };
  }
  const unknownField = rejectUnknownFields(
    raw,
    new Set(["schemaVersion", "contentType", "markdown"]),
    "markdown-artifact.v1"
  );
  if (unknownField) {
    return { ok: false, reason: unknownField };
  }
  return {
    ok: true,
    content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: raw.markdown },
  };
}

function decodeChatMessage(raw: Record<string, unknown>): ContentDecodeResult {
  if (typeof raw.text !== "string") {
    return { ok: false, reason: "chat-message.v1 is missing a string \"text\" field" };
  }
  const unknownField = rejectUnknownFields(
    raw,
    new Set(["schemaVersion", "contentType", "text"]),
    "chat-message.v1"
  );
  if (unknownField) {
    return { ok: false, reason: unknownField };
  }
  return { ok: true, content: { contentType: "chat-message.v1", schemaVersion: 1, text: raw.text } };
}

function decodeCommitMetadata(raw: Record<string, unknown>): ContentDecodeResult {
  if (typeof raw.subject !== "string" || raw.subject.length === 0) {
    return { ok: false, reason: "commit-metadata.v1 is missing a non-empty \"subject\" field" };
  }
  if (raw.subject.length > MAX_COMMIT_SUBJECT_LENGTH_V1) {
    return {
      ok: false,
      reason: `commit-metadata.v1 "subject" exceeds ${MAX_COMMIT_SUBJECT_LENGTH_V1} characters`,
    };
  }
  if (raw.body !== undefined && typeof raw.body !== "string") {
    return { ok: false, reason: "commit-metadata.v1 has a non-string \"body\" field" };
  }
  const unknownField = rejectUnknownFields(
    raw,
    new Set(["schemaVersion", "contentType", "subject", "body"]),
    "commit-metadata.v1"
  );
  if (unknownField) {
    return { ok: false, reason: unknownField };
  }
  const content: CommitMetadataCompletedV1 = {
    contentType: "commit-metadata.v1",
    schemaVersion: 1,
    subject: raw.subject,
    ...(raw.body !== undefined ? { body: raw.body } : {}),
  };
  return { ok: true, content };
}

function decodeParentChain(
  raw: unknown,
  stepId: string
): readonly ParentChainLinkV1[] | string {
  if (!Array.isArray(raw)) {
    return `operation ${stepId} is missing a "parentChain" array`;
  }
  const links: ParentChainLinkV1[] = [];
  for (const entry of raw) {
    if (!isPlainRecord(entry)) {
      return `operation ${stepId} has an invalid parentChain entry`;
    }
    if (entry.kind === "observed") {
      if (typeof entry.observationId !== "string" || entry.observationId.length === 0) {
        return `operation ${stepId} has an "observed" parentChain link missing "observationId"`;
      }
      links.push({ kind: "observed", observationId: entry.observationId });
    } else if (entry.kind === "createdByStep") {
      if (typeof entry.stepId !== "string" || entry.stepId.length === 0) {
        return `operation ${stepId} has a "createdByStep" parentChain link missing "stepId"`;
      }
      links.push({ kind: "createdByStep", stepId: entry.stepId });
    } else {
      return `operation ${stepId} has a parentChain link with an unrecognized "kind": ${JSON.stringify(entry.kind)}`;
    }
  }
  return links;
}

function decodePreflightOperation(
  raw: unknown,
  seenStepIds: ReadonlySet<string>
): PreflightOperationV1 | string {
  if (!isPlainRecord(raw)) {
    return "preflight operation is not an object";
  }
  if (!isStableId(raw.stepId)) {
    return "preflight operation is missing a valid \"stepId\"";
  }
  const stepId = raw.stepId;
  if (seenStepIds.has(stepId)) {
    return `duplicate stepId: ${stepId}`;
  }
  if (typeof raw.kind !== "string" || !PREFLIGHT_OP_KINDS_V1.has(raw.kind)) {
    return `operation ${stepId} has an unrecognized "kind": ${JSON.stringify(raw.kind)}`;
  }
  const kind = raw.kind as PreflightOperationKindV1;
  if (typeof raw.rootId !== "string" || raw.rootId.length === 0) {
    return `operation ${stepId} is missing "rootId"`;
  }
  if (typeof raw.relativePath !== "string" || raw.relativePath.length === 0) {
    return `operation ${stepId} is missing "relativePath"`;
  }
  if (typeof raw.targetObservationId !== "string" || raw.targetObservationId.length === 0) {
    return `operation ${stepId} is missing "targetObservationId"`;
  }
  const parentChain = decodeParentChain(raw.parentChain, stepId);
  if (typeof parentChain === "string") {
    return parentChain;
  }

  const isWrite = kind === "createFile" || kind === "replaceFile";
  if (!isWrite) {
    if (
      raw.contentBase64 !== undefined ||
      raw.decodedByteLength !== undefined ||
      raw.contentSha256 !== undefined
    ) {
      return `non-write operation ${stepId} must not include content bytes`;
    }
    const unknownField = rejectUnknownFields(
      raw,
      new Set(["stepId", "kind", "rootId", "relativePath", "targetObservationId", "parentChain"]),
      `operation ${stepId}`
    );
    if (unknownField) {
      return unknownField;
    }
    return {
      stepId,
      kind,
      rootId: raw.rootId,
      relativePath: raw.relativePath,
      targetObservationId: raw.targetObservationId,
      parentChain,
    };
  }

  if (typeof raw.contentBase64 !== "string") {
    return `write operation ${stepId} is missing "contentBase64"`;
  }
  let decodedBytes: Buffer;
  try {
    decodedBytes = Buffer.from(raw.contentBase64, "base64");
  } catch {
    return `write operation ${stepId} has invalid "contentBase64"`;
  }
  if (decodedBytes.toString("base64") !== raw.contentBase64) {
    return `write operation ${stepId} has non-canonical "contentBase64"`;
  }
  if (typeof raw.decodedByteLength !== "number" || raw.decodedByteLength !== decodedBytes.length) {
    return `write operation ${stepId} has a "decodedByteLength" that does not match its content`;
  }
  if (typeof raw.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.contentSha256)) {
    return `write operation ${stepId} is missing a valid "contentSha256"`;
  }
  const actualSha256 = createHash("sha256").update(decodedBytes).digest("hex");
  if (actualSha256 !== raw.contentSha256) {
    return `write operation ${stepId} has a "contentSha256" that does not match its content`;
  }
  const unknownField = rejectUnknownFields(
    raw,
    new Set([
      "stepId",
      "kind",
      "rootId",
      "relativePath",
      "targetObservationId",
      "parentChain",
      "contentBase64",
      "decodedByteLength",
      "contentSha256",
    ]),
    `operation ${stepId}`
  );
  if (unknownField) {
    return unknownField;
  }
  return {
    stepId,
    kind,
    rootId: raw.rootId,
    relativePath: raw.relativePath,
    targetObservationId: raw.targetObservationId,
    parentChain,
    contentBase64: raw.contentBase64,
    decodedByteLength: raw.decodedByteLength,
    contentSha256: raw.contentSha256,
  };
}

function decodePreflightPlan(raw: Record<string, unknown>): ContentDecodeResult {
  if (typeof raw.requestDigest !== "string" || raw.requestDigest.length === 0) {
    return { ok: false, reason: "preflight-plan.v1 is missing a string \"requestDigest\"" };
  }
  if (typeof raw.rootBindingId !== "string" || raw.rootBindingId.length === 0) {
    return { ok: false, reason: "preflight-plan.v1 is missing a string \"rootBindingId\"" };
  }
  if (!Array.isArray(raw.operations)) {
    return { ok: false, reason: "preflight-plan.v1 is missing an \"operations\" array" };
  }
  if (raw.operations.length > MAX_PREFLIGHT_OPERATIONS_V1) {
    return {
      ok: false,
      reason: `preflight-plan.v1 exceeds ${MAX_PREFLIGHT_OPERATIONS_V1} operations`,
    };
  }

  const operations: PreflightOperationV1[] = [];
  const seenStepIds = new Set<string>();
  let aggregateWriteBytes = 0;
  for (const entry of raw.operations) {
    const decoded = decodePreflightOperation(entry, seenStepIds);
    if (typeof decoded === "string") {
      return { ok: false, reason: decoded };
    }
    seenStepIds.add(decoded.stepId);
    if (decoded.decodedByteLength !== undefined) {
      if (decoded.decodedByteLength > MAX_PREFLIGHT_FILE_BYTES_V1) {
        return {
          ok: false,
          reason: `operation ${decoded.stepId} exceeds the per-file ${MAX_PREFLIGHT_FILE_BYTES_V1}-byte limit`,
        };
      }
      aggregateWriteBytes += decoded.decodedByteLength;
    }
    operations.push(decoded);
  }
  if (aggregateWriteBytes > MAX_PREFLIGHT_AGGREGATE_WRITE_BYTES_V1) {
    return {
      ok: false,
      reason: `preflight-plan.v1 exceeds the aggregate ${MAX_PREFLIGHT_AGGREGATE_WRITE_BYTES_V1}-byte write limit`,
    };
  }

  // Parent-chain referential integrity: a "createdByStep" link must
  // reference a strictly earlier createDirectory step in this same list.
  const stepIndexById = new Map(operations.map((op, idx) => [op.stepId, idx] as const));
  for (let idx = 0; idx < operations.length; idx++) {
    const op = operations[idx]!;
    for (const link of op.parentChain) {
      if (link.kind !== "createdByStep") {
        continue;
      }
      const refIdx = stepIndexById.get(link.stepId);
      if (refIdx === undefined || refIdx >= idx) {
        return {
          ok: false,
          reason: `operation ${op.stepId} parentChain references a non-earlier step: ${link.stepId}`,
        };
      }
      if (operations[refIdx]!.kind !== "createDirectory") {
        return {
          ok: false,
          reason: `operation ${op.stepId} parentChain references a non-createDirectory step: ${link.stepId}`,
        };
      }
    }
  }

  const unknownField = rejectUnknownFields(
    raw,
    new Set(["schemaVersion", "contentType", "requestDigest", "rootBindingId", "operations"]),
    "preflight-plan.v1"
  );
  if (unknownField) {
    return { ok: false, reason: unknownField };
  }

  return {
    ok: true,
    content: {
      contentType: "preflight-plan.v1",
      schemaVersion: 1,
      requestDigest: raw.requestDigest,
      rootBindingId: raw.rootBindingId,
      operations,
    },
  };
}

function decodeEditExecution(raw: Record<string, unknown>): ContentDecodeResult {
  if (typeof raw.executionId !== "string" || raw.executionId.length === 0) {
    return { ok: false, reason: "edit-execution.v1 is missing \"executionId\"" };
  }
  if (typeof raw.planId !== "string" || raw.planId.length === 0) {
    return { ok: false, reason: "edit-execution.v1 is missing \"planId\"" };
  }
  if (typeof raw.planDigest !== "string" || raw.planDigest.length === 0) {
    return { ok: false, reason: "edit-execution.v1 is missing \"planDigest\"" };
  }
  if (
    !Array.isArray(raw.receiptIds) ||
    raw.receiptIds.some((r) => typeof r !== "string" || r.length === 0)
  ) {
    return { ok: false, reason: "edit-execution.v1 has an invalid \"receiptIds\" array" };
  }
  const receiptIds = raw.receiptIds as string[];
  const seen = new Set<string>();
  for (const r of receiptIds) {
    if (seen.has(r)) {
      return { ok: false, reason: `edit-execution.v1 has a duplicate receiptId: ${r}` };
    }
    seen.add(r);
  }
  const unknownField = rejectUnknownFields(
    raw,
    new Set(["schemaVersion", "contentType", "executionId", "planId", "planDigest", "receiptIds"]),
    "edit-execution.v1"
  );
  if (unknownField) {
    return { ok: false, reason: unknownField };
  }
  return {
    ok: true,
    content: {
      contentType: "edit-execution.v1",
      schemaVersion: 1,
      executionId: raw.executionId,
      planId: raw.planId,
      planDigest: raw.planDigest,
      receiptIds,
    },
  };
}

function decodeCompletedContentV1(raw: unknown): ContentDecodeResult {
  if (!isPlainRecord(raw)) {
    return { ok: false, reason: "\"content\" is not an object" };
  }
  if (raw.schemaVersion !== 1) {
    return {
      ok: false,
      reason: `unsupported content "schemaVersion": ${JSON.stringify(raw.schemaVersion)}`,
    };
  }
  switch (raw.contentType) {
    case "markdown-artifact.v1":
      return decodeMarkdownArtifact(raw);
    case "chat-message.v1":
      return decodeChatMessage(raw);
    case "commit-metadata.v1":
      return decodeCommitMetadata(raw);
    case "preflight-plan.v1":
      return decodePreflightPlan(raw);
    case "edit-execution.v1":
      return decodeEditExecution(raw);
    default:
      return { ok: false, reason: `unrecognized "contentType": ${JSON.stringify(raw.contentType)}` };
  }
}

// ---------------------------------------------------------------------------
// Envelope decode + top-level frame parsing
// ---------------------------------------------------------------------------

const ENVELOPE_TOP_LEVEL_FIELDS_V1 = new Set([
  "version",
  "correlation",
  "kind",
  "content",
  "questions",
  "reason",
  "code",
  "message",
  "retryable",
]);

function decodeEnvelopeV1(
  value: unknown,
  raw: string,
  expectedCorrelation: ActionCorrelationV1 | undefined
): AiResultParseOutcomeV1 {
  if (!isPlainRecord(value)) {
    return malformed("invalidEnvelope", raw, "envelope is not a JSON object");
  }
  if (value.version !== 1) {
    return malformed(
      "invalidEnvelope",
      raw,
      `unsupported envelope "version": ${JSON.stringify(value.version)}`
    );
  }
  if (!isActionCorrelationV1(value.correlation)) {
    return malformed("invalidEnvelope", raw, "missing or invalid \"correlation\"");
  }
  const correlationUnknownField = rejectUnknownFields(
    value.correlation as unknown as Record<string, unknown>,
    new Set(["actionKey", "operationId", "attemptId", "taskBindingId", "chatDocumentId"]),
    "correlation"
  );
  if (correlationUnknownField) {
    return malformed("invalidEnvelope", raw, correlationUnknownField);
  }
  // Rebuilt as a plain object literal (not passed through from the strict
  // JSON parser's Object.create(null) result) so downstream consumers see an
  // ordinary object shape.
  const correlation: ActionCorrelationV1 = {
    actionKey: value.correlation.actionKey,
    operationId: value.correlation.operationId,
    attemptId: value.correlation.attemptId,
    taskBindingId: value.correlation.taskBindingId,
    chatDocumentId: value.correlation.chatDocumentId,
  };
  if (expectedCorrelation && !correlationMatchesV1(expectedCorrelation, correlation)) {
    return malformed(
      "resultCorrelationMismatch",
      raw,
      "result correlation does not match the expected operation/attempt"
    );
  }
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_TOP_LEVEL_FIELDS_V1.has(key)) {
      return malformed("invalidEnvelope", raw, `unknown envelope field: ${key}`);
    }
  }

  switch (value.kind) {
    case "completed": {
      const contentResult = decodeCompletedContentV1(value.content);
      if (!contentResult.ok) {
        return malformed("contentSchemaMismatch", raw, contentResult.reason);
      }
      if (contentResult.content.contentType !== "preflight-plan.v1") {
        const byteLen = utf8ByteLength(raw);
        if (byteLen > MAX_NORMAL_COMPLETION_BYTES_V1) {
          return malformed(
            "resultLimitExceeded",
            raw,
            `non-preflight payload exceeds the ${MAX_NORMAL_COMPLETION_BYTES_V1}-byte limit`
          );
        }
      }
      return { version: 1, correlation, kind: "completed", content: contentResult.content };
    }
    case "questions": {
      const decoded = decodeStructuredQuestionsV1(value.questions);
      if (!decoded.ok || !decoded.questions) {
        return malformed("contentSchemaMismatch", raw, decoded.reason ?? "invalid \"questions\"");
      }
      return { version: 1, correlation, kind: "questions", questions: decoded.questions };
    }
    case "cancelled": {
      if (value.reason !== undefined && value.reason !== "provider" && value.reason !== "user") {
        return malformed("invalidEnvelope", raw, "invalid \"reason\" for cancelled envelope");
      }
      return {
        version: 1,
        correlation,
        kind: "cancelled",
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
      };
    }
    case "failed": {
      if (typeof value.code !== "string" || !FAILURE_CODE_PATTERN_V1.test(value.code)) {
        return malformed("invalidEnvelope", raw, "invalid \"code\" for failed envelope");
      }
      if (
        typeof value.message !== "string" ||
        utf8ByteLength(value.message) > MAX_FAILURE_MESSAGE_BYTES_V1
      ) {
        return malformed("invalidEnvelope", raw, "invalid or oversized \"message\" for failed envelope");
      }
      if (typeof value.retryable !== "boolean") {
        return malformed("invalidEnvelope", raw, "missing boolean \"retryable\" for failed envelope");
      }
      return {
        version: 1,
        correlation,
        kind: "failed",
        code: value.code,
        message: value.message,
        retryable: value.retryable,
      };
    }
    default:
      return malformed(
        "invalidEnvelope",
        raw,
        `unrecognized envelope "kind": ${JSON.stringify(value.kind)}`
      );
  }
}

/**
 * Parse raw AI action output into a strict `AiResultEnvelopeV1`.
 *
 * Accepts exactly one frame ending at the very end of the input (beyond a
 * single optional trailing newline), scanning for the LAST occurrence of the
 * start marker so pre-frame narration — structurally unavoidable for models
 * that narrate before their final answer — is tolerated and discarded, and a
 * quoted/mentioned marker earlier in the text can never be mistaken for the
 * real one. Multiple complete frames therefore resolve to the last one, the
 * same "keep only the final say" philosophy the extension applies (see
 * `src/types/aiResultEnvelope.ts` for the incident history behind this).
 *
 * Pass `expectedCorrelation` when the caller knows which operation/attempt
 * it invoked: a cross-task/cross-operation/stale-attempt result rejects
 * (resultCorrelationMismatch) BEFORE any content is decoded.
 */
/**
 * Accept a frame whose payload is complete but whose `FRAME_END_V1`
 * terminator never arrived (2026-08-12 field report, item 1) — ported
 * verbatim from `src/types/aiResultEnvelope.ts`'s own copy; see that file's
 * doc comment for the full rationale. `body` is known NOT to end with
 * `FRAME_END_V1`.
 */
function parseUnterminatedFrameV1(
  raw: string,
  body: string,
  expectedCorrelation?: ActionCorrelationV1
): AiResultParseOutcomeV1 {
  const missingTerminatorReason = `expected the frame to end with ${FRAME_END_V1}`;
  const afterStart = body.slice(FRAME_START_V1.length);

  let eol: "\n" | "\r\n";
  if (afterStart.startsWith("\r\n")) {
    eol = "\r\n";
  } else if (afterStart.startsWith("\n")) {
    eol = "\n";
  } else {
    return malformed("invalidFrame", raw, missingTerminatorReason);
  }

  const candidateLine = afterStart.slice(eol.length);
  if (candidateLine.length === 0 || candidateLine.includes("\n") || candidateLine.includes("\r")) {
    return malformed("invalidFrame", raw, missingTerminatorReason);
  }
  if (utf8ByteLength(candidateLine) > MAX_PREFLIGHT_BYTES_V1) {
    return malformed(
      "resultLimitExceeded",
      raw,
      `payload exceeds the absolute ${MAX_PREFLIGHT_BYTES_V1}-byte ceiling`
    );
  }

  const parsed = parseStrictJsonV1(candidateLine);
  if (!parsed.ok) {
    return malformed("invalidFrame", raw, missingTerminatorReason);
  }
  if (parsed.inertTrailing.length > 0) {
    recordInertTrailingV1(parsed.inertTrailing);
  }

  return decodeEnvelopeV1(parsed.value, raw, expectedCorrelation);
}

export function parseAiResultEnvelopeV1(
  raw: string,
  expectedCorrelation?: ActionCorrelationV1
): AiResultParseOutcomeV1 {
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    return malformed("invalidFrame", raw, "input begins with a byte-order mark (BOM), which is rejected");
  }
  if (hasLoneSurrogateV1(raw)) {
    return malformed("invalidFrame", raw, "input contains a lone (unpaired) UTF-16 surrogate");
  }

  let trimmedForTrailingNewline = raw;
  if (trimmedForTrailingNewline.endsWith("\r\n")) {
    trimmedForTrailingNewline = trimmedForTrailingNewline.slice(0, -2);
  } else if (trimmedForTrailingNewline.endsWith("\n")) {
    trimmedForTrailingNewline = trimmedForTrailingNewline.slice(0, -1);
  }

  const frameStartIndex = trimmedForTrailingNewline.lastIndexOf(FRAME_START_V1);
  if (frameStartIndex === -1) {
    return malformed(
      "invalidFrame",
      raw,
      `the response does not contain the required ${FRAME_START_V1} frame marker anywhere`
    );
  }
  const body = trimmedForTrailingNewline.slice(frameStartIndex);

  if (!body.endsWith(FRAME_END_V1)) {
    return parseUnterminatedFrameV1(raw, body, expectedCorrelation);
  }
  if (body.length < FRAME_START_V1.length + FRAME_END_V1.length) {
    return malformed("invalidFrame", raw, "start and end markers overlap");
  }

  const middle = body.slice(FRAME_START_V1.length, body.length - FRAME_END_V1.length);

  let eol: "\n" | "\r\n";
  if (middle.startsWith("\r\n")) {
    eol = "\r\n";
  } else if (middle.startsWith("\n")) {
    eol = "\n";
  } else {
    return malformed("invalidFrame", raw, "expected a line ending immediately after the start marker");
  }
  if (!middle.endsWith(eol) || middle.length < eol.length * 2) {
    return malformed("invalidFrame", raw, "mixed or missing line endings around the JSON payload");
  }

  const jsonLine = middle.slice(eol.length, middle.length - eol.length);
  if (jsonLine.includes("\n") || jsonLine.includes("\r")) {
    return malformed(
      "invalidFrame",
      raw,
      "the JSON payload must be a single line (no embedded line breaks)"
    );
  }
  if (jsonLine.length === 0) {
    return malformed("invalidJson", raw, "the JSON payload is empty");
  }
  if (utf8ByteLength(jsonLine) > MAX_PREFLIGHT_BYTES_V1) {
    return malformed(
      "resultLimitExceeded",
      raw,
      `payload exceeds the absolute ${MAX_PREFLIGHT_BYTES_V1}-byte ceiling`
    );
  }

  const parsed = parseStrictJsonV1(jsonLine);
  if (!parsed.ok) {
    return malformed("invalidJson", raw, parsed.reason);
  }
  if (parsed.inertTrailing.length > 0) {
    // Accepted, but never silently: a model that miscounts its closers is
    // worth knowing about even when the payload is recoverable, and a silent
    // tolerance would hide a genuinely new malformation behind this one.
    recordInertTrailingV1(parsed.inertTrailing);
  }

  return decodeEnvelopeV1(parsed.value, raw, expectedCorrelation);
}
