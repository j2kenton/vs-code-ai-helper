/**
 * Workflow privacy classifier (plan §2.2, Privacy cohort / executable-order
 * step 7).
 *
 * The one privacy contract every path-consuming module shares: given any
 * task/workflow path (absolute or relative, either slash style), classify it
 * into exactly one of the plan's six data classes and answer the single
 * question consumers actually ask — "may this path enter an artifact, a
 * context pack, a backup, a prompt attachment, a normal log, or the Git
 * index?" (`isWorkflowPrivatePathV1`).
 *
 * Classification is by path SHAPE only (segments and basenames — the same
 * conventions the product itself allocates through WorkflowPathRegistryV1,
 * plan §2.1). It never touches the filesystem, so it is safe to call from
 * VS-Code-API-free modules, tests, and hot enumeration loops. Matching is
 * case-insensitive (Windows filesystems are), which can only over-exclude —
 * every ambiguity fails toward privacy, never toward artifact-safe.
 *
 * The six classes (plan §2.2):
 *  - `artifactSafe`             task/plan/review/implementation artifacts,
 *                               source files — content the product may show,
 *                               attach, back up, and stage;
 *  - `chatPrivate`              task-local Chat transcripts and Chat
 *                               transaction/recovery records — questions,
 *                               answers, and messages that must never enter
 *                               artifacts, packs, prompts, backups, logs, or
 *                               Git metadata;
 *  - `workflowControl`          progress, journal (including the meta-root
 *                               migration journal), lock, checkpoint, lease,
 *                               sentinel, creation-intent, and crash-surviving
 *                               atomic-write temporary records the product
 *                               owns — excluded from packs, prompts, and
 *                               staging like private data;
 *  - `transientProviderData`    sealed provider result spools (plan §3.2);
 *  - `sanitizedDiagnostics`     the CONTENT class for logs/notifications
 *                               (correlation IDs, codes, byte counts,
 *                               digests only). No persisted path family maps
 *                               to it today, so `classifyWorkflowPathV1`
 *                               never returns it — it is part of the union
 *                               for consumers' content-policy decisions;
 *  - `legacyChatPrivateArtifact` legacy `runs/chat-*.md` transcripts —
 *                               read-only recovery records, never migration
 *                               inputs (plan §5.3).
 */
import {
  CHAT_HISTORY_CORRUPT_FILENAME,
  CHAT_HISTORY_FILENAME,
} from "../utils/chatHistoryConstants";
import { RUNS_DIRNAME, TASK_PROGRESS_FILENAME } from "../types/taskProgress";

export type WorkflowPathClassV1 =
  | "artifactSafe"
  | "chatPrivate"
  | "workflowControl"
  | "transientProviderData"
  | "sanitizedDiagnostics"
  | "legacyChatPrivateArtifact";

/** Root directory of all registered private runtime storage (plan §2.1). */
export const WORKFLOW_RUNTIME_DIRNAME_V1 = "workflow-runtime-v1";
/** workflow-runtime-v1 family holding Chat interaction transactions (plan §5.5). */
export const CHAT_TRANSACTIONS_DIRNAME_V1 = "chat-transactions";
/** workflow-runtime-v1 family holding verified Chat reset snapshots (plan §5.1). */
export const CHAT_RECOVERY_DIRNAME_V1 = "chat-recovery";
/** workflow-runtime-v1 family holding sealed provider result spools (plan §3.2). */
export const PROVIDER_RESULTS_DIRNAME_V1 = "provider-results";
/** workflow-runtime-v1 family holding edit-run manifests/receipts (plan §7). */
export const EDIT_RUNS_DIRNAME_V1 = "edit-runs";
/** workflow-runtime-v1 family holding runtime lease records (plan §2.1). */
export const LEASES_DIRNAME_V1 = "leases";
/** Meta-root directory of creation intent/journal/tombstone records (plan §4.2). */
export const CREATION_INTENTS_DIRNAME_V1 = "creation-intents-v1";
/** Task-folder creation sentinel (plan §4.2). */
export const CREATION_SENTINEL_FILENAME_V1 = ".ensemble-creation-sentinel-v1.json";

/**
 * Workflow-control basenames the product persists today. Owners:
 * task-progress.json (types/taskProgress.ts), finalization-journal.json
 * (state/finalizationJournal.ts), .ensemble-activation-checkpoint.json
 * (state/taskActivationCheckpoint.ts), task-models.json
 * (utils/modelSelection.ts), .ensemble-migration.json — the crash-surviving
 * meta-root move provenance journal (utils/metaResourcesMigration.ts
 * MIGRATION_JOURNAL_FILENAME). The classifier unit test pins each literal
 * against its owning module's export where one exists, so the two cannot
 * drift silently.
 */
const WORKFLOW_CONTROL_BASENAMES = new Set<string>([
  TASK_PROGRESS_FILENAME.toLowerCase(),
  "finalization-journal.json",
  ".ensemble-activation-checkpoint.json",
  "task-models.json",
  ".ensemble-migration.json",
  CREATION_SENTINEL_FILENAME_V1.toLowerCase(),
]);

/**
 * Cross-process session/meta/task lock leases (state/primarySessionLock.ts,
 * state/taskStateStore.ts), including the `.stale-<pid>-<rand>` rename a
 * takeover leaves behind.
 */
const WORKFLOW_CONTROL_LOCK_RE = /^\.ensemble-[a-z0-9-]+\.lock(\..+)?$/;

/**
 * Workflow-control suffixes: durable artifact revert journals
 * (utils/artifactRevertJournal.ts REVERT_JOURNAL_SUFFIX) and redo sidecars
 * (utils/redoSidecar.ts REDO_SIDECAR_SUFFIX). Literal copies — those owners
 * import the VS Code API, which this module must stay free of; the unit test
 * pins the literals against the owners' exports.
 */
const WORKFLOW_CONTROL_SUFFIXES = ["_revert-journal.json", "._redo.json"];

/**
 * Atomic-write temporary records (state/writeAtomic.ts):
 * `<base>_temp_<sessionId>_<time>_<rand>.tmp<ext>` — a crash between the temp
 * write and the rename leaves them on disk next to the control record they
 * were meant to replace, and startup cleanup only reaps them after 24 hours.
 * Literal copy of the owner's convention (that owner imports the VS Code
 * API, which this module must stay free of). The owner's exported
 * `formatAtomicTempBasename` is the one definition of the complete layout —
 * production temp names and this classifier's unit-test fixtures are both
 * built by that formatter, so any layout change there leaves these fixtures
 * unmatched and fails the test until this pattern is updated to match.
 */
const ATOMIC_WRITE_TEMP_RE = /_temp_.+\.tmp(\.[^.]+)?$/;

/** Legacy Chat run logs: `runs/chat-*.md` (plan §5.3 — never migration inputs). */
const LEGACY_CHAT_RUN_LOG_RE = /^chat-.*\.md$/;

const CHAT_PRIVATE_BASENAMES = new Set<string>([
  CHAT_HISTORY_FILENAME.toLowerCase(),
  CHAT_HISTORY_CORRUPT_FILENAME.toLowerCase(),
]);

/** Written via fromCharCode so no literal control byte sits in this source file. */
const NUL_CHAR = String.fromCharCode(0);

/**
 * Split any path shape into lowercased significant segments. Absolute
 * prefixes (drive letters, UNC hosts, leading slashes) are dropped — the
 * classification conventions are location-relative, so only the segment
 * names matter.
 */
function toSegments(pathLike: string): string[] {
  return pathLike
    .toLowerCase()
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0 && !/^[a-z]:$/.test(segment));
}

/**
 * Classify a path into exactly one workflow data class (plan §2.2).
 *
 * Accepts absolute or relative paths with either slash style. Empty or
 * NUL-containing input cannot be proven artifact-safe and classifies as
 * `workflowControl` (fail closed).
 */
export function classifyWorkflowPathV1(pathLike: string): WorkflowPathClassV1 {
  if (typeof pathLike !== "string" || pathLike.length === 0 || pathLike.includes(NUL_CHAR)) {
    return "workflowControl";
  }
  const segments = toSegments(pathLike);
  if (segments.length === 0) {
    return "workflowControl";
  }
  const leaf = segments[segments.length - 1]!;

  // Chat transcript files are Chat-private wherever they sit — including a
  // rename destination or a copy inside private runtime storage.
  if (segments.some((segment) => CHAT_PRIVATE_BASENAMES.has(segment))) {
    return "chatPrivate";
  }

  // Registered private runtime storage (plan §2.1). Family membership is
  // positional: the segment immediately after workflow-runtime-v1 names the
  // family. Unknown families are workflow-control — never artifact-safe.
  const runtimeIndex = segments.indexOf(WORKFLOW_RUNTIME_DIRNAME_V1);
  if (runtimeIndex !== -1) {
    const family = segments[runtimeIndex + 1];
    if (family === CHAT_TRANSACTIONS_DIRNAME_V1 || family === CHAT_RECOVERY_DIRNAME_V1) {
      return "chatPrivate";
    }
    if (family === PROVIDER_RESULTS_DIRNAME_V1) {
      return "transientProviderData";
    }
    return "workflowControl";
  }

  if (segments.includes(CREATION_INTENTS_DIRNAME_V1)) {
    return "workflowControl";
  }

  if (
    WORKFLOW_CONTROL_BASENAMES.has(leaf) ||
    WORKFLOW_CONTROL_LOCK_RE.test(leaf) ||
    WORKFLOW_CONTROL_SUFFIXES.some((suffix) => leaf.endsWith(suffix)) ||
    ATOMIC_WRITE_TEMP_RE.test(leaf)
  ) {
    return "workflowControl";
  }

  // Legacy Chat run logs: a chat-*.md directly inside a runs/ directory.
  if (
    segments.length >= 2 &&
    segments[segments.length - 2] === RUNS_DIRNAME.toLowerCase() &&
    LEGACY_CHAT_RUN_LOG_RE.test(leaf)
  ) {
    return "legacyChatPrivateArtifact";
  }

  return "artifactSafe";
}

/**
 * True when the path may NOT enter task artifacts, source files, context
 * packs, backups, prompt attachments, normal logs, or the Git index — i.e.
 * everything except `artifactSafe` (plan §2.2's exclusion list plus §2.4's
 * "private or workflow-control" staging rule, answered by one predicate).
 */
export function isWorkflowPrivatePathV1(pathLike: string): boolean {
  return classifyWorkflowPathV1(pathLike) !== "artifactSafe";
}
