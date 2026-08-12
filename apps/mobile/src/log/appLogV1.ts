/**
 * The app's single diagnostic log pathway (plan Part 11). Every entry passes
 * `redactSecretsV1` BEFORE it is stored or forwarded, so no sink — the
 * capped in-memory ring here, or a platform sink registered via
 * `setAppLogSinkV1` (Metro console in dev, a crash reporter in release) —
 * can ever observe an unredacted line. Screens and services call
 * `logAppEventV1` instead of any console/platform API directly.
 */
import { redactSecretsV1 } from './logRedactionV1';

export interface AppLogEntryV1 {
  readonly at: string;
  readonly line: string;
}

export type AppLogSinkV1 = (entry: AppLogEntryV1) => void;

const MAX_ENTRIES_V1 = 200;

const entries: AppLogEntryV1[] = [];
let sink: AppLogSinkV1 | undefined;

/** Record one redacted diagnostic line (newest kept, capped ring). */
export function logAppEventV1(line: string, at?: string): void {
  const entry: AppLogEntryV1 = {
    at: at ?? new Date().toISOString(),
    line: redactSecretsV1(line),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES_V1) {
    entries.splice(0, entries.length - MAX_ENTRIES_V1);
  }
  sink?.(entry);
}

/** Snapshot of the retained diagnostic entries, oldest first. */
export function readAppLogV1(): readonly AppLogEntryV1[] {
  return [...entries];
}

/** Register/replace the optional platform sink (receives redacted entries only). */
export function setAppLogSinkV1(next?: AppLogSinkV1): void {
  sink = next;
}

/** Test/reset hook. */
export function clearAppLogV1(): void {
  entries.length = 0;
}
