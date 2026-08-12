/**
 * The Expo AuthSession system-browser driver (plan Part 6): opens the
 * already-built authorize URL — PKCE challenge, state, and nonce are ours,
 * generated in pkceV1.ts before this driver is ever invoked — in the system
 * browser via `expo-auth-session`, which delegates to `expo-web-browser`'s
 * `openAuthSessionAsync` (native: an ephemeral browser session; web:
 * `window.open`). No implicit flow, no embedded webviews. `usePKCE: false`
 * so `AuthRequest` never generates a second, unused PKCE pair of its own —
 * the pair the provider actually sees is the one `buildAuthorizeUrlV1`
 * already embedded in `authorizeUrl`. `state` is likewise taken from that
 * same URL (see `extractStateFromAuthorizeUrlV1`) rather than left for
 * `AuthRequest` to generate its own — `AuthRequest`'s `parseReturnUrl` CSRF
 * guard compares the provider-echoed state against ITS OWN `state`, so a
 * mismatched/random internal state would fail every real redirect.
 */
import { AuthRequest } from 'expo-auth-session';

import { extractStateFromAuthorizeUrlV1, mapAuthSessionResultV1 } from './authSessionOutcomeV1';
import type { AuthBrowserDriverV1 } from './pkceV1';

export function createExpoAuthSessionBrowserDriverV1(): AuthBrowserDriverV1 {
  return {
    async authorize(authorizeUrl, redirectUri) {
      const request = new AuthRequest({
        clientId: 'ensemble-mobile',
        redirectUri,
        usePKCE: false,
        state: extractStateFromAuthorizeUrlV1(authorizeUrl),
      });
      const result = await request.promptAsync(
        { authorizationEndpoint: authorizeUrl },
        { url: authorizeUrl }
      );
      return mapAuthSessionResultV1(result);
    },
  };
}
