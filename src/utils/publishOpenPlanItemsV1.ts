/**
 * bugs4 Step 13 (item 42): Publish Checks and the Publish review list unticked plan items,
 * top-level and nested, as blockers unless they are excluded owner hand-offs.
 *
 * Pure text helpers. The section lives between its own markers in publish-review.md, so a
 * later check run replaces it (or removes it once nothing is open) without touching the
 * report around it.
 */
import type { UnsettledPlanItemV1 } from "./implementationChecklist";

export const PUBLISH_OPEN_PLAN_ITEMS_START_V1 = "<!-- publish-open-plan-items:start -->";
export const PUBLISH_OPEN_PLAN_ITEMS_END_V1 = "<!-- publish-open-plan-items:end -->";

/** Most items named in the artifact section; the rest are counted. */
const MAX_LISTED_ITEMS_V1 = 25;
const MAX_ITEM_CHARS_V1 = 240;

function clipItemV1(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_ITEM_CHARS_V1) {
    return flat;
  }
  const cut = flat.slice(0, MAX_ITEM_CHARS_V1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** One sentence for the Publish Checks notice; empty when nothing is open. */
export function describePublishOpenPlanItemsSentenceV1(items: readonly UnsettledPlanItemV1[]): string {
  if (items.length === 0) {
    return "";
  }
  const nested = items.filter((item) => item.nested).length;
  const nestedPart = nested > 0 ? ` (${nested} of them sub-items)` : "";
  return (
    `${items.length} plan item(s) are still unticked${nestedPart}; they block Publish until they are built ` +
    `or excluded as owner hand-offs. They are listed in the Publish report.`
  );
}

/** The marked markdown section, or `undefined` when nothing is open. */
export function buildPublishOpenPlanItemsSectionV1(items: readonly UnsettledPlanItemV1[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const listed = items.slice(0, MAX_LISTED_ITEMS_V1).map((item) => `- ${item.nested ? "(sub-item) " : ""}${clipItemV1(item.text)}`);
  const more = items.length - listed.length;
  return [
    PUBLISH_OPEN_PLAN_ITEMS_START_V1,
    "## Plan items still open (blocking)",
    "",
    `${items.length} item(s) in plan-final.md are unticked and not excluded. Passing checks do not settle them.`,
    "",
    ...listed,
    ...(more > 0 ? [`- …and ${more} more.`] : []),
    PUBLISH_OPEN_PLAN_ITEMS_END_V1,
  ].join("\n");
}

/**
 * Put `section` into `artifact` (replacing a previous one), or remove the previous one when
 * `section` is undefined. Returns the artifact unchanged when there is nothing to do.
 */
export function upsertPublishOpenPlanItemsSectionV1(artifact: string, section: string | undefined): string {
  const startAt = artifact.indexOf(PUBLISH_OPEN_PLAN_ITEMS_START_V1);
  const endAt = startAt >= 0 ? artifact.indexOf(PUBLISH_OPEN_PLAN_ITEMS_END_V1, startAt) : -1;
  if (startAt >= 0 && endAt >= 0) {
    const before = artifact.slice(0, startAt);
    const after = artifact.slice(endAt + PUBLISH_OPEN_PLAN_ITEMS_END_V1.length);
    if (section === undefined) {
      return `${before.trimEnd()}${after.startsWith("\n") ? after : `\n${after}`}`.replace(/\n{3,}/g, "\n\n");
    }
    return `${before}${section}${after}`;
  }
  if (section === undefined) {
    return artifact;
  }
  return `${artifact.trimEnd()}\n\n${section}\n`;
}
