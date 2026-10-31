/**
 * bugs3 Steps 6/17: has Cline actually received the prompt Ensemble wrote?
 *
 * Cline 3.0.74 records the run's first user message in
 * `sessions/<session_id>/<session_id>.messages.json`. Observed on Linux (owner
 * evidence, 2026-10-28), it is exactly
 * `<user_input mode="act">PLACEHOLDER\n\nPROMPT.trim()</user_input>`, where
 * PLACEHOLDER is the fixed positional argument `buildArgs` passes. A run whose
 * stdin never arrived shows the placeholder alone (the 2026-10-26 incident).
 *
 * This module is the pure decision: given the expected prompt and what the
 * session record shows, was it delivered, and if not, why. It never reads a
 * "latest" session: the caller names the session that belongs to THIS attempt
 * (provider pid and start time), and a record that does not match is rejected
 * as someone else's.
 *
 * It also owns the capability gate. Receipt is only observable after the fact
 * unless the CLI can hold its tools until the message is validated, and the
 * owner's evidence has not established such a barrier (hooks continue on
 * timeout and error; `--auto-approve false` denies every write with no
 * headless way to release it). Until `CLINE_PRE_EDIT_RECEIPT_BARRIER_VERIFIED_V1`
 * is set on the strength of that evidence, an editable Cline launch is refused
 * rather than trusting a retrospective check to undo edits.
 */
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

/**
 * Set to true only when a fail-closed mechanism that holds Cline's edit tools
 * until the first user message is validated has been demonstrated on every
 * supported platform. Deliberately a constant, not a setting: flipping it is a
 * code-reviewed decision that cites the evidence.
 */
export const CLINE_PRE_EDIT_RECEIPT_BARRIER_VERIFIED_V1 = false;

export type EditableLaunchGateV1 =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: "promptReceiptBarrierUnverified"; readonly message: string };

/** May an editable (file-changing) Cline run start? */
export function clineEditableLaunchGateV1(
  barrierVerified: boolean = CLINE_PRE_EDIT_RECEIPT_BARRIER_VERIFIED_V1
): EditableLaunchGateV1 {
  if (barrierVerified) {
    return { allowed: true };
  }
  return {
    allowed: false,
    code: "promptReceiptBarrierUnverified",
    message:
      "Cline CLI was not started for this editing round: Ensemble cannot yet confirm that Cline has " +
      "received the prompt before it is allowed to change files. A Cline run that never received its " +
      "prompt chose its own work from the repository and edited unrelated files. Nothing was changed. " +
      "Pick another model for this stage (open AI Models on it), or use Cline for read-only review stages.",
  };
}

/** Wrap the prompt the way Cline 3.0.74 records it as the first user message. */
export function expectedClineFirstUserMessageV1(placeholder: string, prompt: string): string {
  return `<user_input mode="act">${placeholder}\n\n${prompt.trim()}</user_input>`;
}

export function sha256HexV1(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The slice of Cline's `<id>.json` session record needed to bind it to an attempt. */
export interface ClineSessionRecordV1 {
  readonly session_id?: unknown;
  readonly pid?: unknown;
  readonly started_at?: unknown;
}

/** What Ensemble knows about the process it spawned for this attempt. */
export interface ClineAttemptBindingV1 {
  readonly pid: number;
  /** When Ensemble spawned the process (epoch ms). */
  readonly spawnedAtMs: number;
  /** Tolerated clock skew between spawn and Cline's own `started_at`. */
  readonly skewMs?: number;
}

const DEFAULT_SKEW_MS_V1 = 30_000;

export type ClineReceiptVerdictV1 =
  | { readonly ok: true; readonly sessionId: string; readonly expectedSha256: string }
  | {
      readonly ok: false;
      readonly code:
        | "noSessionRecord"
        | "sessionNotThisAttempt"
        | "noFirstUserMessage"
        | "placeholderOnly"
        | "promptMismatch";
      readonly detail: string;
    };

/** True when the session record belongs to the process this attempt spawned. */
export function sessionBelongsToAttemptV1(session: ClineSessionRecordV1, binding: ClineAttemptBindingV1): boolean {
  if (session.pid !== binding.pid) {
    return false;
  }
  if (typeof session.started_at !== "string") {
    return false;
  }
  const startedMs = Date.parse(session.started_at);
  if (!Number.isFinite(startedMs)) {
    return false;
  }
  const skew = binding.skewMs ?? DEFAULT_SKEW_MS_V1;
  return startedMs >= binding.spawnedAtMs - skew && startedMs <= binding.spawnedAtMs + skew + 10 * 60_000;
}

/** The text of the first user message in a Cline `messages.json` object, if any. */
export function firstUserMessageTextV1(messagesRecord: unknown): string | undefined {
  const messages = (messagesRecord as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const message of messages) {
    if ((message as { role?: unknown } | null)?.role !== "user") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => (part as { type?: unknown } | null)?.type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => (part as { text: string }).text)
        .join("");
      return text.length > 0 ? text : undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Compare the attempt's own session record against the prompt Ensemble wrote.
 * Digests, not contents, appear in the verdict: the prompt may hold private
 * source and must not be copied into diagnostics.
 */
export function verifyClinePromptReceiptV1(input: {
  readonly placeholder: string;
  readonly prompt: string;
  readonly session: ClineSessionRecordV1 | undefined;
  readonly messagesRecord: unknown;
  readonly binding: ClineAttemptBindingV1;
}): ClineReceiptVerdictV1 {
  if (input.session === undefined) {
    return { ok: false, code: "noSessionRecord", detail: "Cline wrote no session record for this attempt." };
  }
  if (!sessionBelongsToAttemptV1(input.session, input.binding)) {
    return {
      ok: false,
      code: "sessionNotThisAttempt",
      detail: "The session record does not belong to the process Ensemble started for this attempt.",
    };
  }
  const observed = firstUserMessageTextV1(input.messagesRecord);
  if (observed === undefined) {
    return { ok: false, code: "noFirstUserMessage", detail: "Cline's session shows no first user message." };
  }
  const expected = expectedClineFirstUserMessageV1(input.placeholder, input.prompt);
  if (observed === expected) {
    return {
      ok: true,
      sessionId: typeof input.session.session_id === "string" ? input.session.session_id : "",
      expectedSha256: sha256HexV1(expected),
    };
  }
  if (observed.includes(input.placeholder) && !observed.includes(input.prompt.trim().slice(0, 200))) {
    return {
      ok: false,
      code: "placeholderOnly",
      detail: `Cline's first message is the placeholder instruction without the prompt (${observed.length} characters seen, ${expected.length} expected).`,
    };
  }
  return {
    ok: false,
    code: "promptMismatch",
    detail:
      `Cline's first message differs from the prompt Ensemble wrote ` +
      `(${observed.length} characters seen, ${expected.length} expected; digests ${sha256HexV1(observed).slice(0, 12)} / ${sha256HexV1(expected).slice(0, 12)}).`,
  };
}

/** The user-facing failure for a round whose provider did not receive the prompt. */
export function promptNotDeliveredMessageV1(providerLabel: string, verdict: ClineReceiptVerdictV1 & { ok: false }): string {
  return (
    `Prompt not delivered: ${providerLabel} did not receive the prompt Ensemble wrote (${verdict.detail}) ` +
    "The round was stopped and is not continued, because a model without its instructions picks its own work. " +
    "Anything it changed is reported separately from ordinary edits so you can review or revert it."
  );
}

/**
 * The chat notice for edits a round made after its provider never received the
 * prompt. They are NOT quarantined as an ordinary round's unreported edits (no
 * continuation is owed, and none runs), and they are not work anyone asked for.
 * Returns undefined when the round changed nothing.
 */
export function describeUndeliveredPromptEditsV1(input: {
  readonly providerLabel: string;
  readonly filesChanged: readonly string[];
  readonly filesChangedUnknown: boolean;
  /**
   * Which changed files were clean before the round. When given, the notice
   * says which can be reverted from the offer below it and which were already
   * modified before the round and so are left to the owner.
   */
  readonly scope?: { readonly revertable: readonly string[]; readonly keptApart: readonly string[] };
}): string | undefined {
  if (input.filesChanged.length === 0 && !input.filesChangedUnknown) {
    return undefined;
  }
  const lead =
    `Changes made without the prompt: ${input.providerLabel} never received the prompt for this round, ` +
    "so what it changed was not asked for. These files are kept apart from the round's ordinary edits and no continuation was scheduled for them.";
  if (input.filesChanged.length === 0) {
    return (
      `${lead} Ensemble could not list the changed files; compare the working tree with your last commit ` +
      "(`git status`, `git diff`) and revert anything you did not ask for."
    );
  }
  const shown = input.filesChanged.slice(0, 20).map((file) => `- ${file}`);
  const more = input.filesChanged.length > shown.length ? [`- …and ${input.filesChanged.length - shown.length} more`] : [];
  if (input.scope !== undefined) {
    const offered = input.scope.revertable.length;
    const apart = input.scope.keptApart.length;
    const offerClause =
      offered > 0
        ? `The ${offered} file(s) that were unmodified before the round can be reverted from the choice below.`
        : "None of them can be offered for revert here.";
    const apartClause =
      apart > 0
        ? ` ${apart} of them (${input.scope.keptApart.slice(0, 5).join(", ")}${apart > 5 ? ", …" : ""}) were already ` +
          "modified before the round, so they may hold your own edits and are not part of the revert; review those by hand."
        : "";
    return `${lead} ${offerClause}${apartClause}\n\n${[...shown, ...more].join("\n")}`;
  }
  return (
    `${lead} Review each, and revert only these paths with \`git restore -- <path>\` for tracked files ` +
    `(delete the untracked ones) — your own earlier edits to the same files are not distinguished here.\n\n${[...shown, ...more].join("\n")}`
  );
}

// ---------------------------------------------------------------------------
// Reading the attempt's own session from disk (bugs3 Step 6).
// ---------------------------------------------------------------------------

/** How a session record was tied to this attempt. */
export type ClineSessionBindingBasisV1 = "pid" | "unique-start-window";

export interface ClineSessionCandidateV1 {
  readonly session: ClineSessionRecordV1 & { readonly messages_path?: unknown };
  /** Directory holding the session's files, for the default messages path. */
  readonly directory: string;
}

export interface ClineSessionIoV1 {
  listSessionDirectories(sessionsRoot: string): Promise<string[]>;
  readJson(file: string): Promise<unknown>;
}

/**
 * The real filesystem. Only session folders touched since `sinceMs` are listed,
 * so a data folder holding months of sessions is not read in full.
 */
export function createClineSessionIoV1(sinceMs: number): ClineSessionIoV1 {
  return {
    async listSessionDirectories(sessionsRoot) {
      const entries = await fsPromises.readdir(sessionsRoot, { withFileTypes: true });
      const recent: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const directory = path.join(sessionsRoot, entry.name);
        try {
          if ((await fsPromises.stat(directory)).mtimeMs >= sinceMs) {
            recent.push(directory);
          }
        } catch {
          // A folder that vanished mid-scan is simply not a candidate.
        }
      }
      return recent;
    },
    async readJson(file) {
      try {
        return JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

/** Cline's own data folder: an explicit override, else `~/.cline/data`. */
export function resolveClineDataDirV1(env: NodeJS.ProcessEnv, homeDirectory: string): string {
  const override = env.CLINE_DATA_DIR ?? env.CLINE_DIR;
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  return `${homeDirectory.replace(/[\\/]+$/, "")}/.cline/data`;
}

function startedWithinAttemptWindowV1(session: ClineSessionRecordV1, binding: ClineAttemptBindingV1): boolean {
  const skew = binding.skewMs ?? DEFAULT_SKEW_MS_V1;
  const startedMs = typeof session.started_at === "string" ? Date.parse(session.started_at) : Number.NaN;
  return (
    Number.isFinite(startedMs) &&
    startedMs >= binding.spawnedAtMs - skew &&
    startedMs <= binding.spawnedAtMs + skew + 10 * 60_000
  );
}

/**
 * Choose the session record that belongs to THIS attempt. A record whose pid is
 * the process Ensemble spawned wins. Otherwise (a shell wrapper can sit between
 * Ensemble's pid and Cline's) the one and only record that started inside the
 * attempt's window is used; two or more candidates are ambiguous and none is
 * picked, so an unrelated or concurrent session is never mistaken for this one.
 */
export function selectAttemptSessionV1(
  candidates: readonly ClineSessionCandidateV1[],
  binding: ClineAttemptBindingV1
): { readonly candidate: ClineSessionCandidateV1; readonly basis: ClineSessionBindingBasisV1 } | "ambiguous" | undefined {
  const byPid = candidates.filter((candidate) => sessionBelongsToAttemptV1(candidate.session, binding));
  if (byPid.length === 1 && byPid[0] !== undefined) {
    return { candidate: byPid[0], basis: "pid" };
  }
  if (byPid.length > 1) {
    return "ambiguous";
  }
  const inWindow = candidates.filter((candidate) => startedWithinAttemptWindowV1(candidate.session, binding));
  if (inWindow.length === 1 && inWindow[0] !== undefined) {
    return { candidate: inWindow[0], basis: "unique-start-window" };
  }
  return inWindow.length > 1 ? "ambiguous" : undefined;
}

type ClineReceiptFailureV1 = ClineReceiptVerdictV1 & { readonly ok: false };

export type ClineReceiptCheckV1 =
  | { readonly kind: "delivered"; readonly sessionId: string; readonly basis: ClineSessionBindingBasisV1 }
  | { readonly kind: "notDelivered"; readonly verdict: ClineReceiptFailureV1 }
  /** No session could be tied to the attempt: delivery can be neither confirmed nor refuted. */
  | { readonly kind: "unverifiable"; readonly verdict: ClineReceiptFailureV1 };

/**
 * Read the attempt's session from `dataDir` and compare its complete first user
 * message with the prompt. Positive evidence of non-delivery (the placeholder
 * alone, a different message) is `notDelivered`; a missing or ambiguous session
 * is `unverifiable`, which the caller decides how to treat per platform.
 */
export async function checkClinePromptReceiptOnDiskV1(input: {
  readonly dataDir: string;
  readonly placeholder: string;
  readonly prompt: string;
  readonly binding: ClineAttemptBindingV1;
  readonly io: ClineSessionIoV1;
}): Promise<ClineReceiptCheckV1> {
  const sessionsRoot = `${input.dataDir.replace(/[\\/]+$/, "")}/sessions`;
  const candidates: ClineSessionCandidateV1[] = [];
  try {
    for (const directory of await input.io.listSessionDirectories(sessionsRoot)) {
      const name = directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
      const record = await input.io.readJson(`${directory.replace(/[\\/]+$/, "")}/${name}.json`);
      if (typeof record === "object" && record !== null) {
        candidates.push({ session: record as ClineSessionCandidateV1["session"], directory });
      }
    }
  } catch {
    // An unreadable data folder is "no evidence", handled below.
  }
  const selected = selectAttemptSessionV1(candidates, input.binding);
  if (selected === undefined || selected === "ambiguous") {
    const ambiguous = selected === "ambiguous";
    return {
      kind: "unverifiable",
      verdict: {
        ok: false,
        code: ambiguous ? "sessionNotThisAttempt" : "noSessionRecord",
        detail: ambiguous
          ? "More than one Cline session could belong to this attempt, so none was trusted."
          : "No Cline session record for this attempt could be found.",
      },
    };
  }
  const { candidate, basis } = selected;
  const sessionId = typeof candidate.session.session_id === "string" ? candidate.session.session_id : "";
  const messagesPath =
    typeof candidate.session.messages_path === "string" && candidate.session.messages_path.length > 0
      ? candidate.session.messages_path
      : `${candidate.directory.replace(/[\\/]+$/, "")}/${sessionId}.messages.json`;
  let messagesRecord: unknown;
  try {
    messagesRecord = await input.io.readJson(messagesPath);
  } catch {
    messagesRecord = undefined;
  }
  // A start-window match has no pid proof; the complete first-message
  // comparison below is then its only binding, so present it as bound.
  const boundSession = basis === "pid" ? candidate.session : { ...candidate.session, pid: input.binding.pid };
  const verdict = verifyClinePromptReceiptV1({
    placeholder: input.placeholder,
    prompt: input.prompt,
    session: boundSession,
    messagesRecord,
    binding: input.binding,
  });
  if (verdict.ok) {
    return { kind: "delivered", sessionId: verdict.sessionId, basis };
  }
  return verdict.code === "placeholderOnly" || verdict.code === "promptMismatch"
    ? { kind: "notDelivered", verdict }
    : { kind: "unverifiable", verdict };
}
