/**
 * Task-creation recovery classification types (plan §4.3). NOT part of the
 * production bundle — every export here is `type`/`interface`, so esbuild
 * elides all of them; do not add a production-source-universe baseline row
 * for this file (see the implementation review that removed one).
 *
 * These are read-only classification results produced by
 * `TaskCreationStartupReconcilerV1` for a `status: "creating"` task folder
 * found under a meta root at startup. Classification never mutates the
 * folder; it only determines which recovery affordances (Open, Retry,
 * Adopt-and-Retry, Safe Delete — see that module's header comment for which
 * classes each is wired up for) are conservatively safe to offer.
 */

/**
 * The four conservative classes from plan §4.3, in order of "most
 * confidently recoverable" to "requires manual inspection":
 *
 * - `reconstructible`: strict creating progress, no `task.md`, no other
 *   entries in the folder besides `task-progress.json` itself.
 * - `pristine`: strict creating progress, `task.md` present and byte-exact
 *   to one recorded historical seed, no other entries.
 * - `preservable`: strict creating progress, `task.md` present and differs
 *   from every recorded historical seed (i.e. it looks user-edited), no
 *   other entries.
 * - `inspectionOnly`: invalid/unsupported progress, an unknown entry or
 *   entry type in the folder, an incomplete directory scan, or identity
 *   ambiguity (more than one plausible interpretation).
 */
export type TaskCreationFootprintClassV1 =
  | "reconstructible"
  | "pristine"
  | "preservable"
  | "inspectionOnly";

/** Which historical seed (if any) a `pristine` folder's `task.md` matched. */
export interface MatchedCreationSeedV1 {
  readonly seedId: string;
  readonly version: "v0" | "v1";
}

/**
 * A classified `status: "creating"` footprint. Extends the same identifying
 * fields `LegacyCreatingFootprintV0` already published (so existing callers
 * of that read-only data are unaffected) with the plan §4.3 classification.
 */
export interface ClassifiedCreatingFootprintV1 {
  readonly metaFolderPath: string;
  readonly taskFolderPath: string;
  readonly taskFolderName: string;
  readonly hasTaskMd: boolean;
  readonly footprintClass: TaskCreationFootprintClassV1;
  /** Present only when `footprintClass === "pristine"`. */
  readonly matchedSeed?: MatchedCreationSeedV1;
  /**
   * Human-readable reason a folder fell into `inspectionOnly`, when
   * applicable. Never used for anything but diagnostics/UI copy — never
   * parsed back for control flow.
   */
  readonly inspectionReason?: string;
  /**
   * True only when this classification came from
   * `classifyFromVerifiedJournalV1` — the extension's own §4.2 journal has
   * cryptographically verified (content hash, not just filename) that every
   * byte in the folder is something THIS extension wrote and nothing else
   * has touched. This is plan §4.5's "verified V1 journal" branch of Retry
   * (the "accepts only a verified V1 journal OR completed adoption" pair):
   * Retry may proceed directly, with no adoption step, only when this is
   * true. `classifyFromVerifiedJournalV1` only ever produces
   * `footprintClass: "reconstructible"`, so this is currently always
   * `false` for `pristine`/`preservable`/`inspectionOnly` — those classes'
   * "Retry with adoption" path (plan §4.3's table) is not implemented yet;
   * they get Open only, until adoption-based Retry lands.
   */
  readonly retryWithoutAdoptionEligible: boolean;
  /**
   * True only when a live (not yet `externalStateResolved`) Safe Delete
   * journal exists for this folder (plan §4.6) AND the folder is still
   * present on disk. `taskTreeProvider.ts`/`contextTokens.ts` give this
   * precedence over `footprintClass`/`retryWithoutAdoptionEligible` — a
   * deletion in flight must never also offer Open/Retry/Adopt-and-Retry/Safe
   * Delete again (plan §4.7's `deletionPending` context).
   */
  readonly deletionPending: boolean;
}
