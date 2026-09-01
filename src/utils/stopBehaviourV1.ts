/**
 * Plan Part 14 (items 7a and 8): the decision of what to do after a
 * mid-round provider failure — park the stage durably and offer a scheduled
 * resume, or simply alert and stop — belongs to the failure CLASSIFIER, not
 * to a user-facing setting. The old three-value `FallbackStrategy`
 * (`switch-to-backup` / `pause-and-resume` / `alert-and-wait`) conflated two
 * different axes: whether to use the backup chain at all (now the sole job
 * of `FallbackStrategy`, see `modelFallback.ts`), and what to do about the
 * PRIMARY's own failure once no backup can be tried. This module is the
 * second axis: a pure function of what actually failed, never of a stored
 * preference.
 *
 * `describeMidRoundOutcomeV1` is the second half of item 8: the "Ensemble
 * withheld the automatic switch to this stage's backup model" explanation
 * used to be attached only inside the non-auth quota/outage branches of
 * `runnerRegistry.ts`'s cascade, so an authentication failure that changed
 * files and then failed left the user with no explanation at all for why no
 * backup was tried — see the item 8 write-up ("Same guard, same trigger...
 * and only one path says so"). The guard is what withholds the switch; every
 * failure kind that guard applies to must carry the same sentence.
 *
 * Review completion blocker (2026-09-01): `chooseStopBehaviourV1` was
 * previously called in only ONE place in `runnerRegistry.ts` — the final
 * explanation fallthrough — where its output selected explanation TEXT but
 * controlled no actual behaviour. The durable `quotaParkRecord` write and the
 * "Rerun after reset" scheduled-resume offer were decided by separate, ad hoc
 * conditions in the withheld-cascade branch above it, which never called this
 * function at all. That made this module a description of a policy rather
 * than the policy itself. Both of those call sites now compute their
 * `MidRoundStopBehaviourV1` through `chooseStopBehaviourV1` and act on ITS
 * result — see the two `stopBehaviour ===` checks in `runnerRegistry.ts`
 * around the withheld-cascade branch — so this is the single place that
 * decides, for any mid-round failure, whether to durably park (and whether a
 * reset is near enough to schedule an automatic resume for) or merely alert.
 */

export type MidRoundFailureKindV1 =
  | "quota"
  | "temporarily-unavailable"
  | "model-entitlement"
  | "generic"
  | undefined;

export interface MidRoundFailureClassificationV1 {
  readonly failureKind: MidRoundFailureKindV1;
  /**
   * Structural authentication verdict (`result.authFailure === true` OR a
   * match against `isAuthenticationFailure`) — independent of `failureKind`,
   * since a message can classify as e.g. "temporarily-unavailable" by its
   * "try again later" wording while ALSO being an auth failure by its "403 /
   * sign in" wording (the exact wf10 run 042 case item 8 is built from).
   */
  readonly authFailure: boolean;
  /**
   * A known, NEAR provider-reported reset instant (ISO string), when this
   * exact failure carries one — the caller resolves this the same way
   * `runnerRegistry.ts`'s withheld-cascade branch already did before this
   * fix (`parseQuotaResetV1` on this failure's own message, falling back to
   * the session/ledger-observed reset, then narrowed by
   * `isQuotaResetBeyondThresholdV1`). `undefined` covers both "no reset
   * could be determined at all" and "a reset is known but far enough off
   * that scheduling an automatic resume for it is not worthwhile" — both
   * collapse to the same non-scheduled park outcome (`"park"`) below, since
   * neither is a near-term promise worth automating a resume for. Omit this
   * field entirely (rather than passing `undefined`) at a call site that has
   * no reset information available at all — the two are equivalent, but an
   * explicit `undefined` documents "resets were considered and none apply
   * here" versus a caller that never attempted to parse one.
   */
  readonly knownNearResetAt?: string | undefined;
}

/**
 * `"park-and-schedule"` — a durable, recoverable block with a KNOWN, NEAR
 * reset time: record it (`quotaParkRecord`) so the task tree/status bar can
 * say so, AND offer a scheduled automatic resume at that instant.
 *
 * `"park"` — the same durable, recoverable block (quota/model-entitlement),
 * but with no near reset time to schedule against — either no reset could be
 * parsed at all, or the provider-reported reset is far enough off that an
 * automatic resume is not worth arming. Still recorded as `quotaParkRecord`
 * (the record's own `resetAt` is optional; downstream consumers such as
 * `reviewActions.ts`'s "Wait for reset" option already render the
 * no-known-reset case correctly), just with no scheduled-resume offer.
 *
 * `"alert-and-stop"` — an authentication/sign-in failure. Nothing about it
 * resolves itself with time, so there is nothing to park or schedule; the
 * user must act (sign in again) before any retry — automatic or manual —
 * can succeed.
 *
 * `"alert"` — anything else cascade-relevant (`temporarily-unavailable`
 * outages with no quota semantics, or a `generic` failure). Reported, not
 * tracked as a durable block.
 */
export type MidRoundStopBehaviourV1 = "park-and-schedule" | "park" | "alert-and-stop" | "alert";

export function chooseStopBehaviourV1(
  classification: MidRoundFailureClassificationV1
): MidRoundStopBehaviourV1 {
  if (classification.authFailure) {
    return "alert-and-stop";
  }
  if (
    classification.failureKind === "quota" ||
    classification.failureKind === "model-entitlement"
  ) {
    return classification.knownNearResetAt !== undefined ? "park-and-schedule" : "park";
  }
  return "alert";
}

/**
 * The six situations in which a mid-round failure ends without a backup
 * having actually been dispatched, and therefore needs an explanation of why.
 * `cascadeWithheldDirtyTree` / `noBackupConfigured` / `treeStateUnknown`
 * reproduce the exact wording `runnerRegistry.ts` already showed for the
 * non-auth case (unifying three inline template strings into one place);
 * `authFailureBackupWithheld` is the previously-missing case.
 *
 * `neverSwitchConfigured` is distinct from `noBackupConfigured`: the latter
 * means there is nothing usable to switch to (empty/unresolvable chain under
 * a `switch-to-backup` strategy); the former means a usable chain exists but
 * the stage's own setting says never to use it. Rendering both as "no backup
 * model is configured" would be false for a `never-switch` stage that DOES
 * have backups configured (plan Part 14 item 7/8 review finding).
 *
 * `notCascadeEligible` is a second, previously-missing case (review
 * completion blocker, 2026-09-01, round 2): a `"generic"` (or otherwise
 * unclassified) failure never enters a cascade at all, on a clean OR dirty
 * tree, regardless of whether a backup chain is configured — the caller's own
 * `isCascadeEligibleFailureKind` gate excludes it before any chain/tree check
 * runs. That is a materially different reason than any of the other five
 * (none of which apply — a chain may well be configured, `switch-to-backup`
 * may well be the strategy, and the tree state may well be known) and needs
 * its own explanation rather than silently returning the primary's raw,
 * unexplained error.
 *
 * Review completion blocker (2026-09-01, round 3): the branch above omitted
 * the item 8 guard sentence — "this round changed N file(s), so the switch
 * was withheld" — for a dirty tree, on the reasoning that a non-cascade-
 * eligible failure kind never attempts a backup regardless of tree state, so
 * the tree state seemed irrelevant. Item 8's rule is not "explain the guard
 * only when the guard is the OPERATIVE reason" — it is "any round that
 * changed files and then failed for any reason should carry the same
 * sentence" (plan item 8, verbatim). A dirty-tree `notCascadeEligible`
 * failure changed files and then failed, so it carries the sentence too,
 * alongside (not instead of) the failure-kind reason, exactly as
 * `authFailureBackupWithheld` already does for the auth case.
 */
export type MidRoundStopOutcomeV1 =
  | {
      readonly kind: "cascadeWithheldDirtyTree";
      readonly limitLabel: string;
      readonly filesChangedCount: number;
      readonly remedyText: string;
      readonly affectedStagesClause: string;
    }
  | {
      readonly kind: "notCascadeEligible";
      readonly failureKind: MidRoundFailureKindV1;
      readonly dirtyTree: boolean;
      readonly filesChangedCount?: number;
    }
  | {
      readonly kind: "noBackupConfigured";
      readonly failureKind: MidRoundFailureKindV1;
    }
  | {
      readonly kind: "neverSwitchConfigured";
      readonly failureKind: MidRoundFailureKindV1;
    }
  | {
      readonly kind: "treeStateUnknown";
      readonly failureKind: MidRoundFailureKindV1;
    }
  | {
      readonly kind: "authFailureBackupWithheld";
      readonly dirtyTree: boolean;
      readonly filesChangedCount?: number;
    };

export function describeMidRoundOutcomeV1(
  primaryProviderLabel: string,
  errorMessage: string | undefined,
  outcome: MidRoundStopOutcomeV1
): string {
  switch (outcome.kind) {
    case "cascadeWithheldDirtyTree":
      return (
        `Hit ${outcome.limitLabel} on ${primaryProviderLabel}` +
        (errorMessage ? ` (${errorMessage})` : "") +
        `. This round already changed ${outcome.filesChangedCount} file(s), so Ensemble withheld the ` +
        "automatic switch to this stage's backup model — switching mid-round on a dirty working tree " +
        `risks mixing two models' edits in one round. ${outcome.remedyText}${outcome.affectedStagesClause}`
      );
    case "notCascadeEligible":
      return (
        `${primaryProviderLabel} hit ${outcome.failureKind ?? "a"} failure` +
        (errorMessage ? ` (${errorMessage})` : "") +
        ". Ensemble does not automatically retry this kind of failure against a backup model — it is " +
        "not a quota, rate-limit, outage or entitlement block that switching models would be expected " +
        "to resolve." +
        (outcome.dirtyTree
          ? ` This round already changed ${outcome.filesChangedCount ?? 0} file(s), so Ensemble ` +
            "withheld the automatic switch to this stage's backup model — switching mid-round on a " +
            "dirty working tree risks mixing two models' edits in one round, though a backup would " +
            "never have been tried for this failure kind regardless of the working tree state. Rerun " +
            "this stage to retry with the same model, or switch the stage's model before rerunning."
          : " Rerun this stage to retry with the same model, or switch the stage's model before " +
            "rerunning.")
      );
    case "noBackupConfigured":
      return (
        `${primaryProviderLabel} hit ${outcome.failureKind ?? "a"} failure; no backup model is ` +
        "configured for this stage/chain, so no automatic fallback was attempted."
      );
    case "neverSwitchConfigured":
      return (
        `${primaryProviderLabel} hit ${outcome.failureKind ?? "a"} failure. This stage's fallback ` +
        "setting is Never switch, so the backup model was withheld even though one is configured " +
        "— set it to Fall back to backup models to allow a switch, or rerun this stage to retry " +
        "with the same model."
      );
    case "treeStateUnknown":
      return (
        `${primaryProviderLabel} hit ${outcome.failureKind ?? "a"} failure with the working ` +
        "tree state unknown (git unavailable or not a repository); Ensemble withheld the " +
        "automatic switch to this stage's backup model because a dirty-vs-clean tree could " +
        "not be confirmed."
      );
    case "authFailureBackupWithheld":
      return outcome.dirtyTree
        ? `Hit an authentication failure on ${primaryProviderLabel}` +
            (errorMessage ? ` (${errorMessage})` : "") +
            `. This round already changed ${outcome.filesChangedCount ?? 0} file(s), so Ensemble ` +
            "withheld the automatic switch to this stage's backup model — switching mid-round on a " +
            "dirty working tree risks mixing two models' edits in one round, and an authentication " +
            "failure is never auto-retried against a different model regardless of the working tree " +
            "state. Sign in again, then rerun this stage."
        : `Hit an authentication failure on ${primaryProviderLabel}` +
            (errorMessage ? ` (${errorMessage})` : "") +
            ". Ensemble does not automatically switch to a backup model on an authentication failure " +
            "— a different model would not resolve a sign-in problem with this account. Sign in " +
            "again, then rerun this stage.";
  }
}
