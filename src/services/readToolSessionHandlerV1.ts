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
  MAX_CONSECUTIVE_DISCOVERY_CALLS_V1,
  MAX_DIRECTORY_ENTRIES_V1,
  MAX_FIND_RESULTS_V1,
  MAX_RANGED_READ_SOURCE_BYTES_V1,
  MAX_READ_FILE_BYTES_V1,
  MAX_TEXT_SEARCH_RESULTS_V1,
  ReadFileToolInputV1,
  ReadToolNameV1,
  READ_TOOL_NAMES_V1,
  ReadToolResultV1,
  decodeExactPathToolInputV1,
  decodeReadFileToolInputV1,
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
/** Discovery-returned paths kept so a refusal can name them. */
const MAX_REMEMBERED_DISCOVERY_PATHS_V1 = 40;
/** How many of those one refusal message lists. */
const MAX_SUGGESTED_DISCOVERY_PATHS_V1 = 8;

export interface ReadToolSessionHandlerOptionsV1 {
  readonly view: WorkflowReadOnlyFileViewV1;
  /** The single registered workspace root this session exposes. */
  readonly rootId: string;
  readonly ledger: ObservationLedgerV1;
}

/** One exact-path tool call's target — never content, never a search query
 * (item 3b-2, 2026-08-17..19 workflow-defects batch). */
export interface ReadToolCallEventV1 {
  readonly tool: string;
  readonly relativePath: string;
  /** Present only on a ranged `ensemble_readFile`. */
  readonly startLine?: number;
  readonly endLine?: number;
}

type LineSliceV1 =
  | {
      readonly kind: "ok";
      readonly content: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly totalLines: number;
      /** Stopped before the requested end because the slice hit `maxBytes`. */
      readonly truncated: boolean;
    }
  | { readonly kind: "pastEnd"; readonly totalLines: number }
  | { readonly kind: "lineTooLarge"; readonly line: number; readonly totalLines: number };

/**
 * How many lines `text` has. A trailing "\n" terminates the last line; it
 * does not start another.
 *
 * Scans newline positions rather than splitting: a ranged read may open a
 * file of up to `MAX_RANGED_READ_SOURCE_BYTES_V1`, and `split("\n")` on a
 * newline-dense one would allocate one array entry per line (millions) just
 * to return a few of them.
 */
function countLinesV1(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Refusal for a file too large even for a line-range read: nothing this tool offers can open it. */
function rangedReadSourceLimitReasonV1(): string {
  return (
    `file is over the ${MAX_RANGED_READ_SOURCE_BYTES_V1 / (1024 * 1024)} MB limit even for line-range ` +
    "reads, so this tool cannot read any of it. Do not retry. If your answer depends on this file, " +
    "say so as a confidence limitation."
  );
}

/**
 * Lines `startLine..endLine` (1-based, inclusive) of `text`, byte for byte —
 * each line keeps its own terminator (including a `\r` before `\n`), so the
 * slice can be copied verbatim into a patch. `endLine` past the end is
 * clamped; a slice that would exceed `maxBytes` stops at the last whole line
 * that fits. Memory stays proportional to the returned slice (see
 * `countLinesV1`).
 */
function sliceLinesV1(text: string, startLine: number, endLine: number | undefined, maxBytes: number): LineSliceV1 {
  const totalLines = countLinesV1(text);
  if (startLine > totalLines) {
    return { kind: "pastEnd", totalLines };
  }
  const lastRequested = Math.min(endLine ?? totalLines, totalLines);
  let offset = 0;
  for (let line = 1; line < startLine; line++) {
    offset = text.indexOf("\n", offset) + 1;
  }
  let content = "";
  let bytes = 0;
  let last = startLine - 1;
  for (let line = startLine; line <= lastRequested; line++) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline + 1;
    const piece = text.slice(offset, end);
    const pieceBytes = Buffer.byteLength(piece, "utf8");
    if (bytes + pieceBytes > maxBytes) {
      if (line === startLine) {
        return { kind: "lineTooLarge", line, totalLines };
      }
      break;
    }
    content += piece;
    bytes += pieceBytes;
    last = line;
    offset = end;
  }
  return { kind: "ok", content, startLine, endLine: last, totalLines, truncated: last < lastRequested };
}

export type ReadToolCallObserverV1 = (event: ReadToolCallEventV1) => void;

let readToolCallObserverV1: ReadToolCallObserverV1 | undefined;

/**
 * Wire a sink for the sanitized read-session transcript: tool name plus
 * target path only, on every `ensemble_readFile`/`ensemble_stat`/
 * `ensemble_listDirectory` call. Same optional-seam pattern as
 * `setLmToolSessionObserverV1` (languageModelToolSessionV1.ts) — before this,
 * a preflight session that spent real provider spend reading files and then
 * hit a pre-response transport failure (e.g. a billing-limit exhaustion, item
 * 3b) left no record at all of which files it had opened.
 */
export function setReadToolCallObserverV1(observer: ReadToolCallObserverV1 | undefined): void {
  readToolCallObserverV1 = observer;
}

/** Report, never affect. A throwing observer must not change session behaviour. */
function recordReadToolCallV1(event: ReadToolCallEventV1): void {
  try {
    readToolCallObserverV1?.(event);
  } catch {
    // Observation is a side channel; session correctness cannot depend on it.
  }
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
    ...(record.partialContent ? { partialContent: true as const } : {}),
  };
}

export function createReadToolSessionHandlerV1(
  options: ReadToolSessionHandlerOptionsV1
): RequestLocalToolHandlerV1 {
  const { view, rootId, ledger } = options;
  const violations = createViolationCounterV1();

  /**
   * Discovery calls (`findFiles`/`textSearch`) since the last exact-path read.
   *
   * Searching is the one thing in this session that feels like progress and
   * cannot produce any: a discovery observation never authorizes an operation
   * (`AUTHORIZING_SOURCES_V1`, preflightPlanV1.ts), and the session's cap is on
   * REPLIES, so a reply spent searching is a reply not spent planning. Observed
   * 2026-09-18 across four rounds on one task: 76 searches to 11 reads, then 20
   * to 2, each ending with an empty plan after the model ran out of replies.
   * Two rounds of preamble wording asking it to search less changed nothing.
   *
   * So the tool stops answering instead. The counter resets on any exact-path
   * read, which makes this a "search, then read what you found" rhythm rather
   * than a session-wide quota: a model that reads between searches never sees
   * this at all.
   */
  let discoveryCallsSinceExactRead = 0;
  /** See `RequestLocalToolHandlerV1.exactPathObservationCount`. */
  let exactPathObservations = 0;
  /** Paths the refused call can point at, newest last, capped. */
  const recentDiscoveryPaths: string[] = [];

  function rememberDiscoveryPaths(paths: readonly string[]): void {
    for (const relativePath of paths) {
      if (!recentDiscoveryPaths.includes(relativePath)) {
        recentDiscoveryPaths.push(relativePath);
      }
    }
    while (recentDiscoveryPaths.length > MAX_REMEMBERED_DISCOVERY_PATHS_V1) {
      recentDiscoveryPaths.shift();
    }
  }

  /**
   * The refusal, which has to leave the model somewhere to go: it names the
   * paths it already has and the one call that clears the gate.
   */
  function discoveryBudgetReasonV1(tool: string): string {
    const known =
      recentDiscoveryPaths.length > 0
        ? ` You already have these exact paths: ${recentDiscoveryPaths.slice(-MAX_SUGGESTED_DISCOVERY_PATHS_V1).join(", ")}.`
        : "";
    return (
      `${discoveryCallsSinceExactRead} searches in a row without opening a file. ` +
      "A search result can never authorize an edit — only an exact-path " +
      "`ensemble_readFile`, `ensemble_stat` or `ensemble_readDirectory` can — and this " +
      "session is capped on replies, so more searching cannot produce a plan." +
      known +
      ` Read one of them (use startLine/endLine on a large file), then write your plan. ` +
      `${tool} answers again after any exact-path read.`
    );
  }

  function locator(relativePath: string): WorkflowFileLocatorV1 {
    return { rootId, relativePath };
  }

  /**
   * Mint a directory observation for each existing ancestor of `relativePath`
   * that this session has not observed yet, so a `createFile`/`createDirectory`
   * on that path passes the parent-chain check without the model having to
   * stat every level itself. See the call site for why the host does this.
   *
   * Stops at the first ancestor that is not an existing directory: below such a
   * path nothing can be resolved anyway, and the plan validator's own message
   * is the right place to explain that.
   */
  async function observeAncestorDirectoriesV1(relativePath: string, callId: string): Promise<void> {
    const segments = relativePath.split("/");
    segments.pop();
    let ancestorPath = "";
    for (const segment of segments) {
      ancestorPath = ancestorPath === "" ? segment : `${ancestorPath}/${segment}`;
      const alreadyObserved = ledger
        .records()
        .some(
          (record) =>
            record.rootId === rootId &&
            record.relativePath === ancestorPath &&
            record.kind === "directory"
        );
      if (alreadyObserved) {
        continue;
      }
      const stat = await view.stat(locator(ancestorPath));
      if (stat.kind === "unavailable" || stat.kind === "failed" || stat.value.kind !== "directory") {
        return;
      }
      ledger.mint({
        callId,
        rootId,
        relativePath: ancestorPath,
        // Existence only, exactly as a model's own stat of this directory would
        // record it: `dir:unverified` can prove an ancestor exists and can
        // never stand in for the complete listing an emptiness proof needs.
        kind: "directory",
        revision: "dir:unverified",
        complete: true,
        source: "stat",
      });
    }
  }

  /**
   * Why a whole-file read was refused, and how to read the file instead. A
   * bare "exceeds the per-read byte limit" left a model no way forward, so it
   * names the file's size and length and the range parameters.
   */
  async function wholeFileLimitReasonV1(relativePath: string): Promise<string> {
    const limitKb = MAX_READ_FILE_BYTES_V1 / 1024;
    const probe = await view.readFileBounded(locator(relativePath), MAX_RANGED_READ_SOURCE_BYTES_V1);
    if (probe.kind === "ok") {
      const lines = countLinesV1(probe.value.bytes.toString("utf8"));
      return (
        `file is ${probe.value.bytes.length} bytes, over the ${limitKb} KB whole-file limit. ` +
        `It has ${lines} lines: read it in parts by passing startLine and endLine.`
      );
    }
    if (probe.kind === "failed" && probe.code === "readLimitExceeded") {
      // Ranges are refused above this size too, so suggesting them would only
      // spend another of the session's limited rounds on a certain failure.
      return rangedReadSourceLimitReasonV1();
    }
    return `file is over the ${limitKb} KB whole-file limit: read it in parts by passing startLine and endLine`;
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
    const decoded =
      tool === "ensemble_readFile" ? decodeReadFileToolInputV1(rawInput) : decodeExactPathToolInputV1(rawInput);
    if (!decoded.ok) {
      violations.record();
      return errorResult(callId, tool, "invalidInput", decoded.reason);
    }
    if (decoded.input.rootId !== rootId) {
      violations.record();
      return errorResult(callId, tool, "unknownRoot", "this session exposes a single registered root");
    }
    const relativePath = decoded.input.relativePath;
    const { startLine, endLine } = decoded.input as ReadFileToolInputV1;
    const ranged = startLine !== undefined || endLine !== undefined;
    // Item 3b-2 (2026-08-17..19 workflow-defects batch): record which file
    // was targeted, live, before whatever happens next in the session (a
    // budget cutoff, a crash, a non-completing outcome further down the
    // loop). Fired here — the moment the call is known-valid — rather than
    // batched at session end, so a failed session still leaves a record of
    // what it read instead of nothing at all. Tool name + path (and range)
    // only, never content (§2.2).
    recordReadToolCallV1({
      tool,
      relativePath,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    });

    if (tool === "ensemble_readFile") {
      const read = await view.readFileBounded(
        locator(relativePath),
        ranged ? MAX_RANGED_READ_SOURCE_BYTES_V1 : MAX_READ_FILE_BYTES_V1
      );
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
          return errorResult(
            callId,
            tool,
            "readLimitExceeded",
            ranged ? rangedReadSourceLimitReasonV1() : await wholeFileLimitReasonV1(relativePath)
          );
        }
        return errorResult(callId, tool, "readFailed", read.code);
      }
      const text = read.value.bytes.toString("utf8");
      let rangeFields: Pick<
        Extract<ReadToolResultV1, { ok: true }>,
        "startLine" | "endLine" | "totalLines" | "truncated"
      > = {};
      let contentUtf8 = text;
      if (ranged) {
        const slice = sliceLinesV1(text, startLine ?? 1, endLine, MAX_READ_FILE_BYTES_V1);
        if (slice.kind === "pastEnd") {
          // Not a protocol violation: the model cannot know a file's length
          // before reading it, so this must not count toward the abort cap.
          return errorResult(
            callId,
            tool,
            "invalidInput",
            `startLine ${startLine ?? 1} is past the end of the file, which has ${slice.totalLines} lines`
          );
        }
        if (slice.kind === "lineTooLarge") {
          return errorResult(
            callId,
            tool,
            "readLimitExceeded",
            `line ${slice.line} alone is over the ${MAX_READ_FILE_BYTES_V1 / 1024} KB per-read limit`
          );
        }
        contentUtf8 = slice.content;
        rangeFields = {
          startLine: slice.startLine,
          endLine: slice.endLine,
          totalLines: slice.totalLines,
          ...(slice.truncated ? { truncated: true } : {}),
        };
      }
      // A ranged read's observation still records the WHOLE file's revision
      // and digest: the host read all of it, so this is a complete statement
      // of the file's state. But the model saw only a slice, so it is marked
      // `partialContent`, which the plan validator refuses for `replaceFile`:
      // a whole-file replacement written from a slice would silently delete
      // every line the model never saw.
      const record = ledger.mint({
        callId,
        rootId,
        relativePath,
        kind: "file",
        revision: read.value.revision,
        contentSha256: read.value.sha256,
        complete: true,
        source: "readFile",
        ...(ranged ? { partialContent: true as const } : {}),
      });
      return {
        ok: true,
        tool,
        ...refOf(record),
        contentUtf8,
        ...rangeFields,
      };
    }

    if (tool === "ensemble_stat") {
      const stat = await view.stat(locator(relativePath));
      if (stat.kind === "unavailable") {
        return errorResult(callId, tool, "pathUnsafe", stat.code);
      }
      if (stat.kind === "failed") {
        return errorResult(callId, tool, "readFailed", stat.code);
      }
      const kind = stat.value.kind;
      if (kind === "missing") {
        // Statting a path is how a model authorizes creating it — and creating
        // a file also needs every ancestor directory observed, which the model
        // must otherwise do by hand, one stat per level.
        //
        // It does not. Runs 2067 and 2068 (2026-09-18) both produced a correct,
        // complete plan to add a new test file and both were refused for not
        // having observed `src`, in a repository that obviously has one — the
        // second even after the refusal text was rewritten to say exactly which
        // call to make. The information was never in doubt: the host can see
        // those directories, and the edit broker re-verifies every ancestor at
        // execution time anyway (§7.7 (4)), so nothing is taken on trust by
        // resolving them here. Asking the model for paperwork the host can do
        // itself only loses rounds.
        await observeAncestorDirectoriesV1(relativePath, callId);
      }
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

    // ensemble_readDirectory
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
      return errorResult(callId, "ensemble_findFiles", "invalidInput", decoded.reason);
    }
    if (decoded.input.rootId !== rootId) {
      violations.record();
      return errorResult(callId, "ensemble_findFiles", "unknownRoot", "this session exposes a single registered root");
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
      tool: "ensemble_findFiles",
      ...refOf(record),
      matches,
      ...(complete ? {} : { truncated: true }),
    };
  }

  async function handleTextSearch(callId: string, rawInput: unknown): Promise<ReadToolResultV1> {
    const decoded = decodeTextSearchToolInputV1(rawInput);
    if (!decoded.ok) {
      violations.record();
      return errorResult(callId, "ensemble_textSearch", "invalidInput", decoded.reason);
    }
    if (decoded.input.rootId !== rootId) {
      violations.record();
      return errorResult(callId, "ensemble_textSearch", "unknownRoot", "this session exposes a single registered root");
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
      tool: "ensemble_textSearch",
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
      } else if (call.name === "ensemble_findFiles" || call.name === "ensemble_textSearch") {
        // The gate is here rather than inside each handler so the decision is
        // made once, before any walk runs, and so a refusal costs nothing.
        // NOT a protocol violation: the call is well-formed, it just cannot
        // help. See `discoveryCallsSinceExactRead`.
        if (discoveryCallsSinceExactRead >= MAX_CONSECUTIVE_DISCOVERY_CALLS_V1) {
          result = errorResult(
            call.callId,
            call.name,
            "discoveryBudgetExceeded",
            discoveryBudgetReasonV1(call.name)
          );
        } else {
          discoveryCallsSinceExactRead += 1;
          result =
            call.name === "ensemble_findFiles"
              ? await handleFindFiles(call.callId, call.input)
              : await handleTextSearch(call.callId, call.input);
          if (result.ok) {
            rememberDiscoveryPaths((result.matches ?? []).map((match) => match.relativePath));
          }
        }
      } else {
        result = await handleExactPath(call.name as ReadToolNameV1, call.callId, call.input);
        // Any successful exact-path observation clears the gate — that read is
        // the thing a plan can actually be built on.
        if (result.ok) {
          discoveryCallsSinceExactRead = 0;
          exactPathObservations += 1;
        }
      }
      return canonicalJsonStringifyV1(result as unknown as Record<string, unknown>);
    },
    violationCount: () => violations.count(),
    exactPathObservationCount: () => exactPathObservations,
  };
}
