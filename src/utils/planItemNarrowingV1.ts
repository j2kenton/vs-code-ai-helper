/**
 * RC4 item 3 (trimmed): recognise a review blocker that asks the owner to
 * narrow a plan item, and collect the round's reason and evidence for it so
 * the escalation card can show both next to "Accept this narrowing" / "Keep
 * the item open".
 *
 * Pure: it reads strings and returns a record. Detection ignores the
 * blocker's resolver, so a reviewer that filed the narrowing `task-fixable`
 * still gets the card once the stage plateaus and escalates.
 */
import type { ChecklistChangeProposalV1 } from "../types/taskProgress";
import {
  listCheckedChecklistItemTextsV1,
  listOpenPlanItemRecordsV1,
  normalizeChecklistItemTextV1,
} from "./implementationChecklist";

export const NARROWING_PREFIX_V1 = "Narrowing needs an owner decision";

const NARROWING_PREFIX_RE = /^\W*narrowing needs an owner decision\s*:/i;
const NARROWING_BLOCKER_RE =
  /\bnarrow(?:ed|ing)?\b|no owner decision approves|record the owner decision|ticked though[\s\S]*not updated|unapproved reduction/i;

/** True when `description` carries the literal narrowing prefix the impl-review prompts file. */
export function hasNarrowingPrefixV1(description: string): boolean {
  return NARROWING_PREFIX_RE.test(description.trim());
}

const NO_REASON_TEXT = "The round left no reason on file.";
const NO_EVIDENCE_TEXT = "No evidence on file; the blocker text above is all the reviewer recorded.";
const EVIDENCE_CAP = 600;

export type NarrowingSourceV1 = "the round's refused checklist rewording" | "impl-summary.md" | "none";

export interface NarrowingBlockerV1 {
  itemText: string;
  itemTicked: boolean;
  blocker: string;
  reason: string;
  reasonSource: NarrowingSourceV1;
  evidence: string;
  evidenceSource: NarrowingSourceV1;
}

function norm(text: string): string {
  return normalizeChecklistItemTextV1(text).replace(/\s+/g, " ").trim();
}

function backtickedSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim()).filter((s) => s.length > 0);
}

function findItemForPrefixForm(description: string, items: readonly string[]): string | undefined {
  // The prompt asks for the item text verbatim in backticks, and the item can
  // itself contain backticks, so match the whole item text inside the
  // description first; the longest contained item wins when unique.
  const rest = norm(description.trim().replace(NARROWING_PREFIX_RE, ""));
  const contained = items.filter((item) => {
    const n = norm(item);
    return n.length > 0 && rest.includes(n);
  });
  if (contained.length > 0) {
    const longest = Math.max(...contained.map((item) => norm(item).length));
    const best = contained.filter((item) => norm(item).length === longest);
    if (best.length === 1) {
      return best[0];
    }
  }
  const span = backtickedSpans(description)[0];
  if (span === undefined) {
    return undefined;
  }
  const wanted = norm(span);
  const exact = items.filter((item) => norm(item) === wanted);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return undefined;
  }
  const prefixed = items.filter((item) => norm(item).startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function findItemForFallbackForm(description: string, items: readonly string[]): string | undefined {
  if (!NARROWING_BLOCKER_RE.test(description)) {
    return undefined;
  }
  const tokens = backtickedSpans(description);
  for (const token of tokens) {
    const hits = items.filter((item) => item.includes(token));
    if (hits.length === 1) {
      return hits[0];
    }
  }
  return undefined;
}

export function findNarrowingBlockerV1(
  blockers: readonly { description: string }[],
  planFinal: string | undefined,
  proposals: readonly ChecklistChangeProposalV1[] | undefined,
  implSummary: string | undefined,
): NarrowingBlockerV1 | undefined {
  if (planFinal === undefined || planFinal.trim() === "") {
    return undefined;
  }
  const records = listOpenPlanItemRecordsV1(planFinal);
  const items = records.map((r) => r.itemText);
  if (items.length === 0) {
    return undefined;
  }

  let itemText: string | undefined;
  let blockerText: string | undefined;
  for (const b of blockers) {
    if (NARROWING_PREFIX_RE.test(b.description.trim())) {
      const found = findItemForPrefixForm(b.description, items);
      if (found !== undefined) {
        itemText = found;
        blockerText = b.description;
        break;
      }
    }
  }
  if (itemText === undefined) {
    for (const b of blockers) {
      if (NARROWING_PREFIX_RE.test(b.description.trim())) {
        continue;
      }
      const found = findItemForFallbackForm(b.description, items);
      if (found !== undefined) {
        itemText = found;
        blockerText = b.description;
        break;
      }
    }
  }
  if (itemText === undefined || blockerText === undefined) {
    return undefined;
  }

  const checked = new Set(listCheckedChecklistItemTextsV1(planFinal).map(norm));
  const itemTicked = checked.has(norm(itemText));

  const tokens = [...backtickedSpans(itemText), ...backtickedSpans(blockerText)];
  const paragraphs = (implSummary ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && tokens.some((t) => p.includes(t)));

  let reason = NO_REASON_TEXT;
  let reasonSource: NarrowingSourceV1 = "none";
  const wanted = norm(itemText);
  const proposal = [...(proposals ?? [])]
    .reverse()
    .find((p) => p.removedItems.some((removed) => norm(removed) === wanted));
  if (proposal !== undefined && proposal.proposedItems.length > 0) {
    reason = proposal.proposedItems.join("\n");
    reasonSource = "the round's refused checklist rewording";
  } else if (paragraphs[0] !== undefined) {
    reason = paragraphs[0];
    reasonSource = "impl-summary.md";
  }

  let evidence = NO_EVIDENCE_TEXT;
  let evidenceSource: NarrowingSourceV1 = "none";
  if (paragraphs.length > 0) {
    const joined = paragraphs.join("\n\n");
    evidence = joined.length > EVIDENCE_CAP ? `${joined.slice(0, EVIDENCE_CAP - 1)}…` : joined;
    evidenceSource = "impl-summary.md";
  }

  return { itemText, itemTicked, blocker: blockerText, reason, reasonSource, evidence, evidenceSource };
}
