#!/usr/bin/env node
// pnpm sdk:npm: for the day the packages are on the npm registry. Replaces every GitHub release URL with the plain
// version from sdk-version.json and removes the root overrides, then runs pnpm install. Not run until npm is live.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = JSON.parse(readFileSync(path.join(root, 'sdk-version.json'), 'utf8'));
const names = current.packages.map((p) => `@ourointelligence/${p}`);

const files = [path.join(root, 'package.json')];
for (const dir of ['apps', 'packages']) {
  const base = path.join(root, dir);
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base)) {
    const f = path.join(base, d, 'package.json');
    if (statSync(path.join(base, d)).isDirectory() && existsSync(f)) files.push(f);
  }
}
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of names) if (name in deps) deps[name] = current.version;
  }
  if (pkg.pnpm?.overrides) {
    for (const name of names) delete pkg.pnpm.overrides[name];
    if (Object.keys(pkg.pnpm.overrides).length === 0) delete pkg.pnpm.overrides;
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`SDK packages now point at npm version ${current.version}; running pnpm install`);
execSync('pnpm install', { cwd: root, stdio: 'inherit' });
