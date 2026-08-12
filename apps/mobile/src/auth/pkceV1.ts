/**
 * PKCE core for the Part 6 sign-in flow: authorization-code + PKCE in the
 * SYSTEM browser (no implicit flow, no embedded webviews). This module holds
 * the transport-free pieces — verifier/challenge generation and per-provider
 * authorize-URL construction — over an injected crypto source, so the same
 * code runs on web (WebCrypto) and native (the expo-crypto adapter that
 * lands with the dependency-install round alongside the Expo AuthSession
 * browser driver).
 *
 * The client's only secret-bearing output is the (code, codeVerifier) pair
 * sent ONCE to the control plane's `/v1/auth/exchange`; the provider code
 * exchange itself happens server-side (the Part 6 trust boundary), and the
 * client never sees or forwards provider tokens.
 */

export interface PkceCryptoV1 {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

/** WebCrypto-backed source (web target; also modern Node for tests). */
export function createWebCryptoPkceV1(): PkceCryptoV1 {
  return {
    randomBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
      return new Uint8Array(digest);
    },
  };
}

const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 base64url without padding, dependency-free (no Buffer on RN). */
export function base64UrlEncodeV1(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? (bytes[index + 1] as number) : undefined;
    const c = index + 2 < bytes.length ? (bytes[index + 2] as number) : undefined;
    out += BASE64_URL_ALPHABET[a >> 2];
    out += BASE64_URL_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) {
      out += BASE64_URL_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    }
    if (c !== undefined) {
      out += BASE64_URL_ALPHABET[c & 0x3f];
    }
  }
  return out;
}

export interface PkcePairV1 {
  /** Kept client-side until the control-plane exchange call. */
  readonly codeVerifier: string;
  /** S256 challenge sent to the provider's authorize endpoint. */
  readonly codeChallenge: string;
  /** CSRF binding for the redirect. */
  readonly state: string;
  /** OIDC nonce (Google/Apple ID-token validation binds to it server-side). */
  readonly nonce: string;
}

export async function generatePkcePairV1(crypto: PkceCryptoV1): Promise<PkcePairV1> {
  const codeVerifier = base64UrlEncodeV1(crypto.randomBytes(48));
  const challengeBytes = await crypto.sha256(new TextEncoder().encode(codeVerifier));
  return {
    codeVerifier,
    codeChallenge: base64UrlEncodeV1(challengeBytes),
    state: base64UrlEncodeV1(crypto.randomBytes(16)),
    nonce: base64UrlEncodeV1(crypto.randomBytes(16)),
  };
}

export type IdentityProviderV1 = 'github' | 'google' | 'apple';

interface ProviderAuthorizeConfigV1 {
  readonly endpoint: string;
  readonly defaultScope: string;
  /** OIDC providers require the nonce; GitHub is plain OAuth. */
  readonly oidc: boolean;
}

const PROVIDER_AUTHORIZE_V1: Readonly<Record<IdentityProviderV1, ProviderAuthorizeConfigV1>> = {
  github: {
    endpoint: 'https://github.com/login/oauth/authorize',
    defaultScope: 'read:user',
    oidc: false,
  },
  google: {
    endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    defaultScope: 'openid',
    oidc: true,
  },
  apple: {
    endpoint: 'https://appleid.apple.com/auth/authorize',
    defaultScope: 'name',
    oidc: true,
  },
};

export interface BuildAuthorizeUrlOptionsV1 {
  readonly provider: IdentityProviderV1;
  readonly clientId: string;
  /** Custom scheme on native, HTTPS callback on web — registered per platform. */
  readonly redirectUri: string;
  readonly pkce: PkcePairV1;
  readonly scope?: string;
}

export function buildAuthorizeUrlV1(options: BuildAuthorizeUrlOptionsV1): string {
  const config = PROVIDER_AUTHORIZE_V1[options.provider];
  const parameters = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: options.scope ?? config.defaultScope,
    state: options.pkce.state,
    code_challenge: options.pkce.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.oidc) {
    parameters.set('nonce', options.pkce.nonce);
  }
  return `${config.endpoint}?${parameters.toString()}`;
}

/**
 * The platform browser seam: `expoAuthSessionDriverV1.ts` implements this
 * over `expo-auth-session` + the system browser. `createUnavailableAuthBrowserDriverV1`
 * below stays available as an explicit fallback so a caller can report a
 * missing capability with a typed reason instead of failing silently.
 */
export interface AuthBrowserDriverV1 {
  /**
   * Open the authorize URL in the system browser and resolve with the
   * redirect's code + state, or a typed unavailability/cancellation.
   */
  authorize(
    authorizeUrl: string,
    redirectUri: string
  ): Promise<
    | { readonly kind: 'success'; readonly code: string; readonly state: string }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'unavailable'; readonly reason: string }
  >;
}

export function createUnavailableAuthBrowserDriverV1(reason: string): AuthBrowserDriverV1 {
  return {
    authorize: () => Promise.resolve({ kind: 'unavailable', reason }),
  };
}
