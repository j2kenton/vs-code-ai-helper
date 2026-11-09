/**
 * run1 Step 17: a probe that notices a round's process is gone, on the host that owns the process.
 *
 * Every 5 s the owning host asks the OS whether the round's pid is still there. When it is gone:
 *
 * - `onGone` fires at once, so the running row stops saying the process is there;
 * - if nothing has settled the round `PROCESS_PROBE_SETTLE_AFTER_MS_V1` later, `onSettle` hands the
 *   round to the one settlement decision (cause `processEnded`) instead of leaving it "running".
 *   Anything already settling the round (report recovery, a cancel's process stop, an ordinary exit
 *   that is cleaning up) wins: `canSettle` says so, and the probe waits.
 *
 * A viewer window never owns a process, so a probe built with `ownsProcess: false` does nothing at
 * all: a viewer shows the mirrored `processState` and never settles a round.
 */
import { processAliveV1 } from "./publishChecksOutcomeV1";

export const PROCESS_PROBE_INTERVAL_MS_V1 = 5_000;
export const PROCESS_PROBE_SETTLE_AFTER_MS_V1 = 10_000;

export interface ProcessProbeOptionsV1 {
  readonly pid: number;
  /** False in a viewer window: the probe then never checks, never reports and never settles. */
  readonly ownsProcess: boolean;
  /** True while nothing else is settling the round. */
  readonly canSettle: () => boolean;
  readonly onGone: (at: number) => void;
  readonly onSettle: () => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
}

export class ProcessProbeV1 {
  private goneAt: number | undefined;
  private done = false;

  constructor(private readonly options: ProcessProbeOptionsV1) {}

  /** One probe; the owner calls this every `PROCESS_PROBE_INTERVAL_MS_V1`. */
  check(): void {
    if (!this.options.ownsProcess || this.done) {
      return;
    }
    const now = (this.options.now ?? Date.now)();
    if (this.goneAt === undefined) {
      if ((this.options.isAlive ?? processAliveV1)(this.options.pid)) {
        return;
      }
      this.goneAt = now;
      this.options.onGone(now);
      return;
    }
    if (now - this.goneAt >= PROCESS_PROBE_SETTLE_AFTER_MS_V1 && this.options.canSettle()) {
      this.done = true;
      this.options.onSettle();
    }
  }

  /** The round settled by another route; nothing left to probe. */
  stop(): void {
    this.done = true;
  }
}
