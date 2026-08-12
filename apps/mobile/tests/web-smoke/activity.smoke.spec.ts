import { expect, test } from '@playwright/test';

import { seedSignedInSession } from './support/mockControlPlane';

/**
 * Part 8 web smoke: the signed-in activity feed itself (entries, per-task
 * filtering, the gate deep link into Chat) — the WS-fed content the
 * signed-out `tabs.smoke.spec.ts` suite cannot reach. Entries are seeded via
 * `appendFeedEntries` (the same `appendFeedEntry` store path the real
 * `/v1/events` WS handler uses) since Playwright's `page.route` only
 * intercepts HTTP, not the WS upgrade the live stream needs.
 */
test.describe('Activity (Part 8)', () => {
  test('renders fed entries and deep-links a gate request into Chat', async ({ page }) => {
    await page.goto('/');
    await seedSignedInSession(page);

    await page.getByTestId('tab-activity').click();
    await expect(page.getByText('Stream: disconnected')).toBeVisible();

    await page.evaluate(() => {
      window.__ensembleE2E__?.appendFeedEntries([
        {
          id: 'feed-1',
          at: new Date().toISOString(),
          kind: 'agentLifecycle',
          title: 'Agent run started',
          taskId: 'task-1',
        },
        {
          id: 'feed-2',
          at: new Date().toISOString(),
          kind: 'gateRequested',
          title: 'Gate awaiting review',
          detail: 'Approve the proposed diff to resume.',
          taskId: 'task-1',
          gateId: 'gate-1',
        },
      ]);
    });

    await expect(page.getByText('Agent run started')).toBeVisible();
    await expect(page.getByText('Gate awaiting review')).toBeVisible();

    await page.getByRole('button', { name: 'Open gate' }).click();
    await expect(page.getByText('No task selected')).not.toBeVisible();
  });

  test('filters the feed to only the active task', async ({ page }) => {
    await page.goto('/');
    await seedSignedInSession(page);
    await page.evaluate(() => window.__ensembleE2E__?.setActiveTaskId('task-1'));

    await page.getByTestId('tab-activity').click();
    await page.evaluate(() => {
      window.__ensembleE2E__?.appendFeedEntries([
        { id: 'feed-1', at: new Date().toISOString(), kind: 'agentLifecycle', title: 'Task one event', taskId: 'task-1' },
        { id: 'feed-2', at: new Date().toISOString(), kind: 'agentLifecycle', title: 'Task two event', taskId: 'task-2' },
      ]);
    });

    await expect(page.getByText('Task one event')).toBeVisible();
    await expect(page.getByText('Task two event')).toBeVisible();

    await page.getByRole('radio', { name: 'Active task' }).click();
    await expect(page.getByText('Task one event')).toBeVisible();
    await expect(page.getByText('Task two event')).not.toBeVisible();
  });
});
