import { Rng } from '../src/core/rng';
import { DIVISIONS } from '../src/core/config/divisions';
import { DEFAULT_SETTINGS } from '../src/core/types/save';
import { simulateFight } from '../src/core/sim/engine';
import { generateFighter } from '../src/core/world/generator';
import { isDecision } from '../src/core/types/fight';
import type { GamePlanKey } from '../src/core/types/world';

const N = Number(process.argv[2] ?? 1200);
const PLANS: GamePlanKey[][] = [['pressure'], ['counter'], ['outside-range'], ['takedown-pressure'], ['top-control'], ['high-pace']];
const rng = new Rng(20260101);

let r109 = 0, r108 = 0, r107 = 0, r1010 = 0, other = 0;
let unan = 0, split = 0, major = 0, decisions = 0;
const cards3 = new Map<string, number>();
const cards5 = new Map<string, number>();
let marginTotal = 0;

for (let i = 0; i < N; i++) {
  const division = rng.pick(DIVISIONS.filter((d) => d.activeUntil === null));
  const a = generateFighter(rng, { divisionId: division.id, targetOvr: rng.range(58, 88), today: '2026-01-01', idNumber: i * 2 });
  const b = generateFighter(rng, { divisionId: division.id, targetOvr: rng.range(58, 88), today: '2026-01-01', idNumber: i * 2 + 1 });
  const rounds: 3 | 5 = rng.chance(0.15) ? 5 : 3;
  const result = simulateFight({
    boutId: `sc-${i}`, eventId: 'sc', date: '2026-01-01', divisionId: division.id,
    scheduledRounds: rounds, isTitleFight: false, isInterimTitleFight: false,
    titleIneligibleFighterIds: [], contractedWeightLb: division.limitLb + 1,
    settings: DEFAULT_SETTINGS, seed: rng.nextUint32(),
    a: { fighter: a, gamePlan: rng.pick(PLANS), sharpness: rng.range(0.5, 1), tacticalFamiliarity: rng.range(0.3, 0.9), cutQuality: rng.range(0.6, 1), campQuality: rng.range(0.5, 1), shortNotice: false },
    b: { fighter: b, gamePlan: rng.pick(PLANS), sharpness: rng.range(0.5, 1), tacticalFamiliarity: rng.range(0.3, 0.9), cutQuality: rng.range(0.6, 1), campQuality: rng.range(0.5, 1), shortNotice: false },
  });
  if (!isDecision(result.method)) continue;
  decisions++;
  if (result.method === 'decision-unanimous') unan++;
  else if (result.method === 'decision-split') split++;
  else if (result.method === 'decision-majority') major++;

  for (const card of result.scorecards) {
    for (const rd of card.rounds) {
      const lo = Math.min(rd.a, rd.b);
      const hi = Math.max(rd.a, rd.b);
      if (hi === 10 && lo === 10) r1010++;
      else if (hi === 10 && lo === 9) r109++;
      else if (hi === 10 && lo === 8) r108++;
      else if (hi === 10 && lo === 7) r107++;
      else other++;
    }
    const key = `${Math.max(card.totalA, card.totalB)}-${Math.min(card.totalA, card.totalB)}`;
    marginTotal += Math.abs(card.totalA - card.totalB);
    if (card.rounds.length === 3) cards3.set(key, (cards3.get(key) ?? 0) + 1);
    else cards5.set(key, (cards5.get(key) ?? 0) + 1);
  }
}

const totalRounds = r109 + r108 + r107 + r1010 + other;
const pct = (n: number) => ((n / Math.max(1, totalRounds)) * 100).toFixed(2);
console.log(`\nScorecard calibration: ${N} fights, ${decisions} decisions, ${totalRounds} scored rounds\n`);
console.log(`  10-9   ${pct(r109).padStart(6)}%   target 90 to 97`);
console.log(`  10-8   ${pct(r108).padStart(6)}%   target 3 to 9`);
console.log(`  10-7   ${pct(r107).padStart(6)}%   target below 0.5`);
console.log(`  10-10  ${pct(r1010).padStart(6)}%`);
console.log(`  other  ${pct(other).padStart(6)}%`);
const dpct = (n: number) => ((n / Math.max(1, decisions)) * 100).toFixed(1);
console.log(`\n  unanimous ${dpct(unan)}%   split ${dpct(split)}%   majority ${dpct(major)}%`);
console.log(`  average winning margin ${(marginTotal / Math.max(1, decisions * 3)).toFixed(2)} points`);
const top = (m: Map<string, number>, n = 6) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ');
console.log(`\n  common three round cards: ${top(cards3)}`);
console.log(`  common five round cards:  ${top(cards5)}`);
const p107 = Number(pct(r107)), p108 = Number(pct(r108)), p109 = Number(pct(r109));
const splitPct = Number(dpct(split));
const failures: string[] = [];
if (p107 > 0.5) failures.push(`10-7 at ${p107}% exceeds 0.5%`);
if (p109 < 90 || p109 > 97) failures.push(`10-9 at ${p109}% outside 90 to 97`);
if (p108 < 3 || p108 > 9) failures.push(`10-8 at ${p108}% outside 3 to 9`);
if (splitPct <= 0) failures.push('split decisions are impossible');
const fail = failures.length > 0;
for (const f of failures) console.log(`  FAIL: ${f}`);
console.log(`\n  ${fail ? 'RELEASE GATE FAILS' : 'release gate passes'}`);
