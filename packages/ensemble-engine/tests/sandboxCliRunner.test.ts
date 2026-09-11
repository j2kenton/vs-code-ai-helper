/**
 * Coverage for `createSandboxCliProviderRunnerV1`: the runner that drives a
 * round by running the real Claude Code CLI inside the sandbox. The
 * in-memory sandbox client's `onCommand` hook plays the CLI: it reads the
 * prompt file the runner wrote (proving delivery), echoes the correlation
 * back inside a strict result frame written to the redirected stdout file
 * (proving the read-back path), and chooses an exit code per scenario.
 *
 * Structured-questions envelopes are exercised by the shared envelope tests;
 * this file pins the runner's own contract: argv per stage, prompt/output
 * plumbing, attempt-marked execution under the gate machinery, failure
 * classification of a non-zero exit, and scratch-file cleanup.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateHex128IdV1, type ActionCorrelationV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { createRecordingEventSinkV1 } from "../src/engineEventsV1";
import { createEngineGateMachineryV1 } from "../src/gateMachineryV1";
import {
  createInMemorySandboxClientV1,
  SANDBOX_ATTEMPT_KEY_MARKER_V1,
  type InMemorySandboxClientV1,
  type SandboxCommandRequestV1,
} from "../src/sandboxClientV1";
import {
  buildClaudeCliArgvV1,
  buildSandboxCliScriptV1,
  CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT_V1,
  createSandboxCliProviderRunnerV1,
  parseSandboxCliModelSelectionV1,
  renderEnvFileV1,
  sandboxCliModeForStageV1,
  SANDBOX_CLI_ROUND_FAILURE_CODES_V1,
} from "../src/sandboxCliRunnerV1";
import type { EngineProviderInvocationV1 } from "../src/taskLoopV1";

const SANDBOX = "sbx-cli";
const ROOT = "/workspace/repo";
const PLAN = "- [ ] add the endpoint\n- [ ] write the test";
const SUMMARY = "- [x] add the endpoint\n- [ ] write the test\n<!-- progress: 1/2 -->";

function invocation(stage: EngineProviderInvocationV1["stage"]): EngineProviderInvocationV1 {
  const correlation: ActionCorrelationV1 = {
    actionKey: "engine.runRound.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "binding-digest",
    chatDocumentId: "chat-doc",
  };
  return { taskId: "task-1", taskFolder: "task-1", stage, round: 1, correlation, planOfRecord: PLAN };
}

/** The in-memory "CLI": reads the prompt the runner delivered, answers in a strict frame. */
function scriptedCli(options: {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly frame?: (correlation: unknown) => string;
}): (request: SandboxCommandRequestV1, client: InMemorySandboxClientV1) => { exitCode: number; stdoutTail: string; stderrTail: string } {
  return (request, client) => {
    const script = request.argv[2] ?? "";
    const promptPath = /< '([^']+)'/.exec(script)?.[1];
    const outputPath = /> '([^']+)' 2>/.exec(script)?.[1];
    const stderrPath = /2> '([^']+)'$/.exec(script)?.[1];
    assert.ok(promptPath && outputPath && stderrPath, "the wrapper redirects prompt, stdout, and stderr");
    const prompt = client.readFile(request.sandboxId, promptPath);
    assert.ok(prompt !== undefined && prompt.includes(PLAN), "the prompt file carries the plan of record");
    const echo = /\(echo it verbatim\): (\{[^\n]*\})/.exec(prompt);
    assert.ok(echo, "the round prompt carries the correlation echo");
    const correlation = JSON.parse(echo[1] as string) as unknown;
    const frame =
      options.frame?.(correlation) ??
      `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify({
        version: 1,
        correlation,
        kind: "completed",
        content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: SUMMARY },
      })}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
    client.addFile(request.sandboxId, outputPath, frame);
    client.addFile(request.sandboxId, stderrPath, options.stderr ?? "");
    return { exitCode: options.exitCode ?? 0, stdoutTail: "", stderrTail: options.stderr ?? "" };
  };
}

function makeRunner(client: InMemorySandboxClientV1, extra?: { env?: Record<string, string>; model?: string }) {
  const machinery = createEngineGateMachineryV1({
    taskId: "task-1",
    ownerId: "owner-1",
    workerId: "worker-1",
    sink: createRecordingEventSinkV1(),
  });
  return createSandboxCliProviderRunnerV1({
    client,
    sandboxId: SANDBOX,
    workingDirectoryRoot: ROOT,
    machinery,
    ...(extra?.env !== undefined ? { env: extra.env } : {}),
    ...(extra?.model !== undefined ? { model: extra.model } : {}),
  });
}

test("stage → mode: only impl writes; argv mirrors the extension's Claude Code definition", () => {
  assert.equal(sandboxCliModeForStageV1("impl"), "edit");
  for (const stage of ["desc", "plan", "plan-high-review", "impl-high-review", "publish"] as const) {
    assert.equal(sandboxCliModeForStageV1(stage), "plan");
  }
  assert.deepEqual(buildClaudeCliArgvV1({ mode: "edit", model: "claude-opus-5" }), [
    "claude", "-p", "--output-format", "text", "--permission-mode", "acceptEdits", "--model", "claude-opus-5",
  ]);
  assert.deepEqual(buildClaudeCliArgvV1({ mode: "plan" }), [
    "claude", "-p", "--output-format", "text", "--permission-mode", "plan",
    "--append-system-prompt", CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT_V1,
  ]);
});

test("an impl round runs the CLI in edit mode, attempt-marked, and returns the framed summary", async () => {
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const runner = makeRunner(client, { model: "claude-opus-5" });

  const result = await runner.invoke(invocation("impl"));

  assert.deepEqual(result, { kind: "completed", summaryMarkdown: SUMMARY });
  assert.equal(client.executedCommands.length, 1);
  const executed = client.executedCommands[0]!;
  assert.equal(executed.cwd, ROOT);
  assert.deepEqual(executed.argv.slice(0, 2), ["sh", "-c"]);
  const script = executed.argv[2] as string;
  assert.match(script, /'claude' '-p' '--output-format' 'text' '--permission-mode' 'acceptEdits' '--model' 'claude-opus-5'/);
  assert.match(executed.commandText, new RegExp(`^${SANDBOX_ATTEMPT_KEY_MARKER_V1}='[0-9a-f]+' `));
  // Scratch files never outlive the round.
  for (const path of [/\.prompt\.md'/, /\.out'/, /\.err'/]) {
    const match = path.exec(script);
    assert.ok(match);
  }
  const promptPath = /< '([^']+)'/.exec(script)![1] as string;
  assert.equal(client.readFile(SANDBOX, promptPath), undefined);
});

test("a review round runs read-only plan mode with the headless system prompt", async () => {
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const runner = makeRunner(client);

  const result = await runner.invoke(invocation("impl-high-review"));

  assert.equal(result.kind, "completed");
  const script = client.executedCommands[0]!.argv[2] as string;
  assert.match(script, /'--permission-mode' 'plan' '--append-system-prompt' '/);
  assert.ok(script.includes("ExitPlanMode and AskUserQuestion tools are not available"));
});

test("a non-zero exit is classified like the direct-API path: quota retries, auth never does", async () => {
  const quota = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ exitCode: 1, stderr: "API Error: 429 usage limit reached for this account" }),
  });
  assert.deepEqual(await makeRunner(quota).invoke(invocation("impl")), {
    kind: "failed",
    code: "quotaExhausted",
    retryable: true,
  });

  const auth = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ exitCode: 1, stderr: "Error: Invalid API key · Please run /login" }),
  });
  const authResult = await makeRunner(auth).invoke(invocation("impl"));
  assert.equal(authResult.kind, "failed");
  assert.ok(authResult.kind === "failed" && authResult.retryable === false);

  const generic = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ exitCode: 2, stderr: "something unrelated broke" }),
  });
  assert.deepEqual(await makeRunner(generic).invoke(invocation("impl")), {
    kind: "failed",
    code: "cliExit2",
    retryable: false,
  });
});

test("a signed-out CLI (exit 0, 'Not logged in' on stdout) is a terminal auth failure, not a retryable malformed frame", async () => {
  // The real shape, captured live from `claude -p` in a sandbox with no
  // persisted login: nothing on stderr, exit code 0, and only this on stdout.
  const client = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ exitCode: 0, frame: () => "Not logged in · Please run /login\n" }),
  });

  assert.deepEqual(await makeRunner(client).invoke(invocation("impl")), {
    kind: "failed",
    code: "authenticationFailed",
    retryable: false,
  });

  // The fresh-sandbox variant, also captured live: same stdout text, exit 1,
  // stderr empty. The words are in the redirected stdout FILE, not in the
  // command's captured tail — a runner that only reads stderr on a non-zero
  // exit sees nothing and reports a bare cliExit1.
  const freshSandbox = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ exitCode: 1, stderr: "", frame: () => "Not logged in · Please run /login\n" }),
  });
  assert.deepEqual(await makeRunner(freshSandbox).invoke(invocation("impl")), {
    kind: "failed",
    code: "authenticationFailed",
    retryable: false,
  });
});

test("output without the result frame is a retryable malformed-result failure, never promoted content", async () => {
  const client = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ frame: () => "I edited the files and everything is great.\n" }),
  });

  assert.deepEqual(await makeRunner(client).invoke(invocation("impl")), {
    kind: "failed",
    code: "malformedResult.invalidFrame",
    retryable: true,
  });
});

test("an unframed reply that merely MENTIONS logging in is the model's malformed output, not an expired credential", async () => {
  // The signed-out detection must match the CLI's own short refusal only: a
  // model working on login code and forgetting the frame used to be
  // indistinguishable from "Not logged in" and failed the task as auth.
  const client = createInMemorySandboxClientV1({
    onCommand: scriptedCli({
      frame: () =>
        "I refactored the login form and the session refresh. Users who are not logged in are now redirected " +
        "to /login, and the OAuth callback validates the state parameter. ".repeat(4),
    }),
  });
  assert.deepEqual(await makeRunner(client).invoke(invocation("impl")), {
    kind: "failed",
    code: "malformedResult.invalidFrame",
    retryable: true,
  });
});

test("transport classification: exit failures and the signed-out refusal are classified; a model-reported failure is classified by its MESSAGE only", async () => {
  const quota = createInMemorySandboxClientV1({
    onCommand: scriptedCli({ exitCode: 1, stderr: "API Error: 429 usage limit reached for this account" }),
  });
  const quotaOutcome = await makeRunner(quota).invokeWithModel(invocation("impl"), "sonnet");
  assert.equal(quotaOutcome.classification?.failureKind, "quota");
  assert.equal(quotaOutcome.classification?.authFailure, false);

  // A framed `failed` reply that CLAIMS quota in its code, with an unrelated
  // message: the code is model-written, so no classification is attached
  // and dispatch cannot cascade on it.
  const forged = createInMemorySandboxClientV1({
    onCommand: scriptedCli({
      frame: (correlation) =>
        `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify({
          version: 1,
          correlation,
          kind: "failed",
          code: "quotaExhausted",
          message: "I could not find the file you mentioned.",
          retryable: true,
        })}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`,
    }),
  });
  const forgedOutcome = await makeRunner(forged).invokeWithModel(invocation("impl"), "sonnet");
  assert.deepEqual(forgedOutcome.result, { kind: "failed", code: "quotaExhausted", retryable: true });
  assert.equal(forgedOutcome.classification, undefined);
});

test("cascade candidates get their own crash-safe step: a second model on the same invocation really runs", async () => {
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const runner = makeRunner(client);
  const shared = invocation("impl");
  assert.equal((await runner.invokeWithModel(shared, "sonnet")).result.kind, "completed");
  // Same invocation (same attempt id), different candidate — as dispatch hands it to a backup.
  assert.equal((await runner.invokeWithModel(shared, "opus")).result.kind, "completed");
  assert.equal(client.executedCommands.length, 2, "the backup must not be reported as already executed");
});

test("output the provider will not read back (oversized) is a terminal 'too large', not a retryable 'missing'", async () => {
  // Docker's client refuses to read files over 8 MB; the output file EXISTS.
  // Reporting it as missing (retryable) re-ran a whole edit-mode round.
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const refusing = { ...client, readFileUtf8: () => Promise.resolve(undefined) };
  const runner = createSandboxCliProviderRunnerV1({
    client: refusing,
    sandboxId: SANDBOX,
    workingDirectoryRoot: ROOT,
    machinery: createEngineGateMachineryV1({
      taskId: "task-1",
      ownerId: "owner-1",
      workerId: "worker-1",
      sink: createRecordingEventSinkV1(),
    }),
  });
  assert.deepEqual(await runner.invoke(invocation("impl")), {
    kind: "failed",
    code: SANDBOX_CLI_ROUND_FAILURE_CODES_V1.outputTooLarge,
    retryable: false,
  });
});

test("a step id is unique per invocation, so a second round never reads as alreadyExecuted", async () => {
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const runner = makeRunner(client);

  assert.equal((await runner.invoke(invocation("impl"))).kind, "completed");
  assert.equal((await runner.invoke(invocation("impl"))).kind, "completed");
  assert.equal(client.executedCommands.length, 2);
  assert.notEqual(client.executedCommands[0]!.attemptKey, client.executedCommands[1]!.attemptKey);
});

test("env is delivered through a sourced file, strictly quoted, never on the command line", async () => {
  assert.equal(
    renderEnvFileV1({ ANTHROPIC_API_KEY: "sk-ant-it's-secret", HOME: "/home/user" }),
    "export ANTHROPIC_API_KEY='sk-ant-it'\\''s-secret'\nexport HOME='/home/user'\n"
  );
  assert.throws(() => renderEnvFileV1({ "bad name": "x" }), /invalid environment variable name/);

  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const runner = makeRunner(client, { env: { ANTHROPIC_API_KEY: "sk-ant-secret" } });
  await runner.invoke(invocation("impl"));

  const script = client.executedCommands[0]!.argv[2] as string;
  assert.match(script, /^\. '\/tmp\/ensemble-cli\/[0-9a-f]+\.env' && 'claude'/);
  assert.equal(script.includes("sk-ant-secret"), false);
  assert.equal(client.executedCommands[0]!.commandText.includes("sk-ant-secret"), false);

  assert.equal(
    buildSandboxCliScriptV1({ argv: ["claude", "-p"], promptPath: "/p", outputPath: "/o", stderrPath: "/e" }),
    "'claude' '-p' < '/p' > '/o' 2> '/e'"
  );
});

test("recovery outcomes with no captured output fail closed instead of re-running the CLI", async () => {
  // A worker that never gets the lease cannot have run the CLI: retryable.
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const shared = createEngineGateMachineryV1({
    taskId: "task-1",
    ownerId: "owner-1",
    workerId: "worker-a",
    sink: createRecordingEventSinkV1(),
    leaseTtlMs: 60_000,
  });
  const holder = await shared.leaseStore.acquire("task-1", "someone-else", 60_000);
  assert.equal(holder.acquired, true);
  const runner = createSandboxCliProviderRunnerV1({
    client,
    sandboxId: SANDBOX,
    workingDirectoryRoot: ROOT,
    machinery: shared,
  });
  assert.deepEqual(await runner.invoke(invocation("impl")), {
    kind: "failed",
    code: SANDBOX_CLI_ROUND_FAILURE_CODES_V1.leaseUnavailable,
    retryable: true,
  });
  assert.equal(client.executedCommands.length, 0);
});

test("model selection: the extension's @<effort> suffix becomes --max-thinking-tokens, anything else stays on the name", () => {
  assert.deepEqual(parseSandboxCliModelSelectionV1(undefined), { model: undefined, maxThinkingTokens: undefined });
  assert.deepEqual(parseSandboxCliModelSelectionV1(""), { model: undefined, maxThinkingTokens: undefined });
  assert.deepEqual(parseSandboxCliModelSelectionV1("opus"), { model: "opus", maxThinkingTokens: undefined });
  assert.deepEqual(parseSandboxCliModelSelectionV1("opus@high"), { model: "opus", maxThinkingTokens: 8192 });
  assert.deepEqual(parseSandboxCliModelSelectionV1("sonnet@max"), { model: "sonnet", maxThinkingTokens: 32768 });
  // An unknown suffix is not an effort level: the CLI gets the name verbatim.
  assert.deepEqual(parseSandboxCliModelSelectionV1("opus@turbo"), { model: "opus@turbo", maxThinkingTokens: undefined });
  assert.deepEqual(buildClaudeCliArgvV1({ mode: "edit", model: "opus", maxThinkingTokens: 8192 }).slice(-4), [
    "--model", "opus", "--max-thinking-tokens", "8192",
  ]);
});

test("invokeWithModel binds the selection's model per call, overriding the runner's default", async () => {
  const client = createInMemorySandboxClientV1({ onCommand: scriptedCli({}) });
  const runner = makeRunner(client, { model: "sonnet" });

  assert.equal((await runner.invokeWithModel(invocation("impl"), "opus@high")).result.kind, "completed");
  assert.equal((await runner.invokeWithModel(invocation("impl"), undefined)).result.kind, "completed");
  assert.equal((await runner.invoke(invocation("impl"))).kind, "completed");

  const scripts = client.executedCommands.map((command) => command.argv[2] as string);
  assert.match(scripts[0]!, /'--model' 'opus' '--max-thinking-tokens' '8192'/);
  assert.equal(scripts[1]!.includes("--model"), false, "an undefined selection runs the CLI default, not the runner default");
  assert.match(scripts[2]!, /'--model' 'sonnet'/);
});
