/**
 * bugs3 Step 6: Cline's receipt of the prompt is read from the session record
 * that belongs to THIS attempt, a round whose prompt was not delivered fails as
 * "prompt not delivered" with no continuation, and what it changed is reported
 * apart from ordinary edits.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { execCliAgent, setClineReceiptCheckForTestsV1 } from "../runners/cliAgentRunner";
import { CLINE_CLI_ARGV_PROMPT_PLACEHOLDER, type CliProviderDefinition } from "../runners/providers";
import {
  checkClinePromptReceiptOnDiskV1,
  createClineSessionIoV1,
  describeUndeliveredPromptEditsV1,
  expectedClineFirstUserMessageV1,
  resolveClineDataDirV1,
  selectAttemptSessionV1,
  type ClineReceiptCheckV1,
} from "../utils/clinePromptReceiptV1";

const PLACEHOLDER = CLINE_CLI_ARGV_PROMPT_PLACEHOLDER;
const PROMPT = `Implement step 4.\n${"y".repeat(5000)}\nEND`;
const SPAWNED_AT = Date.parse("2026-10-28T05:38:35.000Z");

function writeSession(
  dataDir: string,
  id: string,
  record: { pid: number; started_at: string },
  firstMessage: string | undefined
): void {
  const directory = path.join(dataDir, "sessions", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, ...record }));
  if (firstMessage !== undefined) {
    fs.writeFileSync(
      path.join(directory, `${id}.messages.json`),
      JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: firstMessage }] }] })
    );
  }
}

void describe("Cline receipt read from the attempt's own session (bugs3 Step 6)", () => {
  let dataDir: string;
  const binding = { pid: 4242, spawnedAtMs: SPAWNED_AT };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-cline-data-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const check = (): Promise<ClineReceiptCheckV1> =>
    checkClinePromptReceiptOnDiskV1({
      dataDir,
      placeholder: PLACEHOLDER,
      prompt: PROMPT,
      binding,
      io: createClineSessionIoV1(0),
    });

  void it("confirms delivery from the session whose pid is the attempt's process", async () => {
    writeSession(dataDir, "s-mine", { pid: 4242, started_at: "2026-10-28T05:38:36.000Z" }, expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT));
    writeSession(dataDir, "s-other", { pid: 7, started_at: "2026-10-28T05:38:37.000Z" }, `<user_input mode="act">${PLACEHOLDER}</user_input>`);
    const result = await check();
    assert.equal(result.kind, "delivered");
    if (result.kind === "delivered") {
      assert.equal(result.sessionId, "s-mine");
      assert.equal(result.basis, "pid");
    }
  });

  void it("reports the placeholder-only message of an undelivered prompt as not delivered", async () => {
    writeSession(dataDir, "s-mine", { pid: 4242, started_at: "2026-10-28T05:38:36.000Z" }, `<user_input mode="act">${PLACEHOLDER}</user_input>`);
    const result = await check();
    assert.equal(result.kind, "notDelivered");
    if (result.kind === "notDelivered") {
      assert.equal(result.verdict.code, "placeholderOnly");
    }
  });

  void it("reports a truncated prompt as not delivered, without copying prompt text into the detail", async () => {
    const truncated = expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT.slice(0, 2000));
    writeSession(dataDir, "s-mine", { pid: 4242, started_at: "2026-10-28T05:38:36.000Z" }, truncated);
    const result = await check();
    assert.equal(result.kind, "notDelivered");
    if (result.kind === "notDelivered") {
      assert.doesNotMatch(result.verdict.detail, /yyyy/);
    }
  });

  void it("falls back to the one session that started in the attempt's window when no pid matches", async () => {
    writeSession(dataDir, "s-shell", { pid: 9999, started_at: "2026-10-28T05:38:36.000Z" }, expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT));
    const result = await check();
    assert.equal(result.kind, "delivered");
    if (result.kind === "delivered") {
      assert.equal(result.basis, "unique-start-window");
    }
  });

  void it("trusts no session when several could belong to the attempt", async () => {
    writeSession(dataDir, "s-a", { pid: 9001, started_at: "2026-10-28T05:38:36.000Z" }, expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT));
    writeSession(dataDir, "s-b", { pid: 9002, started_at: "2026-10-28T05:38:37.000Z" }, expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT));
    const result = await check();
    assert.equal(result.kind, "unverifiable");
  });

  void it("never selects a session that started long before the attempt", async () => {
    writeSession(dataDir, "s-old", { pid: 4242, started_at: "2026-10-26T05:38:36.000Z" }, expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT));
    const result = await check();
    assert.equal(result.kind, "unverifiable");
  });

  void it("is unverifiable when the data folder is missing or the session has no messages file", async () => {
    assert.equal((await check()).kind, "unverifiable");
    writeSession(dataDir, "s-mine", { pid: 4242, started_at: "2026-10-28T05:38:36.000Z" }, undefined);
    assert.equal((await check()).kind, "unverifiable");
  });

  void it("selects by pid first and calls two pid matches ambiguous", () => {
    const candidate = (pid: number, id: string) => ({
      session: { session_id: id, pid, started_at: "2026-10-28T05:38:36.000Z" },
      directory: id,
    });
    assert.equal(selectAttemptSessionV1([candidate(4242, "a"), candidate(1, "b")], binding) !== undefined, true);
    assert.equal(selectAttemptSessionV1([candidate(4242, "a"), candidate(4242, "b")], binding), "ambiguous");
  });

  void it("resolves Cline's data folder from an override or the home folder", () => {
    assert.equal(resolveClineDataDirV1({ CLINE_DATA_DIR: "/custom" }, "/home/u"), "/custom");
    assert.equal(resolveClineDataDirV1({}, "/home/u/"), "/home/u/.cline/data");
  });
});

void describe("execCliAgent judges a Cline run by its receipt (bugs3 Step 6)", () => {
  const fakeCline: CliProviderDefinition = {
    id: "cline-cli",
    label: "Cline CLI",
    command: process.execPath,
    installHint: "install",
    loginHint: "login",
    authErrorMarkers: [],
    signInCommand: "login",
    signInLabel: "Sign in",
    promptTransport: "stdin",
    useShell: false,
    models: [{ model: undefined, name: "default" }],
    usesLastMessageFile: false,
    textModeResponseContractV1: "honours",
    buildArgs(): string[] {
      return ["-e", "process.stdin.resume(); process.stdin.on('end', () => console.log('all done'))"];
    },
  };
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const run = (): ReturnType<typeof execCliAgent> => {
    const cts = new vscode.CancellationTokenSource();
    return execCliAgent({ def: fakeCline, mode: "text", model: undefined, prompt: PROMPT, cwd: process.cwd(), token: cts.token });
  };
  const notDelivered: ClineReceiptCheckV1 = {
    kind: "notDelivered",
    verdict: { ok: false, code: "placeholderOnly", detail: "Cline's first message is the placeholder instruction without the prompt." },
  };

  void it("returns a delivered run unchanged", async () => {
    restore = setClineReceiptCheckForTestsV1(() => Promise.resolve({ kind: "delivered" as const, sessionId: "s", basis: "pid" as const }));
    const result = await run();
    assert.equal(result.status, "completed");
    assert.equal(result.promptNotDeliveredV1, undefined);
  });

  void it("fails a completed run whose prompt never arrived as 'prompt not delivered', with no retry or continuation signal", async () => {
    let boundPid: number | undefined;
    restore = setClineReceiptCheckForTestsV1((input) => {
      boundPid = input.binding.pid;
      assert.equal(input.prompt, PROMPT, "the check compares against the exact prompt that was sent");
      return Promise.resolve(notDelivered);
    });
    const result = await run();
    assert.equal(result.status, "failed");
    assert.equal(result.promptNotDeliveredV1, true);
    assert.match(result.errorMessage ?? "", /^Prompt not delivered: Cline did not receive the prompt/);
    assert.doesNotMatch(result.errorMessage ?? "", /cut short/i);
    assert.equal(result.resumeConversation, undefined);
    assert.equal(result.transient, undefined);
    assert.equal(result.providerCapacity, undefined);
    assert.equal(typeof boundPid, "number", "the check is bound to the process Ensemble spawned");
  });

  void it("fails a completed run it cannot verify on POSIX, but leaves a run that already failed alone", async () => {
    if (process.platform === "win32") {
      return;
    }
    restore = setClineReceiptCheckForTestsV1(() =>
      Promise.resolve({
        kind: "unverifiable" as const,
        verdict: { ok: false as const, code: "noSessionRecord" as const, detail: "No Cline session record for this attempt could be found." },
      })
    );
    const result = await run();
    assert.equal(result.status, "failed");
    assert.equal(result.promptNotDeliveredV1, true);
  });

  void it("treats an exception while reading the session as unverifiable, never as delivered", async () => {
    if (process.platform === "win32") {
      return;
    }
    restore = setClineReceiptCheckForTestsV1(() => Promise.reject(new Error("EACCES")));
    const result = await run();
    assert.equal(result.promptNotDeliveredV1, true);
  });
});

void describe("edits made without the prompt are reported apart (bugs3 Step 6)", () => {
  void it("says nothing for a round that changed nothing", () => {
    assert.equal(
      describeUndeliveredPromptEditsV1({ providerLabel: "Cline CLI", filesChanged: [], filesChangedUnknown: false }),
      undefined
    );
  });

  void it("names the changed files, says they were not asked for and that no continuation was scheduled", () => {
    const text = describeUndeliveredPromptEditsV1({
      providerLabel: "Cline CLI",
      filesChanged: ["src/utils/gitIndexLockV1.ts", "src/commands/addKimiReadConfigV1.ts"],
      filesChangedUnknown: false,
    });
    assert.ok(text);
    assert.match(text, /^Changes made without the prompt: Cline CLI never received the prompt/);
    assert.match(text, /no continuation was scheduled/);
    assert.match(text, /- src\/utils\/gitIndexLockV1\.ts/);
    assert.match(text, /git restore -- <path>/);
  });

  void it("caps a long list and says how many were left out", () => {
    const files = Array.from({ length: 29 }, (_, index) => `src/f${index}.ts`);
    const text = describeUndeliveredPromptEditsV1({ providerLabel: "Cline CLI", filesChanged: files, filesChangedUnknown: false });
    assert.match(text ?? "", /…and 9 more/);
  });

  void it("still reports a change set it could not list", () => {
    const text = describeUndeliveredPromptEditsV1({ providerLabel: "Cline CLI", filesChanged: [], filesChangedUnknown: true });
    assert.match(text ?? "", /could not list the changed files/);
  });
});
