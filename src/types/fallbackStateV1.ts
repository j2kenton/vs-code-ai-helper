/**
 * Per-stage fallback state (plan §3.9).
 *
 * `fallbackActive` remains the existing per-stage map persisted in
 * task-progress.json. Scalar boolean input is INVALID — a historical shape
 * that stored one boolean for the whole task cannot be mapped onto per-stage
 * state without guessing, so the strict decoder rejects it into recovery
 * instead of coercing (plan §3.11: "`fallbackActive` is never assigned a
 * scalar").
 */
import { STAGE_ORDER, TaskStage } from "./taskProgress";

export type FallbackStateV1 = Partial<Record<TaskStage, boolean>>;

export type FallbackStateDecodeResultV1 =
  | { readonly ok: true; readonly state: FallbackStateV1 }
  | { readonly ok: false; readonly reason: string };

const CANONICAL_STAGES: ReadonlySet<string> = new Set(STAGE_ORDER);

/**
 * Strictly decode a persisted `fallbackActive` value. Absent input decodes
 * to an empty map; anything that is not an exact per-canonical-stage boolean
 * map is rejected with a reason (no coercion, no silent dropping of
 * unrecognized keys).
 */
export function decodeFallbackStateV1(value: unknown): FallbackStateDecodeResultV1 {
  if (value === undefined) {
    return { ok: true, state: {} };
  }
  if (typeof value === "boolean") {
    return { ok: false, reason: "fallbackActive is a scalar boolean; only the per-stage map is valid" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "fallbackActive is not a per-stage object map" };
  }
  const state: FallbackStateV1 = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!CANONICAL_STAGES.has(key)) {
      return { ok: false, reason: `fallbackActive has an unrecognized stage key: ${JSON.stringify(key)}` };
    }
    if (typeof entry !== "boolean") {
      return { ok: false, reason: `fallbackActive[${JSON.stringify(key)}] is not a boolean` };
    }
    state[key as TaskStage] = entry;
  }
  return { ok: true, state };
}
