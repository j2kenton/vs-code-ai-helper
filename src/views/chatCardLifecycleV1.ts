/**
 * chat1 Step 10: one card lifecycle for every card kind in Chat With AI. A card opens expanded. When it
 * is finished (answered, dismissed, withdrawn, or overtaken by events) it keeps its full content,
 * read-only, and collapses to one line holding its title and outcome. These are the pure functions that
 * turn a stored record into that one view shape and word the outcome line; rendering lives in
 * `chatView.ts`.
 */
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1 } from "../utils/cardLifecycleV1";

export type ChatCardKindV1 = "decision" | "interaction" | "question" | "form";
export type ChatCardStateV1 = "open" | "answered" | "dismissed" | "withdrawn" | "retired";

/** The one shape the renderer reads, for all four card kinds. */
export interface ChatCardViewV1 {
  readonly cardId: string;
  readonly kind: ChatCardKindV1;
  readonly title: string;
  readonly state: ChatCardStateV1;
  /** The one-line outcome: "needs your answer", "answered: Apply · 03:41", "dismissed · 03:41", … */
  readonly outcome: string;
  /** When the card finished (ISO), when known. */
  readonly at?: string;
}

/** Whether the card is finished: read-only, collapsed by default. */
export function isCardFinishedV1(state: ChatCardStateV1): boolean {
  return state !== "open";
}

/** An open card starts expanded; a finished one starts collapsed. */
export function defaultCardExpandedV1(state: ChatCardStateV1): boolean {
  return state === "open";
}

/** `HH:MM` in the viewer's locale, or undefined when the time is missing or unreadable. */
export function formatCardTimeV1(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function plainReasonV1(reason: string | undefined, fallback: string): string {
  const trimmed = (reason ?? "").trim().replace(/[.\s]+$/, "");
  return trimmed.length > 0 ? trimmed : fallback;
}

/** The outcome line for a card in the given state. */
export function cardOutcomeLineV1(
  state: ChatCardStateV1,
  details: { readonly choice?: string; readonly reason?: string; readonly at?: string } = {}
): string {
  const time = formatCardTimeV1(details.at);
  const timeSuffix = time !== undefined ? ` · ${time}` : "";
  switch (state) {
    case "open":
      return "needs your answer";
    case "answered": {
      const choice = (details.choice ?? "").trim();
      return `${choice.length > 0 ? `answered: ${choice}` : "answered"}${timeSuffix}`;
    }
    case "dismissed":
      return `dismissed${timeSuffix}`;
    case "withdrawn":
      return `withdrawn: ${plainReasonV1(details.reason, "it no longer applies")}`;
    case "retired":
      return `closed: ${plainReasonV1(details.reason, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1)}`;
  }
}

/** The collapsed header line: title and outcome. */
export function cardHeaderTextV1(view: Pick<ChatCardViewV1, "title" | "outcome">): string {
  return `${view.title} — ${view.outcome}`;
}

/** Map a stored decision's lifecycle state to the card state. */
export function decisionCardStateV1(decision: Pick<WorkflowDecisionV1, "state">): ChatCardStateV1 {
  switch (decision.state) {
    case "pending":
      return "open";
    case "resolved":
      return "answered";
    case "dismissed":
      return "dismissed";
    case "withdrawn":
      return "withdrawn";
    case "superseded":
      return "retired";
  }
}

/**
 * The view of a decision card, from its record. `title` is what the open card shows as its heading; the
 * chosen option's label comes from the record's own options. A record whose details were trimmed is
 * the caller's to word ("details no longer kept").
 */
export function cardViewFromDecisionV1(decision: WorkflowDecisionV1, title: string): ChatCardViewV1 {
  const state = decisionCardStateV1(decision);
  const chosen = decision.resolvedOptionId !== undefined
    ? decision.options.find((option) => option.optionId === decision.resolvedOptionId)
    : undefined;
  const at =
    state === "answered" ? decision.resolvedAt : state === "dismissed" ? decision.dismissedAt : undefined;
  const reason =
    state === "withdrawn" ? decision.withdrawnReason : state === "retired" ? decision.withdrawnReason : undefined;
  return {
    cardId: decision.decisionId,
    kind: "decision",
    title,
    state,
    outcome: cardOutcomeLineV1(state, {
      ...(chosen !== undefined ? { choice: chosen.label } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(at !== undefined ? { at } : {}),
    }),
    ...(at !== undefined ? { at } : {}),
  };
}

/** A settled record whose details were trimmed away: a collapsed one-line card that says so. */
export function trimmedCardViewV1(cardId: string, kind: ChatCardKindV1, title: string): ChatCardViewV1 {
  return { cardId, kind, title, state: "retired", outcome: "details no longer kept" };
}

type CardSettlementV1 = Parameters<typeof cardViewFromSettlementV1>[3];

/**
 * How a stored structured-question interaction settled, as a card settlement. Absent while it is still
 * waiting for the owner. `choice` is the answer summary for an interaction that was answered.
 */
export function interactionSettlementV1(
  interaction: { readonly state: string; readonly retirementReason?: string; readonly dismissedAt?: string },
  choice: string | undefined
): CardSettlementV1 {
  const reason = interaction.retirementReason;
  switch (interaction.state) {
    case "unresolved":
      return undefined;
    case "resumed":
      return { kind: "answered", ...(choice !== undefined && choice.length > 0 ? { choice } : {}) };
    case "cancelled":
      return { kind: "dismissed", ...(interaction.dismissedAt !== undefined ? { at: interaction.dismissedAt } : {}) };
    case "expired":
      return { kind: "retired", reason: reason ?? "it expired before it was answered" };
    case "supersededByReplacementOperation":
      return { kind: "retired", reason: reason ?? "a newer run replaced it" };
    case "resetByChatRecovery":
      return { kind: "retired", reason: reason ?? "the chat history was reset" };
    default:
      return { kind: "retired", reason: reason ?? "its record is incomplete, so it can't be answered" };
  }
}

/** How a stored open-items form settled, as a card settlement; absent while it is still open. */
export function formSettlementV1(form: {
  readonly state: string;
  readonly closedReason?: string;
  readonly closedAt?: string;
}): CardSettlementV1 {
  const at = form.closedAt !== undefined ? { at: form.closedAt } : {};
  switch (form.state) {
    case "open":
      return undefined;
    case "applied":
      return { kind: "answered", choice: "applied", ...at };
    case "dismissed":
      return { kind: "dismissed", ...at };
    default:
      return { kind: "retired", reason: form.closedReason ?? "the plan changed after it was posted", ...at };
  }
}

/**
 * The view of a question-style card (a structured interaction, a free-text question or the open-items
 * form) from how it settled. `settled` is absent while the card is still open.
 */
export function cardViewFromSettlementV1(
  cardId: string,
  kind: Exclude<ChatCardKindV1, "decision">,
  title: string,
  settled?: {
    readonly kind: "answered" | "dismissed" | "retired";
    readonly choice?: string;
    readonly reason?: string;
    readonly at?: string;
    /** An answered interaction whose run has not settled yet: "answered: … — resuming". */
    readonly resuming?: boolean;
  }
): ChatCardViewV1 {
  if (settled === undefined) {
    return { cardId, kind, title, state: "open", outcome: cardOutcomeLineV1("open") };
  }
  const state: ChatCardStateV1 = settled.kind;
  const base = cardOutcomeLineV1(state, {
    ...(settled.choice !== undefined ? { choice: settled.choice } : {}),
    ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
    ...(settled.at !== undefined ? { at: settled.at } : {}),
  });
  return {
    cardId,
    kind,
    title,
    state,
    outcome: state === "answered" && settled.resuming === true ? `${base} — resuming` : base,
    ...(settled.at !== undefined ? { at: settled.at } : {}),
  };
}
