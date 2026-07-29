/**
 * Multi seed balance and acceptance harness.
 *
 * Runs a configurable set of seeds forward and reports the distributions the expansion
 * specification asks for, with the healthy target bands printed alongside so a drift is
 * obvious rather than buried.
 *
 * Run with:  npx vite-node tools/acceptance.ts [fiveYearSeeds] [tenYearSeeds] [twentyYearSeeds]
 * Default is a short run. The full run is 20 / 5 / 1 and takes a long time.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { divisionsInYear } from '../src/core/config/divisions';
import type { SnapshotFile } from '../src/core/data/snapshot';
import { createNewGame } from '../src/core/world/newgame';
import { advance } from '../src/core/world/tick';
import { isFinish } from '../src/core/types/fight';
import { daysBetween } from '../src/core/types/common';
import { businessStore } from '../src/core/world/business';
import type { SaveGame } from '../src/core/types/save';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'public', 'data');
const file = readdirSync(DATA).find((f) => f.startsWith('snapshot-'))!;
const snapshot = JSON.parse(readFileSync(join(DATA, file), 'utf8')) as SnapshotFile;

const FIVE = Number(process.argv[2] ?? 4);
const TEN = Number(process.argv[3] ?? 1);
const TWENTY = Number(process.argv[4] ?? 0);

interface RunStats {
  seed: number;
  years: number;
  eventsPerYear: number;
  ppvPerYear: number;
  fightNightsPerYear: number;
  scheduledPerCard: number;
  contestedPerCard: number;
  finishRate: number;
  titleFightsPerDivisionPerYear: number;
  titleChangeRate: number;
  defensesPerReign: number;
  championsWithADefense: number;
  longVacanciesPerDivisionPerYear: number;
  longVacancySpells: number;
  interimTitles: number;
  generatedChampions: number;
  generatedRankedShare: number;
  retirementsPerYear: number;
  injuryRate: number;
  weightMissRate: number;
  activityMean: number;
  activityOverFourShare: number;
  saveSizeMb: number;
  runtimeSec: number;
  meanPpvBuys: number;
  bonusesPerEvent: number;
}

function runSeed(seed: number, years: number): RunStats {
  const t0 = Date.now();
  const { save } = createNewGame(snapshot, { saveName: `acc-${seed}`, seed, mode: 'spectator' });
  for (let y = 0; y < years; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
  return summarize(save, seed, years, (Date.now() - t0) / 1000);
}

function summarize(save: SaveGame, seed: number, years: number, runtimeSec: number): RunStats {
  const actualYears = daysBetween(save.startDate, save.date) / 365;
  const completed = Object.values(save.events).filter((e) => e.status === 'completed');
  const withBouts = completed.filter((e) => e.boutIds.length > 0);
  const ppv = completed.filter((e) => e.tier === 'numbered-ppv');
  const results = Object.values(save.history.results);

  const scheduled = withBouts.map((e) => e.announcedBoutIds.length || e.boutIds.length);
  const contested = withBouts.map((e) => e.contestedBoutIds.length);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

  // Only divisions that are actually contested carry a title, so they are the divisor for
  // every per division rate. Women's Featherweight is configured as no longer contested.
  const contestedDivisions = divisionsInYear(Number(save.date.slice(0, 4)));

  const titleFights = results.filter((r) => r.isTitleFight).length;
  const reigns = save.history.reigns.filter((r) => !r.isInterim);
  // A reign that began after the save started is a title change. Reigns imported from the
  // snapshot carry the start date, so comparing dates is exact and does not assume that
  // every configured division had a champion on day one.
  const newReigns = reigns.filter((r) => r.wonOn > save.startDate).length;
  const defenses = reigns.reduce((s, r) => s + r.defenses, 0);
  const withDefense = reigns.filter((r) => r.defenses > 0).length;

  // Vacancy spells longer than 180 days, including a title still vacant at the end of the
  // run, which the gap-between-reigns walk on its own would miss entirely.
  let vacantLong = 0;
  for (const d of contestedDivisions) {
    const divisionReigns = reigns.filter((r) => r.divisionId === d.id).sort((a, b) => (a.wonOn < b.wonOn ? -1 : 1));
    for (let i = 1; i < divisionReigns.length; i++) {
      const prevEnd = divisionReigns[i - 1].lostOn;
      if (!prevEnd) continue;
      if (daysBetween(prevEnd, divisionReigns[i].wonOn) > 180) vacantLong++;
    }
    const last = divisionReigns[divisionReigns.length - 1];
    if (last?.lostOn && daysBetween(last.lostOn, save.date) > 180) vacantLong++;
  }

  const fighters = Object.values(save.fighters);
  const generatedChampions = reigns.filter((r) => save.fighters[r.fighterId] && !save.fighters[r.fighterId].isRealPerson).length;
  const rankedFighters = fighters.filter((f) => f.ranking !== null);
  const generatedRanked = rankedFighters.filter((f) => !f.isRealPerson).length;

  const active = fighters.filter((f) => !f.retired && f.activityStatus === 'active');
  const rates = active.map((f) => f.boutIds.filter((id) => save.history.results[id]).length / actualYears);

  const injuries = fighters.reduce((s, f) => s + f.injuries.length, 0);
  const weightMisses = fighters.reduce((s, f) => s + f.weightMisses, 0);

  const business = Object.values(businessStore(save));
  const ppvBuys = business.map((b) => b.ppvBuys).filter((v): v is number => v !== null);
  const bonusCount = completed.reduce((s, e) => s + e.performanceBonusFighterIds.length + (e.fightOfTheNightBoutId ? 2 : 0), 0);

  return {
    seed,
    years,
    eventsPerYear: completed.length / actualYears,
    ppvPerYear: ppv.length / actualYears,
    fightNightsPerYear: (completed.length - ppv.length) / actualYears,
    scheduledPerCard: mean(scheduled),
    contestedPerCard: mean(contested),
    finishRate: results.filter((r) => isFinish(r.method)).length / Math.max(1, results.length),
    titleFightsPerDivisionPerYear: titleFights / contestedDivisions.length / actualYears,
    titleChangeRate: titleFights > 0 ? newReigns / titleFights : 0,
    defensesPerReign: reigns.length > 0 ? defenses / reigns.length : 0,
    championsWithADefense: reigns.length > 0 ? withDefense / reigns.length : 0,
    longVacanciesPerDivisionPerYear: vacantLong / contestedDivisions.length / actualYears,
    longVacancySpells: vacantLong,
    interimTitles: save.history.reigns.filter((r) => r.isInterim).length,
    generatedChampions,
    generatedRankedShare: rankedFighters.length > 0 ? generatedRanked / rankedFighters.length : 0,
    retirementsPerYear: save.history.retirements.length / actualYears,
    injuryRate: injuries / Math.max(1, results.length),
    weightMissRate: weightMisses / Math.max(1, results.length * 2),
    activityMean: mean(rates),
    activityOverFourShare: rates.filter((r) => r > 4).length / Math.max(1, rates.length),
    saveSizeMb: JSON.stringify(save).length / 1024 / 1024,
    runtimeSec,
    meanPpvBuys: mean(ppvBuys),
    bonusesPerEvent: bonusCount / Math.max(1, completed.length),
  };
}

const runs: RunStats[] = [];
console.log(`acceptance run: ${FIVE} five year seeds, ${TEN} ten year seeds, ${TWENTY} twenty year seeds\n`);

for (let i = 0; i < FIVE; i++) {
  const s = runSeed(100 + i, 5);
  runs.push(s);
  console.log(`  seed ${s.seed} (5y) done in ${s.runtimeSec.toFixed(1)}s, save ${s.saveSizeMb.toFixed(1)} MB`);
}
for (let i = 0; i < TEN; i++) {
  const s = runSeed(500 + i, 10);
  runs.push(s);
  console.log(`  seed ${s.seed} (10y) done in ${s.runtimeSec.toFixed(1)}s, save ${s.saveSizeMb.toFixed(1)} MB`);
}
for (let i = 0; i < TWENTY; i++) {
  const s = runSeed(900 + i, 20);
  runs.push(s);
  console.log(`  seed ${s.seed} (20y) done in ${s.runtimeSec.toFixed(1)}s, save ${s.saveSizeMb.toFixed(1)} MB`);
}

function agg(pick: (r: RunStats) => number): { mean: number; min: number; max: number } {
  const vals = runs.map(pick);
  return {
    mean: vals.reduce((s, v) => s + v, 0) / vals.length,
    min: Math.min(...vals),
    max: Math.max(...vals),
  };
}

interface Row {
  label: string;
  pick: (r: RunStats) => number;
  target?: [number, number];
  digits?: number;
}

const ROWS: Row[] = [
  { label: 'Events per year', pick: (r) => r.eventsPerYear, target: [40, 52], digits: 1 },
  { label: 'Pay per view cards per year', pick: (r) => r.ppvPerYear, target: [10, 18], digits: 1 },
  { label: 'Fight nights per year', pick: (r) => r.fightNightsPerYear, target: [26, 38], digits: 1 },
  { label: 'Scheduled bouts per card', pick: (r) => r.scheduledPerCard, target: [10, 14], digits: 2 },
  { label: 'Contested bouts per card', pick: (r) => r.contestedPerCard, target: [9, 14], digits: 2 },
  { label: 'Finish rate', pick: (r) => r.finishRate, target: [0.4, 0.56], digits: 3 },
  { label: 'Title fights per division per year', pick: (r) => r.titleFightsPerDivisionPerYear, target: [1.0, 2.0], digits: 2 },
  { label: 'Title change rate', pick: (r) => r.titleChangeRate, target: [0.2, 0.4], digits: 3 },
  { label: 'Defenses per reign', pick: (r) => r.defensesPerReign, target: [1, 3], digits: 2 },
  { label: 'Champions with a defense', pick: (r) => r.championsWithADefense, target: [0.45, 0.7], digits: 3 },
  // Band reasoning: a given division should sit longer than six months without a champion
  // less often than once a decade. That is 0.1 per division per year. The previous version
  // of this row compared a raw spell count against a fixed band, so a ten year run was held
  // to the same number as a five year run and the row said more about run length than about
  // the world. The raw count is still printed below it as a diagnostic.
  { label: 'Long vacancies per division per year', pick: (r) => r.longVacanciesPerDivisionPerYear, target: [0, 0.1], digits: 3 },
  { label: 'Long vacancy spells in the run', pick: (r) => r.longVacancySpells, digits: 1 },
  { label: 'Interim titles', pick: (r) => r.interimTitles, digits: 1 },
  { label: 'Generated fighters who became champion', pick: (r) => r.generatedChampions, digits: 1 },
  { label: 'Generated share of ranked fighters', pick: (r) => r.generatedRankedShare, digits: 3 },
  { label: 'Retirements per year', pick: (r) => r.retirementsPerYear, digits: 1 },
  { label: 'Injuries per fight', pick: (r) => r.injuryRate, digits: 3 },
  { label: 'Weight miss rate per fighter bout', pick: (r) => r.weightMissRate, target: [0, 0.08], digits: 4 },
  { label: 'Fights per active fighter per year', pick: (r) => r.activityMean, target: [1.2, 3.2], digits: 2 },
  { label: 'Share fighting more than four times a year', pick: (r) => r.activityOverFourShare, target: [0, 0.05], digits: 4 },
  { label: 'Mean pay per view buys', pick: (r) => r.meanPpvBuys, digits: 0 },
  { label: 'Bonuses per event', pick: (r) => r.bonusesPerEvent, target: [2, 4], digits: 2 },
  { label: 'Save size in MB', pick: (r) => r.saveSizeMb, digits: 2 },
  { label: 'Runtime seconds', pick: (r) => r.runtimeSec, digits: 1 },
];

console.log(`\n${'METRIC'.padEnd(42)} ${'MEAN'.padStart(11)} ${'MIN'.padStart(11)} ${'MAX'.padStart(11)}  ${'TARGET'.padStart(14)}  STATUS`);
console.log('-'.repeat(112));
let outOfBand = 0;
for (const row of ROWS) {
  const a = agg(row.pick);
  const d = row.digits ?? 2;
  const target = row.target ? `${row.target[0]} to ${row.target[1]}` : '';
  const status = row.target ? (a.mean >= row.target[0] && a.mean <= row.target[1] ? 'ok' : 'OUT') : '';
  if (status === 'OUT') outOfBand++;
  console.log(
    `${row.label.padEnd(42)} ${a.mean.toFixed(d).padStart(11)} ${a.min.toFixed(d).padStart(11)} ${a.max.toFixed(d).padStart(11)}  ${target.padStart(14)}  ${status}`
  );
}
console.log('-'.repeat(112));
console.log(`${runs.length} runs, ${outOfBand} metric${outOfBand === 1 ? '' : 's'} outside the target band.`);

writeFileSync(
  join(ROOT, 'docs', 'ACCEPTANCE.json'),
  JSON.stringify({ measuredAt: new Date().toISOString(), config: { FIVE, TEN, TWENTY }, runs }, null, 2)
);
console.log('written to docs/ACCEPTANCE.json');
