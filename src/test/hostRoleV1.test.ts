/**
 * The cloud runner/viewer role (hostRoleV1.ts): how a host learns its role,
 * and the guarantee that a VIEWER host can never reach a provider — at the
 * route gate every AI command passes first, and at both provider-boundary
 * backstops behind it.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  assertAiExecutionAllowedInThisHostV1,
  configureEnsembleHostRoleForTestV1,
  HostRoleGateErrorV1,
  isRunnerHostV1,
  isViewerHostV1,
  resolveEnsembleHostRoleV1,
} from "../state/hostRoleV1";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import { prepareAgentInvocationV1 } from "../services/agentExecutionBrokerV1";
import { runImplementationForModel } from "../runners/runnerRegistry";

void describe("hostRoleV1", () => {
  afterEach(() => {
    configureEnsembleHostRoleForTestV1(undefined);
  });

  void it("defaults to standalone, and the environment variable wins over the setting", () => {
    assert.equal(resolveEnsembleHostRoleV1({}), "standalone");
    configureEnsembleHostRoleForTestV1(undefined);
    assert.equal(resolveEnsembleHostRoleV1({ ENSEMBLE_HOST_ROLE: "runner" }), "runner");
    configureEnsembleHostRoleForTestV1(undefined);
    // An unknown value is ignored, never trusted as a role.
    assert.equal(resolveEnsembleHostRoleV1({ ENSEMBLE_HOST_ROLE: "admin" }), "standalone");
  });

  void it("reads the setting with ensemble-over-legacy precedence when no environment variable is set", () => {
    const workspace = vscode.workspace as unknown as { getConfiguration: unknown };
    const original = workspace.getConfiguration;
    const values: Record<string, string | undefined> = { ensemble: undefined, "vs-code-ai-helper": "viewer" };
    workspace.getConfiguration = (section: string) => ({
      get: () => undefined,
      inspect: () => (values[section] === undefined ? undefined : { globalValue: values[section] }),
    });
    try {
      assert.equal(resolveEnsembleHostRoleV1({}), "viewer", "the legacy key is honoured when the new one is unset");
      configureEnsembleHostRoleForTestV1(undefined);
      values.ensemble = "runner";
      assert.equal(resolveEnsembleHostRoleV1({}), "runner", "the new key wins over the legacy key");
    } finally {
      workspace.getConfiguration = original;
    }
  });

  void it("the role is fixed once resolved: a later change does not flip a running host", () => {
    assert.equal(resolveEnsembleHostRoleV1({ ENSEMBLE_HOST_ROLE: "viewer" }), "viewer");
    assert.equal(resolveEnsembleHostRoleV1({ ENSEMBLE_HOST_ROLE: "runner" }), "viewer");
    assert.equal(isViewerHostV1(), true);
    assert.equal(isRunnerHostV1(), false);
  });

  void it("a viewer host is refused at the route gate and at both provider boundaries; other roles pass the host check", async () => {
    configureEnsembleHostRoleForTestV1("viewer");
    assert.throws(() => assertAiExecutionAllowedInThisHostV1(), HostRoleGateErrorV1);
    assert.throws(() => assertLegacyAiRouteAllowedV0("review.v1"), HostRoleGateErrorV1);
    // The backstops refuse BEFORE looking at their arguments.
    assert.throws(() => prepareAgentInvocationV1({} as never, {} as never, {} as never), HostRoleGateErrorV1);
    await assert.rejects(runImplementationForModel({} as never), HostRoleGateErrorV1);

    for (const role of ["standalone", "runner"] as const) {
      configureEnsembleHostRoleForTestV1(role);
      assert.doesNotThrow(() => assertAiExecutionAllowedInThisHostV1());
      assert.doesNotThrow(() => assertLegacyAiRouteAllowedV0("review.v1"));
    }
  });
});
