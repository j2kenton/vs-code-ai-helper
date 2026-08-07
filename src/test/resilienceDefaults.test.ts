/**
 * The `ensemble.resilience.*` defaults exist in TWO places: package.json's
 * configuration contribution (what VS Code hands a user who never touched the
 * setting) and RESILIENCE_DEFAULTS in settings.ts (the fallback used by the
 * lightweight configuration adapters in tests and non-VS-Code callers).
 *
 * If those disagree, a flag behaves one way in the product and the other way
 * under test — the hardest kind of drift to notice, because the suite stays
 * green while shipped behavior differs. This pins them equal.
 *
 * 2026-08-07: the defaults were flipped from legacy-off to on, per the plan's
 * own rollout rule — flags become unconditional once a full task has run green
 * under them, which happened that day. Shipping them off meant a new user got
 * exactly the configuration that produced the 119-round review runaway these
 * flags were written to prevent.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RESILIENCE_DEFAULTS } from "../config/settings";

interface ConfigProperty {
  readonly default?: unknown;
}

interface ConfigBlock {
  readonly properties: Record<string, ConfigProperty>;
}

/** Every declared configuration property, flattened across single-or-array `contributes.configuration`. */
function packageJsonConfigProperties(): Record<string, ConfigProperty> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  ) as { contributes: { configuration: ConfigBlock | ConfigBlock[] } };
  const configuration = pkg.contributes.configuration;
  const blocks: ConfigBlock[] = Array.isArray(configuration) ? configuration : [configuration];

  const properties: Record<string, ConfigProperty> = {};
  for (const block of blocks) {
    for (const [key, value] of Object.entries(block.properties)) {
      properties[key] = value;
    }
  }
  return properties;
}

function packageJsonResilienceDefaults(): Record<string, unknown> {
  const prefix = "ensemble.resilience.";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(packageJsonConfigProperties())) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = value.default;
    }
  }
  return out;
}

void describe("ensemble.resilience.* defaults", () => {
  void it("package.json and RESILIENCE_DEFAULTS declare the same value for every flag", () => {
    const fromPackage = packageJsonResilienceDefaults();
    assert.deepStrictEqual(
      { ...RESILIENCE_DEFAULTS },
      fromPackage,
      "settings.ts's fallbacks must equal package.json's schema defaults — otherwise the flag " +
        "behaves differently in the product than under test"
    );
  });

  void it("covers every resilience flag the schema declares, with no extras on either side", () => {
    const fromPackage = Object.keys(packageJsonResilienceDefaults()).sort();
    const fromCode = Object.keys(RESILIENCE_DEFAULTS).sort();
    assert.deepStrictEqual(
      fromCode,
      fromPackage,
      "a flag added to one side but not the other silently falls back to a hardcoded value"
    );
  });

  void it("ships the resilient behavior on, not the legacy behavior that caused the runaway", () => {
    // Direction matters more than the exact numbers: the boolean guards must
    // be enabled, and the two round-count breakers must be armed (non-zero),
    // since 0 disables them entirely.
    assert.strictEqual(RESILIENCE_DEFAULTS.fastForwardSurvivesEscalation, true);
    assert.strictEqual(RESILIENCE_DEFAULTS.rejectDegenerateReviews, true);
    assert.strictEqual(RESILIENCE_DEFAULTS.zeroFixableTerminatesFastForward, true);
    assert.strictEqual(RESILIENCE_DEFAULTS.blockerSetPlateau, true);
    assert.strictEqual(RESILIENCE_DEFAULTS.nothingToFixRoutesToReview, true);
    assert.ok(
      RESILIENCE_DEFAULTS.churnCeilingRounds > 0,
      "churnCeilingRounds of 0 disables the ceiling"
    );
    assert.ok(
      RESILIENCE_DEFAULTS.noProgressBreakerRounds > 0,
      "noProgressBreakerRounds of 0 disables the breaker"
    );
  });

  void it("keeps both breakers below the default fast-forward iteration budget", () => {
    // A breaker at or above the outer budget can never fire — the loop would
    // hit fastForwardMaxIterations first, which is the runaway it exists to
    // prevent.
    const maxIterations =
      packageJsonConfigProperties()["ensemble.fastForwardMaxIterations"]?.default;

    assert.strictEqual(typeof maxIterations, "number");
    assert.ok(
      RESILIENCE_DEFAULTS.churnCeilingRounds < (maxIterations as number),
      `churnCeilingRounds (${RESILIENCE_DEFAULTS.churnCeilingRounds}) must be below fastForwardMaxIterations (${String(maxIterations)})`
    );
    assert.ok(
      RESILIENCE_DEFAULTS.noProgressBreakerRounds < (maxIterations as number),
      `noProgressBreakerRounds (${RESILIENCE_DEFAULTS.noProgressBreakerRounds}) must be below fastForwardMaxIterations (${String(maxIterations)})`
    );
  });
});
