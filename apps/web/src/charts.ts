// Small inline SVG charts drawn by code. Each render replaces the container's content.
import { clear, svg } from './dom.ts';
import type { Cycle } from './types.ts';

type Pt = { x: number; y: number };
type Series = { name: string; color: string; points: Pt[]; dashed?: boolean; width?: number };
type Band = { from: number; to: number; label?: string };
type Marker = { x: number; label: string };

export type LineChartOptions = {
  series: Series[];
  height?: number;
  xLabel?: (x: number) => string;
  yLabel?: (y: number) => string;
  bands?: Band[];
  markers?: Marker[];
  zeroLine?: boolean;
  bars?: { points: Pt[]; color: string; label: string };
  xTicks?: number[];
};

const PAD = { top: 14, right: 16, bottom: 26, left: 44 };

function nice(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** Draw a responsive line chart into `container`. Returns the svg element. */
export function lineChart(container: HTMLElement, opts: LineChartOptions): SVGSVGElement {
  clear(container);
  const width = Math.max(240, container.clientWidth || 600);
  const height = opts.height ?? 280;
  const all = opts.series.flatMap((s) => s.points).concat(opts.bars?.points ?? []);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: String(height), role: 'img', 'aria-label': opts.series.map((s) => s.name).join(', ') });
  const x0 = PAD.left;
  const x1 = width - PAD.right;
  const y0 = PAD.top;
  const y1 = height - PAD.bottom;
  if (!all.length) {
    root.appendChild(svg('text', { x: String(width / 2), y: String(height / 2), 'text-anchor': 'middle', class: 'chart-empty' }, 'no data yet'));
    container.appendChild(root);
    return root;
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y).filter((v) => Number.isFinite(v));
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMax === xMin) {
    xMin -= 1;
    xMax += 1;
  }
  let yMin = Math.min(...ys, opts.zeroLine ? 0 : Infinity);
  let yMax = Math.max(...ys, opts.zeroLine ? 0 : -Infinity);
  if (yMax === yMin) {
    yMin -= 1;
    yMax += 1;
  }
  const span = yMax - yMin;
  yMin -= span * 0.08;
  yMax += span * 0.08;
  const sx = (x: number) => x0 + ((x - xMin) / (xMax - xMin)) * (x1 - x0);
  const sy = (y: number) => y1 - ((y - yMin) / (yMax - yMin)) * (y1 - y0);
  // bands (data gaps)
  for (const b of opts.bands ?? []) {
    root.appendChild(svg('rect', { x: String(sx(b.from)), y: String(y0), width: String(Math.max(2, sx(b.to) - sx(b.from))), height: String(y1 - y0), class: 'chart-band' }));
  }
  // grid and y labels
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const y = sy(v);
    root.appendChild(svg('line', { x1: String(x0), x2: String(x1), y1: String(y), y2: String(y), class: 'chart-grid' }));
    root.appendChild(svg('text', { x: String(x0 - 6), y: String(y + 4), 'text-anchor': 'end', class: 'chart-tick' }, (opts.yLabel ?? nice)(v)));
  }
  if (opts.zeroLine && yMin < 0 && yMax > 0) {
    root.appendChild(svg('line', { x1: String(x0), x2: String(x1), y1: String(sy(0)), y2: String(sy(0)), class: 'chart-zero' }));
  }
  // x ticks
  const ticks = opts.xTicks ?? Array.from({ length: 5 }, (_, i) => xMin + ((xMax - xMin) * i) / 4);
  for (const t of ticks) {
    root.appendChild(svg('text', { x: String(sx(t)), y: String(height - 8), 'text-anchor': 'middle', class: 'chart-tick' }, (opts.xLabel ?? nice)(t)));
  }
  // bars (velocity)
  if (opts.bars) {
    const bw = Math.max(2, ((x1 - x0) / Math.max(1, opts.bars.points.length)) * 0.4);
    for (const p of opts.bars.points) {
      const top = Math.min(sy(p.y), sy(0));
      const hgt = Math.abs(sy(p.y) - sy(0));
      root.appendChild(svg('rect', { x: String(sx(p.x) - bw / 2), y: String(top), width: String(bw), height: String(Math.max(1, hgt)), fill: opts.bars.color, opacity: '0.35' }));
    }
  }
  // series
  for (const s of opts.series) {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
    root.appendChild(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': String(s.width ?? 2), 'stroke-dasharray': s.dashed ? '4 4' : null, 'stroke-linejoin': 'round' }));
    if (pts.length <= 60) for (const p of pts) root.appendChild(svg('circle', { cx: String(sx(p.x)), cy: String(sy(p.y)), r: '2.5', fill: s.color }));
  }
  // markers (ceiling)
  for (const m of opts.markers ?? []) {
    const x = sx(m.x);
    root.appendChild(svg('line', { x1: String(x), x2: String(x), y1: String(y0), y2: String(y1), class: 'chart-marker' }));
    root.appendChild(svg('text', { x: String(x + 4), y: String(y0 + 10), class: 'chart-marker-label' }, m.label));
  }
  // legend
  let lx = x0;
  for (const s of opts.series) {
    root.appendChild(svg('rect', { x: String(lx), y: String(y0 - 10), width: '14', height: '3', fill: s.color }));
    const t = svg('text', { x: String(lx + 18), y: String(y0 - 6), class: 'chart-legend' }, s.name);
    root.appendChild(t);
    lx += 18 + s.name.length * 6.5 + 18;
  }
  if (opts.bars) {
    root.appendChild(svg('rect', { x: String(lx), y: String(y0 - 12), width: '8', height: '8', fill: opts.bars.color, opacity: '0.35' }));
    root.appendChild(svg('text', { x: String(lx + 12), y: String(y0 - 6), class: 'chart-legend' }, opts.bars.label));
  }
  container.appendChild(root);
  return root;
}

/** Gaps between cycles longer than 12 hours are shown as shaded bands on the cycle axis. */
export function cycleGaps(cycles: Cycle[], gapMs = 12 * 3_600_000): Band[] {
  const sorted = [...cycles].sort((a, b) => a.n - b.n);
  const bands: Band[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const from = a.endedAt ?? a.startedAt;
    if (b.startedAt - from > gapMs) bands.push({ from: a.n, to: b.n, label: 'gap' });
    if (b.outcome === 'error') bands.push({ from: b.n - 0.5, to: b.n + 0.5, label: 'error' });
  }
  return bands;
}

export function takeoffChart(container: HTMLElement, cycles: Cycle[], colors: { cobalt: string; flame: string; fg3: string }): void {
  const sorted = [...cycles].sort((a, b) => a.n - b.n);
  const ceiling = sorted.find((c) => c.ceiling);
  lineChart(container, {
    height: 300,
    zeroLine: true,
    xLabel: (x) => `c${Math.round(x)}`,
    xTicks: sorted.length <= 12 ? sorted.map((c) => c.n) : undefined,
    series: [
      { name: 'population CI', color: colors.cobalt, points: sorted.map((c) => ({ x: c.n, y: c.popCI ?? NaN })) },
      { name: 'best CI', color: colors.flame, points: sorted.map((c) => ({ x: c.n, y: c.bestCI ?? NaN })), dashed: true },
    ],
    bars: { points: sorted.map((c) => ({ x: c.n, y: c.velocity ?? 0 })), color: colors.fg3, label: 'velocity' },
    bands: cycleGaps(sorted),
    markers: ceiling ? [{ x: ceiling.n, label: 'ceiling' }] : [],
  });
}

export function equityChart(container: HTMLElement, points: Array<{ ts: number; ensemble: number; benchmark: number }>, colors: { cobalt: string; fg3: string }): void {
  lineChart(container, {
    height: 260,
    xLabel: (x) => {
      const d = new Date(x);
      return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}h`;
    },
    series: [
      { name: 'lane ensemble', color: colors.cobalt, points: points.map((p) => ({ x: p.ts, y: p.ensemble })) },
      { name: 'buy and hold', color: colors.fg3, points: points.map((p) => ({ x: p.ts, y: p.benchmark })), dashed: true },
    ],
  });
}

export function ciChart(container: HTMLElement, rows: Array<{ cycle: number; ci: number }>, color: string): void {
  lineChart(container, {
    height: 200,
    zeroLine: true,
    xLabel: (x) => `c${Math.round(x)}`,
    xTicks: rows.length <= 12 ? rows.map((r) => r.cycle) : undefined,
    series: [{ name: 'CI', color, points: rows.map((r) => ({ x: r.cycle, y: r.ci })) }],
  });
}

export function strategyEquityChart(container: HTMLElement, rows: Array<{ ts: number; equity: number }>, color: string): void {
  lineChart(container, {
    height: 200,
    xLabel: (x) => {
      const d = new Date(x);
      return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    },
    series: [{ name: 'equity', color, points: rows.map((r) => ({ x: r.ts, y: r.equity })) }],
  });
}
