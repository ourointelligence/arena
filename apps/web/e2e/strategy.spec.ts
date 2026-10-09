import { expect, test } from '@playwright/test';

test('the strategy page shows code, params, lineage, trades and the share card', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/arena/s/core/s-0012');
  await expect(page.locator('#strategy-page h1')).toHaveText('s-0012');
  // highlighted code, built from DOM nodes
  await expect(page.locator('.code pre code .hljs-keyword').first()).toBeVisible();
  expect(await page.locator('.code pre code').textContent()).toContain('export function decide');
  // params and bounds table
  const rows = page.locator('#params tbody tr');
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  await expect(rows.first().locator('td').nth(2)).not.toHaveText('n/a');
  // parents and children as links
  const parents = page.locator('.links.parents a');
  const children = page.locator('.links.children a');
  expect((await parents.count()) + (await children.count())).toBeGreaterThan(0);
  const anyLink = (await parents.count()) ? parents.first() : children.first();
  await expect(anyLink).toHaveAttribute('href', /\/arena\/s\/core\/s-\d+/);
  // explanation, charts, trades
  await expect(page.locator('#explanation')).not.toBeEmpty();
  await expect(page.locator('#ci-chart svg')).toBeVisible();
  await expect(page.locator('#strategy-equity svg')).toBeVisible();
  expect(await page.locator('#trades tbody tr').count()).toBeGreaterThan(5);
  // share card image and copy button
  const img = page.locator('#share-card');
  await expect(img).toHaveAttribute('src', '/arena/api/og/core/s-0012.png');
  await expect.poll(async () => img.evaluate((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(page.locator('#copy-link')).toBeVisible();
  await page.screenshot({ path: 'screenshots/strategy-1366-light.png', fullPage: true });
  // no page-level horizontal scroll even with a wide trades table
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
});

test('the strategy page works at phone width and for an unknown id', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/arena/s/core/s-0012');
  await expect(page.locator('#strategy-page h1')).toHaveText('s-0012');
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  await page.screenshot({ path: 'screenshots/strategy-390-light.png', fullPage: true });
  await page.goto('/arena/s/core/s-9999');
  await expect(page.locator('.msg')).toContainText('No strategy s-9999');
});

test('direct navigation to a strategy URL is served (SPA fallback)', async ({ page }) => {
  const res = await page.goto('/arena/s/flow/s-0003');
  expect(res?.status()).toBe(200);
  await expect(page.locator('#strategy-page h1')).toHaveText('s-0003');
});
