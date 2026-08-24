/**
 * Detect a literal textual disagreement between `plan.md` and
 * `plan-final.md` about the SAME named requirement — part of the churn
 * escalation diagnosis (Part 10 of the actionable-hand-offs plan). Evidence-
 * backed only, never inferred: this fires exclusively when a blocker's own
 * description quotes a span of text (backtick- or double-quoted, at least 8
 * characters) that is ALSO, verbatim, a checklist item line
 * (`- [ ]`/`- [x]`) in one of the two artifacts and is textually absent from
 * the other artifact's checklist entirely. A requirement whose wording
 * merely differs slightly between the two files (not an exact match) reports
 * no disagreement — a near-miss is not evidence, per the plan's "never
 * inferred" rule.
 */
export function detectPlanArtifactDisagreementV1(
  blockerDescription: string,
  planMd: string,
  planFinalMd: string
): string | undefined {
  const planItems = extractChecklistItemTextsV1(planMd);
  const planFinalItems = extractChecklistItemTextsV1(planFinalMd);
  for (const quoted of extractQuotedSpansV1(blockerDescription)) {
    const inPlan = planItems.has(quoted);
    const inPlanFinal = planFinalItems.has(quoted);
    if (inPlan !== inPlanFinal) {
      const presentIn = inPlan ? "plan.md" : "plan-final.md";
      const absentFrom = inPlan ? "plan-final.md" : "plan.md";
      return (
        `The blocked requirement ("${quoted}") is a checklist item in ${presentIn} but is not present ` +
        `in ${absentFrom} — the two plan artifacts disagree on this requirement, which is a distinct ` +
        "cause from either churn or a bad spec."
      );
    }
  }
  return undefined;
}

const CHECKLIST_ITEM_RE = /^\s*-\s*\[[ xX]\]\s*(.+?)\s*$/;

/** Strips one matching pair of surrounding backticks or double quotes, so a
 * checklist item written as `` - [ ] `do the thing` `` is comparable against
 * a blocker's quoted span "do the thing" (extractQuotedSpansV1 always yields
 * the inner text, never the delimiters). Leaves the text alone when it is
 * not wrapped in a single matching pair. */
function stripSurroundingQuoteV1(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "`" && last === "`") || (first === '"' && last === '"')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function extractChecklistItemTextsV1(content: string): Set<string> {
  const items = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = CHECKLIST_ITEM_RE.exec(line);
    if (match?.[1]) {
      items.add(match[1]);
      items.add(stripSurroundingQuoteV1(match[1]));
    }
  }
  return items;
}

function extractQuotedSpansV1(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(/`([^`]{8,})`/g)) {
    if (match[1]) {
      spans.push(match[1].trim());
    }
  }
  for (const match of text.matchAll(/"([^"]{8,})"/g)) {
    if (match[1]) {
      spans.push(match[1].trim());
    }
  }
  return spans;
}
