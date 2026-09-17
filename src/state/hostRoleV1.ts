import * as vscode from "vscode";

/**
 * Which ROLE this extension host plays when the workflow runs in the cloud.
 *
 * The cloud setup runs the real extension in an always-on desktop VS Code on
 * the box (the RUNNER) so a task keeps going after the laptop is shut. Any
 * other window open on the same workspace — a Remote-SSH window on the same
 * box, sharing the same task folders — is a VIEWER: it shows tasks and chat
 * and hands the user's actions to the runner, and must never run AI itself.
 * Two hosts that both executed would double-run rounds, steal each other's
 * scheduled-run leases and pause each other's tasks (the runner's in-memory
 * admission registries are invisible to a second host — workAdmissionV1.ts).
 *
 * `standalone` is today's behaviour: one window, does everything.
 *
 * The role is fixed for the life of the extension host: it is resolved once
 * at activation and cached. A window that flipped from viewer to runner
 * mid-session would start executing work it never scheduled or admitted.
 *
 * Precedence: the `ENSEMBLE_HOST_ROLE` environment variable (how the box's
 * runner process declares itself — see deploy/devbox/runner.sh), then the
 * `ensemble.hostRole` setting (legacy `vs-code-ai-helper.hostRole`), then
 * `standalone`.
 */
export type EnsembleHostRoleV1 = "standalone" | "runner" | "viewer";

const HOST_ROLE_ENV_VAR_V1 = "ENSEMBLE_HOST_ROLE";
const HOST_ROLE_SETTING_KEY_V1 = "hostRole";
const ROLES_V1: ReadonlySet<string> = new Set<EnsembleHostRoleV1>(["standalone", "runner", "viewer"]);

let cachedRole: EnsembleHostRoleV1 | undefined;

function isRole(value: unknown): value is EnsembleHostRoleV1 {
  return typeof value === "string" && ROLES_V1.has(value);
}

/** The setting, with the same ensemble-over-legacy precedence settings.ts applies (duplicated to avoid an import cycle). */
function readHostRoleSettingV1(): EnsembleHostRoleV1 | undefined {
  for (const section of ["ensemble", "vs-code-ai-helper"]) {
    const inspected = vscode.workspace.getConfiguration(section).inspect<string>(HOST_ROLE_SETTING_KEY_V1);
    for (const value of [
      inspected?.workspaceFolderValue,
      inspected?.workspaceValue,
      inspected?.globalValue,
    ]) {
      if (value !== undefined) {
        return isRole(value) ? value : undefined;
      }
    }
  }
  return undefined;
}

export function resolveEnsembleHostRoleV1(env: NodeJS.ProcessEnv = process.env): EnsembleHostRoleV1 {
  if (cachedRole !== undefined) {
    return cachedRole;
  }
  const fromEnv = env[HOST_ROLE_ENV_VAR_V1];
  cachedRole = isRole(fromEnv) ? fromEnv : (readHostRoleSettingV1() ?? "standalone");
  return cachedRole;
}

/** Test seam: pin (or clear, with undefined) the cached role. */
export function configureEnsembleHostRoleForTestV1(role: EnsembleHostRoleV1 | undefined): void {
  cachedRole = role;
}

export function isViewerHostV1(): boolean {
  return resolveEnsembleHostRoleV1() === "viewer";
}

export function isRunnerHostV1(): boolean {
  return resolveEnsembleHostRoleV1() === "runner";
}

export class HostRoleGateErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRoleGateErrorV1";
  }
}

export const VIEWER_HOST_REFUSAL_MESSAGE_V1 =
  "This window is an Ensemble viewer: it shows the workflow but never runs AI itself. " +
  "Answer questions in Chat With AI (they are forwarded to the runner), or use " +
  "\"Ensemble: Run on Runner…\" to start an action there.";

/**
 * The hard safety net: a viewer host must never reach a provider. Called as
 * the first statement of every AI route handler (the route gate in
 * legacyAiActionSafetyGateV0.ts) and at both provider-boundary backstops
 * (the broker's prepare step in agentExecutionBrokerV1.ts and the CLI edit
 * entry point in runnerRegistry.ts), so no command, automation chain,
 * scheduled run or resume can execute AI from a viewer window even if some
 * caller forgot the route gate.
 */
export function assertAiExecutionAllowedInThisHostV1(): void {
  if (isViewerHostV1()) {
    throw new HostRoleGateErrorV1(VIEWER_HOST_REFUSAL_MESSAGE_V1);
  }
}
