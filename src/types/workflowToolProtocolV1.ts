/**
 * Request-local tool-session wire contract (plan §7.1/§7.2/§7.4).
 *
 * Declares the CLOSED tool rosters the two session kinds expose — preflight
 * sessions see exactly the five read tools, edit sessions exactly the three
 * mutation tools — plus the strict decoders for model-authored tool inputs
 * and the JSON-serializable result shapes the host returns. Tools are
 * attached REQUEST-LOCALLY (`attachLmToolsV1`, vscodeLmCompat.ts) — never
 * registered globally with the host.
 *
 * Every read result carries the originating host `callId`, a server-issued
 * observation id, a result digest/revision, and a completeness state
 * (§7.2); `findFiles`/`textSearch` results mint observations too but can
 * never authorize mutations (enforced by preflightPlanV1's validator).
 */
import { ObservationRefV1 } from "./preflightPlanV1";

export const READ_TOOL_NAMES_V1 = [
  "ensemble_readFile",
  "ensemble_stat",
  "ensemble_readDirectory",
  "ensemble_findFiles",
  "ensemble_textSearch",
] as const;
export type ReadToolNameV1 = (typeof READ_TOOL_NAMES_V1)[number];

export const EDIT_TOOL_NAMES_V1 = [
  "ensemble_writeFile",
  "ensemble_createDirectory",
  "ensemble_deletePath",
] as const;
export type EditToolNameV1 = (typeof EDIT_TOOL_NAMES_V1)[number];

/** Per-session limits (bounded results, bounded rounds — §3.2's spirit at the tool layer). */
export const MAX_READ_FILE_BYTES_V1 = 512 * 1024;
export const MAX_DIRECTORY_ENTRIES_V1 = 2_048;
export const MAX_FIND_RESULTS_V1 = 512;
export const MAX_TEXT_SEARCH_RESULTS_V1 = 256;
export const MAX_TEXT_SEARCH_QUERY_LENGTH_V1 = 512;
export const MAX_TOOL_ROUNDS_V1 = 64;
export const MAX_TOOL_PROTOCOL_VIOLATIONS_V1 = 8;

const RELATIVE_PATH_MAX_LENGTH_V1 = 1_024;

export interface ExactPathToolInputV1 {
  readonly rootId: string;
  readonly relativePath: string;
}

export interface FindFilesToolInputV1 {
  readonly rootId: string;
  /** Case-insensitive substring matched against root-relative paths. */
  readonly pathContains: string;
  readonly maxResults?: number;
}

export interface TextSearchToolInputV1 {
  readonly rootId: string;
  readonly query: string;
  readonly maxResults?: number;
}

export type ToolInputDecodeResultV1<T> =
  | { readonly ok: true; readonly input: T }
  | { readonly ok: false; readonly reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[]
): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return `unknown field: ${key}`;
    }
  }
  return undefined;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
}

/** Strict `{ rootId, relativePath }` decode — path-shape rules stay with workflowPathSafetyV1 at resolution time. */
export function decodeExactPathToolInputV1(
  raw: unknown
): ToolInputDecodeResultV1<ExactPathToolInputV1> {
  const record = asRecord(raw);
  if (!record) {
    return { ok: false, reason: "input is not an object" };
  }
  const unknown = rejectUnknownKeys(record, ["rootId", "relativePath"]);
  if (unknown) {
    return { ok: false, reason: unknown };
  }
  if (!isNonEmptyString(record.rootId)) {
    return { ok: false, reason: "missing rootId" };
  }
  if (!isNonEmptyString(record.relativePath) || record.relativePath.length > RELATIVE_PATH_MAX_LENGTH_V1) {
    return { ok: false, reason: "missing or oversized relativePath" };
  }
  return { ok: true, input: { rootId: record.rootId, relativePath: record.relativePath } };
}

export function decodeFindFilesToolInputV1(
  raw: unknown
): ToolInputDecodeResultV1<FindFilesToolInputV1> {
  const record = asRecord(raw);
  if (!record) {
    return { ok: false, reason: "input is not an object" };
  }
  const unknown = rejectUnknownKeys(record, ["rootId", "pathContains", "maxResults"]);
  if (unknown) {
    return { ok: false, reason: unknown };
  }
  if (!isNonEmptyString(record.rootId)) {
    return { ok: false, reason: "missing rootId" };
  }
  if (!isNonEmptyString(record.pathContains) || record.pathContains.length > RELATIVE_PATH_MAX_LENGTH_V1) {
    return { ok: false, reason: "missing or oversized pathContains" };
  }
  if (
    record.maxResults !== undefined &&
    (!Number.isSafeInteger(record.maxResults) || (record.maxResults as number) < 1)
  ) {
    return { ok: false, reason: "invalid maxResults" };
  }
  return {
    ok: true,
    input: {
      rootId: record.rootId,
      pathContains: record.pathContains,
      ...(record.maxResults !== undefined ? { maxResults: record.maxResults as number } : {}),
    },
  };
}

export function decodeTextSearchToolInputV1(
  raw: unknown
): ToolInputDecodeResultV1<TextSearchToolInputV1> {
  const record = asRecord(raw);
  if (!record) {
    return { ok: false, reason: "input is not an object" };
  }
  const unknown = rejectUnknownKeys(record, ["rootId", "query", "maxResults"]);
  if (unknown) {
    return { ok: false, reason: unknown };
  }
  if (!isNonEmptyString(record.rootId)) {
    return { ok: false, reason: "missing rootId" };
  }
  if (!isNonEmptyString(record.query) || record.query.length > MAX_TEXT_SEARCH_QUERY_LENGTH_V1) {
    return { ok: false, reason: "missing or oversized query" };
  }
  if (
    record.maxResults !== undefined &&
    (!Number.isSafeInteger(record.maxResults) || (record.maxResults as number) < 1)
  ) {
    return { ok: false, reason: "invalid maxResults" };
  }
  return {
    ok: true,
    input: {
      rootId: record.rootId,
      query: record.query,
      ...(record.maxResults !== undefined ? { maxResults: record.maxResults as number } : {}),
    },
  };
}

/** One directory entry in a `readDirectory` result. */
export interface DirectoryEntryV1 {
  readonly name: string;
  readonly kind: "file" | "directory";
}

/** One match in a `findFiles`/`textSearch` result. */
export interface DiscoveryMatchV1 {
  readonly relativePath: string;
  /** 1-based line number for text matches; absent for file matches. */
  readonly line?: number;
  readonly preview?: string;
}

export type ReadToolResultV1 =
  | (ObservationRefV1 & {
      readonly ok: true;
      readonly tool: ReadToolNameV1;
      /** UTF-8 file content (readFile only), capped at MAX_READ_FILE_BYTES_V1. */
      readonly contentUtf8?: string;
      readonly entries?: readonly DirectoryEntryV1[];
      readonly matches?: readonly DiscoveryMatchV1[];
      /** True when a discovery walk hit its result cap — the listing is not exhaustive. */
      readonly truncated?: boolean;
    })
  | {
      readonly ok: false;
      readonly callId: string;
      readonly tool: string;
      readonly code:
        | "invalidInput"
        | "unknownTool"
        | "unknownRoot"
        | "pathUnsafe"
        | "readFailed"
        | "readLimitExceeded";
      readonly reason: string;
    };

interface LmToolDescriptorV1 {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * The only characters a tool name may contain.
 *
 * This is not our rule — it is the host's. GitHub Copilot Chat rewrites every
 * declared tool name with `name.replace(/[^a-zA-Z0-9_-]/gu, "_")` before the
 * request leaves VS Code, and validates ids against `/^[a-zA-Z0-9_-]+$/u`.
 * These tools were originally named `ensemble.readFile` and friends, so the
 * model was offered `ensemble_readFile` and called it back by that name,
 * while `handleToolCall` matched the inbound name against the DOTTED list —
 * meaning every single tool call landed on the `unknownTool` branch and no
 * Copilot tool session could ever read a file. The dot was invisible in our
 * own logs because the name we recorded was always the one we declared, not
 * the one that crossed the boundary.
 *
 * Naming the tools in the host's own charset makes the rewrite a no-op, so
 * the declared name and the returned name are identical by construction.
 */
const LM_TOOL_NAME_CHARSET_V1 = /^[a-zA-Z0-9_-]+$/u;

/**
 * Fail loudly at construction if a descriptor would be renamed in flight.
 * A silent rewrite costs a whole provider's tool support, so this is checked
 * where the descriptors are built rather than left to a reviewer's eye.
 */
function assertHostSafeToolNamesV1(
  descriptors: readonly LmToolDescriptorV1[]
): readonly LmToolDescriptorV1[] {
  for (const descriptor of descriptors) {
    if (!LM_TOOL_NAME_CHARSET_V1.test(descriptor.name)) {
      throw new Error(
        `Tool name "${descriptor.name}" contains characters the host rewrites ` +
          `(allowed: A-Z a-z 0-9 _ -). The model would call it back under a ` +
          `different name than the one declared here.`
      );
    }
  }
  return descriptors;
}

const EXACT_PATH_SCHEMA_V1: Record<string, unknown> = {
  type: "object",
  properties: {
    rootId: { type: "string", description: "A registered workspace root id from the session preamble." },
    relativePath: { type: "string", description: "Forward-slash root-relative path. No '.', '..', or absolute paths." },
  },
  required: ["rootId", "relativePath"],
  additionalProperties: false,
};

/** Request-local descriptors for a PREFLIGHT session — exactly the five read tools (§7.2). */
export function readToolDescriptorsV1(): readonly LmToolDescriptorV1[] {
  return assertHostSafeToolNamesV1([
    {
      name: "ensemble_readFile",
      description:
        "Read one file's UTF-8 content by exact root-relative path. Returns the content plus a server-issued observation (id, revision, sha256) usable as a mutation precondition.",
      inputSchema: EXACT_PATH_SCHEMA_V1,
    },
    {
      name: "ensemble_stat",
      description:
        "Stat one exact root-relative path. Returns kind (missing | file | directory), revision, and a server-issued observation usable as a mutation precondition.",
      inputSchema: EXACT_PATH_SCHEMA_V1,
    },
    {
      name: "ensemble_readDirectory",
      description:
        "List one directory's immediate entries (complete, never truncated). The returned observation is the only valid parent-chain / emptiness proof.",
      inputSchema: EXACT_PATH_SCHEMA_V1,
    },
    {
      name: "ensemble_findFiles",
      description:
        "Discover files whose root-relative path contains a substring (case-insensitive). Discovery only — its observations can never authorize mutations; follow up with stat/readFile/readDirectory on exact paths.",
      inputSchema: {
        type: "object",
        properties: {
          rootId: { type: "string" },
          pathContains: { type: "string" },
          maxResults: { type: "integer", minimum: 1 },
        },
        required: ["rootId", "pathContains"],
        additionalProperties: false,
      },
    },
    {
      name: "ensemble_textSearch",
      description:
        "Search file contents for a literal string. Discovery only — its observations can never authorize mutations; follow up with exact-path reads.",
      inputSchema: {
        type: "object",
        properties: {
          rootId: { type: "string" },
          query: { type: "string" },
          maxResults: { type: "integer", minimum: 1 },
        },
        required: ["rootId", "query"],
        additionalProperties: false,
      },
    },
  ]);
}

const MUTATION_CALL_SCHEMA_V1: Record<string, unknown> = {
  type: "object",
  properties: {
    executionId: { type: "string" },
    planId: { type: "string" },
    planDigest: { type: "string" },
    stepId: { type: "string" },
  },
  required: ["executionId", "planId", "planDigest", "stepId"],
  additionalProperties: false,
};

/**
 * Request-local descriptors for an EDIT session — exactly the three
 * mutation tools (§7.4). Arguments are reference-only: no paths, no bytes;
 * the broker resolves the sealed operation by stepId.
 */
export function editToolDescriptorsV1(): readonly LmToolDescriptorV1[] {
  return assertHostSafeToolNamesV1(
    EDIT_TOOL_NAMES_V1.map((name) => ({
      name,
      description:
        `Execute the next sealed plan step assigned to ${name}. Arguments are reference-only ` +
        "(executionId/planId/planDigest/stepId from the execution script); the broker holds the sealed operation.",
      inputSchema: MUTATION_CALL_SCHEMA_V1,
    }))
  );
}
