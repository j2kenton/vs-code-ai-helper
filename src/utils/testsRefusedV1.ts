import { AllowedTestCommandV1 } from "./allowedTestCommandV1";

/**
 * bugs4 item 16 / Step 21: a test command the provider refused is not a test that failed.
 * The editing-round prompts tell the round to say so in its summary
 * ("tests could not run: the provider refused the command <command>"); this reads that
 * statement back so the run log, the outcome and the card can name the cause and the
 * remedies, and so later gates can tell "nothing could produce a report" from "tests failed".
 *
 * The CLI parsers do not expose the provider's structured permission-denial events, so the
 * round's own statement is the only source. Read-only: nothing here writes a permission file.
 */

export interface TestsRefusedV1 {
  /** Commands the round reported as refused, in the order stated, de-duplicated. */
  readonly commands: readonly string[];
}

const REFUSAL_STATEMENT_V1 =
  /tests?\s+could\s+not\s+run\b[:\s—–-]*(?:the\s+provider\s+)?(?:refused|declined|denied|blocked|required\s+approval\s+for)\b(?:\s+(?:the\s+)?command)?\s*(.*)$/i;

/** A line that says a command was refused / needs approval, without the canonical prefix. */
const LOOSE_REFUSAL_V1 =
  /\b(?:was\s+refused|were\s+refused|requires?\s+approval|approval\s+was\s+refused|permission\s+(?:was\s+)?denied|not\s+allowed\s+by\s+the\s+(?:project|provider))\b/i;

/** A backticked command that looks like it runs tests. */
const TEST_COMMAND_V1 = /\b(?:test|tests|vitest|jest|mocha|pytest|--test)\b/i;

function backtickedV1(text: string): string[] {
  const found: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const command = match[1]!.trim();
    if (command.length > 0) found.push(command);
  }
  return found;
}

/**
 * The test commands an editing round's summary says the provider refused, or undefined when it
 * reports none. Tests that ran and failed are not matched: only a refusal statement counts.
 */
export function detectTestsRefusedV1(summary: string): TestsRefusedV1 | undefined {
  const commands: string[] = [];
  const add = (command: string): void => {
    const cleaned = command.replace(/[.;,]+$/, "").trim();
    if (cleaned.length > 0 && !commands.includes(cleaned)) commands.push(cleaned);
  };
  for (const rawLine of summary.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const canonical = REFUSAL_STATEMENT_V1.exec(line);
    if (canonical) {
      const rest = canonical[1] ?? "";
      const quoted = backtickedV1(rest);
      if (quoted.length > 0) {
        quoted.forEach(add);
      } else if (rest.trim().length > 0) {
        add(rest.replace(/^["'<]|[">']$/g, ""));
      } else {
        const inLine = backtickedV1(line);
        inLine.forEach(add);
        if (inLine.length === 0) add("(command not named)");
      }
      continue;
    }
    if (LOOSE_REFUSAL_V1.test(line)) {
      for (const command of backtickedV1(line)) {
        if (TEST_COMMAND_V1.test(command)) add(command);
      }
    }
  }
  return commands.length > 0 ? { commands } : undefined;
}

/** What the owner can do about a refused test command; Ensemble never edits permissions itself. */
export function formatTestsRefusedRemedyV1(refused: TestsRefusedV1, allowed?: AllowedTestCommandV1): string {
  const listed = refused.commands.slice(0, 5).map((command) => `\`${command}\``).join(", ");
  const more = refused.commands.length > 5 ? ` and ${refused.commands.length - 5} more` : "";
  const remedies: string[] = [];
  if (allowed) {
    remedies.push(
      allowed.allowedByProjectRules
        ? `run the project's allowed targeted form, \`${allowed.template}\``
        : `run \`${allowed.template}\` (the project's allow rules may not cover it yet)`
    );
  }
  remedies.push("add an allow rule for the test command to your project's Claude settings (your choice; Ensemble never edits permissions)");
  remedies.push("run the round on a provider that can run it, or run the tests yourself and record the run");
  return (
    `The provider refused the test command${refused.commands.length === 1 ? "" : "s"} ${listed}${more}. ` +
    "That is a refused command, not a test failure: the work was built, but no passing test report exists, " +
    "so test-dependent items stay provisional. To get the report: " +
    remedies.map((remedy, index) => `(${index + 1}) ${remedy}`).join("; ") +
    "."
  );
}

/** Run-log section recording the refusal as its own result, separate from failed tests. */
export function formatTestsRefusedSectionV1(refused: TestsRefusedV1): string {
  return (
    "\n\n## Tests could not run (testsRefused)\n\n" +
    "The round reported that the provider refused these test commands. This is recorded separately from " +
    "tests that ran and failed:\n\n" +
    refused.commands.map((command) => `- \`${command}\``).join("\n") +
    "\n"
  );
}
