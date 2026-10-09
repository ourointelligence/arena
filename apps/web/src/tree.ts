// The family tree: a pure radial layout plus a canvas view with one guarded animation loop.
import { tokens } from './theme.ts';
import type { Tree, TreeNode } from './types.ts';

export type LayoutNode = TreeNode & { x: number; y: number; angle: number; ring: number; best: boolean };
export type Layout = { nodes: LayoutNode[]; rings: number; ringGap: number; maxRadius: number; byId: Map<string, LayoutNode> };

const TAU = Math.PI * 2;

function norm(a: number): number {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

function circularMean(angles: number[]): number {
  if (!angles.length) return 0;
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return norm(Math.atan2(y, x));
}

/** Spread the angles of one ring so no two nodes sit closer than minSep, keeping their order. */
export function relaxRing(angles: number[], minSep: number): number[] {
  const n = angles.length;
  if (n < 2) return angles.slice();
  const order = angles.map((a, i) => ({ a: norm(a), i })).sort((p, q) => p.a - q.a);
  const sep = Math.min(minSep, TAU / n);
  const out = order.map((o) => o.a);
  for (let i = 1; i < n; i++) if (out[i]! - out[i - 1]! < sep) out[i] = out[i - 1]! + sep;
  // close the circle: the last node must stay sep away from the first (one turn later)
  const overflow = out[n - 1]! - (out[0]! + TAU - sep);
  if (overflow > 0) {
    const shift = overflow / 2;
    for (let i = 0; i < n; i++) out[i] = out[i]! - shift * (i / (n - 1));
    for (let i = 0; i < n; i++) out[i] = out[0]! + ((out[i]! - out[0]!) * (TAU - sep)) / Math.max(TAU - sep, out[n - 1]! - out[0]!);
  }
  const result = new Array<number>(n);
  order.forEach((o, k) => (result[o.i] = norm(out[k]!)));
  return result;
}

/**
 * Radial layout: seed strategies in the centre ring, one ring per cycle outward, children placed near the angle
 * of their parents and spread apart so rings stay readable. Deterministic for the same input.
 */
export function layoutTree(tree: Tree, ringGap = 60): Layout {
  const nodes = tree.nodes;
  const byId = new Map<string, LayoutNode>();
  const maxBorn = nodes.reduce((m, n) => Math.max(m, n.born), 0);
  const bestSet = new Set(tree.bestLineage);
  const rings = maxBorn;
  const roots = nodes.filter((n) => n.born === 0);
  const r0 = roots.length > 1 ? ringGap * 0.55 : 0;
  roots.forEach((n, i) => {
    const angle = norm(-Math.PI / 2 + (i * TAU) / roots.length);
    byId.set(n.id, { ...n, angle, ring: 0, x: r0 ? r0 * Math.cos(angle) : 0, y: r0 ? r0 * Math.sin(angle) : 0, best: bestSet.has(n.id) });
  });
  for (let b = 1; b <= maxBorn; b++) {
    const ringNodes = nodes.filter((n) => n.born === b);
    if (!ringNodes.length) continue;
    const radius = r0 + b * ringGap;
    // desired angle: mean of the parents' angles; orphans (fresh) take evenly spaced free angles
    const desired = ringNodes.map((n, i) => {
      const pa = n.parents.map((p) => byId.get(p)?.angle).filter((a): a is number => typeof a === 'number');
      if (pa.length) return circularMean(pa);
      return norm(Math.PI / 4 + (i * TAU) / Math.max(ringNodes.length, 3));
    });
    // siblings with the same desired angle fan out before relaxation
    const seen = new Map<string, number>();
    const fanned = desired.map((a, i) => {
      const key = ringNodes[i]!.parents.join('+') || `fresh${i}`;
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      const offset = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.12;
      return norm(a + offset);
    });
    const minSep = Math.max(0.08, Math.min(0.35, 14 / radius));
    const angles = relaxRing(fanned, minSep);
    ringNodes.forEach((n, i) => {
      const angle = angles[i]!;
      byId.set(n.id, { ...n, angle, ring: b, x: radius * Math.cos(angle), y: radius * Math.sin(angle), best: bestSet.has(n.id) });
    });
  }
  return { nodes: [...byId.values()], rings, ringGap, maxRadius: r0 + rings * ringGap, byId };
}

export type TreeHover = { id: string; origin: string; ci: number | null; x: number; y: number } | null;

type Birth = { id: string; from: { x: number; y: number }; start: number };

/**
 * Canvas view. Exactly one requestAnimationFrame loop, guarded so it can never be started twice, throttled to
 * 30 fps, paused while the canvas is off screen or the tab is hidden, and otherwise only drawing when something
 * changed. Pan with drag, zoom with the wheel, reset with reset().
 */
export class TreeView {
  private layout: Layout = { nodes: [], rings: 0, ringGap: 60, maxRadius: 0, byId: new Map() };
  private readonly ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastFrame = 0;
  private dirty = true;
  private visible = true;
  private births: Birth[] = [];
  private known = new Set<string>();
  private tx = 0;
  private ty = 0;
  private k = 1;
  private hoverId: string | null = null;
  private drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  private colors = tokens();
  private width = 0;
  private height = 0;
  private readonly io: IntersectionObserver | null;
  private readonly ro: ResizeObserver | null;
  private fitted = false;
  /** Set once the viewer pans or zooms; auto-fit stops then so new data does not yank the view. */
  private userMoved = false;
  onHover: (h: TreeHover) => void = () => undefined;
  onSelect: (id: string) => void = () => undefined;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.resize();
    this.io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      if (this.visible) this.kick();
    }) : null;
    this.io?.observe(canvas);
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      this.resize();
      this.invalidate();
    }) : null;
    this.ro?.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('ouro-theme', this.onTheme);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('click', this.onClick);
  }

  destroy(): void {
    this.io?.disconnect();
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('ouro-theme', this.onTheme);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  setTree(tree: Tree, animate = true): void {
    const prev = this.layout;
    this.layout = layoutTree(tree, this.layout.ringGap);
    const now = performance.now();
    for (const n of this.layout.nodes) {
      if (this.known.has(n.id)) continue;
      if (animate && this.known.size > 0) {
        const parent = n.parents.map((p) => this.layout.byId.get(p) ?? prev.byId.get(p)).find(Boolean);
        this.births.push({ id: n.id, from: parent ? { x: parent.x, y: parent.y } : { x: 0, y: 0 }, start: now });
      }
      this.known.add(n.id);
    }
    if (!this.fitted || !this.userMoved) this.fit();
    this.invalidate();
  }

  reset(): void {
    this.userMoved = false;
    this.fit();
    this.invalidate();
  }

  private fit(): void {
    const pad = 36;
    const r = Math.max(this.layout.maxRadius + 24, 60);
    this.k = Math.max(0.1, Math.min(this.width, this.height) / 2 / (r + pad / 2));
    this.tx = this.width / 2;
    this.ty = this.height / 2;
    this.fitted = this.width > 0;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    const changed = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (changed && !this.userMoved) this.fit();
  }

  invalidate(): void {
    this.dirty = true;
    this.kick();
  }

  /** Schedule one frame unless one is already scheduled. Never re-entrant. */
  private kick(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (!this.visible || document.hidden) return;
    if (now - this.lastFrame < 33) {
      this.kick();
      return;
    }
    this.lastFrame = now;
    const animating = this.births.length > 0;
    if (this.dirty || animating) this.draw(now);
    this.dirty = false;
    if (this.births.length > 0) this.kick();
  };

  private readonly onVisibility = (): void => {
    if (!document.hidden) this.invalidate();
  };

  private readonly onTheme = (): void => {
    this.colors = tokens();
    this.invalidate();
  };

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.tx) / this.k, y: (sy - this.ty) / this.k };
  }

  private nodeAt(sx: number, sy: number): LayoutNode | null {
    const w = this.toWorld(sx, sy);
    const reach = 10 / this.k;
    let best: LayoutNode | null = null;
    let bestD = reach * reach;
    for (const n of this.layout.nodes) {
      const dx = n.x - w.x;
      const dy = n.y - w.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  private local(e: PointerEvent | MouseEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onDown = (e: PointerEvent): void => {
    const p = this.local(e);
    this.drag = { x: p.x, y: p.y, tx: this.tx, ty: this.ty, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    if (this.drag) {
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        this.drag.moved = true;
        this.userMoved = true;
      }
      this.tx = this.drag.tx + dx;
      this.ty = this.drag.ty + dy;
      this.invalidate();
      return;
    }
    const n = this.nodeAt(p.x, p.y);
    const id = n?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.canvas.style.cursor = id ? 'pointer' : 'grab';
      this.onHover(n ? { id: n.id, origin: n.origin, ci: n.ci, x: p.x, y: p.y } : null);
      this.invalidate();
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (this.drag && this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
  };

  private readonly onLeave = (): void => {
    if (this.hoverId) {
      this.hoverId = null;
      this.onHover(null);
      this.invalidate();
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nk = Math.min(8, Math.max(0.15, this.k * factor));
    this.userMoved = true;
    const w = this.toWorld(p.x, p.y);
    this.k = nk;
    this.tx = p.x - w.x * nk;
    this.ty = p.y - w.y * nk;
    this.invalidate();
  };

  private readonly onClick = (e: MouseEvent): void => {
    if (this.drag?.moved) return;
    const p = this.local(e);
    const n = this.nodeAt(p.x, p.y);
    if (n) this.onSelect(n.id);
  };

  private draw(now: number): void {
    const c = this.ctx;
    const { width: w, height: h } = this;
    const col = this.colors;
    c.clearRect(0, 0, w, h);
    c.save();
    c.translate(this.tx, this.ty);
    c.scale(this.k, this.k);
    const lay = this.layout;
    const px = 1 / this.k;
    // rings
    c.lineWidth = px;
    c.strokeStyle = col.rule2;
    c.fillStyle = col.fg3;
    c.font = `${11 * px}px "Geist Mono", ui-monospace, monospace`;
    c.textBaseline = 'middle';
    const r0 = lay.nodes.some((n) => n.ring === 0 && (n.x !== 0 || n.y !== 0)) ? lay.ringGap * 0.55 : 0;
    // label every ring while they are at least 16 px apart on screen, otherwise every 2nd, 3rd...
    const stride = Math.max(1, Math.ceil(16 / (lay.ringGap * this.k)));
    for (let b = 1; b <= lay.rings; b++) {
      const r = r0 + b * lay.ringGap;
      c.beginPath();
      c.arc(0, 0, r, 0, TAU);
      c.stroke();
      if (b % stride === 0 || b === lay.rings) c.fillText(`c${b}`, r + 4 * px, -8 * px);
    }
    // live positions, with births animating in from their parent
    const pos = new Map<string, { x: number; y: number }>();
    const keep: Birth[] = [];
    for (const n of lay.nodes) pos.set(n.id, { x: n.x, y: n.y });
    for (const b of this.births) {
      const t = Math.min(1, (now - b.start) / 650);
      const n = lay.byId.get(b.id);
      if (!n) continue;
      const e = 1 - Math.pow(1 - t, 3);
      pos.set(b.id, { x: b.from.x + (n.x - b.from.x) * e, y: b.from.y + (n.y - b.from.y) * e });
      if (t < 1) keep.push(b);
    }
    this.births = keep;
    // edges
    c.lineWidth = px;
    for (const n of lay.nodes) {
      const p1 = pos.get(n.id)!;
      for (const pid of n.parents) {
        const p0 = pos.get(pid);
        if (!p0) continue;
        const onBest = n.best && lay.byId.get(pid)?.best;
        if (onBest) continue;
        c.strokeStyle = n.status === 'live' ? col.fg3 : col.rule2;
        c.globalAlpha = n.status === 'live' ? 0.9 : 0.55;
        c.beginPath();
        c.moveTo(p0.x, p0.y);
        c.lineTo(p1.x, p1.y);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
    // best lineage in flame with a glow
    c.save();
    c.strokeStyle = col.flame;
    c.lineWidth = 2.2 * px;
    c.shadowColor = col.flame;
    c.shadowBlur = 12 * px;
    for (const n of lay.nodes) {
      if (!n.best) continue;
      const p1 = pos.get(n.id)!;
      for (const pid of n.parents) {
        const parent = lay.byId.get(pid);
        const p0 = pos.get(pid);
        if (!parent?.best || !p0) continue;
        c.beginPath();
        c.moveTo(p0.x, p0.y);
        c.lineTo(p1.x, p1.y);
        c.stroke();
      }
    }
    c.restore();
    // nodes
    for (const n of lay.nodes) {
      const p = pos.get(n.id)!;
      const hovered = n.id === this.hoverId;
      if (n.status === 'live') {
        const r = (n.best ? 5.5 : 4.5) * px;
        c.fillStyle = n.best ? col.flame : col.cobalt;
        if (n.best) {
          c.save();
          c.shadowColor = col.flame;
          c.shadowBlur = 14 * px;
          c.beginPath();
          c.arc(p.x, p.y, r, 0, TAU);
          c.fill();
          c.restore();
        } else {
          c.beginPath();
          c.arc(p.x, p.y, r, 0, TAU);
          c.fill();
        }
      } else {
        const s = (n.status === 'rejected' ? 2.6 : 3.4) * px;
        c.strokeStyle = n.status === 'rejected' ? col.rule2 : col.fg3;
        c.lineWidth = 1.2 * px;
        c.beginPath();
        c.moveTo(p.x - s, p.y - s);
        c.lineTo(p.x + s, p.y + s);
        c.moveTo(p.x + s, p.y - s);
        c.lineTo(p.x - s, p.y + s);
        c.stroke();
      }
      if (hovered) {
        c.strokeStyle = col.fg;
        c.lineWidth = 1.5 * px;
        c.beginPath();
        c.arc(p.x, p.y, 9 * px, 0, TAU);
        c.stroke();
      }
    }
    c.restore();
  }
}
