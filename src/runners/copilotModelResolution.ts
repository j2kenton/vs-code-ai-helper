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
 */
export function buildCopilotRequestOptions(
  parsedModel: ParsedCopilotModelSelection
): LmChatRequestOptionsV1 {
  const modelOptions: Record<string, unknown> = {};
  if (parsedModel.reasoningEffort) {
    modelOptions.model_reasoning_effort = parsedModel.reasoningEffort;
  }
  if (parsedModel.contextWindow) {
    modelOptions.model_context_window = parsedModel.contextWindow;
  }
  return Object.keys(modelOptions).length > 0 ? { modelOptions } : {};
}
