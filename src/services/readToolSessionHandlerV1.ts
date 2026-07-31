/**
 * Preflight read-session handler (plan §7.2): exposes exactly the five read
 * tools over ONE registered workspace root, mints a server-issued
 * observation into the attempt's ledger for every exact-path result, and is
 * read-only BY CONSTRUCTION — it holds only the file store's read slice
 * (`WorkflowReadOnlyFileViewV1`), so no code path here can name a mutation.
 *
 * Discovery (`findFiles`/`textSearch`) walks the root breadth-first through
 * the same bounded exact-directory listings, skipping well-known dependency
 * and VCS directories; its results mint observations too (every response
 * carries one — §7.2) but with a discovery source the plan validator
 * refuses as a mutation precondition.
 */
import {
  WorkflowDirectoryEntryV1,
  WorkflowFileLocatorV1,
  WorkflowFileStoreV1,
} from "./workflowFileStoreV1";
import { canonicalJsonStringifyV1, sha256OfCanonicalJsonV1 } from "./canonicalJsonV1";
import {
  ObservationLedgerV1,
  ObservationRecordV1,
  ObservationRefV1,
} from "../types/preflightPlanV1";
import {
  DirectoryEntryV1,
  DiscoveryMatchV1,
  MAX_DIRECTORY_ENTRIES_V1,
  MAX_FIND_RESULTS_V1,
  MAX_READ_FILE_BYTES_V1,
  MAX_TEXT_SEARCH_RESULTS_V1,
  ReadToolNameV1,
  READ_TOOL_NAMES_V1,
  ReadToolResultV1,
  decodeExactPathToolInputV1,
  decodeFindFilesToolInputV1,
  decodeTextSearchToolInputV1,
  readToolDescriptorsV1,
} from "../types/workflowToolProtocolV1";
import { RequestLocalToolHandlerV1, createViolationCounterV1 } from "./requestLocalToolHandlerV1";
import { LmToolCallPartV1 } from "../types/vscodeLmCompatV1";

/** The file store's read-only slice — mutation methods are absent from the TYPE. */
export type WorkflowReadOnlyFileViewV1 = Pick<
  WorkflowFileStoreV1,
  "stat" | "readFileBounded" | "listDirectoryBounded"
>;

/** Directories a discovery walk never descends into. */
const DISCOVERY_EXCLUDED_DIRS_V1 = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  ".vscode-test",
]);
/** Total directories a single discovery call may list. */
const MAX_DISCOVERY_DIRECTORIES_V1 = 512;
/** Total files a single textSearch call may read. */
const MAX_TEXT_SEARCH_FILES_V1 = 512;
const MATCH_PREVIEW_MAX_LENGTH_V1 = 200;

export interface ReadToolSessionHandlerOptionsV1 {
  readonly view: WorkflowReadOnlyFileViewV1;
  /** The single registered workspace root this session exposes. */
  readonly rootId: string;
  readonly ledger: ObservationLedgerV1;
}

function errorResult(
  callId: string,
  tool: string,
  code: Extract<ReadToolResultV1, { ok: false }>["code"],
  reason: string
): ReadToolResultV1 {
  return { ok: false, callId, tool, code, reason };
}

function refOf(record: ObservationRecordV1): ObservationRefV1 {
  return {
    observationId: record.observationId,
    callId: record.callId,
    rootId: record.rootId,
    relativePath: record.relativePath,
    kind: record.kind,
    revision: record.revision,
    complete: record.complete,
    ...(record.contentSha256 !== undefined ? { contentSha256: record.contentSha256 } : {}),
  };
}

export function createReadToolSessionHandlerV1(
  options: ReadToolSessionHandlerOptionsV1
): RequestLocalToolHandlerV1 {
  const { view, rootId, ledger } = options;
  const violations = createViolationCounterV1();

  function locator(relativePath: string): WorkflowFileLocatorV1 {
    return { rootId, relativePath };
  }

  function wireEntries(entries: readonly WorkflowDirectoryEntryV1[]): DirectoryEntryV1[] {
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind === "directory" ? "directory" : "file",
    }));
  }

  async function handleExactPath(
    tool: ReadToolNameV1,
    callId: string,
    rawInput: unknown
  ): Promise<ReadToolResultV1> {
    const decoded = decodeExactPathToolInputV1(rawInput);
    if (!decoded.ok) {
      violations.record();
      return errorResult(callId, tool, "invalidInput", decoded.reason);
    }
    if (decoded.input.rootId !== rootId) {
      violations.record();
      return errorResult(callId, tool, "unknownRoot", "this session exposes a single registered root");
    }
    const relativePath = decoded.input.relativePath;

    if (tool === "ensemble.readFile") {
      const read = await view.readFileBounded(locator(relativePath), MAX_READ_FILE_BYTES_V1);
      if (read.kind === "unavailable") {
        return errorResult(callId, tool, "pathUnsafe", read.code);
      }
      if (read.kind === "failed") {
        if (read.code === "targetMissing") {
          const record = ledger.mint({
            callId,
            rootId,
            relativePath,
            kind: "missing",
            revision: "missing",
            complete: true,
            source: "readFile",
          });
          return { ok: true, tool, ...refOf(record) };
        }
        if (read.code === "readLimitExceeded") {
          return errorResult(callId, tool, "readLimitExceeded", "file exceeds the per-read byte limit");
        }
        return errorResult(callId, tool, "readFailed", read.code);
      }
      const record = ledger.mint({
        callId,
        rootId,
        relativePath,
        kind: "file",
        revision: read.value.revision,
        contentSha256: read.value.sha256,
        complete: true,
        source: "readFile",
      });
      return {
        ok: true,
        tool,
        ...refOf(record),
        contentUtf8: read.value.bytes.toString("utf8"),
      };
    }

    if (tool === "ensemble.stat") {
      const stat = await view.stat(locator(relativePath));
      if (stat.kind === "unavailable") {
        return errorResult(callId, tool, "pathUnsafe", stat.code);
      }
      if (stat.kind === "failed") {
        return errorResult(callId, tool, "readFailed", stat.code);
      }
      const kind = stat.value.kind;
      const record = ledger.mint({
        callId,
        rootId,
        relativePath,
        kind,
        revision:
          kind === "file"
            ? stat.value.revision ?? "file:unverified"
            : kind === "directory"
              ? // Existence fact only: a stat cannot prove a complete listing,
                // so it can never serve as a parent-chain/emptiness proof
                // (preflightPlanV1 requires source "readDirectory" for those).
                "dir:unverified"
              : "missing",
        complete: true,
        source: "stat",
      });
      return { ok: true, tool, ...refOf(record) };
    }

    // ensemble.readDirectory
    const listing = await view.listDirectoryBounded(locator(relativePath), MAX_DIRECTORY_ENTRIES_V1);
    if (listing.kind === "unavailable") {
      return errorResult(callId, tool, "pathUnsafe", listing.code);
    }
    if (listing.kind === "failed") {
      if (listing.code === "targetMissing") {
        const record = ledger.mint({
          callId,
          rootId,
          relativePath,
          kind: "missing",
          revision: "missing",
          complete: true,
          source: "readDirectory",
        });
        return { ok: true, tool, ...refOf(record) };
      }
      if (listing.code === "readLimitExceeded") {
        return errorResult(callId, tool, "readLimitExceeded", "directory exceeds the listing limit");
      }
      return errorResult(callId, tool, "readFailed", listing.code);
    }
    const entries = wireEntries(listing.value);
    const sortedForDigest = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const record = ledger.mint({
      callId,
      rootId,
      relativePath,
      kind: "directory",
      revision: `dir:${sha256OfCanonicalJsonV1(sortedForDigest.map((e) => ({ kind: e.kind, name: e.name })))}`,
      complete: true,
      source: "readDirectory",
      entryNames: entries.map((entry) => entry.name),
    });
    return { ok: true, tool, ...refOf(record), entries };
  }

  /** Bounded BFS over the root's directories via complete exact listings. */
  async function walkDirectories(
    visit: (relativePath: string, entries: readonly DirectoryEntryV1[]) => Promise<boolean> | boolean
  ): Promise<{ exhausted: boolean }> {
    const queue: string[] = [""];
    let listed = 0;
    while (queue.length > 0) {
      if (listed >= MAX_DISCOVERY_DIRECTORIES_V1) {
        return { exhausted: false };
      }
      const dir = queue.shift()!;
      listed += 1;
      const listing = await view.listDirectoryBounded(
        locator(dir === "" ? "." : dir),
        MAX_DIRECTORY_ENTRIES_V1
      );
      if (listing.kind !== "ok") {
        continue;
      }
      const entries = wireEntries(listing.value);
      const keepGoing = await visit(dir, entries);
      if (!keepGoing) {
        return { exhausted: true };
      }
      for (const entry of entries) {
        if (entry.kind === "directory" && !DISCOVERY_EXCLUDED_DIRS_V1.has(entry.name)) {
          queue.push(dir === "" ? entry.name : `${dir}/${entry.name}`);
        }
      }
    }
    return { exhausted: true };
  }

  async function handleFindFiles(callId: string, rawInput: unknown): Promise<ReadToolResultV1> {
    const decoded = decodeFindFilesToolInputV1(rawInput);
    if (!decoded.ok) {
      violations.record();
      return errorResult(callId, "ensemble.findFiles", "invalidInput", decoded.reason);
    }
    if (decoded.input.rootId !== rootId) {
      violations.record();
      return errorResult(callId, "ensemble.findFiles", "unknownRoot", "this session exposes a single registered root");
    }
    const needle = decoded.input.pathContains.toLowerCase();
    const cap = Math.min(decoded.input.maxResults ?? MAX_FIND_RESULTS_V1, MAX_FIND_RESULTS_V1);
    const matches: DiscoveryMatchV1[] = [];
    let capped = false;
    const walk = await walkDirectories((dir, entries) => {
      for (const entry of entries) {
        if (entry.kind !== "file") {
          continue;
        }
        const relativePath = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (relativePath.toLowerCase().includes(needle)) {
          matches.push({ relativePath });
          if (matches.length >= cap) {
            capped = true;
            return false;
          }
        }
      }
      return true;
    });
    const complete = walk.exhausted && !capped;
    const record = ledger.mint({
      callId,
      rootId,
      relativePath: "",
      kind: "directory",
      revision: `search:${sha256OfCanonicalJsonV1(matches.map((m) => m.relativePath))}`,
      complete,
      source: "findFiles",
    });
    return {
      ok: true,
      tool: "ensemble.findFiles",
      ...refOf(record),
      matches,
      ...(complete ? {} : { truncated: true }),
    };
  }

  async function handleTextSearch(callId: string, rawInput: unknown): Promise<ReadToolResultV1> {
    const decoded = decodeTextSearchToolInputV1(rawInput);
    if (!decoded.ok) {
      violations.record();
      return errorResult(callId, "ensemble.textSearch", "invalidInput", decoded.reason);
    }
    if (decoded.input.rootId !== rootId) {
      violations.record();
      return errorResult(callId, "ensemble.textSearch", "unknownRoot", "this session exposes a single registered root");
    }
    const query = decoded.input.query;
    const cap = Math.min(decoded.input.maxResults ?? MAX_TEXT_SEARCH_RESULTS_V1, MAX_TEXT_SEARCH_RESULTS_V1);
    const matches: DiscoveryMatchV1[] = [];
    let filesScanned = 0;
    let capped = false;
    const walk = await walkDirectories(async (dir, entries) => {
      for (const entry of entries) {
        if (entry.kind !== "file") {
          continue;
        }
        if (filesScanned >= MAX_TEXT_SEARCH_FILES_V1) {
          capped = true;
          return false;
        }
        filesScanned += 1;
        const relativePath = dir === "" ? entry.name : `${dir}/${entry.name}`;
        const read = await view.readFileBounded(locator(relativePath), MAX_READ_FILE_BYTES_V1);
        if (read.kind !== "ok") {
          continue;
        }
        const text = read.value.bytes.toString("utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.includes(query)) {
            matches.push({
              relativePath,
              line: i + 1,
              preview: line.trim().slice(0, MATCH_PREVIEW_MAX_LENGTH_V1),
            });
            if (matches.length >= cap) {
              capped = true;
              return false;
            }
          }
        }
      }
      return true;
    });
    const complete = walk.exhausted && !capped;
    const record = ledger.mint({
      callId,
      rootId,
      relativePath: "",
      kind: "directory",
      revision: `search:${sha256OfCanonicalJsonV1(matches.map((m) => `${m.relativePath}:${m.line ?? 0}`))}`,
      complete,
      source: "textSearch",
    });
    return {
      ok: true,
      tool: "ensemble.textSearch",
      ...refOf(record),
      matches,
      ...(complete ? {} : { truncated: true }),
    };
  }

  return {
    descriptors: readToolDescriptorsV1(),
    async handleToolCall(call: LmToolCallPartV1): Promise<string> {
      let result: ReadToolResultV1;
      if (!(READ_TOOL_NAMES_V1 as readonly string[]).includes(call.name)) {
        violations.record();
        result = errorResult(call.callId, call.name, "unknownTool", "not a preflight read tool");
      } else if (call.name === "ensemble.findFiles") {
        result = await handleFindFiles(call.callId, call.input);
      } else if (call.name === "ensemble.textSearch") {
        result = await handleTextSearch(call.callId, call.input);
      } else {
        result = await handleExactPath(call.name as ReadToolNameV1, call.callId, call.input);
      }
      return canonicalJsonStringifyV1(result as unknown as Record<string, unknown>);
    },
    violationCount: () => violations.count(),
  };
}
