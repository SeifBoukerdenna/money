import { expect, test } from '@playwright/test';

test('overview page renders mode banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Execution Mode')).toBeVisible();
  await expect(page.getByText('Polymarket Copy Trader')).toBeVisible();
});
