/**
 * Prompt manifest — the observability foundation Part 2 step 7 lays down for
 * Parts 3 and 16 ("make the stage chat a record of work", item 18). Written
 * beside a round's run log: which template rendered it, each named
 * variable's byte size and sha256, the total dispatched-prompt byte size, the
 * total CANONICAL byte size (the same measure the 256 KB transaction limit —
 * `MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1` — will be enforced against once
 * Part 16 lands `measureCanonicalInputBytesV1`), and whether the
 * plan-of-record content fed into it carried the two sections a review is
 * expected to honour (`## Accepted Non-Goals`,
 * `## Human Verification Hand-offs`) — so a later "did the reviewer see the
 * non-goals section?" question (item 18's core finding) is answerable from
 * disk instead of unknowable.
 *
 * **`roundId` (review blocker, 2026-08-26 — "prompt observability uses the
 * wrong authority").** The plan asks this manifest to be written "where the
 * coordinator finalizes `AssembledAttemptPromptV1`" and named/keyed by "the
 * coordinator attempt ID". Neither is available to THIS dispatch path
 * (`reviewActions.ts`'s `executeImplementationRun`, which never itself
 * becomes the coordinator): `executeImplementationRun`'s CLI dispatch never
 * reaches the coordinator at all, and `ChatTransactionInputSnapshotV1`
 * (`chatInteractionTransactionV1.ts`) is NOT the dispatched prompt text
 * regardless — its own doc comment defines it as "the exact post-validation
 * [action] input the coordinator needs to rebuild the action on Resume",
 * i.e. the structured action input for question/answer reconstruction, never
 * populated for a plain edit round.
 *
 * What this module does instead: allocate one fresh id per round
 * (`roundId`, a 128-bit hex token — see `executeImplementationRun`'s call to
 * `allocateHex128IdV1()`) BEFORE dispatch, record it in the run log itself
 * (so a reader can correlate log ↔ manifest ↔ retained prompt without
 * parsing filenames) and in the manifest, and use it as the stable identity
 * this manifest is keyed to. It is deliberately NOT called "attemptId" or
 * "operationId" — those are coordinator concepts this dispatch path does not
 * itself have — and Part 4's round ledger (`RoundLedgerEntryV1`/
 * `resolveRoundV1`) is where a durable, cross-dispatch-path identity scheme
 * is expected to unify with it, the same way Part 4 plans to synthesize ids
 * for pre-ledger legacy chat messages. Retained-file NAMING stays derived
 * from the run log's own filename (still human-navigable on disk, and the
 * run log itself carries `roundId` for lookup) — only the identity a caller
 * resolves by changes.
 *
 * **Coordinator-native capture (review fix, 2026-08-26) — closed for the
 * sealed pipeline's preflight phase.** `AssembledAttemptPromptV1` — the
 * coordinator's own finalized text, including the preflight preamble and
 * result-contract suffix this dispatch path could never see on its own — is
 * now surfaced: `TaskActionRequestV1.onPromptAssembled`
 * (`taskActionCoordinatorV1.ts`) is invoked the instant that assembly
 * finalizes for an attempt; `runTwoPhaseEditActionV1`
 * (`runEditActionV1.ts`) wires it for the preflight call and merges the
 * captured `{ attemptId, prompt, promptSha256 }` onto EVERY outcome kind
 * that can carry it — "completed", but also "questions", "failed" (a
 * preflight failure) and "noChanges" (review blocker, 2026-08-26, second
 * half: these three were previously discarded here, so a round that ended
 * in a question, a preflight failure, or an empty plan had no retained
 * prompt to inspect) — as `assembledPrompt`; `runSealedImplementationV1`
 * carries it through onto `ImplementationRunResult.assembledPrompt` for
 * every one of those — including a "failed" outcome whose underlying
 * `TaskActionOutcomeV1` is itself `{ kind: "cancelled" }`
 * (`describeEditActionOutcomeFailureV1` used to accept `assembledPrompt` as a
 * parameter and drop it on exactly that branch — review fix, 2026-08-27); and
 * `executeImplementationRun` (this manifest's one
 * caller, which itself writes the run log and this manifest unconditionally
 * regardless of `result.status`) now writes THAT text — not the
 * pre-coordinator template — as the retained prompt and sets
 * `promptCaptureComplete: true` whenever it is present, on both success and
 * failure. A CLI-resolved dispatch was already verbatim-complete on its own
 * (it sends `dispatchPrompt` directly) and is unaffected. `totalCanonicalBytes`
 * (below) was also corrected in the same pass to measure this same captured
 * text rather than the pre-coordinator template variables.
 *
 * **Per-attempt cardinality and coordinator-attempt identity (review fix,
 * 2026-08-27 — "prompt observability authority" narrowed).** The single
 * mutable `capturedAssembledPrompt` in `runTwoPhaseEditActionV1` used to be
 * overwritten on every `onPromptAssembled` firing, so a round whose primary
 * candidate failed and fell back to a secondary silently discarded the
 * primary's own captured prompt — the one attempt an operator investigating
 * that failure would want. `onPromptAssembled` now pushes onto an ARRAY
 * (`AssembledPromptAttemptsV1`) instead, threaded through every
 * `TwoPhaseEditResultV1` variant and `ImplementationRunResult` as
 * `assembledPromptAttempts` alongside the existing singular `assembledPrompt`
 * (which still carries the last attempt, unchanged, for callers that only
 * need one). `executeImplementationRun` writes ONE manifest+prompt pair PER
 * captured attempt — not one per round — each keyed by that attempt's own
 * coordinator `attemptId` (this manifest's `attemptId` field, set from
 * assembly time via `AssembledPromptCaptureV1`, never invented post-run).
 * `openRetainedPromptV1.ts` already enumerates every `*.prompt.txt` file
 * under a task's `runs/` directory rather than deriving one pair from a run
 * log filename, so the per-attempt siblings surface there for free, each
 * labelled by its own `attemptId` when the manifest carries one.
 *
 * **Filename identity decoupled from the run log (review blocker,
 * 2026-08-27, third pass — "keeping the last attempt unsuffixed" / "waits
 * until after the run log is written").** `writePromptManifestV1` used to
 * derive its filenames from the JUST-WRITTEN run log's own basename, which
 * forced the write to happen after `writeRunLog` and forced one attempt (the
 * last) to keep the run log's bare basename while only EARLIER attempts got
 * an `.attempt-<attemptId>` suffix — an arbitrary distinction with no
 * relationship to which attempt actually matters. The writer now takes the
 * task's `runs/` directory URI directly and names every file purely from
 * `manifest.roundId` (always) plus `manifest.attemptId` (when the capture
 * carried one) — `<roundId>.prompt-manifest.json` / `.prompt.txt`, or
 * `<roundId>.attempt-<attemptId>.prompt-manifest.json` / `.prompt.txt`. This
 * removes the "last attempt unsuffixed" special case entirely (EVERY
 * attempt, first or last, is named by its own identity when more than one
 * was captured) and removes the run-log dependency, so
 * `executeImplementationRun` now calls this BEFORE `writeRunLog` runs —
 * closer to the round's actual completion, not gated on run-log bookkeeping
 * that has nothing to do with prompt observability. `openRetainedPromptV1.ts`
 * was already filename-agnostic (a directory scan by extension, labelled
 * from the sibling manifest's own `roundId`/`attemptId` fields), so this
 * rename needed no change there.
 *
 * **What remains open.** (1) The sealed pipeline's mechanical EXECUTION
 * phase (`continueSealedEditExecutionV1`, applying the already-decided
 * plan) has no further model-facing prompt for this to capture — nothing to
 * fix there, just nothing to capture. (2) `initialCandidate` reuse inside
 * the coordinator's own admission-time assembly (`admitAction`'s early call,
 * distinct from the `runProviderRow` loop this callback is wired into) is
 * not separately instrumented — `runProviderRow`'s callback still fires for
 * that reused assembly (the destructure it fires from covers both the fresh
 * and reused branches), so this is expected to already be covered, but it
 * has not been independently verified against that exact code path. (3) A
 * round with ZERO captured attempts (the capture callback never fired at
 * all — e.g. a CLI-resolved dispatch, which never reaches the coordinator)
 * still keys its single manifest by `roundId` alone, with no `attemptId` —
 * expected, since no coordinator attempt exists for that dispatch path. (4)
 * The write is now moved ahead of the run log, but still sits after this
 * dispatch path's OWN durable recovery transition (`beginImplementationRecoveryV1`,
 * which is deliberately the first write of any kind after a round settles —
 * see its call site's doc comment in `reviewActions.ts`); true assembly-time
 * persistence (writing from inside the coordinator's own
 * `onPromptAssembled` callback, before this dispatch path even knows the
 * round's outcome) remains unimplemented — that would require plumbing a
 * writable location through `runTwoPhaseEditActionV1`/`runEditActionV1.ts`
 * itself, a change to the shared two-phase edit-action driver with no
 * existing host-level round-trip test to verify it against, and is left as
 * the next coherent slice of this same blocker rather than attempted without
 * that verification. A true cross-dispatch-path identity scheme spanning CLI
 * and coordinator rounds alike remains Part 4's round-ledger work
 * (`RoundLedgerEntryV1`/`resolveRoundV1`), which this manifest's
 * `attemptId`/`roundId` pair is expected to unify with, not replace.
 */
import * as vscode from "vscode";
import { createHash } from "crypto";
import { canonicalJsonByteLengthV1 } from "../types/structuredQuestionV1";

export interface PromptManifestVariableV1 {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PromptManifestV1 {
  /**
   * See this module's doc comment. A freshly allocated 128-bit hex id,
   * unique per round, recorded in the run log alongside it — the identity
   * this manifest is keyed to when no coordinator `attemptId` is available.
   * Every round still gets one, even a Copilot-resolved round that also
   * carries `attemptId` below, so a round with zero captured attempts (the
   * capture callback never fired) is still correlatable to its run log.
   */
  readonly roundId: string;
  /**
   * The coordinator's own per-attempt identity (review blocker, 2026-08-27:
   * "Step 7 expressly requires coordinator-attempt identity ... persistence
   * at assembly time"), when this manifest was built from a captured
   * `AssembledPromptCaptureV1` — see `buildPromptManifestV1`'s `attemptId`
   * parameter, which sets this field, and `executeImplementationRun`
   * (reviewActions.ts), which calls it once per captured attempt.
   * Undefined for a CLI-resolved round (no coordinator attempt exists) or a
   * Copilot-resolved round whose capture never fired.
   */
  readonly attemptId?: string;
  readonly templateName: string;
  readonly variables: readonly PromptManifestVariableV1[];
  /**
   * UTF-8 byte length of the prompt actually dispatched to the provider —
   * the raw text this dispatch path sends, not a canonical-JSON encoding of
   * it.
   */
  readonly totalPromptBytes: number;
  /**
   * Canonical JSON byte length of `{ templateName, prompt: dispatchedPrompt
   * }` — `dispatchedPrompt` being the SAME text retained as `.prompt.txt`
   * (review blocker, 2026-08-26: this previously measured `{ templateName,
   * variables }`, the pre-coordinator template variables, which for a
   * Copilot-resolved round is NOT the captured attempt input — the
   * coordinator's preamble/result-contract wrapping around those variables
   * is exactly what `promptCaptureComplete: true` says was captured, and the
   * old figure silently excluded it). Computed with the SAME encoder
   * (`canonicalJsonByteLengthV1`, `structuredQuestionV1.ts`) that determines
   * whether a chat transaction's `inputSnapshot` exceeds
   * `MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1` (256 KB; item 9's transport
   * limit). Distinct from `totalPromptBytes` only in encoding (this is
   * canonical-JSON-wrapped, that is the raw UTF-8 length): both now measure
   * the same underlying text, and Part 16's `measureCanonicalInputBytesV1`
   * is expected to reuse this measure.
   */
  readonly totalCanonicalBytes: number;
  readonly planSections: {
    readonly acceptedNonGoals: boolean;
    readonly humanVerificationHandoffs: boolean;
  };
  /**
   * Whether the retained/measured prompt below IS the exact text the
   * provider received (review blocker, 2026-08-26: "prompt observability is
   * attached to the wrong authority"). A CLI-resolved dispatch invokes the
   * provider directly with this exact string, so capture is always verbatim.
   * A Copilot-resolved dispatch runs through `runSealedImplementationV1` →
   * the coordinator's sealed two-phase pipeline, which prepends
   * `buildPreflightToolSessionPreambleV1` and appends
   * `buildAiResultContractPromptV1` (`assembleAttemptPromptV1`,
   * `taskActionCoordinatorV1.ts`) around the caller-supplied template text —
   * `true` here means that coordinator-finalized text (captured via
   * `TaskActionRequestV1.onPromptAssembled`, see this module's header) was
   * actually obtained and IS what got retained; `false` means it was not
   * (the capture callback never fired for this attempt — e.g. an
   * `initialCandidate` reuse this has not been independently verified
   * against, or a best-effort capture failure), so the retained
   * `.prompt.txt` fell back to the pre-coordinator template and "did the
   * model see X?" cannot be answered from it alone for that attempt.
   */
  readonly promptCaptureComplete: boolean;
}

function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const ACCEPTED_NON_GOALS_HEADING = /^##\s+Accepted Non-Goals\s*$/m;
const HUMAN_VERIFICATION_HANDOFFS_HEADING = /^##\s+Human Verification Hand-offs\s*$/m;

/**
 * Build the manifest for one round. `planSectionSourceText` is whichever
 * variable actually carries the plan-of-record content for this template
 * (`plan` for `run-implementation.md`, `approvedPlan`/`implementation` for
 * `apply-impl-review-code.md`) — callers pass the concatenation of every
 * variable that might carry those headings, since which one does varies by
 * template and this manifest is not the place to hardcode that mapping.
 */
export function buildPromptManifestV1(
  templateName: string,
  variables: Readonly<Record<string, string>>,
  dispatchedPrompt: string,
  /**
   * See `PromptManifestV1.promptCaptureComplete`. Callers pass `false` when
   * this round's `result.runnerId === "copilot-lm"` (the sealed pipeline),
   * `true` otherwise (a direct CLI dispatch).
   */
  promptCaptureComplete: boolean,
  /** See `PromptManifestV1.roundId`. */
  roundId: string,
  /** See `PromptManifestV1.attemptId`. */
  attemptId?: string
): PromptManifestV1 {
  const variableEntries: PromptManifestVariableV1[] = Object.entries(variables)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      bytes: byteLengthUtf8(value),
      sha256: sha256Hex(value),
    }));
  const combinedVariableText = Object.values(variables)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return {
    roundId,
    ...(attemptId !== undefined ? { attemptId } : {}),
    templateName,
    variables: variableEntries,
    totalPromptBytes: byteLengthUtf8(dispatchedPrompt),
    totalCanonicalBytes: canonicalJsonByteLengthV1({ templateName, prompt: dispatchedPrompt }),
    planSections: {
      acceptedNonGoals: ACCEPTED_NON_GOALS_HEADING.test(combinedVariableText),
      humanVerificationHandoffs: HUMAN_VERIFICATION_HANDOFFS_HEADING.test(combinedVariableText),
    },
    promptCaptureComplete,
  };
}

export interface WrittenPromptManifestV1 {
  readonly manifestUri: vscode.Uri;
  readonly promptUri: vscode.Uri;
}

/**
 * Write the manifest and the retained raw prompt text into `runsDirUri`
 * (the task's `runs/` directory — created if absent, mirroring
 * `writeRunLog`'s own `ensureRunsDirectory`). Filenames are derived purely
 * from `manifest.roundId`/`manifest.attemptId` (review blocker, 2026-08-27,
 * third pass — see the module doc comment's "filename identity decoupled
 * from the run log" section): `<roundId>.prompt-manifest.json` /
 * `.prompt.txt` when no `attemptId` is present, or
 * `<roundId>.attempt-<attemptId>.prompt-manifest.json` / `.prompt.txt` when
 * one is — so a multi-attempt round names EVERY attempt by its own identity,
 * with no unsuffixed "last attempt" special case, and this call no longer
 * needs a run log to already exist. See the module doc comment for why this
 * is a plain retained file rather than a `chatInteractionTransactionV1`
 * lookup.
 */
export async function writePromptManifestV1(
  runsDirUri: vscode.Uri,
  manifest: PromptManifestV1,
  dispatchedPrompt: string
): Promise<WrittenPromptManifestV1> {
  await vscode.workspace.fs.createDirectory(runsDirUri);
  const namePart =
    manifest.attemptId !== undefined
      ? `${manifest.roundId}.attempt-${manifest.attemptId}`
      : manifest.roundId;
  const manifestUri = vscode.Uri.joinPath(runsDirUri, `${namePart}.prompt-manifest.json`);
  const promptUri = vscode.Uri.joinPath(runsDirUri, `${namePart}.prompt.txt`);
  await vscode.workspace.fs.writeFile(
    manifestUri,
    new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  );
  await vscode.workspace.fs.writeFile(promptUri, new TextEncoder().encode(dispatchedPrompt));
  return { manifestUri, promptUri };
}
