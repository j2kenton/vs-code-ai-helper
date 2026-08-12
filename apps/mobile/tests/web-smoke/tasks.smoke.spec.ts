import { expect, test } from '@playwright/test';

import { mockListTasks, seedSignedInSession } from './support/mockControlPlane';

/**
 * Part 7 web smoke: the signed-in task list, detail navigation, and the
 * creation form's SandboxBinding validation error surfacing — the flows the
 * signed-out `tabs.smoke.spec.ts` suite cannot reach.
 */
test.describe('Tasks (Part 7)', () => {
  test('lists a task by display name with N/M progress and opens its detail', async ({ page }) => {
    await page.goto('/');
    // Tasks is the app's default tab: its list-fetch effect fires the
    // instant `seedSignedInSession` flips the session, so the route mock
    // MUST be registered first or that first fetch races past it.
    await mockListTasks(page, [
      { taskId: 'task-1', displayName: 'Ship the mobile app', currentStage: 'implementing' },
    ]);
    await seedSignedInSession(page);

    await page.getByTestId('tab-tasks').click();
    await expect(page.getByText('Ship the mobile app')).toBeVisible();
    await expect(page.getByText(/Stage: implementing.*2\/3 parts/)).toBeVisible();

    await page.getByRole('button', { name: 'Open' }).click();
    // Title/Heading render as plain <Text> (no accessibilityRole="heading"
    // in primitives.tsx), so this asserts by text rather than ARIA role.
    await expect(page.getByText('Round history')).toBeVisible();
    await expect(page.getByText(/Sandbox binding: task-1-binding/)).toBeVisible();
  });

  test('falls back to a humanized name when displayName is absent', async ({ page }) => {
    await page.goto('/');
    await mockListTasks(page, [{ taskId: 'task_folder_42', currentStage: 'planning' }]);
    await seedSignedInSession(page);

    await page.getByTestId('tab-tasks').click();
    await expect(page.getByText('Task folder 42')).toBeVisible();
    await expect(page.getByText('task_folder_42')).not.toBeVisible();
  });

  test('surfaces the typed sandbox-binding validation error on an invalid creation form', async ({ page }) => {
    await page.goto('/');
    await mockListTasks(page, []);
    await seedSignedInSession(page);

    await page.getByTestId('tab-tasks').click();
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByPlaceholder('What should Ensemble do?').fill('Refactor the auth module');
    // The sandbox id only exists when attaching a workspace you already own —
    // a task-owned sandbox is created by the control plane, so there is no id
    // to type and nothing to get wrong. Switch modes to reach the field.
    await page.getByRole('radio', { name: 'Attach mine' }).click();
    // Sentinel sandboxId the mock's server-side handler rejects (see
    // mockControlPlane.ts) — the form's own client-side check only blocks
    // an EMPTY sandboxId, so this reaches the contract's typed error path.
    await page.getByPlaceholder('Existing sandbox / workspace id').fill('reject-me');
    await page.getByRole('button', { name: 'Create task' }).click();

    await expect(page.getByText(/sandboxBindingInvalid/)).toBeVisible();
  });
});
