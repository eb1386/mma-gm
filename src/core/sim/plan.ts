import type { GamePlanKey } from '../types/world';
import type { Tendencies } from '../types/fighter';
import { clamp } from '../rng';
import type { PlanProfile } from './state';

/**
 * Each game plan applies a tradeoff. Nothing here is a free bonus: every entry that
 * raises one desire lowers another or raises the stamina multiplier.
 */
const PLAN_EFFECTS: Record<GamePlanKey, Partial<PlanProfile>> = {
  pressure: { pressure: 0.34, distance: -0.24, pace: 0.16, staminaMult: 0.2, caution: -0.12 },
  counter: { counter: 0.34, pressure: -0.2, pace: -0.1, caution: 0.14, staminaMult: -0.1 },
  'outside-range': { distance: 0.34, pressure: -0.22, caution: 0.12, staminaMult: -0.06 },
  'pocket-boxing': { pressure: 0.24, distance: -0.3, pace: 0.12, caution: -0.24, staminaMult: 0.12 },
  'body-attack': { bodyAttack: 0.4, pace: 0.04, staminaMult: 0.06 },
  'leg-kick-attack': { legKick: 0.42, distance: 0.08, staminaMult: 0.08 },
  'clinch-attack': { clinch: 0.38, distance: -0.26, staminaMult: 0.18 },
  'takedown-pressure': { takedown: 0.38, ground: 0.22, distance: -0.14, staminaMult: 0.26 },
  'fence-wrestling': { clinch: 0.26, takedown: 0.26, ground: 0.2, staminaMult: 0.2, pace: -0.05 },
  'top-control': { ground: 0.34, takedown: 0.18, submission: -0.1, caution: 0.12, pace: -0.08 },
  'submission-hunting': { submission: 0.42, ground: 0.24, caution: -0.18, staminaMult: 0.1 },
  'high-pace': { pace: 0.26, pressure: 0.16, staminaMult: 0.32, caution: -0.1 },
  'conservative-pace': { pace: -0.24, caution: 0.24, staminaMult: -0.2, finishSeeking: -0.14 },
  'early-finish': { finishSeeking: 0.36, pace: 0.18, caution: -0.22, staminaMult: 0.22 },
  'late-fight': { pace: -0.14, caution: 0.14, staminaMult: -0.16, finishSeeking: -0.06 },
  'protect-injury': { caution: 0.3, pace: -0.16, staminaMult: -0.08, protectInjury: true },
  'avoid-strength': { caution: 0.16, avoidStrength: true },
};

export const GAME_PLAN_LABEL: Record<GamePlanKey, string> = {
  pressure: 'Pressure',
  counter: 'Counter',
  'outside-range': 'Outside range',
  'pocket-boxing': 'Pocket boxing',
  'body-attack': 'Body attack',
  'leg-kick-attack': 'Leg kick attack',
  'clinch-attack': 'Clinch attack',
  'takedown-pressure': 'Takedown pressure',
  'fence-wrestling': 'Fence wrestling',
  'top-control': 'Top control',
  'submission-hunting': 'Submission hunting',
  'high-pace': 'High pace',
  'conservative-pace': 'Conservative pace',
  'early-finish': 'Early finish attempt',
  'late-fight': 'Late fight plan',
  'protect-injury': 'Protect an injury',
  'avoid-strength': "Avoid opponent's strength",
};

export const GAME_PLAN_DESCRIPTION: Record<GamePlanKey, string> = {
  pressure: 'Walk the opponent down. More output and more cage control, at a real stamina price.',
  counter: 'Wait and punish. Lower output and lower risk, but close rounds can slip away.',
  'outside-range': 'Fight at the end of the strikes. Works with a reach or movement advantage, less so without one.',
  'pocket-boxing': 'Stand in and trade. Damage goes up for both fighters.',
  'body-attack': 'Invest in the body. Slow to pay off, then it drains the opponent late.',
  'leg-kick-attack': 'Attack the lead leg. Degrades movement and takedown entries over time.',
  'clinch-attack': 'Tie up and work short strikes. Heavy stamina cost for both.',
  'takedown-pressure': 'Shoot early and often. Failed attempts are expensive.',
  'fence-wrestling': 'Force the fight to the fence and work from there.',
  'top-control': 'Take the fight down and hold position. Safe, and referees may stand it up.',
  'submission-hunting': 'Chase the finish on the ground. Position is risked for the attempt.',
  'high-pace': 'Set a punishing tempo. Only viable with the Cardio to back it.',
  'conservative-pace': 'Protect the gas tank. Trades rounds for a fifth round advantage.',
  'early-finish': 'Load up early. High reward, high stamina and damage exposure.',
  'late-fight': 'Bank energy for the championship rounds.',
  'protect-injury': 'Limit the movements that aggravate an injury. Costs output.',
  'avoid-strength': "Steer the fight away from the opponent's best area.",
};

export function buildPlanProfile(t: Tendencies, plans: GamePlanKey[]): PlanProfile {
  const p: PlanProfile = {
    pressure: t.pressure,
    distance: t.range,
    takedown: t.takedownEntry,
    ground: t.topControl,
    submission: t.submissionHunt,
    clinch: t.clinch,
    legKick: t.kicking * 0.6,
    bodyAttack: 0.3,
    pace: t.pace,
    staminaMult: 1,
    finishSeeking: t.finishSeeking,
    caution: 1 - t.riskTolerance,
    counter: t.counter,
    protectInjury: false,
    avoidStrength: false,
  };
  for (const key of plans) {
    const eff = PLAN_EFFECTS[key];
    if (!eff) continue;
    for (const [k, v] of Object.entries(eff)) {
      if (typeof v === 'boolean') {
        (p as unknown as Record<string, boolean>)[k] = v;
      } else if (k === 'staminaMult') {
        p.staminaMult += v as number;
      } else {
        const cur = (p as unknown as Record<string, number>)[k] ?? 0;
        (p as unknown as Record<string, number>)[k] = cur + (v as number);
      }
    }
  }
  const numeric: (keyof PlanProfile)[] = [
    'pressure',
    'distance',
    'takedown',
    'ground',
    'submission',
    'clinch',
    'legKick',
    'bodyAttack',
    'pace',
    'finishSeeking',
    'caution',
    'counter',
  ];
  for (const k of numeric) {
    (p as unknown as Record<string, number>)[k] = clamp((p as unknown as Record<string, number>)[k], 0.02, 1.35);
  }
  p.staminaMult = clamp(p.staminaMult, 0.6, 1.8);
  return p;
}

/**
 * A conflicting plan set wastes the camp. Returns a 0 to 1 coherence value used to scale
 * tactical familiarity, so stacking every aggressive plan is not a free win.
 */
export function planCoherence(plans: GamePlanKey[]): number {
  if (plans.length === 0) return 0.5;
  const conflicts: [GamePlanKey, GamePlanKey][] = [
    ['pressure', 'counter'],
    ['pressure', 'outside-range'],
    ['pocket-boxing', 'outside-range'],
    ['high-pace', 'conservative-pace'],
    ['high-pace', 'late-fight'],
    ['early-finish', 'conservative-pace'],
    ['early-finish', 'late-fight'],
    ['top-control', 'submission-hunting'],
    ['takedown-pressure', 'outside-range'],
    ['clinch-attack', 'outside-range'],
  ];
  let penalty = 0;
  for (const [x, y] of conflicts) {
    if (plans.includes(x) && plans.includes(y)) penalty += 0.22;
  }
  // Too many simultaneous priorities dilutes preparation.
  if (plans.length > 3) penalty += (plans.length - 3) * 0.12;
  return clamp(1 - penalty, 0.2, 1);
}
