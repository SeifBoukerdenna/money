import { expect, test } from '@playwright/test';

test('overview page renders mode banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Track real Polymarket wallets' })).toBeVisible();
  await expect(
    page.getByText('Paste a profile URL or wallet address to start ingesting real trade activity.'),
  ).toBeVisible();
});
