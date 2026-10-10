// Screenshots and basic checks against the live page. Not part of the test suite:
//   pnpm --filter @arena/web exec tsx e2e/live.ts [https://ourosi.xyz/arena/]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'https://ourosi.xyz/arena/';
const out = path.resolve('screenshots');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let ok = true;
for (const [w, h] of [
  [1366, 768],
  [390, 844],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const t0 = Date.now();
  const res = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  const status = res?.status();
  const ms = Date.now() - t0;
  await page.waitForTimeout(3000);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const innerW = await page.evaluate(() => window.innerWidth);
  const h1 = await page.locator('h1').first().textContent();
  const canvasVisible = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    const r = c.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.width > 0;
  });
  const file = path.join(out, `live-${w}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const line = `${w}x${h}: status ${status}, load ${ms} ms, h1 "${h1?.trim()}", overflow ${scrollW > innerW ? 'YES' : 'no'}, tree in viewport ${canvasVisible}, screenshot ${file}`;
  console.log(line);
  for (const e of errors) console.log(`  console error: ${e}`);
  if (status !== 200 || scrollW > innerW || errors.length > 0) ok = false;
  await page.close();
}
await browser.close();
process.exit(ok ? 0 : 1);
