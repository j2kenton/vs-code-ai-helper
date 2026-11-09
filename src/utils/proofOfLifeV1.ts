/**
 * run1 Step 16: the evidence a running round carries for the one Notifications row, read from the
 * round's own activity feed (`roundActivityFeedV1`). The row answers "is it really still running?"
 * from this and nothing else:
 *
 * - `lastContactAt`: the process last wrote output (alive and talking, not progress);
 * - `lastProgressAt` / `lastProgressWhat`: the round last provably did something ("edited `a.ts`",
 *   "ran `pnpm run lint`"), from `progress` entries only;
 * - `lastObservedChangeAt` / `lastObservedChangeWhat`: a workspace file changed without proof it was
 *   this round's. For the tooltip only; it never counts as the round's activity;
 * - `processState`: whether the process is still there (the owning host's probe, Step 17).
 *
 * Plain data, VS Code-free: it is mirrored to viewer windows as JSON.
 */
import type { RoundActivityFeedV1 } from "./roundActivityFeedV1";

export type ProofOfLifeProcessStateV1 = "alive" | "ended" | "unknown";

export interface ProofOfLifeV1 {
  readonly pid?: number;
  readonly lastContactAt?: number;
  readonly lastProgressAt?: number;
  readonly lastProgressWhat?: string;
  readonly lastObservedChangeAt?: number;
  readonly lastObservedChangeWhat?: string;
  readonly processState: ProofOfLifeProcessStateV1;
  /** The settled outcome (Step 8's decision), once the round has one: its status and cause. */
  readonly settledOutcome?: { readonly status: "completed" | "failed" | "cancelled"; readonly cause?: string };
  /** True when the provider prints nothing until it finishes, so silence is not a sign of trouble by itself. */
  readonly reportsOnlyAtEnd?: boolean;
}

/** The registry never sends proof more often than this. */
export const PROOF_OF_LIFE_MIN_INTERVAL_MS_V1 = 2_000;

export type ProofOfLifeFeedV1 = Pick<
  RoundActivityFeedV1,
  "lastContactAt" | "lastProgressAt" | "lastProgressWhat" | "lastObservedChangeAt" | "lastObservedChangeWhat"
>;

function definedOnly<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** The proof a feed gives right now, with the process facts the runner knows. */
export function proofOfLifeOfFeedV1(
  feed: ProofOfLifeFeedV1,
  facts: {
    readonly pid?: number;
    readonly processState: ProofOfLifeProcessStateV1;
    readonly settledOutcome?: ProofOfLifeV1["settledOutcome"];
    readonly reportsOnlyAtEnd?: boolean;
  }
): ProofOfLifeV1 {
  return definedOnly({
    pid: facts.pid,
    lastContactAt: feed.lastContactAt,
    lastProgressAt: feed.lastProgressAt,
    lastProgressWhat: feed.lastProgressWhat,
    lastObservedChangeAt: feed.lastObservedChangeAt,
    lastObservedChangeWhat: feed.lastObservedChangeWhat,
    processState: facts.processState,
    settledOutcome: facts.settledOutcome,
    reportsOnlyAtEnd: facts.reportsOnlyAtEnd,
  }) as ProofOfLifeV1;
}

/**
 * Pushes a round's proof of life to a sink (the operation registry) at most once every
 * `PROOF_OF_LIFE_MIN_INTERVAL_MS_V1`, and only when something changed. The ending (`processState`
 * "ended", or a settled outcome) is sent at once: a row must stop saying "running" within seconds.
 */
export class ProofOfLifeReporterV1 {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastSignature = "";
  private pid: number | undefined;
  private processState: ProofOfLifeProcessStateV1 = "unknown";
  private settledOutcome: ProofOfLifeV1["settledOutcome"];

  constructor(
    private readonly feed: ProofOfLifeFeedV1,
    private readonly sink: (proof: ProofOfLifeV1) => void,
    private readonly options: { readonly reportsOnlyAtEnd?: boolean; readonly now?: () => number } = {}
  ) {}

  setProcess(pid: number | undefined): void {
    this.pid = pid;
    this.processState = pid === undefined ? "unknown" : "alive";
    this.send(true);
  }

  /** The process is gone (Step 17's probe, or the exit), whatever the round's outcome turns out to be. */
  markProcessEnded(): void {
    this.processState = "ended";
    this.send(true);
  }

  /** The round's one settlement decided its outcome (Step 8). */
  markSettled(outcome: NonNullable<ProofOfLifeV1["settledOutcome"]>): void {
    this.settledOutcome = outcome;
    this.send(true);
  }

  /** Called on a timer: sends only when due and changed. */
  tick(): void {
    this.send(false);
  }

  private send(force: boolean): void {
    const now = (this.options.now ?? Date.now)();
    if (!force && now - this.lastSentAt < PROOF_OF_LIFE_MIN_INTERVAL_MS_V1) {
      return;
    }
    const proof = proofOfLifeOfFeedV1(this.feed, {
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      processState: this.processState,
      ...(this.settledOutcome !== undefined ? { settledOutcome: this.settledOutcome } : {}),
      ...(this.options.reportsOnlyAtEnd === true ? { reportsOnlyAtEnd: true } : {}),
    });
    const signature = JSON.stringify(proof);
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    this.lastSentAt = now;
    this.sink(proof);
  }
}
