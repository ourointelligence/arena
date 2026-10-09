import { describe, expect, it } from 'vitest';
import { escapeText, fmt } from '../src/dom.ts';

describe('escapeText', () => {
  it('neutralises every markup character', () => {
    expect(escapeText(`<img src=x onerror="alert('1')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  });
  it('leaves plain text alone', () => {
    expect(escapeText('Hull 21 cross up, ATR stop')).toBe('Hull 21 cross up, ATR stop');
  });
});

describe('fmt', () => {
  it('formats numbers defensively', () => {
    expect(fmt.signed(0.1234)).toBe('+0.12');
    expect(fmt.signed(-1)).toBe('-1.00');
    expect(fmt.signed(null)).toBe('n/a');
    expect(fmt.num(NaN)).toBe('n/a');
    expect(fmt.int(1234567)).toBe('1,234,567');
    expect(fmt.usd(0.4)).toBe('$0.40');
  });
  it('formats ages and durations', () => {
    const now = 10_000_000;
    expect(fmt.ago(now - 5_000, now)).toBe('5s');
    expect(fmt.ago(now - 300_000, now)).toBe('5m');
    expect(fmt.ago(now - 7_200_000, now)).toBe('2h');
    expect(fmt.duration(90_000_000)).toBe('1d 1h');
    expect(fmt.duration(5_400_000)).toBe('1h 30m');
    expect(fmt.clock(Date.UTC(2026, 0, 1, 13, 5, 9))).toBe('13:05:09');
  });
});
