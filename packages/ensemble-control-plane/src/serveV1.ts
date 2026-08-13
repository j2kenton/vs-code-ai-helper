/**
 * The composition root: the one place the control plane is assembled from its
 * parts and actually listens on a port.
 *
 * Everything else in this package is a factory that takes its collaborators as
 * arguments — deliberately, since that is what makes the store, the session
 * service, the hub and the sandbox layer independently testable. The cost of
 * that design is that nothing in the package ever COMPOSES them outside the
 * test files, so until this module existed the server could be exercised by a
 * test and could not be started by a person. This closes that gap and nothing
 * more: no new behaviour, no new endpoints.
 *
 * Configuration comes from the environment, because the values are secrets
 * (OAuth client secrets, the KEK boot secret) and secrets do not belong in a
 * committed file. Nothing is defaulted silently that would be dangerous to get
 * wrong: a missing KEK secret is a hard failure rather than a generated
 * throwaway, since a generated one would decrypt nothing on the next boot and
 * would look like data loss.
 *
 * DELIBERATELY OMITTED: the engine run host (`runs`). It requires a
 * `providerRunnerFor` — the component that actually invokes a model for a task
 * — and wiring that is a separate composition problem with its own credentials
 * and failure modes. Without it the handler is store-only, exactly as its own
 * documentation describes: sign-in, key custody, task records, bindings,
 * gates, files and the WebSocket stream all work; creating a task does not
 * start a run. That is the correct first milestone, and the gap is explicit
 * rather than hidden behind a half-wired runner.
 *
 * THIS NOW COSTS REAL MONEY, which it did not when the omission was written.
 * A `task-owned-ephemeral` binding makes task creation ALLOCATE a sandbox at
 * the user's provider. With no run host, nothing subsequently drives that task:
 * the git source is never acquired, the task stays `creating` forever, and
 * `teardownTaskSandboxV1` — which is what honours `destroy-on-completion` — has
 * no production caller, so the sandbox is never destroyed. Each task created
 * against this composition therefore leaves one billable sandbox running until
 * the user kills it in their provider's dashboard.
 *
 * So this composition REFUSES a `task-owned-ephemeral` binding outright
 * (422 sandboxBindingInvalid, explaining why) rather than allocating something
 * it cannot drive or reclaim. `user-managed-persistent` is unaffected and is
 * the working path here: it allocates nothing, and the sandbox is already
 * yours. Set `ENSEMBLE_ALLOW_UNMANAGED_SANDBOXES=1` to allocate anyway, and
 * accept that every created task leaves a billable sandbox to destroy by hand.
 * Tracked in docs/verification/known-gaps.md.
 *
 * Usage:
 *   ENSEMBLE_KEK_SECRET=... ENSEMBLE_GITHUB_CLIENT_ID=... \
 *   ENSEMBLE_GITHUB_CLIENT_SECRET=... pnpm --filter @ensemble/control-plane serve
 */
import { createRedactingLogSinkV1 } from "../../ensemble-engine/src/logRedactionV1";
import { createControlPlaneHandlerV1, createControlPlaneNodeServerV1 } from "./controlPlaneServerV1";
import {
  createGitHubIdentityValidatorV1,
  createOidcIdentityValidatorV1,
  type IdentityValidatorV1,
} from "./identityValidatorsV1";
import { createBootSecretKekProviderV1 } from "./keyCustodyV1";
import { createSdkSandboxClientFactoryV1 } from "./sandboxLifecycleV1";
import { createSessionServiceV1 } from "./sessionServiceV1";
import { createSqliteControlPlaneStoreV1 } from "./sqliteStoreV1";
import { createWsHubV1 } from "./wsHubV1";

/** Google's published OIDC endpoints — fixed values, not configuration. */
const GOOGLE_TOKEN_ENDPOINT_V1 = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI_V1 = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER_V1 = "https://accounts.google.com";

const DEFAULT_PORT_V1 = 8787;
const DEFAULT_DATABASE_PATH_V1 = "control-plane.sqlite";
/** Where the Expo web target serves from during development. */
const DEFAULT_CORS_ORIGIN_V1 = "http://localhost:8081";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name} is required. The control plane will not start without it — see serveV1.ts for the full list.`
    );
  }
  return value;
}

/** Both halves of an OAuth credential or neither; one alone is a misconfiguration. */
function optionalPair(
  idName: string,
  secretName: string
): { readonly clientId: string; readonly clientSecret: string } | undefined {
  const clientId = process.env[idName];
  const clientSecret = process.env[secretName];
  if (clientId === undefined && clientSecret === undefined) {
    return undefined;
  }
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(`${idName} and ${secretName} must be set together, or neither.`);
  }
  return { clientId, clientSecret };
}

export function buildIdentityValidatorsV1(): readonly IdentityValidatorV1[] {
  const validators: IdentityValidatorV1[] = [];

  const github = optionalPair("ENSEMBLE_GITHUB_CLIENT_ID", "ENSEMBLE_GITHUB_CLIENT_SECRET");
  if (github) {
    validators.push(
      createGitHubIdentityValidatorV1({
        fetch: globalThis.fetch,
        clientId: github.clientId,
        clientSecret: github.clientSecret,
      })
    );
  }

  const google = optionalPair("ENSEMBLE_GOOGLE_CLIENT_ID", "ENSEMBLE_GOOGLE_CLIENT_SECRET");
  if (google) {
    validators.push(
      createOidcIdentityValidatorV1({
        provider: "google",
        fetch: globalThis.fetch,
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT_V1,
        jwksUri: GOOGLE_JWKS_URI_V1,
        issuer: GOOGLE_ISSUER_V1,
      })
    );
  }

  if (validators.length === 0) {
    throw new Error(
      "No identity provider is configured. Set ENSEMBLE_GITHUB_CLIENT_ID/SECRET or " +
        "ENSEMBLE_GOOGLE_CLIENT_ID/SECRET — with none, nobody can sign in and the server is useless."
    );
  }
  return validators;
}

export function startControlPlaneV1(): { readonly port: number; readonly close: () => void } {
  const port = Number(process.env["ENSEMBLE_PORT"] ?? DEFAULT_PORT_V1);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ENSEMBLE_PORT must be a valid port number; got ${String(process.env["ENSEMBLE_PORT"])}`);
  }
  const databasePath = process.env["ENSEMBLE_DATABASE_PATH"] ?? DEFAULT_DATABASE_PATH_V1;
  const corsOrigins = (process.env["ENSEMBLE_CORS_ORIGINS"] ?? DEFAULT_CORS_ORIGIN_V1)
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Fail closed and fail loudly: an absent boot secret must not be replaced by
  // a generated one, because every key sealed under a generated KEK becomes
  // unreadable the moment the process restarts.
  const kekProvider = createBootSecretKekProviderV1({
    kekId: process.env["ENSEMBLE_KEK_ID"] ?? "boot-dev",
    bootSecret: required("ENSEMBLE_KEK_SECRET"),
  });

  const store = createSqliteControlPlaneStoreV1({ databasePath });
  const sessions = createSessionServiceV1({ store, validators: buildIdentityValidatorsV1() });
  const hub = createWsHubV1({ sessions, store });

  // Every line is redacted before it reaches stdout — the sanctioned route for
  // handing a sink to the control plane.
  const log = createRedactingLogSinkV1((line: string) => {
    process.stdout.write(`${line}\n`);
  });

  // Opt-in to creating sandboxes this composition cannot drive or tear down.
  // Off by default: see the handler option's own note, and the "no engine run
  // host" gap in docs/verification/known-gaps.md.
  const allowEphemeralSandboxWithoutRunHost =
    process.env["ENSEMBLE_ALLOW_UNMANAGED_SANDBOXES"] === "1";

  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub,
    kekProvider,
    sandboxFactory: createSdkSandboxClientFactoryV1(),
    allowEphemeralSandboxWithoutRunHost,
    log,
  });

  const server = createControlPlaneNodeServerV1(handler, { hub, corsOrigins });
  server.listen(port);
  log(`control plane listening on http://127.0.0.1:${port}`);
  log(`  database: ${databasePath}`);
  log(`  cors origins: ${corsOrigins.join(", ")}`);
  log(
    allowEphemeralSandboxWithoutRunHost
      ? "  WARNING: task-owned sandboxes are permitted with no run host — each " +
          "created task leaves a billable sandbox you must destroy by hand"
      : "  task-owned sandboxes: refused (no engine run host); attach your own sandbox"
  );
  return { port, close: (): void => void server.close() };
}

// Only run when executed directly, so importing this module (a test, or a
// future supervisor) never starts a listener as a side effect.
if (require.main === module) {
  startControlPlaneV1();
}
