import * as path from "path";
import type { TaskStage } from "../types/taskProgress";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";

/** Small, chat-safe excerpt of the post-round type-check output. */
export function prioritizeImplementationTypeCheckDiagnosticsV1(
  output: string,
  maxChars = 4000
): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  // `check-types` may print package-manager and per-package setup output
  // before the compiler errors. Preserve the first diagnostics before applying
  // the run-log/card cap, otherwise a long preamble can erase every error.
  const diagnostics = trimmed
    .split(/\r?\n/)
    .filter((line) => /\berror\s+TS\d+\b/i.test(line));
  if (diagnostics.length > 0) {
    const header = "[first TypeScript diagnostics; remaining output truncated]\n";
    let selected = header;
    for (const line of diagnostics) {
      const addition = `${line}\n`;
      if (selected.length + addition.length > maxChars) {
        if (selected === header) {
          selected += addition.slice(0, Math.max(0, maxChars - selected.length));
        }
        break;
      }
      selected += addition;
    }
    return selected.trimEnd();
  }

  return `${trimmed.slice(0, maxChars)}\n… (truncated)`;
}

export function formatImplementationTypeCheckErrorsV1(output: string, maxLines = 8): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    // `check-types` runs the root compiler and then each package compiler.
    // Its leading package-manager output can be longer than this card's line
    // budget, so select diagnostics from the complete output before limiting
    // what we show. Keep their original order to expose the first errors.
    .filter((line) => /\berror\s+TS\d+\b/i.test(line));
  const excerptLines = lines.length > 0
    ? lines.slice(0, maxLines)
    : output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(0, maxLines);
  return excerptLines.join("\n").slice(0, 1800) || "The type-check command failed without reporting error text.";
}

export function buildImplementationTypeCheckPromptNoticeV1(errors: string): string {
  return (
    "\n\n## Type-check errors from the previous Implementation round\n\n" +
    "The previous round left the project failing its type-check. Fix these reported errors before " +
    "continuing other implementation work:\n\n```text\n" +
    errors +
    "\n```\n"
  );
}

export function buildImplementationTypeCheckFailedDecisionInputV1(input: {
  readonly taskCanonicalId: string;
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly errors: string;
  readonly logFilePath: string;
}): Omit<CreateWorkflowDecisionInputV1, "decisionId" | "createdAt"> {
  return {
    decisionKey: "implementationTypeCheckFailed",
    taskCanonicalId: input.taskCanonicalId,
    stage: input.stage,
    whatHappened:
      "The Implementation round left the project failing its type-check. The errors and run log are attached below.",
    whyUserNeeded:
      "A reviewer cannot continue until the type-check passes. The round itself finished, so the usual next step is to fix the reported errors and continue to review; run another Implementation round only if you want the model to fix them.",
    evidence: [
      { label: "First type-check errors", detail: input.errors },
      { label: "Implementation run log", detail: path.basename(input.logFilePath), openFilePath: input.logFilePath },
    ],
    options: [
      {
        optionId: "fixBuildManually",
        label: "I'll fix the type-check errors, then continue to review",
        consequence:
          "Leaves the task waiting and dispatches no work. Once the type-check passes, run Review (or Fast Forward) to continue.",
        resumeKind: "unpause",
        effect: { kind: "doNothing" },
      },
      {
        optionId: "runImplementationFix",
        label: "Run another Implementation round to fix the build",
        consequence:
          "Starts a new Implementation round with the reported type-check errors in its prompt. This re-enters a full round over the files already changed.",
        resumeKind: "continue",
        effect: {
          kind: "command",
          // Exhausted recovery pauses the task before this card is
          // posted. Resume and dispatch through the existing combined
          // command so this action works in that state.
          command: "vs-code-ai-helper.resumeAndDispatchImplementation",
          args: [{ taskFolderPath: input.taskFolderPath, implementationTypeCheckErrorsV1: input.errors }],
        },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "fixBuildManually",
      reasoning:
        "The round completed; only the type-check blocks review. Fixing the reported errors and continuing is cheaper than re-entering a full Implementation round.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: "The task remains at its current stage until the type-check passes and review can continue.",
    },
  };
}
