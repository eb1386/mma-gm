/**
 * Batch calibration harness.
 *
 * Runs a large number of fights between generated fighters and reports the outcome
 * distributions that matter: finish rate by method, round of finish, significant strike
 * volume, takedown rates, control time and decision types.
 *
 * Fighters are paired within about three Ovr of each other, the way real matchmaking pairs
 * them. Two independent draws produced mismatches that finished far more often than booked
 * fights do, which hid a decision heavy engine behind a healthy looking finish rate.
 *
 * Run with:  npx vite-node tools/calibrate.ts [fights] [seed]
 *
 * The reference bands printed alongside each metric are the shape of publicly reported
 * UFC aggregate outcomes. They are calibration targets for this engine, not claims about
 * any specific promotion statistic.
 */
import { DIVISIONS, type DivisionId } from '../src/core/config/divisions';
import { Rng } from '../src/core/rng';
import { simulateFight } from '../src/core/sim/engine';
import { DEFAULT_SETTINGS } from '../src/core/types/save';
import { isDecision, isFinish, type FinishMethod } from '../src/core/types/fight';
import { generateFighter } from '../src/core/world/generator';
import type { GamePlanKey } from '../src/core/types/world';

const N = Number(process.argv[2] ?? 3000);
const SEED = Number(process.argv[3] ?? 20260728);

const PLANS: GamePlanKey[][] = [
  ['pressure'],
  ['counter'],
  ['outside-range', 'leg-kick-attack'],
  ['takedown-pressure', 'top-control'],
  ['submission-hunting'],
  ['high-pace', 'pressure'],
  ['conservative-pace', 'counter'],
  ['pocket-boxing'],
  ['fence-wrestling'],
  ['body-attack', 'pressure'],
];

interface Bucket {
  count: number;
  methods: Record<string, number>;
  rounds: Record<number, number>;
  sigA: number;
  sigB: number;
  sigAtt: number;
  decisions: number;
  splits: number;
  majorities: number;
  draws: number;
  scoredRounds: number;
  dissentRounds: number;
  kdEvents: number;
  kdFinishes: number;
  tdA: number;
  tdB: number;
  ctrl: number;
  minutes: number;
  kd: number;
  subAtt: number;
  quality: number;
}

function newBucket(): Bucket {
  return { count: 0, methods: {}, rounds: {}, sigA: 0, sigB: 0, sigAtt: 0, decisions: 0, splits: 0, majorities: 0, draws: 0, scoredRounds: 0, dissentRounds: 0, kdEvents: 0, kdFinishes: 0, tdA: 0, tdB: 0, ctrl: 0, minutes: 0, kd: 0, subAtt: 0, quality: 0 };
}

const aggregate = newBucket();
const byDivision = new Map<DivisionId, Bucket>();
const rng = new Rng(SEED);
let idCounter = 0;

const t0 = Date.now();

for (let i = 0; i < N; i++) {
  const division = rng.pick(DIVISIONS);
  const targetA = rng.normalClamped(72, 8, 45, 95);
  const targetB = rng.normalClamped(targetA, 1.5, targetA - 3, targetA + 3);
  const a = generateFighter(rng, { divisionId: division.id, targetOvr: targetA, today: '2026-01-01', idNumber: idCounter++ });
  const b = generateFighter(rng, { divisionId: division.id, targetOvr: targetB, today: '2026-01-01', idNumber: idCounter++ });
  const scheduledRounds: 3 | 5 = rng.chance(0.12) ? 5 : 3;

  const result = simulateFight({
    boutId: `cal-${i}`,
    eventId: 'cal',
    date: '2026-01-01',
    divisionId: division.id,
    scheduledRounds,
    isTitleFight: false,
    isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
    contractedWeightLb: division.limitLb + 1,
    settings: DEFAULT_SETTINGS,
    seed: rng.nextUint32(),
    a: {
      fighter: a,
      gamePlan: rng.pick(PLANS),
      sharpness: rng.range(0.4, 1),
      tacticalFamiliarity: rng.range(0.3, 0.9),
      cutQuality: rng.range(0.5, 1),
      campQuality: rng.range(0.5, 1),
      shortNotice: false,
    },
    b: {
      fighter: b,
      gamePlan: rng.pick(PLANS),
      sharpness: rng.range(0.4, 1),
      tacticalFamiliarity: rng.range(0.3, 0.9),
      cutQuality: rng.range(0.5, 1),
      campQuality: rng.range(0.5, 1),
      shortNotice: false,
    },
  });

  for (const bucket of [aggregate, byDivision.get(division.id) ?? (byDivision.set(division.id, newBucket()), byDivision.get(division.id)!)]) {
    bucket.count++;
    const cat = categorize(result.method);
    bucket.methods[cat] = (bucket.methods[cat] ?? 0) + 1;
    if (isFinish(result.method)) bucket.rounds[result.endRound] = (bucket.rounds[result.endRound] ?? 0) + 1;
    bucket.sigA += result.totalsA.sigStrikesLanded;
    bucket.sigB += result.totalsB.sigStrikesLanded;
    bucket.sigAtt += result.totalsA.sigStrikesAttempted + result.totalsB.sigStrikesAttempted;
    if (isDecision(result.method)) {
      bucket.decisions++;
      if (result.method === 'decision-split') bucket.splits++;
      if (result.method === 'decision-majority') bucket.majorities++;
      if (result.method.startsWith('draw')) bucket.draws++;
      const cards = result.scorecards;
      for (let r = 0; r < (cards[0]?.rounds.length ?? 0); r++) {
        bucket.scoredRounds++;
        const winners = new Set(cards.map((c) => Math.sign(c.rounds[r].a - c.rounds[r].b)));
        if (winners.size > 1) bucket.dissentRounds++;
      }
    }
    // A knockdown ends the fight when the next thing that happens to the downed fighter is the
    // stoppage, in the same round.
    result.events.forEach((e, idx) => {
      if (!e.tags.includes('knockdown')) return;
      bucket.kdEvents++;
      const next = result.events.slice(idx + 1).find((x) => x.tags.includes('finish') || x.tags.includes('knockdown'));
      if (next && next.tags.includes('finish') && next.round === e.round && (result.method === 'ko' || result.method.startsWith('tko'))) bucket.kdFinishes++;
    });
    bucket.tdA += result.totalsA.takedownsLanded;
    bucket.tdB += result.totalsB.takedownsLanded;
    bucket.ctrl += result.totalsA.controlSeconds + result.totalsB.controlSeconds;
    bucket.kd += result.totalsA.knockdowns + result.totalsB.knockdowns;
    bucket.subAtt += result.totalsA.submissionAttempts + result.totalsB.submissionAttempts;
    bucket.quality += result.fightQuality;
    bucket.minutes += (result.endRound - 1) * 5 + result.endTimeSeconds / 60;
  }
}

function categorize(m: FinishMethod): string {
  if (m === 'ko') return 'KO';
  if (m === 'tko-strikes' || m === 'tko-ground-strikes') return 'TKO';
  if (m === 'submission' || m === 'technical-submission') return 'SUB';
  if (m === 'doctor-stoppage' || m === 'corner-stoppage' || m === 'retirement') return 'STOP-other';
  if (isDecision(m)) return m.startsWith('draw') || m.startsWith('technical-draw') ? 'DRAW' : 'DEC';
  return 'OTHER';
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

function report(name: string, b: Bucket): void {
  const totalMin = b.minutes;
  const perFighterMinutes = totalMin;
  console.log(`\n=== ${name}  (n=${b.count}) ===`);
  const order = ['KO', 'TKO', 'SUB', 'STOP-other', 'DEC', 'DRAW', 'OTHER'];
  const parts = order.filter((k) => b.methods[k]).map((k) => `${k} ${pct(b.methods[k], b.count)}`);
  console.log(`  methods:      ${parts.join('  ')}`);
  const finishes = (b.methods['KO'] ?? 0) + (b.methods['TKO'] ?? 0) + (b.methods['SUB'] ?? 0) + (b.methods['STOP-other'] ?? 0);
  console.log(`  finish rate:  ${pct(finishes, b.count)}   [reference band 44% to 52%]`);
  const rd = Object.entries(b.rounds)
    .sort((x, y) => Number(x[0]) - Number(y[0]))
    .map(([r, c]) => `R${r} ${pct(c, finishes)}`);
  console.log(`  finish round: ${rd.join('  ')}`);
  const share = (r: number) => (b.rounds[r] ?? 0) / Math.max(1, finishes);
  console.log(
    `  R1/R2/R3:     ${pct(b.rounds[1] ?? 0, finishes)} / ${pct(b.rounds[2] ?? 0, finishes)} / ${pct(b.rounds[3] ?? 0, finishes)}   [reference about 45% / 30% / 25%]${share(1) < share(3) ? '   R1 BELOW R3' : ''}`
  );
  console.log(`  sig str/min:  ${((b.sigA + b.sigB) / 2 / perFighterMinutes).toFixed(2)} per fighter   [reference band 3.4 to 4.4]`);
  console.log(`  avg fight:    ${(totalMin / b.count).toFixed(2)} min      [reference band 9.0 to 11.5]`);
  console.log(`  td/15min:     ${(((b.tdA + b.tdB) / 2 / perFighterMinutes) * 15).toFixed(2)} per fighter   [reference band 1.3 to 2.1]`);
  console.log(`  sub att/15:   ${((b.subAtt / 2 / perFighterMinutes) * 15).toFixed(2)} per fighter   [reference band 0.4 to 0.9]`);
  console.log(`  kd/15min:     ${((b.kd / 2 / perFighterMinutes) * 15).toFixed(2)} per fighter   [reference band 0.4 to 0.8]`);
  console.log(`  kd to finish: ${pct(b.kdFinishes, Math.max(1, b.kdEvents))} of knockdowns   [reference band 40% to 50%]`);
  console.log(`  sig accuracy: ${pct(b.sigA + b.sigB, Math.max(1, b.sigAtt))}   [reference band 45% to 50%]`);
  console.log(
    `  decisions:    split ${pct(b.splits, Math.max(1, b.decisions))} [10% to 15%]  majority ${pct(b.majorities, Math.max(1, b.decisions))} [2% to 4%]  draws ${pct(b.draws, Math.max(1, b.decisions))} [1% or less]  round dissent ${pct(b.dissentRounds, Math.max(1, b.scoredRounds))}`
  );
  console.log(`  control:      ${((b.ctrl / b.count / 60)).toFixed(2)} min combined per fight`);
  console.log(`  avg quality:  ${(b.quality / b.count).toFixed(1)}`);
}

report('ALL DIVISIONS', aggregate);
for (const d of DIVISIONS) {
  const b = byDivision.get(d.id);
  if (b) report(d.name, b);
}
console.log(`\nran ${N} fights in ${((Date.now() - t0) / 1000).toFixed(2)}s (${((Date.now() - t0) / N).toFixed(2)} ms per fight)`);
