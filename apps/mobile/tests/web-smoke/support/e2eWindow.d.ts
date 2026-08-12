/**
 * Ambient shape of the `window.__ensembleE2E__` test hook (see
 * `src/testing/e2eHooksV1.ts`), declared standalone here rather than
 * imported from `src/testing` — that module pulls in `appServicesV1`
 * (react-native, expo-auth-session, ...), which the test tsconfig
 * deliberately keeps out of its compile unit. Loosely typed on purpose:
 * this file exists only so `page.evaluate` call sites type-check, not to
 * re-derive the app's real payload types.
 */
export {};

declare global {
  interface Window {
    __ensembleE2E__?: {
      seedSignedInSession(
        controlPlaneUrl: string,
        accessToken: string,
        accessTokenExpiresAt: string
      ): Promise<void>;
      setActiveTaskId(taskId: string | null): void;
      setActiveGateId(gateId: string | null): void;
      appendFeedEntries(entries: readonly unknown[]): void;
      setPendingQuestions(taskId: string, pending: unknown): void;
      installFakeAuthBrowserDriver(fixedCode: string): void;
    };
  }
}
