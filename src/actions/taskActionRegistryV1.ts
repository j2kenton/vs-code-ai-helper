/**
 * Central task-action registry (plan §3.8, `src/actions/taskActionRegistryV1.ts`).
 *
 * Each registry row is the single declarative description of one product
 * action: its stable `actionKey`, every route that may reach it, stage/status
 * eligibility, lease requirements, progress label, provider mode, response
 * limit, permitted result kinds, the ONE completed-content type it accepts,
 * its declared Resume semantics (plan §3.1), promotion behavior, its
 * sanitized logging policy, and at most one declared follow-up. The
 * coordinator (`taskActionCoordinatorV1.ts`) is the only intended consumer.
 *
 * ENFORCEMENT STATE — no production rows exist yet. Per the plan's staged
 * cutover (§8), each cohort constructs its rows in the same change that
 * removes the corresponding route from `LEGACY_AI_ROUTE_DISABLED_V0` and
 * adds its key to `MIGRATED_ACTION_KEYS_V0` (`legacyAiActionSafetyGateV0.ts`).
 * Until then this module is a validated contract: `createTaskActionRegistryV1`
 * fail-closes on any row that violates the plan's row rules, so a malformed
 * row cannot exist long enough to route traffic.
 */
import {
  ActionCorrelationV1,
  ActionKeyV1,
  OperationIdV1,
  ResumeSemanticsV1,
} from "../types/actionCorrelationV1";
import {
  AgentExecutionModeV1,
  maxResponseBytesCeilingForModeV1,
} from "../types/agentExecutionV1";
import { CompletedContentV1 } from "../types/aiResultEnvelope";
import { ObservationLedgerV1 } from "../types/preflightPlanV1";
import { StructuredAnswerV1 } from "../types/structuredQuestionV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { TaskProgress, TaskStage } from "../types/taskProgress";
import {
  CompletedContentTypeNameV1,
  PermittedEnvelopeKindV1,
} from "../prompts/aiResultContractV1";

export class TaskActionRegistryErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskActionRegistryErrorV1";
  }
}

/** Stable action keys look like "generatePlan.v1" / "nextStage.v1". */
const ACTION_KEY_PATTERN_V1 = /^[a-z][A-Za-z0-9]*\.v1$/;

export type TaskActionInputValidationResultV1 =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly reason: string };

export interface TaskActionEligibilityV1 {
  /** Persisted task statuses this action may run against (non-empty). */
  readonly statuses: readonly string[];
  /** Stages this action may run in, or "anyStage". */
  readonly stages: readonly string[] | "anyStage";
}

/** Execution context handed to a provider row's prompt builder and promoter. */
export interface TaskActionExecutionContextV1 {
  readonly correlation: ActionCorrelationV1;
  /** The stage this invocation is running in (Chat is fully stage-isolated — plan §5.1/§6.1). */
  readonly stage: TaskStage;
  /** The row's own `validateInput` output — never the raw request input. */
  readonly validatedInput: unknown;
  /** Validated answers from a resumed structured-question interaction, when resuming. */
  readonly answers?: readonly StructuredAnswerV1[];
  /**
   * The attempt's own observation ledger and workspace root for a
   * `providerMode: "preflight"` row (plan §7.3): promotion validates the
   * returned plan against exactly the observations THIS attempt's read
   * session minted — never another attempt's. Absent for text/edit rows.
   */
  readonly preflight?: {
    readonly ledger: ObservationLedgerV1;
    readonly rootId: string;
  };
}

/** Execution context for non-provider (lifecycle) rows: an operation, but no provider attempt. */
export interface LifecycleExecutionContextV1 {
  readonly actionKey: ActionKeyV1;
  readonly operationId: OperationIdV1;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly validatedInput: unknown;
  /**
   * Lifecycle-only side channel (never available to provider rows, never
   * part of `validatedInput`/Chat-transaction input snapshots, since it
   * carries an in-process closure that cannot be canonically digested or
   * replayed by Resume): an optional effect a row may run atomically inside
   * its own locked read-modify-write, after its own CAS checks succeed but
   * before the patched progress is persisted. Threaded from
   * `TaskActionRequestV1.lifecycleBeforeWrite` — see that field's header for
   * why this exists (publishing a staged artifact atomically with a stage
   * transition, e.g. promoting `plan.md` to `plan-final.md` only when the
   * transition that requires it actually wins its compare-and-swap).
   */
  readonly beforeWrite?: (patched: TaskProgress) => Promise<void>;
  /**
   * Lifecycle-only side channel like `beforeWrite` (never provider rows,
   * never serialized): when true, the row's strict progress patch skips the
   * per-task lock because the CALLER already holds a covering lock —
   * `taskActivationCoordinator.activateTask` holds the shared meta-root lock
   * while invoking `resumeTask.v1` as its target write, and `withTaskLock`
   * queues on the same per-process key, so re-acquiring here would
   * self-deadlock. Threaded from `TaskActionRequestV1.lifecycleSkipTaskLock`.
   */
  readonly skipTaskLock?: boolean;
  /**
   * Lifecycle-only side channel like `beforeWrite`/`skipTaskLock` (never
   * provider rows, never serialized, never part of a Chat transaction's
   * input snapshot): an opaque bag of in-process, non-JSON-serializable
   * dependencies (e.g. `TaskInventory`, `CurrentTaskStore`, a
   * `ChatViewProvider`, a `vscode.ExtensionContext`) that a row needing more
   * than `validatedInput` can carry. Only `commitPush.v1` (plan §10.1/§10.2 —
   * the Git workflow needs live service objects `rawInput` cannot represent)
   * uses this today; every row casts it to its own expected shape, exactly
   * like `validatedInput`. Threaded from `TaskActionRequestV1.lifecycleServices`.
   */
  readonly services?: unknown;
}

export type TaskActionPromotionCodeV1 = "completed" | "noChanges";

/** Audit channels share the bounded-code alphabet used for failure codes (plan §3.5). */
const LOGGING_CHANNEL_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Per-row sanitized logging policy (the plan §3.8 row item, constrained by
 * §2.2's log-content rule: logs carry only correlation IDs, timestamps,
 * statuses, codes, byte counts, and digests). The policy declares WHERE the
 * row's settlement records go and whether result metrics travel with them —
 * never WHAT text is logged: the coordinator's settlement record shape is
 * closed, so no row can opt free-form content (prompts, questions, provider
 * output) into a log.
 */
export interface TaskActionLoggingPolicyV1 {
  /** Bounded audit channel/category name for this row's settlement records. */
  readonly channel: string;
  /**
   * Include the sealed provider result's byte length and SHA-256 digest in
   * settlement records (both are §2.2-permitted fields; rows whose results
   * are especially sensitive may still decline the metrics).
   */
  readonly includeResultMetrics: boolean;
}

interface TaskActionRowBaseV1 {
  readonly actionKey: ActionKeyV1;
  /**
   * Every public/internal/scheduled/webview route id owned by this action
   * (plan §1.2's route rows). Route ids are globally unique across the
   * registry so a route can never be double-owned.
   */
  readonly routes: readonly string[];
  readonly eligibility: TaskActionEligibilityV1;
  readonly requiresTaskOperationLease: boolean;
  /** User-facing progress label (e.g. "Generating plan…"). */
  readonly progressLabel: string;
  readonly validateInput: (rawInput: unknown) => TaskActionInputValidationResultV1;
  /** The row's sanitized settlement-logging policy (plan §3.8 / §2.2). */
  readonly loggingPolicy: TaskActionLoggingPolicyV1;
  /** At most one declared follow-up (plan AC-LIFECYCLE-02); must name a registered row. */
  readonly followUpActionKey?: ActionKeyV1;
}

/**
 * A provider-backed action row. Exactly one completed-content type is
 * permitted per row (plan §3.5), and the row's `ResumeSemanticsV1` is the
 * single authoritative rule for whether Resume preserves the operation
 * (plan §3.1 / AC-ID-04).
 */
export interface ProviderTaskActionRowV1 extends TaskActionRowBaseV1 {
  readonly kind: "provider";
  readonly providerMode: AgentExecutionModeV1;
  readonly maxResponseBytes: number;
  readonly permittedResultKinds: readonly PermittedEnvelopeKindV1[];
  /**
   * The ONE completed-content type this row accepts. The plan §3.8 row item
   * "strict completed-content decoder" is realized as the global strict
   * envelope decoder plus this declaration: `parseAiResultEnvelopeV1`
   * already strict-decodes every completed payload into the closed
   * `CompletedContentV1` union with that content type's exact schema
   * (unknown types/fields fail before promotion, plan §3.5), and the
   * coordinator then requires an exact match against this declared type
   * before `promoteCompletedContent` runs. A second per-row decode pass
   * would re-verify the identical closed schema on already strictly-typed
   * content, so no separate decoder function is declared here.
   */
  readonly completedContentType: CompletedContentTypeNameV1;
  readonly resumeSemantics: ResumeSemanticsV1;
  /** Action-specific prompt content; the coordinator appends the result contract. */
  readonly buildPrompt: (context: TaskActionExecutionContextV1) => string;
  /**
   * Promote strictly decoded completed content. Only the coordinator calls
   * this, and only with content whose `contentType` equals the row's
   * declared `completedContentType`.
   */
  readonly promoteCompletedContent: (
    content: CompletedContentV1,
    context: TaskActionExecutionContextV1
  ) => Promise<TaskActionPromotionCodeV1>;
}

/** A non-provider lifecycle row (plan §6.6's nextStage.v1 / markTaskDone.v1 shape). */
export interface LifecycleTaskActionRowV1 extends TaskActionRowBaseV1 {
  readonly kind: "lifecycle";
  readonly execute: (context: LifecycleExecutionContextV1) => Promise<TaskActionOutcomeV1>;
}

export type TaskActionRegistryRowV1 = ProviderTaskActionRowV1 | LifecycleTaskActionRowV1;

export interface TaskActionRegistryV1 {
  /** Resolve a row by action key; throws on an unknown key (fail-closed). */
  rowForActionKey(actionKey: string): TaskActionRegistryRowV1;
  /** Resolve the owning row for a route id; throws on an unowned route (fail-closed). */
  rowForRoute(routeId: string): TaskActionRegistryRowV1;
  hasActionKey(actionKey: string): boolean;
  actionKeys(): readonly ActionKeyV1[];
}

const TEXT_CONTENT_TYPES_V1: ReadonlySet<CompletedContentTypeNameV1> = new Set<
  CompletedContentTypeNameV1
>(["markdown-artifact.v1", "chat-message.v1", "commit-metadata.v1"]);

function requiredModeForContentType(
  contentType: CompletedContentTypeNameV1
): AgentExecutionModeV1 {
  if (contentType === "preflight-plan.v1") {
    return "preflight";
  }
  if (contentType === "edit-execution.v1") {
    return "edit";
  }
  return "text";
}

function validateBaseRow(row: TaskActionRegistryRowV1): void {
  if (!ACTION_KEY_PATTERN_V1.test(row.actionKey)) {
    throw new TaskActionRegistryErrorV1(
      `Invalid actionKey ${JSON.stringify(row.actionKey)}: action keys must match ` +
        `${String(ACTION_KEY_PATTERN_V1)} (e.g. "generatePlan.v1").`
    );
  }
  if (row.routes.length === 0) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares no routes: every registry row owns at least one route.`
    );
  }
  for (const route of row.routes) {
    if (typeof route !== "string" || route.length === 0) {
      throw new TaskActionRegistryErrorV1(
        `Row ${row.actionKey} declares an empty route id.`
      );
    }
  }
  if (new Set(row.routes).size !== row.routes.length) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares a duplicate route id.`
    );
  }
  if (row.eligibility.statuses.length === 0) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares no eligible statuses.`
    );
  }
  if (row.eligibility.stages !== "anyStage" && row.eligibility.stages.length === 0) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares an empty stage list; use "anyStage" for stage-independent actions.`
    );
  }
  if (row.progressLabel.length === 0) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares an empty progress label.`
    );
  }
  if (!LOGGING_CHANNEL_PATTERN_V1.test(row.loggingPolicy.channel)) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares logging channel ${JSON.stringify(row.loggingPolicy.channel)}: ` +
        `channels must match ${String(LOGGING_CHANNEL_PATTERN_V1)}.`
    );
  }
}

function validateProviderRow(row: ProviderTaskActionRowV1): void {
  const ceiling = maxResponseBytesCeilingForModeV1(row.providerMode);
  if (
    !Number.isInteger(row.maxResponseBytes) ||
    row.maxResponseBytes <= 0 ||
    row.maxResponseBytes > ceiling
  ) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares maxResponseBytes=${String(row.maxResponseBytes)}: the ` +
        `"${row.providerMode}" mode requires an integer between 1 and ${ceiling}.`
    );
  }
  if (row.permittedResultKinds.length === 0) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} permits no result kinds.`
    );
  }
  if (new Set(row.permittedResultKinds).size !== row.permittedResultKinds.length) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} declares a duplicate permitted result kind.`
    );
  }
  if (!row.permittedResultKinds.includes("completed")) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} must permit "completed": a provider row that can never complete has no purpose.`
    );
  }
  const requiredMode = requiredModeForContentType(row.completedContentType);
  if (row.providerMode !== requiredMode) {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} pairs completedContentType "${row.completedContentType}" with provider mode ` +
        `"${row.providerMode}"; that content type requires mode "${requiredMode}".`
    );
  }
  if (
    row.completedContentType === "edit-execution.v1" &&
    row.permittedResultKinds.includes("questions")
  ) {
    // Plan §7.4/§7.6: questions are invalid during edit execution.
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} permits "questions" for edit execution; questions are invalid during edit ` +
        "execution (plan §7.6) — they belong to the preflight row."
    );
  }
  if (TEXT_CONTENT_TYPES_V1.has(row.completedContentType) && row.providerMode !== "text") {
    throw new TaskActionRegistryErrorV1(
      `Row ${row.actionKey} pairs a text completed-content type with non-text mode "${row.providerMode}".`
    );
  }
}

/**
 * Construct a validated registry from a complete row set. Any rule violation
 * throws — a registry with a malformed row never exists.
 */
export function createTaskActionRegistryV1(
  rows: readonly TaskActionRegistryRowV1[]
): TaskActionRegistryV1 {
  const byActionKey = new Map<string, TaskActionRegistryRowV1>();
  const byRoute = new Map<string, TaskActionRegistryRowV1>();

  for (const row of rows) {
    validateBaseRow(row);
    if (byActionKey.has(row.actionKey)) {
      throw new TaskActionRegistryErrorV1(
        `Duplicate actionKey ${JSON.stringify(row.actionKey)}: action keys are unique across the registry.`
      );
    }
    if (row.kind === "provider") {
      validateProviderRow(row);
    }
    byActionKey.set(row.actionKey, row);
    for (const route of row.routes) {
      const owner = byRoute.get(route);
      if (owner) {
        throw new TaskActionRegistryErrorV1(
          `Route ${JSON.stringify(route)} is declared by both ${owner.actionKey} and ${row.actionKey}: ` +
            "every route has exactly one owning row."
        );
      }
      byRoute.set(route, row);
    }
  }

  // Follow-ups are validated after the whole set registers so ordering of
  // `rows` does not matter; a follow-up must name a registered row and may
  // not name the row itself (that would be an unbounded self-loop, not the
  // plan's "at most one declared follow-up").
  for (const row of byActionKey.values()) {
    if (row.followUpActionKey === undefined) {
      continue;
    }
    if (row.followUpActionKey === row.actionKey) {
      throw new TaskActionRegistryErrorV1(
        `Row ${row.actionKey} declares itself as its own follow-up.`
      );
    }
    if (!byActionKey.has(row.followUpActionKey)) {
      throw new TaskActionRegistryErrorV1(
        `Row ${row.actionKey} declares follow-up ${JSON.stringify(row.followUpActionKey)}, ` +
          "which is not a registered action."
      );
    }
  }

  return {
    rowForActionKey(actionKey: string): TaskActionRegistryRowV1 {
      const row = byActionKey.get(actionKey);
      if (!row) {
        throw new TaskActionRegistryErrorV1(
          `Unknown actionKey ${JSON.stringify(actionKey)}: only registered actions can be coordinated.`
        );
      }
      return row;
    },
    rowForRoute(routeId: string): TaskActionRegistryRowV1 {
      const row = byRoute.get(routeId);
      if (!row) {
        throw new TaskActionRegistryErrorV1(
          `Route ${JSON.stringify(routeId)} is not owned by any registry row: unowned routes fail closed.`
        );
      }
      return row;
    },
    hasActionKey(actionKey: string): boolean {
      return byActionKey.has(actionKey);
    },
    actionKeys(): readonly ActionKeyV1[] {
      return [...byActionKey.keys()];
    },
  };
}
