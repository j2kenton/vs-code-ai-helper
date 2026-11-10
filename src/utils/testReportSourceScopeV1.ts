/**
 * review2 Step 10 (bugs6 item 25): when is a recorded test report's source snapshot "truncated"?
 *
 * A report snapshots the workspace files its test exercised. The old rule marked every report truncated as soon as
 * the task's scope held more than 100 files, whatever the test actually depended on, so a test over three files
 * was distrusted because an unrelated 150-file change existed. The flag now means one thing: a file the test itself
 * depends on was not captured.
 */

/** The files to snapshot, in order: every report's own files first (so the 100-file cap never cuts one), then the rest. */
export function orderSourceFilesForReportsV1(
  ownFilesPerReport: readonly (readonly string[])[],
  scopedFiles: readonly string[]
): string[] {
  const normalize = (file: string): string => file.replace(/\\/g, "/");
  return [...new Set([...ownFilesPerReport.flat(), ...scopedFiles].map(normalize))];
}

/**
 * Whether one report's source files were cut.
 *
 * - `ownFiles` (the test files, their direct imports and the test-run config, from the report's dependency states)
 *   known: truncated only if one of them was not captured.
 * - `ownFiles` unknown (the command names no resolvable test file, so what it runs is not known): the old
 *   conservative rule, because nothing says which of the scoped files it exercised.
 */
export function reportSourceFilesTruncatedV1(input: {
  readonly ownFiles: readonly string[];
  readonly scopedFileCount: number;
  readonly capturedPaths: ReadonlySet<string>;
  readonly cap: number;
}): boolean {
  if (input.ownFiles.length > 0) {
    return input.ownFiles.some((file) => !input.capturedPaths.has(file.replace(/\\/g, "/")));
  }
  return (
    input.scopedFileCount > input.cap ||
    input.scopedFileCount === 0 ||
    input.capturedPaths.size !== Math.min(input.scopedFileCount, input.cap)
  );
}
