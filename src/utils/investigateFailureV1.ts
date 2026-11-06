/**
 * review1 Step 49: the diagnostic round behind "Investigate it for me". It is dispatched with an investigation request
 * instead of the review's blockers, in the provider's enforced read-only text mode (owner decision 2026-11-05):
 * `investigate-failure.md` is rendered from the failure, Ensemble's environment for the run, and the working-tree files
 * that belong to the task. The round answers with the diagnosis and Ensemble saves it as `evidence/diagnosis-<n>.md`.
 *
 * The request is held in memory for the dispatching call only, like the "Let the AI gather it" focus: the
 * dispatcher sets it before it dispatches and clears it in a `finally`. A window restart loses it on purpose; the
 * next dispatch is then an ordinary Apply Review.
 *
 * Pure: no `vscode`, no I/O.
 */

export interface InvestigationRequestV1 {
  /** The failing command, where it stopped and the output tail (`formatFailureReportV1`). */
  readonly failure: string;
  /** Ensemble's own environment for that run (`formatEnvironmentReportV1`). */
  readonly environmentReport: string;
  /** The working-tree files that belong to the task; the round must not change or discard them. */
  readonly protectedFiles: readonly string[];
  /** Task-relative path of the file the round writes, e.g. `evidence/diagnosis-2.md`. */
  readonly diagnosisPath: string;
}

const requestByTaskV1 = new Map<string, InvestigationRequestV1>();

function keyV1(taskFolderPath: string): string {
  return taskFolderPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function setInvestigationRequestV1(taskFolderPath: string, request: InvestigationRequestV1): void {
  requestByTaskV1.set(keyV1(taskFolderPath), request);
}

export function clearInvestigationRequestV1(taskFolderPath: string): void {
  requestByTaskV1.delete(keyV1(taskFolderPath));
}

export function peekInvestigationRequestV1(taskFolderPath: string): InvestigationRequestV1 | undefined {
  return requestByTaskV1.get(keyV1(taskFolderPath));
}

/**
 * The out-of-plan fix the owner approved on the card that follows a diagnosis. The Apply Review it dispatches may
 * edit ONLY these files. Held in memory for the dispatching call only, like the investigation request.
 */
export interface ApprovedFixRequestV1 {
  readonly diagnosisPath: string;
  readonly files: readonly string[];
  readonly failure: string;
}

const approvedFixByTaskV1 = new Map<string, ApprovedFixRequestV1>();

export function setApprovedFixRequestV1(taskFolderPath: string, request: ApprovedFixRequestV1): void {
  approvedFixByTaskV1.set(keyV1(taskFolderPath), request);
}

export function clearApprovedFixRequestV1(taskFolderPath: string): void {
  approvedFixByTaskV1.delete(keyV1(taskFolderPath));
}

export function peekApprovedFixRequestV1(taskFolderPath: string): ApprovedFixRequestV1 | undefined {
  return approvedFixByTaskV1.get(keyV1(taskFolderPath));
}

/**
 * The files an approval may cover: workspace-relative, inside the workspace, and not Git internals or task
 * artifacts. A path that fails any of these is dropped, so a card built from a diagnosis can never approve an edit
 * outside the workspace.
 */
export function sanitizeApprovedFixFilesV1(files: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of files) {
    const file = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (file.length === 0) continue;
    if (/^([a-z]:|\/|~)/i.test(file)) continue;
    if (file.split("/").some((part) => part === ".." || part === ".git")) continue;
    if (file.startsWith(".ensemble/")) continue;
    if (!kept.includes(file)) kept.push(file);
  }
  return kept;
}

/** What the owner approved, in the words `task.md` records under `## Owner decisions`. */
export function describeOutOfPlanApprovalV1(request: ApprovedFixRequestV1): string {
  return (
    `Approved one out-of-plan change, limited to ${request.files.map((file) => `\`${file}\``).join(", ")}, ` +
    `as suggested in ${request.diagnosisPath}. It is not a plan step and ticks no plan item.`
  );
}

/** The block an approved-fix Apply Review is given in place of the review's blocker work. */
export function formatApprovedFixBlockV1(request: ApprovedFixRequestV1): string {
  return (
    "## Owner-approved fix (this round's only work)\n\n" +
    "A diagnostic round investigated one failing check and the owner approved the fix it suggested. This round " +
    "applies exactly that fix and nothing else. Ignore every instruction in this prompt to work on the review's " +
    "blockers or to build plan steps.\n\n" +
    `Read the diagnosis first: \`${request.diagnosisPath}\` in the task folder.\n\n` +
    `The failure it was about:\n${request.failure}\n\n` +
    "You may edit ONLY these files:\n" +
    request.files.map((file) => `- \`${file}\``).join("\n") +
    "\n\nDo not edit any other file, do not tick plan items, and do not report this as a plan deviation: the owner " +
    "approved it and `task.md` records that. After the edit, run the failing command from the diagnosis if you " +
    "can, and say in your summary what it showed. If the suggested fix does not work, say so and stop; do not widen " +
    "the change to other files.\n"
  );
}

/** `evidence/diagnosis-<n>.md` with `n` one past the highest number already in `existingNames`. */
export function nextDiagnosisPathV1(existingNames: readonly string[]): string {
  let highest = 0;
  for (const name of existingNames) {
    const match = /^diagnosis-(\d+)\.md$/i.exec(name.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `evidence/diagnosis-${highest + 1}.md`;
}

/**
 * The task's own in-flight files, normalised, deduplicated and without anything under `.ensemble/` (task
 * artifacts are not workspace code). Sorted so the prompt is stable.
 */
export function collectProtectedFilesV1(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  for (const source of sources) {
    for (const raw of source ?? []) {
      const file = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (file.length === 0 || file.startsWith(".ensemble/") || file.includes("/.ensemble/")) continue;
      seen.add(file);
    }
  }
  return [...seen].sort();
}

const PROTECTED_FILES_LISTED_MAX_V1 = 200;

export function formatProtectedFilesV1(files: readonly string[]): string {
  if (files.length === 0) {
    return "(Ensemble has no files recorded for this task yet; treat every modified file `git status` shows as protected.)";
  }
  const shown = files.slice(0, PROTECTED_FILES_LISTED_MAX_V1).map((file) => `- \`${file}\``);
  const more = files.length > PROTECTED_FILES_LISTED_MAX_V1
    ? [`- …and ${files.length - PROTECTED_FILES_LISTED_MAX_V1} more: treat every modified file \`git status\` shows as protected.`]
    : [];
  return [...shown, ...more].join("\n");
}

/** The variables `investigate-failure.md` is rendered with. */
export function investigationTemplateVariablesV1(request: InvestigationRequestV1): Record<string, string> {
  return {
    failure: request.failure,
    environmentReport: request.environmentReport,
    protectedFiles: formatProtectedFilesV1(request.protectedFiles),
    diagnosisPath: request.diagnosisPath,
  };
}

/**
 * The files a diagnosis names under its `Files to change:` line, for the card that follows. Empty when it names
 * none (or says `none`).
 */
export function parseDiagnosisFilesToChangeV1(diagnosis: string): string[] {
  const lines = diagnosis.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\W*files to change\s*:/i.test(line));
  if (start === -1) return [];
  const files: string[] = [];
  const inline = lines[start]!.replace(/^\W*files to change\s*:/i, "").trim();
  if (inline.length > 0) {
    if (/^none\b/i.test(inline)) return [];
    for (const part of inline.split(/[,;]/)) {
      const file = part.replace(/[`*]/g, "").trim();
      if (file.length > 0) files.push(file);
    }
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      if (files.length > 0) break;
      continue;
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!item) break;
    const file = item[1]!.replace(/[`*]/g, "").trim();
    if (file.length > 0 && !/^none\b/i.test(file)) files.push(file);
  }
  return [...new Set(files)];
}
