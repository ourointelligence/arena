import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', index: 'src/index.ts' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // the SDK packages and native modules stay external; @arena/* and lanes/ are bundled in
  external: ['@ourointelligence/sdk', '@ourointelligence/source-hyperliquid', '@ourointelligence/executor-paper', 'better-sqlite3', 'ws', 'isolated-vm'],
  noExternal: ['@arena/core', '@arena/flow', '@arena/hl', '@arena/lanes'],

});
