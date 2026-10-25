/**
 * Report per-check outcomes for completion lint and fix runs (Step 28 / Defect 13).
 * Classifies each previously failing check as passing, still failing, unrun, or denied.
 */

export type FixCheckStatusKindV1 = "passing" | "still failing" | "unrun" | "denied";

export interface FixCheckItemStatusV1 {
  readonly command: string;
  readonly status: FixCheckStatusKindV1;
  readonly detail?: string;
}

export interface ClassifyFixCheckStatusesOptionsV1 {
  readonly priorFailedChecks: readonly { command: string; exitCode?: number }[];
  readonly rerunFailedChecks?: readonly { command: string; exitCode?: number }[];
  readonly rerunCommandsRun?: readonly string[];
  readonly rerunExecuted: boolean;
  readonly deniedCommands?: readonly string[];
}

export interface FixCheckClassificationResultV1 {
  readonly items: readonly FixCheckItemStatusV1[];
  readonly allPassed: boolean;
  readonly hasUnrun: boolean;
  readonly hasDenied: boolean;
  readonly summary: string;
}

/**
 * Classifies each previously failing check command as passing, still failing, unrun, or denied
 * based on post-edit rerun results and sandbox denial records.
 */
export function classifyFixCheckStatusesV1(
  options: ClassifyFixCheckStatusesOptionsV1
): FixCheckClassificationResultV1 {
  const {
    priorFailedChecks,
    rerunFailedChecks = [],
    rerunCommandsRun,
    rerunExecuted,
    deniedCommands = [],
  } = options;
  const rerunFailedSet = new Set(rerunFailedChecks.map((c) => c.command));
  const deniedSet = new Set(deniedCommands);
  const rerunCommandsSet = rerunCommandsRun ? new Set(rerunCommandsRun) : undefined;

  const items: FixCheckItemStatusV1[] = priorFailedChecks.map((check) => {
    if (!rerunExecuted) {
      if (deniedSet.has(check.command)) {
        return { command: check.command, status: "denied", detail: "denied in sandbox and untested" };
      }
      return { command: check.command, status: "unrun", detail: "checks were not rerun" };
    }
    // Step 28 / Review Blocker: Classify against the commands actually executed.
    // If a check was omitted from the rerun, it must be reported as unrun, not passing.
    if (rerunCommandsSet !== undefined && !rerunCommandsSet.has(check.command)) {
      if (deniedSet.has(check.command)) {
        return { command: check.command, status: "denied", detail: "denied in sandbox and not rerun" };
      }
      return { command: check.command, status: "unrun", detail: "omitted from rerun" };
    }
    if (rerunFailedSet.has(check.command)) {
      return { command: check.command, status: "still failing" };
    }
    if (deniedSet.has(check.command)) {
      return { command: check.command, status: "denied", detail: "denied in sandbox" };
    }
    return { command: check.command, status: "passing" };
  });

  const allPassed = rerunExecuted && items.length > 0 && items.every((i) => i.status === "passing");
  const hasUnrun = items.some((i) => i.status === "unrun");
  const hasDenied = items.some((i) => i.status === "denied");
  const stillFailing = items.filter((i) => i.status === "still failing");

  let summary: string;
  if (items.length === 0) {
    summary = "No previously failing checks were recorded.";
  } else if (allPassed) {
    summary = `All previously failing checks are now passing: ${items.map((i) => i.command).join(", ")}.`;
  } else {
    const parts: string[] = [];
    const passing = items.filter((i) => i.status === "passing");
    if (passing.length > 0) {
      parts.push(`passing: ${passing.map((i) => i.command).join(", ")}`);
    }
    const failing = stillFailing.map((i) => i.command);
    if (failing.length > 0) {
      parts.push(`still failing: ${failing.join(", ")}`);
    }
    const unrun = items.filter((i) => i.status === "unrun");
    if (unrun.length > 0) {
      parts.push(`unrun/untested: ${unrun.map((i) => i.command).join(", ")}`);
    }
    const denied = items.filter((i) => i.status === "denied");
    if (denied.length > 0) {
      parts.push(`denied: ${denied.map((i) => i.command).join(", ")}`);
    }
    summary = `Checks summary: ${parts.join("; ")}.`;
  }

  return {
    items,
    allPassed,
    hasUnrun,
    hasDenied,
    summary,
  };
}

/**
 * Whether a fix's rerun leaves any prior failure unresolved: the rerun itself
 * failed, or a previously failing check is unrun, denied or otherwise not
 * proven passing. Such a fix must not read as success, write a freshness
 * stamp, or schedule the Publish review (Step 28).
 */
export function fixHasUnresolvedChecksV1(options: {
  readonly rerunPassed: boolean;
  readonly classification: FixCheckClassificationResultV1;
  readonly priorFailedCount: number;
}): boolean {
  return (
    !options.rerunPassed ||
    options.classification.hasUnrun ||
    options.classification.hasDenied ||
    (!options.classification.allPassed && options.priorFailedCount > 0)
  );
}
