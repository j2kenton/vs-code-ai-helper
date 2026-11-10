/**
 * review2 Step 43: "Answer in my own words…" is answered in Chat With AI's own message box, with no pop-up.
 *
 * The owner chooses the option; the window where they clicked shows "Answering: <card title>" above its message box
 * (with Cancel) and the next message sent from that box is the answer. It never starts a Chat With AI round. The
 * message travels as an ordinary chat send carrying the decision it answers (`answersDecision`); the window that
 * runs the workflow records the text under task.md's "## Owner decisions" and runs what the option promised.
 *
 * Pure: no `vscode`, no I/O. The in-memory hand-over only carries the typed text from the send handler to the
 * decision's own command, which runs in the same process.
 */

/** What the card says when an own-words option is chosen. */
export const OWN_WORDS_TYPE_HINT_V1 = "Type your answer in the message box below.";

/** The banner above the message box while an answer is pending. */
export function ownWordsBannerTextV1(cardTitle: string): string {
  const title = cardTitle.replace(/\s+/g, " ").trim();
  return `Answering: ${title.length > 120 ? `${title.slice(0, 117)}…` : title}`;
}

/** The decision (card id and option id) an own-words chat send answers. */
export interface AnswersDecisionV1 {
  readonly decisionId: string;
  readonly optionId: string;
}

const DECISION_ID_RE = /^[\w:.\-%@]{1,300}$/;

/** Decode the relayed field: only two plain strings of a sane shape are accepted. */
export function decodeAnswersDecisionV1(value: unknown): AnswersDecisionV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { decisionId, optionId } = record;
  if (typeof decisionId !== "string" || typeof optionId !== "string") return undefined;
  if (!DECISION_ID_RE.test(decisionId) || !DECISION_ID_RE.test(optionId)) return undefined;
  return { decisionId, optionId };
}

/**
 * Whether a card option is an own-words option: it dispatches the owner-decision command with `ownWords: true`.
 * Returns that argument (so the caller can see the blocker id), or undefined for any other option.
 */
export function ownWordsArgOfOptionV1(option: {
  readonly effect: { readonly kind: string; readonly args?: readonly unknown[] };
}): { readonly blockerId: string; readonly taskFolderPath: string } | undefined {
  if (option.effect.kind !== "command") return undefined;
  const arg = option.effect.args?.[0];
  if (typeof arg !== "object" || arg === null) return undefined;
  const record = arg as Record<string, unknown>;
  if (record.ownWords !== true) return undefined;
  if (typeof record.blockerId !== "string" || typeof record.taskFolderPath !== "string") return undefined;
  return { blockerId: record.blockerId, taskFolderPath: record.taskFolderPath };
}

const MAX_OWN_WORDS_LENGTH_V1 = 1000;

/** The typed text as it is recorded: whitespace collapsed, bounded. */
export function normalizeOwnWordsTextV1(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_OWN_WORDS_LENGTH_V1);
}

const handedOver = new Map<string, string>();

function handOverKey(taskFolderPath: string, blockerId: string): string {
  return `${taskFolderPath}\n${blockerId}`;
}

/** Leave the typed text for the decision's own command, which runs next in this process. */
export function handOverOwnWordsTextV1(taskFolderPath: string, blockerId: string, text: string): void {
  handedOver.set(handOverKey(taskFolderPath, blockerId), text);
}

/** True when text has been handed over for this blocker and its command has not taken it yet. */
export function hasHandedOverOwnWordsTextV1(taskFolderPath: string, blockerId: string): boolean {
  return handedOver.has(handOverKey(taskFolderPath, blockerId));
}

/** Take (and clear) the text handed over for this blocker; undefined when none was typed. */
export function takeHandedOverOwnWordsTextV1(taskFolderPath: string, blockerId: string): string | undefined {
  const key = handOverKey(taskFolderPath, blockerId);
  const text = handedOver.get(key);
  handedOver.delete(key);
  return text;
}
