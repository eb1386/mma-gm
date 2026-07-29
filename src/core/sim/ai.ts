import { CALIBRATION as C } from '../config/calibration';
import { clamp, Rng } from '../rng';
import type { FightAction, StrikeAction, SubmissionName, WrestlingAction } from '../types/fight';
import { effective } from './effective';
import { GROUND_VALUE, opponentOf, totalLegDamage, type FightState, type SideState } from './state';

export interface Decision {
  action: FightAction;
  target?: 'head' | 'body' | 'leg';
  /** Commitment level, 0 to 1. Higher means more damage, more stamina and more exposure. */
  power: number;
  /** Set when the fighter is deliberately closing or opening distance with the action. */
  rangeIntent?: -1 | 0 | 1;
}

interface Weighted<T> {
  item: T;
  weight: number;
}

function pickWeighted<T>(rng: Rng, options: Weighted<T>[]): T {
  return rng.weighted(options, (o) => o.weight).item;
}

// ---------------------------------------------------------------------------
// Situational assessment
// ---------------------------------------------------------------------------

/**
 * The AI's own read of the scorecard. It uses the same statistics a judge would see,
 * never the hidden true score and never any knowledge of future random outcomes.
 */
export function estimateRoundLead(st: FightState, side: SideState): number {
  const opp = opponentOf(st, side);
  const mine = side.roundStats;
  const theirs = opp.roundStats;
  let score = 0;
  score += (mine.sigStrikesLanded - theirs.sigStrikesLanded) * 1.0;
  score += (mine.knockdowns - theirs.knockdowns) * 9;
  score += (mine.takedownsLanded - theirs.takedownsLanded) * 3;
  score += (mine.controlSeconds - theirs.controlSeconds) * 0.03;
  score += (mine.submissionAttempts - theirs.submissionAttempts) * 2.2;
  score += (opp.damage.head - side.damage.head) * 0.12;
  return score;
}

export function estimateFightLead(st: FightState, side: SideState): number {
  const opp = opponentOf(st, side);
  let score = 0;
  score += (side.fightStats.sigStrikesLanded - opp.fightStats.sigStrikesLanded) * 0.7;
  score += (side.fightStats.knockdowns - opp.fightStats.knockdowns) * 8;
  score += (side.fightStats.takedownsLanded - opp.fightStats.takedownsLanded) * 2.6;
  score += (side.fightStats.controlSeconds - opp.fightStats.controlSeconds) * 0.025;
  return score;
}

/**
 * Refreshes the live tactical stance. Called at round start and occasionally mid round.
 * A fighter behind late takes more risk, a fighter ahead late protects, a tired wrestler
 * stops shooting, a hurt fighter looks for a place to survive.
 */
export function updateTactics(st: FightState, side: SideState, rng: Rng): void {
  const opp = opponentOf(st, side);
  const roundsLeft = st.scheduledRounds - st.round;
  const fightLead = estimateFightLead(st, side);
  const roundLead = estimateRoundLead(st, side);
  const lateInRound = st.clock < 90;
  const lateInFight = roundsLeft === 0 || (roundsLeft === 1 && st.clock < 150);

  side.desperate = false;
  side.protectingLead = false;

  if (lateInFight && fightLead < -6) {
    side.desperate = true;
  } else if (lateInFight && fightLead > 8) {
    side.protectingLead = true;
  } else if (lateInRound && roundLead < -4 && roundsLeft <= 1) {
    side.desperate = true;
  }

  const staminaFactor = clamp(side.stamina / 70, 0.35, 1.15);
  const hurt = side.stunSecondsRemaining > 0 || side.damage.head > 45;

  let aggression = side.plan.pressure * 0.55 + side.plan.pace * 0.45;
  if (side.desperate) aggression *= C.ai.desperationScale;
  if (side.protectingLead) aggression /= C.ai.leadProtectionScale;
  if (hurt) aggression *= 0.55;
  aggression *= staminaFactor;
  side.aggression = clamp(aggression, 0.08, 1.6);

  // Pace target. Five round fights force a lower early ceiling for anyone sensible.
  const paceCeiling = st.scheduledRounds === 5 && st.round <= 2 ? C.ai.fiveRoundPacing : 1;
  side.paceTarget = clamp(side.plan.pace * paceCeiling * staminaFactor, 0.15, 1.3);

  // Where does this fighter want the fight.
  const myGroundEdge =
    effective(st, side, 'ground-offense') - effective(st, opp, 'ground-defense') + (effective(st, side, 'takedown-offense') - effective(st, opp, 'takedown-defense'));
  const myStandingEdge = effective(st, side, 'strike-offense') - effective(st, opp, 'strike-defense');

  let groundDesire = side.plan.takedown * 0.5 + side.plan.ground * 0.5;
  groundDesire += clamp(myGroundEdge / 40, -0.35, 0.45);
  if (side.plan.avoidStrength && myStandingEdge < myGroundEdge) groundDesire += 0.2;
  if (side.stamina < 40) groundDesire -= 0.25;
  if (hurt) groundDesire += 0.28;
  side.wantsGround = groundDesire > 0.5 + (rng.next() - 0.5) * 0.12;

  let distanceDesire = side.plan.distance + clamp(side.reachAdvantage / 8, -0.25, 0.3);
  if (side.protectingLead) distanceDesire += 0.18;
  if (hurt) distanceDesire += 0.3;
  if (side.desperate) distanceDesire -= 0.24;
  if (totalLegDamage(side.damage) > C.striking.legDamageMobilityThreshold) distanceDesire -= 0.2;
  side.wantsDistance = distanceDesire > side.plan.pressure;
}

// ---------------------------------------------------------------------------
// Action menus
// ---------------------------------------------------------------------------

const PUNCHES_LONG: StrikeAction[] = ['jab', 'cross'];
const PUNCHES_BOXING: StrikeAction[] = ['jab', 'cross', 'hook', 'overhand', 'body-punch', 'combination'];
const PUNCHES_POCKET: StrikeAction[] = ['hook', 'uppercut', 'overhand', 'combination', 'body-punch'];

function kickOptions(side: SideState, st: FightState): Weighted<StrikeAction>[] {
  const legDamage = totalLegDamage(side.damage);
  const mobility = clamp(1 - legDamage / 60, 0.25, 1);
  const kickSkill = side.tendencies.kicking;
  const risky = side.tendencies.riskTolerance;
  const injuredKicks = side.injuryEffects.some((i) => i.blocksKicks);
  const kickMult = (injuredKicks ? 0.25 : 1) * mobility;
  const range = st.position.range;
  const rangeOk = range === 'long' || range === 'kick';
  const list: Weighted<StrikeAction>[] = [
    { item: 'low-kick', weight: kickSkill * (0.8 + side.plan.legKick * 1.6) * kickMult * (rangeOk ? 1.2 : 0.5) },
    { item: 'calf-kick', weight: kickSkill * (0.55 + side.plan.legKick * 1.4) * kickMult * (rangeOk ? 1.1 : 0.4) },
    { item: 'body-kick', weight: kickSkill * (0.5 + side.plan.bodyAttack * 0.9) * kickMult * (rangeOk ? 1 : 0.3) },
    { item: 'head-kick', weight: kickSkill * 0.28 * kickMult * (0.5 + risky) * (rangeOk ? 1 : 0.2) },
    { item: 'front-kick', weight: kickSkill * 0.3 * kickMult * (side.plan.distance + 0.3) },
    { item: 'side-kick', weight: kickSkill * 0.14 * kickMult * side.plan.distance },
    { item: 'spinning-kick', weight: kickSkill * 0.1 * kickMult * risky * (side.desperate ? 2.2 : 1) },
  ];
  return list.filter((o) => o.weight > 0.001);
}

function chooseStandingStrike(st: FightState, side: SideState, rng: Rng): Decision {
  const range = st.position.range;
  const opts: Weighted<StrikeAction>[] = [];
  const pocketBias = 1 - side.plan.distance;

  if (range === 'long') {
    for (const p of PUNCHES_LONG) opts.push({ item: p, weight: p === 'jab' ? 1.5 : 0.7 });
    opts.push(...kickOptions(side, st).map((k) => ({ item: k.item, weight: k.weight * 1.35 })));
  } else if (range === 'kick') {
    for (const p of PUNCHES_LONG) opts.push({ item: p, weight: p === 'jab' ? 1.2 : 0.9 });
    opts.push({ item: 'hook', weight: 0.35 });
    opts.push(...kickOptions(side, st).map((k) => ({ item: k.item, weight: k.weight * 1.15 })));
  } else if (range === 'boxing') {
    for (const p of PUNCHES_BOXING) {
      const base = p === 'jab' ? 1.25 : p === 'combination' ? 0.75 + side.plan.pace * 0.6 : 0.85;
      opts.push({ item: p, weight: base * (p === 'body-punch' ? 0.6 + side.plan.bodyAttack : 1) });
    }
    opts.push(...kickOptions(side, st).map((k) => ({ item: k.item, weight: k.weight * 0.55 })));
    opts.push({ item: 'knee', weight: 0.18 * side.tendencies.clinch });
  } else {
    for (const p of PUNCHES_POCKET) {
      opts.push({
        item: p,
        weight: (p === 'combination' ? 0.9 + side.plan.pace * 0.7 : 1) * (p === 'body-punch' ? 0.7 + side.plan.bodyAttack : 1) * pocketBias,
      });
    }
    opts.push({ item: 'elbow', weight: 0.34 * side.tendencies.clinch });
    opts.push({ item: 'knee', weight: 0.26 * side.tendencies.clinch });
    opts.push({ item: 'uppercut', weight: 0.7 });
    opts.push({ item: 'spinning-elbow', weight: 0.05 * side.tendencies.riskTolerance * (side.desperate ? 2 : 1) });
  }

  // A fighter who wants a finish loads up. A cautious one picks safer shots.
  const commit = clamp(side.plan.finishSeeking * 0.6 + side.aggression * 0.4 + (side.desperate ? 0.3 : 0) - side.plan.caution * 0.25, 0.05, 1);
  const name = pickWeighted(rng, opts);

  let target: 'head' | 'body' | 'leg' = 'head';
  if (name === 'low-kick' || name === 'calf-kick') target = 'leg';
  else if (name === 'body-kick' || name === 'body-punch') target = 'body';
  else if (name === 'front-kick') target = rng.chance(0.55) ? 'body' : 'head';
  else if (rng.chance(clamp(side.plan.bodyAttack * 0.3, 0.03, 0.3))) target = 'body';

  const power =
    name === 'jab'
      ? clamp(commit * 0.5, 0.05, 0.55)
      : name === 'combination'
        ? clamp(commit * 0.75, 0.1, 0.85)
        : name === 'spinning-kick' || name === 'spinning-elbow' || name === 'head-kick' || name === 'overhand'
          ? clamp(0.6 + commit * 0.4, 0.4, 1)
          : clamp(commit, 0.08, 1);

  return { action: { kind: 'strike', name }, target, power };
}

function takedownOptions(st: FightState, side: SideState): Weighted<WrestlingAction>[] {
  const fromClinch = st.position.zone === 'clinch';
  const fence = st.position.clinchKind === 'fence';
  const wrestlingSkill = side.base.wrestling / 100;
  const legDamage = totalLegDamage(side.damage);
  const shotPenalty = clamp(1 - legDamage / 50, 0.3, 1);
  const blocked = side.injuryEffects.some((i) => i.blocksTakedowns) ? 0.3 : 1;
  if (fromClinch) {
    return [
      { item: 'body-lock', weight: 1 * wrestlingSkill * blocked },
      { item: 'outside-trip', weight: 0.8 * wrestlingSkill * blocked },
      { item: 'inside-trip', weight: 0.6 * wrestlingSkill * blocked },
      { item: 'foot-sweep', weight: 0.4 * wrestlingSkill * blocked },
      { item: 'hip-throw', weight: 0.35 * wrestlingSkill * side.tendencies.riskTolerance * blocked },
      { item: 'fence-takedown', weight: (fence ? 1.6 : 0.4) * wrestlingSkill * blocked },
    ];
  }
  return [
    { item: 'double-leg', weight: 1.1 * wrestlingSkill * shotPenalty * blocked },
    { item: 'single-leg', weight: 1.0 * wrestlingSkill * shotPenalty * blocked },
    { item: 'reactive-takedown', weight: 0.45 * side.tendencies.counter * wrestlingSkill * blocked },
    { item: 'catch-kick-takedown', weight: 0.25 * side.tendencies.counter * wrestlingSkill * blocked },
    { item: 'body-lock', weight: 0.4 * wrestlingSkill * blocked },
  ];
}

function chooseStandingAction(st: FightState, side: SideState, rng: Rng): Decision {
  const pos = st.position;
  const opp = opponentOf(st, side);
  const hurt = side.stunSecondsRemaining > 0;

  // A stunned fighter is mostly trying to survive.
  if (hurt) {
    const opts: Weighted<Decision>[] = [
      { item: { action: { kind: 'movement', name: 'retreat' }, power: 0, rangeIntent: 1 }, weight: 1.6 },
      { item: { action: { kind: 'defense', name: 'shell' }, power: 0 }, weight: 1.2 },
      { item: { action: { kind: 'movement', name: 'recover' }, power: 0 }, weight: 1.0 },
      { item: { action: { kind: 'wrestle', name: 'body-lock' }, power: 0.5 }, weight: 0.9 * side.base.wrestling / 100 },
      { item: chooseStandingStrike(st, side, rng), weight: 0.5 },
    ];
    return pickWeighted(rng, opts);
  }

  const wantsCloser = !side.wantsDistance && (pos.range === 'long' || pos.range === 'kick');
  const wantsFurther = side.wantsDistance && (pos.range === 'pocket' || pos.range === 'boxing');

  const takedownDesire =
    side.wantsGround && pos.range !== 'long'
      ? side.plan.takedown * (1.1 + (side.desperate ? 0.4 : 0)) * clamp(side.stamina / 55, 0.3, 1.2)
      : side.plan.takedown * 0.25;

  const clinchDesire = side.plan.clinch * (pos.range === 'pocket' || pos.range === 'boxing' ? 1.2 : 0.4);

  const opts: Weighted<Decision>[] = [
    { item: chooseStandingStrike(st, side, rng), weight: 4.4 * (0.55 + side.paceTarget) * (side.plan.counter > 0.7 ? 0.82 : 1) },
    {
      item: { action: { kind: 'movement', name: wantsCloser ? 'press-forward' : 'circle' }, power: 0, rangeIntent: wantsCloser ? -1 : 0 },
      weight: wantsCloser ? 1.15 * side.plan.pressure : 0.42,
    },
    {
      item: { action: { kind: 'movement', name: 'retreat' }, power: 0, rangeIntent: 1 },
      weight: wantsFurther ? 0.85 * side.plan.distance : 0.14,
    },
    { item: { action: { kind: 'movement', name: 'feint' }, power: 0 }, weight: 0.4 + side.plan.caution * 0.35 },
    {
      item: { action: { kind: 'defense', name: 'level-change-feint' }, power: 0 },
      weight: 0.24 * side.plan.takedown,
    },
    {
      item: { action: { kind: 'defense', name: 'angle-exit' }, power: 0, rangeIntent: 1 },
      weight: 0.24 * side.plan.distance,
    },
  ];

  if (pos.range !== 'long') {
    const td = pickWeighted(rng, takedownOptions(st, side));
    opts.push({ item: { action: { kind: 'wrestle', name: td }, power: 0.7 }, weight: 1.25 * takedownDesire });
    opts.push({
      item: { action: { kind: 'wrestle', name: 'body-lock' }, power: 0.5, rangeIntent: -1 },
      weight: clinchDesire,
    });
  }

  // A fighter who has been badly hurt by the opponent's power becomes more careful.
  if (opp.fightStats.knockdowns > 0 && side.damage.head > 30) {
    for (const o of opts) {
      if (o.item.action.kind === 'strike') o.weight *= 0.78;
      if (o.item.action.kind === 'movement' && o.item.action.name === 'retreat') o.weight *= 1.4;
    }
  }

  return pickWeighted(rng, opts);
}

function chooseClinchAction(st: FightState, side: SideState, rng: Rng): Decision {
  const controlling = st.position.controller === side.idx;
  const fence = st.position.clinchKind === 'fence';
  const td = pickWeighted(rng, takedownOptions(st, side));

  const opts: Weighted<Decision>[] = [
    {
      item: { action: { kind: 'strike', name: 'clinch-strike' }, target: rng.chance(0.4) ? 'body' : 'head', power: 0.5 },
      weight: 1.0 * side.paceTarget,
    },
    {
      item: { action: { kind: 'strike', name: 'knee' }, target: rng.chance(0.55) ? 'body' : 'head', power: 0.75 },
      weight: 0.7 * side.tendencies.clinch * (controlling ? 1.3 : 0.6),
    },
    {
      item: { action: { kind: 'strike', name: 'elbow' }, target: 'head', power: 0.7 },
      weight: 0.4 * side.tendencies.clinch * (controlling ? 1.2 : 0.5),
    },
    {
      item: { action: { kind: 'wrestle', name: td }, power: 0.75 },
      weight: 1.3 * side.plan.takedown * (controlling ? 1.3 : 0.55) * clamp(side.stamina / 50, 0.25, 1.2),
    },
    {
      item: { action: { kind: 'wrestle', name: 'underhook-defense' }, power: 0.3 },
      weight: controlling ? 0.2 : 0.9,
    },
    {
      item: { action: { kind: 'movement', name: 'reset' }, power: 0, rangeIntent: 1 },
      weight: (controlling ? 0.2 : 0.8) * (side.wantsDistance ? 1.8 : 0.7),
    },
    {
      item: { action: { kind: 'grapple', name: 'hold-position' }, power: 0.2 },
      weight: controlling && side.protectingLead ? 1.1 : 0.3,
    },
  ];

  if (fence && controlling) {
    opts.push({ item: { action: { kind: 'wrestle', name: 'fence-takedown' }, power: 0.8 }, weight: 1.0 * side.plan.takedown });
  }
  if (side.stamina < 32) {
    for (const o of opts) {
      if (o.item.action.kind === 'wrestle') o.weight *= 0.45;
      if (o.item.action.kind === 'grapple') o.weight *= 1.7;
    }
  }
  return pickWeighted(rng, opts);
}

const GUARD_SUBMISSIONS: SubmissionName[] = ['triangle-choke', 'armbar', 'omoplata', 'guillotine', 'kimura'];
const TOP_SUBMISSIONS: SubmissionName[] = ['arm-triangle', 'darce-choke', 'anaconda-choke', 'kimura', 'americana', 'north-south-choke'];
const BACK_SUBMISSIONS: SubmissionName[] = ['rear-naked-choke', 'armbar', 'twister'];
const MOUNT_SUBMISSIONS: SubmissionName[] = ['armbar', 'arm-triangle', 'americana', 'triangle-choke'];
const LEG_SUBMISSIONS: SubmissionName[] = ['heel-hook', 'kneebar', 'ankle-lock', 'calf-slicer'];
const TURTLE_SUBMISSIONS: SubmissionName[] = ['rear-naked-choke', 'peruvian-necktie', 'darce-choke', 'anaconda-choke'];

export function submissionsAvailable(st: FightState, side: SideState): SubmissionName[] {
  const pos = st.position;
  if (pos.zone === 'clinch') return ['guillotine', 'darce-choke'];
  if (pos.zone !== 'ground') return [];
  const controlling = pos.controller === side.idx;
  switch (pos.ground) {
    case 'back':
      return controlling ? BACK_SUBMISSIONS : [];
    case 'mount':
      return controlling ? MOUNT_SUBMISSIONS : [];
    case 'side-control':
      return controlling ? TOP_SUBMISSIONS : ['von-flue-choke'];
    case 'half-guard':
      return controlling ? ['kimura', 'darce-choke', 'arm-triangle'] : ['kimura', 'guillotine'];
    case 'guard':
      return controlling ? ['darce-choke', 'kimura'] : GUARD_SUBMISSIONS;
    case 'turtle':
      return controlling ? TURTLE_SUBMISSIONS : [];
    case 'leg-entanglement':
      return LEG_SUBMISSIONS;
    case 'scramble':
      return ['guillotine'];
  }
}

function chooseGroundAction(st: FightState, side: SideState, rng: Rng): Decision {
  const pos = st.position;
  const controlling = pos.controller === side.idx;
  const value = GROUND_VALUE[pos.ground];
  const subs = submissionsAvailable(st, side);
  const opts: Weighted<Decision>[] = [];

  if (pos.ground === 'scramble') {
    opts.push({ item: { action: { kind: 'grapple', name: 'scramble-reset' }, power: 0.6 }, weight: 1.2 });
    opts.push({ item: { action: { kind: 'wrestle', name: 'stand-up' }, power: 0.6 }, weight: side.wantsGround ? 0.4 : 1.2 });
    opts.push({ item: { action: { kind: 'grapple', name: 'take-back' }, power: 0.7 }, weight: 0.7 * side.base.grappling / 100 });
    if (subs.length > 0) {
      opts.push({
        item: { action: { kind: 'submission', name: rng.pick(subs), stage: 'entry' }, power: 0.7 },
        weight: 0.085 * side.plan.submission,
      });
    }
    return pickWeighted(rng, opts);
  }

  if (controlling) {
    const dominant = value >= 0.66;
    opts.push({
      item: { action: { kind: 'strike', name: pos.ground === 'guard' || rng.chance(0.65) ? 'ground-strike' : 'ground-elbow' }, target: 'head', power: clamp(0.4 + side.plan.finishSeeking * 0.5, 0.2, 1) },
      weight: (dominant ? 1.5 : 0.9) * side.paceTarget * (1 + side.plan.finishSeeking * 0.6),
    });
    opts.push({
      item: { action: { kind: 'grapple', name: 'advance-position' }, power: 0.6 },
      weight: value < 0.9 ? 1.15 * (0.6 + side.base.grappling / 140) : 0.1,
    });
    opts.push({
      item: { action: { kind: 'grapple', name: 'hold-position' }, power: 0.2 },
      weight: (side.protectingLead ? 1.5 : 0.55) * (1 + side.plan.ground * 0.7) * (side.stamina < 40 ? 1.8 : 1),
    });
    if (subs.length > 0) {
      opts.push({
        item: { action: { kind: 'submission', name: rng.pick(subs), stage: 'entry' }, power: 0.75 },
        weight: 0.155 * side.plan.submission * (0.5 + side.base.submissions / 110) * (dominant ? 1.4 : 0.8),
      });
    }
    opts.push({
      item: { action: { kind: 'grapple', name: 'posture-up' }, power: 0.3 },
      weight: pos.ground === 'guard' ? 0.6 : 0.1,
    });
    if (!side.wantsGround || side.stamina < 25) {
      opts.push({ item: { action: { kind: 'wrestle', name: 'stand-up' }, power: 0.5 }, weight: 0.5 });
    }
  } else {
    const trapped = value >= 0.8;
    opts.push({
      item: { action: { kind: 'grapple', name: pos.ground === 'back' ? 'escape-back' : 'guard-recovery' }, power: 0.55 },
      weight: (trapped ? 1.6 : 1.0) * (0.6 + side.base.grappling / 130),
    });
    opts.push({
      item: { action: { kind: 'grapple', name: 'sweep' }, power: 0.7 },
      weight: (pos.ground === 'guard' || pos.ground === 'half-guard' ? 1.0 : 0.35) * (0.5 + side.base.grappling / 120),
    });
    opts.push({
      item: { action: { kind: 'wrestle', name: 'wall-walk' }, power: 0.55 },
      weight: 0.75 * (0.5 + side.base.wrestling / 130),
    });
    opts.push({
      item: { action: { kind: 'grapple', name: 'reversal' }, power: 0.75 },
      weight: 0.4 * (0.4 + side.base.wrestling / 130) * (side.desperate ? 1.6 : 1),
    });
    if (subs.length > 0) {
      opts.push({
        item: { action: { kind: 'submission', name: rng.pick(subs), stage: 'entry' }, power: 0.7 },
        weight: 0.145 * side.plan.submission * (0.4 + side.base.submissions / 100) * (trapped ? 0.5 : 1.2),
      });
    }
    opts.push({
      item: { action: { kind: 'strike', name: 'ground-strike' }, target: 'head', power: 0.35 },
      weight: pos.ground === 'guard' ? 0.3 : 0.08,
    });
    opts.push({
      item: { action: { kind: 'grapple', name: 'rest-in-position' }, power: 0.05 },
      weight: side.stamina < 35 ? 1.0 : 0.2,
    });
  }
  return pickWeighted(rng, opts);
}

function chooseKnockdownAction(st: FightState, side: SideState, rng: Rng): Decision {
  const pos = st.position;
  const iAmDown = pos.downedIdx === side.idx;
  if (iAmDown) {
    const opts: Weighted<Decision>[] = [
      { item: { action: { kind: 'grapple', name: 'guard-recovery' }, power: 0.6 }, weight: 1.4 },
      { item: { action: { kind: 'wrestle', name: 'stand-up' }, power: 0.7 }, weight: 1.0 },
      { item: { action: { kind: 'defense', name: 'shell' }, power: 0 }, weight: 1.1 },
      { item: { action: { kind: 'submission', name: 'guillotine', stage: 'entry' }, power: 0.6 }, weight: 0.25 * side.plan.submission },
    ];
    return pickWeighted(rng, opts);
  }
  const opts: Weighted<Decision>[] = [
    { item: { action: { kind: 'strike', name: 'ground-strike' }, target: 'head', power: 0.9 }, weight: 1.8 },
    { item: { action: { kind: 'strike', name: 'hook' }, target: 'head', power: 1 }, weight: 1.2 },
    { item: { action: { kind: 'grapple', name: 'advance-position' }, power: 0.6 }, weight: 0.5 },
    { item: { action: { kind: 'movement', name: 'reset' }, power: 0, rangeIntent: 1 }, weight: side.plan.caution * 0.5 },
    {
      item: { action: { kind: 'submission', name: 'guillotine', stage: 'entry' }, power: 0.7 },
      weight: 0.25 * side.plan.submission,
    },
  ];
  return pickWeighted(rng, opts);
}

/** Top level action selection. The opponent AI uses this exact function. */
export function chooseAction(st: FightState, side: SideState, rng: Rng): Decision {
  if (rng.chance(C.ai.reevaluateChance * 0.35)) updateTactics(st, side, rng);
  const pos = st.position;
  if (pos.downedIdx !== null) return chooseKnockdownAction(st, side, rng);
  if (pos.zone === 'standing') return chooseStandingAction(st, side, rng);
  if (pos.zone === 'clinch') return chooseClinchAction(st, side, rng);
  return chooseGroundAction(st, side, rng);
}

/**
 * Decides which fighter acts next. Position dictates most of it: the fighter on top or
 * with the back controls the pace, the standing fighter dictates after a knockdown, and
 * at range the more aggressive fighter initiates more often.
 */
export function chooseInitiative(st: FightState, rng: Rng): SideState {
  const pos = st.position;
  if (pos.downedIdx !== null) {
    return pos.downedIdx === 0 ? st.b : st.a;
  }
  let weightA = st.a.aggression + 0.35;
  let weightB = st.b.aggression + 0.35;
  if (pos.zone === 'ground' && pos.ground !== 'scramble') {
    if (pos.controller === 0) {
      weightA *= 2.1;
    } else {
      weightB *= 2.1;
    }
  } else if (pos.zone === 'clinch') {
    if (pos.controller === 0) weightA *= 1.55;
    else weightB *= 1.55;
  }
  if (st.a.stunSecondsRemaining > 0) weightA *= 0.35;
  if (st.b.stunSecondsRemaining > 0) weightB *= 0.35;
  return rng.next() * (weightA + weightB) < weightA ? st.a : st.b;
}
