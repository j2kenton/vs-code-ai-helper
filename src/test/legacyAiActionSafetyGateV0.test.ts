/**
 * Coverage for the fail-closed AI action safety gate (plan §1.3):
 *  - assertLegacyAiRouteAllowedV0 rejects any route id that is not in the
 *    registered catalog, so a future new AI route added without updating
 *    the catalog fails closed instead of running unaccounted-for.
 *  - In production, EVERY registered legacy route is disabled and EVERY
 *    uncorrelated provider invocation is rejected until its V1 migration
 *    lands (asserted statically against the source initializers, since the
 *    unit-test harness — test-stubs/register.js — suspends both switches so
 *    behavioral suites can keep exercising the retained legacy machinery).
 *  - assertNoUnauthorizedV1CorrelationV0 rejects a V1-correlated request
 *    unless its actionKey is a migrated action, and rejects uncorrelated
 *    legacy requests whenever the production boundary switch is on.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  assertLegacyAiRouteAllowedV0,
  assertNoUnauthorizedV1CorrelationV0,
  isLegacyAiRouteDisabledV0,
  LEGACY_AI_ROUTE_DISABLED_V0,
  LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0,
  LegacyAiActionSafetyGateErrorV0,
  MIGRATED_ACTION_KEYS_V0,
} from "../services/legacyAiActionSafetyGateV0";

const REGISTERED_ROUTE_IDS = [
  "draft.v1",
  "generatePlan.v1",
  "review.v1",
  "applyReview.v1",
  "fastForward.v1",
  "generateImplementation.v1",
  "implementation.v1",
  "applyCurrentStage.v1",
  "lint.v1",
  "chatSend.v1",
  "commitPushMetadata.v1",
];

/**
 * Route ids that have migrated onto the coordinator (plan §6.2 onward): each
 * one's LEGACY invocation path is no longer in `LEGACY_AI_ROUTE_DISABLED_V0`
 * (its real handler now routes through the coordinator instead), and its
 * actionKey is in `MIGRATED_ACTION_KEYS_V0`. Still a REGISTERED route id
 * (assertLegacyAiRouteAllowedV0 still recognizes it), just no longer
 * disabled.
 */
const MIGRATED_ROUTE_IDS = [
  "generatePlan.v1",
  "draft.v1",
  "generateImplementation.v1",
  "review.v1",
  "applyReview.v1",
  "chatSend.v1",
  "commitPushMetadata.v1",
];

const GATE_SOURCE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "services",
  "legacyAiActionSafetyGateV0.ts"
);

void describe("LegacyAiActionSafetyGateV0", () => {
  void describe("production enforcement state (static source assertions)", () => {
    // The harness (test-stubs/register.js) clears the disabled set and turns
    // the boundary switch off before any behavioral test loads, so the
    // PRODUCTION values must be proven against the source initializers — the
    // same source-order technique the wiring tests use.
    const source = fs.readFileSync(GATE_SOURCE_PATH, "utf8");

    void it("LEGACY_AI_ROUTE_DISABLED_V0's initializer disables every registered, not-yet-migrated route", () => {
      const initializerStart = source.indexOf(
        "export const LEGACY_AI_ROUTE_DISABLED_V0: ReadonlySet<string> = new Set<string>(["
      );
      assert.ok(initializerStart >= 0, "could not find the LEGACY_AI_ROUTE_DISABLED_V0 initializer");
      const initializerEnd = source.indexOf("]);", initializerStart);
      assert.ok(initializerEnd > initializerStart, "could not find the end of the initializer");
      const initializer = source.slice(initializerStart, initializerEnd);
      for (const routeId of REGISTERED_ROUTE_IDS) {
        if (MIGRATED_ROUTE_IDS.includes(routeId)) {
          assert.ok(
            !initializer.includes(`"${routeId}"`),
            `production LEGACY_AI_ROUTE_DISABLED_V0 must NOT disable migrated route "${routeId}"`
          );
          continue;
        }
        assert.ok(
          initializer.includes(`"${routeId}"`),
          `production LEGACY_AI_ROUTE_DISABLED_V0 must disable "${routeId}" until its V1 migration lands`
        );
      }
    });

    void it("LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0 defaults to enabled", () => {
      assert.ok(
        source.includes(
          "export const LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0 = { enabled: true };"
        ),
        "production boundary switch must default to { enabled: true }"
      );
    });

    void it("MIGRATED_ACTION_KEYS_V0 contains exactly the migrated route ids", () => {
      assert.equal(MIGRATED_ACTION_KEYS_V0.size, MIGRATED_ROUTE_IDS.length);
      for (const routeId of MIGRATED_ROUTE_IDS) {
        assert.ok(
          MIGRATED_ACTION_KEYS_V0.has(routeId),
          `MIGRATED_ACTION_KEYS_V0 must contain "${routeId}"`
        );
      }
    });
  });

  void describe("assertLegacyAiRouteAllowedV0", () => {
    for (const routeId of REGISTERED_ROUTE_IDS) {
      void it(`recognizes the registered route id "${routeId}" (harness-suspended enforcement)`, () => {
        // With enforcement suspended by the harness, a registered id passes;
        // the enforcement path itself is proven in the kill-switch test below.
        assert.doesNotThrow(() => assertLegacyAiRouteAllowedV0(routeId));
      });
    }

    void it("throws for an unregistered route id (fail-closed)", () => {
      assert.throws(
        () => assertLegacyAiRouteAllowedV0("someNewAiAction.v1"),
        LegacyAiActionSafetyGateErrorV0
      );
    });

    void it("throws for an empty string", () => {
      assert.throws(() => assertLegacyAiRouteAllowedV0(""), LegacyAiActionSafetyGateErrorV0);
    });

    void it("rejects a route while it is in the disabled set (production state)", () => {
      // The harness cleared the set; re-add one route to prove the disabled
      // path is real and wired, then restore so no state leaks across tests.
      const mutable = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(mutable.has("generatePlan.v1"), false);
      mutable.add("generatePlan.v1");
      try {
        assert.throws(() => assertLegacyAiRouteAllowedV0("generatePlan.v1"), LegacyAiActionSafetyGateErrorV0);
        // A route not in the set remains recognized.
        assert.doesNotThrow(() => assertLegacyAiRouteAllowedV0("draft.v1"));
      } finally {
        mutable.delete("generatePlan.v1");
      }
    });
  });

  void describe("isLegacyAiRouteDisabledV0 (composite-route query)", () => {
    void it("throws for an unregistered route id (identity stays fail-closed)", () => {
      assert.throws(() => isLegacyAiRouteDisabledV0("someNewAiAction.v1"), LegacyAiActionSafetyGateErrorV0);
    });

    void it("reports disabled/enabled state without throwing for registered routes", () => {
      const mutable = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(isLegacyAiRouteDisabledV0("commitPushMetadata.v1"), false);
      mutable.add("commitPushMetadata.v1");
      try {
        assert.equal(isLegacyAiRouteDisabledV0("commitPushMetadata.v1"), true);
      } finally {
        mutable.delete("commitPushMetadata.v1");
      }
    });
  });

  void describe("assertNoUnauthorizedV1CorrelationV0", () => {
    void it("rejects every legacy (uncorrelated) request while the production boundary switch is on, except implementation.v1's own bootstrap request", () => {
      // The harness turned the switch off; restore the production value to
      // prove the fail-closed boundary path, then suspend it again.
      assert.equal(LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled, false);
      LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = true;
      try {
        assert.throws(() => assertNoUnauthorizedV1CorrelationV0(undefined), LegacyAiActionSafetyGateErrorV0);
        assert.throws(() => assertNoUnauthorizedV1CorrelationV0(null), LegacyAiActionSafetyGateErrorV0);
        assert.throws(
          () =>
            assertNoUnauthorizedV1CorrelationV0({
              taskFolderUri: {},
              workspaceUri: {},
              stage: "desc",
              prompt: "hello",
              outputFile: {},
              modelId: "claude-cli:sonnet",
            }),
          LegacyAiActionSafetyGateErrorV0
        );
        // "implementation.v1" (Run Implementation) is this migration's own
        // bootstrapping tool, identified here by stage "impl" — it must stay
        // exempt from the uncorrelated-rejection even with the switch on, or
        // the task can never build the step (plan.md step 16) that would
        // properly migrate it. See the exemption's rationale in
        // legacyAiActionSafetyGateV0.ts and the matching NOTE on
        // runImplementationWithAI in reviewActions.ts.
        assert.doesNotThrow(() =>
          assertNoUnauthorizedV1CorrelationV0({
            taskFolderUri: {},
            workspaceUri: {},
            stage: "impl",
            prompt: "hello",
            outputFile: {},
            modelId: "claude-cli:sonnet",
          })
        );
      } finally {
        LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = false;
      }
    });

    void it("passes legacy (uncorrelated) requests through only when the switch is suspended (test harness state)", () => {
      assert.equal(LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled, false);
      assert.doesNotThrow(() => assertNoUnauthorizedV1CorrelationV0(undefined));
      assert.doesNotThrow(() => assertNoUnauthorizedV1CorrelationV0(null));
      assert.doesNotThrow(() =>
        assertNoUnauthorizedV1CorrelationV0({
          taskFolderUri: {},
          workspaceUri: {},
          stage: "desc",
          prompt: "hello",
          outputFile: {},
          modelId: "claude-cli:sonnet",
        })
      );
    });

    void it("rejects a V1-correlated request whose actionKey is not migrated", () => {
      assert.throws(
        () =>
          assertNoUnauthorizedV1CorrelationV0({
            prompt: "hello",
            correlation: {
              // "fastForward.v1" has not migrated yet — "generatePlan.v1" and
              // "draft.v1" are covered by the "allows... once migrated" test
              // below instead.
              actionKey: "fastForward.v1",
              operationId: "a".repeat(32),
              attemptId: "b".repeat(32),
              taskBindingId: "tb",
              chatDocumentId: "cd",
            },
          }),
        LegacyAiActionSafetyGateErrorV0
      );
    });

    void it("rejects a V1-correlated request with a non-string actionKey", () => {
      assert.throws(
        () =>
          assertNoUnauthorizedV1CorrelationV0({
            correlation: { actionKey: 42 },
          }),
        LegacyAiActionSafetyGateErrorV0
      );
    });

    void it("allows a V1-correlated request once its actionKey is migrated", () => {
      // "generatePlan.v1" and "draft.v1" are genuinely migrated in
      // production today (plan §6.2/§6.3) — no mutation needed to prove the
      // "allowed" branch, unlike before any action had migrated.
      assert.equal(MIGRATED_ACTION_KEYS_V0.has("generatePlan.v1"), true);
      assert.equal(MIGRATED_ACTION_KEYS_V0.has("draft.v1"), true);
      assert.doesNotThrow(() =>
        assertNoUnauthorizedV1CorrelationV0({
          correlation: { actionKey: "generatePlan.v1" },
        })
      );
      assert.doesNotThrow(() =>
        assertNoUnauthorizedV1CorrelationV0({
          correlation: { actionKey: "draft.v1" },
        })
      );
    });
  });
});
