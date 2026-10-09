import type { Db } from './db.js';
import { parseJson } from './db.js';
import type { ArenaEventMap, ArenaEventType, LaneId, MomentKind, MomentRow } from './types.js';

export type Moments = {
  /** Evaluate every rule that the event could have triggered. Returns the moments written (none when deduped). */
  check<K extends ArenaEventType>(type: K, payload: ArenaEventMap[K], ts?: number): MomentRow[];
};

const LANE_NAMES: Record<LaneId, string> = { core: 'Core', alts: 'Alts', flow: 'Flow' };

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '.';
}

/**
 * Writes a moments row for each notable event, in plain language, at most once per trigger (the `key` column is
 * unique per lane). Titles stay under 80 characters and bodies under 280 so they can be posted as they are.
 */
export function createMoments(db: Db, lane: LaneId, opts: { now?: () => number } = {}): Moments {
  const now = opts.now ?? (() => Date.now());
  const name = LANE_NAMES[lane];
  const insert = db.prepare('INSERT OR IGNORE INTO moments (lane_id, ts, kind, title, body, strategy_id, key) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const write = (kind: MomentKind, key: string, title: string, body: string, strategyId: string | null, ts: number): MomentRow | null => {
    const t = clip(title, 79);
    const b = clip(body, 279);
    const r = insert.run(lane, ts, kind, t, b, strategyId, key);
    if (r.changes === 0) return null;
    return { id: Number(r.lastInsertRowid), lane_id: lane, ts, kind, title: t, body: b, strategy_id: strategyId };
  };

  const q = {
    prevBest: db.prepare('SELECT MAX(best_ci) AS v FROM cycles WHERE lane_id = ? AND n < ? AND best_ci IS NOT NULL'),
    prevCycle: db.prepare('SELECT ceiling, outcome FROM cycles WHERE lane_id = ? AND n < ? ORDER BY n DESC LIMIT 1'),
    candidates: db.prepare('SELECT stage, reason FROM candidates WHERE lane_id = ? AND cycle = ?'),
    born: db.prepare('SELECT COUNT(*) AS n FROM strategies WHERE lane_id = ?'),
    live: db.prepare("SELECT id, parents, born_cycle, describe, ci FROM strategies WHERE lane_id = ? AND status = 'live'"),
    strategy: db.prepare('SELECT id, parents, born_cycle, describe, ci, holdout_score, forward_score, forward_trades FROM strategies WHERE lane_id = ? AND id = ?'),
    best: db.prepare("SELECT id, describe, ci FROM strategies WHERE lane_id = ? AND status = 'live' AND ci IS NOT NULL ORDER BY ci DESC LIMIT 1"),
    promotions: db.prepare("SELECT COUNT(*) AS n FROM moments WHERE lane_id = ? AND kind = 'first_promotion'"),
  };

  const rootOf = (id: string, seen = new Set<string>()): { id: string; born: number } | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const s = q.strategy.get(lane, id) as { id: string; parents: string; born_cycle: number } | undefined;
    if (!s) return null;
    const parents = parseJson<string[]>(s.parents, []);
    for (const pid of parents) {
      const r = rootOf(pid, seen);
      if (r) return r;
    }
    return { id: s.id, born: s.born_cycle };
  };

  function check<K extends ArenaEventType>(type: K, payload: ArenaEventMap[K], ts = now()): MomentRow[] {
    const out: MomentRow[] = [];
    const push = (m: MomentRow | null) => {
      if (m) out.push(m);
    };
    const p = payload as any;
    switch (type) {
      case 'cycle:end': {
        const n = Number(p.cycle);
        const prevBest = (q.prevBest.get(lane, n) as { v: number | null }).v;
        if (typeof p.bestCI === 'number' && Number.isFinite(p.bestCI) && prevBest !== null && p.bestCI > prevBest) {
          const best = q.best.get(lane) as { id: string; describe: string; ci: number } | undefined;
          push(
            write(
              'best_ci',
              `best_ci:${n}`,
              `${name} lane: new best Capability Index ${fmt(p.bestCI)}`,
              `After cycle ${n} the best live strategy${best ? ` (${best.id})` : ''} scores ${fmt(p.bestCI)} against the seed generation on unseen data, up from ${fmt(prevBest)}.${best?.describe ? ` ${best.describe}` : ''}`,
              best?.id ?? null,
              ts,
            ),
          );
        }
        const cands = q.candidates.all(lane, n) as Array<{ stage: string; reason: string | null }>;
        if (cands.length > 0 && cands.every((c) => c.reason === 'holdout')) {
          push(
            write(
              'all_died_holdout',
              `all_died_holdout:${n}`,
              `${name} lane, cycle ${n}: every candidate failed on new data`,
              'Every idea this cycle looked good on old data and failed on new data. Nothing was promoted.',
              null,
              ts,
            ),
          );
        }
        const prev = q.prevCycle.get(lane, n) as { ceiling: number } | undefined;
        const prevCeiling = !!prev?.ceiling;
        if (p.ceiling && !prevCeiling) {
          push(
            write(
              'ceiling_raised',
              `ceiling_raised:${n}`,
              `${name} lane has hit a ceiling`,
              `The population Capability Index has moved less than 0.01 per cycle for three cycles in a row, as of cycle ${n}. The strategies have used up what the current primitives offer.`,
              null,
              ts,
            ),
          );
        } else if (!p.ceiling && prevCeiling) {
          push(
            write(
              'ceiling_cleared',
              `ceiling_cleared:${n}`,
              `${name} lane is improving again`,
              `The ceiling flag was cleared at cycle ${n}: the population Capability Index is moving again after a flat stretch.`,
              null,
              ts,
            ),
          );
        }
        for (const s of q.live.all(lane) as Array<{ id: string; parents: string; born_cycle: number; describe: string }>) {
          const root = rootOf(s.id);
          if (!root) continue;
          if (n - root.born >= 10) {
            push(
              write(
                'lineage_10',
                `lineage_10:${root.id}`,
                `${name} lane: a lineage has survived 10 cycles`,
                `The line that started with ${root.id} in cycle ${root.born} still has a living descendant (${s.id}) at cycle ${n}. ${s.describe}`,
                s.id,
                ts,
              ),
            );
          }
        }
        break;
      }
      case 'promote': {
        const count = (q.promotions.get(lane) as { n: number }).n;
        if (count === 0) {
          const s = q.strategy.get(lane, p.id) as { describe: string } | undefined;
          push(
            write(
              'first_promotion',
              'first_promotion',
              `${name} lane: first promotion`,
              `${p.id} beat the population on old data and on unseen data in cycle ${p.cycle} and replaced ${p.replaces}. ${s?.describe ?? ''}`.trim(),
              p.id,
              ts,
            ),
          );
        }
        break;
      }
      case 'candidate': {
        const born = (q.born.get(lane) as { n: number }).n;
        if (born === 100 || born === 500) {
          push(
            write(
              born === 100 ? 'born_100' : 'born_500',
              `born_${born}`,
              `${name} lane: strategy number ${born} was born`,
              `OURO has now written ${born} strategies in the ${name} lane, all by itself. The newest is ${p.id}, a ${p.origin} born in cycle ${p.cycle}.`,
              p.id,
              ts,
            ),
          );
        }
        break;
      }
      case 'trade:close': {
        const s = q.strategy.get(lane, p.strategyId) as
          | { id: string; describe: string; holdout_score: number | null; forward_score: number | null; forward_trades: number }
          | undefined;
        if (s && s.forward_trades >= 20 && s.holdout_score !== null && s.forward_score !== null && s.forward_score > s.holdout_score) {
          push(
            write(
              'forward_beats_holdout',
              `forward_beats_holdout:${s.id}`,
              `${name} lane: ${s.id} does better live than in its trial`,
              `After ${s.forward_trades} trades since promotion, ${s.id} averages ${fmt(s.forward_score, 3)} per trade against ${fmt(s.holdout_score, 3)} on its holdout trial. ${s.describe}`,
              s.id,
              ts,
            ),
          );
        }
        break;
      }
      case 'control': {
        const action = String(p.action);
        const note = p.note ? ` ${p.note}` : '';
        const id = Number(p.id ?? ts);
        if (action === 'pause') push(write('pause', `pause:${id}`, `${name} lane paused`, `The ${name} lane was paused by ${p.actor}. No new trades open until it is resumed.${note}`, null, ts));
        else if (action === 'resume') push(write('resume', `resume:${id}`, `${name} lane resumed`, `The ${name} lane is trading again after ${p.actor} resumed it.${note}`, null, ts));
        else if (action === 'approve') push(write('approve', `approve:${id}`, `${name} lane: a pending cycle was approved`, `${p.actor} read the Critic's diagnosis and approved the promotions.${note}`, null, ts));
        else if (action === 'reject') push(write('reject', `reject:${id}`, `${name} lane: a pending cycle was rejected`, `${p.actor} read the Critic's diagnosis and rejected the promotions. The population stays as it was.${note}`, null, ts));
        else if (action === 'rollback') push(write('rollback', `rollback:${id}`, `${name} lane rolled back`, `${p.actor} restored an earlier population. Strategies born after that point are marked rolled back; nothing is deleted.${note}`, null, ts));
        else if (action === 'budget_pause') push(write('budget_pause', `budget_pause:${id}`, `${name} lane paused itself: daily budget reached`, `The lane spent its model budget for the day and paused. It resumes at 00:00 UTC.${note}`, null, ts));
        break;
      }
      case 'budget': {
        if (p.action === 'pause') {
          push(
            write(
              'budget_pause',
              `budget_pause:${Math.floor(ts / 86_400_000)}`,
              `${name} lane paused itself: daily budget reached`,
              `The lane spent $${Number(p.usd).toFixed(2)} of its $${Number(p.budgetUsd).toFixed(2)} model budget for the day and paused. It resumes at 00:00 UTC.`,
              null,
              ts,
            ),
          );
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  return { check };
}
