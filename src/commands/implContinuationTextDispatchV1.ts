/**
 * Text-mode dispatch for a `summary-only` recovery continuation
 * (workflow-robustness Part 2 item 4).
 *
 * A `summary-only` continuation's premise is "the work exists and was
 * reviewed; only the report is missing" — so the continuation must run with
 * edit permissions actually WITHHELD, not merely instructed away. This module
 * provides both halves of that guarantee:
 *
 *  - `isSummaryOnlyDispatchAvailableV1` — the per-provider capability probe
 *    mode selection feeds on (`selectImplRecoveryModeV1`): true only when the
 *    resolved provider's text mode is enforced read-only (Copilot's broker
 *    text mode grants no edit tools at all; a CLI provider qualifies only
 *    when its vendor CLI enforces read-only text mode — Claude
 *    `--permission-mode plan`, Codex `--sandbox read-only`, etc.; Antigravity/
 *    Cline, whose text mode runs every tool auto-approved, do not). When the
 *    probe is false, selection falls back to `inspect-and-complete` per the
 *    plan's rule — never an edit run carrying only a no-edits instruction.
 *
 *  - `runSummaryOnlyContinuationV1` — the dispatch itself, through the
 *    coordinator's `implContinuationReport.v1` row (provider mode `text`),
 *    wrapped in the same before/after git snapshot the CLI edit path uses so
 *    the post-run delta gate in `executeImplementationRun` can verify the
 *    no-edit premise held. The promoted transfer file is read back and
 *    deleted here; its text flows through the exact same summary shape
 *    gates, checklist merge, promotion, and staling an edit round's response
 *    gets.
 *
 * The snapshot is a backstop, not a sandbox: a provider that shells out can
 * still write files, and the ranked selection can substitute a backup whose
 * text mode is weaker than the primary's. Any observed (or unenumerable)
 * delta rejects the round as a summary-only report, quarantines the delta,
 * and escalates the mode — see the `summaryOnlyViolation` gate in
 * reviewActions.ts.
 */
import * as vscode from "vscode";
import * as path from "path";
import { createProductionTaskActionCoordinatorV1 } from "../actions/productionTaskActionRuntimeV1";
import {
  IMPL_CONTINUATION_REPORT_ACTION_KEY_V1,
  IMPL_CONTINUATION_REPORT_TRANSFER_FILENAME_V1,
  ImplContinuationReportActionInputV1,
} from "../actions/rows/implContinuationReportRowV1";
import { ImplementationRunResult } from "../runners/copilotImplementationRunner";
import { isCliTextModeGuaranteedReadOnlyV1 } from "../runners/cliAgentRunner";
import { resolveEffectiveProvider } from "../runners/runnerRegistry";
import { resolveEffectiveStageChainV1 } from "../utils/modelSelection";
import {
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  changedStageResponsePathsSince,
  resolveStageResponseScope,
  snapshotStageResponseState,
} from "../utils/stageResponseScope";
import { TaskStage } from "../types/taskProgress";

/**
 * Whether a `summary-only` continuation can currently be dispatched with edit
 * permissions actually withheld. `modelId` is the model the dispatch would
 * resolve against; when omitted, the impl stage's effective primary is probed
 * (the transition-time caller, `beginImplementationRecoveryV1`, has no
 * per-task model resolution in scope). Unresolvable/unconfigured models probe
 * false — the enforceable fallback (`inspect-and-complete`) is always the
 * safe answer when the capability cannot be proven.
 */
export function isSummaryOnlyDispatchAvailableV1(modelId?: string): boolean {
  try {
    const resolvedId = modelId ?? resolveEffectiveStageChainV1("impl").primary;
    const effective = resolveEffectiveProvider(resolvedId);
    if (effective.kind === "copilot") {
      // Broker-mediated text mode: the request-local session has no edit
      // tools at all, so the no-edit premise is enforced by construction.
      return true;
    }
    return isCliTextModeGuaranteedReadOnlyV1(effective.def);
  } catch {
    return false;
  }
}

const RUNNER_ID_V1 = "impl-continuation-text";

function failedResult(
  errorMessage: string,
  extra?: Partial<ImplementationRunResult>
): ImplementationRunResult & { runnerId: string } {
  return {
    status: "failed",
    filesChanged: [],
    failureKind: "generic",
    errorMessage,
    runnerId: RUNNER_ID_V1,
    ...extra,
  };
}

export interface SummaryOnlyContinuationOptionsV1 {
  readonly taskFolderUri: vscode.Uri;
  readonly workspaceUri: vscode.Uri;
  /** The fully-built continuation prompt (summary-only mandate included). */
  readonly prompt: string;
  readonly modelId: string | undefined;
  /** The task's actual current stage, for row eligibility. */
  readonly taskStage: TaskStage;
  readonly token: vscode.CancellationToken;
  readonly onProgress: (message: string) => void;
}

/**
 * Run the summary-only continuation in text mode and shape the outcome as an
 * `ImplementationRunResult` so every downstream gate in
 * `executeImplementationRun` (shape gate, delta gate, promotion, staling)
 * applies to it unchanged.
 */
export async function runSummaryOnlyContinuationV1(
  options: SummaryOnlyContinuationOptionsV1
): Promise<
  ImplementationRunResult & {
    runnerId: string;
    providerLabel?: string;
    storedModelId?: string;
  }
> {
  let rootId: string;
  let taskBindingId: string;
  try {
    rootId = ensureWorkflowTaskFolderRootV1(options.taskFolderUri.fsPath);
    const verified = getVerifiedTaskBindingIdV1(rootId);
    if (!verified) {
      return failedResult(
        "This task's ownership binding could not be verified — its task-progress.json needs recovery " +
          "before the continuation report can run."
      );
    }
    taskBindingId = verified;
  } catch (error) {
    return failedResult(error instanceof Error ? error.message : String(error));
  }

  let chatDocumentId: string;
  try {
    const identity = await readChatDocumentIdentityV1(
      options.taskFolderUri.fsPath,
      options.taskFolderUri.fsPath
    );
    chatDocumentId = identity?.documentId ?? allocateHex128IdV1();
  } catch {
    chatDocumentId = allocateHex128IdV1();
  }

  options.onProgress("Producing the missing implementation report (no edits)...");

  // The same before/after fingerprint snapshot the CLI edit path uses — the
  // delta gate's evidence that the no-edit premise held. The scope factory
  // only needs a stage with a defined artifact filename; the snapshot itself
  // reads nothing stage-specific.
  const scope = await resolveStageResponseScope(
    options.workspaceUri,
    options.taskFolderUri,
    "impl"
  );
  const before = await snapshotStageResponseState(scope);

  const fileStore = getWorkflowFileStoreV1();
  const targetLocator = {
    rootId,
    relativePath: IMPL_CONTINUATION_REPORT_TRANSFER_FILENAME_V1,
  };
  // A leftover transfer file from a crashed earlier attempt is replaced
  // exactly; otherwise the write is create-exclusive.
  const statResult = await fileStore.stat(targetLocator);
  const baselineRevision =
    statResult.kind === "ok" && statResult.value.kind === "file"
      ? statResult.value.revision
      : undefined;

  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: options.workspaceUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId: options.modelId, stage: "impl" }),
    // The no-edit premise this dispatch exists to enforce must hold for
    // whichever candidate actually runs, not only the one probed at
    // selection time (review blocker, 2026-08-14): a write-capable backup
    // (Cline/Antigravity) must never be reserved in place of a read-only
    // primary. See the option's own doc comment.
    requireGuaranteedReadOnlyText: true,
  });
  const validatedInput: ImplContinuationReportActionInputV1 = {
    prompt: options.prompt,
    targetLocator,
    ...(baselineRevision !== undefined ? { baselineRevision } : {}),
  };
  const outcome = await coordinator.executeAction({
    actionKey: IMPL_CONTINUATION_REPORT_ACTION_KEY_V1,
    taskBinding: { taskBindingId, chatDocumentId },
    taskStatus: "active",
    taskStage: options.taskStage,
    rawInput: validatedInput as unknown as Record<string, unknown>,
    cancellationToken: options.token,
  });

  // Delta AFTER the provider ran, filtered to exclude the task folder's own
  // files: the transfer artifact, chat/interaction transactions, and retry
  // audit logs all legitimately land there during the run and are workflow
  // bookkeeping, not workspace edits the mode forbids.
  const after = before ? await snapshotStageResponseState(scope) : undefined;
  const filesChangedUnknown = before === undefined || after === undefined;
  const taskFolderPrefix = (
    path
      .relative(scope.gitRootFsPath ?? options.workspaceUri.fsPath, options.taskFolderUri.fsPath)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
  );
  const filesChanged = filesChangedUnknown
    ? []
    : changedStageResponsePathsSince(before, after).filter(
        (file) =>
          taskFolderPrefix.length === 0 ||
          (file !== taskFolderPrefix && !file.startsWith(`${taskFolderPrefix}/`))
      );

  if (outcome.kind === "completed") {
    const transferUri = vscode.Uri.file(
      path.join(options.taskFolderUri.fsPath, IMPL_CONTINUATION_REPORT_TRANSFER_FILENAME_V1)
    );
    let summary: string;
    try {
      summary = new TextDecoder().decode(await vscode.workspace.fs.readFile(transferUri));
    } catch (error) {
      return failedResult(
        `The continuation report completed but its transfer file could not be read back: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { filesChanged, filesChangedUnknown }
      );
    }
    try {
      await vscode.workspace.fs.delete(transferUri);
    } catch {
      // Best-effort cleanup; a leftover transfer file is replaced exactly on
      // the next dispatch (baselineRevision above).
    }
    return {
      status: "completed",
      summary,
      filesChanged,
      filesChangedUnknown,
      runnerId: RUNNER_ID_V1,
      ...(outcome.provider
        ? {
            providerLabel: outcome.provider.providerLabel,
            storedModelId: outcome.provider.storedModelId,
          }
        : {}),
    };
  }
  if (outcome.kind === "cancelled") {
    return { status: "cancelled", filesChanged, filesChangedUnknown, runnerId: RUNNER_ID_V1 };
  }
  if (outcome.kind === "questions") {
    return failedResult(
      "The continuation report run returned structured questions instead of the report. " +
        "Rerun the implementation to retry the continuation.",
      { filesChanged, filesChangedUnknown }
    );
  }
  if (outcome.kind === "unavailable") {
    return failedResult(outcome.code, {
      failureKind: "temporarily-unavailable",
      filesChanged,
      filesChangedUnknown,
    });
  }
  const code = "code" in outcome ? String(outcome.code) : outcome.kind;
  return failedResult(`The continuation report run did not complete (${code}).`, {
    filesChanged,
    filesChangedUnknown,
  });
}

/**
 * Prompt for the report-only follow-up this module's `runSealedEditContinuationReportV1`
 * dispatches after a sealed edit already applied its plan (workflow-robustness
 * Part 5 item 5). Unlike `buildImplementationContinuationPromptV1`'s
 * `summary-only` notice — written for a PRIOR round that failed to report —
 * this names the round that just ran and the exact files its receipts
 * already changed, so the model reports on committed work rather than
 * re-narrating or re-planning it.
 */
export function buildSealedEditReportPromptV1(
  basePrompt: string,
  changedPaths: readonly string[]
): string {
  const fileList =
    changedPaths.length > 0 ? changedPaths.map((file) => `- ${file}`) : ["- _none recorded_"];
  return (
    basePrompt +
    [
      "",
      "",
      "## Continuation Notice — report for the applied sealed edit",
      "",
      "The edit plan for this round has ALREADY been applied via the sealed edit",
      "pipeline — the files below are already changed on disk. This round must",
      "NOT propose or make any further edits: it produces ONLY the report the",
      "applied plan owes — `## Files Changed` covering exactly the files listed",
      "below, `## Verification`, and the plan checklist echo with every box the",
      "applied changes complete. Do not defer any part of the report to a later",
      "turn: this round gets no follow-up turn.",
      "",
      "Files changed by the applied edit plan:",
      ...fileList,
    ].join("\n")
  );
}

export interface SealedEditReportOptionsV1 {
  readonly taskFolderUri: vscode.Uri;
  readonly workspaceUri: vscode.Uri;
  /** The original edit prompt the sealed round itself was invoked with. */
  readonly basePrompt: string;
  /** The receipted change set the sealed round's execution actually applied. */
  readonly changedPaths: readonly string[];
  readonly modelId: string | undefined;
  readonly taskStage: TaskStage;
  readonly token: vscode.CancellationToken;
  readonly onProgress: (message: string) => void;
}

/**
 * Request the missing report for a sealed edit round that already applied
 * its plan (workflow-robustness Part 5 item 5). Dispatches through the exact
 * same text-mode, edit-permissions-withheld mechanism `runSummaryOnlyContinuationV1`
 * uses for a recovery continuation, so the returned `summary` is model-authored
 * (never `summaryIsSynthetic`) and can be shape-gated and checklist-merged by
 * `executeImplementationRun` exactly like an ordinary implementation round —
 * the only path that can ever tick the plan's own checkboxes.
 *
 * Callers MUST still fall back to the sealed pipeline's own synthetic summary
 * when this does not cleanly succeed (failed/cancelled/questions outcome, or
 * a report that itself changed — or may have changed — files): the sealed
 * edit's completion is not contingent on this follow-up, only its checklist
 * bookkeeping is.
 */
export async function runSealedEditContinuationReportV1(
  options: SealedEditReportOptionsV1
): Promise<
  ImplementationRunResult & { runnerId: string; providerLabel?: string; storedModelId?: string }
> {
  return runSummaryOnlyContinuationV1({
    taskFolderUri: options.taskFolderUri,
    workspaceUri: options.workspaceUri,
    prompt: buildSealedEditReportPromptV1(options.basePrompt, options.changedPaths),
    modelId: options.modelId,
    taskStage: options.taskStage,
    token: options.token,
    onProgress: options.onProgress,
  });
}
