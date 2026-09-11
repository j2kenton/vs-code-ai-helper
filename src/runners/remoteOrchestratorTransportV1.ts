import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  boundedTransportDetailV1,
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
  /**
   * Hard deadline for one whole call — headers AND body. Default 15
   * minutes: a single model round, generously; never unbounded.
   */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS_V1 = 15 * 60 * 1000;

interface ProviderCallSuccessBodyV1 {
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the response body, rejecting as soon as `signal` aborts. A real
 * fetch body already honours the request's signal; this also holds for a
 * body stream that does not (an injected fetch, a stalled proxy stream).
 */
function readBodyOrAbort(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    response.text().then(
      (text) => {
        signal.removeEventListener("abort", onAbort);
        resolve(text);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("body read failed"));
      }
    );
  });
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

      // Checked before ANY network work: a token that is already cancelled
      // fires its listener only asynchronously, after the POST — and the
      // server would run (and bill) the provider call anyway.
      if (request.cancellationToken.isCancellationRequested) {
        return { kind: "callerCancelled" };
      }
      let accessToken: string | undefined;
      try {
        accessToken = await getAccessToken();
      } catch (error) {
        return {
          kind: "transportFailure",
          code: "remoteOrchestratorNotSignedIn",
          detail: boundedTransportDetailV1(error) ?? "the Ensemble Cloud session could not be read",
        };
      }
      if (request.cancellationToken.isCancellationRequested) {
        return { kind: "callerCancelled" };
      }
      if (accessToken === undefined) {
        return {
          kind: "transportFailure",
          code: "remoteOrchestratorNotSignedIn",
          detail: "no active Ensemble Cloud session — sign in to run this stage on the cloud box",
        };
      }

      // Cancellation and the deadline cover the WHOLE call, body included.
      // They used to be released as soon as headers arrived, so a proxy that
      // sent headers and then stalled left the stage hung with Cancel no
      // longer able to stop it (review finding, 2026-09-11).
      const controller = new AbortController();
      let timedOut = false;
      const cancelListener = request.cancellationToken.onCancellationRequested(() => {
        controller.abort();
      });
      const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS_V1);

      let response: Response;
      let bodyText: string;
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
        bodyText = await readBodyOrAbort(response, controller.signal);
      } catch (error) {
        if (request.cancellationToken.isCancellationRequested) {
          return { kind: "callerCancelled" };
        }
        if (timedOut) {
          return {
            kind: "transportFailure",
            code: "remoteOrchestratorTimeout",
            detail: "the remote orchestrator did not finish the call in time",
            networkFault: true,
          };
        }
        return {
          kind: "transportFailure",
          code: "remoteOrchestratorTransportError",
          detail: boundedTransportDetailV1(error) ?? "network error",
          networkFault: true,
        };
      } finally {
        clearTimeout(deadline);
        cancelListener.dispose();
      }
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

      // The body is untrusted: fields are used only when they are strings (a
      // non-string `message` used to make `.slice` throw out of invoke), and
      // the detail goes through the shared bounded, redacting formatter the
      // AgentTransportExitV1 contract requires.
      const errorBody = isRecord(parsed) ? parsed : undefined;
      const errorCode = typeof errorBody?.["code"] === "string" ? errorBody["code"] : undefined;
      const errorMessage = typeof errorBody?.["message"] === "string" ? errorBody["message"] : undefined;
      const code =
        errorCode !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(errorCode)
          ? `remoteOrchestrator.${errorCode}`
          : `remoteOrchestratorHttp${response.status}`;
      const detail =
        boundedTransportDetailV1(errorMessage ?? `remote orchestrator returned ${response.status}`) ??
        `remote orchestrator returned ${response.status}`;
      return { kind: "transportFailure", code, detail };
    },
  };
}
