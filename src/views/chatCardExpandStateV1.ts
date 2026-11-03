/**
 * chat1 Step 13: remember, per card, whether the owner expanded or collapsed it, so the choice survives
 * a re-render and a window reload. Modelled on `chatRevealV1.ts`: one key in workspace state holding a
 * bounded list.
 *
 * A choice is stored with the card state it was made in and applies only while the card is still in
 * that state. So a card that goes back to pending, is raised again under a new id, or has just
 * finished starts from its default (open: expanded; finished: collapsed), not from an old choice.
 */
import { defaultCardExpandedV1, type ChatCardStateV1 } from "./chatCardLifecycleV1";

/** Memento key for the bounded list of per-card expand choices. */
export const CARD_EXPAND_CHOICES_KEY_V1 = "vs-code-ai-helper.chatView.cardExpandChoices";
const MAX_REMEMBERED_CHOICES_V1 = 300;

export interface CardExpandChoiceV1 {
  readonly cardId: string;
  /** The card state the owner was looking at when they chose. */
  readonly state: ChatCardStateV1;
  readonly expanded: boolean;
}

export interface CardExpandMementoV1 {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Whether a card is shown expanded: the saved choice while the card is still in the state it was made in, else the default. */
export function isCardExpandedV1(
  choices: readonly CardExpandChoiceV1[],
  cardId: string,
  state: ChatCardStateV1
): boolean {
  const saved = choices.find((choice) => choice.cardId === cardId);
  return saved !== undefined && saved.state === state ? saved.expanded : defaultCardExpandedV1(state);
}

/** Record a choice, newest last, one entry per card, bounded so the Memento never grows without limit. */
export function rememberCardExpandChoiceV1(
  choices: readonly CardExpandChoiceV1[],
  choice: CardExpandChoiceV1
): CardExpandChoiceV1[] {
  return [...choices.filter((existing) => existing.cardId !== choice.cardId), choice].slice(-MAX_REMEMBERED_CHOICES_V1);
}

/** Drop a choice that no longer applies (the card changed state), so the list does not hold stale entries. */
export function forgetStaleCardExpandChoicesV1(
  choices: readonly CardExpandChoiceV1[],
  current: ReadonlyMap<string, ChatCardStateV1>
): CardExpandChoiceV1[] {
  return choices.filter((choice) => {
    const state = current.get(choice.cardId);
    return state === undefined || state === choice.state;
  });
}

function isChoiceV1(value: unknown): value is CardExpandChoiceV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.cardId === "string" &&
    typeof candidate.expanded === "boolean" &&
    (candidate.state === "open" ||
      candidate.state === "answered" ||
      candidate.state === "dismissed" ||
      candidate.state === "withdrawn" ||
      candidate.state === "retired")
  );
}

/** Read the saved choices; anything malformed in the stored value is dropped, never thrown on. */
export function readCardExpandChoicesV1(state: CardExpandMementoV1 | undefined): CardExpandChoiceV1[] {
  const raw = state?.get<unknown>(CARD_EXPAND_CHOICES_KEY_V1, []);
  return Array.isArray(raw) ? raw.filter(isChoiceV1).slice(-MAX_REMEMBERED_CHOICES_V1) : [];
}

/** Save the owner's choice for one card. Best-effort: a failed save must never break the toggle. */
export async function saveCardExpandChoiceV1(
  state: CardExpandMementoV1 | undefined,
  choice: CardExpandChoiceV1
): Promise<void> {
  if (!state) return;
  try {
    await state.update(CARD_EXPAND_CHOICES_KEY_V1, rememberCardExpandChoiceV1(readCardExpandChoicesV1(state), choice));
  } catch {
    // The toggle already happened in the page; only persistence across a reload is lost.
  }
}
