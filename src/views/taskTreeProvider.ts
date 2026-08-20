import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  DEFAULT_HIDDEN_STATUSES,
  IMPLEMENTATION_FILENAME,
  isReviewStage,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TASK_STATUSES,
  TaskStage,
} from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { taskOperations, taskKey, hasActiveOperationTargetingStage } from "../utils/taskOperations";
import { resolveCurrentPlanUri, statIfExists } from "../utils/fileUtils";
import { hasPreviousVersion } from "../utils/artifactBackups";
import { readRedoSidecar, isRedoAvailableFromRecord } from "../utils/redoSidecar";
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { effectiveReviewProgressV1 } from "../utils/effectiveReviewProgress";
import {
  computeReviewFreshness,
  parseReadiness,
  parseReviewedCommitSha,
  REVIEWED_COMMIT_STAGES,
  REVIEW_TARGETS,
} from "../utils/reviewReadiness";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { TaskProgressRecoveryEntryV1 } from "../services/taskProgressDiscoveryV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { buildTaskContextValue, buildStageContextValue, TaskCreationContextInput } from "../utils/contextTokens";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { buildQuotaRemedyTextV1 } from "../utils/quota";
import { getConfiguredTaskRoot, normalizePath } from "../utils/taskRoot";
import { listUncheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { WorkflowDecisionV1 } from "../types/workflowDecisionV1";

/**
 * The view ID for the tasks tree view (must match package.json)
 */
export const TASKS_VIEW_ID = "vs-code-ai-helper.tasksView";

/**
 * Task-list display order: pinned tasks first (most recently pinned first),
 * then unpinned tasks by recency (updatedAt descending) with the task
 * display name as a deterministic tiebreaker for equal timestamps.
 * Exported for direct unit testing.
 */
export function orderTasksForDisplay(visible: readonly IncompleteTask[]): IncompleteTask[] {
  const displayLabel = (t: IncompleteTask): string =>
    t.progress.displayName ?? t.folderName;
  const pinned = visible
    .filter((t) => t.progress.pinnedAt !== undefined)
    .sort((a, b) => String(b.progress.pinnedAt).localeCompare(String(a.progress.pinnedAt)));
  const unpinned = visible
    .filter((t) => t.progress.pinnedAt === undefined)
    .sort((a, b) => {
      const recency =
        new Date(b.progress.updatedAt).getTime() -
        new Date(a.progress.updatedAt).getTime();
      return recency !== 0 ? recency : displayLabel(a).localeCompare(displayLabel(b));
    });
  return [...pinned, ...unpinned];
}

/**
 * The first ACTIVE task in an already-display-ordered list — not `ordered[0]`,
 * which can be a completed or archived row (e.g. a pinned finished task) that
 * would otherwise swallow the auto-expansion while the actual working task
 * stays collapsed. Returns undefined when every task is completed/archived.
 * Exported for direct unit testing.
 */
export function firstActiveInDisplayOrder(ordered: readonly IncompleteTask[]): IncompleteTask | undefined {
  return ordered.find(
    (t) => t.progress.status !== "completed" && t.progress.status !== "archived"
  );
}

type StageStatus = "done" | "current" | "outstanding";

/**
 * Determine the status of a stage relative to a task's current stage.
 *
 * The current-stage comparison wins over `completedStages`: stages at or
 * after the current index NEVER render as done, no matter what
 * `completedStages` claims. A rollback out of Publish retracts the
 * re-entered stages on write (updateTaskProgressStage / applyReopenPolicyV1),
 * but files written before that retraction existed — and kept whole by the
 * decoder's canonicalize-to-a-prefix backfill — can still list the
 * destination stage (or every later stage) as completed. Consulting that
 * list first rendered every stage as done after a Publish rollback: no
 * current marker anywhere, as if the stage change never landed.
 *
 * `completedStages` stays in the signature (callers still pass it, and the
 * regression tests exercise stale shapes through it), but it is deliberately
 * not consulted: a stage strictly before the current one is already done by
 * position, and one at/after it must never be.
 *
 * Exported for direct unit testing.
 */
export function getStageStatus(stage: TaskStage, currentStage: TaskStage, _completedStages?: readonly TaskStage[]): StageStatus {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  const currentIndex = STAGE_ORDER.indexOf(currentStage);

  if (stageIndex === currentIndex) {
    return "current";
  }
  if (stageIndex < currentIndex) {
    return "done";
  }
  return "outstanding";
}

/**
 * Best-effort, synchronous read of plan-final.md's currently-unticked items,
 * for the `checklistProgressUnreliable` tooltip line below. A plain
 * `fs.readFileSync` rather than the async `readPlanOfRecordV1` resolver
 * (which also saves an open editor's unsaved buffer first) because
 * `TreeItem.tooltip` has no async form — `buildTaskTooltip` runs inside
 * `TaskNode`'s synchronous constructor. Display-only, so a stale read against
 * an unsaved buffer is an acceptable trade against the alternative of making
 * every tree row construction async. Swallows any read error (file missing,
 * permission issue): the tooltip degrades to the unqualified message rather
 * than throwing out of a tree render.
 */
function readOutstandingChecklistItemsForTooltipV1(
  task: IncompleteTask,
  limit: number = 5
): { items: readonly string[]; total: number } {
  try {
    const content = fs.readFileSync(
      path.join(task.folderUri.fsPath, IMPLEMENTATION_FILENAME),
      "utf8"
    );
    return listUncheckedChecklistItemTextsV1(content, limit);
  } catch {
    return { items: [], total: 0 };
  }
}

/**
 * Most-recent-first ordering for a task's pending `WorkflowDecisionV1`
 * records, so the tooltip and the "Review Pending Decision" affordance both
 * lead with whichever decision was posted last. Exported for direct unit
 * testing.
 */
export function sortPendingDecisionsByRecencyV1(
  decisions: readonly WorkflowDecisionV1[]
): WorkflowDecisionV1[] {
  return [...decisions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Build a markdown tooltip summarizing a task's full stage checklist
 */
function buildTaskTooltip(
  task: IncompleteTask,
  pendingDecisions: readonly WorkflowDecisionV1[] = []
): vscode.MarkdownString {
  const lines: string[] = [`**${task.folderName}**`, ""];

  const isPaused = task.progress.status === "paused";
  if (isPaused) {
    // A workflow-imposed pause carries its reason (e.g. an exhausted
    // provider chain, finding 4) — surfaced here so a paused-with-reason
    // task is distinguishable from one the user paused, and from a round
    // still thinking.
    lines.push(
      task.progress.pausedReason
        ? `⏸ **Paused** — ${task.progress.pausedReason}`
        : "⏸ **Paused**",
      ""
    );
  }
  if (task.progress.status === "archived") {
    lines.push("$(archive) **Archived**", "");
  }
  if (task.progress.pinnedAt) {
    lines.push("$(pinned) **Pinned**", "");
  }
  // The durable record of a quota/model-entitlement block — written whether
  // or not it also paused the whole task (a withheld-backup-switch block on
  // a dirty tree keeps the task "active" with no other visible trace; see
  // recordQuotaParkV1 vs. pauseTaskWithReason in taskProgressTransforms.ts).
  // Without this the operator had no way to see WHEN (if known) a blocked
  // model was expected to recover short of reading run logs by hand.
  if (task.progress.quotaParkRecord) {
    const park = task.progress.quotaParkRecord;
    const label =
      park.failureKind === "model-entitlement" ? "model-entitlement block" : "quota/rate limit";
    lines.push(
      `$(clock) **Blocked by a ${label}** on \`${park.modelId}\` as of ${new Date(park.observedAt).toLocaleString()}. ${buildQuotaRemedyTextV1(park.resetAt)}`,
      ""
    );
  }
  // A decision the workflow needs the user to make (task: "Replace hidden
  // notification decision buttons with explained, selectable decisions").
  // Persistent task-node state (plan PART 3) so an owed decision stays
  // visible until resolved, not only reachable by hovering a transient
  // notification. The full explained choice — what happened, why, options
  // with consequences, a recommendation — renders in Chat With AI; this line
  // is discoverability only, never the decision surface itself.
  if (pendingDecisions.length > 0) {
    for (const decision of pendingDecisions) {
      lines.push(
        `$(warning) **Decision waiting** (${STAGE_DISPLAY_NAMES[decision.stage]}) — ${decision.whatHappened} _Review it in Chat With AI._`,
        ""
      );
    }
  }
  // The completeness gate stands down for this task (see
  // checklistProgressUnreliable). Surfaced because the alternative is degrading
  // in silence: a round landed work the plan's checklist could not record, so
  // its counts understate what is done and no longer gate advancement. Without
  // this the only trace is a comment in one round's summary, long scrolled past
  // by the time the missing safety net matters.
  if (task.progress.checklistProgressUnreliable) {
    const outstanding = readOutstandingChecklistItemsForTooltipV1(task);
    const outstandingSuffix =
      outstanding.total > 0
        ? ` Outstanding: ${outstanding.items.join("; ")}` +
          (outstanding.total > outstanding.items.length
            ? ` (+${outstanding.total - outstanding.items.length} more)`
            : "") +
          "."
        : "";
    lines.push(
      `$(warning) **Plan checklist is not a complete record** — a round landed changes it could not check off, so its counts understate what is done and no longer gate advancement. Tick the missed items in \`plan-final.md\`, then run **Ensemble: Mark Plan Checklist Reconciled** on this task to restore them.${outstandingSuffix}`,
      ""
    );
  }

  for (const stage of STAGE_ORDER) {
    const status = getStageStatus(stage, task.progress.currentStage, task.progress.completedStages);
    const marker =
      status === "done" ? "$(check)" : status === "current" ? "$(arrow-right)" : "$(circle-large-outline)";
    const suffix =
      status === "current" ? " — **current**" : status === "outstanding" ? " — outstanding" : "";
    lines.push(`${marker} ${STAGE_DISPLAY_NAMES[stage]}${suffix}`);
    lines.push("");
  }

  lines.push(
    `_Last updated: ${new Date(task.progress.updatedAt).toLocaleString()}_`
  );

  const tooltip = new vscode.MarkdownString(lines.join("\n"), true);
  return tooltip;
}

/**
 * Return the stable identity key for a task, used as `TreeItem.id` and for
 * matching against the persisted `CurrentTaskStore` value.
 *
 * Prefers the canonicalId when present (normalized absolute path produced by
 * taskRoot.ts — lowercased on Windows). Falls back to `folderUri.fsPath` for
 * legacy task objects that were not sourced through TaskInventory.
 */
function taskIdentityKey(task: IncompleteTask): string {
  return task.canonicalId ?? task.folderUri.fsPath;
}

/**
 * Adapt a TaskWithProgress to the IncompleteTask shape expected by tree nodes.
 *
 * Preserves the canonicalId from the inventory so that every render surface
 * (TreeItem.id, status bar, isCurrent matching, getTaskNodeById) uses the
 * same normalized identity key that CurrentTaskStore persists. Without this,
 * a path-case difference on Windows (inventory normalizes to lower-case, but
 * Uri.file().fsPath preserves the original case) would cause the stored
 * canonical ID to not match the fsPath used for comparison, making the tree
 * badge and status bar miss the current task.
 */
function toIncompleteTask(t: TaskWithProgress): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(t.taskFolderPath),
    folderName: t.folderName,
    progress: t.progress,
    canonicalId: t.canonicalId,
  };
}
// ... (skip down to TaskNode)
export class TaskNode extends vscode.TreeItem {
  /**
   * The most-recently-posted pending `WorkflowDecisionV1` for this task, if
   * any — set from the constructor's `pendingDecisions` argument. Read by
   * the "Review Pending Decision" command (`vs-code-ai-helper.viewPendingTaskDecision`
   * in extension.ts) to build the `ChatTarget` that opens Chat With AI on
   * exactly the decision's stage, since decisions are rendered stage-scoped
   * (`chatView.ts`'s `render()`).
   */
  public readonly pendingDecision?: WorkflowDecisionV1;

  constructor(
    public readonly task: IncompleteTask,
    expanded: boolean,
    isCurrent: boolean = false,
    isScheduled: boolean = false,
    isMetaManaged: boolean = false,
    collapseEpoch: number = 0,
    /** Plan §4.7 classification for a `creating`-status row; ignored otherwise. */
    creationFootprint?: TaskCreationContextInput,
    /**
     * This task's pending `WorkflowDecisionV1` records, if any (task:
     * "Replace hidden notification decision buttons with explained,
     * selectable decisions", PART 3). Surfaced in the tooltip and exposed as
     * `pendingDecision` (most recent first) so the "Review Pending Decision"
     * command can route to the right decision's stage without re-querying
     * the store.
     */
    pendingDecisions: readonly WorkflowDecisionV1[] = []
  ) {
    // An interrupted creation (plan §4.7 recovery row) has no stages to show
    // — getStageNodes() is never called for it (see getChildren) — so it
    // renders as a non-expandable leaf rather than a row with a dead
    // disclosure arrow.
    const isCreating = task.progress.status === "creating";
    super(
      task.progress.displayName ?? task.folderName,
      isCreating
        ? vscode.TreeItemCollapsibleState.None
        : expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
    );

    // Stable identity so VS Code can preserve expansion state across
    // refreshes within the same session. Uses the canonical ID when
    // available (normalized, lowercased on Windows) so it matches
    // exactly what CurrentTaskStore persists, falling back to fsPath for
    // legacy task objects not sourced through TaskInventory. The epoch
    // suffix is bumped by collapseAll() so the widget can't reuse a
    // previously-memorized (expanded) UI state for the same task.
    this.id = collapseEpoch > 0
      ? `${taskIdentityKey(task)}::c${collapseEpoch}`
      : taskIdentityKey(task);

    const currentStage = task.progress.currentStage;
    const isPaused = task.progress.status === "paused";

    // Only task-level operations (commit/push, Complete and Move On, Release)
    // spin the task row. Stage-scoped operations already spin their own stage
    // row, so spinning here as well would be redundant.
    //
    // Plain task rows carry no description: the status is already conveyed by
    // the icon (play = active, pause = paused, archive = archived, tick =
    // completed) and the current stage is visible by expanding the task, so
    // the "Status · Stage" subtext was dropped. The operation branches keep
    // their label — that is transient in-flight information the icon alone
    // (spinner vs. waiting) cannot fully explain.
    const tKey = taskKey(task.canonicalId ?? task.folderUri.fsPath);
    const taskLevelOp = taskOperations
      .getTaskOperations(tKey)
      .find(op => op.exclusive && op.stage === undefined);

    if (isCreating) {
      // No taskLevelOp/paused/archived/completed branch below applies to an
      // interrupted creation — it is its own lifecycle state (plan §4.7).
      this.description = creationFootprint?.deletionPending
        ? "Deletion in progress"
        : "Incomplete creation — needs recovery";
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("charts.red")
      );
    } else if (taskLevelOp && taskLevelOp.waitingForUser) {
      // Same "waiting is not running" distinction as StageNode below: a
      // task-level op (commit/push, release) paused on the user shouldn't
      // spin as if the computer is still working.
      this.iconPath = new vscode.ThemeIcon(
        "comment-unresolved",
        new vscode.ThemeColor("charts.yellow")
      );
      this.description = `${taskLevelOp.label} · waiting for you`;
    } else if (taskLevelOp) {
      this.iconPath = new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.blue")
      );
      this.description = `${taskLevelOp.label}…`;
    } else if (isPaused) {
      this.iconPath = new vscode.ThemeIcon(
        "debug-pause",
        new vscode.ThemeColor("charts.orange")
      );
    } else if (task.progress.status === "archived") {
      this.iconPath = new vscode.ThemeIcon(
        "archive",
        new vscode.ThemeColor("disabledForeground")
      );
    } else if (task.progress.status === "completed") {
      this.iconPath = new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("charts.green")
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        "play-circle",
        new vscode.ThemeColor("charts.blue")
      );
    }

    // Highlight current task: synthesize a `current-task:` URI so the
    // FileDecorationProvider in extension.ts can paint the ▶ badge.
    // The URI authority carries the canonical identity key so the decoration
    // provider can invalidate it precisely when the current task changes.
    if (isCurrent) {
      this.resourceUri = vscode.Uri.parse(
        `current-task:${taskIdentityKey(task)}`
      );
    }

    const sortedPendingDecisions = sortPendingDecisionsByRecencyV1(pendingDecisions);
    /** The most-recently-posted pending decision, if any — used by the
     * "Review Pending Decision" command to route to the right stage. */
    this.pendingDecision = sortedPendingDecisions[0];

    this.tooltip = buildTaskTooltip(task, sortedPendingDecisions);

    // Centralized context value construction via buildTaskContextValue
    this.contextValue = buildTaskContextValue({
      status: isPaused ? "paused" : (task.progress.status || "active"),
      currentStage,
      hasLintPayload: task.progress.lintPayload !== undefined,
      lintPassed: task.progress.lintPayload?.passed,
      isScheduled,
      isMetaManaged,
      // The same flag the tooltip branch above reads: carrying it into the
      // context value is what scopes the reconcilePlanChecklist menu entry to
      // latched tasks only (package.json matches /-checklistUnreliable/).
      checklistProgressUnreliable: task.progress.checklistProgressUnreliable === true,
      isPinned: task.progress.pinnedAt !== undefined,
      hasPendingDecision: sortedPendingDecisions.length > 0,
      creationFootprint
    });
  }
}

/**
 * Tree node representing one workflow stage within a task
 */
export class StageNode extends vscode.TreeItem {
  constructor(
    public readonly task: IncompleteTask,
    public readonly stage: TaskStage,
    status: StageStatus,
    artifactUri: vscode.Uri | undefined,
    /** Optional readiness info for review stages: the score label plus, when
     * the review carries a usable progress marker, the checklist-reconciled
     * step counts (see effectiveReviewProgressV1). `staleReviewedSha` is set
     * when the review's recorded commit is no longer HEAD (review freshness —
     * display-side only, the artifact itself is never mutated here). */
    readiness?: { label: string; progress?: { complete: number; total: number }; staleReviewedSha?: string },
    isScheduled: boolean = false,
    isMetaManaged: boolean = false,
    hasBackup: boolean = false,
    redoAvailable: boolean = false
  ) {
    super(STAGE_DISPLAY_NAMES[stage], vscode.TreeItemCollapsibleState.None);

    const artifactName =
      artifactUri?.path.split("/").pop() ?? STAGE_ARTIFACT_FILENAMES[stage];

    const tKey = taskKey(task.canonicalId ?? task.folderUri.fsPath);
    // Leaf-operation semantics (C1 nesting): during a composite run the
    // spinner follows the actively running sub-stage — the implementation
    // row while a fix is being implemented, the review row while
    // re-reviewing — rather than parking on the composite root's stage.
    //
    // For a review stage specifically, a raw stage match is not enough: a
    // rerun launched while the task still sat on a PRE-review stage (`plan`,
    // `impl`, `publish`) registers its "review"-kind taskOperations entry
    // under THAT stage, not the review stage it targets — getActiveStages
    // would miss it. hasActiveOperationTargetingStage translates through
    // REVIEW_TARGETS (the same mapping reviewActions.ts's
    // isReviewActivelyRerunningV1 uses) so this row still takes the running
    // branch, which is what suppresses the "· stale" qualifier below in
    // favor of "Review in progress" (Part 2, review status messaging).
    //
    // The translated check must itself split on waitingForUser (matchWaiting
    // false/true below) the same way getActiveStages/getWaitingStages split
    // raw-stage ops: a rerun that is paused on a question or round-limit
    // (still a live "review"-kind op, just not spinning) must take the
    // waiting branch, not the running one, even after translation.
    const isRunning =
      taskOperations.getActiveStages(tKey).includes(stage) ||
      (isReviewStage(stage) &&
        hasActiveOperationTargetingStage(tKey, "review", stage, (s) => REVIEW_TARGETS[s], false));
    // Waiting on the user (a question, a round-limit pause) is NOT "in
    // progress" from the user's point of view — a spinner over it reads as
    // "the computer is working, leave it alone", exactly backwards. Show a
    // distinct, non-spinning icon instead.
    const isWaitingForUser =
      !isRunning &&
      (taskOperations.getWaitingStages(tKey).includes(stage) ||
        (isReviewStage(stage) &&
          hasActiveOperationTargetingStage(tKey, "review", stage, (s) => REVIEW_TARGETS[s], true)));

    if (isRunning) {
      this.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
      this.description = "running";
    } else if (isWaitingForUser) {
      this.iconPath = new vscode.ThemeIcon("comment-unresolved", new vscode.ThemeColor("charts.yellow"));
      this.description = "waiting for you";
    } else {
      switch (status) {
        case "done":
          // Completed stages always render with the done/tick icon, regardless
          // of whether readiness data is present. Overwriting the tick with a
          // readiness icon (thumbsup/question/thumbsdown) would make completed
          // stages visually ambiguous after a refresh — the acceptance criterion
          // for reliable completed-stage ticks requires the tick to be
          // unconditional for the "done" state.
          this.iconPath = new vscode.ThemeIcon(
            "check",
            new vscode.ThemeColor("charts.green")
          );
          this.description = "done";
          break;
        case "current": {
          // The current-stage icon is always the plain horizontal arrow,
          // regardless of readiness — review-score indicator glyphs
          // (check/arrow-right/arrow-down keyed to score bands) were removed
          // from stage-level icons; a low score must not turn this into a
          // down-arrow. The score itself still surfaces in the description
          // text below, same as a "done" stage's tick never varies by score.
          const escalated = task.progress.escalation?.stage === stage;
          this.iconPath = new vscode.ThemeIcon(
            escalated ? "warning" : "arrow-right",
            new vscode.ThemeColor(escalated ? "charts.orange" : "charts.blue")
          );
          // Score AND step progress at a glance: the score alone read as
          // "finished" when the workflow had only completed some of the
          // plan's steps (a loop back into implementation looked like a
          // bug). A missing/malformed marker renders exactly the pre-existing
          // score-only output. A review whose recorded commit is no longer
          // HEAD carries a "stale" qualifier so its score stops reading as a
          // verdict on the current workspace.
          const staleSuffix = readiness?.staleReviewedSha ? " · stale" : "";
          const readinessLabel = readiness
            ? (readiness.progress
                ? `${readiness.label} · ${readiness.progress.complete} of ${readiness.progress.total} steps`
                : readiness.label) + staleSuffix
            : undefined;
          const base = readinessLabel ? `current · ${readinessLabel}` : "current";
          this.description = escalated ? `${base} · escalated` : base;
          break;
        }
        case "outstanding":
          this.iconPath = new vscode.ThemeIcon(
            "circle-large-outline",
            new vscode.ThemeColor("disabledForeground")
          );
          this.description = "outstanding";
          break;
      }
    }

    if (artifactUri) {
      this.command = {
        command: "vscode.open",
        title: "Open Artifact",
        arguments: [artifactUri],
      };
    } else if (artifactName) {
      // No artifact on disk yet — most commonly because auto-advance just
      // moved this stage to "current" and its AI review is still generating
      // the file asynchronously. Previously this left `command` unset, so
      // clicking the row silently did nothing; bind a fallback that at least
      // explains why. Once the artifact is written, taskOperations' change
      // event refreshes the tree and this node is rebuilt with the real
      // "vscode.open" command above.
      const notReadyMessage = isRunning
        ? `${artifactName} is still being generated for "${task.folderName}" — click the stage again once the review finishes to open it.`
        : `${artifactName} has not been created yet for this stage of "${task.folderName}".`;
      this.command = {
        command: "vs-code-ai-helper.stageArtifactNotReady",
        title: "Artifact Not Ready",
        arguments: [notReadyMessage],
      };
    }

    let tooltipStr = artifactName
      ? (artifactUri ? `Open ${artifactName}` : `${artifactName} has not been created yet`)
      : STAGE_DISPLAY_NAMES[stage];

    if (readiness?.progress) {
      // The score on one line, a divider, then the step progress on the next
      // — the two read as separate facts instead of one conflated number.
      tooltipStr +=
        `\n\nReview score: ${readiness.label}\n\n---\n\n` +
        `${readiness.progress.complete} of ${readiness.progress.total} steps completed`;
    }
    if (readiness?.staleReviewedSha) {
      // Display-time computation (Part 2, review status messaging): a stale
      // review with an active translated rerun shows "Review in progress"
      // instead of the categorical rerun instruction — re-derived from live
      // taskOperations state on every render, so a cancelled or failed rerun
      // can never leave this tooltip stuck on stale wording it should have
      // reverted from, and a genuinely still-stale review (no active rerun)
      // keeps the instruction. Uses isRunning || isWaitingForUser, not
      // isRunning alone: a rerun paused on a question or round-limit is
      // still genuinely in flight (the placeholder file and banner keep
      // saying "in progress" for the same reason — see
      // isReviewActivelyRerunningV1), so the tooltip must not fall back to
      // the stale/re-run instruction just because the spinner isn't showing.
      tooltipStr += (isRunning || isWaitingForUser)
        ? "\n\n⏳ Review in progress: re-evaluating this artifact against the current HEAD."
        : `\n\n⚠ This review examined commit ${readiness.staleReviewedSha}, which is no longer HEAD — ` +
          "re-run Review with AI to assess the current state.";
    }
    if (isScheduled) {
      this.description = this.description
        ? `${this.description} · scheduled`
        : "scheduled";
      tooltipStr += "\n\nThe current-stage action is scheduled.";
    }
    if (task.progress.escalation?.stage === stage) {
      tooltipStr += `\n\nAutomated review iteration is stuck and needs your input: ${task.progress.escalation.reason}`;
    }
    this.tooltip = new vscode.MarkdownString(tooltipStr, true);

    // Use the computed stage context for stage-specific buttons
    this.contextValue = getStageNodeContextValue(
      stage,
      status,
      task.progress.status === "paused",
      task.progress.lintPayload !== undefined,
      task.progress.lintPayload?.passed,
      isScheduled,
      isMetaManaged,
      hasBackup,
      redoAvailable
    );
  }

}

/**
 * Computes the `contextValue` for a `StageNode` in the task tree view.
 * This value drives which action buttons are shown on hover for a given stage.
 *
 * @param stage The task stage represented by the node.
 * @param status The stage's status relative to the task's current progress.
 * @returns A string to be used as the `TreeItem.contextValue`.
 */
export function getStageNodeContextValue(
  stage: TaskStage,
  status: StageStatus,
  isPaused: boolean = false,
  hasLintPayload: boolean = false,
  lintPassed?: boolean,
  isScheduled: boolean = false,
  isMetaManaged: boolean = false,
  hasBackup: boolean = false,
  redoAvailable: boolean = false
): string {
  return buildStageContextValue({
    stage,
    status,
    isPaused,
    hasLintPayload,
    lintPassed,
    isScheduled,
    isMetaManaged,
    hasBackup,
    redoAvailable,
  });
}

export class EmptyTasksNode extends vscode.TreeItem {
  constructor() {
    super("No matching tasks", vscode.TreeItemCollapsibleState.None);
    this.description = "Change the status filter or reset it to view all tasks.";
    this.iconPath = new vscode.ThemeIcon("filter");
    this.command = { command: "vs-code-ai-helper.resetTaskStatusFilter", title: "Reset task status filter" };
  }
}

/**
 * Inspection-only node for a folder whose `task-progress.json` exists but
 * did not strictly decode (plan §3.12 step 4): the task is no longer
 * silently omitted from the list — it renders here with the decoder's
 * recovery code, and clicking it opens the progress file for manual repair.
 * Folders the creation reconciler already claims never reach this node
 * (TaskInventory skips them), so one folder can't grow two recovery surfaces.
 */
export class ProgressRecoveryNode extends vscode.TreeItem {
  constructor(public readonly entry: TaskProgressRecoveryEntryV1) {
    super(entry.folderName, vscode.TreeItemCollapsibleState.None);
    this.description = `needs recovery — ${entry.code}`;
    this.tooltip =
      `${entry.reason}\n\n` +
      "This task's task-progress.json did not strictly decode. Open it to " +
      "inspect and repair the recorded fields, then refresh the Tasks panel.";
    this.iconPath = new vscode.ThemeIcon("warning");
    this.contextValue = "ensemble.task.progressRecovery";
    this.command = {
      command: "vscode.open",
      title: "Open task-progress.json",
      arguments: [vscode.Uri.file(path.join(entry.taskFolderPath, "task-progress.json"))],
    };
  }
}

type TaskTreeNode = TaskNode | StageNode | EmptyTasksNode | ProgressRecoveryNode;

/**
 * Try to read review readiness (score) and the effective plan progress from
 * a review artifact file. The progress is the same checklist-reconciled
 * value the advance gates use (effectiveReviewProgressV1), read under the
 * lenient policy so a tree render can never throw or notify — anything
 * unreadable simply yields no progress, and the row renders score-only.
 *
 * @internal exported for testing
 */
export async function tryReadReadiness(
  artifactUri: vscode.Uri | undefined,
  stage: TaskStage,
  folderUri: vscode.Uri,
  /**
   * HEAD to judge the review's recorded commit against — either the SHA
   * itself (tests inject it) or a lazy resolver (the provider passes its
   * refresh-scoped cache, so one tree render costs at most one git
   * resolution no matter how many review tasks are expanded). Either form
   * is consulted only when the artifact actually carries a reviewed-commit
   * marker; omitted entirely, HEAD is resolved directly.
   */
  headSha?: string | (() => Promise<string | undefined>)
): Promise<{ label: string; progress?: { complete: number; total: number }; staleReviewedSha?: string } | undefined> {
  if (!artifactUri) {
    return undefined;
  }
  try {
    const content = await vscode.workspace.fs.readFile(artifactUri);
    const text = new TextDecoder().decode(content);
    const result = parseReadiness(text);
    const progress = await effectiveReviewProgressV1(folderUri, stage, text, "lenient");
    // Review freshness (display-side only — the tree never mutates the
    // artifact): a review whose recorded commit is behind HEAD is flagged so
    // its score no longer reads as a verdict on the current workspace.
    let staleReviewedSha: string | undefined;
    if (
      REVIEWED_COMMIT_STAGES.has(stage) &&
      parseReviewedCommitSha(text) !== undefined
    ) {
      const resolvedHead =
        typeof headSha === "function"
          ? await headSha()
          : headSha ?? (await resolveHeadCommitSha(folderUri.fsPath));
      const freshness = computeReviewFreshness(text, resolvedHead);
      if (freshness.behindHead) {
        staleReviewedSha = freshness.reviewedSha;
      }
    }
    const base = progress ? { label: result.label, progress } : { label: result.label };
    return staleReviewedSha ? { ...base, staleReviewedSha } : base;
  } catch {
    return undefined;
  }
}

/**
 * Tree data provider for the Ensemble tasks view. Shows every task in the
 * meta resources folder with a per-stage checklist (done / current /
 * outstanding), so workflow progress is always visible at a glance.
 *
 * Accepts the shared TaskInventory so it and all commands use the same
 * discovered-task source.
 */
export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly taskNodesByFolder = new Map<string, TaskNode>();

  // HEAD resolutions shared for the duration of one tree refresh, keyed by
  // the containing workspace folder — falling back, for tasks outside every
  // workspace folder (an absolute configured task root, taskRoot.ts), to the
  // task folder's parent directory. Task folders are direct children of
  // their task root (discoverTasksInRoot), so sibling tasks under one such
  // root share a key while tasks in unrelated locations still get their
  // own. Storing the in-flight promise means N expanded review tasks
  // rendered concurrently still cost one git call, not N. Cleared at every
  // root render — the funnel every _onDidChangeTreeData.fire() passes
  // through — so an external HEAD move (pull/rebase in a terminal) is
  // picked up on the next refresh.
  private readonly headShaByRepo = new Map<string, Promise<string | undefined>>();

  private readonly _onDidLoadTasks = new vscode.EventEmitter<
    IncompleteTask[]
  >();
  /** Fired after the root task list is (re)loaded, e.g. for the status bar */
  readonly onDidLoadTasks = this._onDidLoadTasks.event;

  // Collapse/expand state management
  private mode: "autoFirstActive" | "allExpanded" | "allCollapsed" = "autoFirstActive";
  private readonly explicitlyExpanded = new Set<string>();
  private readonly explicitlyCollapsed = new Set<string>();
  // Bumped on every collapseAll() so TaskNode ids change and VS Code can't
  // reuse its own memorized (already-expanded) UI state for the same node.
  private collapseEpoch = 0;
  private readonly filterKey = "ensemble.taskStatusFilter";
  private readonly filterKnownStatusesKey = "ensemble.taskStatusFilterKnownStatuses";
  private selectedStatuses: Set<string>;
  private readonly operationsSub: vscode.Disposable;
  /**
   * Reads pending `WorkflowDecisionV1` records for the "decision waiting"
   * tooltip line and the "Review Pending Decision" affordance (task:
   * "Replace hidden notification decision buttons with explained,
   * selectable decisions", PART 3). Constructed over the same `state`
   * Memento `ChatViewProvider` uses (both receive `context.workspaceState`
   * from extension.ts), per that class's own doc comment: any module may
   * independently construct a store over the same Memento and observe the
   * same records. `undefined` when no Memento was supplied (minimal test
   * stubs), in which case no task ever shows a pending decision.
   */
  private readonly workflowDecisionStore?: WorkflowDecisionStoreV1;
  private readonly workflowDecisionSub?: vscode.Disposable;

  constructor(
    private readonly inventory: TaskInventory,
    private readonly currentTaskStore?: CurrentTaskStore,
    private readonly state?: vscode.Memento
  ) {
    const saved = state?.get<string[]>(this.filterKey);
    if (Array.isArray(saved)) {
      // Reconcile against statuses that didn't exist when the filter was last saved, so a
      // status introduced after the user's last save (e.g. the "creating" recovery status)
      // isn't silently hidden forever. Installations that saved a filter before this
      // reconciliation existed have no known-statuses record, so assume the status set that
      // predated "creating" (the only status added since this filter shipped).
      const savedKnown = state?.get<string[]>(this.filterKnownStatusesKey);
      const previouslyKnown = Array.isArray(savedKnown)
        ? savedKnown
        : this.allStatuses().filter(status => status !== "creating");
      // Newly introduced statuses become visible automatically — except the
      // hidden-by-default ones (archived), which the user must opt into.
      const newlyAddedStatuses = this.allStatuses().filter(
        status =>
          !previouslyKnown.includes(status) &&
          !(DEFAULT_HIDDEN_STATUSES as readonly string[]).includes(status)
      );
      this.selectedStatuses = new Set([...saved, ...newlyAddedStatuses]);
    } else {
      this.selectedStatuses = new Set(this.defaultStatuses());
    }
    // When the shared inventory changes, refresh the tree automatically
    this.inventory.onDidChange(() => this._onDidChangeTreeData.fire());

    // Subscribe to current-task changes and refresh the tree
    if (currentTaskStore) {
      currentTaskStore.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    // taskOperations is a module singleton that outlives this provider, so the
    // subscription must be released on dispose or it will fire into a dead emitter.
    this.operationsSub = taskOperations.onDidChange(() => this._onDidChangeTreeData.fire());

    if (state) {
      this.workflowDecisionStore = new WorkflowDecisionStoreV1(state);
      // Resolving/posting a decision from Chat With AI (or anywhere else
      // sharing this Memento) must clear or add the tree's tooltip line
      // without waiting for an unrelated refresh (AC-06: "visible until
      // resolved", not "visible until the next coincidental refresh").
      this.workflowDecisionSub = this.workflowDecisionStore.onDidChange(() => this._onDidChangeTreeData.fire());
    }
  }

  dispose(): void {
    this.operationsSub.dispose();
    this.workflowDecisionSub?.dispose();
  }

  /**
   * Refresh the tree view. Also asks the inventory to reload so newly-created
   * tasks are visible immediately.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
    this.loadTasks();
  }

  private allStatuses(): string[] {
    return [...TASK_STATUSES];
  }

  /** Filter default: every status except the hidden-by-default ones (archived). */
  private defaultStatuses(): string[] {
    return this.allStatuses().filter(
      status => !(DEFAULT_HIDDEN_STATUSES as readonly string[]).includes(status)
    );
  }

  private static readonly STATUS_DESCRIPTIONS: Partial<Record<string, string>> = {
    creating: "Still being created (recovery entries)",
    active: "In progress tasks",
    archived: "Archived tasks (hidden by default)",
  };

  async chooseStatusFilter(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      this.allStatuses().map(status => ({
        label: (status[0] ?? "").toUpperCase() + status.slice(1),
        description: TaskTreeProvider.STATUS_DESCRIPTIONS[status],
        picked: this.selectedStatuses.has(status),
      })),
      { canPickMany: true, title: "Filter tasks by status", placeHolder: "Select the task statuses to show" }
    );
    if (!picked) return;
    this.selectedStatuses = new Set(picked.map(item => item.label.toLowerCase()));
    await this.state?.update(this.filterKey, [...this.selectedStatuses]);
    await this.state?.update(this.filterKnownStatusesKey, this.allStatuses());
    this._onDidChangeTreeData.fire();
  }

  async resetStatusFilter(): Promise<void> {
    this.selectedStatuses = new Set(this.defaultStatuses());
    await this.state?.update(this.filterKey, [...this.selectedStatuses]);
    await this.state?.update(this.filterKnownStatusesKey, this.allStatuses());
    this._onDidChangeTreeData.fire();
  }

  /** Expand all task rows by switching to all-expanded mode */
  async expandAll(treeView: vscode.TreeView<TaskTreeNode>): Promise<void> {
    this.mode = 'allExpanded';
    this.explicitlyExpanded.clear();
    this.explicitlyCollapsed.clear();
    this._onDidChangeTreeData.fire();

    // Force reveal all nodes to ensure they are expanded
    const nodes = this.getTaskNodes();
    for (const node of nodes) {
      if (!(node instanceof TaskNode)) continue;
      try {
        await treeView.reveal(node, {
          expand: true,
          focus: false,
          select: false,
        });
      } catch {
        // Ignore reveal failures (node may not be visible yet)
      }
    }
  }

  /** Collapse all task rows by switching to all-collapsed mode */
  collapseAll(): void {
    this.mode = 'allCollapsed';
    this.explicitlyExpanded.clear();
    this.explicitlyCollapsed.clear();
    // VS Code's TreeView remembers expand/collapse state per item id across
    // refreshes, so simply re-rendering with Collapsed items isn't enough for
    // rows the user (or expandAll) already expanded. Bumping the epoch changes
    // every node's id so the widget treats them as new items and applies the
    // freshly computed (collapsed) state instead of the memorized one.
    this.collapseEpoch += 1;
    this._onDidChangeTreeData.fire();
  }

  /** Whether the tree is currently in all-expanded mode (for context-key sync) */
  isAllExpanded(): boolean {
    return this.mode === 'allExpanded';
  }

  /**
   * Called when a task row is explicitly expanded by the user.
   * Records the choice so it survives refreshes within the same session.
   */
  notifyExpanded(task: IncompleteTask): void {
    const id = taskIdentityKey(task);
    this.explicitlyExpanded.add(id);
    this.explicitlyCollapsed.delete(id);
  }

  /**
   * Called when a task row is explicitly collapsed by the user.
   * Records the choice so it survives refreshes within the same session.
   */
  notifyCollapsed(task: IncompleteTask): void {
    const id = taskIdentityKey(task);
    this.explicitlyCollapsed.add(id);
    this.explicitlyExpanded.delete(id);
  }

  /**
   * Return the cached TaskNode for the given canonical ID, or undefined if the
   * node is not in the current render. Used by the reveal helper in
   * extension.ts so it can call `treeView.reveal()` with a live node reference.
   *
   * Matching priority:
   *   1. `task.canonicalId` — exact match against the normalized ID that
   *      CurrentTaskStore persists. This is the authoritative comparison and
   *      handles Windows case-normalization differences between the stored
   *      canonical ID and `folderUri.fsPath`.
   *   2. `task.folderUri.fsPath` — fallback for legacy nodes that were
   *      constructed without a canonical ID (e.g. direct URI scan tasks).
   */
  getTaskNodeById(canonicalId: string): TaskNode | undefined {
    for (const node of this.taskNodesByFolder.values()) {
      if (
        node.task.canonicalId === canonicalId ||
        node.task.folderUri.fsPath === canonicalId
      ) {
        return node;
      }
    }
    return undefined;
  }

  getTreeItem(element: TaskTreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: TaskTreeNode): TaskNode | undefined {
    if (
      element instanceof TaskNode ||
      element instanceof EmptyTasksNode ||
      element instanceof ProgressRecoveryNode
    ) {
      return undefined;
    }
    return this.taskNodesByFolder.get(element.task.folderUri.toString());
  }

  private isMetaManaged: boolean = false;

  private async updateMetaManagedStatus(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.isMetaManaged = false;
        return;
      }
      
      const metaPath = getConfiguredTaskRoot();
      if (!metaPath || metaPath.trim() === "" || path.isAbsolute(metaPath)) {
        this.isMetaManaged = false;
        return;
      }
      
      const normalized = path.normalize(metaPath);
      if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
        this.isMetaManaged = false;
        return;
      }
      
      const gitignorePath = normalized.replace(/\\/g, "/");
      const firstFolder = workspaceFolders[0];
      if (!firstFolder) {
        this.isMetaManaged = false;
        return;
      }
      const workspaceRoot = firstFolder.uri.fsPath;
      const gitignoreUri = vscode.Uri.file(path.join(workspaceRoot, ".gitignore"));
      
      const fileContent = await vscode.workspace.fs.readFile(gitignoreUri);
      const content = new TextDecoder().decode(fileContent);
      const lines = content.split(/\r?\n/);
      const metaResourcesEntry = `/${gitignorePath}`;
      
      this.isMetaManaged = lines.some((line) => line.trim() === metaResourcesEntry);
    } catch {
      this.isMetaManaged = false;
    }
  }

  async getChildren(element?: TaskTreeNode): Promise<TaskTreeNode[]> {
    if (!element) {
      // A root render is the start of a refresh cycle: every
      // _onDidChangeTreeData.fire() re-queries the root before any task's
      // stage nodes, so clearing here re-resolves HEAD exactly once per
      // refresh while still observing external HEAD moves.
      this.headShaByRepo.clear();
      await this.updateMetaManagedStatus();
    }
    if (element instanceof TaskNode) {
      // An interrupted creation (plan §4.7) has no stage/AI menu surface —
      // its TaskNode already renders non-expandable (see the constructor),
      // but VS Code can still ask for children (e.g. a stale expand request
      // from before a refresh), so this must independently return none.
      if (element.task.progress.status === "creating") {
        return [];
      }
      return this.getStageNodes(element.task);
    }
    if (element) {
      return [];
    }
    return this.getTaskNodes();
  }

  private loadTasks(): IncompleteTask[] {
    try {
      // Use the shared inventory as the source of truth
      const inventoryTasks = this.inventory.getTasks();
      const tasks: IncompleteTask[] = inventoryTasks.map(toIncompleteTask);

      const hasTasks = tasks.length > 0;
      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.hasTasks",
        hasTasks
      );
      // Always report hasMetaFolder as true since we use a default meta root.
      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.hasMetaFolder",
        true
      );

      this._onDidLoadTasks.fire(tasks);
      return tasks;
    } catch (error) {
      console.error('Failed to load tasks:', error);
      this._onDidLoadTasks.fire([]);
      throw error;
    }
  }

  private getTaskNodes(): TaskTreeNode[] {
    const tasks = this.loadTasks();
    const visible = tasks.filter(task => this.selectedStatuses.has(task.progress.status ?? "active"));

    const ordered = orderTasksForDisplay(visible);
    const firstActive = firstActiveInDisplayOrder(ordered);
    const firstActiveId = firstActive !== undefined ? taskIdentityKey(firstActive) : undefined;

    const shouldExpand = (task: IncompleteTask): boolean => {
      const id = taskIdentityKey(task);

      // Explicit user state takes precedence over mode
      if (this.explicitlyExpanded.has(id)) {
        return true;
      }
      if (this.explicitlyCollapsed.has(id)) {
        return false;
      }

      // Otherwise follow the global mode
      if (this.mode === 'allExpanded') {
        return true;
      }
      if (this.mode === 'allCollapsed') {
        return false;
      }
      // autoFirstActive mode: expand only the first active task in display order
      return firstActiveId !== undefined && id === firstActiveId;
    };

    // Get current task ID from the store (canonical normalized path).
    // Compare against task.canonicalId first, falling back to fsPath for
    // legacy task objects that have no canonicalId.
    const currentTaskCanonicalId = this.currentTaskStore?.get();

    const nodes: TaskTreeNode[] = ordered.map(
      (task) => {
        const taskId = taskIdentityKey(task);
        const isCurrent =
          currentTaskCanonicalId !== undefined &&
          taskId === currentTaskCanonicalId;
        // scheduledResumeTime belonged to the removed in-session scheduler.
        // Treat legacy values as inert so old completed tasks keep rendering.
        const isScheduled = task.progress.scheduledRun !== undefined;
        const creationFootprint =
          task.progress.status === "creating"
            ? TaskCreationStartupReconcilerV1.getLastKnownFootprint(
                path.dirname(task.folderUri.fsPath),
                task.folderUri.fsPath
              )
            : undefined;
        const pendingDecisions = this.workflowDecisionStore?.listPending(taskId) ?? [];
        return new TaskNode(
          task,
          shouldExpand(task),
          isCurrent,
          isScheduled,
          this.isMetaManaged,
          this.collapseEpoch,
          creationFootprint,
          pendingDecisions
        );
      }
    );

    // Rebuild the folder→node cache so getParent and getTaskNodeById work
    this.taskNodesByFolder.clear();
    for (const node of nodes) {
      if (node instanceof TaskNode) this.taskNodesByFolder.set(node.task.folderUri.toString(), node);
    }

    // Undecodable progress files render as inspection-only recovery nodes
    // (plan §3.12 step 4) — after the real tasks, unaffected by the status
    // filter (a recovery entry has no trustworthy status to filter on).
    // Optional call: minimal test stubs build inventories as plain objects
    // without the prototype; a missing method simply means no recovery rows.
    const recoveryNodes = (this.inventory.getRecoveryEntries?.() ?? []).map(
      (entry) => new ProgressRecoveryNode(entry)
    );

    if (nodes.length === 0 && recoveryNodes.length === 0 && tasks.length > 0) {
      return [new EmptyTasksNode()];
    }
    return [...nodes, ...recoveryNodes];
  }

  /**
   * Resolve HEAD once per refresh cycle (see headShaByRepo). Lazy: only
   * called when a current review stage's artifact actually carries a
   * reviewed-commit marker, so a tree with no such artifact costs no git
   * call at all.
   */
  private resolveHeadShaShared(folderUri: vscode.Uri): Promise<string | undefined> {
    const key =
      vscode.workspace.getWorkspaceFolder(folderUri)?.uri.toString() ??
      normalizePath(path.dirname(folderUri.fsPath));
    let pending = this.headShaByRepo.get(key);
    if (pending === undefined) {
      pending = resolveHeadCommitSha(folderUri.fsPath);
      this.headShaByRepo.set(key, pending);
    }
    return pending;
  }

  private async getStageNodes(task: IncompleteTask): Promise<StageNode[]> {
    const nodes: StageNode[] = [];

    for (const stage of STAGE_ORDER) {
      const status = getStageStatus(stage, task.progress.currentStage, task.progress.completedStages);

      let artifactUri: vscode.Uri | undefined;

      if (stage === "plan") {
        const candidate = await resolveCurrentPlanUri(task.folderUri);
        artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
      } else if (stage === "impl") {
        // Merged stage: prefer plan-final.md, fallback to implementation.md
        const resolved = await resolveImplementationArtifact(task.folderUri);
        artifactUri = (await statIfExists(resolved.uri)) ? resolved.uri : undefined;
      } else {
        const artifactName = STAGE_ARTIFACT_FILENAMES[stage];
        if (artifactName) {
          const candidate = vscode.Uri.joinPath(task.folderUri, artifactName);
          artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
        }
      }

      // For review stages, only try to parse readiness when the stage is
      // current — done stages always render with the tick icon regardless of
      // readiness data present in the artifact.
      let readiness: { label: string; progress?: { complete: number; total: number }; staleReviewedSha?: string } | undefined;
      if (isReviewStage(stage) && status === "current") {
        readiness = await tryReadReadiness(artifactUri, stage, task.folderUri, () =>
          this.resolveHeadShaShared(task.folderUri)
        );
      }

      const isStageScheduled = status === "current" && task.progress.scheduledRun !== undefined;

      // Backup availability drives the has-backup context token (Revert
      // Changes / Delete Previous Version menus). Resolved with the same
      // artifact rule the revert command uses (viewStageChanges.artifactFor):
      // plan → the current plan file, otherwise the stage's fixed filename.
      let revertArtifact: vscode.Uri | undefined;
      if (stage === "plan") {
        revertArtifact = await resolveCurrentPlanUri(task.folderUri);
      } else {
        const revertArtifactName = STAGE_ARTIFACT_FILENAMES[stage];
        revertArtifact = revertArtifactName
          ? vscode.Uri.joinPath(task.folderUri, revertArtifactName)
          : undefined;
      }
      const hasBackup =
        revertArtifact !== undefined && (await hasPreviousVersion(revertArtifact));
      // Durable across reloads/crashes: read from the on-disk redo sidecar
      // (redoSidecar.ts), which performJournaledRevertSwap keeps in sync with
      // which side of the artifact/backup swap the artifact currently sits
      // on. A missing/unknown sidecar safely defaults to "no redo available".
      const redoAvailable =
        hasBackup &&
        revertArtifact !== undefined &&
        isRedoAvailableFromRecord(await readRedoSidecar(revertArtifact));

      nodes.push(
        new StageNode(
          task,
          stage,
          status,
          artifactUri,
          readiness,
          isStageScheduled,
          this.isMetaManaged,
          hasBackup,
          redoAvailable
        )
      );
    }

    return nodes;
  }
}
