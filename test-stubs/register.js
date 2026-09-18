"use strict";
// Preload hook for `node --test -r ./test-stubs/register.js`: makes
// require("vscode") resolve to the stub in test-stubs/vscode, so files that
// import vscode can be loaded under plain Node (outside the extension host)
// by test:unit. See test-stubs/vscode/index.js for what's implemented.

const path = require("node:path");
const Module = require("node:module");

// The unit suite must not inherit the HOST ROLE of whatever started it.
//
// `deploy/devbox/runner.sh` exports ENSEMBLE_HOST_ROLE=runner, and every
// process the runner's VS Code spawns inherits it — including the workflow's
// own `pnpm run verify`. Product code reads that variable
// (src/state/hostRoleV1.ts), so suites that assert on role-dependent
// behaviour changed answer purely because of WHERE they ran: on 2026-09-18 a
// cloud task sat blocked on a red acceptance gate whose only cause was this,
// with `settingsScopeMigration` and `draftTaskWithAIWorkAdmission` failing on
// the box (4 of 16) and the identical tree passing 16 of 16 over SSH. Any
// task on that box would have hit it.
//
// Tests that want a role set it explicitly, through
// `configureEnsembleHostRoleForTestV1` or by assigning this variable inside
// the test and restoring it afterwards.
delete process.env.ENSEMBLE_HOST_ROLE;

const stubPath = path.join(__dirname, "vscode", "index.js");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return stubPath;
  }
  return originalResolveFilename.call(this, request, ...rest);
};

// Suspend the fail-closed AI safety-gate enforcement for behavioral tests.
//
// Production ships with every legacy AI route disabled and every
// uncorrelated provider invocation rejected (plan §1.3 / §8 staged
// migration — see src/services/legacyAiActionSafetyGateV0.ts). The
// behavioral unit suites, however, deliberately exercise the retained
// legacy handler/runner machinery (draft, reviews, commit-message
// generation, runner fallback cascades, ...) that stays in the tree until
// the V1 cutover adapts it (plan §3.4) — with enforcement on, every one of
// those suites would fail at the first gate statement and stop covering the
// machinery the cutover depends on. Enforcement itself, including the
// production values of both switches, is covered explicitly by
// legacyAiActionSafetyGateV0.test.ts, which re-enables them per test and
// statically asserts the production initializers in the source file. This
// preload hook never runs in the packaged extension.
try {
  const gate = require(path.join(__dirname, "..", "out", "services", "legacyAiActionSafetyGateV0.js"));
  gate.LEGACY_AI_ROUTE_DISABLED_V0.clear();
  gate.LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = false;
} catch {
  // out/services not compiled yet (e.g. a targeted run before tsc) — tests
  // that need the gate will fail loudly on their own import instead.
}
