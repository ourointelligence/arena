// Same theme handling as the main site: data-theme on <html>, saved under localStorage key ouro-theme.
const KEY = 'ouro-theme';
const root = () => document.documentElement;

export function isDark(): boolean {
  const t = root().getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function loadTheme(): void {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') root().setAttribute('data-theme', saved);
  } catch {
    // storage blocked: follow the system
  }
}

export function toggleTheme(): void {
  const next = isDark() ? 'light' : 'dark';
  root().setAttribute('data-theme', next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event('ouro-theme'));
}

/** Resolved colour tokens, read from CSS so canvas drawings follow the theme. */
export function tokens(): Record<'bg' | 'fg' | 'fg2' | 'fg3' | 'rule' | 'rule2' | 'soft' | 'cobalt' | 'flame' | 'good' | 'bad', string> {
  const cs = getComputedStyle(root());
  const get = (n: string) => cs.getPropertyValue(n).trim();
  return { bg: get('--bg'), fg: get('--fg'), fg2: get('--fg2'), fg3: get('--fg3'), rule: get('--rule'), rule2: get('--rule2'), soft: get('--soft'), cobalt: get('--cobalt'), flame: get('--flame'), good: get('--good'), bad: get('--bad') };
}
