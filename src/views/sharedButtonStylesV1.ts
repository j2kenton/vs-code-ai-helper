/**
 * bugs5 Step 5 / item 19: one place for how a button that closes without acting looks, shared by
 * the chat panel (Dismiss on every card) and AI Models (Discard Unsaved Changes), so the two
 * cannot drift apart again.
 *
 * Only the background and its matching foreground change; size, padding and shape stay as each
 * view's other buttons. The card's action button keeps the primary background, so the two read as
 * different things.
 */

/** The class a close-without-acting button carries. */
export const ENSEMBLE_DISMISS_CLASS_V1 = "ensemble-dismiss";

/**
 * The rules, for a webview `<style>` block. `button.ensemble-dismiss` and the `.interaction-actions`
 * form both appear so the rule wins over the chat panel's generic `.interaction-actions button`
 * (primary background) regardless of source order. On dark themes the secondary background can
 * equal the page background, so some of the theme text colour is mixed in to get a grey that
 * always shows up (25% on hover).
 */
export const ENSEMBLE_DISMISS_BUTTON_CSS_V1 = `
          button.${ENSEMBLE_DISMISS_CLASS_V1},
          .interaction-actions button.${ENSEMBLE_DISMISS_CLASS_V1} {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          button.${ENSEMBLE_DISMISS_CLASS_V1}:hover,
          .interaction-actions button.${ENSEMBLE_DISMISS_CLASS_V1}:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }
          body.vscode-dark button.${ENSEMBLE_DISMISS_CLASS_V1},
          body.vscode-dark .interaction-actions button.${ENSEMBLE_DISMISS_CLASS_V1} {
            background-color: color-mix(in srgb, var(--vscode-foreground) 15%, var(--vscode-editor-background));
          }
          body.vscode-dark button.${ENSEMBLE_DISMISS_CLASS_V1}:hover,
          body.vscode-dark .interaction-actions button.${ENSEMBLE_DISMISS_CLASS_V1}:hover {
            background-color: color-mix(in srgb, var(--vscode-foreground) 25%, var(--vscode-editor-background));
          }
`;
