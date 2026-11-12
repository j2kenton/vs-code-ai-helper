import type { TestFailureV1 } from "./testFailuresV1";

/**
 * bugs7 item 5 (Steps 15 and 16): when the Publish Checks run made for test evidence FAILS, the card names the failing
 * tests (file and test name) and says, for each, whether it touches what the task changed. A failure in the task's own
 * area is the task's breakage and is fixed by a round; a failure that names none of the task's files is only called a
 * probable flake when the known-flake record lists it (Ensemble does not re-run the test here), and otherwise says no
 * link to the task's changes was found. A failure that names no changed file is never called "unrelated".
 */

export type EvidenceRunFailureClassV1 = "touches-task" | "probable-flake" | "no-link";

export interface ClassifiedEvidenceRunFailureV1 extends TestFailureV1 {
  readonly classification: EvidenceRunFailureClassV1;
  /** The changed files the failure's test file, name or message names (for "touches-task"). */
  readonly touches: readonly string[];
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function baseName(file: string): string {
  return normalize(file).split("/").pop() ?? "";
}

/**
 * The changed files a failure names: its own test file (source or compiled), or a changed file's path, or its file
 * name, found in the failure's name or assertion. Short generic base names (under 5 characters) are not enough alone.
 */
export function changedFilesNamedByFailureV1(failure: TestFailureV1, changedFiles: readonly string[]): string[] {
  // The complete message and stack (`detail`) are read before any shortening: a stack frame can be the only place a
  // changed source file is named.
  const text = normalize(`${failure.name} ${failure.assertion ?? ""} ${failure.detail ?? ""}`);
  const own = failure.file ? normalize(failure.file).replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/^(?:out|dist)\//, "src/") : undefined;
  const named: string[] = [];
  for (const changed of changedFiles) {
    const path = normalize(changed);
    const stem = path.replace(/\.(?:[cm]?[jt]sx?)$/, "");
    const base = baseName(path);
    const ownMatch = own !== undefined && (stem === own || stem.endsWith(`/${own}`) || own.endsWith(`/${stem}`));
    const textMatch = text.includes(path) || (base.length >= 5 && text.includes(base));
    if (ownMatch || textMatch) named.push(changed);
  }
  return named;
}

export function classifyEvidenceRunFailuresV1(input: {
  readonly failures: readonly TestFailureV1[];
  readonly changedFiles: readonly string[];
  /** Test file base names or test names the known-flake record lists. */
  readonly knownFlakes?: readonly string[];
}): ClassifiedEvidenceRunFailureV1[] {
  const flakes = (input.knownFlakes ?? []).map((flake) => flake.toLowerCase());
  return input.failures.map((failure) => {
    const touches = changedFilesNamedByFailureV1(failure, input.changedFiles);
    if (touches.length > 0) return { ...failure, classification: "touches-task", touches };
    const file = failure.file ? baseName(failure.file) : "";
    const listed = flakes.some((flake) => (file !== "" && file.includes(flake)) || failure.name.toLowerCase().includes(flake));
    return { ...failure, classification: listed ? "probable-flake" : "no-link", touches: [] };
  });
}

export function describeEvidenceRunFailureClassV1(failure: ClassifiedEvidenceRunFailureV1): string {
  switch (failure.classification) {
    case "touches-task":
      return `touches this task's changes (${failure.touches.slice(0, 3).join(", ")})`;
    case "probable-flake":
      return "probable flake (on the known-flake record, no link to this task's changes)";
    case "no-link":
      return "no link to this task's changes found";
  }
}

/** One card line per failing test: file, test name, and how it relates to the task's changes. */
export function describeEvidenceRunFailuresV1(failures: readonly ClassifiedEvidenceRunFailureV1[], max = 6): string[] {
  const lines = failures.slice(0, max).map((failure) => {
    const where = failure.file ? `${failure.file}: ` : "";
    return `- ${where}${failure.name} — ${describeEvidenceRunFailureClassV1(failure)}`;
  });
  if (failures.length > max) lines.push(`…and ${failures.length - max} more failing tests.`);
  return lines;
}
