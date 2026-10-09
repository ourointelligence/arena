import { expect, test, type Page } from '@playwright/test';

const WIDTHS: Array<{ w: number; h: number }> = [
  { w: 1440, h: 900 },
  { w: 1366, h: 768 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'] as const;

async function openArena(page: Page, theme: 'light' | 'dark', w: number, h: number): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('ouro-theme', t);
    } catch {
      // ignore
    }
  }, theme);
  await page.setViewportSize({ width: w, height: h });
  await page.goto('/arena/');
  await expect(page.locator('#state')).not.toHaveText('loading');
  await expect(page.locator('#population tbody tr').first()).toBeVisible();
  await expect(page.locator('#takeoff-chart svg')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const { w, h } of WIDTHS) {
  for (const theme of THEMES) {
    test(`renders at ${w}x${h} in ${theme} without overflow or overlapping headings`, async ({ page }) => {
      await openArena(page, theme, w, h);
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(overflow.scroll, `page scrollWidth ${overflow.scroll} must not exceed innerWidth ${overflow.inner}`).toBeLessThanOrEqual(overflow.inner);
      const overlaps = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('h1, h2, h3'))
          .map((e) => ({ t: (e.textContent ?? '').trim().slice(0, 40), r: e.getBoundingClientRect() }))
          .filter((b) => b.r.width > 0 && b.r.height > 0);
        const bad: string[] = [];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!.r;
            const b = boxes[j]!.r;
            const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > 1 && y > 1) bad.push(`${boxes[i]!.t} / ${boxes[j]!.t}`);
          }
        }
        return bad;
      });
      expect(overlaps, 'headings must not overlap').toEqual([]);
      const tables = await page.evaluate(() => Array.from(document.querySelectorAll('.tablewrap')).map((t) => ({ scroll: t.scrollWidth, client: t.clientWidth, canScroll: getComputedStyle(t).overflowX })));
      for (const t of tables) if (t.scroll > t.client) expect(t.canScroll).toBe('auto');
      await page.screenshot({ path: `screenshots/arena-${w}-${theme}.png`, fullPage: true });
    });
  }
}

test('the family tree is visible above the fold at 1366x768', async ({ page }) => {
  await openArena(page, 'light', 1366, 768);
  const box = await page.locator('#tree canvas').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(768);
  expect(box!.y + box!.height).toBeGreaterThan(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const visible = await page.evaluate(() => {
    const r = document.querySelector('#tree canvas')!.getBoundingClientRect();
    return Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  });
  expect(visible).toBeGreaterThan(250);
});

test('lane tabs switch the lane and the status pill follows', async ({ page }) => {
  await openArena(page, 'light', 1366, 768);
  await expect(page.locator('#state')).toHaveText('running');
  await page.getByRole('tab', { name: 'Alts' }).click();
  await expect(page.locator('#state')).toHaveText('paused');
  await expect(page).toHaveURL(/lane=alts/);
  await expect(page.locator('#population tbody tr').first()).toBeVisible();
});

test('the event stream goes live and the thought log keeps growing but stays capped', async ({ page }) => {
  await openArena(page, 'dark', 1440, 900);
  await expect(page.locator('#stream-state')).toHaveText('live', { timeout: 20_000 });
  const before = await page.locator('#log-rows .row').count();
  await page.waitForTimeout(3500);
  const after = await page.locator('#log-rows .row').count();
  expect(after).toBeGreaterThan(before);
  expect(after).toBeLessThanOrEqual(200);
});

test('clicking a population row opens the strategy page without a reload', async ({ page }) => {
  await openArena(page, 'light', 1366, 768);
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42));
  await page.locator('#population tbody tr td.id a').first().click();
  await expect(page.locator('#strategy-page')).toBeVisible();
  await expect(page).toHaveURL(/\/arena\/s\/core\/s-\d+/);
  expect(await page.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(42);
});

test('model text is rendered as text, never as markup', async ({ page }) => {
  await openArena(page, 'light', 1366, 768);
  // every describe cell in the population table is a single text node under the cell
  const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#population td.desc')).every((td) => Array.from(td.childNodes).every((n) => n.nodeType === Node.TEXT_NODE)));
  expect(ok).toBe(true);
  const inlineScripts = await page.evaluate(() => Array.from(document.scripts).filter((s) => !s.src).length);
  expect(inlineScripts).toBe(0);
});
