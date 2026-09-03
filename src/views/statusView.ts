import * as vscode from "vscode";
import { StatusSurface } from "../utils/notificationRouter";
import { formatTaskNameForDisplay, taskOperations } from "../utils/taskOperations";
import { TaskOperationSnapshot } from "../utils/taskOperations";
import { OperationKind } from "../utils/operationTaxonomy";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import { notificationFallbackUri } from "../utils/notificationContentProvider";
import { formatTimestampForDisplay } from "../utils/timeFormat";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { REVIEW_TARGETS } from "../utils/reviewReadiness";

export const STATUS_VIEW_ID = "vs-code-ai-helper.statusView";

export interface StatusEntry {
  message: string;
  level: "info" | "warning" | "error";
  timestamp: Date;
  /** Absolute fsPath of the file this notification relates to, if any. Clicking the entry opens it. */
  filePath?: string;
  /**
   * Stringified vscode.Uri (vscode.Uri.parse() it, never vscode.Uri.file())
   * of the operation's result artifact/run log, when known. Distinct from
   * `filePath` — see TaskOperationSnapshot.resultTargetUri. Takes over the
   * click-to-open behavior only when `filePath` is absent.
   */
  resultTargetUri?: string;
  /**
   * Id of the taskOperations root operation this entry is about, when known.
   * Only used to conditionally show an inline cancel action (D10) when the
   * id still resolves to a currently live, cancellable root operation — see
   * getTreeItem. A terminal/history entry for an already-ended operation
   * never shows a cancel action.
   */
  sourceOperationId?: string;
  /**
   * An actionable follow-up command for notifications that report a skipped
   * automatic action the user can still trigger manually (e.g. "Auto-publish
   * skipped: publish manually once checks pass"). When present, it is
   * exposed as a separate inline action (see D11 below) alongside — not
   * instead of — the usual open-file/open-result/fallback-document click
   * behavior, so a prose-only warning still gives the user something to act
   * on directly from the Notifications list.
   */
  actionCommand?: { command: string; title: string; args?: unknown[] };
}

export interface StatusOperationNode {
  readonly kind: "operation";
  readonly id: string;
  readonly label: string;
  readonly taskName: string;
  readonly detail?: string;
  /** Shows the inline cancel button (see the ensemble-operation-cancellable menu contribution). */
  readonly cancellable: boolean;
  /** See TaskOperationHandle.setWaitingForUser — swaps the spinner for a non-spinning "waiting" icon. */
  readonly waitingForUser: boolean;
  readonly stage?: TaskStage;
  /**
   * `TaskOperationSnapshot.kind`, carried through for display translation
   * only (see the `stageLabel` computation in `getTreeItem`) — a
   * `kind: "review"` root's `stage` is legitimately still the pre-review
   * stage while the review runs (REVIEW_TARGETS, reviewReadiness.ts's doc
   * comment), so the row must translate it the same way
   * `hasActiveOperationTargetingStage` already does for other readers.
   */
  readonly operationKind?: OperationKind;
  /** The resolved provider/model identity, when the operation has one (see TaskOperationHandle.setModel). */
  readonly modelId?: string;
  /** See TaskOperationHandle.reportActivity. */
  readonly activity?: string;
  /** Elapsed-time origin for `activity`; falls back to `startedAt` when absent. */
  readonly activityStartedAt?: number;
  readonly startedAt: number;
}

/** Live elapsed-time display: seconds below one minute, `Xm Ys` below one
 * hour, `Xh Ym` from then on — matches the in-flight-activity worked
 * example ("2m 48s", "17m 42s"). `now` is injectable for tests. */
export function formatElapsedForDisplay(originMs: number, now: number = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - originMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {return `${hours}h ${minutes}m`;}
  if (minutes > 0) {return `${minutes}m ${seconds}s`;}
  return `${seconds}s`;
}

export type StatusTreeNode = StatusEntry | StatusOperationNode;

function isOperationNode(node: StatusTreeNode): node is StatusOperationNode {
  return (node as StatusOperationNode).kind === "operation";
}

const STATUS_STATE_KEY = "ensemble.notifications";
const RUNNING_OPERATIONS_STATE_KEY = "ensemble.runningOperations";
const LEVEL_FILTER_STATE_KEY = "ensemble.notificationLevelFilter";
const ALL_LEVELS: ReadonlyArray<StatusEntry["level"]> = ["info", "warning", "error"];
/** Label text above this length is truncated with an ellipsis; the full text is still in the hover tooltip. */
const LABEL_TRUNCATE_LENGTH = 150;

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusTreeNode>, StatusSurface, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: StatusEntry[];
  private writes: Promise<void> = Promise.resolve();
  private readonly operationsSub: vscode.Disposable;
  /** Which notification levels are shown; all by default. */
  private levelFilter: Set<StatusEntry["level"]>;
  /**
   * Drives the live elapsed-time counter on running-operation rows. Runs
   * only while at least one root operation is live, and is unref'd so it
   * can never keep the extension host process alive on its own — a tick
   * only calls `refresh()` (a presentation repaint): it never touches the
   * registry or persistence.
   */
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly state?: vscode.Memento) {
    const savedFilter = state?.get<string[]>(LEVEL_FILTER_STATE_KEY);
    this.levelFilter = new Set(
      Array.isArray(savedFilter)
        ? (savedFilter.filter((l): l is StatusEntry["level"] => (ALL_LEVELS as readonly string[]).includes(l)))
        : ALL_LEVELS
    );
    if (this.levelFilter.size === 0) {
      this.levelFilter = new Set(ALL_LEVELS);
    }
    const persisted = state?.get<Array<Omit<StatusEntry, "timestamp"> & { timestamp: string }>>(STATUS_STATE_KEY, []) ?? [];
    // Notifications persist for the lifetime of this workspace with no
    // retention limit — the user only clears them explicitly via Clear All.
    // sourceOperationId is stripped on load too, not just in persist() below
    // — state written by a version before that fix can still carry one on
    // disk, and loading it verbatim would reintroduce the same cross-session
    // id collision (D10) this fix exists to close.
    this.entries = persisted
      .filter(entry => typeof entry.message === "string" && typeof entry.timestamp === "string")
      .map(({ sourceOperationId: _sourceOperationId, ...entry }) => ({ ...entry, timestamp: new Date(entry.timestamp) }))
      .filter(entry => !Number.isNaN(entry.timestamp.getTime()));

    // Operations themselves are necessarily in-memory, but a tiny snapshot
    // lets a later activation tell the user that a live operation was cut off
    // by reload rather than silently losing its Notifications row.
    const interrupted = state?.get<SerializedOperation[]>(RUNNING_OPERATIONS_STATE_KEY, []) ?? [];
    for (const snapshot of interrupted) {
      const entry = terminalEntryFor({ ...snapshot, state: "interrupted", waitingForUser: false });
      if (entry) {
        this.entries.unshift({
          message: entry.message,
          level: "warning",
          timestamp: new Date(),
        });
      }
    }
    if (interrupted.length > 0) {
      this.persist();
      void state?.update(RUNNING_OPERATIONS_STATE_KEY, []);
    }

    // taskOperations is a module singleton that outlives this provider, so the
    // subscription must be released on dispose or it will fire into a dead emitter.
    this.operationsSub = taskOperations.onDidChange((event) => {
      // Persisting is skipped for activity-only updates (persistenceRelevant:
      // false) — SerializedOperation never carries activity/activityStartedAt
      // anyway, so there is nothing new to persist, and every lifecycle/
      // detail/model/waiting-for-user change that DOES need persisting still
      // flags itself relevant exactly as before this event carried a payload.
      if (event.persistenceRelevant) {
        this.persistRunningOperations();
      }
      this.refresh();
      this.ensureTicking();
    });
  }

  /** Starts the 1s elapsed-time tick while any root operation is live, and
   * stops it once none remain — see `tickTimer`. */
  private ensureTicking(): void {
    const hasLiveRoot = taskOperations.getRootOperations().length > 0;
    if (hasLiveRoot && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.refresh(), 1000);
      // Node-only API (absent from the browser typings vscode's own lib
      // pulls in for webviews) — never let this timer keep the extension
      // host process alive on its own.
      (this.tickTimer as unknown as { unref?: () => void }).unref?.();
    } else if (!hasLiveRoot && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  dispose(): void {
    this.operationsSub.dispose();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  /**
   * Add a new status entry to the surface.
   * Entries persist indefinitely (no retention cap); the user clears them via Clear All.
   */
  addEntry(
    message: string,
    level: "info" | "warning" | "error",
    filePath?: string,
    resultTargetUri?: string,
    sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void {
    const entry: StatusEntry = {
      // Keep the complete process/result text. The tree label is compacted
      // separately, while the persisted entry remains useful after reload.
      message,
      level,
      timestamp: new Date(),
      filePath,
      resultTargetUri,
      sourceOperationId,
      actionCommand,
    };

    // Insert newest first
    this.entries.unshift(entry);

    this.persist();
    this.refresh();
    void vscode.commands.executeCommand("vs-code-ai-helper.statusView.focus").then(undefined, () => undefined);
  }

  /**
   * QuickPick for filtering notifications by type (info / warning / error).
   * Running-operation rows are never filtered out.
   */
  async chooseLevelFilter(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      ALL_LEVELS.map((level) => ({
        label: level[0]!.toUpperCase() + level.slice(1),
        picked: this.levelFilter.has(level),
        level,
      })),
      { canPickMany: true, title: "Filter notifications by type", placeHolder: "Select the notification types to show" }
    );
    if (!picked) return;
    this.levelFilter = picked.length === 0 ? new Set(ALL_LEVELS) : new Set(picked.map((item) => item.level));
    await this.state?.update(LEVEL_FILTER_STATE_KEY, [...this.levelFilter]);
    this.refresh();
  }

  /**
   * Clear all status entries. Useful for testing.
   */
  clear(): void {
    this.entries = [];
    this.persist();
    this.refresh();
  }

  /**
   * Get all entries currently stored.
   */
  getEntries(): StatusEntry[] {
    return [...this.entries];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private persist(): void {
    if (!this.state) return;
    // sourceOperationId is deliberately dropped here: taskOperations mints
    // ids from a counter that restarts at 0 every activation, so an id
    // persisted from a prior session can collide with an unrelated live
    // operation's id in a later session — surfacing a cancel button on a
    // stale entry that would abort the wrong, currently-running operation
    // (D10). serializeOperation and the interrupted-restore path below
    // already omit it for the same reason; this is the remaining path that
    // wrote it to disk.
    const serialized = this.entries.map(({ sourceOperationId: _sourceOperationId, ...rest }) => ({
      ...rest,
      timestamp: rest.timestamp.toISOString(),
    }));
    this.writes = this.writes.then(() => this.state!.update(STATUS_STATE_KEY, serialized));
    void this.writes.catch(() => undefined);
  }

  private persistRunningOperations(): void {
    if (!this.state) return;
    const snapshots = taskOperations.getRootOperations().map(serializeOperation);
    this.writes = this.writes.then(() => this.state!.update(RUNNING_OPERATIONS_STATE_KEY, snapshots));
    void this.writes.catch(() => undefined);
  }

  getTreeItem(element: StatusTreeNode): vscode.TreeItem {
    if (isOperationNode(element)) {
      const label = `${element.label} — ${formatTaskNameForDisplay(element.taskName)}`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = `running:${element.id}`;

      // In-flight status line: stage · activity · provider/model · elapsed,
      // omitting any absent segment. `detail` (composite sub-status text
      // surfaced from a descendant, e.g. "waiting for your answer",
      // "cancelling…") takes precedence over the new `activity` signal when
      // both are present — it is more specific, real-time information that
      // predates this field and must keep showing exactly as before.
      // `kind: "review"` roots register with the pre-review stage
      // (resolved.progress.currentStage) because a rerun can be launched
      // before the task has advanced onto its review stage — the same
      // convention `hasActiveOperationTargetingStage` accounts for via
      // REVIEW_TARGETS. Translate here too, so a running High-Level Code
      // Review shows "High-Level Code Review", not "Implementation".
      // `kind: "fast-forward"` roots use the identical convention
      // (runFastForwardReviewWithAI registers with `stage:
      // resolved.progress.currentStage`, reviewActions.ts:5987) and
      // `runReviewForFolder`'s initial dispatch reports activity directly
      // through this root (reviewActions.ts:6090) whenever no usable review
      // exists yet — review blocker 6392c9ff…-1: without this, that row
      // showed the pre-review stage for the whole initial-review dispatch
      // instead of the review actually running. This is display-only and
      // does not affect `isReviewActivelyRerunningV1`, which deliberately
      // excludes "fast-forward" for an unrelated reason (avoiding
      // double-counting against its own nested "review"-kind child ops).
      const displayStage =
        element.stage && (element.operationKind === "review" || element.operationKind === "fast-forward")
          ? REVIEW_TARGETS[element.stage] ?? element.stage
          : element.stage;
      const stageLabel = displayStage ? STAGE_DISPLAY_NAMES[displayStage] : undefined;
      const activitySegment =
        element.detail ?? element.activity ?? (element.waitingForUser ? "waiting for you" : "running");
      const elapsedOrigin = element.activityStartedAt ?? element.startedAt;
      const elapsedSegment = formatElapsedForDisplay(elapsedOrigin);
      item.description = [stageLabel, activitySegment, element.modelId, elapsedSegment]
        .filter((segment): segment is string => segment !== undefined && segment.length > 0)
        .join(" · ");

      item.iconPath = element.waitingForUser
        ? new vscode.ThemeIcon("comment-unresolved", new vscode.ThemeColor("charts.yellow"))
        : new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
      // Cancellable operations get an inline stop button via the
      // view/item/context menu contribution keyed on this contextValue.
      item.contextValue = element.cancellable
        ? "ensemble-operation-cancellable"
        : "ensemble-operation";
      return item;
    }

    const isTruncated = element.message.length > LABEL_TRUNCATE_LENGTH;
    const label = isTruncated ? `${element.message.slice(0, LABEL_TRUNCATE_LENGTH)}…` : element.message;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    // Displayed timestamp is HH:mm for today and YYYY-MM-DD for any earlier
    // day (a bare time is meaningless once the day has changed); the
    // underlying Date retains full precision and still drives ordering.
    item.description = formatTimestampForDisplay(element.timestamp);

    // Click still always navigates to the notification's full text/target
    // (D11) — `actionCommand`, when present, is exposed as a separate inline
    // context-menu button (see contextValue below) rather than hijacking the
    // row click, so users can still read the full notification before
    // deciding whether to act on it.
    if (element.filePath) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode.Uri.file(element.filePath)],
      };
      item.tooltip = new vscode.MarkdownString(
        `**[${element.level.toUpperCase()}]** ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}\n\nClick to open the related file.`
      );
    } else if (element.resultTargetUri) {
      let targetUri: vscode.Uri | undefined;
      try {
        targetUri = vscode.Uri.parse(element.resultTargetUri, true);
      } catch {
        targetUri = undefined;
      }
      if (targetUri) {
        item.command = {
          command: "vscode.open",
          title: "Open Result",
          arguments: [targetUri],
        };
        item.tooltip = new vscode.MarkdownString(
          `**[${element.level.toUpperCase()}]** ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}\n\nClick to open the result.`
        );
      } else {
        item.tooltip = `[${element.level.toUpperCase()}] ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}`;
      }
    } else {
      // Nothing real to navigate to — open a read-only virtual document with
      // the full notification text rather than leaving the row unclickable.
      item.command = {
        command: "vscode.open",
        title: "Show Full Notification",
        arguments: [notificationFallbackUri(element.message, element.level, element.timestamp)],
      };
      item.tooltip = `[${element.level.toUpperCase()}] ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}`;
    }

    // Icon based on severity
    let iconName = "info";
    let iconColor = "charts.blue";
    if (element.level === "warning") {
      iconName = "warning";
      iconColor = "charts.orange";
    } else if (element.level === "error") {
      iconName = "error";
      iconColor = "charts.red";
    }

    item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(iconColor));

    // contextValue is a space-separated token list so an entry can expose
    // both the cancel affordance (D10) and the actionable follow-up button
    // at the same time; `when` clauses match individual tokens with `=~`.
    const contextTokens: string[] = [];

    // D10: a history/terminal entry gets the inline cancel action only when
    // its recorded operation id still resolves to a currently live,
    // cancellable root operation. Terminal, stale, and unknown ids
    // intentionally render with no cancel affordance.
    if (element.sourceOperationId && this.isLiveCancellableOperation(element.sourceOperationId)) {
      contextTokens.push("ensemble-notification-cancellable");
    }

    // A concrete follow-up (e.g. "Publish Anyway") is exposed as a separate
    // inline button, never as the row's click target — the click always
    // navigates to the notification's full text/target above.
    if (element.actionCommand) {
      contextTokens.push("ensemble-notification-actionable");
      const actionTitle = element.actionCommand.title;
      const baseTooltip = item.tooltip instanceof vscode.MarkdownString
        ? item.tooltip.value
        : item.tooltip ?? `[${element.level.toUpperCase()}] ${element.message}`;
      item.tooltip = new vscode.MarkdownString(`${baseTooltip}\n\nAction available: ${actionTitle}.`);
    }

    if (contextTokens.length > 0) {
      item.contextValue = contextTokens.join(" ");
    }
    return item;
  }

  runAction(element: StatusTreeNode): void {
    if (isOperationNode(element) || !element.actionCommand) return;
    const { command, args } = element.actionCommand;
    void vscode.commands.executeCommand(command, ...(args ?? []));
  }

  private isLiveCancellableOperation(operationId: string): boolean {
    return taskOperations
      .getRootOperations()
      .some((op) => op.id === operationId && op.state === "running" && op.cancellable);
  }

  getChildren(element?: StatusTreeNode): vscode.ProviderResult<StatusTreeNode[]> {
    if (!element) {
      // Root operations only (C1 nesting): a composite like Fast Forward
      // renders exactly one in-progress row, never one per internal attempt.
      // getRootOperations surfaces the newest child detail on the root row.
      const runningNodes = taskOperations.getRootOperations().map((op): StatusOperationNode => ({
        kind: "operation",
        id: op.id,
        label: op.label,
        taskName: op.taskName,
        detail: op.detail,
        cancellable: op.cancellable,
        waitingForUser: op.waitingForUser,
        // Display-only: tracks whichever nested sub-stage (e.g. the
        // Implementation edit inside a running Apply Review Edit) is
        // actually running, without touching the root's own persisted
        // `stage` field — see TaskOperationRegistry.getDisplayStage's doc
        // comment for why this must stay a separate call from
        // getRootOperations() above.
        stage: taskOperations.getDisplayStage(op.id),
        operationKind: op.kind,
        modelId: op.modelId,
        activity: op.activity,
        activityStartedAt: op.activityStartedAt,
        startedAt: op.startedAt,
      }));
      return [...runningNodes, ...this.entries.filter((entry) => this.levelFilter.has(entry.level))];
    }
    return [];
  }
}

/** JSON-safe minimal representation of a root operation surviving reload. */
type SerializedOperation = Pick<
  TaskOperationSnapshot,
  "id" | "key" | "label" | "stage" | "taskName" | "startedAt" |
  "detail" | "exclusive" | "kind" | "parentId" | "cancellable"
>;

function serializeOperation(operation: TaskOperationSnapshot): SerializedOperation {
  const { id, key, label, stage, taskName, startedAt, detail, exclusive, kind, parentId, cancellable } = operation;
  return { id, key, label, stage, taskName, startedAt, detail, exclusive, kind, parentId, cancellable };
}
