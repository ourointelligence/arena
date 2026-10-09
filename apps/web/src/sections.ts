// Section builders for the Arena page. Each returns its root element and an update function.
import { equityChart, takeoffChart } from './charts.ts';
import { clear, el, fmt, replace } from './dom.ts';
import { strategyPath } from './router.ts';
import { barAgeState, TF_MS, type LogRow } from './store.ts';
import { tokens } from './theme.ts';
import type { ControlRow, Cycle, EquityRange, GraveRow, Health, Lane, LaneState, Ledger, Moment, PopulationRow, Summary } from './types.ts';

export function chapterTop(num: string, title: string, lede?: string, tools?: HTMLElement): HTMLElement {
  return el(
    'div',
    { class: 'ch-top' },
    el('div', { class: 'cnum' }, num),
    el('h2', { class: 'title' }, title),
    tools ? el('div', { class: 'tools' }, tools) : lede ? el('p', { class: 'lede' }, lede) : null,
  );
}

function originCell(origin: string): HTMLTableCellElement {
  return el('td', { class: `origin ${origin}` }, origin);
}

/* ------------------------------------ 1. status bar ------------------------------------ */

export function statusBar(lanes: Lane[], onLane: (id: string) => void) {
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Lanes' });
  const buttons = new Map<string, HTMLButtonElement>();
  for (const l of lanes) {
    const b = el('button', { class: 'tab', role: 'tab', 'data-lane': l.id }, l.name);
    b.addEventListener('click', () => onLane(l.id));
    buttons.set(l.id, b);
    tabs.appendChild(b);
  }
  const pill = el('span', { class: 'pill', id: 'state' }, 'loading');
  const uptime = el('b', null, 'n/a');
  const cycles = el('b', null, 'n/a');
  const born = el('b', null, 'n/a');
  const spend = el('b', null, 'n/a');
  const barAge = el('b', null, 'n/a');
  const stream = el('span', { class: 'stream', id: 'stream-state' }, 'connecting');
  const root = el(
    'div',
    { class: 'status', id: 'status' },
    tabs,
    pill,
    el('span', { class: 'stat' }, 'uptime', uptime),
    el('span', { class: 'stat' }, 'cycles', cycles),
    el('span', { class: 'stat' }, 'born', born),
    el('span', { class: 'stat' }, 'spend today', spend),
    el('span', { class: 'stat' }, 'last bar', barAge),
    stream,
  );
  let lastBar: number | null = null;
  let tfMs = 900_000;
  const tick = () => {
    const state = barAgeState(lastBar, tfMs);
    barAge.textContent = lastBar === null ? 'n/a' : `${fmt.ago(lastBar)} ago`;
    barAge.className = state === 'late' ? 'late' : state === 'stale' ? 'stale' : '';
  };
  const timer = setInterval(tick, 1000);
  return {
    root,
    destroy: () => clearInterval(timer),
    setLane(id: string, tf: string) {
      for (const [k, b] of buttons) {
        b.classList.toggle('on', k === id);
        b.setAttribute('aria-selected', k === id ? 'true' : 'false');
      }
      tfMs = TF_MS[tf] ?? 900_000;
    },
    setStream(mode: string) {
      stream.textContent = mode === 'live' ? 'live' : mode === 'polling' ? 'polling every 10 s' : mode;
      stream.className = `stream ${mode}`;
    },
    update(s: Summary) {
      pill.textContent = s.status;
      pill.className = `pill ${s.status}`;
      uptime.textContent = fmt.duration(s.uptimeMs);
      cycles.textContent = fmt.int(s.cycles);
      born.textContent = fmt.int(s.born);
      spend.textContent = `${fmt.usd(s.spendTodayUsd)} of ${fmt.usd(s.budgetUsd)}`;
      lastBar = s.lastBarTs;
      tick();
    },
  };
}

/* ------------------------------------ 2. hero ------------------------------------ */

export function hero(treePanel: HTMLElement) {
  const ci = el('div', { class: 'v co num' }, 'n/a');
  const best = el('div', { class: 'v num' }, 'n/a');
  const live = el('div', { class: 'v num' }, 'n/a');
  const copy = el(
    'div',
    { class: 'hero-copy' },
    el('div', { class: 'label' }, 'OURO Arena · live paper lanes on Hyperliquid'),
    el('h1', null, 'Watch it ', el('em', null, 'rewrite itself.')),
    el('p', { class: 'sub' }, 'Three OURO loops invent, test, kill and promote their own trading strategies on live market data. Paper only, every step shown, nothing hidden.'),
    el(
      'div',
      { class: 'kpis' },
      el('div', { class: 'kpi' }, el('div', { class: 'label' }, 'Population CI'), ci),
      el('div', { class: 'kpi' }, el('div', { class: 'label' }, 'Best CI'), best),
      el('div', { class: 'kpi' }, el('div', { class: 'label' }, 'Alive'), live),
    ),
  );
  const root = el('section', { class: 'hero', id: 'top' }, copy, treePanel);
  return {
    root,
    update(s: Summary) {
      ci.textContent = fmt.signed(s.popCI);
      ci.className = `v num ${(s.popCI ?? 0) >= 0 ? 'good' : 'bad'}`;
      best.textContent = fmt.signed(s.bestCI);
      live.textContent = fmt.int(s.live);
    },
  };
}

/* ------------------------------------ 4. takeoff ------------------------------------ */

export function takeoff() {
  const chart = el('div', { class: 'chart', id: 'takeoff-chart' });
  const pop = el('div', { class: 'v num' }, 'n/a');
  const best = el('div', { class: 'v num' }, 'n/a');
  const vel = el('div', { class: 'v num' }, 'n/a');
  const ceil = el('div', { class: 'v' }, 'n/a');
  const root = el(
    'section',
    { class: 'chapter', id: 'takeoff' },
    chapterTop('02 / Takeoff', 'Is it getting smarter?', 'Population CI and best CI per cycle, measured on data the strategies never saw. Velocity is the gain per cycle. A ceiling means three flat cycles in a row.'),
    chart,
    el(
      'div',
      { class: 'metrics' },
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Population CI'), pop),
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Best CI'), best),
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Velocity'), vel),
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Ceiling'), ceil),
    ),
  );
  let cycles: Cycle[] = [];
  const draw = () => {
    const t = tokens();
    takeoffChart(chart, cycles, { cobalt: t.cobalt, flame: t.flame, fg3: t.fg3 });
  };
  window.addEventListener('ouro-theme', draw);
  return {
    root,
    redraw: draw,
    update(rows: Cycle[], s: Summary | null) {
      cycles = rows;
      draw();
      if (s) {
        pop.textContent = fmt.signed(s.popCI);
        pop.className = `v num ${(s.popCI ?? 0) >= 0 ? 'good' : 'bad'}`;
        best.textContent = fmt.signed(s.bestCI);
        vel.textContent = fmt.signed(s.velocity, 3);
        ceil.textContent = s.ceiling ? 'raised' : 'clear';
        ceil.className = `v ${s.ceiling ? 'fl' : 'good'}`;
      }
    },
  };
}

/* ------------------------------------ 5. population ------------------------------------ */

export function population() {
  const tbody = el('tbody');
  const table = el(
    'table',
    null,
    el(
      'thead',
      null,
      el('tr', null, el('th', null, 'id'), el('th', null, 'origin'), el('th', { class: 'num' }, 'born'), el('th', { class: 'num' }, 'CI'), el('th', { class: 'num' }, 'holdout'), el('th', { class: 'num' }, 'forward'), el('th', { class: 'num' }, 'trades'), el('th', { class: 'num' }, 'survived'), el('th', null, 'description')),
    ),
    tbody,
  );
  const root = el('section', { class: 'chapter', id: 'population' }, chapterTop('03 / Live population', 'Eight alive at once.', 'The strategies trading right now. CI compares each one with the seed generation on unseen data; forward is the score on trades made after promotion.'), el('div', { class: 'tablewrap' }, table));
  return {
    root,
    update(lane: string, rows: PopulationRow[], bestId: string | null) {
      clear(tbody);
      if (!rows.length) tbody.appendChild(el('tr', null, el('td', { colspan: '9', class: 'empty' }, 'nothing alive yet')));
      for (const r of rows) {
        tbody.appendChild(
          el(
            'tr',
            { class: r.id === bestId ? 'best' : null },
            el('td', { class: 'id' }, el('a', { href: strategyPath(lane, r.id) }, r.id)),
            originCell(r.origin),
            el('td', { class: 'num' }, `c${r.bornCycle}`),
            el('td', { class: `num ${(r.ci ?? 0) >= 0 ? 'good' : 'bad'}` }, fmt.signed(r.ci)),
            el('td', { class: 'num' }, fmt.signed(r.holdoutScore, 3)),
            el('td', { class: 'num' }, r.forwardScore === null ? 'n/a' : `${fmt.signed(r.forwardScore, 3)} (${r.forwardTrades})`),
            el('td', { class: 'num' }, fmt.int(r.trades)),
            el('td', { class: 'num' }, fmt.int(r.cyclesSurvived)),
            el('td', { class: 'desc' }, r.describe),
          ),
        );
      }
    },
  };
}

/* ------------------------------------ 6. thought log ------------------------------------ */

export function thoughtLog() {
  const rows = el('div', { class: 'rows', id: 'log-rows', role: 'log', 'aria-live': 'polite' });
  const title = el('span', null, el('i'), 'thought log');
  const count = el('span', null, '0 rows');
  const root = el(
    'section',
    { class: 'chapter', id: 'log' },
    chapterTop('04 / Thought log', 'The loop, thinking out loud.', 'Every cycle step as it happens: collect, rank, the critic in full, each candidate with its fate and the reason.'),
    el('div', { class: 'term' }, el('div', { class: 'bar' }, title, count), rows),
  );
  let stickToBottom = true;
  rows.addEventListener('scroll', () => {
    stickToBottom = rows.scrollHeight - rows.scrollTop - rows.clientHeight < 24;
  });
  const render = (list: LogRow[]) => {
    clear(rows);
    for (const r of list) rows.appendChild(el('div', { class: `row ${r.tone}` }, el('span', { class: 't' }, fmt.clock(r.ts)), el('span', null, r.text)));
    count.textContent = `${list.length} rows`;
    if (stickToBottom) rows.scrollTop = rows.scrollHeight;
  };
  return {
    root,
    set(list: LogRow[]) {
      render(list);
    },
    append(list: LogRow[], added: LogRow[]) {
      // keep the DOM in step with the capped list: drop oldest rows, add the new ones
      while (rows.childElementCount + added.length > list.length && rows.firstChild) rows.removeChild(rows.firstChild);
      for (const r of added) rows.appendChild(el('div', { class: `row ${r.tone}` }, el('span', { class: 't' }, fmt.clock(r.ts)), el('span', null, r.text)));
      count.textContent = `${list.length} rows`;
      if (stickToBottom) rows.scrollTop = rows.scrollHeight;
    },
  };
}

/* ------------------------------------ 7. paper book ------------------------------------ */

export function paperBook(onRange: (r: EquityRange) => void) {
  const chart = el('div', { class: 'chart', id: 'equity-chart' });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Range' });
  const ranges: EquityRange[] = ['24h', '7d', '30d', 'all'];
  const buttons = new Map<EquityRange, HTMLButtonElement>();
  for (const r of ranges) {
    const b = el('button', { class: r === '7d' ? 'on' : null }, r);
    b.addEventListener('click', () => {
      for (const [k, x] of buttons) x.classList.toggle('on', k === r);
      onRange(r);
    });
    buttons.set(r, b);
    seg.appendChild(b);
  }
  const ens = el('div', { class: 'v num' }, 'n/a');
  const bench = el('div', { class: 'v num' }, 'n/a');
  const gap = el('div', { class: 'v num' }, 'n/a');
  const root = el(
    'section',
    { class: 'chapter', id: 'book' },
    chapterTop('05 / Paper book', 'Against buy and hold.', undefined, seg),
    el('p', { class: 'lede', style: 'margin-bottom:20px' }, 'The lane ensemble paper equity next to simply holding the first asset over the same period, both starting at 100. Fees, slippage and funding count.'),
    chart,
    el(
      'div',
      { class: 'metrics' },
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Ensemble'), ens),
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Buy and hold'), bench),
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Gap'), gap),
      el('div', { class: 'metric' }, el('div', { class: 'label' }, 'Mode'), el('div', { class: 'v' }, 'paper')),
    ),
  );
  let points: Array<{ ts: number; ensemble: number; benchmark: number }> = [];
  const draw = () => {
    const t = tokens();
    equityChart(chart, points, { cobalt: t.cobalt, fg3: t.fg3 });
  };
  window.addEventListener('ouro-theme', draw);
  return {
    root,
    update(p: typeof points) {
      points = p;
      draw();
      const last = p[p.length - 1];
      ens.textContent = last ? fmt.num(last.ensemble) : 'n/a';
      bench.textContent = last ? fmt.num(last.benchmark) : 'n/a';
      const g = last ? last.ensemble - last.benchmark : null;
      gap.textContent = fmt.signed(g);
      gap.className = `v num ${(g ?? 0) >= 0 ? 'good' : 'bad'}`;
    },
  };
}

/* ------------------------------------ 8. moments ------------------------------------ */

export function moments() {
  const list = el('div', { class: 'moments', id: 'moments-list' });
  const root = el('section', { class: 'chapter', id: 'moments' }, chapterTop('06 / Moments', 'Worth a post.', 'Notable events written by the loop itself: a new best, a ceiling, a lineage that survived, a cycle where every idea died on new data.'), list);
  return {
    root,
    update(lane: string, rows: Moment[]) {
      clear(list);
      if (!rows.length) list.appendChild(el('div', { class: 'empty' }, 'nothing notable yet'));
      for (const m of rows) {
        list.appendChild(
          el(
            'div',
            { class: 'moment' },
            el('div', { class: 'when' }, fmt.time(m.ts), el('b', null, `${m.lane} · ${m.kind.replace(/_/g, ' ')}`)),
            el('div', null, el('h3', null, m.title), el('p', null, m.body), m.strategyId ? el('a', { href: strategyPath(lane, m.strategyId) }, m.strategyId) : null),
          ),
        );
      }
    },
  };
}

/* ------------------------------------ 9. graveyard ------------------------------------ */

export function graveyard(onMore: () => void) {
  const tbody = el('tbody');
  const more = el('button', { class: 'btn more' }, 'load more');
  more.addEventListener('click', onMore);
  const table = el(
    'table',
    null,
    el('thead', null, el('tr', null, el('th', null, 'id'), el('th', null, 'origin'), el('th', { class: 'num' }, 'born'), el('th', { class: 'num' }, 'died'), el('th', { class: 'num' }, 'lived'), el('th', null, 'epitaph'), el('th', null, 'reason'), el('th', { class: 'num' }, 'holdout'), el('th', { class: 'num' }, 'CI'))),
    tbody,
  );
  const root = el('section', { class: 'chapter', id: 'graveyard' }, chapterTop('07 / Graveyard', 'Everything that died, and why.', 'Retired strategies lost their slot to a better candidate. Rejected ones never made it in: sandbox, guards, train margin or holdout.'), el('div', { class: 'tablewrap' }, table), more);
  return {
    root,
    update(lane: string, rows: GraveRow[], hasMore: boolean) {
      clear(tbody);
      if (!rows.length) tbody.appendChild(el('tr', null, el('td', { colspan: '9', class: 'empty' }, 'nothing has died yet')));
      for (const r of rows) {
        tbody.appendChild(
          el(
            'tr',
            null,
            el('td', { class: 'id' }, el('a', { href: strategyPath(lane, r.id) }, r.id)),
            originCell(r.origin),
            el('td', { class: 'num' }, `c${r.born}`),
            el('td', { class: 'num' }, `c${r.died}`),
            el('td', { class: 'num' }, r.lifespan === 0 ? 'never lived' : `${r.lifespan} cycles`),
            el('td', { class: 'desc' }, r.describe),
            el('td', { class: 'desc' }, r.reason),
            el('td', { class: 'num' }, fmt.signed(r.holdoutScore, 3)),
            el('td', { class: 'num' }, fmt.signed(r.ci)),
          ),
        );
      }
      more.classList.toggle('hidden', !hasMore);
    },
  };
}

/* ------------------------------------ 10. kill switch ------------------------------------ */

const ACTION_TEXT: Record<string, string> = {
  pause: 'paused',
  resume: 'resumed',
  approval_on: 'approval switched on',
  approval_off: 'approval switched off',
  approve: 'cycle approved',
  reject: 'cycle rejected',
  rollback: 'rolled back',
  budget: 'budget changed',
  budget_pause: 'paused by budget',
  budget_resume: 'resumed after budget reset',
  drill: 'kill switch drill',
};

export function killSwitch() {
  const states = el('div', { class: 'lanes-state' });
  const tbody = el('tbody');
  const table = el('table', null, el('thead', null, el('tr', null, el('th', null, 'when'), el('th', null, 'lane'), el('th', null, 'action'), el('th', null, 'by'), el('th', null, 'note'))), tbody);
  const root = el(
    'section',
    { class: 'chapter', id: 'switch' },
    chapterTop('08 / The switch', 'Off means off.', 'The current state of every lane and the full control log. The page has no buttons; every change is an admin command on the server, and every one is recorded.'),
    el('div', { class: 'switch-grid' }, states, el('div', { class: 'tablewrap' }, table)),
  );
  const stateText: Record<LaneState, string> = { running: 'trading and cycling', paused: 'no new trades, no cycles', pending: 'a cycle is waiting for approval', error: 'last cycle failed, still trading', stopped: 'runner is down' };
  return {
    root,
    updateStates(lanes: Lane[], health: Health | null) {
      clear(states);
      for (const l of lanes) {
        const h = health?.lanes[l.id];
        const st: LaneState = h?.state ?? l.status;
        states.appendChild(el('div', { class: 'lane-state' }, el('span', { class: 'n' }, l.name), el('span', null, el('span', { class: `pill ${st}` }, st), el('div', { class: 'd' }, stateText[st] ?? st)), el('span', { class: 'd' }, h?.lastCycleTs ? `last cycle ${fmt.ago(h.lastCycleTs)} ago` : '')));
      }
    },
    updateLog(rows: ControlRow[]) {
      clear(tbody);
      if (!rows.length) tbody.appendChild(el('tr', null, el('td', { colspan: '5', class: 'empty' }, 'no admin action yet')));
      for (const r of rows) tbody.appendChild(el('tr', null, el('td', { class: 'num' }, fmt.time(r.ts)), el('td', null, r.lane), el('td', null, ACTION_TEXT[r.action] ?? r.action), el('td', null, r.actor), el('td', { class: 'desc' }, r.note)));
    },
  };
}

/* ------------------------------------ 11. ledger ------------------------------------ */

export function ledger() {
  const list = el('div', { class: 'ledger' });
  const root = el(
    'section',
    { class: 'chapter', id: 'ledger' },
    chapterTop('09 / Ledger', 'Numbers you can check.', 'Every hour each lane exports its full state, the file is hashed, and the hash is chained to the previous one. A daily copy goes to a public repo, so nothing here can be edited later without breaking the chain.'),
    list,
  );
  return {
    root,
    update(l: Ledger) {
      clear(list);
      list.appendChild(el('div', { class: 'row head' }, el('span', null, 'lane'), el('span', null, 'latest hash'), el('span', null, 'entries'), el('span', null, 'chain')));
      for (const [lane, v] of Object.entries(l.lanes)) {
        list.appendChild(
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'mono' }, lane),
            el('span', { class: 'hash', title: v.latest?.sha256 ?? '' }, v.latest ? `${v.latest.sha256} · ${fmt.time(v.latest.ts)}` : 'no entry yet'),
            el('span', { class: 'mono num' }, fmt.int(v.count)),
            el('span', { class: v.chainOk ? 'ok' : 'no' }, v.chainOk ? 'valid' : 'broken'),
          ),
        );
      }
      list.appendChild(el('div', { class: 'row' }, el('span', null), el('span', null, el('a', { href: l.repo, target: '_blank', rel: 'noopener' }, l.repo), ' holds the daily copies and explains how to recompute the hashes.')));
    },
  };
}

/* ------------------------------------ 12. how it works ------------------------------------ */

export function howItWorks(): HTMLElement {
  return el(
    'section',
    { class: 'chapter', id: 'how' },
    chapterTop('10 / How it works', 'Six lines.'),
    el(
      'div',
      { class: 'how' },
      el(
        'div',
        { class: 'lines' },
        el('p', null, el('span', null, 'Each lane is one OURO loop with a goal, a data source and a scorer. No strategy is written by a person.')),
        el('p', null, el('span', null, 'The loop asks a model for eight strategies, runs them in a sandbox on live Hyperliquid candles, on paper.')),
        el('p', null, el('span', null, 'Every 40 trades per strategy, or every 6 hours, a cycle ranks them and a critic reads the worst and best trades.')),
        el('p', null, el('span', null, 'New candidates are written from that diagnosis: mutations, a crossbreed and a fresh idea.')),
        el('p', null, el('span', null, 'A candidate only replaces a live strategy if it wins on old data and on data nobody has seen yet.')),
        el('p', null, el('span', null, 'Everything is logged, hashed hourly and published. The switch on the server can pause, reject or roll back any lane.')),
      ),
      el(
        'div',
        null,
        el('p', { class: 'lede', style: 'margin-bottom:18px' }, 'The SDK behind this page is open source. The docs explain the loop, the guards and the Capability Index in detail.'),
        el('a', { class: 'btn', href: 'https://ourosi.xyz/#docs' }, 'Read the OURO docs'),
        el('div', { class: 'note', style: 'margin-top:28px' }, el('b', null, 'Paper trading only.'), ' Nothing here is financial advice or a trading signal.'),
      ),
    ),
  );
}

/* ------------------------------------ tree panel ------------------------------------ */

export function treePanel() {
  const canvas = el('canvas', { 'aria-label': 'Family tree of strategies', role: 'img' });
  const tip = el('div', { class: 'tip hidden' });
  const reset = el('button', { class: 'btn reset', type: 'button' }, 'reset view');
  const root = el(
    'div',
    { class: 'tree', id: 'tree' },
    el('span', { class: 'title' }, 'family tree · one ring per cycle'),
    canvas,
    tip,
    reset,
    el('div', { class: 'legend' }, el('span', null, el('i', { class: 'live' }), 'alive'), el('span', null, el('i', { class: 'best' }), 'best lineage'), el('span', null, el('i', { class: 'dead' }), 'dead')),
  );
  return {
    root,
    canvas,
    reset,
    showTip(h: { id: string; origin: string; ci: number | null; x: number; y: number } | null) {
      if (!h) {
        tip.classList.add('hidden');
        return;
      }
      replace(tip, `${h.id} · ${h.origin} · CI ${fmt.signed(h.ci)}`);
      tip.style.left = `${h.x}px`;
      tip.style.top = `${h.y}px`;
      tip.classList.remove('hidden');
    },
  };
}
