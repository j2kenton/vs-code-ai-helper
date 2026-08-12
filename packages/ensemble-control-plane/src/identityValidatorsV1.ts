/**
 * Server-side identity establishment (plan Parts 5/6 — the trust boundary).
 *
 * The client sends ONLY the authorization code + PKCE verifier; the control
 * plane performs the code exchange with the provider server-side and
 * validates the result per provider:
 *
 * - **OIDC (Google, Apple):** exchange the code at the token endpoint, then
 *   verify the ID token's RS256 signature against the provider's published
 *   JWKS plus issuer, audience, expiry, and nonce — every check fail-closed.
 * - **GitHub (plain OAuth):** exchange the code, then call the user API
 *   server-side with the resulting token; the subject is the numeric user id.
 *
 * Identity is mapped by the stable (provider, provider-subject-id) pair —
 * NEVER by email — and provider tokens are used once for identity
 * establishment and not retained (nothing here returns or stores them).
 * No code path trusts client-asserted identity data: the only inputs are
 * the code/verifier, and everything else comes from the provider.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import type { FetchLikeV1 } from "../../ensemble-engine/src/providerAdaptersV1";

export type IdentityProviderNameV1 = "github" | "google" | "apple";

/** The Part 3 authExchange request body. */
export interface AuthExchangeRequestV1 {
  readonly provider: IdentityProviderNameV1;
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  /** OIDC nonce echoed for ID-token validation (required for Google/Apple). */
  readonly nonce?: string;
}

/** The server-established identity — the ONLY thing a validator produces. */
export interface ProviderIdentityV1 {
  readonly provider: IdentityProviderNameV1;
  readonly providerSubjectId: string;
}

/** Typed rejection: the identity could not be established. */
export class IdentityValidationErrorV1 extends Error {
  readonly code = "identityValidationFailed";
  constructor(reason: string) {
    super(reason);
    this.name = "IdentityValidationErrorV1";
  }
}

export interface IdentityValidatorV1 {
  readonly provider: IdentityProviderNameV1;
  /** Exchange + validate server-side; throws IdentityValidationErrorV1. */
  validate(request: AuthExchangeRequestV1): Promise<ProviderIdentityV1>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export interface CreateGitHubIdentityValidatorOptionsV1 {
  readonly fetch: FetchLikeV1;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Default `https://github.com/login/oauth/access_token`. */
  readonly tokenEndpoint?: string;
  /** Default `https://api.github.com/user`. */
  readonly userEndpoint?: string;
}

/** GitHub: server-side code exchange + server-side user-API verification. */
export function createGitHubIdentityValidatorV1(
  options: CreateGitHubIdentityValidatorOptionsV1
): IdentityValidatorV1 {
  const tokenEndpoint = options.tokenEndpoint ?? "https://github.com/login/oauth/access_token";
  const userEndpoint = options.userEndpoint ?? "https://api.github.com/user";
  return {
    provider: "github",
    async validate(request: AuthExchangeRequestV1): Promise<ProviderIdentityV1> {
      const tokenResponse = await options.fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code: request.authorizationCode,
          code_verifier: request.codeVerifier,
          redirect_uri: request.redirectUri,
        }),
      });
      const tokenBody = await tokenResponse.text();
      const tokenParsed = parseJson(tokenBody);
      const accessToken = isRecord(tokenParsed) ? tokenParsed.access_token : undefined;
      if (
        tokenResponse.status < 200 ||
        tokenResponse.status >= 300 ||
        typeof accessToken !== "string" ||
        accessToken.length === 0
      ) {
        throw new IdentityValidationErrorV1("GitHub code exchange failed");
      }
      // Server-side user-API call with the exchanged token; the token is
      // used exactly once here and never retained.
      const userResponse = await options.fetch(userEndpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "ensemble-control-plane",
        },
      });
      const userBody = await userResponse.text();
      const userParsed = parseJson(userBody);
      const id = isRecord(userParsed) ? userParsed.id : undefined;
      if (
        userResponse.status < 200 ||
        userResponse.status >= 300 ||
        typeof id !== "number" ||
        !Number.isInteger(id)
      ) {
        throw new IdentityValidationErrorV1("GitHub user verification failed");
      }
      return { provider: "github", providerSubjectId: String(id) };
    },
  };
}

export interface CreateOidcIdentityValidatorOptionsV1 {
  readonly provider: Extract<IdentityProviderNameV1, "google" | "apple">;
  readonly fetch: FetchLikeV1;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** Expected `iss` claim, exactly. */
  readonly issuer: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * OIDC (Google/Apple): server-side code exchange, then full ID-token
 * validation — RS256 signature against the published JWKS, issuer, audience,
 * expiry, and nonce. Any failed check rejects; nothing is coerced.
 */
export function createOidcIdentityValidatorV1(
  options: CreateOidcIdentityValidatorOptionsV1
): IdentityValidatorV1 {
  const now = options.now ?? ((): Date => new Date());
  return {
    provider: options.provider,
    async validate(request: AuthExchangeRequestV1): Promise<ProviderIdentityV1> {
      if (request.nonce === undefined || request.nonce.length === 0) {
        throw new IdentityValidationErrorV1("OIDC exchange requires the client's nonce");
      }
      const tokenResponse = await options.fetch(options.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: request.authorizationCode,
          code_verifier: request.codeVerifier,
          redirect_uri: request.redirectUri,
          client_id: options.clientId,
          ...(options.clientSecret !== undefined
            ? { client_secret: options.clientSecret }
            : {}),
        }).toString(),
      });
      const tokenBody = await tokenResponse.text();
      const tokenParsed = parseJson(tokenBody);
      const idToken = isRecord(tokenParsed) ? tokenParsed.id_token : undefined;
      if (
        tokenResponse.status < 200 ||
        tokenResponse.status >= 300 ||
        typeof idToken !== "string"
      ) {
        throw new IdentityValidationErrorV1(`${options.provider} code exchange failed`);
      }

      const segments = idToken.split(".");
      if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
        throw new IdentityValidationErrorV1("the ID token is not a well-formed JWT");
      }
      const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];
      const header = parseJson(base64UrlDecode(headerB64).toString("utf8"));
      const payload = parseJson(base64UrlDecode(payloadB64).toString("utf8"));
      if (!isRecord(header) || !isRecord(payload)) {
        throw new IdentityValidationErrorV1("the ID token header/payload did not decode");
      }
      if (header.alg !== "RS256") {
        // Fail-closed on algorithm confusion: only RS256 JWKS keys are used.
        throw new IdentityValidationErrorV1(`unsupported ID-token algorithm ${String(header.alg)}`);
      }

      // Signature against the provider's PUBLISHED JWKS, matched by kid.
      const jwksResponse = await options.fetch(options.jwksUri, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const jwksParsed = parseJson(await jwksResponse.text());
      const keys =
        isRecord(jwksParsed) && Array.isArray(jwksParsed.keys) ? jwksParsed.keys : [];
      const jwk = keys.find(
        (candidate): candidate is Record<string, unknown> =>
          isRecord(candidate) && candidate.kid === header.kid && candidate.kty === "RSA"
      );
      if (jwk === undefined) {
        throw new IdentityValidationErrorV1("no JWKS key matches the ID token's kid");
      }
      let verified = false;
      try {
        const publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
        verified = cryptoVerify(
          "RSA-SHA256",
          Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
          publicKey,
          base64UrlDecode(signatureB64)
        );
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new IdentityValidationErrorV1("the ID token signature did not verify");
      }

      if (payload.iss !== options.issuer) {
        throw new IdentityValidationErrorV1("the ID token issuer does not match");
      }
      const audience = payload.aud;
      const audienceOk = Array.isArray(audience)
        ? audience.includes(options.clientId)
        : audience === options.clientId;
      if (!audienceOk) {
        throw new IdentityValidationErrorV1("the ID token audience does not match");
      }
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= now().getTime()) {
        throw new IdentityValidationErrorV1("the ID token is expired");
      }
      if (payload.nonce !== request.nonce) {
        throw new IdentityValidationErrorV1("the ID token nonce does not match");
      }
      const subject = payload.sub;
      if (typeof subject !== "string" || subject.length === 0) {
        throw new IdentityValidationErrorV1("the ID token carries no subject");
      }
      return { provider: options.provider, providerSubjectId: subject };
    },
  };
}
