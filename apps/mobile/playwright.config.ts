import { defineConfig, devices } from '@playwright/test';

/**
 * Web smoke suite (plan Parts 6–10): drives the app under `react-native-web`
 * in a real browser to prove each tab renders and its primary interactions
 * work, independent of the per-screen unit tests in `tests/*.test.ts`.
 *
 * `tabs.smoke.spec.ts` runs fully signed-out — every screen's signed-out
 * empty state — proving the RootTabs shell, theme, and primitives render
 * correctly under react-native-web without any network mocking. The other
 * specs reach signed-in screens via the `__ensembleE2E__` test hook (see
 * `src/testing/e2eHooksV1.ts`), which installs a real session through the
 * app's own session manager — the same code path a completed PKCE exchange
 * uses — then drive `/v1/*` calls through `page.route` mocks matching the
 * Part 3 contract shapes, so what's under test is the real UI wired to a
 * fake control plane, not a UI stub.
 */
export default defineConfig({
  testDir: './tests/web-smoke',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8081',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx expo start --web --port 8081',
    url: 'http://127.0.0.1:8081',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { CI: '1', EXPO_PUBLIC_E2E_TEST_HOOKS: '1' },
  },
});
