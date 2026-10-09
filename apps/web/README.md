# @arena/web

The OURO Arena page, served at https://ourosi.xyz/arena. Vite plus vanilla TypeScript, no framework. The page only reads: every number comes from `/arena/api` (see `docs/api-contract.md`) and every change goes through the admin command line on the server.

## Run it

```bash
pnpm dev          # Vite on http://localhost:5173/arena/ with the mock API started in-process on 8788
pnpm build        # static build in dist/, served by nginx with an SPA fallback for /arena/s/*
pnpm preview      # serve dist/ on http://127.0.0.1:4173 (proxies /arena/api to the mock on 8788)
pnpm mock         # the mock API alone: pnpm mock [port]
```

To point the dev server at a real API instead of the mock: `ARENA_API_PROXY=http://127.0.0.1:8787 pnpm dev`.

## Tests

```bash
pnpm test         # vitest: escaping and formatting, thought log rows, tree layout
pnpm test:e2e     # Playwright: four widths, both themes, overflow and heading checks, strategy page, stream
pnpm test:soak    # Playwright: 10 minutes at 10 events per second, long tasks under 200 ms, flat memory
pnpm exec tsx e2e/inspect.ts   # viewport screenshots of the fold, the log and the switch panel (servers must be up)
```

Screenshots land in `screenshots/`. The Playwright config starts the mock API and a fresh build on its own; it reuses servers that are already running.

## Layout

- `src/main.ts` boot, routing between the arena page and the strategy page.
- `src/pages/arena.ts` loads one lane at a time, subscribes to the event stream, refreshes sections.
- `src/pages/strategy.ts` the strategy page.
- `src/sections.ts` the twelve sections as DOM builders; `src/tree.ts` the radial family tree (layout plus canvas view); `src/charts.ts` inline SVG charts.
- `src/stream.ts` server-sent events with backoff and a polling fallback; `src/store.ts` pure helpers (log rows, caps, refresh rules).
- `src/dom.ts` element helpers that only ever create text nodes; `src/highlight.ts` highlight.js output rebuilt as DOM nodes.
- `test/mock-api.ts` a dependency-free mock of the whole API with deterministic data and a scripted event stream.

## Rules the code follows

- No innerHTML anywhere; model text is always a text node. No inline scripts or handlers, so the page works under the nginx Content-Security-Policy.
- One requestAnimationFrame loop for the tree, guarded against double starts, throttled to 30 fps, paused off screen and when the tab is hidden.
- The thought log keeps at most 200 rows. The event stream reconnects with backoff and falls back to polling every 10 s when the server answers 503.
- Works at 360 px wide: tables scroll inside their own container, the tree shrinks, the page never scrolls sideways.
