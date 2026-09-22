import * as vscode from "vscode";
import {
  parseCopilotModelSelection,
  type ParsedCopilotModelSelection,
} from "./providers";
import type { LmChatRequestOptionsV1 } from "../types/vscodeLmCompatV1";

export interface ResolvedCopilotModel {
  ok: true;
  model: vscode.LanguageModelChat;
  parsedModel: ParsedCopilotModelSelection;
}

export interface UnresolvedCopilotModel {
  ok: false;
  errorMessage: string;
  /** Always "temporarily-unavailable" so callers' backup-switch logic engages. */
  failureKind: "temporarily-unavailable";
}

/**
 * Picks the Copilot model to run against: the explicitly requested model, or
 * the "auto" model when none was configured. Fails explicitly instead of
 * silently falling back to an unrelated model — the user must always know
 * which model actually ran.
 */
export function resolveCopilotModel(
  models: readonly vscode.LanguageModelChat[],
  requestedModelId: string | undefined
): ResolvedCopilotModel | UnresolvedCopilotModel {
  const parsedModel = parseCopilotModelSelection(requestedModelId);

  if (parsedModel.model) {
    const model = models.find((candidate) => candidate.id === parsedModel.model);
    if (!model) {
      return {
        ok: false,
        failureKind: "temporarily-unavailable",
        errorMessage:
          `The configured Copilot model "${parsedModel.model}" is not available. ` +
          "Select an available model in Settings.",
      };
    }
    return { ok: true, model, parsedModel };
  }

  const model = models.find(
    (candidate) =>
      candidate.id.toLowerCase() === "auto" ||
      candidate.name.toLowerCase() === "auto"
  );
  if (!model) {
    return {
      ok: false,
      failureKind: "temporarily-unavailable",
      errorMessage:
        "The configured Copilot model is unavailable. Select an available model in Settings.",
    };
  }
  return { ok: true, model, parsedModel };
}

/**
 * Builds the modelOptions/requestOptions shared by every Copilot request.
 *
 * Returns the neutral `LmChatRequestOptionsV1` shape (plan §1.6) rather than
 * `vscode.LanguageModelChatRequestOptions` directly: this function is called
 * by both the simple text-completion runner and the tool-calling
 * implementation runner, and only the latter needs the post-1.93 `tools`
 * field, which `vscodeLmCompat.ts` attaches at the actual `sendRequest` call.
 *
 * v1 fixes 2, item 19: deliberately sends NO `model_reasoning_effort` or
 * `model_context_window`. Copilot's LM provider never reads either (Copilot
 * Chat 0.65.0), so forwarding a legacy `@high` / `+long` selection would only
 * make the run record claim a setting that did not apply. The suffix is still
 * parsed so an older saved selection resolves to its base model; effort and
 * context size for Copilot are configured in VS Code's per-model settings.
 */
export function buildCopilotRequestOptions(
  _parsedModel: ParsedCopilotModelSelection
): LmChatRequestOptionsV1 {
  return {};
}
