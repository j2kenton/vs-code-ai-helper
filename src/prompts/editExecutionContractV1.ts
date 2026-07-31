/**
 * The FIXED edit-execution contract prompt (plan §7.4/§7.6): together with
 * the canonical execution script it is the ENTIRE input a mutation session
 * receives — no task, artifact, Chat, or source content, no paths, no
 * bytes. The model's only job is to call each scripted step exactly once,
 * in order, with the script's tool and the four reference fields; the
 * broker holds every sealed operation and refuses anything else.
 */
import { EditExecutionScriptV1 } from "../types/editExecutionProtocolV1";
import { canonicalJsonStringifyV1 } from "../services/canonicalJsonV1";

export const EDIT_EXECUTION_CONTRACT_ID_V1 = "ensemble-edit-execution-contract";
export const EDIT_EXECUTION_CONTRACT_VERSION_V1 = 1;

export function buildEditExecutionContractPromptV1(script: EditExecutionScriptV1): string {
  const scriptJson = canonicalJsonStringifyV1({
    executionId: script.executionId,
    planId: script.planId,
    planDigest: script.planDigest,
    steps: script.steps.map((step) => ({ stepId: step.stepId, tool: step.tool })),
  });
  return [
    "You are executing a SEALED edit plan. The plan's operations (paths and",
    "content) were fixed during a prior read-only preflight and are held by",
    "the execution broker — you cannot see or change them, and you must not",
    "invent any content or path.",
    "",
    "Execute the script below by calling each step EXACTLY ONCE, in the",
    "listed order, using the step's assigned tool. Every tool call takes",
    "exactly these arguments and nothing else:",
    "",
    '  { "executionId": "...", "planId": "...", "planDigest": "...", "stepId": "..." }',
    "",
    "copied verbatim from the script. The broker validates order and tool",
    "assignment; a reordered, repeated, skipped, or altered call permanently",
    "blocks the execution. Each successful call returns a receipt with a",
    "receiptId — collect them in order.",
    "",
    "After the final step, report the completed execution in the result",
    "envelope's edit-execution.v1 content with the executionId, planId,",
    "planDigest, and the ordered receiptIds exactly as issued. Do not ask",
    "questions — questions are invalid during edit execution.",
    "",
    "EXECUTION SCRIPT:",
    scriptJson,
  ].join("\n");
}
