/**
 * Rating worth check.
 *
 * Fights a fighter with all six ratings at 70 against the same fighter with one rating raised,
 * for each rating in turn, and prints the raised fighter's win rate. Ovr is the plain mean of the
 * six, so each rating should be worth roughly the same: a single rating that wins nearly every
 * fight, or one that changes nothing, means the Ovr shown to the player misdescribes how good a
 * fighter really is.
 *
 * Run with:  npx vite-node tools/rating-mirror.ts [fights per rating] [bump]
 *
 * The habits (tendencies) of each pair are borrowed from a real lightweight or welterweight, so
 * the check covers the range of styles the game actually has rather than one invented fighter.
 */
import { DEFAULT_SETTINGS } from '../src/core/types/save';
import { Rng } from '../src/core/rng';
import { simulateFight } from '../src/core/sim/engine';
import { loadSnapshot } from '../src/core/testing/fixtures';
import type { Fighter, Ratings } from '../src/core/types/fighter';

const N = Number(process.argv[2] ?? 1000);
const BUMP = Number(process.argv[3] ?? 10);
const KEYS: (keyof Ratings)[] = ['striking', 'grappling', 'wrestling', 'submissions', 'cardio', 'durability'];
/** The reference band for a +10 bump. Submissions only has a floor. */
const BAND = { low: 57, high: 68, submissionsFloor: 55 };

const pool = loadSnapshot().fighters.filter((f) => f.divisionId === 'lightweight' || f.divisionId === 'welterweight');
const t0 = Date.now();

for (const key of KEYS) {
  const rng = new Rng(21);
  let wins = 0;
  let losses = 0;
  for (let i = 0; i < N; i++) {
    const template = rng.pick(pool);
    const base: Fighter = {
      ...template,
      id: 'base',
      ratings: { striking: 70, grappling: 70, wrestling: 70, submissions: 70, cardio: 70, durability: 70 },
      injuries: [],
    };
    const raised: Fighter = { ...base, id: 'raised', ratings: { ...base.ratings, [key]: 70 + BUMP } };
    const side = (f: Fighter) => ({ fighter: f, gamePlan: [], sharpness: 0.65, tacticalFamiliarity: 0.55, cutQuality: 0.85, campQuality: 0.9, shortNotice: false });
    const result = simulateFight({
      boutId: `mirror-${key}-${i}`,
      eventId: 'mirror',
      date: '2026-10-10',
      divisionId: template.divisionId,
      scheduledRounds: 3,
      isTitleFight: false,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      contractedWeightLb: 156,
      settings: DEFAULT_SETTINGS,
      seed: rng.nextUint32(),
      a: side(raised),
      b: side(base),
    });
    if (result.winnerId === 'raised') wins++;
    else if (result.winnerId === 'base') losses++;
  }
  const rate = (100 * wins) / Math.max(1, wins + losses);
  const floor = key === 'submissions' ? BAND.submissionsFloor : BAND.low;
  const flag = rate < floor ? '   BELOW BAND' : rate > BAND.high ? '   ABOVE BAND' : '';
  console.log(`  +${BUMP} ${key.padEnd(12)} ${rate.toFixed(1)}%   [reference ${floor} to ${BAND.high}]${flag}`);
}
console.log(`\nran ${N * KEYS.length} fights in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
