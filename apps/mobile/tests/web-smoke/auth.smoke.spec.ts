import { expect, test } from '@playwright/test';

import { installFakeAuthBrowserDriver, mockAuthExchange } from './support/mockControlPlane';

/**
 * Part 6 web smoke: the AuthSession redirect flow and web session-token
 * handling. Playwright cannot drive a real identity provider through a live
 * redirect, so the system-browser driver is substituted with a fake that
 * reads `state` straight back off the authorize URL it is given (the same
 * CSRF-binding check the real flow performs still runs) and resolves with a
 * fixed authorization code — exercising PKCE construction, the "redirect",
 * and the server-side exchange call exactly as the real driver would hand
 * off, without trusting anything the client asserts about identity.
 */
test.describe('Auth redirect flow (Part 6)', () => {
  test('completes sign-in through the fake browser driver and the exchange endpoint', async ({ page }) => {
    await page.goto('/');
    await installFakeAuthBrowserDriver(page, 'e2e-auth-code');
    await mockAuthExchange(page, { expectedCode: 'e2e-auth-code' });

    await page.getByTestId('tab-settings').click();
    await expect(page.getByText(/Sign in with your identity provider/)).toBeVisible();

    await page.getByRole('button', { name: 'GitHub' }).click();

    await expect(page.getByText('Signed in to the control plane.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('rejects an exchange whose code does not match what the driver returned', async ({ page }) => {
    await page.goto('/');
    await installFakeAuthBrowserDriver(page, 'e2e-auth-code');
    // The mock only accepts a different code, so the client's real code is
    // rejected server-side — proving the client can't forge its way in and
    // that a failed exchange surfaces the typed error instead of a silent
    // signed-in state.
    await mockAuthExchange(page, { expectedCode: 'some-other-code' });

    await page.getByTestId('tab-settings').click();
    await page.getByRole('button', { name: 'GitHub' }).click();

    await expect(page.getByText(/Sign-in failed/)).toBeVisible();
    await expect(page.getByText('Signed in to the control plane.')).not.toBeVisible();
  });

  test('web sign-out revokes the session and returns to the signed-out state', async ({ page }) => {
    await page.goto('/');
    await installFakeAuthBrowserDriver(page, 'e2e-auth-code');
    await mockAuthExchange(page, { expectedCode: 'e2e-auth-code' });

    let revokeCalled = false;
    await page.route('https://control-plane.invalid/v1/auth/revoke', async (route) => {
      revokeCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.getByTestId('tab-settings').click();
    await page.getByRole('button', { name: 'GitHub' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByText(/Sign in with your identity provider/)).toBeVisible();
    expect(revokeCalled).toBe(true);
  });
});
