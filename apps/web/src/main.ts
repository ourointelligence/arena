import { el, replace } from './dom.ts';
import { current, installRouter, onRoute, type Route } from './router.ts';
import { loadTheme } from './theme.ts';
import { arenaPage, type PageHandle } from './pages/arena.ts';
import { strategyPage } from './pages/strategy.ts';
import { buildFooter, buildNav } from './nav.ts';

loadTheme();
installRouter();

const app = document.getElementById('app')!;
let page: PageHandle | null = null;
let token = 0;

async function render(route: Route): Promise<void> {
  const my = ++token;
  page?.destroy();
  page = null;
  let next: PageHandle;
  if (route.page === 'arena') next = await arenaPage(route.lane);
  else if (route.page === 'strategy') next = await strategyPage(route.lane, route.id);
  else {
    const root = el('div', null, buildNav(), el('main', { class: 'wrap' }, el('div', { class: 'msg' }, 'There is nothing at this address.')), buildFooter());
    next = { root, destroy: () => undefined };
  }
  if (my !== token) {
    next.destroy();
    return;
  }
  page = next;
  replace(app, next.root);
}

onRoute((r) => void render(r));
void render(current());
