import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  BoundedResultWriterV1,
} from "../types/agentExecutionV1";

/**
 * Remote-orchestrator text transport (progressive step toward "runs exactly
 * like local, just physically executes on the cloud box"): proxies a SINGLE
 * per-stage model call through the deployed control plane's
 * `POST /v1/provider-calls` instead of calling the provider directly from
 * this machine. Per-stage model/provider selection is UNCHANGED — the
 * caller (`runnerRegistry.ts`, not yet wired to construct this) still
 * decides which provider/model each stage uses, exactly as it does for a
 * local CLI or Copilot transport; only the network hop for that one call
 * moves to the cloud box. This does not yet move the orchestration LOOP
 * itself remote — closing this laptop mid-task still stops the run, since
 * the extension is still the one deciding what happens after each round.
 *
 * NOT YET WIRED into runnerRegistry.ts's dispatch (deliberately, per plan
 * discussion 2026-09-10): that file's `resolveRunnerForModel` is large,
 * actively-evolving, shared with concurrent local work, and this transport
 * needed to exist and be independently correct first.
 */

export interface RemoteOrchestratorTransportOptionsV1 {
  /** e.g. "https://orchestrator.ensembleworkflow.com" — no trailing slash. */
  readonly baseUrl: string;
  /** Provider id as the control plane's catalog knows it: "anthropic" | "openai" | "google". */
  readonly provider: string;
  /** Provider-native (unqualified) model id; undefined runs the provider's default. */
  readonly model: string | undefined;
  /**
   * Resolves the current control-plane session access token. A function
   * (not a fixed string) so the caller can refresh an expired token between
   * invocations without reconstructing the transport. Returning `undefined`
   * (not signed in) is a normal, expected outcome — mapped to a clear
   * transport failure, not an exception.
   */
  readonly getAccessToken: () => Promise<string | undefined>;
  /** Test seam: overrides the runtime's global fetch. Production callers never set it. */
  fetchImpl?: typeof fetch;
}

interface ProviderCallSuccessBodyV1 {
  readonly text: string;
}

interface ProviderCallErrorBodyV1 {
  readonly code: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `runnerId` distinguishes this transport in logs/telemetry from local CLI/Copilot runner ids. */
export function remoteOrchestratorRunnerId(provider: string): string {
  return `remote-orchestrator:${provider}`;
}

export function createRemoteOrchestratorTextTransportV1(
  options: RemoteOrchestratorTransportOptionsV1
): AgentTransportV1 {
  const { baseUrl, provider, model, getAccessToken } = options;
  const injectedFetch = options.fetchImpl;
  const fetchImpl: typeof fetch = (input, init) =>
    injectedFetch !== undefined ? injectedFetch(input, init) : fetch(input, init);

  return {
    runnerId: remoteOrchestratorRunnerId(provider),

    async invoke(
      request: AgentExecutionRequestV1,
      output: BoundedResultWriterV1
    ): Promise<AgentTransportExitV1> {
      if (request.mode !== "text") {
        // The remote endpoint is a single provider text call; it has no
        // preflight/edit shape (same restriction the local CLI transport
        // declares for the same reason — see cliAgentRunner.ts).
        return {
          kind: "transportFailure",
          code: "remoteOrchestratorModeUnsupported",
          detail: `the remote orchestrator has no provider-call path for mode "${request.mode}" (text only)`,
        };
      }

      const accessToken = await getAccessToken();
      if (accessToken === undefined) {
        return {
          kind: "transportFailure",
          code: "remoteOrchestratorNotSignedIn",
          detail: "no active Ensemble Cloud session — sign in to run this stage on the cloud box",
        };
      }

      const controller = new AbortController();
      const cancelListener = request.cancellationToken.onCancellationRequested(() => {
        controller.abort();
      });

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/provider-calls`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ provider, model, prompt: request.prompt }),
          signal: controller.signal,
        });
      } catch (error) {
        cancelListener.dispose();
        if (request.cancellationToken.isCancellationRequested) {
          return { kind: "callerCancelled" };
        }
        return {
          kind: "transportFailure",
          code: "remoteOrchestratorTransportError",
          detail: error instanceof Error ? error.message.slice(0, 200) : "network error",
          networkFault: true,
        };
      }
      cancelListener.dispose();

      const bodyText = await response.text();
      const parsed: unknown = ((): unknown => {
        try {
          return JSON.parse(bodyText) as unknown;
        } catch {
          return undefined;
        }
      })();

      if (response.status === 200) {
        const success = isRecord(parsed) ? (parsed as unknown as ProviderCallSuccessBodyV1) : undefined;
        if (success === undefined || typeof success.text !== "string") {
          return {
            kind: "transportFailure",
            code: "remoteOrchestratorMalformedResponse",
            detail: "the remote orchestrator's response had no text field",
          };
        }
        output.write(success.text);
        return { kind: "completed" };
      }

      const errorBody = isRecord(parsed) ? (parsed as unknown as ProviderCallErrorBodyV1) : undefined;
      const code =
        errorBody?.code !== undefined
          ? `remoteOrchestrator.${errorBody.code}`
          : `remoteOrchestratorHttp${response.status}`;
      const detail = errorBody?.message ?? `remote orchestrator returned ${response.status}`;
      return { kind: "transportFailure", code, detail: detail.slice(0, 200) };
    },
  };
}
