import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'index.ts', core: 'core.ts', alts: 'alts.ts', flow: 'flow.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@ourointelligence/sdk', '@arena/flow'],
});
