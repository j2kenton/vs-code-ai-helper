/** A failed completion-lint result can have no failed command rows (for example, editor diagnostics). */
export function deterministicFixOutcomeV1(args: {
  readonly passed: boolean;
  readonly fixedCount: number;
  readonly failedCommands: readonly string[];
}): { readonly kind: "success" | "failure" | "no-fix"; readonly handback?: string } {
  if (args.passed) {
    return args.fixedCount > 0 ? { kind: "success" } : { kind: "no-fix" };
  }

  const failures = args.failedCommands.length > 0
    ? ` Publish Checks still fail: ${args.failedCommands.join(", ")}.`
    : "Completion lint still fails, but reported no failing command identity.";
  const action = args.fixedCount > 0
    ? "Review the changes and fix the remaining issues, then run Publish Checks."
    : "Fix the reported issues, then run Publish Checks.";
  return {
    kind: "failure",
    handback: args.fixedCount > 0
      ? `Deterministic fixes were applied, but${failures} ${action}`
      : `No automatic fixes were available. ${failures.trimStart()} ${action}`,
  };
}
