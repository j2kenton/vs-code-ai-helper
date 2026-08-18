/**
 * Coverage for the `draft.v1` registry row (plan §6.3, "Migrate Draft
 * atomically with task-document formatting" — the second action migrated
 * onto the coordinator, mirroring generatePlanRowV1.test.ts's shape):
 *
 *  - `validateDraftInputV1` accepts only the exact declared shape (and,
 *    unlike generatePlan.v1, requires `baselineRevision` — task.md always
 *    exists by the desc stage).
 *  - A `completed` markdown-artifact.v1 result merges into task.md's
 *    `## Draft with AI` section via a revision-checked read-merge-write,
 *    preserving `## Task Description` untouched and never emitting a fresh
 *    `## Open Questions` section; a STALE captured revision (a concurrent
 *    edit landed after the baseline was read) is refused rather than
 *    clobbered.
 *  - A structurally invalid draft body (missing required subsections) is
 *    wrapped under the `Draft (unstructured)` heading instead of rejected.
 *  - A `questions` result never touches task.md — only the durable Chat
 *    interaction transaction is written.
 *  - Malformed, cross-operation (mismatched correlation), cancelled, and
 *    failed results never touch task.md either.
 *  - Resume after answering reconstructs the action from the persisted
 *    validated-input snapshot (the exact same prompt) and completes it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  ActionConversationOrchestratorV1,
  createActionConversationOrchestratorV1,
  InteractionRefV1,
} from "../actions/actionConversationOrchestratorV1";
import {
  createTaskActionCoordinatorV1,
  RunnerSelectionOpenerV1,
  TaskActionCoordinatorV1,
} from "../actions/taskActionCoordinatorV1";
import { createTaskActionRegistryV1 } from "../actions/taskActionRegistryV1";
import {
  createDraftRowV1,
  DRAFT_ACTION_KEY_V1,
  DRAFT_TARGET_RELATIVE_PATH_V1,
  validateDraftInputV1,
} from "../actions/rows/draftRowV1";
import { DRAFT_UNSTRUCTURED_HEADING } from "../commands/draftTaskWithAI";
import { buildTaskDocument } from "../utils/taskDescriptionDocument";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import { createWorkflowLeaseStoreV1 } from "../services/workflowLeaseStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  ensureWorkflowTaskFolderRootV1,
  getChatInteractionTransactionStoreV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  resetWorkflowRuntimeServicesForTestV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { AgentTransportV1 } from "../types/agentExecutionV1";
import { V1ReserveNextResultV1 } from "../runners/runnerRegistry";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const INITIAL_TASK_MD = [
  "## Task Description",
  "",
  "Build a widget.",
  "",
  "## Draft with AI",
  "",
].join("\n");

const VALID_DRAFT_BODY = [
  "Add a background export queue.",
  "",
  "### Behavior change",
  "",
  "Exports run off the UI thread.",
  "",
  "### Affected areas",
  "",
  "- exportService.ts",
  "",
  "### Actionable changes",
  "",
  "- Add the queue.",
].join("\n");

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function fakeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

/** A `RunnerSelectionOpenerV1` test double: one reservation per listed transport, then exhausted. */
function stubSelectionOpener(transports: readonly AgentTransportV1[]): RunnerSelectionOpenerV1 {
  let cursor = 0;
  return ({ session, mode }) => ({
    reserveNext(attemptId): V1ReserveNextResultV1 {
      const transport = transports[cursor];
      if (!transport) {
        return cursor === 0
          ? { kind: "noneRemaining", code: "providerModeUnavailable" }
          : { kind: "noneRemaining", code: "candidatesExhausted" };
      }
      cursor += 1;
      const handle = session.reserve({
        attemptId,
        mode,
        runnerId: transport.runnerId,
        providerId: "copilot",
        modelId: "copilot:test",
      });
      return {
        kind: "reserved",
        reserved: {
          handle,
          providerLabel: "Test Provider",
          storedModelId: "copilot:test",
          createTransport: () => transport,
        },
      };
    },
  });
}

/** A transport that frames whatever `script` returns for the request's own correlation. */
function scriptedTransport(script: (correlation: unknown) => string): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(script(request.correlation));
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

function completedTransport(markdown: string): AgentTransportV1 {
  return scriptedTransport((correlation) =>
    frame({
      version: 1,
      correlation,
      kind: "completed",
      content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
    })
  );
}

function questionsTransport(): AgentTransportV1 {
  return scriptedTransport((correlation) =>
    frame({
      version: 1,
      correlation,
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "text",
          prompt: "What export formats matter?",
          required: true,
        },
      ],
    })
  );
}

function cancelledTransport(): AgentTransportV1 {
  return scriptedTransport((correlation) => frame({ version: 1, correlation, kind: "cancelled", reason: "user" }));
}

function failedTransport(): AgentTransportV1 {
  return scriptedTransport((correlation) =>
    frame({ version: 1, correlation, kind: "failed", code: "providerError", message: "boom", retryable: false })
  );
}

function malformedTransport(): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (_request, output): Promise<{ kind: "completed" }> => {
      // Short enough (under taskActionCoordinatorV1.ts's
      // FRAMELESS_FALLBACK_MIN_CHARS_V1) to stay genuinely malformed rather
      // than being rescued by tryFramelessContentFallbackV1, which this
      // suite's own tests are not about.
      output.write("no frame");
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/** Echoes a foreign correlation (cross-operation/stale-attempt) instead of the request's own. */
function crossOperationTransport(markdown: string): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (_request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frame({
          version: 1,
          correlation: {
            actionKey: DRAFT_ACTION_KEY_V1,
            operationId: allocateHex128IdV1(),
            attemptId: allocateHex128IdV1(),
            taskBindingId: "some-other-task",
            chatDocumentId: "some-other-doc",
          },
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

interface TestEnvV1 {
  readonly taskFolder: string;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly orchestrator: ActionConversationOrchestratorV1;
  makeCoordinator(transports: readonly AgentTransportV1[]): TaskActionCoordinatorV1;
  readTaskFile(): string | undefined;
  writeTaskFile(content: string): void;
  tearDown(): void;
}

function setUpTestEnvV1(): TestEnvV1 {
  resetWorkflowRuntimeServicesForTestV1();
  const privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-draft-private-"));
  const privateRootId = configureWorkflowPrivateStorageRootV1(privateStorageDir);
  setChatInteractionTransactionStoreV1(
    createChatInteractionTransactionStoreV1({
      registry: getWorkflowPathRegistryV1(),
      fileStore: getWorkflowFileStoreV1(),
      privateRootId,
    })
  );
  const fixture = makeOwnedTaskFolder("ensemble-draft-task-");
  fs.writeFileSync(path.join(fixture.folder, DRAFT_TARGET_RELATIVE_PATH_V1), INITIAL_TASK_MD, "utf8");
  const rootId = ensureWorkflowTaskFolderRootV1(fixture.folder);
  const taskBindingId = getVerifiedTaskBindingIdV1(rootId);
  assert.ok(taskBindingId, "task folder root must verify for this fixture");
  const orchestrator = createActionConversationOrchestratorV1({
    transactionStore: getChatInteractionTransactionStoreV1()!,
  });

  return {
    taskFolder: fixture.folder,
    taskBindingId,
    chatDocumentId: allocateHex128IdV1(),
    orchestrator,
    makeCoordinator(transports: readonly AgentTransportV1[]): TaskActionCoordinatorV1 {
      return createTaskActionCoordinatorV1({
        registry: createTaskActionRegistryV1([createDraftRowV1()]),
        leaseStore: createWorkflowLeaseStoreV1(),
        openRunnerSelection: stubSelectionOpener(transports),
        orchestrator,
        followUpScheduler: { schedule: (): void => undefined },
        presenter: { beginProgress: () => ({ end: (): void => undefined }) },
        auditLogger: { log: (): void => undefined },
      });
    },
    readTaskFile(): string | undefined {
      try {
        return fs.readFileSync(path.join(fixture.folder, DRAFT_TARGET_RELATIVE_PATH_V1), "utf8");
      } catch {
        return undefined;
      }
    },
    writeTaskFile(content: string): void {
      fs.writeFileSync(path.join(fixture.folder, DRAFT_TARGET_RELATIVE_PATH_V1), content, "utf8");
    },
    tearDown(): void {
      resetWorkflowRuntimeServicesForTestV1();
      fs.rmSync(fixture.folder, { recursive: true, force: true });
      fs.rmSync(privateStorageDir, { recursive: true, force: true });
    },
  };
}

async function buildValidatedInput(
  env: TestEnvV1,
  prompt: string
): Promise<{ prompt: string; targetLocator: { rootId: string; relativePath: string }; baselineRevision: string }> {
  const rootId = ensureWorkflowTaskFolderRootV1(env.taskFolder);
  const locator = { rootId, relativePath: DRAFT_TARGET_RELATIVE_PATH_V1 };
  const stat = await getWorkflowFileStoreV1().stat(locator);
  assert.equal(stat.kind, "ok");
  assert.ok(stat.kind === "ok" && stat.value.kind === "file", "task.md must exist for this fixture");
  const baselineRevision =
    stat.kind === "ok" && stat.value.kind === "file" ? stat.value.revision! : "";
  return { prompt, targetLocator: locator, baselineRevision };
}

function baseRequest(env: TestEnvV1, rawInput: unknown): {
  actionKey: string;
  taskBinding: { taskBindingId: string; chatDocumentId: string };
  taskStatus: string;
  taskStage: string;
  rawInput: unknown;
  cancellationToken: vscode.CancellationToken;
} {
  return {
    actionKey: DRAFT_ACTION_KEY_V1,
    taskBinding: { taskBindingId: env.taskBindingId, chatDocumentId: env.chatDocumentId },
    taskStatus: "active",
    taskStage: "desc",
    rawInput,
    cancellationToken: fakeToken(),
  };
}

void describe("draftRowV1", () => {
  void describe("validateDraftInputV1", () => {
    void it("accepts a well-formed input", () => {
      const result = validateDraftInputV1({
        prompt: "hello",
        targetLocator: { rootId: "root-1", relativePath: "task.md" },
        baselineRevision: "v1:10:100:5",
      });
      assert.equal(result.ok, true);
    });

    void it("rejects a missing prompt", () => {
      const result = validateDraftInputV1({
        targetLocator: { rootId: "r", relativePath: "task.md" },
        baselineRevision: "v1:1:1:1",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects an empty prompt", () => {
      const result = validateDraftInputV1({
        prompt: "",
        targetLocator: { rootId: "r", relativePath: "task.md" },
        baselineRevision: "v1:1:1:1",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a missing baselineRevision (task.md always exists by the desc stage)", () => {
      const result = validateDraftInputV1({
        prompt: "hello",
        targetLocator: { rootId: "r", relativePath: "task.md" },
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a relativePath other than task.md", () => {
      const result = validateDraftInputV1({
        prompt: "hello",
        targetLocator: { rootId: "r", relativePath: "plan.md" },
        baselineRevision: "v1:1:1:1",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects an unknown field", () => {
      const result = validateDraftInputV1({
        prompt: "hello",
        targetLocator: { rootId: "r", relativePath: "task.md" },
        baselineRevision: "v1:1:1:1",
        extra: "nope",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a non-object input", () => {
      assert.equal(validateDraftInputV1("nope").ok, false);
      assert.equal(validateDraftInputV1(null).ok, false);
      assert.equal(validateDraftInputV1(undefined).ok, false);
    });
  });

  void describe("end to end through the coordinator", () => {
    let env: TestEnvV1;

    before(() => {
      env = setUpTestEnvV1();
    });
    after(() => {
      env.tearDown();
    });

    void it("a completed result merges into task.md's Draft with AI section, preserving Task Description", async () => {
      const input = await buildValidatedInput(env, "ACTION PROMPT 1");
      const coordinator = env.makeCoordinator([completedTransport(VALID_DRAFT_BODY)]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "completed");
      const content = env.readTaskFile();
      assert.ok(content?.includes("Build a widget."), "Task Description must be preserved");
      assert.ok(content?.includes(VALID_DRAFT_BODY), "the draft body must be written verbatim");
      assert.ok(!content?.includes("## Open Questions"), "a fresh V1 draft must never emit Open Questions");
    });

    void it("a structurally invalid draft is wrapped under the unstructured heading, not rejected", async () => {
      const input = await buildValidatedInput(env, "ACTION PROMPT 2");
      const coordinator = env.makeCoordinator([completedTransport("Just prose with no subsections.")]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "completed");
      const content = env.readTaskFile();
      assert.ok(content?.includes(DRAFT_UNSTRUCTURED_HEADING));
      assert.ok(content?.includes("Just prose with no subsections."));
    });

    void it("refuses to promote over a STALE baseline revision (concurrent edit) and leaves task.md untouched", async () => {
      const input = await buildValidatedInput(env, "ACTION PROMPT 3");
      // Simulate a concurrent edit landing after the baseline revision was
      // captured but before this drive's promotion runs.
      env.writeTaskFile(INITIAL_TASK_MD + "\nEdited concurrently.\n");
      const before = env.readTaskFile();
      const coordinator = env.makeCoordinator([completedTransport(VALID_DRAFT_BODY)]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        // promotionFailureCodeV1 now appends the row's own write-failure
        // detail (bounded/flattened) instead of the bare code — see that
        // function's own doc comment for the live diagnosability gap this
        // closes.
        assert.match(outcome.code, /^promotionFailed: task\.md changed since this drive's baseline revision was captured/);
      }
      assert.equal(env.readTaskFile(), before);
    });

    void it("a questions result never touches task.md — only Chat's durable transaction is written", async () => {
      const before = env.readTaskFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 4");
      const coordinator = env.makeCoordinator([questionsTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "questions");
      assert.equal(env.readTaskFile(), before, "task.md must be byte-identical — questions never touch it");
      if (outcome.kind === "questions") {
        const record = await env.orchestrator.getRecord({
          operationId: outcome.correlation.operationId,
          interactionId: outcome.interactionId,
          taskBindingId: outcome.correlation.taskBindingId,
          chatDocumentId: outcome.correlation.chatDocumentId,
          sourceAttemptId: outcome.correlation.attemptId,
        });
        assert.ok(record, "the durable Chat interaction transaction must exist");
        assert.equal(record?.questions?.length, 1);
        assert.equal(record?.resumeSemantics, "sameOperation");
      }
    });

    void it("a malformed provider response never touches task.md", async () => {
      const before = env.readTaskFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 5");
      const coordinator = env.makeCoordinator([malformedTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "malformedResult");
      assert.equal(env.readTaskFile(), before);
    });

    void it("a cross-operation/stale-attempt result (foreign correlation) never touches task.md", async () => {
      const before = env.readTaskFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 6");
      const coordinator = env.makeCoordinator([crossOperationTransport(VALID_DRAFT_BODY)]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind === "malformedResult") {
        assert.equal(outcome.code, "resultCorrelationMismatch");
      }
      assert.equal(env.readTaskFile(), before);
    });

    void it("a cancelled result never touches task.md", async () => {
      const before = env.readTaskFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 7");
      const coordinator = env.makeCoordinator([cancelledTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "cancelled");
      assert.equal(env.readTaskFile(), before);
    });

    void it("a failed result never touches task.md", async () => {
      const before = env.readTaskFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 8");
      const coordinator = env.makeCoordinator([failedTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "failed");
      assert.equal(env.readTaskFile(), before);
    });

    void it("Resume after answering reconstructs the action from its saved transaction and completes it", async () => {
      const originalPrompt = "ACTION PROMPT — RESUME CASE";
      const input = await buildValidatedInput(env, originalPrompt);
      const firstCoordinator = env.makeCoordinator([questionsTransport()]);
      const questionsOutcome = await firstCoordinator.executeAction(baseRequest(env, input));
      assert.equal(questionsOutcome.kind, "questions");
      if (questionsOutcome.kind !== "questions") {
        return;
      }

      const ref: InteractionRefV1 = {
        operationId: questionsOutcome.correlation.operationId,
        interactionId: questionsOutcome.interactionId,
        taskBindingId: questionsOutcome.correlation.taskBindingId,
        chatDocumentId: questionsOutcome.correlation.chatDocumentId,
        sourceAttemptId: questionsOutcome.correlation.attemptId,
      };
      const submitted = await env.orchestrator.submitAnswers(
        ref,
        [{ questionId: "q1", kind: "text", state: "answered", value: "CSV and JSON." }],
        allocateHex128IdV1()
      );
      assert.equal(submitted.ok, true);

      let sawReconstructedPrompt = false;
      const resumeTransport: AgentTransportV1 = {
        runnerId: "scripted-transport",
        invoke: (request, output) => {
          sawReconstructedPrompt = request.prompt.startsWith(originalPrompt);
          output.write(
            frame({
              version: 1,
              correlation: request.correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: VALID_DRAFT_BODY },
            })
          );
          return Promise.resolve({ kind: "completed" as const });
        },
      };
      const resumeCoordinator = env.makeCoordinator([resumeTransport]);
      const resumeOutcome = await resumeCoordinator.resumeAction({
        interaction: ref,
        taskBinding: { taskBindingId: env.taskBindingId, chatDocumentId: env.chatDocumentId },
        taskStatus: "active",
        taskStage: "desc",
        resumeIdempotencyId: allocateHex128IdV1(),
        cancellationToken: fakeToken(),
      });
      assert.equal(resumeOutcome.kind, "completed");
      assert.equal(sawReconstructedPrompt, true, "Resume must rebuild the exact original prompt from the snapshot");
      assert.ok(env.readTaskFile()?.includes(VALID_DRAFT_BODY));
    });

    void it("always emits canonical LF line endings and one final newline when promoting a CRLF file", async () => {
      const env = setUpTestEnvV1();
      try {
        const crlfTaskMd = [
          "# Task",
          "",
          "## Task Description",
          "",
          "Build a widget.",
          "",
          "## Draft with AI",
          "",
        ].join("\r\n");
        env.writeTaskFile(crlfTaskMd);

        const rootId = ensureWorkflowTaskFolderRootV1(env.taskFolder);
        const targetLocator = { rootId, relativePath: DRAFT_TARGET_RELATIVE_PATH_V1 };
        const fileStore = getWorkflowFileStoreV1();
        const statResult = await fileStore.stat(targetLocator);
        assert.equal(statResult.kind, "ok");
        const baselineRevision = (statResult as { value: { revision: string } }).value.revision;

        const transport: AgentTransportV1 = {
          runnerId: "scripted-transport",
          invoke: (request, output) => {
            output.write(
              frame({
                version: 1,
                correlation: request.correlation,
                kind: "completed",
                content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: VALID_DRAFT_BODY },
              })
            );
            return Promise.resolve({ kind: "completed" as const });
          },
        };

        const validated = validateDraftInputV1({
          prompt: "Draft prompt",
          targetLocator,
          baselineRevision,
        });
        assert.equal(validated.ok, true);
        const input = (validated as { ok: true; input: unknown }).input;

        const coordinator = env.makeCoordinator([transport]);
        const outcome = await coordinator.executeAction({
          actionKey: DRAFT_ACTION_KEY_V1,
          taskBinding: { taskBindingId: env.taskBindingId, chatDocumentId: env.chatDocumentId },
          taskStatus: "active",
          taskStage: "desc",
          rawInput: input,
          cancellationToken: fakeToken(),
        });

        assert.equal(outcome.kind, "completed");
        const writtenContent = env.readTaskFile()!;
        assert.equal(writtenContent.includes("\r\n"), false, "Canonical V1 rewrite must not contain CRLF");
        assert.equal(writtenContent.endsWith("\n"), true, "Canonical V1 rewrite must end with LF newline");
        assert.equal(writtenContent.endsWith("\n\n"), false, "Canonical V1 rewrite must end with EXACTLY ONE LF newline, not two");
      } finally {
        env.tearDown();
      }
    });

    void it("buildTaskDocument guarantees exactly one final LF newline even when draftWithAI ends in newlines", () => {
      const docWithTrailingNewlines = buildTaskDocument({
        introText: "",
        taskDescription: "Description text.",
        draftWithAI: "Draft text.\n\n\n",
        openQuestions: "",
      });
      assert.equal(docWithTrailingNewlines.endsWith("\n"), true, "buildTaskDocument must end with LF newline");
      assert.equal(docWithTrailingNewlines.endsWith("\n\n"), false, "buildTaskDocument must not end with double LF newline");

      const docWithoutTrailingNewlines = buildTaskDocument({
        introText: "",
        taskDescription: "Description text.",
        draftWithAI: "Draft text.",
        openQuestions: "",
      });
      assert.equal(docWithoutTrailingNewlines.endsWith("\n"), true, "buildTaskDocument must end with LF newline");
      assert.equal(docWithoutTrailingNewlines.endsWith("\n\n"), false, "buildTaskDocument must not end with double LF newline");
    });

    void it("verifies creation seed-history fixtures exist and match legacy vs canonical contracts", () => {
      const fixturesDir = path.join(process.cwd(), "test-fixtures", "creation-seeds");
      const manifestPath = path.join(fixturesDir, "seed-history-v1.json");

      assert.equal(fs.existsSync(manifestPath), true, "seed history manifest must exist");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        schemaVersion: number;
        seeds: Array<{ id: string; fixture: string; version: string; hasOpenQuestionsHeading: boolean }>;
      };

      assert.equal(manifest.seeds.length, 5, "seed history must inventory all 5 historical and V1 creation seeds");

      const templatePath = path.join(process.cwd(), "resources", "prompts", "task-template.md");
      assert.equal(fs.existsSync(templatePath), true, "task-template.md must exist");
      const templateContent = fs.readFileSync(templatePath, "utf8");
      const inlineFallback = "# Task\n\n## Task Description\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n## Draft with AI\n\n[Click the Draft with AI button, or press Ctrl+Shift+Alt+I]\n";

      for (const entry of manifest.seeds) {
        const fixturePath = path.join(fixturesDir, entry.fixture);
        assert.equal(fs.existsSync(fixturePath), true, `seed fixture ${entry.fixture} must exist`);
        const content = fs.readFileSync(fixturePath, "utf8");
        assert.equal(content.endsWith("\n"), true, `fixture ${entry.fixture} must end with LF newline`);
        if (entry.id === "v1-canonical") {
          assert.equal(content.endsWith("\n\n"), false, `canonical V1 fixture ${entry.fixture} must end with exactly one LF newline`);
          assert.equal(content, templateContent, `canonical V1 fixture ${entry.fixture} must match task-template.md byte-for-byte`);
          assert.equal(content, inlineFallback, `canonical V1 fixture ${entry.fixture} must match startNewTask inline fallback byte-for-byte`);
        }
        assert.equal(
          content.includes("## Open Questions"),
          entry.hasOpenQuestionsHeading,
          `fixture ${entry.fixture} hasOpenQuestionsHeading mismatch`
        );
      }
    });
  });
});

