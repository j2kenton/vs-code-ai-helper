/**
 * review1 Step 49 (owner decision 2026-11-05): the diagnostic round runs in the provider's enforced read-only text mode,
 * the same mode reviews use (Claude plan mode, Codex read-only sandbox). A chain model whose provider cannot enforce it
 * (those with a `permissionWarning`: Antigravity, Cline) is skipped for the next model in Implementation's chain that
 * can. This answers, before the round is offered or dispatched, whether any model in the chain qualifies, and why not.
 */
import { isCliTextModeGuaranteedReadOnlyV1 } from "../runners/cliAgentRunner";
import { resolveEffectiveProvider } from "../runners/runnerRegistry";
import { resolveEffectiveStageChainV1 } from "./modelSelection";

export type ReadOnlyDiagnosisAvailabilityV1 =
  | { readonly available: true; readonly modelId: string }
  | { readonly available: false; readonly reason: string };

export function resolveReadOnlyDiagnosisAvailabilityV1(): ReadOnlyDiagnosisAvailabilityV1 {
  try {
    const chain = resolveEffectiveStageChainV1("impl");
    const models = [chain.primary, ...chain.backups].filter((id): id is string => typeof id === "string" && id.length > 0);
    if (models.length === 0) {
      return { available: false, reason: "no model is configured for Implementation" };
    }
    const skipped: string[] = [];
    for (const modelId of models) {
      const effective = resolveEffectiveProvider(modelId);
      if (effective.kind === "copilot" || isCliTextModeGuaranteedReadOnlyV1(effective.def)) {
        return { available: true, modelId };
      }
      skipped.push(effective.def.label);
    }
    return {
      available: false,
      reason:
        `none of the models in Implementation's chain (${[...new Set(skipped)].join(", ")}) can run in a mode that ` +
        "stops the provider editing files, and the diagnosis must not be able to change your working tree. Add a " +
        "model such as Claude Code or Codex to Implementation's chain, or look at the failure yourself",
    };
  } catch {
    return { available: false, reason: "the Implementation model chain could not be read" };
  }
}
