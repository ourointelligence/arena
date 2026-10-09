// Takes viewport-sized screenshots of key regions for manual inspection. Run with: pnpm exec tsx e2e/inspect.ts
// Expects the mock API on 8788 and `pnpm preview` on 4173.
import { chromium } from '@playwright/test';

const base = 'http://127.0.0.1:4173';
const browser = await chromium.launch();
for (const theme of ['light', 'dark'] as const) {
  for (const [w, h] of [
    [1366, 768],
    [390, 844],
  ] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('ouro-theme', t), theme);
    const page = await ctx.newPage();
    await page.goto(`${base}/arena/`);
    await page.waitForSelector('#population tbody tr');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `screenshots/fold-${w}-${theme}.png` });
    if (w === 1366) {
      await page.locator('#log').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `screenshots/log-${w}-${theme}.png` });
      await page.locator('#switch').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `screenshots/switch-${w}-${theme}.png` });
    }
    await ctx.close();
  }
}
await browser.close();
console.log('done');
