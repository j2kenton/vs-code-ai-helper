import * as fs from "fs/promises";
import * as path from "path";

export const OWNER_EVIDENCE_ANSWER_MARKER_V1 = "<!-- ensemble:owner-evidence-answer -->";

export class OwnerEvidenceSubmissionErrorV1 extends Error {
  constructor(
    readonly phase: "write" | "review",
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "OwnerEvidenceSubmissionErrorV1";
  }
}

function fencedAnswer(answer: string): string {
  const runs = answer.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}\n${answer}\n${fence}`;
}

/** Append an owner's answer without normalizing or truncating pasted output. */
export async function appendOwnerEvidenceV1(
  taskFolderPath: string,
  blocker: string,
  answer: string,
  date = new Date().toISOString().slice(0, 10)
): Promise<void> {
  const taskPath = path.join(taskFolderPath, "task.md");
  const original = await fs.readFile(taskPath, "utf8");
  const subsection = `### ${date}\n\nBlocker answered:\n> ${blocker.replace(/\r?\n/g, "\n> ")}\n\n${fencedAnswer(answer)}\n`;
  const heading = /^## Owner evidence[ \t]*$/m;
  if (heading.test(original)) {
    const match = heading.exec(original)!;
    const insertAt = match.index + match[0].length;
    const before = original.slice(0, insertAt);
    const after = original.slice(insertAt).replace(/^\s*/, "");
    await fs.writeFile(taskPath, `${before}\n\n${subsection}\n\n${after}`);
    return;
  }
  const draftHeading = /^## Draft with AI[ \t]*$/m;
  if (draftHeading.test(original)) {
    const match = draftHeading.exec(original)!;
    await fs.writeFile(taskPath, `${original.slice(0, match.index)}## Owner evidence\n\n${subsection}\n\n${original.slice(match.index)}`);
    return;
  }
  await fs.writeFile(taskPath, `${original.replace(/\s*$/, "")}\n\n## Owner evidence\n\n${subsection}\n`);
}

/**
 * review1 Step 40: records an owner's answer to an owner-decision blocker under `## Owner decisions` in task.md,
 * dated, with the blocker id, the blocker text and the answer. Reviews read task.md as the owner's own words, so a
 * decision recorded here is one they treat as settled (a plan line saying "owner decision" proves nothing by
 * itself). Returns false, writing nothing, when task.md cannot be read or the same answer is already recorded.
 */
export async function appendOwnerDecisionV1(
  taskFolderPath: string,
  decision: { readonly blockerId: string; readonly blockerText: string; readonly answer: string },
  date = new Date().toISOString().slice(0, 10)
): Promise<boolean> {
  const taskPath = path.join(taskFolderPath, "task.md");
  let original: string;
  try {
    original = await fs.readFile(taskPath, "utf8");
  } catch {
    return false;
  }
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
  const entry =
    `### ${date} — ${decision.blockerId}\n\n` +
    `Blocker answered:\n> ${oneLine(decision.blockerText)}\n\n` +
    `Owner's answer: ${oneLine(decision.answer)}\n`;
  if (original.includes(entry)) return false;
  const heading = /^## Owner decisions[ \t]*$/im;
  const existing = heading.exec(original);
  if (existing) {
    const insertAt = existing.index + existing[0].length;
    const after = original.slice(insertAt).replace(/^\s*/, "");
    await fs.writeFile(taskPath, `${original.slice(0, insertAt)}\n\n${entry}\n${after}`);
    return true;
  }
  const draftHeading = /^## Draft with AI[ \t]*$/m;
  const draft = draftHeading.exec(original);
  if (draft) {
    await fs.writeFile(taskPath, `${original.slice(0, draft.index)}## Owner decisions\n\n${entry}\n${original.slice(draft.index)}`);
    return true;
  }
  await fs.writeFile(taskPath, `${original.replace(/\s*$/, "")}\n\n## Owner decisions\n\n${entry}`);
  return true;
}

/** The heading line every recorded owner-run command starts with; the rubric tells reviewers to look for it. */
export const OWNER_RUN_COMMAND_HEADING_V1 = "Owner-run command (run by the owner outside this task; not run by Ensemble or an agent)";

export interface OwnerRunCommandRecordV1 {
  /** The blocker's lineage id (the same id owner cards and `[same:<id>]` use), when one is known. */
  readonly blockerLineageId?: string;
  readonly command: string;
  readonly exitCode: number;
  /** When the owner recorded it (ISO). */
  readonly recordedAt: string;
  /** The last lines of the output, as the owner pasted them. */
  readonly outputTail?: string;
}

/** The owner-run record as `## Owner evidence` shows it, with attribution and the blocker it answers. */
export function formatOwnerRunCommandAnswerV1(record: OwnerRunCommandRecordV1): string {
  return [
    OWNER_RUN_COMMAND_HEADING_V1,
    ...(record.blockerLineageId ? [`Blocker lineage id: ${record.blockerLineageId}`] : []),
    `Command: ${record.command}`,
    `Exit code: ${record.exitCode} (${record.exitCode === 0 ? "passed" : "failed"})`,
    `Recorded by the owner at: ${record.recordedAt}`,
    ...(record.outputTail && record.outputTail.trim().length > 0 ? ["Output tail:", record.outputTail.trim()] : []),
  ].join("\n");
}

/**
 * review1 Step 50: records a command the owner ran outside the task against the blocker it answers, under
 * `## Owner evidence` in task.md. Attributed to the owner (a reviewer may still disagree, but must cite this
 * record) and bound to the blocker's lineage id, so a re-raise is visibly a disagreement and not a fresh finding.
 */
export async function appendOwnerRunCommandV1(
  taskFolderPath: string,
  blockerText: string,
  record: OwnerRunCommandRecordV1
): Promise<void> {
  await appendOwnerEvidenceV1(
    taskFolderPath,
    blockerText,
    formatOwnerRunCommandAnswerV1(record),
    record.recordedAt.slice(0, 10)
  );
}

/** The review callback is reached only after the task.md write has completed. */
export async function appendOwnerEvidenceThenV1(
  taskFolderPath: string,
  blocker: string,
  answer: string,
  rerunReview: () => Promise<unknown>,
  date?: string
): Promise<void> {
  try {
    await appendOwnerEvidenceV1(taskFolderPath, blocker, answer, date);
  } catch (error) {
    throw new OwnerEvidenceSubmissionErrorV1("write", error);
  }
  try {
    await rerunReview();
  } catch (error) {
    throw new OwnerEvidenceSubmissionErrorV1("review", error);
  }
}
