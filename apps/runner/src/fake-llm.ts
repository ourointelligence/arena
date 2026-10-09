import type { LLM } from '@ourointelligence/sdk';

/**
 * The scripted fake model used by the integration tests (ARENA_FAKE_LLM=1). It answers the real Generator and
 * Critic prompts with valid TA strategies, and once each: a broken JSON reply, an adapter timeout, and a strategy
 * that tries to import a module (which the sandbox must reject).
 */
const bands: Array<[number, number, number]> = [
  [30, 70, 2],
  [35, 65, 1.5],
  [25, 75, 2.5],
  [40, 60, 1],
  [20, 80, 3],
  [45, 55, 1],
  [30, 75, 2],
  [35, 70, 1.5],
  [28, 72, 2],
  [33, 67, 2.5],
];

export function taStrategy(low: number, high: number, stopAtr: number, extra = ''): string {
  return `export const params = { low: ${low}, high: ${high}, stopAtr: ${stopAtr}, size: 0.05 };
export const bounds = { low: { min: 10, max: 50, step: 1 }, high: { min: 50, max: 90, step: 1 }, stopAtr: { min: 0.5, max: 4, step: 0.5 }, size: { min: 0.01, max: 0.1, step: 0.01 } };
${extra}
export function decide(x: Input, p: typeof params): Decision {
  const rsi = x.features['ta.rsi14'];
  const atr = x.features['ta.atr14'];
  if (typeof rsi !== 'number' || typeof atr !== 'number') return null;
  if (rsi < p.low) return { side: 'long', size: p.size, stop: p.stopAtr * atr, tp: 2 * p.stopAtr * atr };
  if (rsi > p.high) return { side: 'short', size: p.size, stop: p.stopAtr * atr, tp: 2 * p.stopAtr * atr };
  return null;
}
export const describe = 'RSI mean reversion with band ${low} to ${high} and an ATR stop of ${stopAtr}.';`;
}

export function scriptedFakeLLM(seed = 1): LLM & { calls: number } {
  let k = seed;
  let generatorCalls = 0;
  const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
  const one = (extra = '') => {
    const [low, high, stopAtr] = bands[k++ % bands.length]!;
    const jitter = (k % 3) - 1;
    return {
      code: taStrategy(low + jitter, high - jitter, stopAtr, extra),
      params: { low: low + jitter, high: high - jitter, stopAtr, size: 0.05 },
      bounds: { low: { min: 10, max: 50, step: 1 }, high: { min: 50, max: 90, step: 1 }, stopAtr: { min: 0.5, max: 4, step: 0.5 }, size: { min: 0.01, max: 0.1, step: 0.01 } },
      rationale: `RSI band ${low + jitter} to ${high - jitter}`,
    };
  };
  const llm = {
    name: 'fake:scripted',
    calls: 0,
    async complete({ system, user }: { system: string; user: string }) {
      llm.calls++;
      if (/Critic/.test(system)) {
        return { text: JSON.stringify({ patterns: ['Losses cluster when RSI stays extreme for several bars.', 'Wins come from quick reversals near the band edges.'], summary: 'Tighten the stop and widen the RSI band on the weak strategies.', weakIds: [], strongIds: [] }), usage: usage(1800, 90), model: 'fake-model' };
      }
      const task = /^TASK: (\w+)/m.exec(user)?.[1] ?? 'unknown';
      if (task === 'seed') {
        const n = Number(/Write (\d+) strategies/.exec(user)?.[1] ?? 1);
        return { text: JSON.stringify({ strategies: Array.from({ length: n }, () => one()) }), usage: usage(4000, 3000), model: 'fake-model' };
      }
      generatorCalls++;
      // once each: broken JSON (the loop asks again), an outage of three timeouts in a row (longer than the loop's
      // two retries, so that cycle ends as llm_error), and an import attempt (the sandbox must reject it)
      if (generatorCalls === 2) return { text: '{"code": "export const params = {', usage: usage(1500, 20), model: 'fake-model' };
      if (generatorCalls >= 5 && generatorCalls <= 7) throw new Error('adapter: request timed out after 60000 ms');
      if (generatorCalls === 9) return { text: JSON.stringify(one(`import fs from 'node:fs';`)), usage: usage(1500, 400), model: 'fake-model' };
      return { text: JSON.stringify(one()), usage: usage(1500, 400), model: 'fake-model' };
    },
  };
  return llm;
}
