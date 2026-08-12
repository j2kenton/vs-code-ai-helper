import { expect, test } from '@playwright/test';

import { mockChatAndGates, seedSignedInSession, setActiveTaskId } from './support/mockControlPlane';

/**
 * Part 9 web smoke: threaded chat turns, an idempotent gate approve flow
 * (confirm → decide → replayed-outcome on a same-key retry), and structured
 * questions rendered from a seeded pending interaction — the signed-in
 * content the signed-out `tabs.smoke.spec.ts` suite cannot reach.
 */
test.describe('Chat and gate control (Part 9)', () => {
  test('renders chat turns and approves a pending gate', async ({ page }) => {
    await page.goto('/');
    await seedSignedInSession(page);
    await setActiveTaskId(page, 'task-1');
    await mockChatAndGates(page, 'task-1', {
      turns: [{ turnId: 't1', role: 'assistant', text: 'Starting round 1 of 3.' }],
      gates: [{ gateId: 'gate-1', state: 'pending', summary: 'Review the proposed diff before applying.' }],
    });

    await page.getByTestId('tab-chat').click();
    await expect(page.getByText('Starting round 1 of 3.')).toBeVisible();
    await expect(page.getByText('Review the proposed diff before applying.')).toBeVisible();

    await page.getByRole('button', { name: 'Approve…' }).click();
    await page.getByRole('button', { name: 'Confirm approve' }).click();

    await expect(page.getByText(/Decision: approved/)).toBeVisible();
    await expect(page.getByText('Gate approved')).toBeVisible();
  });

  test('renders a pending structured-question interaction as an answerable form', async ({ page }) => {
    await page.goto('/');
    await seedSignedInSession(page);
    await setActiveTaskId(page, 'task-1');
    await mockChatAndGates(page, 'task-1', { turns: [], gates: [] });

    await page.getByTestId('tab-chat').click();
    await expect(page.getByText('Task task-1')).toBeVisible();

    await page.evaluate(() => {
      window.__ensembleE2E__?.setPendingQuestions('task-1', {
        interactionId: 'int-1',
        questions: [
          {
            questionId: 'q1',
            kind: 'text',
            prompt: 'What should the commit message say?',
            required: true,
          },
        ],
      });
    });

    await expect(page.getByText('The agent needs answers')).toBeVisible();
    await expect(page.getByText('What should the commit message say?')).toBeVisible();
  });
});
