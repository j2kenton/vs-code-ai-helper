/**
 * bugs4 item 34: the Commit & Push confirmation shows at most 15 files. "View Full
 * List" used to write the rest to an output channel and END the run. It now
 * re-asks the same confirmation with every file listed in the card itself, so the
 * owner can read the list in the chat and still choose Commit & Push or Cancel.
 *
 * Pure: no vscode, no I/O.
 */

export interface CommitPushFullListMessageInputV1 {
  readonly title: string;
  readonly scopeLabel: string;
  readonly currentBranch: string;
  readonly pushDestination: string;
  /** Every file to be staged, already rendered for display (with any run-artifact marker). */
  readonly scopedFiles: readonly string[];
  /** Pre-rendered notes about excluded files, appended after the list. */
  readonly trailer: string;
}

export function buildFullListConfirmMessageV1(input: CommitPushFullListMessageInputV1): string {
  const list = input.scopedFiles.map((file) => `  • ${file}`).join("\n");
  return (
    `⚠️ ${input.title}\n\n` +
    `Scope: ${input.scopeLabel}\n` +
    `Branch: ${input.currentBranch}\n` +
    `Destination: ${input.pushDestination}\n\n` +
    `Full list of files to be staged (${input.scopedFiles.length} total):\n` +
    list +
    input.trailer +
    `\n\nThis is the same confirmation as before, with every file shown. Nothing has been committed and the ` +
    `checks did not run again.\n\nPushing is outward-facing and largely irreversible.\nProceed?`
  );
}

/**
 * The reason carried on the "Ended: Commit and Push" chat line for a run that did
 * not complete. Whatever produced `text` (a decline, a git error, a failed push),
 * the line says what did not happen and what to do next:
 *  - text that already says nothing was committed is kept as written;
 *  - a failed push keeps its own statement (the local commit was kept) and gains a next step;
 *  - anything else gets "Nothing was committed or pushed" and a next step added.
 */
export function describeCommitPushEndedForChatV1(reason: string, text: string): string {
  const base = text.trim().replace(/[.\s]+$/, "");
  if (/nothing was committed/i.test(base)) {
    return `${base}.`;
  }
  if (reason === "pushFailed") {
    return `${base}. Fix the push problem, then choose Commit & Push again to push the local commit.`;
  }
  return `${base}. Nothing was committed or pushed. Fix that, then choose Commit & Push again.`;
}

/** The plain chat line for a Commit & Push run that ended without committing. */
export function describeCommitPushNotCommittedV1(cause: "cancelled" | "declined"): string {
  return cause === "cancelled"
    ? "Commit and push cancelled. Nothing was committed or pushed, and the working tree and index are unchanged. " +
        "Choose Commit & Push when you want to continue."
    : "Commit and push stopped at your choice. Nothing was committed or pushed. Choose Commit & Push to continue.";
}
