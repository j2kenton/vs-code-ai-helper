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
