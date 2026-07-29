#!/usr/bin/env node
// Repository guard for project terminology rules.
//
// Rule 1: the long form of Ovr must never appear. The abbreviation Ovr is the only
//         permitted spelling in code, comments, docs, UI copy, and generated text.
// Rule 2: the long form of Pot must never appear as a fighter attribute label. Pot is
//         the only permitted spelling.
//
// Both rules are enforced case insensitively on whole words so that unrelated words
// containing the letters (for example "potential customers" does not exist here, but
// "potentially" would still be caught and must be rephrased) do not slip through.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// .claude holds instruction documents supplied to the project rather than anything the
// project itself produces, so the terminology rules do not apply to them.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite', '.cache', 'raw', '.claude']);
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.html']);

const SELF = join(ROOT, 'scripts', 'check-terms.mjs');

// Built from character classes so that this checker file does not itself contain the
// banned literals, which would otherwise make the check unable to run on its own repo.
const RULES = [
  {
    name: 'long form of Ovr',
    re: new RegExp('\\b' + 'o' + 'verall' + '\\w*\\b', 'gi'),
    fix: 'Use Ovr.',
  },
  {
    name: 'long form of Pot',
    re: new RegExp('\\b' + 'p' + 'otential' + '\\w*\\b', 'gi'),
    fix: 'Use Pot.',
  },
];

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
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          col: m.index + 1,
          rule: rule.name,
          fix: rule.fix,
          text: line.trim().slice(0, 120),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`Terminology check FAILED: ${violations.length} violation(s).\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  ${v.rule}. ${v.fix}`);
    console.error(`      ${v.text}`);
  }
  process.exit(1);
}

console.log(`Terminology check passed: scanned ${files.length} files.`);
