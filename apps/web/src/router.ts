export const BASE = '/arena';

export type Route = { page: 'arena'; lane: string | null } | { page: 'strategy'; lane: string; id: string } | { page: 'missing' };

export function parseRoute(pathname: string, search = ''): Route {
  const p = pathname.replace(/\/+$/, '');
  if (p === '' || p === BASE || p === `${BASE}/index.html`) {
    const lane = new URLSearchParams(search).get('lane');
    return { page: 'arena', lane };
  }
  const m = new RegExp(`^${BASE}/s/([a-z]+)/([\\w-]+)$`).exec(p);
  if (m) return { page: 'strategy', lane: m[1]!, id: m[2]! };
  return { page: 'missing' };
}

export function strategyPath(lane: string, id: string): string {
  return `${BASE}/s/${encodeURIComponent(lane)}/${encodeURIComponent(id)}`;
}

export function arenaPath(lane?: string | null): string {
  return lane ? `${BASE}/?lane=${encodeURIComponent(lane)}` : `${BASE}/`;
}

type Listener = (route: Route) => void;
const listeners = new Set<Listener>();

export function onRoute(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function current(): Route {
  return parseRoute(location.pathname, location.search);
}

function emit(): void {
  const r = current();
  for (const fn of listeners) fn(r);
}

export function navigate(path: string, replaceState = false): void {
  if (replaceState) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  emit();
}

/** Intercept clicks on same-origin links under the base path so the page never reloads. */
export function installRouter(): void {
  window.addEventListener('popstate', emit);
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith(BASE + '/') && href !== BASE) return;
    e.preventDefault();
    navigate(href);
    window.scrollTo({ top: 0 });
  });
}
