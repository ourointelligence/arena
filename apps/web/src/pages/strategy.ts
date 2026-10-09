// The strategy page: code, params and bounds, lineage, explanation, CI over time, trades, equity, share card.
import { api, ApiError } from '../api.ts';
import { ciChart, strategyEquityChart } from '../charts.ts';
import { clear, el, fmt } from '../dom.ts';
import { highlightInto } from '../highlight.ts';
import { buildFooter, buildNav } from '../nav.ts';
import { arenaPath, strategyPath } from '../router.ts';
import { tokens } from '../theme.ts';
import type { PageHandle } from './arena.ts';
import type { Strategy, Trade } from '../types.ts';

function kv(rows: Array<[string, string | HTMLElement]>): HTMLElement {
  const box = el('div', { class: 'kv' });
  for (const [k, v] of rows) box.append(el('b', null, k), el('span', null, v));
  return box;
}

export async function strategyPage(lane: string, id: string): Promise<PageHandle> {
  const root = el('div', { id: 'strategy-page' });
  root.appendChild(buildNav());
  const main = el('main', { class: 'wrap spage' });
  root.appendChild(main);
  root.appendChild(buildFooter());

  let s: Strategy;
  let trades: Trade[] = [];
  try {
    [s, trades] = await Promise.all([api.strategy(lane, id), api.trades(lane, id).catch(() => [] as Trade[])]);
  } catch (err) {
    const missing = err instanceof ApiError && err.status === 404;
    main.appendChild(el('div', { class: 'msg' }, missing ? `No strategy ${id} in the ${lane} lane.` : 'The Arena API is not reachable right now.'));
    main.appendChild(el('a', { class: 'btn', href: arenaPath(lane) }, 'back to the arena'));
    return { root, destroy: () => undefined };
  }

  const shareUrl = `${location.origin}${strategyPath(lane, id)}`;
  const copyBtn = el('button', { class: 'copy', type: 'button', id: 'copy-link' }, 'copy link');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copyBtn.textContent = 'copied';
    } catch {
      copyBtn.textContent = 'copy failed';
    }
    setTimeout(() => (copyBtn.textContent = 'copy link'), 1500);
  });

  const head = el(
    'div',
    { class: 'head' },
    el(
      'div',
      null,
      el('div', { class: 'crumbs' }, el('a', { href: arenaPath(lane) }, 'arena'), ` / ${lane} / ${s.id}`),
      el('h1', null, s.id),
      el('p', { class: 'lede', style: 'margin-top:16px' }, s.describe || 'no description'),
    ),
    el(
      'div',
      { class: 'kpis' },
      el('div', { class: 'kpi' }, el('div', { class: 'label' }, 'Status'), el('div', { class: `v ${s.status === 'live' ? 'co' : 'dim'}` }, s.status)),
      el('div', { class: 'kpi' }, el('div', { class: 'label' }, 'CI'), el('div', { class: `v num ${(s.ci ?? 0) >= 0 ? 'good' : 'bad'}` }, fmt.signed(s.ci))),
      el('div', { class: 'kpi' }, el('div', { class: 'label' }, 'Forward'), el('div', { class: 'v num' }, s.forwardScore === null ? 'n/a' : fmt.signed(s.forwardScore, 3))),
    ),
  );

  const code = el('code', { class: 'language-typescript' });
  highlightInto(code, s.code);
  const codeBlock = el('div', { class: 'block' }, el('h2', null, 'Code'), el('div', { class: 'code' }, el('div', { class: 'hd' }, el('span', null, `.ouro/population/${s.id}.ts`), el('span', null, 'read only')), el('pre', null, code)));

  const paramsTbody = el('tbody');
  for (const [k, v] of Object.entries(s.params)) {
    const b = s.bounds[k];
    paramsTbody.appendChild(el('tr', null, el('td', { class: 'id' }, k), el('td', { class: 'num' }, String(v)), el('td', { class: 'num' }, b ? String(b.min) : 'n/a'), el('td', { class: 'num' }, b ? String(b.max) : 'n/a'), el('td', { class: 'num' }, b ? String(b.step) : 'n/a')));
  }
  const paramsBlock = el(
    'div',
    { class: 'block' },
    el('h2', null, 'Params and bounds'),
    el('div', { class: 'tablewrap' }, el('table', { id: 'params', style: 'min-width:0' }, el('thead', null, el('tr', null, el('th', null, 'param'), el('th', { class: 'num' }, 'value'), el('th', { class: 'num' }, 'min'), el('th', { class: 'num' }, 'max'), el('th', { class: 'num' }, 'step'))), paramsTbody)),
  );

  const linkList = (ids: string[], cls: string) => {
    const box = el('span', { class: `links ${cls}` });
    if (!ids.length) box.appendChild(el('span', { class: 'dim' }, 'none'));
    for (const pid of ids) box.appendChild(el('a', { href: strategyPath(lane, pid) }, pid));
    return box;
  };
  const lineageBlock = el(
    'div',
    { class: 'block' },
    el('h2', null, 'Lineage'),
    kv([
      ['origin', s.origin],
      ['born', `cycle ${s.bornCycle}`],
      ['died', s.diedCycle === null ? 'still alive' : `cycle ${s.diedCycle}${s.rejectReason ? ` (${s.rejectReason})` : ''}`],
      ['parents', linkList(s.parents, 'parents')],
      ['children', linkList(s.children, 'children')],
      ['model', s.model],
      ['train score', fmt.signed(s.trainScore, 3)],
      ['holdout score', fmt.signed(s.holdoutScore, 3)],
      ['trades', `${s.trades} (${s.forwardTrades} after promotion)`],
      ['forward score', s.forwardScore === null ? 'n/a' : fmt.signed(s.forwardScore, 3)],
    ]),
  );

  const explainBlock = el('div', { class: 'block' }, el('h2', null, 'Explanation'), el('p', { class: 'explain', id: 'explanation' }, s.explanation || 'No explanation recorded.'));

  const ciBox = el('div', { class: 'chart', id: 'ci-chart' });
  const eqBox = el('div', { class: 'chart', id: 'strategy-equity' });
  const draw = () => {
    const t = tokens();
    ciChart(ciBox, s.ciHistory, t.cobalt);
    strategyEquityChart(eqBox, s.equity, t.flame);
  };
  window.addEventListener('ouro-theme', draw);
  const chartsBlock = el('div', { class: 'block' }, el('h2', null, 'CI over time'), ciBox, el('h2', { style: 'margin-top:28px' }, 'Own equity'), eqBox);

  const tbody = el('tbody');
  if (!trades.length) tbody.appendChild(el('tr', null, el('td', { colspan: '11', class: 'empty' }, 'no closed trades yet')));
  for (const t of trades) {
    tbody.appendChild(
      el(
        'tr',
        null,
        el('td', { class: 'num' }, fmt.time(t.closedAt)),
        el('td', null, t.asset),
        el('td', null, t.side),
        el('td', { class: 'num' }, fmt.num(t.size, 3)),
        el('td', { class: 'num' }, fmt.num(t.entry, 2)),
        el('td', { class: 'num' }, fmt.num(t.exit, 2)),
        el('td', { class: `num ${t.pnl >= 0 ? 'good' : 'bad'}` }, fmt.signed(t.pnl, 3)),
        el('td', { class: 'num' }, fmt.num(t.fees, 3)),
        el('td', { class: 'num' }, fmt.signed(t.funding, 3)),
        el('td', { class: 'num' }, fmt.num(t.drawdown, 3)),
        el('td', { class: `num ${t.score >= 0 ? 'good' : 'bad'}` }, fmt.signed(t.score, 3)),
      ),
    );
  }
  const openBox = el('div');
  if (s.openPositions.length) {
    openBox.appendChild(el('p', { class: 'lede', style: 'margin:0 0 12px;font-size:14px' }, `Open now (shown 15 minutes after opening): ${s.openPositions.map((o) => `${o.side} ${o.asset} size ${o.size} from ${fmt.num(o.entry, 2)}`).join('; ')}`));
  }
  const tradesBlock = el(
    'div',
    { class: 'block', style: 'margin-top:36px' },
    el('h2', null, 'Trades'),
    openBox,
    el('div', { class: 'tablewrap' }, el('table', { id: 'trades' }, el('thead', null, el('tr', null, el('th', null, 'closed'), el('th', null, 'asset'), el('th', null, 'side'), el('th', { class: 'num' }, 'size'), el('th', { class: 'num' }, 'entry'), el('th', { class: 'num' }, 'exit'), el('th', { class: 'num' }, 'pnl'), el('th', { class: 'num' }, 'fees'), el('th', { class: 'num' }, 'funding'), el('th', { class: 'num' }, 'drawdown'), el('th', { class: 'num' }, 'score'))), tbody)),
  );

  const card = el('img', { class: 'card', id: 'share-card', src: api.ogUrl(lane, id), alt: `Share card for ${s.id}`, loading: 'lazy' });
  const shareBlock = el('div', { class: 'block' }, el('h2', null, 'Share card'), card, el('div', { class: 'share' }, copyBtn, el('span', { class: 'url' }, shareUrl)));

  main.append(head, el('div', { class: 'two' }, el('div', null, codeBlock, el('div', { style: 'height:28px' }), explainBlock), el('div', null, paramsBlock, el('div', { style: 'height:28px' }), lineageBlock, el('div', { style: 'height:28px' }), shareBlock)), el('div', { class: 'two' }, chartsBlock, el('div')), tradesBlock);
  draw();
  requestAnimationFrame(draw);

  return {
    root,
    destroy() {
      window.removeEventListener('ouro-theme', draw);
      clear(root);
    },
  };
}
