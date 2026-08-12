/**
 * HttpOnly refresh-token cookie for the web target (plan Part 6): "on web
 * use shorter access-token lifetime with refresh kept server-side via
 * HttpOnly cookie (secure-store's web fallback is not secure storage)".
 *
 * A request signals the web policy with `x-ensemble-platform: web` (a
 * transport hint only — it never establishes or asserts identity, unlike
 * the bearer token). When present, `/v1/auth/exchange` and
 * `/v1/auth/refresh` omit `refreshToken` from the JSON body — so it is
 * never reachable from web JS — and deliver it solely as an HttpOnly,
 * Secure, SameSite=Strict cookie scoped to `/v1/auth`; refresh then reads
 * the token back from the cookie header instead of a body field. Native
 * clients (the default when the header is absent) are unaffected: the
 * refresh token continues to travel in the body only, and no cookie is set.
 */

export const WEB_REFRESH_COOKIE_NAME_V1 = "ensemble_rt";
const WEB_REFRESH_COOKIE_PATH_V1 = "/v1/auth";
/** 30 days: long enough to avoid forcing re-sign-in, rotated on every use. */
export const WEB_REFRESH_COOKIE_MAX_AGE_SECONDS_V1 = 60 * 60 * 24 * 30;

const PLATFORM_HEADER_NAME_V1 = "x-ensemble-platform";

export function isWebPlatformRequestV1(headers: Readonly<Record<string, string>>): boolean {
  return headers[PLATFORM_HEADER_NAME_V1] === "web";
}

/** Minimal `Cookie` request-header parser (name=value pairs, `;`-separated). */
export function parseCookieHeaderV1(header: string | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (header === undefined) {
    return result;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (name.length === 0) {
      continue;
    }
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

export function readWebRefreshCookieV1(
  headers: Readonly<Record<string, string>>
): string | undefined {
  const cookies = parseCookieHeaderV1(headers["cookie"]);
  const value = cookies[WEB_REFRESH_COOKIE_NAME_V1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** `Set-Cookie` header value that plants the refresh token, HttpOnly. */
export function serializeWebRefreshCookieV1(token: string): string {
  return [
    `${WEB_REFRESH_COOKIE_NAME_V1}=${encodeURIComponent(token)}`,
    `Path=${WEB_REFRESH_COOKIE_PATH_V1}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${WEB_REFRESH_COOKIE_MAX_AGE_SECONDS_V1}`,
  ].join("; ");
}

/** `Set-Cookie` header value that clears the refresh cookie (sign-out). */
export function serializeClearedWebRefreshCookieV1(): string {
  return [
    `${WEB_REFRESH_COOKIE_NAME_V1}=`,
    `Path=${WEB_REFRESH_COOKIE_PATH_V1}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}
