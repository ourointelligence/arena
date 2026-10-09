// DOM helpers. Every string becomes a text node; nothing here ever sets innerHTML.

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | number | null | undefined | false;

function applyAttrs(node: Element, attrs?: Attrs | null): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', String(v));
    else if (k.startsWith('on')) throw new Error('inline handlers are not allowed');
    else node.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(node: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

/** Escape for the rare place a string must become markup-safe text inside an attribute. */
export function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export const fmt = {
  num(v: number | null | undefined, d = 2): string {
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'n/a';
  },
  signed(v: number | null | undefined, d = 2): string {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
    return (v >= 0 ? '+' : '') + v.toFixed(d);
  },
  int(v: number | null | undefined): string {
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : 'n/a';
  },
  usd(v: number | null | undefined): string {
    return typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : 'n/a';
  },
  /** "12s", "4m", "3h", "2d" relative to now. */
  ago(ts: number | null | undefined, now = Date.now()): string {
    if (typeof ts !== 'number') return 'n/a';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  },
  duration(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
    const h = Math.floor(ms / 3_600_000);
    const d = Math.floor(h / 24);
    if (d >= 1) return `${d}d ${h - d * 24}h`;
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  },
  time(ts: number | null | undefined): string {
    if (typeof ts !== 'number') return 'n/a';
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  },
  clock(ts: number | null | undefined): string {
    if (typeof ts !== 'number') return 'n/a';
    return new Date(ts).toISOString().slice(11, 19);
  },
};
