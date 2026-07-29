/**
 * End to end world simulation harness.
 *
 * Creates a save from the built snapshot, runs it forward for a number of years, and
 * reports what the simulated world looks like. This is the check that the whole loop
 * holds together over a long career: matchmaking, rankings, titles, aging, injuries,
 * retirements, prospect intake, news and history.
 *
 * Run with:  npx vite-node tools/sim-world.ts [years] [seed]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIVISIONS } from '../src/core/config/divisions';
import type { SnapshotFile } from '../src/core/data/snapshot';
import { ovrDisplayed } from '../src/core/types/fighter';
import { isFinish } from '../src/core/types/fight';
import { createNewGame } from '../src/core/world/newgame';
import { advance } from '../src/core/world/tick';
import { buildRecordBooks } from '../src/core/world/history';
import { formatMoney } from '../src/core/types/common';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'public', 'data');

const YEARS = Number(process.argv[2] ?? 3);
const SEED = Number(process.argv[3] ?? 424242);

const file = readdirSync(DATA).find((f) => f.startsWith('snapshot-'));
if (!file) {
  console.error('No snapshot found. Run: npx vite-node tools/build-snapshot.ts');
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(join(DATA, file), 'utf8')) as SnapshotFile;

const t0 = Date.now();
const { save, summary } = createNewGame(snapshot, {
  saveName: 'harness',
  seed: SEED,
  mode: 'spectator',
});

console.log(`world created from ${snapshot.meta.snapshotId}`);
console.log(`  real fighters      ${summary.realFighters}`);
console.log(`  fictional fighters ${summary.generatedFighters}`);
console.log(`  gyms               ${summary.gyms}`);
console.log(`  events scheduled   ${summary.events}`);
console.log(`  start date         ${save.date}`);

for (let y = 0; y < YEARS; y++) {
  const report = advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
  const completed = Object.values(save.events).filter((e) => e.status === 'completed').length;
  const fights = Object.keys(save.history.results).length;
  console.log(
    `\nyear ${y + 1}: advanced to ${save.date}. events resolved this pass ${report.eventsResolved.length}, cumulative events ${completed}, cumulative fights ${fights}`
  );
}

console.log(`\n=== CHAMPIONS at ${save.date} ===`);
for (const d of DIVISIONS) {
  const t = save.rankings[d.id];
  const champ = t.championId ? save.fighters[t.championId] : null;
  const interim = t.interimChampionId ? save.fighters[t.interimChampionId] : null;
  const reign = save.history.reigns.find((r) => r.fighterId === champ?.id && r.lostOn === null);
  console.log(
    `  ${d.name.padEnd(18)} ${champ ? `${champ.name.padEnd(24)} Ovr ${ovrDisplayed(champ.ratings)}  ${reign ? `${reign.defenses} defenses` : ''}${champ.isRealPerson ? '' : '  [fictional]'}` : 'VACANT'}${interim ? `   interim: ${interim.name}` : ''}`
  );
}

console.log(`\n=== LIGHTWEIGHT TOP 10 ===`);
for (const e of save.rankings.lightweight.entries.slice(0, 10)) {
  const f = save.fighters[e.fighterId];
  if (!f) continue;
  console.log(
    `  ${String(e.rank).padStart(2)}. ${f.name.padEnd(24)} ${f.ufcRecord.wins}-${f.ufcRecord.losses} promo  Ovr ${ovrDisplayed(f.ratings)} Pot ${f.pot}  Lng ${f.longevity}  age ${f.ageAtSnapshot ?? '?'}${f.isRealPerson ? '' : '  [fictional]'}`
  );
}

console.log(`\n=== POUND FOR POUND TOP 8 ===`);
for (const e of save.pfp.entries.slice(0, 8)) {
  const f = save.fighters[e.fighterId];
  if (!f) continue;
  console.log(`  ${String(e.rank).padStart(2)}. ${f.name.padEnd(24)} ${f.divisionId}`);
}

const results = Object.values(save.history.results);
const finishes = results.filter((r) => isFinish(r.method)).length;
console.log(`\n=== SIMULATED WORLD TOTALS ===`);
console.log(`  fights            ${results.length}`);
console.log(`  finish rate       ${((finishes / Math.max(1, results.length)) * 100).toFixed(1)}%`);
console.log(`  title fights      ${results.filter((r) => r.isTitleFight).length}`);
console.log(`  title changes     ${save.history.reigns.length - 8}`);
console.log(`  retirements       ${save.history.retirements.length}`);
console.log(`  new fighters      ${Object.values(save.fighters).filter((f) => f.createdBy === 'generated').length}`);
console.log(`  active roster     ${Object.values(save.fighters).filter((f) => !f.retired && f.activityStatus === 'active').length}`);
console.log(`  news items        ${save.history.news.length}`);
console.log(`  awards            ${save.history.awards.length}`);
console.log(`  hall of fame      ${save.history.hallOfFame.length}`);
const injured = Object.values(save.fighters).filter((f) => f.injuries.some((i) => i.actualReturn === null)).length;
console.log(`  currently injured ${injured}`);

const books = buildRecordBooks(save);
for (const key of ['wins', 'finishes', 'reign', 'defenses', 'earnings']) {
  const book = books.find((b) => b.key === key);
  if (!book || book.rows.length === 0) continue;
  const top = book.rows[0];
  console.log(
    `  ${book.label.padEnd(28)} ${top.name} (${key === 'earnings' ? formatMoney(top.value) : `${top.value} ${book.unit}`})`
  );
}

console.log(`\n=== SAMPLE HEADLINES ===`);
for (const n of save.history.news.filter((n) => n.importance >= 4).slice(0, 8)) {
  console.log(`  ${n.date}  ${n.headline}`);
}

console.log(`\n=== SAMPLE FIGHT RECAP ===`);
const sample = results[results.length - 1];
if (sample) {
  console.log(`  ${sample.narrativeSummary}`);
  console.log(`  Round 1 summary: ${sample.rounds[0]?.summary ?? 'n/a'}`);
}

const bytes = JSON.stringify(save).length;
console.log(`\nsave size ${(bytes / 1024 / 1024).toFixed(2)} MB, ran in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
