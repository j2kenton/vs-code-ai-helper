/**
 * The shared hand-off contract (task: "Actionable Hand-offs: one contract,
 * nine surfaces").
 *
 * Every surface where the workflow hands control to the user, or takes it
 * back, was found handing over evidence without guidance: a manual-
 * verification checklist line with no priority, a stage prerequisite stated
 * only after failure, a refusal with no clearing condition, a routing
 * recommendation decided from partial state, an advertised envelope nothing
 * consumed, a chat panel showing pending state for settled work, scheduled
 * work starting unannounced, and a churn escalation that could not tell "the
 * spec is wrong" from "this is converging". Nine surfaces, one defect: the
 * system holds information the user needs to act, and stops short of saying
 * it.
 *
 * This module is the shared vocabulary every surface renders through, so the
 * fix is one contract applied in nine places rather than nine bespoke
 * wordings that drift independently. Seven fields, in a fixed order:
 *
 *   1. Action              — what to do, concrete and specific
 *   2. Reason               — why, in one sentence
 *   3. Method                — the actual steps
 *   4. Failure/clearing signal — the observable symptom of failure, or (for
 *                                a refusal/escalation) what has to happen
 *                                before it clears
 *   5. Impact                — how much it matters: HIGH (silent/damaging)
 *                                vs LOW (loud/recoverable)
 *   6. Gating                 — whether acting on this actually unblocks
 *                                task progress
 *   7. Acknowledgement         — confirmation that an answer or click
 *                                registered
 *
 * Not every surface needs every field — `getRequiredHandoffFieldsV1` (backed
 * by `HANDOFF_REQUIRED_FIELDS_V1` and, for the one surface whose
 * requirement is conditional, `HANDOFF_CONDITIONAL_FIELDS_V1`) states which
 * fields each surface must supply right now. A field a surface does not
 * require is simply never rendered for it; a field it does require but the
 * caller did not supply renders as an explicit "not recorded" statement
 * rather than being silently dropped. That statement distinguishes *why* the
 * field is absent (`HandoffAbsenceReasonV1`): "not recorded (older record)"
 * only when the caller holds positive evidence the record predates the
 * field, "not recorded — unknown" otherwise (the default) — because absence
 * of a record is never itself positive evidence of anything, including of
 * being legacy. `taskTreeProvider.ts`'s tooltip and `chatView.ts`'s decision
 * cards both render through this module for exactly this reason, and both
 * currently pass `"legacyRecord"` because `WorkflowDecisionV1`'s type has no
 * `gating` field at all yet — a provable case, not a guess.
 *
 * Fields 4 and 5 are context-sensitive, per the plan's own wording:
 *
 *   - Field 4 means "what failure looks like" for a manual-verification
 *     check, but "what clears a block and when" for a refusal, a stage
 *     prerequisite, a scheduling notice, or a churn escalation (plan.md's
 *     PART 10.6: "what clears it"), and "is anything in flight right now"
 *     for the chat panel's pending posture. `HandoffFailureSignalV1` is
 *     therefore a discriminated union of those three shapes
 *     (`failureSymptom` / `clearingSignal` / `statusSignal`), and the
 *     rendered *label* for field 4 is chosen from the value's own `kind` via
 *     `HANDOFF_FAILURE_SIGNAL_LABELS_V1` ("If it fails" / "Clears when" /
 *     "Status"), not hard-coded to one wording for every surface.
 *   - Field 5 means "priority" (HIGH/LOW plus cost of failure) for a check
 *     or a decision, but "collateral" (what is at risk or quarantined, with
 *     no HIGH/LOW level implied) for a refusal. `HandoffImpactV1` is a
 *     discriminated union of the two shapes for the same reason, so a
 *     refusal is never forced to invent a priority level it does not have.
 *
 * `HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1` / `HANDOFF_IMPACT_KIND_BY_SURFACE_V1`
 * enforce which `kind` each surface may actually use — a `clearingSignal`
 * handed to a `manualVerificationItem`, or a `priority` handed to an
 * `actionRefusal`, is treated as though the field were never supplied at all
 * (see `formatFieldValueV1`), so the wrong meaning can never render under
 * the wrong surface's label.
 */

/** The seven-field hand-off vocabulary, in the fixed rendering order. */
export type HandoffFieldKeyV1 =
  | "action"
  | "reason"
  | "method"
  | "failureSignal"
  | "impact"
  | "gating"
  | "acknowledgement";

export const HANDOFF_FIELD_ORDER_V1: readonly HandoffFieldKeyV1[] = [
  "action",
  "reason",
  "method",
  "failureSignal",
  "impact",
  "gating",
  "acknowledgement",
];

/** Static fallback labels used only when a field is entirely absent (the
 * "not recorded" case, where no payload — and therefore no `kind` — exists
 * to pick a more specific label from). Once a value *is* supplied for
 * `failureSignal` or `impact`, the label rendered comes from the value's own
 * `kind` (see `HANDOFF_FAILURE_SIGNAL_LABELS_V1` / `HANDOFF_IMPACT_LABELS_V1`
 * below), never from this table — that is what lets the same field slot mean
 * "if it fails" for a check and "clears when" for a refusal without the
 * renderer having to know which surface it is rendering for. */
export const HANDOFF_FIELD_LABELS_V1: Readonly<Record<HandoffFieldKeyV1, string>> = {
  action: "What",
  reason: "Why",
  method: "How",
  failureSignal: "Failure / clearing signal",
  impact: "Priority / collateral",
  gating: "Unblocks",
  acknowledgement: "Acknowledged",
};

export type HandoffImpactLevelV1 = "high" | "low";

/**
 * Field 5, as a discriminated union rather than one fixed shape, because the
 * plan's matrix uses this field for two unrelated meanings:
 *
 *   - `"priority"` — for a manual-verification check or a decision: HIGH
 *     when a failure here would be silent or damaging in the user's own
 *     project, LOW when it would be loud and recoverable. Derived from
 *     failure cost, never from any Ensemble-specific notion of a "write
 *     path" — a check on an unrelated domain (a Terraform module, a data
 *     pipeline) must be gradable the same way.
 *   - `"collateral"` — for a refusal: what is at risk or already
 *     quarantined while the refusal holds (e.g. "3 files are quarantined
 *     behind this continuation"). A refusal has no HIGH/LOW failure-cost
 *     level to report — the action already did not happen — so forcing it
 *     through the priority shape would require inventing a level nothing
 *     backs. This shape has none.
 *
 * The rendered label is chosen from `kind` (via
 * `HANDOFF_IMPACT_LABELS_V1`), not from which surface is rendering, so a
 * surface is never limited to only one of the two meanings by construction —
 * `checkHandoffConformanceV1` is what enforces which `kind` each surface is
 * actually allowed to use (see `HANDOFF_IMPACT_KIND_BY_SURFACE_V1`).
 */
export type HandoffImpactV1 =
  | { readonly kind: "priority"; readonly level: HandoffImpactLevelV1; readonly costOfFailure: string }
  | { readonly kind: "collateral"; readonly detail: string };

/**
 * Field 6 — two independent facts, not one, because a single boolean cannot
 * carry both (review completion blocker, "Actionable Hand-offs" PART 5
 * follow-up): whether this decision is the reason the task is CURRENTLY
 * paused, and whether resolving it is expected to move the task forward.
 * These can diverge — `providerChainExhausted`'s decision (`reviewActions.ts`,
 * deferred to PART 9) pauses the task via `pauseTaskWithReason` itself, so it
 * unquestionably `holdsTaskPaused`, yet its "wait" option does not itself
 * cause anything to resume (something else — the passage of time, a retry
 * succeeding — has to happen), so `unblocksProgress` for that option is not
 * simply "true". Collapsing the two into one field either falsely denies
 * ownership of the pause (the PART 5 defect this fixes) or falsely promises
 * that answering always unblocks.
 *
 *   - `holdsTaskPaused` — is THIS decision the one actually responsible for
 *     the task being paused right now (ownership), independent of what
 *     choosing an option does. Two outstanding decisions can look identical
 *     while only one holds the task paused; this is what lets the chat panel
 *     and tree tooltip highlight the correct one (the reconciliation
 *     decision's worked example: answered while the task stayed paused by an
 *     unrelated escalation, with nothing distinguishing the two).
 *   - `unblocksProgress` — does resolving this decision (choosing its
 *     recommended or an otherwise-progressing option) actually move the task
 *     forward, as opposed to being informational or a declared no-op.
 *
 * `detail` is required either way so a non-gating item says plainly that it
 * does not resume anything, and a gating one says what actually clears it.
 */
export interface HandoffGatingV1 {
  readonly holdsTaskPaused: boolean;
  readonly unblocksProgress: boolean;
  readonly detail: string;
}

/**
 * Field 4, as a discriminated union rather than one fixed shape, because the
 * plan's own wording gives it three different meanings depending on the
 * surface:
 *
 *   - `"failureSymptom"` — for a manual-verification check: "what failure
 *     looks like", the observable symptom that tells the user it did not
 *     pass.
 *   - `"clearingSignal"` — for a refusal, a stage prerequisite, a
 *     scheduling notice, or a churn escalation: "what clears a block and
 *     when" — `clearsAt` carries the wall-clock time where one is known
 *     (e.g. a lease expiry), and is omitted (never fabricated) where none
 *     exists yet.
 *   - `"statusSignal"` — for the chat panel's pending posture: whether
 *     anything is actually in flight right now, so a transport that reports
 *     nothing mid-flight can say that explicitly instead of implying a wait.
 *
 * As with `HandoffImpactV1`, the rendered label comes from `kind`, and
 * `checkHandoffConformanceV1` enforces which `kind` each surface may use
 * (see `HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1`) rather than the render
 * path guessing from the surface name.
 */
export type HandoffFailureSignalV1 =
  | { readonly kind: "failureSymptom"; readonly detail: string }
  | { readonly kind: "clearingSignal"; readonly detail: string; readonly clearsAt?: string }
  | { readonly kind: "statusSignal"; readonly detail: string };

/** The seven fields, all optional at the type level — a surface's required
 * subset is enforced at render time via `HANDOFF_REQUIRED_FIELDS_V1`, not by
 * the shape of this interface, because different surfaces require different
 * subsets of the same vocabulary. */
export interface HandoffGuidanceFieldsV1 {
  readonly action?: string;
  readonly reason?: string;
  readonly method?: string;
  readonly failureSignal?: HandoffFailureSignalV1;
  readonly impact?: HandoffImpactV1;
  readonly gating?: HandoffGatingV1;
  readonly acknowledgement?: string;
}

/** Every surface identified in the task as handing over evidence without
 * guidance. Adding a tenth surface later means adding one entry here and one
 * row to `HANDOFF_REQUIRED_FIELDS_V1` — the render/conformance machinery
 * below does not need to change. */
export type HandoffSurfaceV1 =
  | "manualVerificationItem"
  | "stagePrerequisite"
  | "actionRefusal"
  | "routingRecommendation"
  | "envelopeOutcome"
  | "chatPendingState"
  | "scheduledWork"
  | "decisionRecord"
  | "churnEscalation";

/** The noun used in a surface's "not recorded" fallback text, e.g. "this
 * decision predates the hand-off contract for this field". */
export const HANDOFF_SURFACE_NOUNS_V1: Readonly<Record<HandoffSurfaceV1, string>> = {
  manualVerificationItem: "checklist item",
  stagePrerequisite: "stage message",
  actionRefusal: "refusal",
  routingRecommendation: "recommendation",
  envelopeOutcome: "envelope outcome",
  chatPendingState: "chat state",
  scheduledWork: "scheduling notice",
  decisionRecord: "decision",
  churnEscalation: "escalation",
};

/** The label rendered for field 4 once a value is supplied, keyed by the
 * value's own `kind` rather than by which surface is rendering — see the
 * doc comment on `HandoffFailureSignalV1`. */
export const HANDOFF_FAILURE_SIGNAL_LABELS_V1: Readonly<Record<HandoffFailureSignalV1["kind"], string>> = {
  failureSymptom: "If it fails",
  clearingSignal: "Clears when",
  statusSignal: "Status",
};

/** The label rendered for field 5 once a value is supplied, keyed by the
 * value's own `kind` — see the doc comment on `HandoffImpactV1`. */
export const HANDOFF_IMPACT_LABELS_V1: Readonly<Record<HandoffImpactV1["kind"], string>> = {
  priority: "Priority",
  collateral: "Collateral",
};

/**
 * Which `HandoffFailureSignalV1.kind`(s) each surface may supply for field 4,
 * derived from the plan's own wording for that surface (a check's "what
 * failure looks like" vs a refusal/scheduling notice's "what clears a block
 * and when" vs the chat panel's "is anything in flight"). A surface not
 * listed here does not render field 4 at all (see
 * `HANDOFF_REQUIRED_FIELDS_V1`) and has no allowed kind.
 *
 * `checkHandoffConformanceV1` treats a supplied value whose `kind` is not in
 * this list the same as an absent value — a `clearingSignal` handed to a
 * manual-verification item is exactly the defect this fixes, so it must not
 * silently pass conformance.
 */
export const HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1: Readonly<
  Partial<Record<HandoffSurfaceV1, readonly HandoffFailureSignalV1["kind"][]>>
> = {
  manualVerificationItem: ["failureSymptom"],
  actionRefusal: ["clearingSignal"],
  stagePrerequisite: ["clearingSignal"],
  scheduledWork: ["clearingSignal"],
  churnEscalation: ["clearingSignal"],
  chatPendingState: ["statusSignal"],
  // A decision record's field 4 varies with what the decision is about (it
  // could describe a check-like failure, a refusal-like clearing condition,
  // or an in-flight status) — all three kinds are legitimate here.
  decisionRecord: ["failureSymptom", "clearingSignal", "statusSignal"],
};

/**
 * Which `HandoffImpactV1.kind`(s) each surface may supply for field 5 — a
 * check/decision's HIGH/LOW priority vs a refusal's collateral, with no
 * priority level implied. Same enforcement rule as
 * `HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1`: a mismatched kind is treated
 * as though the field were never supplied.
 */
export const HANDOFF_IMPACT_KIND_BY_SURFACE_V1: Readonly<
  Partial<Record<HandoffSurfaceV1, readonly HandoffImpactV1["kind"][]>>
> = {
  manualVerificationItem: ["priority"],
  actionRefusal: ["collateral"],
  stagePrerequisite: ["collateral"],
  decisionRecord: ["priority", "collateral"],
};


/**
 * Which of the seven fields each surface must supply *unconditionally*, in
 * the plan's own words — this is the literal per-surface conformance matrix
 * from plan.md's "Per-surface conformance matrix (PART 11 audits against
 * it)" table, transcribed field-number-for-field-number:
 *
 *   | Surface                                | Required fields        |
 *   | Manual-verification checklist items    | 1-5                     |
 *   | Decision records                       | 1-7                     |
 *   | Refusals (lease, stage prerequisites)  | 1, 2, 4, 5, 7           |
 *   | Scheduling announcements                | 2, 4, 6                 |
 *   | Stage-chat envelope outcomes            | 7 (+2 on refusal)       |
 *   | Chat pending posture                    | 4, 6                    |
 *   | Routing recommendations                 | 1, 2                    |
 *   | Churn escalations                       | 1, 2, 4                 |
 *
 * The plan's single "Refusals" row covers two surfaces here
 * (`stagePrerequisite` and `actionRefusal`) — both get the same required
 * set. "Stage-chat envelope outcomes" is the one row with a *conditional*
 * requirement ("plus 2 on refusal"); that is not expressible as a flat list,
 * so it is carried separately in `HANDOFF_CONDITIONAL_FIELDS_V1` rather than
 * folded into this table (folding it in would make every non-refused
 * envelope outcome permanently fail conformance for a field it does not, in
 * that case, need). Two matrix cells name a requirement outside the
 * seven-field vocabulary ("must see the gating state" for routing
 * recommendations; "plus an evidence-backed cause" for churn escalations) —
 * those are constraints on the *input* a recommendation is derived from, not
 * a renderable field, so they are documented here rather than invented as an
 * eighth field.
 *
 * A surface not listed here has no wired requirement yet — that is a gap for
 * whichever later part owns it, not a reason to invent one here.
 */
export const HANDOFF_REQUIRED_FIELDS_V1: Readonly<Record<HandoffSurfaceV1, readonly HandoffFieldKeyV1[]>> = {
  // Manual-verification checklist item: fields 1-5 (What / Why / How /
  // If-it-fails / Priority) — the five-field-plus-priority shape from the
  // worked example.
  manualVerificationItem: ["action", "reason", "method", "failureSignal", "impact"],
  // Refusals (continuation lease, stage prerequisites): fields 1, 2, 4, 5, 7.
  // Both refusal surfaces share the plan's single "Refusals" row.
  stagePrerequisite: ["action", "reason", "failureSignal", "impact", "acknowledgement"],
  actionRefusal: ["action", "reason", "failureSignal", "impact", "acknowledgement"],
  // A routing recommendation: fields 1, 2. The plan adds "and must see the
  // gating state" — a constraint on what state the recommendation is
  // derived from, not a rendered field; enforced by the caller supplying
  // that state as an *input* to the decision, not by this table.
  routingRecommendation: ["action", "reason"],
  // An advertised envelope's outcome line: field 7 unconditionally. Field 2
  // (reason) is required only "on refusal" — see
  // `HANDOFF_CONDITIONAL_FIELDS_V1`.
  envelopeOutcome: ["acknowledgement"],
  // The chat panel's pending state: fields 4, 6 — the observable
  // failure/clearing signal (an explicit "no status until it finishes"
  // rather than an implied wait) and whether this is gating (waiting on the
  // system) or not (waiting on the user).
  chatPendingState: ["failureSignal", "gating"],
  // Scheduled background work: fields 2, 4, 6 — why, what clears/when it
  // fires or will not retry, and whether the operator or the system owns
  // the next move.
  scheduledWork: ["reason", "failureSignal", "gating"],
  // A decision record: all seven fields — decisions get the full contract.
  decisionRecord: [...HANDOFF_FIELD_ORDER_V1],
  // A churn escalation: fields 1, 2, 4. The plan adds "plus an
  // evidence-backed cause" — the classification (unchanged / narrowing /
  // insufficient-evidence) that field 2 (reason) must be derived from, not
  // an eighth rendered field.
  churnEscalation: ["action", "reason", "failureSignal"],
};

/** Context a caller may supply describing circumstances that add to a
 * surface's unconditional required-field set (plan.md: "Stage-chat envelope
 * outcomes | 7, plus 2 on refusal"). Absent entirely, no conditional field
 * applies. */
export interface HandoffFieldContextV1 {
  /** True when the outcome being rendered is a refusal — adds "reason" (2)
   * to `envelopeOutcome`'s otherwise-unconditional "acknowledgement" (7). */
  readonly refused?: boolean;
}

const HANDOFF_CONDITIONAL_FIELDS_V1: Partial<
  Record<HandoffSurfaceV1, (context: HandoffFieldContextV1 | undefined) => readonly HandoffFieldKeyV1[]>
> = {
  envelopeOutcome: (context) => (context?.refused ? ["reason"] : []),
};

/** The fields `surface` requires right now, given `context` — the
 * unconditional set from `HANDOFF_REQUIRED_FIELDS_V1` plus whatever
 * `HANDOFF_CONDITIONAL_FIELDS_V1` adds for this context, deduplicated and
 * restored to the fixed field order. This is the function every renderer
 * and the conformance checker call instead of reading
 * `HANDOFF_REQUIRED_FIELDS_V1` directly, so a conditional requirement can
 * never be missed by a caller that only knows about the static table. */
export function getRequiredHandoffFieldsV1(
  surface: HandoffSurfaceV1,
  context?: HandoffFieldContextV1
): readonly HandoffFieldKeyV1[] {
  const base = HANDOFF_REQUIRED_FIELDS_V1[surface];
  const conditional = HANDOFF_CONDITIONAL_FIELDS_V1[surface]?.(context) ?? [];
  if (conditional.length === 0) {
    return base;
  }
  const combined = new Set<HandoffFieldKeyV1>([...base, ...conditional]);
  return HANDOFF_FIELD_ORDER_V1.filter((field) => combined.has(field));
}

/** One rendered field line, plus whether the value was actually supplied. */
export interface RenderedHandoffLineV1 {
  readonly field: HandoffFieldKeyV1;
  readonly label: string;
  readonly text: string;
  readonly recorded: boolean;
}

/**
 * Why a required field has no value, distinguished so the fallback text can
 * tell them apart rather than collapsing both into a claim of proven legacy
 * provenance (review completion blocker: "the missing-data renderer treats
 * every absent value as proven legacy provenance"):
 *
 *   - `"legacyRecord"` — the caller has *positive evidence* this specific
 *     record structurally predates the field (e.g. no code path anywhere
 *     has ever populated it yet, or a persisted schema version check). Only
 *     use this when that is actually provable, per the contract's global
 *     rule that absence of a record is never treated as positive evidence
 *     on its own — "legacy" is itself a positive claim and needs a reason to
 *     back it, not just an empty value.
 *   - `"unknown"` — the safe default. The field is simply missing and
 *     nothing here proves why; render an explicit unknown rather than
 *     guessing "legacy".
 */
export type HandoffAbsenceReasonV1 = "legacyRecord" | "unknown";

/** The label used for an entirely-absent field 4/5, chosen from whichever
 * `kind`(s) `surface` is actually allowed to supply (so a refusal's "not
 * recorded" line says "Collateral", not the generic combined label, once it
 * is known only one kind applies) — falling back to the generic label from
 * `HANDOFF_FIELD_LABELS_V1` when a surface allows more than one kind (a
 * decision record) or none at all (not expected to be reached, since a field
 * with no allowed kind is never in a surface's required set). */
function fallbackLabelForAbsentValueV1(surface: HandoffSurfaceV1, field: HandoffFieldKeyV1): string {
  if (field === "impact") {
    const kinds = HANDOFF_IMPACT_KIND_BY_SURFACE_V1[surface];
    const onlyKind = kinds && kinds.length === 1 ? kinds[0] : undefined;
    if (onlyKind) {
      return HANDOFF_IMPACT_LABELS_V1[onlyKind];
    }
    return HANDOFF_FIELD_LABELS_V1.impact;
  }
  if (field === "failureSignal") {
    const kinds = HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1[surface];
    const onlyKind = kinds && kinds.length === 1 ? kinds[0] : undefined;
    if (onlyKind) {
      return HANDOFF_FAILURE_SIGNAL_LABELS_V1[onlyKind];
    }
    return HANDOFF_FIELD_LABELS_V1.failureSignal;
  }
  return HANDOFF_FIELD_LABELS_V1[field];
}

function notRecordedLineV1(
  surface: HandoffSurfaceV1,
  field: HandoffFieldKeyV1,
  absenceReason: HandoffAbsenceReasonV1
): RenderedHandoffLineV1 {
  const label = fallbackLabelForAbsentValueV1(surface, field);
  const noun = HANDOFF_SURFACE_NOUNS_V1[surface];
  const text =
    absenceReason === "legacyRecord"
      ? `${label}: not recorded (older record) — this ${noun} predates the hand-off contract for this field.`
      : `${label}: not recorded — unknown; nothing has established this field for this ${noun} yet.`;
  return { field, label, recorded: false, text };
}

/**
 * Resolves the concrete `{ label, value }` text for one field, given the
 * surface it is rendering for — `undefined` means "treat as absent",
 * covering both "no value supplied" and, for fields 4/5, "a value was
 * supplied but its `kind` is not one this surface is allowed to render"
 * (the mismatch this fix exists to catch: e.g. a `clearingSignal` handed to
 * a `manualVerificationItem`, or a `priority` handed to an `actionRefusal`).
 * A mismatched kind is deliberately *not* distinguished from "absent" in
 * the return type — both must fail conformance and fall back to the
 * "not recorded" line identically, since rendering the wrong kind's value
 * under the wrong label is exactly the defect being fixed, not a value.
 */
function formatFieldValueV1(
  surface: HandoffSurfaceV1,
  field: HandoffFieldKeyV1,
  fields: HandoffGuidanceFieldsV1
): { readonly label: string; readonly value: string } | undefined {
  if (field === "impact") {
    const impact = fields.impact;
    if (!impact) {
      return undefined;
    }
    const allowedKinds = HANDOFF_IMPACT_KIND_BY_SURFACE_V1[surface] ?? [];
    if (!allowedKinds.includes(impact.kind)) {
      return undefined;
    }
    const label = HANDOFF_IMPACT_LABELS_V1[impact.kind];
    const value = impact.kind === "priority" ? `${impact.level.toUpperCase()} — ${impact.costOfFailure}` : impact.detail;
    return { label, value };
  }
  if (field === "failureSignal") {
    const signal = fields.failureSignal;
    if (!signal) {
      return undefined;
    }
    const allowedKinds = HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1[surface] ?? [];
    if (!allowedKinds.includes(signal.kind)) {
      return undefined;
    }
    const label = HANDOFF_FAILURE_SIGNAL_LABELS_V1[signal.kind];
    const value =
      signal.kind === "clearingSignal" && signal.clearsAt ? `${signal.detail} (clears ${signal.clearsAt})` : signal.detail;
    return { label, value };
  }
  if (field === "gating") {
    const gating = fields.gating;
    return gating ? { label: HANDOFF_FIELD_LABELS_V1.gating, value: gating.detail } : undefined;
  }
  const value = fields[field];
  return typeof value === "string" && value.length > 0 ? { label: HANDOFF_FIELD_LABELS_V1[field], value } : undefined;
}

/** Renders exactly one field for one surface, falling back to an explicit
 * "not recorded" statement rather than an empty or missing line — the rule
 * that makes absent metadata legible instead of silently invisible.
 *
 * `absenceReason` controls the wording used *only* when the field turns out
 * to be missing; it defaults to `"unknown"` (the safe default — see
 * `HandoffAbsenceReasonV1`) so a caller that does not know why a field is
 * absent never has to claim it is a proven legacy record. Pass
 * `"legacyRecord"` only when the caller holds positive evidence that this
 * specific record predates the field. */
export function renderHandoffFieldLineV1(
  surface: HandoffSurfaceV1,
  field: HandoffFieldKeyV1,
  fields: HandoffGuidanceFieldsV1 | undefined,
  absenceReason: HandoffAbsenceReasonV1 = "unknown"
): RenderedHandoffLineV1 {
  const resolved = fields ? formatFieldValueV1(surface, field, fields) : undefined;
  if (!resolved) {
    return notRecordedLineV1(surface, field, absenceReason);
  }
  return { field, label: resolved.label, recorded: true, text: `${resolved.label}: ${resolved.value}` };
}

/** Renders every field a surface currently requires (its unconditional set
 * plus whatever `context` adds — see `getRequiredHandoffFieldsV1`), in the
 * fixed field order, for `fields` (which may be entirely absent). This is
 * the one function every surface's rendering code should call: it is what
 * keeps the five(ish) elements the task asks for from drifting into nine
 * separate wordings.
 *
 * `absenceReason` defaults to `"unknown"` for the same reason it does on
 * `renderHandoffFieldLineV1` — only pass `"legacyRecord"` when the caller
 * can actually prove the record predates the missing field. */
export function renderRequiredHandoffFieldsV1(
  surface: HandoffSurfaceV1,
  fields: HandoffGuidanceFieldsV1 | undefined,
  context?: HandoffFieldContextV1,
  absenceReason: HandoffAbsenceReasonV1 = "unknown"
): RenderedHandoffLineV1[] {
  return getRequiredHandoffFieldsV1(surface, context).map((field) =>
    renderHandoffFieldLineV1(surface, field, fields, absenceReason)
  );
}

/** Result of checking whether a surface's guidance fully conforms — every
 * field it requires was actually supplied, not left to fall back. */
export interface HandoffConformanceResultV1 {
  readonly ok: boolean;
  readonly missing: readonly HandoffFieldKeyV1[];
}

/**
 * Checks whether `fields` supplies every field `surface` currently requires
 * (including any `context`-conditional fields — e.g. `envelopeOutcome` with
 * `{ refused: true }`). This is the function Part 11's conformance pass runs
 * over the Part 5 creation-site inventory: `ok: false` on a live call site
 * is a gap to fix; `ok: false` on an intentionally-legacy record is expected
 * and renders via the "not recorded (older record)" fallback rather than
 * failing anything.
 */
export function checkHandoffConformanceV1(
  surface: HandoffSurfaceV1,
  fields: HandoffGuidanceFieldsV1 | undefined,
  context?: HandoffFieldContextV1
): HandoffConformanceResultV1 {
  const missing = getRequiredHandoffFieldsV1(surface, context).filter(
    (field) => (fields ? formatFieldValueV1(surface, field, fields) : undefined) === undefined
  );
  return { ok: missing.length === 0, missing };
}
