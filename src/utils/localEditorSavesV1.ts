/**
 * run1 Step 11: when the owner last saved each file from an editor on THIS host. A round's activity
 * feed uses it to tell the owner's save of the round's own `round-progress.md` from the round's own
 * write, so an editor save never counts as the round being alive. Saves made on another host are not
 * visible here, which the plan accepts.
 */
import * as path from "node:path";

const savedAtByPath = new Map<string, number>();
/** Keep the map bounded across a long session. */
const MAX_TRACKED_PATHS = 200;

export function recordLocalEditorSaveV1(absolutePath: string, at: number = Date.now()): void {
  const key = path.resolve(absolutePath);
  savedAtByPath.delete(key);
  savedAtByPath.set(key, at);
  if (savedAtByPath.size > MAX_TRACKED_PATHS) {
    const oldest = savedAtByPath.keys().next().value;
    if (oldest !== undefined) {
      savedAtByPath.delete(oldest);
    }
  }
}

export function localEditorSaveAtV1(absolutePath: string): number | undefined {
  return savedAtByPath.get(path.resolve(absolutePath));
}

export function resetLocalEditorSavesForTestsV1(): void {
  savedAtByPath.clear();
}
