import { loadSnapshot } from '../src/core/testing/fixtures';
import { createNewGame } from '../src/core/world/newgame';
import { advance } from '../src/core/world/tick';

/**
 * Fights per year by career tier.
 *
 * The tier is decided at the time of each fight, not at the end of the run. Classifying by final
 * status counted every fight a contender had on the way up as a champion's fight, which made the
 * champion tier look far busier than it is.
 */
const YEARS = Number(process.argv[2] ?? 3);
const SEEDS = Number(process.argv[3] ?? 3);
const snapshot = loadSnapshot();

type Tier = 'champion' | 'interim-or-top' | 'ranked' | 'unranked';
const BANDS: Record<Tier, [number, number]> = {
  champion: [1, 2],
  'interim-or-top': [1, 3],
  ranked: [2, 3],
  unranked: [2, 4],
};

/** Fighter time spent in each tier, and fights taken while in it. */
const fightsIn: Record<Tier, number> = { champion: 0, 'interim-or-top': 0, ranked: 0, unranked: 0 };
const yearsIn: Record<Tier, number> = { champion: 0, 'interim-or-top': 0, ranked: 0, unranked: 0 };

/** The fighter's rank on the most recent ranking snapshot at or before a date. */



for (let s = 0; s < SEEDS; s++) {
  const { save } = createNewGame(snapshot, { saveName: 'bands', seed: 900 + s, mode: 'spectator' });
  for (let y = 0; y < YEARS; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });

  // Only the final twelve months are counted, and the tier is the one the fighter is in now. Over
  // a single year a fighter's tier rarely changes, so this attributes fights to the right tier
  // without needing a full history of every ranking table.
  const windowStart = new Date(new Date(save.date).getTime() - 365 * 86400000).toISOString().slice(0, 10);

  for (const f of Object.values(save.fighters)) {
    if (f.retired || f.activityStatus !== 'active') continue;
    const table = save.rankings[f.divisionId];
    const tier: Tier =
      table?.championId === f.id
        ? 'champion'
        : table?.interimChampionId === f.id || (f.ranking !== null && f.ranking <= 5)
          ? 'interim-or-top'
          : f.ranking !== null
            ? 'ranked'
            : 'unranked';
    yearsIn[tier] += 1;
    for (const id of f.boutIds) {
      const r = save.history.results[id];
      if (!r || r.date < windowStart) continue;
      fightsIn[tier]++;
    }
  }
}

console.log(`\nFights per year by tier at the time of the fight: ${SEEDS} seeds of ${YEARS} years\n`);
let failures = 0;
for (const tier of Object.keys(BANDS) as Tier[]) {
  const rate = yearsIn[tier] > 0 ? fightsIn[tier] / yearsIn[tier] : 0;
  const [lo, hi] = BANDS[tier];
  const ok = rate >= lo && rate <= hi;
  if (!ok) failures++;
  console.log(
    `  ${tier.padEnd(16)} ${rate.toFixed(2)} fights per year   ${fightsIn[tier]} fights over ${yearsIn[tier].toFixed(0)} fighter years   band ${lo} to ${hi}  ${ok ? 'ok' : 'OUTSIDE'}`
  );
}
console.log(`\n  ${failures} tier${failures === 1 ? '' : 's'} outside band\n`);
if (failures > 0) process.exitCode = 1;
