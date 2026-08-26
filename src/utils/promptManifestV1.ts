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
 * coordinator attempt ID". Neither is available to this dispatch path, and
 * the gap is architectural, not an oversight this module can paper over:
 * `AssembledAttemptPromptV1` (`taskActionCoordinatorV1.ts`) exists only
 * inside the coordinator's question-admission flow for question-capable
 * actions; `executeImplementationRun`'s CLI dispatch never reaches the
 * coordinator at all, and even the Copilot-resolved path
 * (`runSealedImplementationV1` → the sealed two-phase pipeline) does not
 * surface its assembled prompt or attemptId back out through
 * `ImplementationRunResult`. Separately, `ChatTransactionInputSnapshotV1`
 * (`chatInteractionTransactionV1.ts`) is NOT the dispatched prompt text at
 * all — its own doc comment defines it as "the exact post-validation
 * [action] input the coordinator needs to rebuild the action on Resume",
 * i.e. the structured action input for question/answer reconstruction, never
 * populated for a plain edit round. Reading it here would not produce the
 * text this manifest is about, even where a transaction happens to exist.
 *
 * What this module does instead: allocate one fresh id per round
 * (`roundId`, a 128-bit hex token — see `executeImplementationRun`'s call to
 * `allocateHex128IdV1()`) BEFORE dispatch, record it in the run log itself
 * (so a reader can correlate log ↔ manifest ↔ retained prompt without
 * parsing filenames) and in the manifest, and use it as the stable identity
 * this manifest is keyed to. It is deliberately NOT called "attemptId" or
 * "operationId" — those are coordinator concepts this dispatch path does not
 * have — and Part 4's round ledger (`RoundLedgerEntryV1`/`resolveRoundV1`) is
 * where a durable, cross-dispatch-path identity scheme is expected to unify
 * with it, the same way Part 4 plans to synthesize ids for pre-ledger legacy
 * chat messages. Retained-file NAMING stays derived from the run log's own
 * filename (still human-navigable on disk, and the run log itself carries
 * `roundId` for lookup) — only the identity a caller resolves by changes.
 *
 * A genuinely coordinator-native capture for the Copilot sealed-pipeline
 * path (surfacing `AssembledAttemptPromptV1.prompt`/`promptSha256` through
 * `runSealedImplementationV1`'s result) remains outstanding; that is a
 * change to `taskActionCoordinatorV1.ts`'s and `runEditActionV1.ts`'s public
 * surface, not to this manifest module, and is recorded as a remaining
 * blocker rather than attempted here.
 */
import * as vscode from "vscode";
import * as path from "path";
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
   * this manifest is keyed to. Not a coordinator `attemptId`/`operationId`;
   * no such id exists for this dispatch path.
   */
  readonly roundId: string;
  readonly templateName: string;
  readonly variables: readonly PromptManifestVariableV1[];
  /**
   * UTF-8 byte length of the prompt actually dispatched to the provider —
   * the raw text this dispatch path sends, not a canonical-JSON encoding of
   * it.
   */
  readonly totalPromptBytes: number;
  /**
   * Canonical JSON byte length of `{ templateName, variables }`, computed
   * with the SAME encoder (`canonicalJsonByteLengthV1`,
   * `structuredQuestionV1.ts`) that determines whether a chat transaction's
   * `inputSnapshot` exceeds `MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1` (256 KB;
   * item 9's transport limit). Distinct from `totalPromptBytes`: this is the
   * figure that is actually comparable against that limit, and the figure
   * Part 16's `measureCanonicalInputBytesV1` is expected to reuse.
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
   * provider directly with this exact string, so capture is verbatim. A
   * Copilot-resolved dispatch instead runs through
   * `runSealedImplementationV1` → the coordinator's sealed two-phase
   * pipeline, which prepends `buildPreflightToolSessionPreambleV1` (the
   * preflight row's `buildPrompt`, `editPreflightRowsV1.ts`) and appends
   * `buildAiResultContractPromptV1` (`assembleAttemptPromptV1`,
   * `taskActionCoordinatorV1.ts`) — neither of which this dispatch path
   * (`reviewActions.ts`'s `writeRunLog` caller) has access to, since it does
   * not route through `chatInteractionTransactionV1`'s transaction store.
   * `false` here means the retained `.prompt.txt` is the pre-coordinator
   * template only, and "did the model see X?" cannot be answered from it
   * alone for that attempt — recording this explicitly rather than silently
   * overclaiming completeness is the smallest honest fix within this
   * dispatch path's reach; genuinely capturing the coordinator's assembled
   * prompt for Copilot-sealed rounds requires surfacing it from
   * `taskActionCoordinatorV1.ts` through `runSealedImplementationV1`'s
   * result, which remains outstanding.
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
  roundId: string
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
    templateName,
    variables: variableEntries,
    totalPromptBytes: byteLengthUtf8(dispatchedPrompt),
    totalCanonicalBytes: canonicalJsonByteLengthV1({ templateName, variables }),
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
 * Write the manifest and the retained raw prompt text as siblings of a
 * just-written run log (same directory, same base filename, `.md` replaced
 * with `.prompt-manifest.json` / `.prompt.txt`). File NAMING stays derived
 * from the run log's own filename — still human-navigable on disk, and this
 * dispatch path has no other name to give it — but the manifest's `roundId`
 * field (see the module doc comment) is the real identity a caller resolves
 * by; the run log itself carries the same id so the two can be correlated
 * without parsing filenames. See the module doc comment for why this is a
 * plain retained file rather than a `chatInteractionTransactionV1` lookup.
 */
export async function writePromptManifestV1(
  logUri: vscode.Uri,
  manifest: PromptManifestV1,
  dispatchedPrompt: string
): Promise<WrittenPromptManifestV1> {
  const dirUri = vscode.Uri.joinPath(logUri, "..");
  const baseName = path.basename(logUri.fsPath).replace(/\.md$/i, "");
  const manifestUri = vscode.Uri.joinPath(dirUri, `${baseName}.prompt-manifest.json`);
  const promptUri = vscode.Uri.joinPath(dirUri, `${baseName}.prompt.txt`);
  await vscode.workspace.fs.writeFile(
    manifestUri,
    new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  );
  await vscode.workspace.fs.writeFile(promptUri, new TextEncoder().encode(dispatchedPrompt));
  return { manifestUri, promptUri };
}

/** Derive the manifest/prompt sibling URIs for a run log without writing anything — used by "Open Retained Prompt" to locate them. */
export function promptManifestUrisForRunLogV1(logUri: vscode.Uri): WrittenPromptManifestV1 {
  const dirUri = vscode.Uri.joinPath(logUri, "..");
  const baseName = path.basename(logUri.fsPath).replace(/\.md$/i, "");
  return {
    manifestUri: vscode.Uri.joinPath(dirUri, `${baseName}.prompt-manifest.json`),
    promptUri: vscode.Uri.joinPath(dirUri, `${baseName}.prompt.txt`),
  };
}
