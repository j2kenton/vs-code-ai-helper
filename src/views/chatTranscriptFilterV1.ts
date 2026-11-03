/**
 * chat1 Step 2: what Chat With AI shows as conversation.
 *
 * The chat is a conversation: the owner's messages, the stage AI's replies, questions and cards.
 * Machine status (Auto-starting, Started, Progress, Ended, Recorded, Dismissed, Withdrawn) is the
 * Notifications log's job, and the live strip answers "is it running?". Entries stay in
 * `chat-v1.json` unchanged; this only decides what the transcript renders.
 *
 * Absence of a `kind` never means status: an untyped entry is conversation. Only an untyped
 * assistant line written before status lines carried a `kind` is recognised, and only when the
 * whole single line matches the exact format its producer writes, so an AI reply that merely
 * mentions "Progress" is never hidden.
 */

/** The few entry fields the filter reads. */
export interface TranscriptFilterEntryV1 {
  readonly role: "user" | "assistant" | "question";
  readonly text: string;
  readonly kind?: string;
  readonly decisionId?: string;
  readonly endedOperationId?: string;
}

export interface TranscriptFilterContextV1 {
  /** Ids of decision cards the chat renders, so their `decision` anchor is not also a text line. */
  readonly renderedDecisionIds?: ReadonlySet<string>;
}

// One line, anchored at both ends. `.` does not match a newline, so a multi-line reply never matches.
const LEGACY_STATUS_LINE_PATTERNS_V1: readonly RegExp[] = [
  // traceDecisionOperationV1: `Started ${label} at ${HH:MM | YYYY-MM-DD}.`
  /^Started .+ at \d{1,2}:\d{2}\.$|^Started .+ at \d{4}-\d{2}-\d{2}[ T\d:]*\.$/,
  // `Resumed ${label}.`
  /^Resumed .+\.$/,
  // `Progress: ${label}.`
  /^Progress: .+\.$/,
  // operationEndedLineV1: `Ended ${label} — ${state}[: ${reason}].`
  /^Ended .+ — .+\.$/,
  // Answer acknowledgements: `Recorded: …`.
  /^Recorded: .+$/,
  // Dismissal acknowledgements: `Dismissed "…" …` / `Dismissed “…” …` / `Dismissed: "…" …`.
  /^Dismissed(?::| [“"]).+$/,
  // `Withdrawn: ${reason}`.
  /^Withdrawn: .+$/,
  // startupAnnouncerLinesV1.
  /^.+ is starting — wait here; progress appears below\.$/,
  /^.+ is still starting \(\d+(?:\.\d+)? min\)\.$/,
  /^.+ stopped before it started, so nothing ran\. The notification above says why; choose it again when that is resolved\.$/,
];

/** True for an untyped assistant line in a status format a producer wrote before status lines were tagged. */
export function isLegacyStatusLineV1(entry: Pick<TranscriptFilterEntryV1, "role" | "text" | "kind">): boolean {
  if (entry.role !== "assistant" || entry.kind !== undefined) return false;
  const text = entry.text.trim();
  if (text.includes("\n")) return false;
  return LEGACY_STATUS_LINE_PATTERNS_V1.some((pattern) => pattern.test(text));
}

/**
 * Whether an entry is part of the conversation the chat renders. Shows owner messages, questions,
 * untyped assistant replies and any unknown `kind`; hides `activity` and `outcome` entries, the
 * recognised legacy status lines and a `decision` anchor whose card is rendered.
 */
export function isConversationEntryV1(entry: TranscriptFilterEntryV1, context: TranscriptFilterContextV1 = {}): boolean {
  if (entry.role === "user" || entry.role === "question") return true;
  if (entry.kind === "activity" || entry.kind === "outcome") return false;
  // A terminal "Ended …" line is recognisable by the operation it closes even without a kind.
  if (entry.endedOperationId !== undefined) return false;
  if (entry.kind === "decision") {
    return !(entry.decisionId !== undefined && context.renderedDecisionIds?.has(entry.decisionId));
  }
  if (entry.kind !== undefined) return true;
  return !isLegacyStatusLineV1(entry);
}
