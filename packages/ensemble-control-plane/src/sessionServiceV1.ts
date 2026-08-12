/**
 * Control-plane session credentials (plan Parts 5/6).
 *
 * After the trust boundary establishes identity (identityValidatorsV1), the
 * control plane issues its OWN session credential — the contract's ONLY
 * security scheme:
 *
 * - a SHORT-LIVED access token (default 15 minutes) plus a ROTATING refresh
 *   token in a token family;
 * - refresh rotates the token: the old refresh is marked `rotated` and a
 *   successor issued in the same family;
 * - REUSE DETECTION: presenting an already-rotated refresh token revokes the
 *   whole family (every refresh and access token in it) — the typed
 *   `refreshTokenReused` outcome;
 * - sign-out explicitly revokes the family.
 *
 * Tokens are opaque CSPRNG values; the store persists ONLY their SHA-256
 * hashes, so the serialized document never contains a usable credential.
 * `authenticate` is what every handler and WS subscription resolves the
 * caller against — no server component ever accepts client-asserted
 * identity.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  AccessTokenRecordV1,
  ControlPlaneStoreV1,
  RefreshFamilyRecordV1,
  RefreshTokenRecordV1,
} from "./storeV1";
import {
  AuthExchangeRequestV1,
  IdentityProviderNameV1,
  IdentityValidationErrorV1,
  IdentityValidatorV1,
} from "./identityValidatorsV1";

/** The Part 3 SessionTokens response body. */
export interface SessionTokensV1 {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
}

export type SessionExchangeResultV1 =
  | { readonly ok: true; readonly userId: string; readonly tokens: SessionTokensV1 }
  | { readonly ok: false; readonly code: "identityValidationFailed"; readonly reason: string };

export type SessionRefreshResultV1 =
  | { readonly ok: true; readonly tokens: SessionTokensV1 }
  | {
      readonly ok: false;
      readonly code: "refreshTokenInvalid" | "refreshTokenReused";
      readonly reason: string;
    };

export interface SessionServiceV1 {
  /** Establish identity via the provider validator and issue a session. */
  exchange(request: AuthExchangeRequestV1): Promise<SessionExchangeResultV1>;
  /** Rotate the refresh token; reuse of a rotated token revokes the family. */
  refresh(refreshToken: string): Promise<SessionRefreshResultV1>;
  /** Sign-out: revoke the presenting session's whole family. */
  revokeByAccessToken(accessToken: string): Promise<boolean>;
  /** Resolve a bearer access token to its user; undefined = not authorized. */
  authenticate(accessToken: string): Promise<{ readonly userId: string } | undefined>;
}

export interface CreateSessionServiceOptionsV1 {
  readonly store: ControlPlaneStoreV1;
  readonly validators: readonly IdentityValidatorV1[];
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Access-token lifetime; default 15 minutes (short-lived by design). */
  readonly accessTtlMs?: number;
}

const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1000;

export function hashSessionTokenV1(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function createSessionServiceV1(options: CreateSessionServiceOptionsV1): SessionServiceV1 {
  const { store } = options;
  const now = options.now ?? ((): Date => new Date());
  const accessTtlMs = options.accessTtlMs ?? DEFAULT_ACCESS_TTL_MS;
  const validators = new Map<IdentityProviderNameV1, IdentityValidatorV1>(
    options.validators.map((validator) => [validator.provider, validator])
  );

  function issueTokens(
    userId: string,
    familyId: string
  ): {
    readonly tokens: SessionTokensV1;
    readonly refresh: RefreshTokenRecordV1;
    readonly access: AccessTokenRecordV1;
  } {
    const at = now();
    const accessToken = newOpaqueToken("cpat");
    const refreshToken = newOpaqueToken("cprt");
    const expiresAt = new Date(at.getTime() + accessTtlMs).toISOString();
    return {
      tokens: { accessToken, accessTokenExpiresAt: expiresAt, refreshToken },
      refresh: {
        tokenHash: hashSessionTokenV1(refreshToken),
        familyId,
        userId,
        createdAt: at.toISOString(),
        status: "active",
      },
      access: {
        tokenHash: hashSessionTokenV1(accessToken),
        familyId,
        userId,
        expiresAt,
      },
    };
  }

  return {
    async exchange(request: AuthExchangeRequestV1): Promise<SessionExchangeResultV1> {
      const validator = validators.get(request.provider);
      if (validator === undefined) {
        return {
          ok: false,
          code: "identityValidationFailed",
          reason: `no identity validator is configured for ${String(request.provider)}`,
        };
      }
      let identity;
      try {
        identity = await validator.validate(request);
      } catch (error) {
        const reason =
          error instanceof IdentityValidationErrorV1
            ? error.message
            : "identity validation failed";
        return { ok: false, code: "identityValidationFailed", reason };
      }
      const user = store.upsertUserByIdentity(identity.provider, identity.providerSubjectId);
      const familyId = randomBytes(16).toString("hex");
      const family: RefreshFamilyRecordV1 = {
        familyId,
        userId: user.userId,
        createdAt: now().toISOString(),
      };
      const issued = issueTokens(user.userId, familyId);
      store.createSessionFamily(family, issued.refresh, issued.access);
      return { ok: true, userId: user.userId, tokens: issued.tokens };
    },

    async refresh(refreshToken: string): Promise<SessionRefreshResultV1> {
      const record = store.findRefreshTokenByHash(hashSessionTokenV1(refreshToken));
      if (record === undefined) {
        return {
          ok: false,
          code: "refreshTokenInvalid",
          reason: "the refresh token is not recognized",
        };
      }
      const family = store.readFamily(record.familyId);
      if (family === undefined || family.revokedAt !== undefined || record.status === "revoked") {
        return {
          ok: false,
          code: "refreshTokenInvalid",
          reason: "the refresh token's family is revoked",
        };
      }
      if (record.status === "rotated") {
        // REUSE: the token was already rotated away — someone is replaying
        // it. Revoke the entire family, fail-closed.
        store.revokeSessionFamily(record.familyId, now().toISOString());
        return {
          ok: false,
          code: "refreshTokenReused",
          reason: "refresh-token reuse detected; the token family is revoked",
        };
      }
      const issued = issueTokens(record.userId, record.familyId);
      store.rotateRefreshToken(record.tokenHash, issued.refresh, issued.access);
      return { ok: true, tokens: issued.tokens };
    },

    async revokeByAccessToken(accessToken: string): Promise<boolean> {
      const record = store.findAccessTokenByHash(hashSessionTokenV1(accessToken));
      if (record === undefined) {
        return false;
      }
      store.revokeSessionFamily(record.familyId, now().toISOString());
      return true;
    },

    async authenticate(accessToken: string): Promise<{ readonly userId: string } | undefined> {
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        return undefined;
      }
      const record = store.findAccessTokenByHash(hashSessionTokenV1(accessToken));
      if (record === undefined || record.revokedAt !== undefined) {
        return undefined;
      }
      if (new Date(record.expiresAt).getTime() <= now().getTime()) {
        return undefined;
      }
      const family = store.readFamily(record.familyId);
      if (family === undefined || family.revokedAt !== undefined) {
        return undefined;
      }
      return { userId: record.userId };
    },
  };
}
