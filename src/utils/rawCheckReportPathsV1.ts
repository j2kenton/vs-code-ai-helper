/**
 * bugs5 Step 16: where a Publish Checks run's complete raw output is written.
 *
 * Every run with failures keeps its own file, `runs/raw-check-output-<runId>.log`. The canonical
 * `runs/raw-check-output.log` always holds the LAST COMPLETED run's output: a run that was cancelled
 * writes only its own file, so a cancelled run's partial output can no longer overwrite the report
 * of an earlier completed run (the 17:13 failure in the owner's bugs4 incident).
 */
export const DEFAULT_RAW_CHECK_REPORT_V1 = "runs/raw-check-output.log";

export interface RawCheckReportPlanV1 {
  /** Task-folder-relative files to write, in order. */
  readonly writes: readonly string[];
  /** The location the run's result and failure text should point at. */
  readonly resultLocation: string;
}

export function planRawCheckReportV1(input: {
  readonly requestedLocation?: string;
  readonly cancelled: boolean;
  readonly runId: string;
}): RawCheckReportPlanV1 {
  const requested = input.requestedLocation ?? DEFAULT_RAW_CHECK_REPORT_V1;
  if (requested !== DEFAULT_RAW_CHECK_REPORT_V1) {
    // A caller-chosen location (failed-first attempts) is already isolated per attempt.
    return { writes: [requested], resultLocation: requested };
  }
  const safeId = input.runId.replace(/[^0-9A-Za-z-]/g, "-");
  const perRun = `runs/raw-check-output-${safeId}.log`;
  return input.cancelled
    ? { writes: [perRun], resultLocation: perRun }
    : { writes: [perRun, DEFAULT_RAW_CHECK_REPORT_V1], resultLocation: DEFAULT_RAW_CHECK_REPORT_V1 };
}
