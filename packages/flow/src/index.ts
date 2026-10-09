import type { Bar, FeatureValue, PrimitivePack } from '@ourointelligence/sdk';

/** Bars used for the funding z-score (48 bars of 15m is twelve hours). */
export const FUNDING_Z_WINDOW = 48;

function ext(bar: Bar | undefined, key: string): number | null {
  const v = bar?.ext?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Bars per hour for a bar's timeframe, from the gap between it and the previous bar (falls back to 15m). */
function barsPerHour(bars: Bar[], i: number): number {
  const a = bars[i];
  const b = bars[i - 1];
  const ms = a && b && a.ts > b.ts ? a.ts - b.ts : 900_000;
  return Math.max(1, Math.round(3_600_000 / ms));
}

function oiChange(bars: Bar[], i: number, hours: number): FeatureValue {
  const back = barsPerHour(bars, i) * hours;
  const now = ext(bars[i], 'oi');
  const then = ext(bars[i - back], 'oi');
  if (now === null || then === null || then === 0) return null;
  return now / then - 1;
}

/**
 * Flow pack: market structure features that come with the bar from the exchange rather than from price.
 * Every feature reads only bars[0..i]; nothing looks ahead.
 */
export const flow: PrimitivePack = {
  name: 'flow',
  compute(bars, i) {
    const bar = bars[i];
    const funding = ext(bar, 'funding.rate');
    let fundingZ: FeatureValue = null;
    if (funding !== null) {
      const xs: number[] = [];
      for (let k = Math.max(0, i - FUNDING_Z_WINDOW + 1); k <= i; k++) {
        const v = ext(bars[k], 'funding.rate');
        if (v !== null) xs.push(v);
      }
      if (xs.length >= 8) {
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
        fundingZ = sd > 0 ? (funding - mean) / sd : 0;
      }
    }
    const mark = ext(bar, 'mark');
    const oracle = ext(bar, 'oracle');
    return {
      funding,
      fundingZ,
      oiChange1h: oiChange(bars, i, 1),
      oiChange4h: oiChange(bars, i, 4),
      premium: ext(bar, 'premium'),
      basis: mark !== null && oracle !== null && oracle !== 0 ? mark / oracle - 1 : null,
    };
  },
  describe() {
    return [
      { key: 'funding', doc: 'Current hourly funding rate as a decimal; positive means longs pay shorts.' },
      { key: 'fundingZ', doc: `Funding rate z-score over the last ${FUNDING_Z_WINDOW} bars; above 2 means funding is unusually high for the period.` },
      { key: 'oiChange1h', doc: 'Open interest change over the last hour as a fraction; 0.05 means 5 percent more contracts open than an hour ago.' },
      { key: 'oiChange4h', doc: 'Open interest change over the last four hours as a fraction.' },
      { key: 'premium', doc: 'Perp premium over the index as reported by the exchange, a decimal.' },
      { key: 'basis', doc: 'Mark price divided by oracle price minus one; positive when the perp trades above spot.' },
    ];
  },
};

export default flow;
