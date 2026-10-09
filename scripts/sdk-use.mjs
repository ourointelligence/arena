#!/usr/bin/env node
// pnpm sdk:use <version>: point every @ourointelligence dependency and the root overrides at the GitHub release
// files for that tag, write sdk-version.json, and run pnpm install so pnpm-lock.yaml follows.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = path.join(root, 'sdk-version.json');
const current = JSON.parse(readFileSync(versionFile, 'utf8'));
const version = process.argv[2] ?? current.version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`usage: pnpm sdk:use <version>   (for example 0.2.0); got "${version}"`);
  process.exit(1);
}

export function releaseUrl(pkg, v = version, base = current.releaseBase) {
  return `${base}/v${v}/ourointelligence-${pkg}-${v}.tgz`;
}

const names = current.packages.map((p) => `@ourointelligence/${p}`);

function manifests() {
  const out = [path.join(root, 'package.json')];
  for (const dir of ['apps', 'packages']) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const f = path.join(base, d, 'package.json');
      if (statSync(path.join(base, d)).isDirectory() && existsSync(f)) out.push(f);
    }
  }
  return out;
}

let touched = 0;
for (const file of manifests()) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of names) {
      if (name in deps) {
        deps[name] = releaseUrl(name.split('/')[1]);
        changed = true;
      }
    }
  }
  if (file === path.join(root, 'package.json')) {
    pkg.pnpm ??= {};
    pkg.pnpm.overrides ??= {};
    for (const name of names) pkg.pnpm.overrides[name] = releaseUrl(name.split('/')[1]);
    changed = true;
  }
  if (changed) {
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    touched++;
  }
}
writeFileSync(versionFile, JSON.stringify({ ...current, version }, null, 2) + '\n');
console.log(`SDK ${version}: ${touched} manifest(s) updated; running pnpm install`);
execSync('pnpm install', { cwd: root, stdio: 'inherit' });
