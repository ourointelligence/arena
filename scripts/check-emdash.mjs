#!/usr/bin/env node
// Fails when any tracked text file contains an em dash (U+2014) or an en dash (U+2013).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DASHES = new RegExp('[\\u2013\\u2014]');
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|woff2?|ttf|otf|ico|gz|db)$/i.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (DASHES.test(line)) bad.push(`${f}:${i + 1}`);
  });
}
if (bad.length) {
  console.error(`em or en dash found in ${bad.length} place(s):\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`no em or en dashes in ${files.length} tracked files`);
