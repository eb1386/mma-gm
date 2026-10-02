#!/usr/bin/env node
// Roster discovery from fight cards.
//
// The ranked roster is all that /rankings names, and the full athlete directory is closed to crawlers
// (robots.txt disallows /athletes/all?*). Fight cards are not: every past event page links each
// fighter who competed on it. Walking the public events list back through recent cards discovers
// the active roster below the rankings, and each discovered profile is then fetched exactly like a
// ranked one.
//
// Compliance is the same as the ranked crawl: one connection, the published 15 second crawl delay,
// every disallowed path refused, every response cached so a re-run costs nothing, and incremental
// writes so a long run can be stopped and resumed.
//
// Usage: node tools/ingest/roster.mjs [--pages=14] [--since=2024-07-01] [--max-athletes=900]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoliteFetcher, DEFAULT_DELAY_MS } from './http.mjs';
import { parseAthlete } from './parse.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_DIR = join(ROOT, 'data', 'raw-ingest');
const CACHE_DIR = join(ROOT, 'data', 'raw', 'ufc-com');
const arg = (name, fallback) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : fallback;
};
const MAX_PAGES = Number(arg('pages', 14));
const SINCE = arg('since', '2024-07-01');
const MAX_ATHLETES = Number(arg('max-athletes', 900));

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function eventLinks(html) {
  return [...new Set([...html.matchAll(/href="(?:https:\/\/www\.ufc\.com)?\/event\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
}

function athleteLinks(html) {
  return [...new Set([...html.matchAll(/href="(?:https:\/\/www\.ufc\.com)?\/athlete\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
}

function eventDate(html) {
  const ts = html.match(/data-timestamp="(\d+)"/);
  return ts ? new Date(Number(ts[1]) * 1000).toISOString().slice(0, 10) : null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const fetcher = new PoliteFetcher({ cacheDir: CACHE_DIR, delayMs: DEFAULT_DELAY_MS, log });
  const discoveryPath = join(OUT_DIR, 'roster-discovery.json');
  const discovery = existsSync(discoveryPath)
    ? JSON.parse(readFileSync(discoveryPath, 'utf8'))
    : { events: {}, athletes: {} };

  // 1. The events list, newest first, back to the cutoff.
  const today = new Date().toISOString().slice(0, 10);
  let reachedCutoff = false;
  for (let page = 0; page <= MAX_PAGES && !reachedCutoff; page++) {
    const url = page === 0 ? 'https://www.ufc.com/events' : `https://www.ufc.com/events?page=${page}`;
    const res = await fetcher.get(url);
    if (!res.ok) {
      log(`events page ${page} failed (${res.reason}); stopping the list walk here`);
      break;
    }
    const slugs = eventLinks(res.body);
    log(`events page ${page}: ${slugs.length} cards`);
    for (const slug of slugs) {
      if (discovery.events[slug]?.done) continue;
      const ev = await fetcher.get(`https://www.ufc.com/event/${slug}`);
      if (!ev.ok) {
        log(`  ${slug} failed (${ev.reason})`);
        continue;
      }
      const date = eventDate(ev.body);
      const fighters = athleteLinks(ev.body);
      const completed = date !== null && date < today;
      discovery.events[slug] = { date, fighters, done: completed };
      log(`  ${slug} ${date ?? '?'} ${fighters.length} fighters${completed ? '' : ' (upcoming)'}`);
      for (const f of fighters) {
        const seen = discovery.athletes[f];
        if (!seen || (date && (!seen.lastEventDate || date > seen.lastEventDate))) {
          discovery.athletes[f] = { lastEventDate: date, lastEvent: slug, upcoming: !completed || Boolean(seen?.upcoming) };
        }
      }
      if (date && date < SINCE) reachedCutoff = true;
      writeFileSync(discoveryPath, JSON.stringify(discovery, null, 2));
    }
  }

  // 2. Profiles for every discovered fighter who is not already ingested.
  const athletesPath = join(OUT_DIR, 'athletes.json');
  const store = existsSync(athletesPath) ? JSON.parse(readFileSync(athletesPath, 'utf8')) : { athletes: {}, gaps: [] };
  const athletes = store.athletes || {};
  const gaps = store.gaps || [];
  const todo = Object.entries(discovery.athletes)
    .filter(([slug]) => !athletes[slug])
    .sort((a, b) => ((a[1].lastEventDate ?? '') < (b[1].lastEventDate ?? '') ? 1 : -1))
    .slice(0, MAX_ATHLETES);
  log(`discovered ${Object.keys(discovery.athletes).length} fighters, ${todo.length} profiles to fetch, about ${Math.round((todo.length * DEFAULT_DELAY_MS) / 60000)} min`);
  let i = 0;
  for (const [slug, seen] of todo) {
    i++;
    const url = `https://www.ufc.com/athlete/${slug}`;
    const res = await fetcher.get(url);
    if (!res.ok) {
      gaps.push({ slug, url, reason: res.reason, status: res.status });
      log(`  ${i}/${todo.length} ${slug} FAILED (${res.reason})`);
      continue;
    }
    const parsed = parseAthlete(res.body, slug);
    const missing = Object.entries(parsed).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
    athletes[slug] = {
      ...parsed,
      rankingDivision: null,
      rankingRank: null,
      rankingName: parsed.name,
      pfpOnly: false,
      discoveredFrom: seen.lastEvent,
      lastEventDate: seen.lastEventDate,
      sourceUrl: url,
      fetchedAt: res.fetchedAt || new Date().toISOString(),
      missingFields: missing,
    };
    log(`  ${i}/${todo.length} ${slug} ok${res.fromCache ? ' (cache)' : ''} ${parsed.divisionLabel ?? '?'} ${parsed.status ?? '?'}`);
    if (i % 5 === 0 || i === todo.length) writeFileSync(athletesPath, JSON.stringify({ ...store, athletes, gaps }, null, 2));
  }
  writeFileSync(athletesPath, JSON.stringify({ ...store, athletes, gaps }, null, 2));
  log(`roster discovery complete. athletes in store ${Object.keys(athletes).length}. network ${fetcher.stats.network}, cache ${fetcher.stats.cache}, refused ${fetcher.stats.disallowed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
