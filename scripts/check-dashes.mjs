#!/usr/bin/env node
// Repository guard: fails when a Unicode em dash appears anywhere in tracked source,
// documentation, seed data, or generated content templates.
//
// Rationale: the project style rule forbids the em dash character in every artifact the
// project produces, including UI copy and generated fight commentary. A build time check
// is the only reliable way to keep it out over a long lived codebase.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EM_DASH = '—';

// Additional dash-like characters that read as em dashes in a terminal or browser and
// would defeat the intent of the rule if substituted.
const BANNED = [
  { char: '—', name: 'EM DASH (U+2014)' },
  { char: '―', name: 'HORIZONTAL BAR (U+2015)' },
  { char: '⸺', name: 'TWO-EM DASH (U+2E3A)' },
  { char: '⸻', name: 'THREE-EM DASH (U+2E3B)' },
  { char: '﹘', name: 'SMALL EM DASH (U+FE58)' },
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.vite',
  '.cache',
  'raw', // ingestion HTML cache: third party markup, not project output
  '.claude', // instruction documents supplied to the project, not project output
]);

const SCAN_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.txt',
  '.yml',
  '.yaml',
]);

// This file necessarily contains the characters it bans.
const SELF = join(ROOT, 'scripts', 'check-dashes.mjs');

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(extname(entry))) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
const violations = [];

for (const file of files) {
  if (file === SELF) continue;
  const text = readFileSync(file, 'utf8');
  let hit = false;
  for (const b of BANNED) if (text.includes(b.char)) hit = true;
  if (!hit) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const b of BANNED) {
      let col = line.indexOf(b.char);
      while (col !== -1) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          col: col + 1,
          name: b.name,
          text: line.trim().slice(0, 120),
        });
        col = line.indexOf(b.char, col + 1);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`Dash check FAILED: ${violations.length} banned dash character(s) found.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  ${v.name}`);
    console.error(`      ${v.text}`);
  }
  console.error(`\nUse a hyphen, a colon, a comma, parentheses, or two sentences instead.`);
  process.exit(1);
}

console.log(`Dash check passed: scanned ${files.length} files, zero banned dash characters.`);
void EM_DASH;
