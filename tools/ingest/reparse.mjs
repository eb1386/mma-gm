#!/usr/bin/env node
// Offline re-parse of every ingested athlete from the disk cache.
//
// The crawlers never re-parse a profile already in athletes.json, so a parser fix (a relabelled bio
// field, a quoting change) would otherwise only reach fighters fetched after it. This walks the
// store, reads each profile from data/raw/ufc-com by the same cache key the fetcher uses, and
// replaces the parsed fields. It makes no network request at all: a profile missing from the cache
// keeps its stored values and is reported.
//
// Fields the crawl added beside the parse (ranking metadata, the card a fighter was found on, the
// source URL and fetch time) are kept as they are.
//
// Usage: node tools/ingest/reparse.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseAthlete } from './parse.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CACHE_DIR = join(ROOT, 'data', 'raw', 'ufc-com');
const athletesPath = join(ROOT, 'data', 'raw-ingest', 'athletes.json');

function cachePathFor(url) {
  const h = createHash('sha1').update(url).digest('hex');
  return join(CACHE_DIR, h.slice(0, 2), `${h}.html`);
}

const store = JSON.parse(readFileSync(athletesPath, 'utf8'));
const athletes = store.athletes || {};
let reparsed = 0;
const uncached = [];
for (const [slug, prev] of Object.entries(athletes)) {
  const url = prev.sourceUrl || `https://www.ufc.com/athlete/${slug}`;
  const path = cachePathFor(url);
  if (!existsSync(path)) {
    uncached.push(slug);
    continue;
  }
  const parsed = parseAthlete(readFileSync(path, 'utf8'), slug);
  const missing = Object.entries(parsed)
    .filter(([, v]) => v === null || v === undefined)
    .map(([k]) => k);
  athletes[slug] = { ...prev, ...parsed, missingFields: missing };
  reparsed++;
}
writeFileSync(athletesPath, JSON.stringify({ ...store, athletes }, null, 2));
console.log(`re-parsed ${reparsed} of ${Object.keys(athletes).length} athletes from the cache`);
if (uncached.length) console.log(`not in the cache, kept as stored: ${uncached.join(', ')}`);
