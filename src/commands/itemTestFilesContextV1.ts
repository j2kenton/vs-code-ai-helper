import * as fs from "fs";
import * as path from "path";

import type { ItemTestFilesContextV1 } from "../utils/itemTestFilesV1";

/**
 * bugs7 item 1 (Step 2): the host-side facts `resolveItemTestFilesV1` needs: the workspace's known test files, and
 * the test files the rounds that built or claimed an item added or changed (read from those rounds' run records).
 * No `vscode` import, so tests can run it against a temp folder. A source that cannot be read is empty.
 */

export const KNOWN_TEST_FILES_CAP_V1 = 5000;
const SKIPPED_DIRS_V1 = new Set(["node_modules", "out", "dist", ".git", ".scratch", ".ensemble", ".vscode-test", "coverage"]);
const TEST_FILE_RE_V1 = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i;
const RUN_RECORD_HEAD_BYTES_V1 = 16 * 1024;

/** A scan is shared for a few seconds: one round settles many items, each of which asks for the same list. */
const SCAN_CACHE_TTL_MS_V1 = 3000;
const scanCacheV1 = new Map<string, { readonly at: number; readonly result: { readonly files: readonly string[]; readonly capped: boolean } }>();

/** The workspace's test files (workspace-relative, forward slashes), bounded; `capped` when the bound was hit. */
export async function scanKnownTestFilesV1(
  workspaceRoot: string,
  cap = KNOWN_TEST_FILES_CAP_V1
): Promise<{ readonly files: readonly string[]; readonly capped: boolean }> {
  const cacheKey = `${workspaceRoot}|${cap}`;
  const cached = scanCacheV1.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_TTL_MS_V1) return cached.result;
  const result = await scanKnownTestFilesUncachedV1(workspaceRoot, cap);
  scanCacheV1.set(cacheKey, { at: Date.now(), result });
  if (scanCacheV1.size > 20) {
    const oldest = scanCacheV1.keys().next().value;
    if (oldest !== undefined) scanCacheV1.delete(oldest);
  }
  return result;
}

async function scanKnownTestFilesUncachedV1(
  workspaceRoot: string,
  cap: number
): Promise<{ readonly files: readonly string[]; readonly capped: boolean }> {
  const files: string[] = [];
  let capped = false;
  const walk = async (dir: string): Promise<void> => {
    if (capped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped) return;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS_V1.has(entry.name)) await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && TEST_FILE_RE_V1.test(entry.name)) {
        if (files.length >= cap) {
          capped = true;
          return;
        }
        files.push(path.relative(workspaceRoot, path.join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  };
  await walk(workspaceRoot);
  return { files, capped };
}

/** The round ids and changed files one run record (`runs/NNN-*.md`) states in its header. */
export function parseRunRecordRoundFilesV1(text: string): { readonly roundIds: readonly string[]; readonly files: readonly string[] } {
  const roundIds = [...text.matchAll(/^(?:Prompt )?Round ID:\s*([\w-]+)\s*$/gim)].map((m) => (m[1] ?? "").toLowerCase());
  const files: string[] = [];
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => /^(?:#+\s*)?Files (?:changed|Changed)\s*:?\s*$/.test(line.trim()));
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i++) {
      const bullet = /^\s*[-*]\s+`?([^`\s]+)`?/.exec(lines[i] ?? "");
      if (!bullet) {
        if ((lines[i] ?? "").trim() === "" && i === at + 1) continue;
        break;
      }
      files.push((bullet[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return { roundIds, files };
}

/** The test files changed by the rounds with these ids (their run records under `<task folder>/runs/`). */
export async function readRoundChangedTestFilesV1(taskFolderPath: string, roundIds: readonly string[]): Promise<string[]> {
  const wanted = new Set(roundIds.map((id) => id.toLowerCase()));
  if (wanted.size === 0) return [];
  const runsDir = path.join(taskFolderPath, "runs");
  let names: string[];
  try {
    names = (await fs.promises.readdir(runsDir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const name of names) {
    let head: string;
    try {
      const handle = await fs.promises.open(path.join(runsDir, name), "r");
      try {
        const buffer = Buffer.alloc(RUN_RECORD_HEAD_BYTES_V1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    const parsed = parseRunRecordRoundFilesV1(head);
    if (!parsed.roundIds.some((id) => wanted.has(id))) continue;
    for (const file of parsed.files) if (TEST_FILE_RE_V1.test(file)) out.add(file);
  }
  return [...out];
}

/** The round ids on one plan item's evidence row (claims, verifications, test reports). */
export function roundIdsOfEvidenceRowV1(row: {
  readonly claims?: readonly { readonly roundId?: string }[];
  readonly verifications?: readonly { readonly roundId?: string }[];
  readonly testReports?: readonly { readonly roundId?: string }[];
} | undefined): string[] {
  if (!row) return [];
  const ids = [
    ...(row.claims ?? []).map((c) => c.roundId),
    ...(row.verifications ?? []).map((v) => v.roundId),
    ...(row.testReports ?? []).map((r) => r.roundId),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
}

/** One round ledger row's ids: a run record may print any of them as its round id. */
export interface RoundLedgerIdsV1 {
  readonly roundId: string;
  readonly intentId?: string;
  readonly operationId?: string;
  readonly attemptIds?: readonly string[];
}

/** The ids a round goes by, expanded through the round ledger (a record may name the operation, not the ledger row). */
export function expandRoundIdsThroughLedgerV1(roundIds: readonly string[], ledger: readonly RoundLedgerIdsV1[] | undefined): string[] {
  const wanted = new Set(roundIds.filter((id) => id !== "").map((id) => id.toLowerCase()));
  for (const row of ledger ?? []) {
    const aliases = [row.roundId, row.intentId, row.operationId, ...(row.attemptIds ?? [])].filter(
      (id): id is string => typeof id === "string" && id !== ""
    );
    if (aliases.some((id) => wanted.has(id.toLowerCase()))) for (const id of aliases) wanted.add(id.toLowerCase());
  }
  return [...wanted];
}

/**
 * Builds the context for one item (or, with no row, for the changed files the caller already knows). With
 * `planItemEvidence` it also carries each item's own historical round files, so a caller that settles many items with
 * one context still resolves each from the rounds that built or claimed THAT item (a building round stays in the set
 * when a later round re-claims the item without touching its tests).
 */
export async function buildItemTestFilesContextV1(input: {
  readonly workspaceRoot: string;
  readonly taskFolderPath?: string;
  readonly evidenceRow?: Parameters<typeof roundIdsOfEvidenceRowV1>[0];
  /** Every item's evidence row (`TaskProgress.planItemEvidence`): fills `roundChangedTestFilesByItemKey`. */
  readonly planItemEvidence?: ReadonlyArray<{ readonly itemKey: string } & NonNullable<Parameters<typeof roundIdsOfEvidenceRowV1>[0]>>;
  readonly roundLedger?: readonly RoundLedgerIdsV1[];
  /** Files the current round changed (for example from its summary), workspace-relative. */
  readonly changedFiles?: readonly string[];
  /** A scan to reuse across items. */
  readonly known?: { readonly files: readonly string[]; readonly capped: boolean };
}): Promise<ItemTestFilesContextV1> {
  const known = input.known ?? (await scanKnownTestFilesV1(input.workspaceRoot).catch(() => ({ files: [] as string[], capped: false })));
  const knownSet = new Set(known.files.map((f) => f.toLowerCase()));
  const onlyKnown = (files: readonly string[]): string[] => [...new Set(files)].filter((f) => knownSet.has(f.toLowerCase()));
  const filesForRows = async (row: Parameters<typeof roundIdsOfEvidenceRowV1>[0]): Promise<string[]> =>
    input.taskFolderPath !== undefined
      ? await readRoundChangedTestFilesV1(input.taskFolderPath, expandRoundIdsThroughLedgerV1(roundIdsOfEvidenceRowV1(row), input.roundLedger)).catch(
          () => [] as string[]
        )
      : [];
  const fromRounds = await filesForRows(input.evidenceRow);
  const byItem: Record<string, string[]> = {};
  for (const row of input.planItemEvidence ?? []) {
    const files = onlyKnown(await filesForRows(row));
    if (files.length === 0) continue;
    byItem[row.itemKey] = [...new Set([...(byItem[row.itemKey] ?? []), ...files])];
  }
  const changed = onlyKnown([...fromRounds, ...(input.changedFiles ?? []).map((f) => f.replace(/\\/g, "/"))]);
  return {
    knownTestFiles: known.files,
    roundChangedTestFiles: changed,
    knownFilesCapped: known.capped,
    ...(Object.keys(byItem).length > 0 ? { roundChangedTestFilesByItemKey: byItem } : {}),
  };
}
