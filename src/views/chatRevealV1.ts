/**
 * bugs4 item 20 / Step 33: a card that waits on the owner opens the Chat With AI section, once,
 * without taking keyboard focus. Pure decision logic lives here so it is testable without VS Code;
 * the chat view registers the actual reveal.
 */

/** Memento key for the bounded list of decision ids whose card has already revealed the chat. */
export const REVEALED_CARD_IDS_KEY_V1 = "vs-code-ai-helper.chatView.revealedCardIds";
const MAX_REMEMBERED_REVEALS_V1 = 200;

/** The few decision fields the reveal rule reads. */
export interface RevealableDecisionV1 {
  readonly decisionId: string;
  readonly gating?: { readonly holdsTaskPaused: boolean; readonly unblocksProgress: boolean };
}

/**
 * A card waits on the owner when it pauses the task or when answering it is what moves the task on.
 * Informational and non-gating cards (a notice with a button, an optional offer) never reveal.
 */
export function cardWaitsOnOwnerV1(decision: RevealableDecisionV1): boolean {
  return decision.gating?.holdsTaskPaused === true || decision.gating?.unblocksProgress === true;
}

/** True when this card should reveal the chat now: it waits on the owner and has not revealed before. */
export function shouldRevealChatForCardV1(decision: RevealableDecisionV1, alreadyRevealed: readonly string[]): boolean {
  return cardWaitsOnOwnerV1(decision) && !alreadyRevealed.includes(decision.decisionId);
}

/** Add an id to the remembered list, newest last, bounded so the Memento never grows without limit. */
export function rememberRevealedCardV1(alreadyRevealed: readonly string[], decisionId: string): string[] {
  if (alreadyRevealed.includes(decisionId)) return [...alreadyRevealed];
  return [...alreadyRevealed, decisionId].slice(-MAX_REMEMBERED_REVEALS_V1);
}

export interface RevealMementoV1 {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type ChatRevealHandlerV1 = (decisionId: string) => Promise<void> | void;

let revealHandlerV1: ChatRevealHandlerV1 | undefined;

/** The chat view registers how to open itself without focus and scroll to a card. */
export function setChatRevealHandlerV1(handler: ChatRevealHandlerV1 | undefined): void {
  revealHandlerV1 = handler;
}

/**
 * Called when a decision card is posted. Reveals at most once per card id (persisted, so a reload or
 * a restored view never reveals again) and only for cards that wait on the owner. Best-effort: a
 * reveal failure must never affect posting the card.
 */
export async function revealChatForOwnerCardV1(
  decision: RevealableDecisionV1,
  state: RevealMementoV1 | undefined
): Promise<boolean> {
  const handler = revealHandlerV1;
  if (!handler || !state) return false;
  const revealed = state.get<string[]>(REVEALED_CARD_IDS_KEY_V1, []);
  if (!shouldRevealChatForCardV1(decision, revealed)) return false;
  try {
    await state.update(REVEALED_CARD_IDS_KEY_V1, rememberRevealedCardV1(revealed, decision.decisionId));
    await handler(decision.decisionId);
    return true;
  } catch {
    return false;
  }
}
