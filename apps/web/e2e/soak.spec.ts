import { expect, test } from '@playwright/test';

// Ten minutes with the mock stream at ten events per second. Run with `pnpm --filter @arena/web run test:soak`.
test('@soak the page stays responsive for 10 minutes at 10 events per second', async ({ page }) => {
  test.setTimeout(14 * 60_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __maxLong: number; __longCount: number };
    w.__maxLong = 0;
    w.__longCount = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          w.__longCount++;
          if (e.duration > w.__maxLong) w.__maxLong = e.duration;
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask not supported
    }
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/arena/?lane=core&stream=10');
  await expect(page.locator('#stream-state')).toHaveText('live', { timeout: 20_000 });

  const sample = async () => {
    await page.evaluate(() => (window as unknown as { gc?: () => void }).gc?.());
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const w = window as unknown as { __maxLong: number; __longCount: number };
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return { heap: mem?.usedJSHeapSize ?? 0, maxLong: w.__maxLong, longCount: w.__longCount, rows: document.querySelectorAll('#log-rows .row').length };
    });
  };

  await page.waitForTimeout(2 * 60_000);
  const m2 = await sample();
  await page.waitForTimeout(8 * 60_000);
  const m10 = await sample();
  console.log(`soak: heap at 2 min ${(m2.heap / 1e6).toFixed(1)} MB, at 10 min ${(m10.heap / 1e6).toFixed(1)} MB; longest task ${m10.maxLong.toFixed(0)} ms over ${m10.longCount} long tasks; log rows ${m10.rows}`);
  expect(m10.rows).toBeLessThanOrEqual(200);
  expect(m10.maxLong, 'no main-thread block over 200 ms').toBeLessThan(200);
  expect(m10.heap, 'heap after 10 minutes within 25 percent of minute 2').toBeLessThanOrEqual(m2.heap * 1.25);
  // the page still answers
  await page.getByRole('tab', { name: 'Flow' }).click();
  await expect(page.locator('#population tbody tr').first()).toBeVisible({ timeout: 15_000 });
});
