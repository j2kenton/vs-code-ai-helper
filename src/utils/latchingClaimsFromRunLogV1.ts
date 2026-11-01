/**
 * bugs4 Step 15 (items 14-15): recover the claims that set the unreliable-checklist latch
 * from the round's own run log, for the reconcile card to use when the triggering
 * round summary is no longer in scope (the latched-task repost, or the manual
 * "Mark Plan Checklist Reconciled" command on a later day).
 *
 * The durable record is the run log's `## Checklist merge diagnostics` section
 * (`buildChecklistMergeDiagnosticsNoteV1`). It lists every unmatched claim plus a total,
 * so a truncated list (written by an older build, which logged only two) is told apart
 * from a complete one and is NEVER trusted: judging "everything was already ticked" from
 * a partial list would clear a latch that a hidden claim still justifies.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_LATCHING_CLAIMS_V1 } from "../types/taskProgress";
import type { MergeChecklistProgressResultV1 } from "./implementationChecklist";

const SECTION_HEADING_V1 = "## Checklist merge diagnostics";
/** How many of the newest run logs are searched; the latching round is the most recent no-match. */
const MAX_RUN_LOGS_SEARCHED_V1 = 12;

/** Parse `"a", "b"` (as written by the diagnostics note) into its claim texts. */
function parseQuotedClaimListV1(list: string): string[] {
  const claims: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*?)"(?:, |$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(list)) !== null) {
    claims.push(match[1]!);
  }
  return claims;
}

/**
 * Pure: the latching claims in one run log's merge diagnostics, or `undefined` when the
 * log is not a `no-match` round or its claim list is not provably complete.
 */
export function parseLatchingClaimsFromRunLogV1(logText: string): Extract<MergeChecklistProgressResultV1, { kind: "no-match" }> | undefined {
  const at = logText.lastIndexOf(SECTION_HEADING_V1);
  if (at < 0) {
    return undefined;
  }
  const section = logText.slice(at);
  if (!/Merge kind: `no-match`/.test(section)) {
    return undefined;
  }
  const listed = /Unmatched claim text: (.*?)\. Unmatched claims in total: (\d+)\./s.exec(section);
  if (!listed) {
    return undefined;
  }
  const unmatchedAll = parseQuotedClaimListV1(listed[1]!);
  if (unmatchedAll.length === 0 || unmatchedAll.length !== Number(listed[2])) {
    return undefined;
  }
  const recorded = /Already recorded \([^)]*\): (.*?)\.(?: Latch|$)/s.exec(section);
  const alreadyRecorded = recorded ? parseQuotedClaimListV1(recorded[1]!) : [];
  return {
    kind: "no-match",
    unmatchedSample: unmatchedAll.slice(0, 2),
    unmatchedAll,
    ...(alreadyRecorded.length > 0 ? { alreadyRecorded } : {}),
  };
}

/**
 * The newest `no-match` round's claims from `<taskFolder>/runs/`, or `undefined` when no
 * recent log carries a complete list. Never throws: a missing or unreadable `runs/` is
 * simply "no record", and the card falls back to its existing wording.
 */
export async function loadLatchingClaimsFromRunLogV1(
  taskFolderPath: string
): Promise<Extract<MergeChecklistProgressResultV1, { kind: "no-match" }> | undefined> {
  try {
    const runsDir = path.join(taskFolderPath, "runs");
    const names = (await fs.readdir(runsDir)).filter((name) => name.endsWith(".md")).sort().reverse();
    for (const name of names.slice(0, MAX_RUN_LOGS_SEARCHED_V1)) {
      const text = await fs.readFile(path.join(runsDir, name), "utf8");
      if (!text.includes(SECTION_HEADING_V1)) {
        continue;
      }
      // The newest log WITH a diagnostics section decides: an older no-match must not
      // outvote a newer merged round that already superseded it.
      return parseLatchingClaimsFromRunLogV1(text);
    }
  } catch {
    // No record is not an error.
  }
  return undefined;
}

/**
 * bugs4 Step 15 (item 22): the claims to store on the latch record
 * (`TaskProgress.checklistProgressUnreliableClaims`) for a merge result, or `undefined`
 * when there is nothing complete to store. A list too long for the record is not
 * truncated: a partial list could make the card judge "everything was already ticked"
 * from claims that are only some of the latching ones.
 */
export function latchingClaimsForRecordV1(result: MergeChecklistProgressResultV1 | undefined): string[] | undefined {
  if (result?.kind !== "no-match" || result.unmatchedAll.length === 0 || result.unmatchedAll.length > MAX_LATCHING_CLAIMS_V1) {
    return undefined;
  }
  if (result.unmatchedAll.some((claim) => claim.length === 0 || claim.length > 4000)) {
    return undefined;
  }
  return [...result.unmatchedAll];
}

/**
 * bugs4 Step 15 (item 23): the latching claims for the reconcile card. The latch record
 * is authoritative; a latch written before the record existed falls back to the run log's
 * complete diagnostics list.
 */
export async function loadLatchingClaimsV1(
  taskFolderPath: string,
  recorded: readonly string[] | undefined
): Promise<Extract<MergeChecklistProgressResultV1, { kind: "no-match" }> | undefined> {
  if (recorded !== undefined && recorded.length > 0) {
    return { kind: "no-match", unmatchedSample: recorded.slice(0, 2), unmatchedAll: [...recorded] };
  }
  return loadLatchingClaimsFromRunLogV1(taskFolderPath);
}
