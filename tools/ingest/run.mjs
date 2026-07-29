#!/usr/bin/env node
// Ingestion orchestrator for the official UFC source.
//
// Order of work:
//   1. Fetch /rankings once. This is the authoritative division membership, champion,
//      interim champion, and rank 1 to 15 list, plus the pound for pound list.
//   2. Fetch /athlete/<slug> for every men's division fighter named by step 1.
//   3. Write raw parsed records plus a fetch report to data/raw-ingest.
//
// Nothing is invented. Fighters the crawl cannot reach are recorded as gaps in the
// report and are excluded from the snapshot rather than filled in with estimates.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoliteFetcher, DEFAULT_DELAY_MS } from './http.mjs';
import { parseRankings, parseAthlete } from './parse.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_DIR = join(ROOT, 'data', 'raw-ingest');
const CACHE_DIR = join(ROOT, 'data', 'raw', 'ufc-com');

const MENS_DIVISIONS = [
  'Flyweight',
  'Bantamweight',
  'Featherweight',
  'Lightweight',
  'Welterweight',
  'Middleweight',
  'Light Heavyweight',
  'Heavyweight',
];

// The rankings page publishes women's division names with an HTML escaped apostrophe.
const WOMENS_DIVISIONS = ["Women's Strawweight", "Women's Flyweight", "Women's Bantamweight", "Women's Featherweight"];

function isTrackedDivision(name) {
  return MENS_DIVISIONS.includes(name) || WOMENS_DIVISIONS.includes(name);
}

const args = process.argv.slice(2);
const onlyRankings = args.includes('--only-rankings');
const delayArg = args.find((a) => a.startsWith('--delay='));
const delayMs = delayArg ? Number(delayArg.split('=')[1]) : DEFAULT_DELAY_MS;

function logLine(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const fetcher = new PoliteFetcher({ cacheDir: CACHE_DIR, delayMs, log: logLine });

  logLine(`ingest start. crawl delay ${delayMs}ms per robots.txt.`);

  // Step 1: rankings
  const rankUrl = 'https://www.ufc.com/rankings';
  const rankRes = await fetcher.get(rankUrl);
  if (!rankRes.ok) {
    logLine(`FATAL: rankings fetch failed (${rankRes.reason}). Nothing written.`);
    process.exit(2);
  }
  const rankings = parseRankings(rankRes.body);
  const rankingsFetchedAt = rankRes.fetchedAt || startedAt;

  // The rankings page renders each division grouping twice: once populated and once as
  // an empty mobile duplicate. Keep the richest copy of each division name.
  const byName = new Map();
  for (const d of rankings.divisions) {
    const prev = byName.get(d.name);
    if (!prev || d.entries.length > prev.entries.length) byName.set(d.name, d);
  }
  const tracked = [...MENS_DIVISIONS, ...WOMENS_DIVISIONS].map((n) => byName.get(n)).filter(Boolean);
  const mens = tracked;
  const pfp = byName.get("Men's Pound-for-Pound") || null;
  const womensPfp = byName.get("Women's Pound-for-Pound") || null;
  void isTrackedDivision;

  logLine(`rankings parsed: ${mens.length} tracked divisions, pfp entries ${pfp ? pfp.entries.length : 0}`);
  for (const d of mens) {
    logLine(`  ${d.name}: champion=${d.champion ? d.champion.slug : 'none'} ranked=${d.entries.length}`);
  }

  writeFileSync(
    join(OUT_DIR, 'rankings.json'),
    JSON.stringify(
      {
        source: 'ufc.com/rankings',
        sourceUrl: rankUrl,
        fetchedAt: rankingsFetchedAt,
        divisions: mens,
        pfp,
        womensPfp,
        allGroupings: rankings.divisions.map((d) => d.name),
      },
      null,
      2
    )
  );

  if (onlyRankings) {
    logLine('only-rankings mode. done.');
    return;
  }

  // Step 2: athlete profiles for every men's division slug named by the rankings.
  const targets = new Map();
  for (const d of mens) {
    if (d.champion) targets.set(d.champion.slug, { division: d.name, rank: 0, name: d.champion.name });
    for (const e of d.entries) {
      if (!targets.has(e.slug)) targets.set(e.slug, { division: d.name, rank: e.rank, name: e.name });
    }
  }
  for (const table of [pfp, womensPfp]) {
    if (!table) continue;
    for (const e of table.entries) {
      if (!targets.has(e.slug)) targets.set(e.slug, { division: null, rank: null, name: e.name, pfpOnly: true });
    }
    if (table.champion && !targets.has(table.champion.slug)) {
      targets.set(table.champion.slug, { division: null, rank: null, name: table.champion.name, pfpOnly: true });
    }
  }

  logLine(`athlete profiles to fetch: ${targets.size}. estimated wall clock ${Math.round((targets.size * delayMs) / 60000)} min.`);

  const athletesPath = join(OUT_DIR, 'athletes.json');
  const existing = existsSync(athletesPath) ? JSON.parse(readFileSync(athletesPath, 'utf8')) : { athletes: {} };
  const athletes = existing.athletes || {};
  const gaps = [];

  let i = 0;
  for (const [slug, meta] of targets) {
    i++;
    const url = `https://www.ufc.com/athlete/${slug}`;
    const res = await fetcher.get(url);
    if (!res.ok) {
      gaps.push({ slug, url, reason: res.reason, status: res.status });
      logLine(`  ${i}/${targets.size} ${slug} FAILED (${res.reason})`);
      continue;
    }
    const parsed = parseAthlete(res.body, slug);
    const missing = Object.entries(parsed)
      .filter(([, v]) => v === null || v === undefined)
      .map(([k]) => k);
    athletes[slug] = {
      ...parsed,
      rankingDivision: meta.division,
      rankingRank: meta.rank,
      rankingName: meta.name,
      pfpOnly: meta.pfpOnly === true,
      sourceUrl: url,
      fetchedAt: res.fetchedAt || new Date().toISOString(),
      missingFields: missing,
    };
    logLine(
      `  ${i}/${targets.size} ${slug} ok${res.fromCache ? ' (cache)' : ''} status=${parsed.status ?? '?'} div=${parsed.divisionLabel ?? '?'} missing=${missing.length}`
    );

    // Write incrementally so a long run is resumable and never loses work.
    if (i % 5 === 0 || i === targets.size) {
      writeFileSync(
        athletesPath,
        JSON.stringify({ source: 'ufc.com/athlete', startedAt, athletes, gaps }, null, 2)
      );
    }
  }

  writeFileSync(athletesPath, JSON.stringify({ source: 'ufc.com/athlete', startedAt, athletes, gaps }, null, 2));

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    crawlDelayMs: delayMs,
    robotsCompliance: {
      crawlDelayHonored: true,
      disallowedPathsRefused: fetcher.stats.disallowed,
      note: 'ufc.com robots.txt disallows /athletes/all?* so the full historical directory is not crawled. Roster membership comes from /rankings only.',
    },
    requests: fetcher.stats,
    athleteCount: Object.keys(athletes).length,
    gapCount: gaps.length,
    gaps,
  };
  writeFileSync(join(OUT_DIR, 'fetch-report.json'), JSON.stringify(report, null, 2));
  logLine(`ingest complete. athletes=${report.athleteCount} gaps=${report.gapCount} network=${fetcher.stats.network} cache=${fetcher.stats.cache}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
