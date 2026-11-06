import type { ReportContractRejectionV1 } from "../types/taskProgress";

/**
 * review1 Step 21: a round's report is rejected when it breaks the summary contract. The same violation was repeated
 * eight times in one task (wf12), and the ninth round received the same instructions as the first. Each rejection is
 * recorded by kind, and the next round's prompt carries the last one in a single sentence with the fix.
 */
export type ReportContractRejectionKindV1 = ReportContractRejectionV1["kind"];

export const MAX_REPORT_CONTRACT_REJECTIONS_V1 = 50;

/** Reads the kind off the gate's own reason text; anything the gate says that is not listed here is `other`. */
export function classifyReportContractRejectionKindV1(reason: string): ReportContractRejectionKindV1 {
  const text = reason.toLowerCase();
  if (/returned no final summary text|no final summary/.test(text)) return "no-summary";
  if (/entries are checkboxes|checkbox/.test(text) && /files changed/.test(text)) return "checkbox-files-changed";
  if (/any files under .*files changed/.test(text)) return "empty-files-changed";
  if (/any content under .*verification/.test(text)) return "empty-verification";
  if (/missing[^.]*files changed|`## files changed`/.test(text) && /missing|lacks|without|no /.test(text)) return "missing-files-changed";
  if (/`## verification`/.test(text) && /missing|lacks|without|no /.test(text)) return "missing-verification";
  if (/plan item checklist|no-checklist-change|checklist claim|did not match any item/.test(text)) return "checklist-claim";
  return "other";
}

const FIXES: Readonly<Record<ReportContractRejectionKindV1, string>> = {
  "no-summary": "end the round with the full Markdown summary as your final response, not a status message.",
  "checkbox-files-changed": "list changed files under `## Files Changed` as plain bullets (`- path — what changed`), not checkboxes.",
  "empty-files-changed": "list every file you changed under `## Files Changed`, one bullet each.",
  "empty-verification": "put the commands you ran, with their results, under `## Verification`.",
  "missing-files-changed": "include a `## Files Changed` section (write `None.` if you changed nothing).",
  "missing-verification": "include a `## Verification` section with the commands you ran and their results.",
  "checklist-claim": "quote each completed item's exact text (or its [item:<id>]) under `## Plan Item Checklist` as `<item> — done — <evidence>`; the claim list is the only source of ticks, and the no-checklist-change marker is optional.",
  other: "follow the report shape stated at the top of this prompt.",
};

/** One sentence naming the fix for a kind of rejection. */
export function describeReportContractFixV1(kind: ReportContractRejectionKindV1): string {
  return FIXES[kind];
}

/** Appends a rejection to the bounded list, oldest dropped first. */
export function appendReportContractRejectionV1(
  existing: readonly ReportContractRejectionV1[] | undefined,
  entry: { readonly at: string; readonly reason: string; readonly roundId?: string; readonly stage?: ReportContractRejectionV1["stage"] }
): ReportContractRejectionV1[] {
  const kind = classifyReportContractRejectionKindV1(entry.reason);
  const next: ReportContractRejectionV1 = {
    at: entry.at,
    kind,
    reason: entry.reason.slice(0, 500),
    ...(entry.roundId ? { roundId: entry.roundId } : {}),
    ...(entry.stage ? { stage: entry.stage } : {}),
  };
  return [...(existing ?? []), next].slice(-MAX_REPORT_CONTRACT_REJECTIONS_V1);
}

/** How many times a kind of rejection has happened in this task. */
export function countReportContractRejectionsOfKindV1(
  rejections: readonly ReportContractRejectionV1[] | undefined,
  kind: ReportContractRejectionKindV1
): number {
  return (rejections ?? []).filter((entry) => entry.kind === kind).length;
}

/**
 * The sentence the next round's prompt carries: the last rejection and the fix, with how often it has happened.
 * Empty when the task has no recorded rejection.
 */
export function formatReportContractReminderV1(rejections: readonly ReportContractRejectionV1[] | undefined): string {
  const last = rejections?.[rejections.length - 1];
  if (!last) return "";
  const times = countReportContractRejectionsOfKindV1(rejections, last.kind);
  return (
    `\n\n## Your last report was rejected\n\nThe previous round's report was rejected: ${last.reason}` +
    `${/[.!?]$/.test(last.reason) ? "" : "."} To fix it, ${describeReportContractFixV1(last.kind)}` +
    (times > 1 ? ` This has happened ${times} times in this task.` : "") +
    "\n"
  );
}

/** review1 Step 35: how many rejections of one kind make it a pattern the owner is told about. */
export const REPEATED_REJECTION_THRESHOLD_V1 = 3;

/**
 * The kind of rejection that has now happened three or more times in the task, with its count and the last reason,
 * or `undefined` when none has. When several kinds qualify the most frequent wins (the latest, on a tie).
 */
export function selectRepeatedRejectionV1(
  rejections: readonly ReportContractRejectionV1[] | undefined
): { readonly kind: ReportContractRejectionKindV1; readonly count: number; readonly lastReason: string } | undefined {
  const list = rejections ?? [];
  let best: { kind: ReportContractRejectionKindV1; count: number; lastReason: string; lastIndex: number } | undefined;
  for (const kind of new Set(list.map((entry) => entry.kind))) {
    const count = countReportContractRejectionsOfKindV1(list, kind);
    if (count < REPEATED_REJECTION_THRESHOLD_V1) continue;
    const lastIndex = list.map((entry) => entry.kind).lastIndexOf(kind);
    if (!best || count > best.count || (count === best.count && lastIndex > best.lastIndex)) {
      best = { kind, count, lastReason: list[lastIndex]!.reason, lastIndex };
    }
  }
  return best ? { kind: best.kind, count: best.count, lastReason: best.lastReason } : undefined;
}

/**
 * The round-end chat line for a pattern, used when automation is still running (no stop card to carry it). Says how
 * many times it has happened, quotes the last reason and names the way out. Empty until the third rejection of a kind.
 */
export function formatRepeatedRejectionLineV1(rejections: readonly ReportContractRejectionV1[] | undefined): string {
  const repeated = selectRepeatedRejectionV1(rejections);
  if (!repeated) return "";
  return (
    `A round's report has now been rejected for the same reason ${repeated.count} times in this task (${repeated.kind}). ` +
    `The last reason: ${repeated.lastReason.slice(0, 240)}${/[.!?]$/.test(repeated.lastReason) ? "" : "."} ` +
    "Changing this stage's model (AI Models) is the way out if it keeps happening."
  );
}
