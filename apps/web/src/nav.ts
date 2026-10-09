import { el, svg } from './dom.ts';
import { isDark, toggleTheme } from './theme.ts';
import { arenaPath } from './router.ts';

const SITE = 'https://ourosi.xyz';

function logo(): SVGSVGElement {
  const s = svg('svg', { class: 'logo', viewBox: '0 0 256 256', 'aria-hidden': 'true' });
  s.appendChild(svg('path', { d: 'M177.3 57.6A86 86 0 1 1 91.7 50.1', fill: 'none', stroke: 'currentColor', 'stroke-width': '22', 'stroke-linecap': 'round' }));
  s.appendChild(svg('circle', { cx: '145.9', cy: '43.9', r: '17', fill: 'var(--cobalt)' }));
  return s;
}

function github(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 24 24' });
  s.appendChild(svg('path', { d: 'M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z' }));
  return s;
}

function xmark(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 24 24' });
  s.appendChild(svg('path', { d: 'M18.2 2h3.4l-7.4 8.5L23 22h-6.8l-5.3-7-6.1 7H1.4l7.9-9.1L1 2h7l4.8 6.4L18.2 2zm-1.2 18h1.9L7.1 3.9H5.1L17 20z' }));
  return s;
}

/** The main site's nav with Arena marked active. */
export function buildNav(): HTMLElement {
  const label = el('span', { id: 'theme-lbl' }, isDark() ? 'light' : 'dark');
  const tog = el('button', { class: 'tog', id: 'theme', 'aria-label': 'Toggle light and dark theme' }, label);
  tog.addEventListener('click', () => {
    toggleTheme();
    label.textContent = isDark() ? 'light' : 'dark';
  });
  const links = el(
    'div',
    { class: 'navlinks' },
    el('a', { href: `${SITE}/`, class: 'keep' }, 'Home'),
    el('a', { href: `${SITE}/#loop` }, 'Loop'),
    el('a', { href: `${SITE}/#takeoff` }, 'Takeoff'),
    el('a', { href: `${SITE}/#population` }, 'Population'),
    el('a', { href: `${SITE}/#primitives` }, 'SI'),
    el('a', { href: `${SITE}/#switch` }, 'Switch'),
    el('a', { href: `${SITE}/#install` }, 'Install'),
    el('a', { href: `${SITE}/#docs`, class: 'keep' }, 'Docs'),
    el('a', { href: arenaPath(), class: 'on keep', 'aria-current': 'page' }, 'Arena'),
  );
  const ext = el(
    'div',
    { class: 'ext' },
    el('a', { href: 'https://github.com/ourointelligence/arena', target: '_blank', rel: 'noopener', 'aria-label': 'GitHub' }, github()),
    el('a', { href: 'https://x.com/ourointel', target: '_blank', rel: 'noopener', 'aria-label': 'X' }, xmark()),
    tog,
  );
  const mark = el('a', { class: 'mark', href: `${SITE}/` }, logo(), 'OURO');
  return el('div', { class: 'nav' }, el('div', { class: 'wrap' }, mark, links, ext));
}

export function buildFooter(): HTMLElement {
  return el(
    'div',
    { class: 'wrap' },
    el(
      'footer',
      null,
      el('span', null, 'OURO Arena · paper trading, every step in the open · ', el('a', { href: 'https://github.com/ourointelligence/arena', target: '_blank', rel: 'noopener' }, 'github.com/ourointelligence/arena'), ' · ', el('a', { href: `${SITE}/` }, 'ourosi.xyz')),
      el('span', null, 'Paper trading only. Nothing here is financial advice or a trading signal.'),
    ),
  );
}
