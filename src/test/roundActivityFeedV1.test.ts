/**
 * run1 Step 11: the round's activity feed counts only what the round provably did.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRoundIdleV1, RoundActivityFeedV1 } from "../utils/roundActivityFeedV1";

const ROOT = "/work/repo";
const PROGRESS_FILE = `${ROOT}/.ensemble/2026-11-06_task_1/round-progress.md`;

const toolLine = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const textLine = (text: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

function streamingFeed(): RoundActivityFeedV1 {
  return new RoundActivityFeedV1({ workspaceRoot: ROOT, roundProgressPath: PROGRESS_FILE, streaming: true });
}

const kinds = (feed: RoundActivityFeedV1): string[] => feed.entries().map((entry) => entry.kind);

void describe("RoundActivityFeedV1 (run1 Step 11)", () => {
  void it("records nothing for another task's task.md, .ensemble heartbeat files, .git, dist or out", () => {
    const feed = streamingFeed();
    feed.recordFileChanges(
      [
        `${ROOT}/.ensemble/2026-11-06_task_2/task.md`,
        `${ROOT}/.ensemble/heartbeat.json`,
        `${ROOT}/.git/index`,
        `${ROOT}/dist/extension.js`,
        `${ROOT}/out/test/a.js`,
      ],
      1000
    );
    assert.deepEqual(feed.entries(), []);
    assert.equal(feed.lastLivenessAt(), undefined);
  });

  void it("streaming: an edit event naming a file plus that file's change in the next scan is one progress entry", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Edit", { file_path: `${ROOT}/src/a.ts` }), 1000);
    feed.recordFileChanges([`${ROOT}/src/a.ts`], 2000);
    assert.deepEqual(feed.attributedFiles(), ["src/a.ts"]);
    assert.equal(feed.lastProgressWhat, "edited `a.ts`");
    assert.equal(feed.lastProgressAt, 2000);
    assert.equal(feed.entries().filter((e) => e.kind === "progress").length, 2, "the event itself, then the confirmed change");
    assert.deepEqual(feed.observedFiles(), []);
  });

  void it("streaming: a second change to the same file with no new edit event is only observed", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Write", { file_path: `${ROOT}/src/a.ts` }), 1000);
    feed.recordFileChanges([`${ROOT}/src/a.ts`], 2000);
    const progressAfterFirst = feed.lastProgressAt;
    feed.recordFileChanges([`${ROOT}/src/a.ts`], 17_000);
    assert.equal(feed.lastProgressAt, progressAfterFirst);
    assert.deepEqual(feed.observedFiles(), ["src/a.ts"]);
    assert.equal(feed.attributedFiles().length, 1);
  });

  void it("streaming: a source change with no matching edit event (from another host) is only observed", () => {
    const feed = streamingFeed();
    feed.recordFileChanges([`${ROOT}/src/other.ts`], 5000);
    assert.deepEqual(kinds(feed), ["observed"]);
    assert.equal(feed.lastLivenessAt(), undefined, "an observed change never counts as the round's activity");
    assert.deepEqual(feed.attributedFiles(), []);
  });

  void it("streaming: a change while a command runs, with no event naming the file, is only observed", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Bash", { command: "pnpm run build" }), 1000);
    feed.recordFileChanges([`${ROOT}/src/generated.ts`], 16_000);
    feed.recordFileChanges([`${ROOT}/src/generated.ts`], 31_000);
    assert.deepEqual(feed.attributedFiles(), []);
    assert.equal(feed.lastProgressAt, 1000, "only the command event was progress");
    assert.deepEqual(feed.observedFiles(), ["src/generated.ts"]);
  });

  void it("an edit event attributes only the first scan after it", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Edit", { file_path: `${ROOT}/src/a.ts` }), 1000);
    feed.recordFileChanges([], 16_000);
    feed.recordFileChanges([`${ROOT}/src/a.ts`], 31_000);
    assert.deepEqual(feed.attributedFiles(), [], "the event was spent by the scan that found nothing");
    assert.deepEqual(feed.observedFiles(), ["src/a.ts"]);
  });

  void it("a silent round with an outstanding command while another host edits source every minute shows no progress after the command event", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Bash", { command: "node long.js" }), 1000);
    for (let minute = 1; minute <= 20; minute++) {
      feed.recordFileChanges([`${ROOT}/src/file${minute % 3}.ts`], 1000 + minute * 60_000);
    }
    assert.equal(feed.lastProgressAt, 1000);
    assert.equal(feed.lastProgressWhat, "ran `node long.js`");
    assert.equal(feed.lastLivenessAt(), 1000);
  });

  void it("a command event adds one progress entry when it arrives, and none afterwards while it runs", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Bash", { command: "sleep 600" }), 1000);
    feed.recordStreamLine(toolLine("t1", "Bash", { command: "sleep 600" }), 2000);
    assert.equal(feed.entries().filter((e) => e.kind === "progress").length, 1);
    assert.equal(feed.lastProgressAt, 1000);
  });

  void it("non-streaming: another host's source change is only observed and moves neither clock", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: false });
    feed.recordStreamLine(toolLine("t1", "Edit", { file_path: `${ROOT}/src/a.ts` }), 1000);
    feed.recordFileChanges([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], 2000);
    assert.deepEqual(kinds(feed), ["observed", "observed"]);
    assert.equal(feed.lastLivenessAt(), undefined);
    assert.equal(isRoundIdleV1(feed, 0, 3_600_000, 60_000, false), false, "no idle stop without a stream");
  });

  void it("non-streaming: this round's own round-progress.md is progress", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, roundProgressPath: PROGRESS_FILE, streaming: false });
    feed.recordFileChanges([PROGRESS_FILE], 4000);
    assert.deepEqual(kinds(feed), ["progress"]);
    assert.equal(feed.lastProgressAt, 4000);
  });

  void it("output bytes add contact only", () => {
    const feed = streamingFeed();
    feed.recordContact(1000);
    assert.deepEqual(kinds(feed), ["contact"]);
    assert.equal(feed.lastContactAt, 1000);
    assert.equal(feed.lastProgressAt, undefined);
    assert.equal(feed.lastLivenessAt(), 1000);
  });
});

void describe("the idle stop and the repeat stop read the feed (run1 Step 12)", () => {
  const MINUTE = 60_000;

  void it("2 hours of edits every minute is never idle", () => {
    const feed = streamingFeed();
    for (let minute = 1; minute <= 120; minute++) {
      feed.recordStreamLine(toolLine(`t${minute}`, "Edit", { file_path: `${ROOT}/src/f${minute}.ts` }), minute * MINUTE);
      assert.equal(isRoundIdleV1(feed, 0, minute * MINUTE + 30_000, 20 * MINUTE, true), false);
    }
  });

  void it("20 silent minutes is idle", () => {
    const feed = streamingFeed();
    feed.recordContact(0);
    assert.equal(isRoundIdleV1(feed, 0, 19 * MINUTE, 20 * MINUTE, true), false);
    assert.equal(isRoundIdleV1(feed, 0, 20 * MINUTE, 20 * MINUTE, true), true);
  });

  void it("20 minutes in which only other tasks' files, .ensemble and unattributed source files change is idle", () => {
    const feed = streamingFeed();
    feed.recordContact(0);
    for (let minute = 1; minute <= 20; minute++) {
      feed.recordFileChanges(
        [`${ROOT}/.ensemble/2026-11-06_task_2/task.md`, `${ROOT}/.ensemble/x.json`, `${ROOT}/src/x${minute}.ts`],
        minute * MINUTE
      );
    }
    assert.equal(isRoundIdleV1(feed, 0, 20 * MINUTE, 20 * MINUTE, true), true);
  });

  void it("20 minutes with one outstanding command, no output and another host's source edits every minute is idle", () => {
    const feed = streamingFeed();
    feed.recordStreamLine(toolLine("t1", "Bash", { command: "node wait.js" }), 0);
    for (let minute = 1; minute <= 20; minute++) {
      feed.recordFileChanges([`${ROOT}/src/y${minute}.ts`], minute * MINUTE);
    }
    assert.equal(isRoundIdleV1(feed, 0, 20 * MINUTE, 20 * MINUTE, true), true);
  });

  void it("the same message three times is a repeat stop, and different messages are not", () => {
    const varied = streamingFeed();
    for (const text of ["one", "two", "three", "four"]) {
      varied.recordStreamLine(textLine(text), 1);
    }
    assert.equal(varied.repeatStop(), undefined);

    const feed = streamingFeed();
    for (let i = 0; i < 3; i++) {
      feed.recordStreamLine(textLine("That was another monitor timing out with no events. Here is the report again."), i);
    }
    assert.equal(feed.repeatStop()?.kind, "message");
  });

  void it("the same tool call with the same input five times in a row is a repeat stop", () => {
    const feed = streamingFeed();
    for (let i = 0; i < 4; i++) {
      feed.recordStreamLine(toolLine(`t${i}`, "Bash", { command: "pnpm run lint" }), i);
    }
    assert.equal(feed.repeatStop(), undefined);
    feed.recordStreamLine(toolLine("t4", "Bash", { command: "pnpm run lint" }), 5);
    assert.equal(feed.repeatStop()?.kind, "toolCall");
  });

  void it("a different call in between breaks the run of identical tool calls", () => {
    const feed = streamingFeed();
    for (let i = 0; i < 10; i++) {
      feed.recordStreamLine(toolLine(`a${i}`, "Bash", { command: "ls" }), i);
      feed.recordStreamLine(toolLine(`b${i}`, "Read", { file_path: `${ROOT}/src/f${i}.ts` }), i);
    }
    assert.equal(feed.repeatStop(), undefined);
  });

  void it("codex: a command item is one progress entry (started and completed share an id), and a file_change item names the files the next scan may attribute", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, provider: "codex" });
    const command = (type: string): string =>
      JSON.stringify({ type, item: { id: "item_1", type: "command_execution", command: "ls src" } });
    feed.recordStreamLine(command("item.started"), 1000);
    feed.recordStreamLine(command("item.completed"), 2000);
    assert.deepEqual(kinds(feed), ["progress"]);
    assert.equal(feed.lastProgressAt, 1000);

    feed.recordStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_2", type: "file_change", changes: [{ path: `${ROOT}/src/a.ts`, kind: "update" }] },
      }),
      3000
    );
    feed.recordFileChanges([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], 4000);
    assert.deepEqual(feed.attributedFiles(), ["src/a.ts"]);
    assert.deepEqual(feed.observedFiles(), ["src/b.ts"]);
  });

  void it("codex: the same agent message three times is a repeat stop", () => {
    const feed = new RoundActivityFeedV1({ streaming: true, provider: "codex" });
    for (let i = 0; i < 3; i++) {
      feed.recordStreamLine(
        JSON.stringify({ type: "item.completed", item: { id: `m${i}`, type: "agent_message", text: "Here is the report again." } }),
        i
      );
    }
    assert.equal(feed.repeatStop()?.kind, "message");
  });

  void it("opencode: a tool_use edit part attributes the file named by its input, and a text part counts as a message", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, provider: "opencode" });
    feed.recordStreamLine(
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "edit", callID: "c1", state: { status: "completed", input: { filePath: `${ROOT}/src/a.ts` } } },
      }),
      1000
    );
    feed.recordFileChanges([`${ROOT}/src/a.ts`], 2000);
    assert.deepEqual(feed.attributedFiles(), ["src/a.ts"]);
    for (let i = 0; i < 3; i++) {
      feed.recordStreamLine(JSON.stringify({ type: "text", part: { type: "text", text: "same" } }), 3000 + i);
    }
    assert.equal(feed.repeatStop()?.kind, "message");
  });

  void it("kimi: assistant tool_calls name the file written, and a read does not attribute anything", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, provider: "kimi" });
    feed.recordStreamLine(
      JSON.stringify({
        role: "assistant",
        tool_calls: [
          { id: "k1", function: { name: "WriteFile", arguments: JSON.stringify({ path: `${ROOT}/src/a.ts` }) } },
          { id: "k2", function: { name: "ReadFile", arguments: JSON.stringify({ path: `${ROOT}/src/b.ts` }) } },
        ],
      }),
      1000
    );
    feed.recordFileChanges([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], 2000);
    assert.deepEqual(feed.attributedFiles(), ["src/a.ts"]);
    assert.deepEqual(feed.observedFiles(), ["src/b.ts"]);
  });

  void it("cline: tool events are progress once per call id, messages feed the repeat stop, and no file is attributed", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, provider: "cline" });
    const tool = (type: string, id: string, name: string): string =>
      JSON.stringify({
        type: "agent_event",
        event: { type, contentType: "tool", toolCallId: id, toolName: name },
      });
    feed.recordStreamLine(tool("content_start", "call_1", "read_files"), 1_000);
    feed.recordStreamLine(tool("content_end", "call_1", "read_files"), 2_000);
    assert.deepEqual(kinds(feed), ["progress"]);
    assert.equal(feed.lastProgressAt, 1_000);
    feed.recordStreamLine(tool("content_end", "call_2", "run_commands"), 3_000);
    assert.deepEqual(kinds(feed), ["progress", "progress"]);

    const text = JSON.stringify({
      type: "agent_event",
      event: { type: "content_end", contentType: "text", text: "Still working." },
    });
    for (let i = 0; i < 3; i++) {
      feed.recordStreamLine(text, 4_000 + i);
    }
    assert.equal(feed.repeatStop()?.kind, "message");

    // Cline's write-tool arguments are unconfirmed, so a changed file is only observed.
    feed.recordFileChanges([`${ROOT}/src/a.ts`], 15_000);
    assert.deepEqual(feed.attributedFiles(), []);
    assert.deepEqual(feed.observedFiles(), ["src/a.ts"]);
  });

  void it("cline: five different calls to one tool with no input are not a repeat, five identical known calls are", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, provider: "cline" });
    const call = (id: string, input?: Record<string, unknown>): string =>
      JSON.stringify({
        type: "agent_event",
        event: {
          type: "content_end",
          contentType: "tool",
          toolCallId: id,
          toolName: "read_files",
          ...(input !== undefined ? { input } : {}),
        },
      });
    for (let i = 0; i < 8; i++) {
      feed.recordStreamLine(call(`unknown_${i}`), 1_000 + i);
    }
    assert.equal(feed.repeatStop(), undefined);
    assert.equal(kinds(feed).length, 8);
    assert.equal(feed.lastProgressAt, 1_007);

    // Known, differing arguments are not a repeat either.
    for (let i = 0; i < 8; i++) {
      feed.recordStreamLine(call(`known_${i}`, { path: `f${i}.ts` }), 2_000 + i);
    }
    assert.equal(feed.repeatStop(), undefined);

    // Five identical known calls back to back are.
    for (let i = 0; i < 5; i++) {
      feed.recordStreamLine(call(`same_${i}`, { path: "same.ts" }), 3_000 + i);
    }
    assert.equal(feed.repeatStop()?.kind, "toolCall");
  });

  void it("an unknown-input call between identical known calls breaks the run", () => {
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, provider: "cline" });
    const call = (id: string, input?: Record<string, unknown>): string =>
      JSON.stringify({
        type: "agent_event",
        event: { type: "content_end", contentType: "tool", toolCallId: id, toolName: "search", ...(input ? { input } : {}) },
      });
    for (let i = 0; i < 4; i++) {
      feed.recordStreamLine(call(`a${i}`, { q: "x" }), 1_000 + i);
    }
    feed.recordStreamLine(call("unknown"), 1_100);
    feed.recordStreamLine(call("a5", { q: "x" }), 1_200);
    assert.equal(feed.repeatStop(), undefined);
  });

  void it("cline: the final run_result line and hook events add nothing to the feed", () => {
    const feed = new RoundActivityFeedV1({ streaming: true, provider: "cline" });
    feed.recordStreamLine(JSON.stringify({ type: "run_result", finishReason: "completed", text: "PONG" }), 1);
    feed.recordStreamLine(JSON.stringify({ type: "hook_event", hookEventName: "agent_start" }), 2);
    assert.deepEqual(feed.entries(), []);
  });

  void it("a Claude-shaped line fed to a codex feed is ignored, and a non-JSON line adds nothing", () => {
    const feed = new RoundActivityFeedV1({ streaming: true, provider: "codex" });
    feed.recordStreamLine(toolLine("t1", "Bash", { command: "ls" }), 1);
    feed.recordStreamLine("plain text line", 2);
    assert.deepEqual(feed.entries(), []);
  });

  void it("the owner's editor save of the round's own round-progress.md is not the round's progress", () => {
    const savedAt = new Map<string, number>();
    const feed = new RoundActivityFeedV1({
      workspaceRoot: ROOT,
      roundProgressPath: PROGRESS_FILE,
      streaming: true,
      localEditorSaveAt: (file) => savedAt.get(file),
      now: () => 0,
    });
    // The owner saves the file from an editor between two scans.
    savedAt.set(PROGRESS_FILE, 5_000);
    feed.recordFileChanges([PROGRESS_FILE], 15_000);
    assert.deepEqual(feed.entries(), []);
    assert.equal(feed.lastProgressAt, undefined);
    assert.equal(feed.lastLivenessAt(), undefined);

    // The round writes it itself in the next window, with no editor save since the last scan.
    feed.recordFileChanges([PROGRESS_FILE], 30_000);
    assert.deepEqual(kinds(feed), ["progress"]);
    assert.equal(feed.lastProgressAt, 30_000);
  });
});
