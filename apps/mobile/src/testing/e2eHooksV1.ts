/**
 * Test-only browser hooks (Parts 6-10 web smoke). Playwright drives the real
 * app under `react-native-web`, but it cannot complete a live OAuth redirect
 * against a real identity provider, so screens that require a signed-in
 * session are otherwise unreachable from an E2E test. This module exposes a
 * narrow seam — install a session directly through the real session manager
 * (the same code path `completeSignIn` uses after a real PKCE exchange) and
 * set the active task — so tests can reach signed-in screens and then drive
 * every subsequent interaction through the real UI and a mocked network
 * layer (`page.route`).
 *
 * Gated behind `EXPO_PUBLIC_E2E_TEST_HOOKS`, an Expo public env var inlined
 * at bundle time: unset (the default, including every production build), it
 * is dead code that never touches `window`. Playwright's webServer sets it
 * to `'1'` only for the local dev server the test suite drives.
 */
import { configureAppServicesTestOverridesV1, getAppServicesV1 } from '../services/appServicesV1';
import type { AuthBrowserDriverV1, IdentityProviderV1 } from '../auth/pkceV1';
import { useAppStore, type PendingQuestionsV1 } from '../state/appStore';
import type { FeedEntryV1 } from '../events/notificationFeedV1';

export interface E2ETestHooksV1 {
  seedSignedInSession(
    controlPlaneUrl: string,
    accessToken: string,
    accessTokenExpiresAt: string
  ): Promise<void>;
  /**
   * Substitutes a fake `AuthBrowserDriverV1` for the real system-browser
   * driver (Part 6 smoke): the fake reads `state` straight back off the
   * authorize URL it was asked to open, so the PKCE CSRF check still binds
   * correctly, and resolves with a fixed authorization code — exercising
   * the full PKCE-build -> "redirect" -> control-plane-exchange path
   * without a live identity provider, which Playwright cannot drive.
   */
  installFakeAuthBrowserDriver(fixedCode: string): void;
  setActiveTaskId(taskId: string | null): void;
  setActiveGateId(gateId: string | null): void;
  /**
   * Appends feed entries directly (Part 8 smoke): the real feed is fed by
   * the `/v1/events` WebSocket, which Playwright's `page.route` cannot mock
   * (it intercepts HTTP, not WS upgrades) — this exercises the same
   * `appendFeedEntry` store path the WS handler uses, just without a live
   * socket.
   */
  appendFeedEntries(entries: readonly FeedEntryV1[]): void;
  /**
   * Sets a pending structured-question interaction (Part 9 smoke): the real
   * interaction arrives over the same unmockable `/v1/events` WS, so this
   * exercises the same `setPendingQuestions` store path directly.
   */
  setPendingQuestions(taskId: string, pending: PendingQuestionsV1): void;
}

declare global {
  interface Window {
    __ensembleE2E__?: E2ETestHooksV1;
  }
}

const hooks: E2ETestHooksV1 = {
  async seedSignedInSession(controlPlaneUrl, accessToken, accessTokenExpiresAt) {
    const services = getAppServicesV1(controlPlaneUrl);
    useAppStore.getState().setControlPlaneUrl(controlPlaneUrl);
    await services.session.completeSignIn({ accessToken, accessTokenExpiresAt });
  },
  setActiveTaskId(taskId) {
    useAppStore.getState().setActiveTaskId(taskId);
  },
  setActiveGateId(gateId) {
    useAppStore.getState().setActiveGateId(gateId);
  },
  appendFeedEntries(entries) {
    const store = useAppStore.getState();
    for (const entry of entries) {
      store.appendFeedEntry(entry);
    }
  },
  setPendingQuestions(taskId, pending) {
    useAppStore.getState().setPendingQuestions(taskId, pending);
  },
  installFakeAuthBrowserDriver(fixedCode) {
    const fakeDriver: AuthBrowserDriverV1 = {
      authorize(authorizeUrl) {
        const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
        return Promise.resolve({ kind: 'success', code: fixedCode, state });
      },
    };
    const oauthClientIds: Partial<Record<IdentityProviderV1, string>> = {
      github: 'e2e-github-client',
      google: 'e2e-google-client',
    };
    configureAppServicesTestOverridesV1({ browserDriver: fakeDriver, oauthClientIds });
  },
};

export function installE2ETestHooksV1(): void {
  if (process.env.EXPO_PUBLIC_E2E_TEST_HOOKS !== '1') {
    return;
  }
  if (typeof window === 'undefined') {
    return;
  }
  window.__ensembleE2E__ = hooks;
}
