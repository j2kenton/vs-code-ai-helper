import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as path from "node:path";

void test("completion final-fixes prompt exposes lint and context inputs", async () => {
  const promptPath = path.resolve(__dirname, "../../resources/prompts/final-fixes-code.md");
  const prompt = await readFile(promptPath, "utf8");
  assert.match(prompt, /Keep the task in the completed stage/);
  assert.match(prompt, /{{lint}}/);
  assert.match(prompt, /{{contextPack}}/);
});
