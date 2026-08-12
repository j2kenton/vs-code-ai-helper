import { expect, test } from '@playwright/test';

/**
 * Web smoke suite (plan Parts 6-10): proves every tab renders under
 * `react-native-web` and its primary interactions work in a real browser.
 *
 * Runs signed-out, with no control-plane mock backend. Every screen defines
 * a signed-out empty state (see `src/screens/*.tsx`), so navigating the full
 * tab shell and exercising the Settings screen's non-network interactions
 * (theme, sandbox provider, gate policy, control-plane URL field) proves the
 * RootTabs shell, theme system, and touch-first primitives all work under
 * react-native-web without needing a fake backend.
 *
 * NOT covered here (left for a follow-up round, see plan-final.md):
 * - The AuthSession OAuth redirect round trip (Part 6) — requires mocking
 *   the browser-driver seam or an OAuth test provider.
 * - Signed-in flows (task creation, chat/gate control, file/diff viewing)
 *   — require a mock control-plane backend.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tab-tasks')).toBeVisible();
});

test('Tasks tab shows the signed-out empty state', async ({ page }) => {
  await expect(page.getByText('Sign in to manage tasks')).toBeVisible();
});

test('Activity tab shows the signed-out empty state', async ({ page }) => {
  await page.getByTestId('tab-activity').click();
  await expect(page.getByText('Sign in to follow activity')).toBeVisible();
});

test('Chat tab shows the signed-out empty state', async ({ page }) => {
  await page.getByTestId('tab-chat').click();
  await expect(page.getByText('Sign in to chat')).toBeVisible();
});

test('Files tab shows the signed-out empty state', async ({ page }) => {
  await page.getByTestId('tab-files').click();
  await expect(page.getByText('Sign in to browse files')).toBeVisible();
});

test('Settings tab renders sign-in options and the BYOS controls', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  await expect(page.getByText('Sign in with your identity provider.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'E2B' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Daytona' })).toBeVisible();
  await expect(page.getByPlaceholder('https://control-plane.example.com')).toBeVisible();
});

test('Settings sandbox provider selection toggles between E2B and Daytona', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  const e2b = page.getByRole('radio', { name: 'E2B' });
  const daytona = page.getByRole('radio', { name: 'Daytona' });

  // The selection is now an ARIA state rather than a colour, so this asserts
  // WHICH provider is selected — previously it could only check that both
  // options were still visible and clickable after a change.
  await expect(e2b).toBeChecked();
  await expect(daytona).not.toBeChecked();

  await daytona.click();
  await expect(daytona).toBeChecked();
  await expect(e2b).not.toBeChecked();

  await e2b.click();
  await expect(e2b).toBeChecked();
});

test('Settings gate policy toggle flips its state without a network dependency', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  // Same segmented control as the provider and theme pickers: the choice is
  // visible as a selected option rather than a caption that mutates.
  const required = page.getByRole('radio', { name: 'Required' });
  const optional = page.getByRole('radio', { name: 'Optional' });
  await expect(required).toBeChecked();
  await optional.click();
  await expect(optional).toBeChecked();
  await expect(required).not.toBeChecked();
  await required.click();
  await expect(required).toBeChecked();
});

test('Settings appearance theme selector switches themes', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  await page.getByRole('radio', { name: 'dark' }).click();
  await expect(page.getByRole('radio', { name: 'dark' })).toBeChecked();
  await page.getByRole('radio', { name: 'light' }).click();
  await expect(page.getByRole('radio', { name: 'light' })).toBeChecked();
  await page.getByRole('radio', { name: 'system' }).click();
  await expect(page.getByRole('radio', { name: 'system' })).toBeChecked();
});

test('all five tabs are reachable in one pass', async ({ page }) => {
  for (const tab of ['tab-activity', 'tab-chat', 'tab-files', 'tab-settings', 'tab-tasks']) {
    await page.getByTestId(tab).click();
  }
  await expect(page.getByText('Sign in to manage tasks')).toBeVisible();
});
