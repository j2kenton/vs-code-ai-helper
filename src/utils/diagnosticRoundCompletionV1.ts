/**
 * review1 Step 49: a diagnostic round is complete when its diagnosis (the round's answer, which Ensemble saves as
 * `evidence/diagnosis-<n>.md` because the round runs read-only) exists and says something. It is NOT held to the
 * editing report contract (`## Files Changed`, `## Verification`, a checklist echo): gating it on the editing shape
 * would send a compliant round into report correction or implementation recovery instead of the owner's follow-up card.
 *
 * Pure: no `vscode`, no I/O.
 */

/** Fewer characters than this is a placeholder, not a diagnosis. */
export const DIAGNOSIS_MIN_CHARS_V1 = 80;

export type DiagnosticRoundCompletionV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function assessDiagnosticRoundCompletionV1(
  diagnosisPath: string,
  diagnosisText: string | undefined
): DiagnosticRoundCompletionV1 {
  const text = diagnosisText?.trim() ?? "";
  if (text.length === 0) {
    return { ok: false, reason: `the diagnostic round returned no diagnosis to save as ${diagnosisPath}` };
  }
  if (text.length < DIAGNOSIS_MIN_CHARS_V1) {
    return { ok: false, reason: `${diagnosisPath} is too short to be a diagnosis (${text.length} characters)` };
  }
  return { ok: true };
}

/** The run log for a diagnostic round: it names the diagnosis instead of the editing report's sections. */
export function formatDiagnosticRunLogV1(input: {
  readonly roundId: string;
  readonly promptRoundId: string;
  readonly status: string;
  readonly providerLine: string;
  readonly diagnosisPath: string;
  readonly completion: DiagnosticRoundCompletionV1;
  readonly summary: string;
}): string {
  return (
    `# Implementation Run\n\nRound ID: ${input.roundId}\nPrompt Round ID: ${input.promptRoundId}\n\n` +
    `Mode: diagnose\nStatus: ${input.status}\n\n${input.providerLine}` +
    `Diagnosis file: ${input.diagnosisPath}${input.completion.ok ? "" : ` (${input.completion.reason})`}\n\n` +
    `${input.summary}\n`
  );
}
