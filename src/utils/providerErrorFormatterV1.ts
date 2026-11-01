/**
 * bugs4 item 35: one place that turns a provider's raw failure text into the
 * short, readable reason chat and cards show.
 *
 * Provider CLIs append structured envelopes (`AGY_ERROR: {"short_error": ...}`),
 * repeat their own message inside them, and prefix internal codes
 * (`cliExit.3`). The old display path cut that text at 300 characters, which
 * left raw JSON in chat, cut mid-word. This formatter:
 *
 * - drops structured JSON envelopes (balanced or truncated) and keeps their
 *   `message` / `short_error` only when nothing readable remains around them;
 * - drops internal exit codes such as `cliExit.3`;
 * - shows a repeated sentence once;
 * - shortens only at a sentence or word boundary.
 *
 * The raw text is the caller's to keep in the run log; nothing is lost here
 * because nothing is stored. Pure: no I/O.
 */

const INTERNAL_CODE_RE_V1 = /\b[A-Za-z]+Exit\.\d+:?\s*/g;
const ENVELOPE_LABEL_RE_V1 = /\b[A-Za-z][A-Za-z0-9]*_ERROR:\s*$/;
const MESSAGE_KEYS_V1 = ["short_error", "message", "error_description", "detail"] as const;

/** Index just past the balanced JSON value starting at `start`, or -1 when it never closes. */
function balancedJsonEndV1(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  return -1;
}

function jsonMessageV1(fragment: string): string | undefined {
  for (const key of MESSAGE_KEYS_V1) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(fragment);
    const value = match?.[1]?.replace(/\\"/g, "\"").replace(/\\n/g, " ").trim();
    if (value) return value;
  }
  return undefined;
}

/** Removes every JSON object/array from `text`; returns the rest and the first message found inside them. */
function stripStructuredEnvelopesV1(text: string): { readonly text: string; readonly message?: string } {
  let result = "";
  let message: string | undefined;
  let cursor = 0;
  for (;;) {
    const open = /[{[]/.exec(text.slice(cursor));
    if (!open) {
      result += text.slice(cursor);
      break;
    }
    const start = cursor + open.index;
    // Only JSON-looking openers: an object with a quoted key, or an array of objects/strings.
    if (!/^[{[]\s*["{[]/.test(text.slice(start, start + 4))) {
      result += text.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    const end = balancedJsonEndV1(text, start);
    const fragment = end === -1 ? text.slice(start) : text.slice(start, end);
    message ??= jsonMessageV1(fragment);
    result += text.slice(cursor, start).replace(ENVELOPE_LABEL_RE_V1, "");
    if (end === -1) break;
    cursor = end;
  }
  return { text: result, ...(message ? { message } : {}) };
}

function uniqueSentencesV1(text: string): string[] {
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase().replace(/[\s.!?]+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    sentences.push(trimmed);
  }
  return sentences;
}

function shortenAtBoundaryV1(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  let kept = "";
  for (const sentence of sentences) {
    const next = kept ? `${kept} ${sentence}` : sentence;
    if (next.length > maxChars) break;
    kept = next;
  }
  if (kept) return kept;
  const room = text.slice(0, Math.max(0, maxChars - 1));
  const lastSpace = room.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.4 ? room.slice(0, lastSpace) : room;
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

export interface FormatProviderErrorOptionsV1 {
  /** Hard cap on the returned text (default 300). */
  readonly maxChars?: number;
  /** The model that actually served the request, named after the failure when a backup ran. */
  readonly ranOnBackup?: string;
  /**
   * Keep internal exit codes such as `cliExit.3`. Chat text drops them; the outcome's
   * durable `fallbackReason` keeps them, because other readers of that field match on
   * the code. Envelope removal, de-duplication and boundary shortening still apply.
   */
  readonly keepInternalCodes?: boolean;
}

/** Prefix other readers of run logs and chat match on; do not reword it. */
export const BACKUP_USED_PREFIX_V1 = "Backup used; primary was skipped or failed: ";

/**
 * The chat/run-log line for a backup that served the request: the stable prefix
 * plus the primary's failure in readable form, naming the backup that ran when
 * it is known.
 */
export function backupUsedNoteV1(rawFallbackReason: string, ranOnBackup?: string): string {
  return buildBackupUsedNoteV1(rawFallbackReason, ranOnBackup, false);
}

/**
 * Shared builder. `keepStablePrefix` keeps `BACKUP_USED_PREFIX_V1` in front of a correlation
 * rejection too: the run log needs it (its readers match that line), while the chat outcome
 * starts with the rejection itself, as bugs4 item 9 requires.
 */
function buildBackupUsedNoteV1(rawFallbackReason: string, ranOnBackup: string | undefined, keepStablePrefix: boolean): string {
  // bugs4 item 9: the recovery instruction for a rejected-but-preserved result is never cut
  // short, whatever the length of the text before it; and a correlation rejection says so
  // first, naming the field that failed and the backup that ran.
  const recovery = RECOVERY_INSTRUCTION_RE_V1.exec(rawFallbackReason);
  const withoutRecovery = recovery
    ? rawFallbackReason.replace(recovery[0], " ").replace(/\s*[—–-]\s*$/, "")
    : rawFallbackReason;
  const mismatch = CORRELATION_REJECTION_RE_V1.exec(rawFallbackReason);
  if (mismatch === null && recovery === null) {
    const reason = formatProviderErrorV1(rawFallbackReason, { maxChars: 300, ...(ranOnBackup ? { ranOnBackup } : {}) });
    return `${BACKUP_USED_PREFIX_V1}${reason ?? "the primary reported no readable reason."}`;
  }
  const lead = mismatch
    ? `Primary result rejected (${mismatch[1]} mismatch)${ranOnBackup ? `; ran on backup ${ranOnBackup}` : ""}. `
    : "";
  const body = formatProviderErrorV1(withoutRecovery, {
    maxChars: 300,
    ...(!mismatch && ranOnBackup ? { ranOnBackup } : {}),
  });
  const tail = recovery ? ` ${recovery[0].replace(/^[\s—–-]+/, "")}` : "";
  const prefix = mismatch && !keepStablePrefix ? "" : BACKUP_USED_PREFIX_V1;
  return `${prefix}${lead}${body ?? "the primary reported no readable reason."}${tail}`;
}

/** `run "Recover Last AI Response" (…) to read it back`, with its leading dash, kept whole. */
const RECOVERY_INSTRUCTION_RE_V1 = /\s*[—–-]?\s*run "Recover Last AI Response"[^\n]*?to read it back/i;
/** The coordinator's own wording for a spool correlation rejection, naming the failed field. */
const CORRELATION_REJECTION_RE_V1 = /Primary result rejected \(([^)]+?) mismatch\)/;

/**
 * The run-log form of a backup note: the readable line chat shows, then the
 * provider's raw text unshortened, so the formatter's clean-up never loses the
 * evidence (bugs4 item 35: "the full text stays in the run log").
 */
export function backupUsedRunLogNoteV1(rawFallbackReason: string, ranOnBackup?: string): string {
  const note = buildBackupUsedNoteV1(rawFallbackReason, ranOnBackup, true);
  const raw = rawFallbackReason.trim();
  return raw ? `${note}\n\nRaw provider message: ${raw}` : note;
}

/**
 * The readable form of a provider failure. Never returns raw JSON, never cuts
 * mid-word, never repeats a sentence. Returns `undefined` for empty input.
 */
export function formatProviderErrorV1(raw: string, options: FormatProviderErrorOptionsV1 = {}): string | undefined {
  const maxChars = options.maxChars ?? 300;
  const flattened = raw.replace(/\s+/g, " ").trim();
  if (!flattened) return undefined;
  const stripped = stripStructuredEnvelopesV1(flattened);
  let readable = (options.keepInternalCodes ? stripped.text : stripped.text.replace(INTERNAL_CODE_RE_V1, ""))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:]+$/, "");
  if (stripped.message) {
    const lowered = readable.toLowerCase();
    const probe = stripped.message.toLowerCase().slice(0, 24);
    const endsWithStatus = /\bHTTP \d{3}$/.test(readable);
    if ((readable === "" || endsWithStatus) && !lowered.includes(probe)) {
      readable = readable ? `${readable}: ${stripped.message}` : stripped.message;
    }
  }
  const sentences = uniqueSentencesV1(readable);
  let body = sentences.join(" ");
  const suffix = options.ranOnBackup ? ` Ran on backup ${options.ranOnBackup}.` : "";
  if (!body) {
    body = "the provider reported a failure with no readable message";
  }
  const room = Math.max(40, maxChars - suffix.length);
  const shortened = shortenAtBoundaryV1(body, room);
  return `${shortened}${suffix}`.slice(0, maxChars);
}
