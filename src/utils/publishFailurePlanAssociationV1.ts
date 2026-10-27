import { PlanItemEvidenceV1 } from "../types/taskProgress";
import { extractFailingTestsV1 } from "./failingTestsV1";

export interface PublishPlanFailureV1 {
  readonly command: string;
  readonly output: string;
}

export interface PublishFailurePlanAssociationV1 {
  readonly itemText: string;
  readonly disposition: "contradicted" | "candidate";
  readonly failures: readonly PublishPlanFailureV1[];
  readonly paths: readonly string[];
}

export interface PublishOwnerHandOffCoverageV1 {
  readonly itemText: string;
  readonly testPaths: readonly string[];
  readonly note: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

/**
 * Return the identities that can refer to one acceptance test. Publish often
 * runs the compiled Node suite from `out/test`, while implementation reports
 * the source test under `src/test`. Preserve the literal identity too, and
 * drop an absolute checkout prefix only for these known repository test
 * roots so absolute and relative report paths compare consistently.
 */
function pathIdentities(value: string): string[] {
  const normalized = normalizePath(value);
  const identities = new Set([normalized]);
  const compiled = /(?:^|\/)out\/test\/(.+\.test)\.js$/.exec(normalized);
  if (compiled?.[1]) identities.add(`src/test/${compiled[1]}.ts`);
  const source = /(?:^|\/)src\/test\/(.+\.test)\.ts$/.exec(normalized);
  if (source?.[1]) identities.add(`src/test/${source[1]}.ts`);
  return [...identities];
}

function addFailurePathIdentity(paths: Set<string>, value: string): void {
  for (const identity of pathIdentities(value)) paths.add(identity);
}

function intersectsPathIdentities(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.some((path) => pathIdentities(path).some((identity) => right.has(identity)));
}

/** Compare a persisted acceptance-test identity with Publish failure paths. */
export function publishFailureMatchesTestIdentityV1(
  identity: string,
  failurePaths: ReadonlySet<string>
): boolean {
  return intersectsPathIdentities([identity], failurePaths);
}

export function extractPublishFailurePathsV1(failure: PublishPlanFailureV1): ReadonlySet<string> {
  const paths = new Set<string>();
  const expression = /(?:^|[\s'"`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?::\d+(?::\d+)?)?/g;
  const failureLine = /(?:^|\b)(?:FAIL(?:ED)?\b|ERROR\b|error\s+TS\d+|✖|AssertionError\b|failed\b)/i;
  for (const test of extractFailingTestsV1(failure.output).tests) {
    if (test.file) addFailurePathIdentity(paths, test.file);
  }
  for (const line of failure.output.split(/\r?\n/)) {
    const indexedFailure = /^\s*-\s+(.+?):\s+/.test(line);
    if (!failureLine.test(line) && !indexedFailure) continue;
    for (const match of line.matchAll(expression)) {
      if (match[1]) addFailurePathIdentity(paths, match[1]);
    }
  }
  return paths;
}

/**
 * Relates failed Publish checks to checked plan items through actual failing
 * test identities. Source-file overlap is retained as a candidate only: it
 * cannot establish that an incidental path mention is a failed acceptance.
 */
export function associatePublishFailuresWithPlanItemsV1(input: {
  readonly checkedItems: readonly string[];
  readonly evidence: readonly PlanItemEvidenceV1[];
  readonly failures: readonly PublishPlanFailureV1[];
  readonly ownerHandOffCoverage?: readonly PublishOwnerHandOffCoverageV1[];
}): readonly PublishFailurePlanAssociationV1[] {
  const evidenceByText = new Map(input.evidence.map((record) => [record.itemText, record]));
  const matchedByFailure = input.failures.map((failure) => {
    const failurePaths = extractPublishFailurePathsV1(failure);
    if (failurePaths.size === 0) return { failure, paths: failurePaths, items: [] as string[] };
    const items = input.checkedItems.filter((item) => {
      const record = evidenceByText.get(item);
      const reports = record?.testReports ?? [];
      const evidencePathMatch = reports.some((report) => {
        const reportPaths = [
          report.testIdentity,
          ...(report.sourceFiles ?? []),
          ...(report.sourceFileStates ?? []).map((state) => state.path),
        ];
        return intersectsPathIdentities(reportPaths, failurePaths);
      });
      const ownerCoverageMatch = (input.ownerHandOffCoverage ?? []).some((coverage) =>
        coverage.itemText === item && intersectsPathIdentities(coverage.testPaths, failurePaths)
      );
      return evidencePathMatch || ownerCoverageMatch;
    });
    return { failure, paths: failurePaths, items };
  });
  const implicated = new Map<string, { failures: PublishPlanFailureV1[]; paths: Set<string> }>();
  for (const row of matchedByFailure) {
    for (const item of row.items) {
      const entry = implicated.get(item) ?? { failures: [], paths: new Set<string>() };
      entry.failures.push(row.failure);
      for (const path of row.paths) entry.paths.add(path);
      implicated.set(item, entry);
    }
  }
  return [...implicated].map(([itemText, data]) => ({
    itemText,
    disposition: data.failures.some((failure) => {
      const row = matchedByFailure.find((candidate) => candidate.failure === failure);
      if ((row?.items.length ?? 0) > 1) return true;
      const record = evidenceByText.get(itemText);
      const exactAcceptanceMatch = (record?.testReports ?? []).some((report) =>
        intersectsPathIdentities([report.testIdentity], row?.paths ?? new Set())
      );
      return !exactAcceptanceMatch;
    }) ? "candidate" : "contradicted",
    failures: data.failures,
    paths: [...data.paths].sort(),
  }));
}

/**
 * Read explicit `Covers: Step N` links in task.md owner hand-offs. These are
 * candidate associations because hand-off text supplies scope provenance,
 * while the failed check still has to identify a path from that hand-off.
 */
export function ownerHandOffCoverageFromTaskMdV1(
  taskMd: string,
  checkedItems: readonly string[]
): readonly PublishOwnerHandOffCoverageV1[] {
  const blocks = taskMd.split(/(?=^\s*- \*\*)/m);
  const result: PublishOwnerHandOffCoverageV1[] = [];
  const pathExpression = /(?:^|[\s'"`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?::\d+(?::\d+)?)?/g;
  for (const block of blocks) {
    const steps = [...block.matchAll(/\bCovers:\s*Step\s+(\d+)\b/gi)].map((match) => Number(match[1]));
    if (steps.length === 0) continue;
    const paths = new Set<string>();
    for (const match of block.matchAll(pathExpression)) if (match[1]) paths.add(normalizePath(match[1]));
    if (paths.size === 0) continue;
    for (const step of steps) {
      const itemText = checkedItems.find((item) => new RegExp(`\\bStep\\s+${step}\\b`, "i").test(item));
      if (!itemText) continue;
      result.push({
        itemText,
        testPaths: [...paths],
        note: `task.md owner hand-off explicitly Covers: Step ${step}`,
      });
    }
  }
  return result;
}

export function formatPublishFailurePlanAssociationsV1(
  associations: readonly PublishFailurePlanAssociationV1[]
): string {
  if (associations.length === 0) return "";
  return [
    "## Checklist items related to failed Publish checks",
    "",
    ...associations.map((association) => {
      const status = association.disposition === "candidate" ? "candidate association" : "contradicted by the failure evidence";
      const failures = association.failures.map((failure) => `\`${failure.command}\``).join(", ");
      return `- ${association.itemText} — ${status}; failed check(s): ${failures}; paths: ${association.paths.join(", ")}`;
    }),
    "",
  ].join("\n");
}
