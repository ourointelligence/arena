import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  external: ['@ourointelligence/sdk', '@ourointelligence/source-hyperliquid', '@ourointelligence/executor-paper', 'better-sqlite3', 'ws', 'isolated-vm'],
  noExternal: ['@arena/core', '@arena/runner', '@arena/flow', '@arena/hl', '@arena/lanes'],
  banner: { js: '#!/usr/bin/env node' },
});
