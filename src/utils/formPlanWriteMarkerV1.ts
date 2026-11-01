/**
 * bugs4 item 6: a marker for the open-items form's own `plan-final.md` write.
 *
 * The form writes the plan and then dispatches the stage's next action. Anything
 * else that reacts to that same write (Apply Reviewer-Verified Ticks dispatching
 * `resumeAndApplyCurrentStageAction` after its own tick write) would race the
 * form's dispatch for the task's work admission and lose, leaving the owner a
 * refusal for a round that was never theirs to start. The marker lets that second
 * dispatcher see the form owns the follow-up and stand down.
 *
 * The marker records the plan path, the content hash the form wrote and the time,
 * and expires after a short window so a crashed continuation never silences a later,
 * unrelated dispatch. In-memory by design: it only coordinates callers in one window.
 */
import { createHash } from "node:crypto";

export const FORM_PLAN_WRITE_MARKER_WINDOW_MS_V1 = 2 * 60 * 1000;

interface FormPlanWriteMarkerV1 {
  readonly planPath: string;
  readonly contentHash: string;
  readonly at: number;
}

const markersV1 = new Map<string, FormPlanWriteMarkerV1>();

function hashV1(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Record that the form wrote `content` to `planPath` for the task and now owns the follow-up dispatch. */
export function markFormPlanWriteV1(
  taskFolderPath: string,
  planPath: string,
  content: string,
  now: number = Date.now()
): void {
  markersV1.set(taskFolderPath, { planPath, contentHash: hashV1(content), at: now });
}

/** The form's continuation finished (dispatched, refused or posted its card): it no longer owns the follow-up. */
export function clearFormPlanWriteMarkerV1(taskFolderPath: string): void {
  markersV1.delete(taskFolderPath);
}

/**
 * True while the form's own follow-up for this task is pending and inside the
 * window. A caller that would dispatch the same stage action stands down.
 */
export function isFormContinuationPendingV1(taskFolderPath: string, now: number = Date.now()): boolean {
  const marker = markersV1.get(taskFolderPath);
  if (!marker) {
    return false;
  }
  if (now - marker.at > FORM_PLAN_WRITE_MARKER_WINDOW_MS_V1 || now < marker.at) {
    markersV1.delete(taskFolderPath);
    return false;
  }
  return true;
}

/** True when `content` is exactly what the form wrote for this task inside the window. */
export function isFormPlanWriteContentV1(taskFolderPath: string, content: string, now: number = Date.now()): boolean {
  const marker = markersV1.get(taskFolderPath);
  return isFormContinuationPendingV1(taskFolderPath, now) && marker !== undefined && marker.contentHash === hashV1(content);
}
