import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', main: 'src/main.ts', 'fixture-server': 'src/fixture-server.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  splitting: true,
  external: ['better-sqlite3', '@resvg/resvg-js', 'satori', 'hono', '@hono/node-server', '@arena/core'],
});
