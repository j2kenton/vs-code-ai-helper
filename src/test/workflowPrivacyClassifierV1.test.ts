/**
 * Coverage for the §2.2 privacy classifier (Privacy cohort):
 *  1. every path family the plan names classifies into its declared class,
 *     across relative/absolute paths, both slash styles, and letter case;
 *  2. ambiguous or invalid input fails toward privacy, never artifact-safe;
 *  3. the classifier's literal copies of owner-module filename conventions
 *     (revert journals, redo sidecars, model config, progress, chat files,
 *     the meta-root migration journal, atomic-write temp records) are pinned
 *     against the owners' actual exports so they cannot drift — atomic temp
 *     fixtures come from the owner's complete formatter, the same function
 *     production temp names come from, not a layout rebuilt here.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyWorkflowPathV1,
  isWorkflowPrivatePathV1,
  CREATION_SENTINEL_FILENAME_V1,
} from "../services/workflowPrivacyClassifierV1";
import {
  CHAT_HISTORY_CORRUPT_FILENAME,
  CHAT_HISTORY_FILENAME,
} from "../utils/chatHistoryConstants";
import { RUNS_DIRNAME, TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { REVERT_JOURNAL_SUFFIX } from "../utils/artifactRevertJournal";
import { REDO_SIDECAR_SUFFIX } from "../utils/redoSidecar";
import { TASK_MODEL_CONFIG_FILENAME, RESOLVED_MODEL_SNAPSHOT_FILENAME } from "../utils/modelSelection";
import { MIGRATION_JOURNAL_FILENAME } from "../utils/metaResourcesMigration";
import { formatAtomicTempBasename } from "../state/writeAtomic";

/**
 * A representative crash-surviving atomic-write temp name, built by the
 * OWNER's exported complete formatter (state/writeAtomic.ts) — the same
 * function every production temp name comes from — rather than a layout
 * reconstructed here from its tokens. If the owner reorders or extends its
 * naming convention without a matching classifier update, these fixtures
 * take the new shape, stop matching the classifier, and fail this suite.
 */
const ATOMIC_TEMP_FIXTURE = formatAtomicTempBasename(
  "task-progress.json",
  "12345_abc123_1712000000000_x9y8z7"
);

void describe("workflowPrivacyClassifierV1", () => {
  void it("classifies Chat transcript files as Chat-private wherever they sit", () => {
    assert.equal(classifyWorkflowPathV1(CHAT_HISTORY_FILENAME), "chatPrivate");
    assert.equal(classifyWorkflowPathV1(CHAT_HISTORY_CORRUPT_FILENAME), "chatPrivate");
    assert.equal(classifyWorkflowPathV1(".ensemble/plans/2026_task_1/chat-v1.json"), "chatPrivate");
    assert.equal(classifyWorkflowPathV1("C:\\ws\\.ensemble\\plans\\t\\chat-v1.json"), "chatPrivate");
    // A rename destination with an extra suffix directory keeps the segment.
    assert.equal(classifyWorkflowPathV1("notes/archive/chat-v1.json"), "chatPrivate");
    // Case-insensitive (Windows filesystems are).
    assert.equal(classifyWorkflowPathV1("PLANS/T/CHAT-V1.JSON"), "chatPrivate");
  });

  void it("classifies private runtime storage by workflow-runtime-v1 family", () => {
    assert.equal(
      classifyWorkflowPathV1("workflow-runtime-v1/chat-transactions/0123456789abcdef0123456789abcdef"),
      "chatPrivate"
    );
    assert.equal(
      classifyWorkflowPathV1("workflow-runtime-v1/chat-recovery/aa11/bb22"),
      "chatPrivate"
    );
    assert.equal(
      classifyWorkflowPathV1(
        "workflow-runtime-v1/provider-results/0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef/result-v1.bin"
      ),
      "transientProviderData"
    );
    assert.equal(classifyWorkflowPathV1("workflow-runtime-v1/edit-runs/abc"), "workflowControl");
    assert.equal(classifyWorkflowPathV1("workflow-runtime-v1/leases"), "workflowControl");
    // Unknown families under the runtime root fail toward control, never safe.
    assert.equal(classifyWorkflowPathV1("workflow-runtime-v1/future-family/x"), "workflowControl");
    assert.equal(classifyWorkflowPathV1("workflow-runtime-v1"), "workflowControl");
    // Absolute storage path, mixed case, backslashes.
    assert.equal(
      classifyWorkflowPathV1("C:\\Users\\x\\AppData\\storage\\Workflow-Runtime-V1\\Provider-Results\\a\\b\\c"),
      "transientProviderData"
    );
  });

  void it("classifies creation, progress, journal, lock, and sidecar records as workflow-control", () => {
    assert.equal(classifyWorkflowPathV1("creation-intents-v1/intent-abc123.json"), "workflowControl");
    assert.equal(classifyWorkflowPathV1(CREATION_SENTINEL_FILENAME_V1), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`plans/t/${CREATION_SENTINEL_FILENAME_V1}`), "workflowControl");
    assert.equal(classifyWorkflowPathV1(TASK_PROGRESS_FILENAME), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`plans/t/${TASK_PROGRESS_FILENAME}`), "workflowControl");
    assert.equal(classifyWorkflowPathV1("finalization-journal.json"), "workflowControl");
    assert.equal(classifyWorkflowPathV1(".ensemble-activation-checkpoint.json"), "workflowControl");
    assert.equal(classifyWorkflowPathV1(TASK_MODEL_CONFIG_FILENAME), "workflowControl");
    assert.equal(classifyWorkflowPathV1(RESOLVED_MODEL_SNAPSHOT_FILENAME), "workflowControl");
    assert.equal(classifyWorkflowPathV1(".ensemble-session.lock"), "workflowControl");
    assert.equal(classifyWorkflowPathV1(".ensemble-meta.lock"), "workflowControl");
    assert.equal(classifyWorkflowPathV1("plans/t/.ensemble-task.lock"), "workflowControl");
    // Stale-lock rename left behind by a takeover (primarySessionLock.ts).
    assert.equal(classifyWorkflowPathV1(".ensemble-task.lock.stale-1234-ab12cd"), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`plans/t/plan.md${REVERT_JOURNAL_SUFFIX}`), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`plans/t/plan.md${REDO_SIDECAR_SUFFIX}`), "workflowControl");
  });

  void it("classifies the meta-root migration journal as workflow-control (pinned to its owner export)", () => {
    assert.equal(classifyWorkflowPathV1(MIGRATION_JOURNAL_FILENAME), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`.ensemble/${MIGRATION_JOURNAL_FILENAME}`), "workflowControl");
    assert.equal(
      classifyWorkflowPathV1(`C:\\ws\\plans\\${MIGRATION_JOURNAL_FILENAME}`),
      "workflowControl"
    );
  });

  void it("classifies crash-surviving atomic-write temp records as workflow-control (pinned to the owner's formatter)", () => {
    assert.equal(classifyWorkflowPathV1(ATOMIC_TEMP_FIXTURE), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`plans/t/${ATOMIC_TEMP_FIXTURE}`), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`C:\\ws\\.ensemble\\t\\${ATOMIC_TEMP_FIXTURE}`), "workflowControl");
    // Any atomically written target leaves the same shape: other extensions
    // and extensionless targets (bare `.tmp` suffix) are still control records.
    assert.equal(
      classifyWorkflowPathV1(formatAtomicTempBasename("plan.md", "9_a_1_b")),
      "workflowControl"
    );
    assert.equal(
      classifyWorkflowPathV1(formatAtomicTempBasename("LICENSE", "9_a_1_b")),
      "workflowControl"
    );
    // Near-misses stay artifact-safe: the infix without the .tmp suffix, and
    // the .tmp suffix without the infix, are ordinary user files.
    assert.equal(classifyWorkflowPathV1("notes/my_temp_file.txt"), "artifactSafe");
    assert.equal(classifyWorkflowPathV1("attempt.tmp.json"), "artifactSafe");
    assert.equal(classifyWorkflowPathV1("docs/template.tmp"), "artifactSafe");
  });

  void it("classifies legacy runs/chat-*.md transcripts, and only those, as legacy Chat artifacts", () => {
    assert.equal(classifyWorkflowPathV1(`${RUNS_DIRNAME}/chat-implement.md`), "legacyChatPrivateArtifact");
    assert.equal(
      classifyWorkflowPathV1(`plans/2026_task_1/${RUNS_DIRNAME}/chat-2.md`),
      "legacyChatPrivateArtifact"
    );
    // Normal numbered run logs stay artifact-safe.
    assert.equal(classifyWorkflowPathV1(`${RUNS_DIRNAME}/001-copilot-lm-impl.md`), "artifactSafe");
    // chat-*.md outside a runs/ directory is an ordinary document.
    assert.equal(classifyWorkflowPathV1("docs/chat-notes.md"), "artifactSafe");
    // A chat-*.md nested deeper than a direct runs/ child is not the legacy shape.
    assert.equal(classifyWorkflowPathV1(`${RUNS_DIRNAME}/sub/chat-1.md`), "artifactSafe");
  });

  void it("leaves task artifacts and source files artifact-safe", () => {
    for (const safe of [
      "task.md",
      "plan.md",
      "plan-final.md",
      "context-pack.md",
      "plans/2026_task_1/task.md",
      "src/utils/contextPack.ts",
      "README.md",
      "plans/t/plan.md.bak",
    ]) {
      assert.equal(classifyWorkflowPathV1(safe), "artifactSafe", safe);
      assert.equal(isWorkflowPrivatePathV1(safe), false, safe);
    }
  });

  void it("fails closed on empty or invalid input", () => {
    assert.equal(classifyWorkflowPathV1(""), "workflowControl");
    assert.equal(classifyWorkflowPathV1("/"), "workflowControl");
    assert.equal(classifyWorkflowPathV1(`bad${String.fromCharCode(0)}path.md`), "workflowControl");
  });

  void it("isWorkflowPrivatePathV1 is true for exactly the non-artifact-safe classes", () => {
    for (const privatePath of [
      CHAT_HISTORY_FILENAME,
      "workflow-runtime-v1/provider-results/a/b/c",
      "workflow-runtime-v1/leases",
      "creation-intents-v1/journal-x.json",
      TASK_PROGRESS_FILENAME,
      MIGRATION_JOURNAL_FILENAME,
      ATOMIC_TEMP_FIXTURE,
      `${RUNS_DIRNAME}/chat-implement.md`,
      "",
    ]) {
      assert.equal(isWorkflowPrivatePathV1(privatePath), true, privatePath);
    }
  });
});
