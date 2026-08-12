import { expect, test } from '@playwright/test';

import { mockFilesAndDiff, seedSignedInSession, setActiveTaskId } from './support/mockControlPlane';

/**
 * Part 10 web smoke: read-only directory browsing into a file view, the
 * wrap toggle, and the unified-diff view — the signed-in content the
 * signed-out `tabs.smoke.spec.ts` suite cannot reach.
 */
test.describe('Files and diff viewer (Part 10)', () => {
  test('browses into a file and renders its content read-only', async ({ page }) => {
    await page.goto('/');
    await seedSignedInSession(page);
    await setActiveTaskId(page, 'task-1');
    await mockFilesAndDiff(page, 'task-1', {
      root: [{ name: 'README.md', kind: 'file' }],
      // Client paths are binding-root-relative with no leading slash (the
      // root itself is `.`, per pathBrowserV1.ts's ROOT_PATH_V1).
      files: [{ path: 'README.md', text: '# Hello\n\nA read-only file.', language: 'markdown' }],
      diff: '',
    });

    await page.getByTestId('tab-files').click();
    await expect(page.getByText('📄 README.md')).toBeVisible();

    await page.getByRole('button', { name: '📄 README.md' }).click();
    await expect(page.getByText('# Hello')).toBeVisible();
    await expect(page.getByText('A read-only file.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wrap: off' })).toBeVisible();
  });

  test('renders a unified diff for review before gate approval', async ({ page }) => {
    await page.goto('/');
    await seedSignedInSession(page);
    await setActiveTaskId(page, 'task-1');
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      ' unchanged',
    ].join('\n');
    await mockFilesAndDiff(page, 'task-1', { root: [], files: [], diff });

    await page.getByTestId('tab-files').click();
    await page.getByRole('button', { name: 'Pending diff' }).click();

    await expect(page.getByText('+new line')).toBeVisible();
    await expect(page.getByText('-old line')).toBeVisible();
  });
});
