/**
 * 1200x630 share card for one strategy: satori renders a small element tree to SVG, resvg rasterises it.
 * Cached on disk by lane and id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

export type CardData = {
  lane: string;
  laneName: string;
  id: string;
  describe: string;
  ci: number | null;
  holdoutScore: number | null;
  forwardScore: number | null;
  bornCycle: number;
  status: string;
  origin: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));

function findFonts(): string {
  for (const dir of [path.join(here, '..', 'fonts'), path.join(here, '..', '..', 'fonts'), path.join(process.cwd(), 'fonts')]) {
    if (fs.existsSync(path.join(dir, 'ArchivoBlack-Regular.ttf'))) return dir;
  }
  throw new Error('share card fonts not found (apps/api/fonts)');
}

let fontCache: Array<{ name: string; data: ArrayBuffer; weight: 400 | 900; style: 'normal' }> | null = null;

export function loadFonts(dir = findFonts()) {
  if (fontCache) return fontCache;
  const buf = (f: string) => {
    const b = fs.readFileSync(path.join(dir, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  fontCache = [
    { name: 'Archivo Black', data: buf('ArchivoBlack-Regular.ttf'), weight: 900, style: 'normal' },
    { name: 'Geist Mono', data: buf('GeistMono-Regular.ttf'), weight: 400, style: 'normal' },
  ];
  return fontCache;
}

const fmt = (v: number | null, digits = 2, signed = true) => (v === null ? 'n/a' : (signed && v >= 0 ? '+' : '') + v.toFixed(digits));

function h(type: string, style: Record<string, unknown>, children?: unknown) {
  return { type, props: { style, children } };
}

export function cardElement(d: CardData) {
  const mono: Record<string, unknown> = { fontFamily: 'Geist Mono', fontSize: 26, color: '#4c4d52', display: 'flex' };
  const stat = (label: string, value: string, color = '#0b0b0c') =>
    h('div', { display: 'flex', flexDirection: 'column', marginRight: 56 }, [
      h('div', { ...mono, fontSize: 20, letterSpacing: 2, textTransform: 'uppercase' }, label),
      h('div', { fontFamily: 'Geist Mono', fontSize: 44, color, marginTop: 6, display: 'flex' }, value),
    ]);
  const describe = d.describe.length > 150 ? d.describe.slice(0, 149).trimEnd() + '.' : d.describe;
  return h('div', { width: 1200, height: 630, background: '#ffffff', display: 'flex', flexDirection: 'column', padding: '64px 72px', color: '#0b0b0c' }, [
    h('div', { display: 'flex', alignItems: 'center', ...mono, fontSize: 24, letterSpacing: 3 }, [
      h('div', { width: 20, height: 20, borderRadius: 20, background: '#1a3cff', marginRight: 16, display: 'flex' }),
      h('div', { display: 'flex' }, `OURO ARENA  /  ${d.laneName.toUpperCase()} LANE  /  ${d.id}`),
    ]),
    h('div', { fontFamily: 'Archivo Black', fontSize: 56, lineHeight: 1.05, marginTop: 44, display: 'flex', maxWidth: 1056 }, describe),
    h('div', { display: 'flex', marginTop: 'auto' }, [
      stat('Capability Index', fmt(d.ci), d.ci !== null && d.ci < 0 ? '#d8102e' : '#1a3cff'),
      stat('Holdout', fmt(d.holdoutScore, 3)),
      stat('Forward', fmt(d.forwardScore, 3)),
      stat('Born', `c${d.bornCycle}`),
      stat('Status', d.status),
    ]),
    h('div', { ...mono, fontSize: 20, marginTop: 36, color: '#8b8c93' }, 'ourosi.xyz/arena  .  paper trading only, not financial advice'),
  ]);
}

export async function renderCard(d: CardData, fonts = loadFonts()): Promise<Buffer> {
  const svg = await satori(cardElement(d) as any, { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  return Buffer.from(png);
}

export async function cachedCard(cacheDir: string, d: CardData): Promise<Buffer> {
  const file = path.join(cacheDir, `${d.lane}-${d.id}.png`);
  try {
    return fs.readFileSync(file);
  } catch {
    // not cached yet
  }
  const png = await renderCard(d);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, png);
  } catch {
    // a read-only cache dir only costs a re-render
  }
  return png;
}
