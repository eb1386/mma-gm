import { Rng } from '../src/core/rng';
import { simulateFight } from '../src/core/sim/engine';
import { narrateResult } from '../src/core/narrative/render';
import { DEFAULT_SETTINGS } from '../src/core/types/save';
import { generateFighter } from '../src/core/world/generator';
import { METHOD_LABEL } from '../src/core/types/fight';
import { formatClock } from '../src/core/types/common';

const rng = new Rng(Number(process.argv[2] ?? 77));
const a = generateFighter(rng, { divisionId: 'lightweight', targetOvr: 84, today: '2026-01-01', idNumber: 1 });
const b = generateFighter(rng, { divisionId: 'lightweight', targetOvr: 81, today: '2026-01-01', idNumber: 2 });
const res = simulateFight({
  boutId: 'demo', eventId: 'demo', date: '2026-01-01', divisionId: 'lightweight',
  scheduledRounds: 5, isTitleFight: true, isInterimTitleFight: false, titleIneligibleFighterIds: [], contractedWeightLb: 155,
  settings: DEFAULT_SETTINGS, seed: rng.nextUint32(),
  a: { fighter: a, gamePlan: ['pressure', 'body-attack'], sharpness: 0.9, tacticalFamiliarity: 0.7, cutQuality: 0.9, campQuality: 0.95, shortNotice: false },
  b: { fighter: b, gamePlan: ['counter', 'takedown-pressure'], sharpness: 0.8, tacticalFamiliarity: 0.6, cutQuality: 0.7, campQuality: 0.85, shortNotice: false },
});
const nf = (f: typeof a) => ({ id: f.id, name: f.name, lastName: f.lastName, nickname: f.nickname });
narrateResult(res, nf(a), nf(b));
console.log(`${a.name} (${a.ratings.striking}/${a.ratings.wrestling}) vs ${b.name} (${b.ratings.striking}/${b.ratings.wrestling})\n`);
let round = 0;
for (const e of res.events) {
  if (e.round !== round) { round = e.round; console.log(`\n--- ROUND ${round} ---`); }
  if (e.text) console.log(`  ${formatClock(e.clockSecondsRemaining)}  ${e.text}`);
}
for (const r of res.rounds) console.log(`\n[R${r.round} SUMMARY] ${r.summary}`);
console.log(`\nRESULT: ${METHOD_LABEL[res.method]} R${res.endRound} ${formatClock(res.endTimeSeconds)}`);
console.log(`RECAP: ${res.narrativeSummary}`);
for (const c of res.scorecards) console.log(`  ${c.judgeName}: ${c.totalA}-${c.totalB}`);
