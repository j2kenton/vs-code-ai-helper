/**
 * bugs3 Step 5/7: one notion of "deferred plan work" for every gate that
 * decides whether work remains (plan-review blockers, the "review text says
 * steps are still to be built" check, the checklist-behind check, escalation
 * recommendations and Publish).
 *
 * Plan items fall into four dispositions:
 *  - `settled`  — ticked or excluded.
 *  - `deferred` — the owner's task description, or the plan itself, says the
 *                 step waits for a later owner approval / is not built in this
 *                 task. Shown as deferred, never counted as open work.
 *  - `gated`    — authorized work whose dependent step waits on an OPEN owner
 *                 gate the plan names. Not buildable yet; carried, not open.
 *  - `open`     — authorized unfinished work.
 *
 * Only the task description and the plan can defer work. Review prose never
 * does: a reviewer saying "intentionally unbuilt" is evidence about the plan,
 * not authority to shrink it. A step reference that cannot be resolved to a
 * checklist owner exactly (ambiguous numbering, reversed range) defers nothing
 * and is reported as unresolved.
 *
 * Pure: no vscode, no fs.
 */
import { listPlanItemStepOwnersV1, listStepNumbersNamedInTextV1 } from "./implementationChecklist";

export type PlanItemDispositionV1 = "settled" | "open" | "deferred" | "gated";

export interface ClassifiedPlanItemV1 {
  readonly itemId: string;
  readonly itemText: string;
  readonly stepNumber: number | undefined;
  readonly disposition: PlanItemDispositionV1;
  /** Why a deferred or gated item is not open (the sentence that said so). */
  readonly reason?: string;
  readonly source?: "task.md" | "plan";
}

/** An owner gate the plan marks OPEN, with the steps that wait on it. */
export interface CarriedGateV1 {
  readonly description: string;
  readonly dependentSteps: readonly number[];
  /**
   * Set when the "gate" is evidence about a resource the plan itself will
   * create (it cannot exist until that step runs), not a gate the plan marks
   * open. The dependent step is the one that creates the resource.
   */
  readonly createdResource?: string;
}

export interface DeferredPlanScopeV1 {
  readonly items: readonly ClassifiedPlanItemV1[];
  readonly counts: { readonly open: number; readonly deferred: number; readonly gated: number; readonly settled: number };
  readonly carriedGates: readonly CarriedGateV1[];
  /** Step references a deferral or gate named that could not be resolved exactly. */
  readonly unresolvedReferences: readonly string[];
}

/**
 * A sentence that scopes steps out of this task / behind a later approval.
 * Deliberately narrow; "later" alone is not a deferral.
 */
const DEFERRAL_CUE_RE =
  /\b(?:do(?:es)? not build|don't build|must not (?:be )?built|not to be built|intentionally unbuilt|(?:is|are) deferred|deferred (?:to|until)|out of scope|not part of this task|wait(?:s)? for (?:the )?owner(?:'s)?\s+(?:approval|decision)|wait(?:s)? for owner approval|pending owner approval|until the owner approves)\b/i;
/** A negated cue ("do not defer", "nothing is deferred") never defers. */
const NEGATED_DEFERRAL_RE = /\b(?:do(?:es)? not defer|never defer|nothing (?:is )?deferred|no (?:steps? (?:is|are) )?deferred)\b/i;
const GATE_OPEN_RE = /\bgate\b[^.\n]*\bopen\b|\bopen\b[^.\n]*\bgate\b/i;
const GATE_DEPENDENT_RE = /\b(?:wait(?:s)? on|depend(?:s|ent)? on|blocked (?:by|on)|gated (?:by|on)|behind)\b/i;

/** The owner's own `## Task Description` section, or the whole text when it has none. */
export function taskDescriptionSectionV1(taskMd: string): string {
  const lines = taskMd.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Task Description\s*$/i.test(line.trim()));
  if (start === -1) {
    return taskMd;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function sentencesOf(text: string): string[] {
  // Split on sentence ends and newlines, never on `;` — a deferral names its
  // steps and its cue in one clause list ("Steps 3–12 wait …; do not build them").
  return text
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z`*(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

interface StepClaimV1 {
  readonly sentence: string;
  readonly steps: readonly number[];
  readonly unreadable: readonly string[];
}

function stepClaims(text: string, accept: (sentence: string) => boolean): StepClaimV1[] {
  const claims: StepClaimV1[] = [];
  for (const sentence of sentencesOf(text)) {
    if (!accept(sentence)) {
      continue;
    }
    const named = listStepNumbersNamedInTextV1(sentence);
    if (named.steps.length > 0 || named.unreadable.length > 0) {
      claims.push({ sentence, steps: named.steps, unreadable: named.unreadable });
    }
  }
  return claims;
}

const isDeferralSentence = (sentence: string): boolean =>
  DEFERRAL_CUE_RE.test(sentence) && !NEGATED_DEFERRAL_RE.test(sentence);
const isGateSentence = (sentence: string): boolean =>
  GATE_OPEN_RE.test(sentence) && GATE_DEPENDENT_RE.test(sentence);

/** Gates a plan marks OPEN together with the steps that wait on them. */
export function extractCarriedGatesV1(planText: string): readonly CarriedGateV1[] {
  return stepClaims(planText, isGateSentence)
    .filter((claim) => claim.steps.length > 0)
    .map((claim) => ({ description: claim.sentence, dependentSteps: claim.steps }));
}

/**
 * Classify every top-level checklist item of `planText` against the owner's
 * task description and the plan's own deferrals and open gates.
 */
export function classifyDeferredPlanScopeV1(input: {
  readonly planText: string;
  readonly taskMd: string;
}): DeferredPlanScopeV1 {
  const owners = listPlanItemStepOwnersV1(input.planText);
  const knownSteps = new Set<number>();
  for (const owner of owners) {
    if (owner.stepNumber !== undefined) {
      knownSteps.add(owner.stepNumber);
    }
  }
  const unresolved: string[] = [];
  const deferredBy = new Map<number, { reason: string; source: "task.md" | "plan" }>();
  const noteClaim = (claim: StepClaimV1, source: "task.md" | "plan", into: Map<number, { reason: string; source: "task.md" | "plan" }>): void => {
    for (const bad of claim.unreadable) {
      unresolved.push(bad);
    }
    for (const step of claim.steps) {
      if (!knownSteps.has(step)) {
        unresolved.push(`Step ${step}`);
        continue;
      }
      if (!into.has(step)) {
        into.set(step, { reason: claim.sentence, source });
      }
    }
  };
  for (const claim of stepClaims(taskDescriptionSectionV1(input.taskMd), isDeferralSentence)) {
    noteClaim(claim, "task.md", deferredBy);
  }
  for (const claim of stepClaims(input.planText, isDeferralSentence)) {
    noteClaim(claim, "plan", deferredBy);
  }
  const gates = extractCarriedGatesV1(input.planText);
  const gatedBy = new Map<number, string>();
  for (const gate of gates) {
    for (const step of gate.dependentSteps) {
      if (knownSteps.has(step) && !gatedBy.has(step)) {
        gatedBy.set(step, gate.description);
      } else if (!knownSteps.has(step)) {
        unresolved.push(`Step ${step}`);
      }
    }
  }

  const items: ClassifiedPlanItemV1[] = owners.map((owner) => {
    const base = { itemId: owner.itemId, itemText: owner.itemText, stepNumber: owner.stepNumber };
    if (owner.settled) {
      return { ...base, disposition: "settled" };
    }
    const deferral = owner.stepNumber === undefined ? undefined : deferredBy.get(owner.stepNumber);
    if (deferral) {
      return { ...base, disposition: "deferred", reason: deferral.reason, source: deferral.source };
    }
    const gateReason = owner.stepNumber === undefined ? undefined : gatedBy.get(owner.stepNumber);
    if (gateReason !== undefined) {
      return { ...base, disposition: "gated", reason: gateReason, source: "plan" };
    }
    return { ...base, disposition: "open" };
  });
  const count = (disposition: PlanItemDispositionV1): number =>
    items.filter((item) => item.disposition === disposition).length;
  return {
    items,
    counts: { open: count("open"), deferred: count("deferred"), gated: count("gated"), settled: count("settled") },
    carriedGates: gates,
    unresolvedReferences: [...new Set(unresolved)],
  };
}

const STOP_TOKENS_V1 = new Set([
  "needed", "owner", "evidence", "before", "recorded", "current", "actual", "status", "other", "which", "their",
  "about", "should", "would", "could", "there", "these", "those", "where", "while", "after",
]);

function distinctiveTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? []).filter((token) => !STOP_TOKENS_V1.has(token))
  );
}

/** Wording that says the plan cannot be written without the evidence. */
const NEEDED_TO_WRITE_PLAN_RE =
  /\b(?:needed|required|necessary) (?:to|before) (?:write|formulate|draft|finish|complete)(?: the)? plan\b|\bplan cannot be (?:written|completed)\b/i;

const CREATING_ITEM_RE =
  /^(?:\*\*)?(?:step\s+\d+\s*[:.\-—]\s*)?(?:create|provision|set up|establish|open|register|stand up|generate|issue)\s+(?:the |a |an )?([^.,;:—\n]+)/i;
const PLAN_HEADING_STEP_RE = /^#{2,4}\s+(?:step\s+)?(\d+)\b/i;

/**
 * The resource an UNFINISHED plan item will create when the owner-evidence
 * blocker asks for evidence about it ("root/MFA recovery for the backup
 * account" when an open item says "Create the backup account"). Such evidence
 * cannot exist before the plan is carried out. Conservative: every distinctive
 * word of the created resource must appear in the blocker, and a one-word
 * resource must be specific (8+ letters). A built (ticked) item never counts —
 * its resource already exists.
 */
export function findPlanCreatedResourceV1(
  blockerText: string,
  planText: string
): { readonly resource: string; readonly stepNumber: number | undefined } | undefined {
  const blockerTokens = distinctiveTokens(blockerText);
  let stepNumber: number | undefined;
  for (const rawLine of planText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = PLAN_HEADING_STEP_RE.exec(line);
    if (heading) {
      stepNumber = Number(heading[1]);
      continue;
    }
    const item = /^[-*]\s+\[ \]\s+(.*)$/.exec(line);
    if (!item) {
      continue;
    }
    const created = CREATING_ITEM_RE.exec(item[1]!.trim());
    const resource = created?.[1]?.trim();
    if (!resource) {
      continue;
    }
    const tokens = [...distinctiveTokens(resource)];
    const specificEnough = tokens.length >= 2 || (tokens.length === 1 && tokens[0]!.length >= 8);
    if (specificEnough && tokens.every((token) => blockerTokens.has(token))) {
      return { resource, stepNumber };
    }
  }
  return undefined;
}

export type OwnerEvidenceDispositionV1 =
  | { readonly kind: "carried"; readonly gate: CarriedGateV1 }
  | { readonly kind: "current"; readonly reason: string };

/**
 * Is an owner-evidence blocker one the plan already defers to named later
 * steps (a carried gate, not a hold on this stage), or evidence this stage
 * itself needs? Conservative: anything not clearly matching a carried gate is
 * `current`.
 */
export function classifyOwnerEvidenceBlockerV1(
  blockerText: string,
  scope: Pick<DeferredPlanScopeV1, "carriedGates"> & { readonly planText?: string }
): OwnerEvidenceDispositionV1 {
  if (NEEDED_TO_WRITE_PLAN_RE.test(blockerText)) {
    return { kind: "current", reason: "the blocker says the plan cannot be completed without this evidence" };
  }
  const named = listStepNumbersNamedInTextV1(blockerText).steps;
  const blockerTokens = distinctiveTokens(blockerText);
  for (const gate of scope.carriedGates) {
    if (named.length > 0) {
      // Explicit step references decide: wording overlap must never carry
      // evidence the blocker itself ties to a step this gate does not gate.
      if (named.every((step) => gate.dependentSteps.includes(step))) {
        return { kind: "carried", gate };
      }
      continue;
    }
    const gateTokens = distinctiveTokens(gate.description);
    let shared = 0;
    for (const token of blockerTokens) {
      if (gateTokens.has(token)) {
        shared++;
      }
    }
    if (shared >= 3) {
      return { kind: "carried", gate };
    }
  }
  // Evidence about a resource a still-open plan step will create cannot exist
  // yet: carry it to that step instead of asking the owner to gather it.
  const created = scope.planText !== undefined ? findPlanCreatedResourceV1(blockerText, scope.planText) : undefined;
  if (created) {
    return {
      kind: "carried",
      gate: {
        description: `Evidence about the ${created.resource}, which the plan itself creates`,
        dependentSteps: created.stepNumber !== undefined ? [created.stepNumber] : [],
        createdResource: created.resource,
      },
    };
  }
  return { kind: "current", reason: "no gate the plan marks open and defers to later steps matches this evidence" };
}

export interface CarriedEvidenceSummaryV1 {
  /** True when at least one blocker exists and every blocker is owner evidence a plan gate carries. */
  readonly allCarried: boolean;
  /** The distinct gates the blockers map to, with the steps that wait on them. */
  readonly gates: readonly CarriedGateV1[];
}

/**
 * Do ALL of a review's blockers ask only for owner evidence that the plan
 * already defers to named later steps? Then the stage is not held by them:
 * they are recorded as carried gates the dependent steps must clear. Any other
 * blocker, or evidence the plan needs to be written at all, makes this false.
 */
export function summarizeCarriedEvidenceV1(
  blockers: readonly { readonly description: string }[],
  scope: Pick<DeferredPlanScopeV1, "carriedGates"> & { readonly planText?: string },
  isOwnerEvidence: (description: string) => boolean
): CarriedEvidenceSummaryV1 {
  if (blockers.length === 0) {
    return { allCarried: false, gates: [] };
  }
  const gates = new Map<string, CarriedGateV1>();
  for (const blocker of blockers) {
    if (!isOwnerEvidence(blocker.description)) {
      return { allCarried: false, gates: [] };
    }
    const disposition = classifyOwnerEvidenceBlockerV1(blocker.description, scope);
    if (disposition.kind !== "carried") {
      return { allCarried: false, gates: [] };
    }
    gates.set(disposition.gate.description, disposition.gate);
  }
  return { allCarried: true, gates: [...gates.values()] };
}

/**
 * Split a review's blockers into owner-evidence blockers the plan carries to
 * named later steps and everything else. Unlike `summarizeCarriedEvidenceV1`
 * this works blocker by blocker, so a mixed review still hands the routing
 * step the carried ones to set aside without hiding the rest.
 */
export function partitionCarriedEvidenceBlockersV1<T extends { readonly description: string }>(
  blockers: readonly T[],
  scope: Pick<DeferredPlanScopeV1, "carriedGates"> & { readonly planText?: string },
  isOwnerEvidence: (description: string) => boolean
): { readonly carried: readonly T[]; readonly remaining: readonly T[] } {
  const carried: T[] = [];
  const remaining: T[] = [];
  for (const blocker of blockers) {
    if (
      isOwnerEvidence(blocker.description) &&
      classifyOwnerEvidenceBlockerV1(blocker.description, scope).kind === "carried"
    ) {
      carried.push(blocker);
    } else {
      remaining.push(blocker);
    }
  }
  return { carried, remaining };
}

/**
 * At Publish: the carried gates the task's deliverable does not depend on.
 * A gate counts only while every item of every step that waits on it is still
 * deferred or gated; once any dependent step has been built (settled) or is
 * authorized open work, the deliverable needs the evidence and the gate stays
 * a real hold. Reported to the owner, never a failed check.
 */
export function gatesOutsideDeliverableV1(
  scope: Pick<DeferredPlanScopeV1, "items" | "carriedGates">
): readonly CarriedGateV1[] {
  return scope.carriedGates.filter((gate) =>
    gate.dependentSteps.every((step) => {
      const items = scope.items.filter((item) => item.stepNumber === step);
      return items.length > 0 && items.every((item) => item.disposition === "deferred" || item.disposition === "gated");
    })
  );
}

/**
 * Step numbers whose unfinished work the task description or the plan defers
 * or gates behind an open owner gate. A review sentence that names only these
 * steps as "still to be built" is describing deferred scope, not a
 * contradiction in the review.
 */
export function deferredOrGatedStepNumbersV1(scope: Pick<DeferredPlanScopeV1, "items">): ReadonlySet<number> {
  const steps = new Set<number>();
  for (const item of scope.items) {
    if ((item.disposition === "deferred" || item.disposition === "gated") && item.stepNumber !== undefined) {
      steps.add(item.stepNumber);
    }
  }
  return steps;
}

/**
 * A review's `complete/total` progress with the plan's deferred open items
 * counted as settled-for-the-gate, so deferred work never holds a stage.
 * Never exceeds `total`; `null` stays `null`.
 */
export function settleDeferredInProgressV1(
  progress: { readonly complete: number; readonly total: number } | null,
  deferredOpen: number
): { complete: number; total: number } | null {
  if (progress === null) {
    return null;
  }
  const settled = Math.min(progress.total, progress.complete + Math.max(0, deferredOpen));
  return { complete: settled, total: progress.total };
}

/**
 * One display line saying how many of the plan's unfinished items are
 * deferred or waiting on an owner gate (and so are not open work), or ""
 * when there are none. Used by the Tasks tree so the raw checklist count is
 * never the only account of what remains.
 */
export function describeDeferredChecklistCountsV1(
  counts: Pick<DeferredPlanScopeV1["counts"], "deferred" | "gated">
): string {
  const parts: string[] = [];
  if (counts.deferred > 0) {
    parts.push(`${counts.deferred} deferred by the task or plan`);
  }
  if (counts.gated > 0) {
    parts.push(`${counts.gated} waiting on a carried owner gate`);
  }
  return parts.length === 0
    ? ""
    : `${parts.join(" and ")} — shown separately from open work; neither holds a stage or calls for Back to Implementation.`;
}

/**
 * Chat note for owner-evidence blockers a review raised that the plan carries
 * forward instead of holding the stage on. At Publish it says the gate is
 * reported, not a failed check; elsewhere that the dependent steps stay gated.
 * Never claims the evidence exists.
 */
export function describeCarriedGateReportV1(
  blockers: readonly { readonly description: string }[],
  stageName: string,
  atPublish: boolean
): string {
  if (blockers.length === 0) {
    return "";
  }
  const bullets = blockers.slice(0, 5).map((b) => `- ${b.description.replace(/\s+/g, " ").trim().slice(0, 240)}`);
  const more = blockers.length > bullets.length ? [`- …and ${blockers.length - bullets.length} more`] : [];
  const lead = atPublish
    ? `_${stageName} did not hold on ${blockers.length === 1 ? "an owner gate" : `${blockers.length} owner gates`} that this task's ` +
      "deliverable does not depend on. They are reported here, not counted as a failed check:_"
    : `_${stageName} carries ${blockers.length === 1 ? "an owner gate" : `${blockers.length} owner gates`} forward. The evidence ` +
      "has not been recorded; the steps that depend on it stay gated until it is:_";
  return [lead, "", ...bullets, ...more].join("\n");
}

export interface ScopedItemListV1 {
  readonly items: string[];
  readonly total: number;
}

export interface ScopedOpenItemsV1 {
  readonly open: ScopedItemListV1;
  readonly deferred: ScopedItemListV1;
  readonly gated: ScopedItemListV1;
}

/** Unfinished items split by disposition, each list capped at `maxItems` and `maxItemChars`. */
export function splitUnfinishedItemsByScopeV1(
  scope: Pick<DeferredPlanScopeV1, "items">,
  options: { readonly maxItems: number; readonly maxItemChars: number }
): ScopedOpenItemsV1 {
  const pick = (disposition: PlanItemDispositionV1): ScopedItemListV1 => {
    const all = scope.items.filter((item) => item.disposition === disposition);
    return {
      items: all
        .slice(0, options.maxItems)
        .map((item) =>
          item.itemText.length > options.maxItemChars ? item.itemText.slice(0, options.maxItemChars - 1) + "…" : item.itemText
        ),
      total: all.length,
    };
  };
  return { open: pick("open"), deferred: pick("deferred"), gated: pick("gated") };
}
