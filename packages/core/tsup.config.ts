import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', fixture: 'src/fixture.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  external: ['better-sqlite3'],
});
