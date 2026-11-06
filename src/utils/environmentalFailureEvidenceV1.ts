/**
 * review1 Step 48: what the card for a blocker automation cannot fix has to show. The failing command, where it
 * stopped and the tail of its output come from the mechanical blocker (and the recorded Verified Checks when
 * present); Ensemble's own environment for that run is the cwd as spawned and the NAMES (never values) of the
 * variables in the process. Also the one-line lead a notification about the stage opens with, so the broken check
 * comes before the checklist.
 *
 * Pure: no `vscode`, no I/O.
 */

/** The blocker fields this module reads; satisfied by `ReviewBlocker` and by a recorded blocker identity. */
export interface EnvironmentalEvidenceBlockerV1 {
  readonly resolver?: string;
  readonly description?: string;
  readonly origin?: "reviewer" | "mechanical";
}

/** The Verified Checks environment disclosure (`CompletionLintResult.verificationEnvironment`). */
export interface EnvironmentalEvidenceEnvV1 {
  readonly cwd: string;
  readonly packageManager?: string | null;
  readonly envVarNames: readonly string[];
}

export interface EnvironmentalFailedCheckV1 {
  readonly command: string;
  readonly exitCode?: number;
  readonly output: string;
}

export interface EnvironmentalFailureEvidenceV1 {
  /** The environmental blockers' own text, as the reviewer wrote it. */
  readonly environmentalDescriptions: readonly string[];
  /** True when any of them is `environmental-fixable`: a bounded code change may resolve it. */
  readonly fixable: boolean;
  readonly failingCommand?: string;
  readonly exitCode?: number;
  /** Where it stopped: the last non-empty line of the output that names an error, else the last line. */
  readonly stoppedAt?: string;
  readonly outputTail?: string;
  readonly environment?: EnvironmentalEvidenceEnvV1;
}

export const ENVIRONMENTAL_OUTPUT_TAIL_MAX_CHARS_V1 = 800;
export const ENVIRONMENTAL_ENV_NAMES_MAX_V1 = 60;

const MECHANICAL_COMMAND_RE = /^`([^`]+)`\s+failed\s+\(exit\s+(-?\d+)\)/;
const FENCED_OUTPUT_RE = /```\r?\n([\s\S]*?)\r?\n```/;
const ERROR_LINE_RE = /\b(?:error|failed|fail|cannot|can't|unable|timed? ?out|ENOENT|EACCES|EPERM|refused|exception|not found)\b/i;

function isEnvironmentalResolver(resolver: string | undefined): boolean {
  return resolver === "environmental" || resolver === "environmental-fixable";
}

function tailOf(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}

function stoppedAtLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERROR_LINE_RE.test(lines[i]!)) return lines[i]!.slice(0, 240);
  }
  return lines[lines.length - 1]!.slice(0, 240);
}

/**
 * Collects the evidence for the card. `failedChecks` (the recorded Verified Checks' failures) are preferred over
 * the mechanical blocker text because they carry the full output; the blocker text is the fallback.
 */
export function extractEnvironmentalFailureEvidenceV1(input: {
  readonly blockers: readonly EnvironmentalEvidenceBlockerV1[];
  readonly failedChecks?: readonly EnvironmentalFailedCheckV1[];
  readonly environment?: EnvironmentalEvidenceEnvV1;
}): EnvironmentalFailureEvidenceV1 {
  const environmental = input.blockers.filter((b) => isEnvironmentalResolver(b.resolver));
  const fixable = environmental.some((b) => b.resolver === "environmental-fixable");
  const environmentalDescriptions = environmental
    .map((b) => (b.description ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);

  let failingCommand: string | undefined;
  let exitCode: number | undefined;
  let output: string | undefined;

  const recorded = input.failedChecks?.find((check) => check.command.trim().length > 0);
  if (recorded) {
    failingCommand = recorded.command.trim();
    exitCode = recorded.exitCode;
    output = recorded.output;
  } else {
    for (const blocker of input.blockers) {
      if (blocker.origin !== "mechanical") continue;
      const description = blocker.description ?? "";
      const match = MECHANICAL_COMMAND_RE.exec(description.trim());
      if (!match) continue;
      failingCommand = match[1]!.trim();
      exitCode = Number(match[2]);
      output = FENCED_OUTPUT_RE.exec(description)?.[1];
      break;
    }
  }

  const outputTail = output !== undefined && output.trim().length > 0
    ? tailOf(output, ENVIRONMENTAL_OUTPUT_TAIL_MAX_CHARS_V1)
    : undefined;
  const stoppedAt = output !== undefined ? stoppedAtLine(output) : undefined;

  return {
    environmentalDescriptions,
    fixable,
    ...(failingCommand !== undefined ? { failingCommand } : {}),
    ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(outputTail !== undefined ? { outputTail } : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
  };
}

/** Ensemble's own environment for the run: the cwd as spawned and variable NAMES only. Never values. */
export function formatEnvironmentReportV1(environment: EnvironmentalEvidenceEnvV1 | undefined): string {
  if (!environment) {
    return "Ensemble did not record the environment the checks ran in for this review.";
  }
  const names = [...environment.envVarNames].sort();
  const shown = names.slice(0, ENVIRONMENTAL_ENV_NAMES_MAX_V1).map((name) => `\`${name}\``).join(", ");
  const more = names.length > ENVIRONMENTAL_ENV_NAMES_MAX_V1 ? ` (and ${names.length - ENVIRONMENTAL_ENV_NAMES_MAX_V1} more)` : "";
  return [
    `Working directory as spawned: ${environment.cwd}`,
    ...(environment.packageManager ? [`Package manager: ${environment.packageManager}`] : []),
    `Variables present in the process (names only; values are never shown): ${shown || "none recorded"}${more}`,
  ].join("\n");
}

/** The failure, as a block both the card and the diagnostic round are given. */
export function formatFailureReportV1(evidence: EnvironmentalFailureEvidenceV1): string {
  const lines: string[] = [];
  if (evidence.failingCommand !== undefined) {
    lines.push(
      `Failing command: \`${evidence.failingCommand}\`` +
        (evidence.exitCode !== undefined ? ` (exit ${evidence.exitCode})` : "")
    );
  }
  if (evidence.stoppedAt !== undefined) lines.push(`Where it stopped: ${evidence.stoppedAt}`);
  if (evidence.outputTail !== undefined) lines.push(`Output tail:\n${evidence.outputTail}`);
  if (lines.length === 0) {
    lines.push(
      "Ensemble holds no failing command or output for this blocker; the reviewer's description is all there is."
    );
  }
  if (evidence.environmentalDescriptions.length > 0) {
    lines.push(`Blocker${evidence.environmentalDescriptions.length > 1 ? "s" : ""}:\n- ${evidence.environmentalDescriptions.join("\n- ")}`);
  }
  return lines.join("\n");
}

/**
 * The first sentence of any notification about a stage whose review left environmental blockers: the broken check,
 * not the checklist. Undefined when there is nothing environmental to lead with.
 */
export function describeBrokenCheckLeadV1(evidence: EnvironmentalFailureEvidenceV1): string | undefined {
  if (evidence.environmentalDescriptions.length === 0 && evidence.failingCommand === undefined) {
    return undefined;
  }
  if (evidence.failingCommand !== undefined) {
    const where = evidence.stoppedAt ? ` — ${evidence.stoppedAt}` : "";
    return `A check is failing outside the plan's own work: \`${evidence.failingCommand}\`${where}.`;
  }
  const first = evidence.environmentalDescriptions[0]!;
  return `A blocker no implementation round can clear is standing: ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`;
}
