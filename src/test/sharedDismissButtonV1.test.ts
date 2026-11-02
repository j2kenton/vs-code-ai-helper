/**
 * bugs5 Step 5 / item 19: every close-without-acting button shares one class and one set of
 * colours, in the chat panel and in AI Models, and sits before the card's action button.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ENSEMBLE_DISMISS_BUTTON_CSS_V1, ENSEMBLE_DISMISS_CLASS_V1 } from "../views/sharedButtonStylesV1";

const SRC = path.resolve(__dirname, "../../src/views");
const chatSource = fs.readFileSync(path.join(SRC, "chatView.ts"), "utf8");
const settingsSource = fs.readFileSync(path.join(SRC, "settingsView.ts"), "utf8");

void describe("shared Dismiss button styling (bugs5 Step 5)", () => {
  void it("uses the secondary background, the dark-theme grey mix and its hover", () => {
    const css = ENSEMBLE_DISMISS_BUTTON_CSS_V1;
    assert.match(css, /--vscode-button-secondaryBackground/);
    assert.match(css, /--vscode-button-secondaryHoverBackground/);
    assert.match(css, /color-mix\(in srgb, var\(--vscode-foreground\) 15%, var\(--vscode-editor-background\)\)/);
    assert.match(css, /color-mix\(in srgb, var\(--vscode-foreground\) 25%, var\(--vscode-editor-background\)\)/);
  });

  void it("changes only colours, never size, padding or shape", () => {
    assert.doesNotMatch(ENSEMBLE_DISMISS_BUTTON_CSS_V1, /padding|border|width|height|font|radius|margin/);
  });

  void it("is included by both views", () => {
    assert.match(chatSource, /\$\{ENSEMBLE_DISMISS_BUTTON_CSS_V1\}/);
    assert.match(settingsSource, /\$\{ENSEMBLE_DISMISS_BUTTON_CSS_V1\}/);
  });

  void it("AI Models' Discard buttons carry the class, with no override of their own left", () => {
    assert.match(settingsSource, new RegExp(`id="discard-btn" class="secondary ${ENSEMBLE_DISMISS_CLASS_V1}"`));
    assert.match(settingsSource, new RegExp(`id="discard-providers-btn" class="secondary ${ENSEMBLE_DISMISS_CLASS_V1}"`));
    assert.doesNotMatch(settingsSource, /body\.vscode-dark #discard-btn/);
    assert.doesNotMatch(settingsSource, /body\.vscode-dark #discard-providers-btn/);
  });

  void it("every Dismiss button on a chat card carries the class", () => {
    const dismissCreations = chatSource.match(/[A-Za-z]+=document\.createElement\('button'\);\s*[A-Za-z]+\.type='button';[^\n]*textContent='Dismiss'/g) ?? [];
    assert.equal(dismissCreations.length, 4, "interaction form, open-items form, decision card, question");
    for (const creation of dismissCreations) {
      assert.match(creation, new RegExp(`className='${ENSEMBLE_DISMISS_CLASS_V1}'`), creation);
    }
  });

  void it("on every card type Dismiss is appended before the action button", () => {
    assert.match(chatSource, /actions\.appendChild\(cancelBtn\); actions\.appendChild\(chatBtn\); actions\.appendChild\(confirmBtn\);/);
    assert.match(chatSource, /actions\.appendChild\(dismiss\); actions\.appendChild\(apply\);/);
    assert.match(chatSource, /actions\.appendChild\(dismissBtn\);\s*actions\.appendChild\(confirmBtn\);/);
    assert.match(chatSource, /actions\.appendChild\(dismissBtn\);\s*actions\.appendChild\(sendBtn\);/);
  });

  void it("the row is left-aligned and the action buttons keep the primary background", () => {
    assert.match(chatSource, /\.interaction-actions \{ display: flex; gap: var\(--ensemble-space-2\); \}/);
    assert.match(chatSource, /\.interaction-actions button \{\s*background-color: var\(--vscode-button-background\)/);
  });
});
