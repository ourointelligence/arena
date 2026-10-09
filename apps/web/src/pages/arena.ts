// The Arena page: wires the API, the event stream and every section for one lane at a time.
import { api } from '../api.ts';
import { el } from '../dom.ts';
import { buildFooter, buildNav } from '../nav.ts';
import { arenaPath, navigate, strategyPath } from '../router.ts';
import { EventStream } from '../stream.ts';
import { capPush, logRowsFromCycle, logRowsFromEvent, refreshFor, type LogRow, type Refresh } from '../store.ts';
import { TreeView } from '../tree.ts';
import * as S from '../sections.ts';
import type { ArenaEvent, EquityRange, GraveRow, Lane } from '../types.ts';

export type PageHandle = { root: HTMLElement; destroy: () => void };

export async function arenaPage(initialLane: string | null): Promise<PageHandle> {
  const root = el('div', { id: 'arena-page' });
  root.appendChild(buildNav());
  const main = el('main', { class: 'wrap' });
  root.appendChild(main);

  let lanes: Lane[] = [];
  try {
    lanes = await api.lanes();
  } catch {
    main.appendChild(el('div', { class: 'msg' }, 'The Arena API is not reachable right now. Try again in a moment.'));
    root.appendChild(buildFooter());
    return { root, destroy: () => undefined };
  }
  let lane: string = lanes.find((l) => l.id === initialLane)?.id ?? lanes[0]?.id ?? 'core';
  let disposed = false;

  const tree = S.treePanel();
  const status = S.statusBar(lanes, (id) => {
    if (id === lane) return;
    navigate(arenaPath(id), true);
    void switchLane(id);
  });
  const heroS = S.hero(tree.root);
  const takeoffS = S.takeoff();
  const popS = S.population();
  const logS = S.thoughtLog();
  const bookS = S.paperBook((r) => void loadEquity(r));
  const momentsS = S.moments();
  const graveS = S.graveyard(() => void loadGraveyard(true));
  const switchS = S.killSwitch();
  const ledgerS = S.ledger();
  main.append(status.root, heroS.root, takeoffS.root, popS.root, logS.root, bookS.root, momentsS.root, graveS.root, switchS.root, ledgerS.root, S.howItWorks());
  root.appendChild(buildFooter());

  const view = new TreeView(tree.canvas);
  view.onHover = (h) => tree.showTip(h);
  view.onSelect = (id) => navigate(strategyPath(lane, id));
  tree.reset.addEventListener('click', () => view.reset());

  const log: LogRow[] = [];
  let bestId: string | null = null;
  let range: EquityRange = '7d';
  let graveCursor: number | null = null;
  let graveRows: GraveRow[] = [];

  const safe = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.warn(`${label} failed`, err);
    }
  };

  async function loadSummary() {
    const s = await api.summary(lane);
    if (disposed) return;
    status.update(s);
    heroS.update(s);
    const cycles = (await api.cycles(lane, 60)).items;
    takeoffS.update(cycles, s);
  }
  async function loadPopulation() {
    const rows = await api.population(lane);
    if (disposed) return;
    popS.update(lane, rows, bestId);
  }
  async function loadTree(animate = true) {
    const t = await api.tree(lane);
    if (disposed) return;
    bestId = t.bestId;
    view.setTree(t, animate);
  }
  async function loadLogFromApi() {
    const recent = (await api.cycles(lane, 3)).items.sort((a, b) => a.n - b.n);
    const details = await Promise.all(recent.map((c) => api.cycle(lane, c.n).catch(() => null)));
    if (disposed) return;
    log.length = 0;
    for (const d of details) if (d) for (const r of logRowsFromCycle(d)) capPush(log, r);
    logS.set(log);
  }
  async function loadEquity(r: EquityRange = range) {
    range = r;
    const e = await api.equity(lane, r);
    if (disposed) return;
    bookS.update(e.points);
  }
  async function loadMoments() {
    const m = await api.moments(lane);
    if (disposed) return;
    momentsS.update(lane, m.items);
  }
  async function loadGraveyard(more = false) {
    const page = await api.graveyard(lane, more ? graveCursor : undefined);
    if (disposed) return;
    graveRows = more ? [...graveRows, ...page.items] : page.items;
    graveCursor = page.nextCursor;
    graveS.update(lane, graveRows, graveCursor !== null);
  }
  async function loadControl() {
    const [rows, health] = await Promise.all([api.control(), api.health().catch(() => null)]);
    if (disposed) return;
    switchS.updateStates(lanes, health);
    switchS.updateLog(rows);
  }
  async function loadLedger() {
    const l = await api.ledger();
    if (disposed) return;
    ledgerS.update(l);
  }

  const pending = new Set<Refresh>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh(kinds: Refresh[]) {
    for (const k of kinds) pending.add(k);
    if (flushTimer || !pending.size) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const kinds = [...pending];
      pending.clear();
      const jobs: Promise<void>[] = [];
      if (kinds.includes('tree')) jobs.push(safe('tree', () => loadTree(true)).then(() => (kinds.includes('population') ? safe('population', loadPopulation) : undefined)));
      else if (kinds.includes('population')) jobs.push(safe('population', loadPopulation));
      if (kinds.includes('summary') || kinds.includes('cycles')) jobs.push(safe('summary', loadSummary));
      if (kinds.includes('moments')) jobs.push(safe('moments', loadMoments));
      if (kinds.includes('control')) jobs.push(safe('control', loadControl));
      if (kinds.includes('equity')) jobs.push(safe('equity', () => loadEquity()));
      void Promise.all(jobs);
    }, 600);
  }

  // ?stream=<events per second> is a test hook for the soak test against the mock API
  const streamRate = new URLSearchParams(location.search).get('stream');
  const streamUrl = (id: string) => api.streamUrl(id) + (streamRate ? `&rate=${encodeURIComponent(streamRate)}` : '');
  const stream = new EventStream(() => scheduleRefresh(['summary', 'population', 'moments', 'control', 'equity']));
  stream.onMode((m) => status.setStream(m));
  stream.on((ev: ArenaEvent) => {
    if (ev.lane && ev.lane !== lane) return;
    const rows = logRowsFromEvent(ev);
    if (rows.length) {
      for (const r of rows) capPush(log, r);
      logS.append(log, rows);
    }
    scheduleRefresh(refreshFor(ev.type));
  });

  async function loadAll() {
    const l = lanes.find((x) => x.id === lane)!;
    status.setLane(lane, l.tf);
    await Promise.all([
      safe('summary', loadSummary),
      safe('tree', () => loadTree(false)).then(() => safe('population', loadPopulation)),
      safe('log', loadLogFromApi),
      safe('equity', () => loadEquity(range)),
      safe('moments', loadMoments),
      safe('graveyard', () => loadGraveyard(false)),
      safe('control', loadControl),
      safe('ledger', loadLedger),
    ]);
  }

  async function switchLane(id: string) {
    lane = id;
    log.length = 0;
    logS.set(log);
    graveCursor = null;
    graveRows = [];
    stream.start(streamUrl(lane));
    await loadAll();
  }

  stream.start(streamUrl(lane));
  void loadAll();
  const healthTimer = setInterval(() => void safe('control', loadControl), 30_000);

  return {
    root,
    destroy() {
      disposed = true;
      stream.stop();
      view.destroy();
      status.destroy();
      clearInterval(healthTimer);
      if (flushTimer) clearTimeout(flushTimer);
    },
  };
}
