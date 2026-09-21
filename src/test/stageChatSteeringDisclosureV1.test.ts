/**
 * v1 fixes 2, item 12 (release half): the stage chat must not imply that what
 * is typed will steer the next round. Two surfaces carry that:
 *   - the chat view says plainly that messages do not reach the next round and
 *     points at `plan-final.md`, which rounds do read (stage chats only — the
 *     global assistant is not a stage chat);
 *   - the reply path instructs the model never to promise that a later round
 *     will act on what the user said.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";

import { buildStageResponsePrompt } from "../commands/chatWithStage";

void describe("stage chat non-steering disclosure", () => {
  const source = fs.readFileSync("src/views/chatView.ts", "utf8");

  void it("renders a note saying messages are not passed to the next round and naming plan-final.md", () => {
    const note = /<div id="steering-note"[^>]*>([^<]*(?:<code>[^<]*<\/code>[^<]*)*)<\/div>/.exec(source);
    assert.ok(note, "the chat view must render a #steering-note element");
    assert.match(note[1]!, /not passed to the next round/);
    assert.match(note[1]!, /plan-final\.md/);
  });

  void it("shows the note for stage chats only, never for the global assistant", () => {
    assert.match(
      source,
      /sn\.style\.display=\(s\.target&&s\.target\.kind!=='global'\)\?'block':'none';/,
      "visibility must follow the target kind"
    );
    assert.match(source, /#steering-note \{ display: none;/, "hidden until a stage chat is shown");
  });

  void it("tells the model that nothing typed in the chat reaches a later round and to point at plan-final.md", () => {
    const prompt = buildStageResponsePrompt("Implementation", "Task", "", "", "please also handle X next time");
    assert.match(prompt, /Nothing the user types in this chat is passed to any later implementation or review round/);
    assert.match(prompt, /never say or imply that a later round will act on/);
    assert.match(prompt, /record it in plan-final\.md, which rounds do read/);
  });
});
