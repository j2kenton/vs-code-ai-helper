/**
 * The settled operation taxonomy (contract C1).
 *
 * One data-driven table classifying every qualifying entry point, derived
 * directly from the user's statements: "every operation should trigger
 * something … only if it's an action, not view changes"; settings Reset to
 * Default "doesn't actually save anything" (so it is a view/form-only change
 * and produces no operation and no notification — only Save does).
 *
 * The table answers two questions per category:
 *   - tracked: does it register a TrackedOperation (spinner, optimistic
 *     in-progress row, cancel affordance when a cancel callback exists)?
 *   - notification: what does it write to the Notifications section?
 *
 * `operationTaxonomy.test.ts` asserts this table row-by-row, so a later
 * correction by the user is a one-line data change, not a code hunt.
 */

export type OperationCategory =
  | "instant-mutation"
  | "long-running"
  | "chat-response"
  | "informational"
  | "view-only";

export type NotificationPolicy =
  /** A terminal entry is always recorded (create/rename/pause/resume/complete, settings Save). */
  | "terminal-always"
  /** An in-progress entry appears immediately and is updated to a terminal state in place. */
  | "in-progress-then-terminal"
  /** Tracked for spinner/cancel, but a terminal entry is recorded only on failure/cancel — no per-turn success noise. */
  | "terminal-on-failure-only"
  /** Not an operation at all; the event just writes an entry. */
  | "entry-only"
  /** Nothing: no operation, no entry. */
  | "none";

export interface OperationCategoryPolicy {
  readonly tracked: boolean;
  readonly notification: NotificationPolicy;
}

export const OPERATION_CATEGORY_POLICIES: Record<OperationCategory, OperationCategoryPolicy> = {
  "instant-mutation": { tracked: true, notification: "terminal-always" },
  "long-running": { tracked: true, notification: "in-progress-then-terminal" },
  "chat-response": { tracked: true, notification: "terminal-on-failure-only" },
  "informational": { tracked: false, notification: "entry-only" },
  "view-only": { tracked: false, notification: "none" },
};

/**
 * Every concrete operation kind the extension registers, mapped to its
 * category. `kind` travels on the TrackedOperation record
 * (taskOperations.ts) so views and tests can classify a live operation
 * without string-matching its label.
 */
export type OperationKind =
  // Instant user mutations
  | "create-task"
  | "delete-task"
  | "rename-task"
  | "pause-task"
  | "resume-task"
  | "complete-task"
  | "settings-save"
  // Long-running operations
  | "draft-task"
  | "generate-plan"
  | "review"
  | "apply-review"
  | "fast-forward"
  | "generate-implementation"
  | "run-implementation"
  | "lint-fixes"
  | "completion-checks"
  | "commit-push"
  | "complete-commit-push"
  | "release"
  // Chat
  | "chat-send";

export const OPERATION_KINDS: Record<OperationKind, { label: string; category: OperationCategory }> = {
  "create-task": { label: "Create Task", category: "instant-mutation" },
  "delete-task": { label: "Safe Delete Task", category: "instant-mutation" },
  "rename-task": { label: "Rename Task", category: "instant-mutation" },
  "pause-task": { label: "Pause Task", category: "instant-mutation" },
  "resume-task": { label: "Resume Task", category: "instant-mutation" },
  "complete-task": { label: "Complete Task", category: "instant-mutation" },
  "settings-save": { label: "Save Settings", category: "instant-mutation" },
  "draft-task": { label: "Draft Task with AI", category: "long-running" },
  "generate-plan": { label: "Generate Plan", category: "long-running" },
  "review": { label: "Review", category: "long-running" },
  "apply-review": { label: "Apply Review", category: "long-running" },
  "fast-forward": { label: "Fast Forward Review", category: "long-running" },
  "generate-implementation": { label: "Generate Implementation", category: "long-running" },
  "run-implementation": { label: "Run Implementation", category: "long-running" },
  "lint-fixes": { label: "Fix Linting & Code Errors", category: "long-running" },
  "completion-checks": { label: "Completion Checks", category: "long-running" },
  "commit-push": { label: "Commit and Push", category: "long-running" },
  "complete-commit-push": { label: "Complete, Commit and Push", category: "long-running" },
  "release": { label: "Release", category: "long-running" },
  "chat-send": { label: "Chat Response", category: "chat-response" },
};

export function policyForKind(kind: OperationKind): OperationCategoryPolicy {
  return OPERATION_CATEGORY_POLICIES[OPERATION_KINDS[kind].category];
}
