import { CALIBRATION as C } from '../config/calibration';
import { clamp, Rng, sigmoid } from '../rng';
import type {
  DamageDelta,
  EventImportance,
  FightAction,
  FightActionResult,
  FightEvent,
  RoundStatLine,
  StrikeAction,
  SubmissionName,
  WrestlingAction,
} from '../types/fight';
import type { Decision } from './ai';
import { effective, spendStamina } from './effective';
import { isKick, isSpinning, STRIKE_PROFILE } from './strikes';
import {
  addDamage,
  GROUND_VALUE,
  opponentOf,
  publicPosition,
  resetToStanding,
  totalLegDamage,
  zeroDamage,
  type FightState,
  type GroundPosition,
  type SideState,
} from './state';

export interface ResolveCtx {
  st: FightState;
  rng: Rng;
  push: (e: Omit<FightEvent, 'seq'>) => void;
}

export interface ResolveOutcome {
  timeUsed: number;
  /** Set when the action ended the fight. */
  finish: {
    method: 'ko' | 'tko-strikes' | 'tko-ground-strikes' | 'submission' | 'technical-submission';
    winnerIdx: 0 | 1;
    submissionName?: SubmissionName;
    finishingStrike?: StrikeAction;
  } | null;
}

const NO_FINISH: ResolveOutcome['finish'] = null;

function emptyDelta(): DamageDelta {
  return zeroDamage();
}

function statsOf(side: SideState): RoundStatLine[] {
  return [side.roundStats, side.fightStats];
}

function bump(side: SideState, key: keyof RoundStatLine, n = 1): void {
  for (const s of statsOf(side)) s[key] += n;
}

/** Records a strike attempt and, when landed, the landed counters for every dimension. */
function recordStrike(
  attacker: SideState,
  landed: boolean,
  significant: boolean,
  count: number,
  target: 'head' | 'body' | 'leg',
  zone: 'distance' | 'clinch' | 'ground'
): void {
  bump(attacker, 'totalStrikesAttempted', count);
  if (landed) bump(attacker, 'totalStrikesLanded', count);
  if (significant) {
    bump(attacker, 'sigStrikesAttempted', count);
    if (landed) bump(attacker, 'sigStrikesLanded', count);
    const tgtA = target === 'head' ? 'headAttempted' : target === 'body' ? 'bodyAttempted' : 'legAttempted';
    const tgtL = target === 'head' ? 'headLanded' : target === 'body' ? 'bodyLanded' : 'legLanded';
    bump(attacker, tgtA, count);
    if (landed) bump(attacker, tgtL, count);
    const zoneA = zone === 'distance' ? 'distanceAttempted' : zone === 'clinch' ? 'clinchAttempted' : 'groundAttempted';
    const zoneL = zone === 'distance' ? 'distanceLanded' : zone === 'clinch' ? 'clinchLanded' : 'groundLanded';
    bump(attacker, zoneA, count);
    if (landed) bump(attacker, zoneL, count);
  }
}

function zoneOf(st: FightState): 'distance' | 'clinch' | 'ground' {
  if (st.position.zone === 'standing') return 'distance';
  if (st.position.zone === 'clinch') return 'clinch';
  return 'ground';
}

/**
 * Damage scaling. Power is a product of striking effectiveness, division, build and
 * commitment. It is deliberately not a stored rating.
 */
function computeDamage(
  ctx: ResolveCtx,
  attacker: SideState,
  defender: SideState,
  name: StrikeAction,
  target: 'head' | 'body' | 'leg',
  power: number,
  quality: number
): DamageDelta {
  const prof = STRIKE_PROFILE[name];
  const st = ctx.st;
  const base =
    target === 'head' ? C.damage.baseCleanHead : target === 'body' ? C.damage.baseCleanBody : C.damage.baseCleanLeg;
  const groundBase = st.position.zone === 'ground' ? C.damage.baseGroundStrike / C.damage.baseCleanHead : 1;

  const powerRating = effective(st, attacker, 'power');
  const durability = effective(st, defender, 'strike-defense', { bonus: defender.base.durability - defender.base.striking });
  const skillTerm = 1 + (powerRating - 65) * 0.014;
  const durabilityTerm = 1 - (durability - 65) * C.damage.durabilityScale;
  const commitment = 0.55 + power * 0.75;
  const variance = 0.72 + ctx.rng.next() * 0.62;

  const magnitude =
    base *
    prof.damage *
    groundBase *
    skillTerm *
    clamp(durabilityTerm, 0.45, 1.6) *
    commitment *
    quality *
    attacker.powerFactor *
    variance;

  const d = emptyDelta();
  if (target === 'head') {
    d.head = magnitude;
    d.balance = magnitude * 0.35;
    if (ctx.rng.chance(clamp(C.damage.cutBaseChance * prof.cut * (1 + power), 0, 0.35))) {
      d.cut = magnitude * 0.8;
    }
    d.swelling = magnitude * 0.3;
  } else if (target === 'body') {
    d.body = magnitude;
  } else {
    // Kicks land on the lead leg most of the time.
    const leadLeft = attacker.fighter.stance !== 'southpaw';
    if (leadLeft) d.legLeft = magnitude;
    else d.legRight = magnitude;
  }
  return d;
}

function knockdownChance(
  st: FightState,
  attacker: SideState,
  defender: SideState,
  name: StrikeAction,
  target: 'head' | 'body' | 'leg',
  power: number
): number {
  if (target === 'leg') {
    // Leg kicks only drop a fighter whose legs are already badly compromised.
    const legs = totalLegDamage(defender.damage);
    if (legs < 34) return 0;
    return clamp((legs - 34) * 0.004, 0, 0.09);
  }
  const prof = STRIKE_PROFILE[name];
  const strikeAdv = effective(st, attacker, 'power') - effective(st, defender, 'strike-defense');
  const durabilityDeficit = 70 - defender.base.durability;
  let p = C.knockdown.base * prof.knockdown * attacker.powerFactor;
  p *= 1 + clamp(strikeAdv, -30, 40) * C.knockdown.strikingScale;
  p *= 1 + clamp(durabilityDeficit, -35, 40) * C.knockdown.durabilityScale;
  p *= 1 + defender.damage.head * C.knockdown.accumulationScale;
  p *= 0.55 + power * 0.9;
  if (defender.stunSecondsRemaining > 0) p *= C.knockdown.stunnedMultiplier;
  if (defender.stamina < 35) p *= C.knockdown.fatiguedMultiplier;
  if (target === 'body') p *= 0.22;
  if (st.position.zone === 'ground') p *= 0.35;
  return clamp(p, 0, 0.75);
}

function importanceOf(result: FightActionResult, damage: DamageDelta, tags: string[]): EventImportance {
  if (tags.includes('knockdown') || tags.includes('finish')) return 'decisive';
  if (tags.includes('stun') || tags.includes('takedown') || tags.includes('submission-secured') || tags.includes('sweep')) return 'major';
  const total = damage.head + damage.body + damage.legLeft + damage.legRight;
  if (result === 'clean-land' && total > 7) return 'notable';
  if (result === 'clean-land') return 'minor';
  if (result === 'countered') return 'notable';
  return 'trivial';
}

// ---------------------------------------------------------------------------
// Striking
// ---------------------------------------------------------------------------

export function resolveStrike(ctx: ResolveCtx, attacker: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const defender = opponentOf(st, attacker);
  const action = dec.action as Extract<FightAction, { kind: 'strike' }>;
  const name = action.name;
  const prof = STRIKE_PROFILE[name];
  const target = dec.target ?? 'head';
  const zone = zoneOf(st);
  const power = dec.power;
  const stateBefore = publicPosition(st.position, attacker.idx);

  const cost = C.stamina.costs[prof.cost] * (1 + power * 0.8) * attacker.plan.staminaMult;
  const spent = spendStamina(attacker, cost);

  // Accuracy contest. Technique difficulty and commitment both reduce the chance to land.
  const atk = effective(st, attacker, 'strike-offense', { bonus: -prof.difficulty - power * 5 });
  const def = effective(st, defender, 'strike-defense') * C.striking.defenseWeight;
  const landChance = clamp(sigmoid((atk - def) / C.actionSpread) * 0.92, 0.03, 0.93);

  const roll = ctx.rng.next();
  let result: FightActionResult;
  let quality = 1;
  const tags: string[] = [zone];

  if (roll < landChance * 0.72) {
    result = 'clean-land';
  } else if (roll < landChance) {
    result = 'partial-land';
    quality = C.damage.partialMultiplier;
  } else {
    // The defender's response depends on what they are good at and how they fight.
    const defRoll = ctx.rng.next();
    const blockBias = clamp(0.3 + (defender.base.durability - 60) / 200, 0.15, 0.6);
    const slipBias = clamp(0.25 + (defender.base.striking - 60) / 180 + defender.tendencies.counter * 0.2, 0.1, 0.6);
    if (defRoll < blockBias) {
      result = 'blocked';
      quality = C.damage.blockedMultiplier;
    } else if (defRoll < blockBias + slipBias) {
      result = 'slipped';
      quality = 0;
    } else {
      result = 'missed';
      quality = 0;
    }
  }

  const landed = result === 'clean-land' || result === 'partial-land' || result === 'blocked';
  const significant = zone === 'distance' || power >= 0.35;
  recordStrike(attacker, result === 'clean-land' || result === 'partial-land' || result === 'blocked', significant, prof.strikeCount, target, zone);
  if (name === 'combination' && (result === 'clean-land' || result === 'partial-land')) bump(attacker, 'combinations');

  let damage = emptyDelta();
  const finish: ResolveOutcome['finish'] = NO_FINISH;

  if (landed && quality > 0) {
    damage = computeDamage(ctx, attacker, defender, name, target, power, quality);
    addDamage(defender.damage, damage);
    if (damage.cut > 0) tags.push('cut');
  }

  if (result === 'clean-land') {
    defender.unansweredAgainst += prof.strikeCount;
    attacker.unansweredAgainst = 0;
    st.position.inactivitySeconds = 0;
  }

  // Stun and knockdown checks only on a genuinely clean shot.
  if (result === 'clean-land' && target !== 'leg') {
    const kdChance = knockdownChance(st, attacker, defender, name, target, power);
    if (ctx.rng.chance(kdChance)) {
      tags.push('knockdown');
      defender.knockdownsTaken++;
      attacker.knockdownsScored++;
      bump(attacker, 'knockdowns');
      defender.damage.balance += 22;
      defender.stunSecondsRemaining = Math.max(defender.stunSecondsRemaining, C.stun.durationSeconds);
      defender.vulnerableSecondsRemaining = C.knockdown.vulnerabilitySeconds;
      st.position.downedIdx = defender.idx;
      st.position.zone = 'ground';
      st.position.ground = 'guard';
      st.position.controller = attacker.idx;
      st.position.heldSeconds = 0;
    } else {
      const stunAdv = effective(st, attacker, 'power') - effective(st, defender, 'strike-defense');
      const stunChance = clamp(
        C.stun.base * prof.knockdown * (1 + clamp(stunAdv, -25, 35) * 0.016) * (0.5 + power) * (1 + defender.damage.head * 0.006),
        0,
        0.45
      );
      if (ctx.rng.chance(stunChance)) {
        tags.push('stun');
        bump(attacker, 'stuns');
        defender.stunSecondsRemaining = Math.max(defender.stunSecondsRemaining, C.stun.durationSeconds * (0.5 + power * 0.6));
      }
    }
  } else if (result === 'clean-land' && target === 'leg') {
    const kdChance = knockdownChance(st, attacker, defender, name, target, power);
    if (ctx.rng.chance(kdChance)) {
      tags.push('leg-drop');
      defender.knockdownsTaken++;
      attacker.knockdownsScored++;
      bump(attacker, 'knockdowns');
      st.position.downedIdx = defender.idx;
      st.position.zone = 'ground';
      st.position.ground = 'guard';
      st.position.controller = attacker.idx;
    }
  }

  // A miss on a committed strike can be punished.
  let counterEvent = false;
  if ((result === 'missed' || result === 'slipped') && st.position.zone === 'standing') {
    const exposure = prof.counterExposure * (0.5 + power);
    const counterChance = clamp(
      (C.striking.counterBase + defender.tendencies.counter * C.striking.counterTendencyScale) * exposure * (defender.stunSecondsRemaining > 0 ? 0.3 : 1),
      0,
      0.5
    );
    if (ctx.rng.chance(counterChance)) counterEvent = true;
  }

  const timeUsed = C.timeCost[prof.time] * (0.8 + ctx.rng.next() * 0.4);

  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: attacker.id,
    defenderId: defender.id,
    stateBefore,
    action: { kind: 'strike', name },
    target,
    result,
    stateAfter: publicPosition(st.position, attacker.idx),
    damage,
    staminaCost: spent,
    scoreImpact: result === 'clean-land' ? 1 * prof.strikeCount : result === 'partial-land' ? 0.4 : 0,
    importance: importanceOf(result, damage, tags),
    tags,
  });

  if (counterEvent) {
    const counterDec: Decision = {
      action: { kind: 'strike', name: ctx.rng.chance(0.5) ? 'cross' : 'hook' },
      target: 'head',
      power: clamp(0.5 + defender.tendencies.counter * 0.4, 0.3, 1),
    };
    bump(defender, 'counters');
    const out = resolveStrike(ctx, defender, counterDec);
    return { timeUsed: timeUsed + out.timeUsed, finish: out.finish };
  }

  return { timeUsed, finish };
}

// ---------------------------------------------------------------------------
// Wrestling
// ---------------------------------------------------------------------------

const TAKEDOWN_DIFFICULTY: Partial<Record<WrestlingAction, number>> = {
  'double-leg': 0,
  'single-leg': 1.5,
  'body-lock': -1,
  'outside-trip': 1,
  'inside-trip': 2,
  'foot-sweep': 4,
  'hip-throw': 6,
  'reactive-takedown': -3,
  'catch-kick-takedown': -5,
  'fence-takedown': -2,
  'mat-return': -4,
};

export function resolveTakedown(ctx: ResolveCtx, attacker: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const defender = opponentOf(st, attacker);
  const action = dec.action as Extract<FightAction, { kind: 'wrestle' }>;
  const name = action.name;
  const stateBefore = publicPosition(st.position, attacker.idx);
  const tags: string[] = ['takedown-attempt'];

  const spent = spendStamina(attacker, C.stamina.costs.takedownAttempt * attacker.plan.staminaMult);
  spendStamina(defender, C.stamina.costs.takedownDefense * 0.7);

  const difficulty = TAKEDOWN_DIFFICULTY[name] ?? 0;
  const fenceBonus = st.position.clinchKind === 'fence' && st.position.controller === attacker.idx ? 3 : 0;
  const atk = effective(st, attacker, 'takedown-offense', { bonus: -difficulty + fenceBonus }) * C.wrestling.entryWeight;
  const def = effective(st, defender, 'takedown-defense');
  const p = clamp(sigmoid((atk - def) / C.grappleSpread) * 0.95, 0.03, 0.94);

  bump(attacker, 'takedownsAttempted');

  const roll = ctx.rng.next();
  let result: FightActionResult;
  let timeUsed = C.timeCost.takedownAttempt * (0.8 + ctx.rng.next() * 0.5);

  if (roll < p * 0.78) {
    result = 'completed';
    tags.push('takedown');
    bump(attacker, 'takedownsLanded');
    st.position.zone = 'ground';
    st.position.controller = attacker.idx;
    st.position.downedIdx = null;
    st.position.heldSeconds = 0;
    st.position.inactivitySeconds = 0;
    const dominant = ctx.rng.chance(C.wrestling.dominantLandingChance * (1 + (attacker.base.grappling - 65) / 120));
    st.position.ground = dominant ? (ctx.rng.chance(0.6) ? 'side-control' : 'half-guard') : ctx.rng.chance(0.72) ? 'guard' : 'half-guard';
  } else if (roll < p) {
    result = 'partial';
    tags.push('partial-takedown');
    if (st.position.zone === 'standing') {
      st.position.zone = 'clinch';
      st.position.clinchKind = ctx.rng.chance(C.wrestling.fenceStallChance + 0.35) ? 'fence' : 'open';
      st.position.controller = attacker.idx;
    }
    timeUsed *= 1.2;
  } else {
    result = 'stuffed';
    tags.push('stuffed');
    if (ctx.rng.chance(C.wrestling.stuffCounterChance)) {
      // A badly timed shot can be turned around.
      tags.push('counter-position');
      if (ctx.rng.chance(0.5)) {
        st.position.zone = 'ground';
        st.position.controller = defender.idx;
        st.position.ground = ctx.rng.chance(0.4) ? 'turtle' : 'guard';
      } else {
        st.position.zone = 'clinch';
        st.position.clinchKind = 'fence';
        st.position.controller = defender.idx;
      }
    } else if (st.position.zone === 'standing') {
      st.position.range = 'boxing';
    }
    spendStamina(attacker, C.stamina.costs.takedownAttempt * 0.45);
  }

  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: attacker.id,
    defenderId: defender.id,
    stateBefore,
    action: { kind: 'wrestle', name },
    result,
    stateAfter: publicPosition(st.position, attacker.idx),
    damage: emptyDelta(),
    staminaCost: spent,
    scoreImpact: result === 'completed' ? 3 : result === 'partial' ? 0.6 : 0,
    importance: importanceOf(result, emptyDelta(), tags),
    tags,
  });

  return { timeUsed, finish: NO_FINISH };
}

// ---------------------------------------------------------------------------
// Grappling transitions
// ---------------------------------------------------------------------------

const ADVANCE_CHAIN: Record<GroundPosition, GroundPosition> = {
  guard: 'half-guard',
  'half-guard': 'side-control',
  'side-control': 'mount',
  mount: 'back',
  back: 'back',
  turtle: 'back',
  'leg-entanglement': 'side-control',
  scramble: 'guard',
};

export function resolveGrapple(ctx: ResolveCtx, actor: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const defender = opponentOf(st, actor);
  const action = dec.action as Extract<FightAction, { kind: 'grapple' }>;
  const name = action.name;
  const pos = st.position;
  const stateBefore = publicPosition(pos, actor.idx);
  const controlling = pos.controller === actor.idx;
  const tags: string[] = ['grappling'];
  let result: FightActionResult = 'no-effect';
  let timeUsed = C.timeCost.positionAdvance * (0.8 + ctx.rng.next() * 0.5);
  let scoreImpact = 0;

  const atkDomain = controlling ? 'ground-offense' : 'ground-defense';
  const defDomain = controlling ? 'ground-defense' : 'ground-offense';

  switch (name) {
    case 'advance-position': {
      const spent = spendStamina(actor, C.stamina.costs.scramble * 0.8);
      const next = ADVANCE_CHAIN[pos.ground];
      const resistance = GROUND_VALUE[pos.ground] * 8;
      const atk = effective(st, actor, atkDomain, { bonus: -resistance });
      const def = effective(st, defender, defDomain);
      const p = clamp(C.grappling.advanceBase + sigmoid((atk - def) / C.grappleSpread) * 0.5, 0.05, 0.82);
      if (ctx.rng.chance(p)) {
        pos.ground = next;
        pos.heldSeconds = 0;
        pos.inactivitySeconds = 0;
        result = 'completed';
        tags.push('advance');
        scoreImpact = 1.6;
      } else if (ctx.rng.chance(0.14)) {
        pos.ground = 'scramble';
        result = 'escaped';
        tags.push('scramble');
      } else {
        result = 'defended';
      }
      void spent;
      break;
    }
    case 'hold-position':
    case 'rest-in-position': {
      spendStamina(actor, C.stamina.costs.groundControlPerSecond * C.timeCost.groundControl * (name === 'rest-in-position' ? 0.4 : 1));
      timeUsed = C.timeCost.groundControl * (0.85 + ctx.rng.next() * 0.5);
      pos.inactivitySeconds += timeUsed;
      result = 'stalled';
      scoreImpact = controlling ? 0.5 : 0;
      tags.push('control');
      break;
    }
    case 'posture-up': {
      spendStamina(actor, C.stamina.costs.groundControlPerSecond * 4);
      result = ctx.rng.chance(0.6) ? 'completed' : 'defended';
      timeUsed = C.timeCost.groundStrike * 1.2;
      break;
    }
    case 'sweep':
    case 'reversal': {
      const spent = spendStamina(actor, C.stamina.costs.scramble * (name === 'reversal' ? 1.2 : 1));
      const atk = effective(st, actor, 'ground-offense');
      const def = effective(st, defender, 'ground-defense');
      const base = name === 'sweep' ? C.grappling.sweepBase : C.grappling.sweepBase * 0.75;
      const p = clamp(base + sigmoid((atk - def) / C.grappleSpread) * 0.34, 0.02, 0.7);
      if (ctx.rng.chance(p)) {
        pos.controller = actor.idx;
        pos.ground = name === 'reversal' ? 'half-guard' : 'guard';
        pos.heldSeconds = 0;
        pos.inactivitySeconds = 0;
        result = 'reversed';
        tags.push('sweep');
        bump(actor, 'reversals');
        scoreImpact = 2.2;
      } else {
        result = 'defended';
      }
      void spent;
      break;
    }
    case 'guard-recovery':
    case 'escape-back': {
      const spent = spendStamina(actor, C.stamina.costs.scramble * 0.85);
      const atk = effective(st, actor, 'ground-defense');
      const def = effective(st, defender, 'ground-offense');
      const difficulty = GROUND_VALUE[pos.ground] * 10;
      const p = clamp(sigmoid((atk - def - difficulty + 6) / C.grappleSpread) * 0.7, 0.03, 0.72);
      if (ctx.rng.chance(p)) {
        const downgrade: Record<GroundPosition, GroundPosition> = {
          back: 'turtle',
          mount: 'half-guard',
          'side-control': 'half-guard',
          'half-guard': 'guard',
          guard: 'guard',
          turtle: 'guard',
          'leg-entanglement': 'guard',
          scramble: 'guard',
        };
        const next = downgrade[pos.ground];
        if (next === pos.ground && pos.ground === 'guard') {
          pos.ground = 'scramble';
          tags.push('scramble');
        } else {
          pos.ground = next;
        }
        pos.heldSeconds = 0;
        pos.inactivitySeconds = 0;
        result = 'escaped';
        tags.push('escape');
        scoreImpact = 0.9;
      } else {
        result = 'defended';
      }
      void spent;
      break;
    }
    case 'take-back': {
      spendStamina(actor, C.stamina.costs.scramble);
      const atk = effective(st, actor, 'ground-offense');
      const def = effective(st, defender, 'ground-defense');
      if (ctx.rng.chance(clamp(sigmoid((atk - def) / C.grappleSpread) * 0.45, 0.03, 0.55))) {
        pos.ground = 'back';
        pos.controller = actor.idx;
        result = 'completed';
        tags.push('advance');
        scoreImpact = 2.4;
      } else {
        result = 'defended';
      }
      break;
    }
    case 'scramble-reset': {
      spendStamina(actor, C.stamina.costs.scramble);
      const atk = effective(st, actor, 'scramble');
      const def = effective(st, defender, 'scramble');
      timeUsed = C.timeCost.scramble;
      if (ctx.rng.chance(clamp(sigmoid((atk - def) / C.grappleSpread), 0.08, 0.9))) {
        pos.controller = actor.idx;
        pos.ground = ctx.rng.chance(0.45) ? 'half-guard' : 'guard';
        result = 'completed';
        scoreImpact = 0.8;
      } else {
        pos.controller = defender.idx;
        pos.ground = ctx.rng.chance(0.45) ? 'half-guard' : 'guard';
        result = 'defended';
      }
      pos.heldSeconds = 0;
      break;
    }
    case 'turtle-transition': {
      pos.ground = 'turtle';
      result = 'completed';
      timeUsed = C.timeCost.scramble * 0.8;
      break;
    }
  }

  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: actor.id,
    defenderId: defender.id,
    stateBefore,
    action: { kind: 'grapple', name },
    result,
    stateAfter: publicPosition(pos, actor.idx),
    damage: emptyDelta(),
    staminaCost: 0,
    scoreImpact,
    importance: importanceOf(result, emptyDelta(), tags),
    tags,
  });

  return { timeUsed, finish: NO_FINISH };
}

/** Stand up and wall walk share a resolution path but differ in cost and difficulty. */
export function resolveStandUp(ctx: ResolveCtx, actor: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const pos = st.position;
  const defender = opponentOf(st, actor);
  const action = dec.action as Extract<FightAction, { kind: 'wrestle' }>;
  const stateBefore = publicPosition(pos, actor.idx);
  const isWallWalk = action.name === 'wall-walk';
  const spent = spendStamina(actor, isWallWalk ? C.stamina.costs.wallWalk : C.stamina.costs.standUp);

  const controlling = pos.controller === actor.idx;
  let p: number;
  if (controlling) {
    // Disengaging from top is mostly a choice, not a contest.
    p = 0.9;
  } else {
    const atk = effective(st, actor, 'ground-defense', { bonus: isWallWalk ? 4 : 0 });
    const def = effective(st, defender, 'ground-offense');
    p = clamp(C.grappling.standUpBase + sigmoid((atk - def) / C.grappleSpread) * 0.4 - GROUND_VALUE[pos.ground] * 0.3, 0.03, 0.8);
  }

  const timeUsed = C.timeCost.standUp * (0.8 + ctx.rng.next() * 0.5);
  let result: FightActionResult;
  if (ctx.rng.chance(p)) {
    result = 'completed';
    resetToStanding(pos, 'boxing');
    if (!controlling && ctx.rng.chance(0.3)) {
      pos.zone = 'clinch';
      pos.clinchKind = 'fence';
      pos.controller = defender.idx;
    }
  } else {
    result = 'defended';
    pos.inactivitySeconds += timeUsed * 0.5;
  }

  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: actor.id,
    defenderId: defender.id,
    stateBefore,
    action,
    result,
    stateAfter: publicPosition(pos, actor.idx),
    damage: emptyDelta(),
    staminaCost: spent,
    scoreImpact: result === 'completed' && !controlling ? 0.6 : 0,
    importance: result === 'completed' ? 'minor' : 'trivial',
    tags: ['stand-up'],
  });

  return { timeUsed, finish: NO_FINISH };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

const SUBMISSION_DIFFICULTY: Record<SubmissionName, number> = {
  'rear-naked-choke': -2,
  guillotine: 2,
  'arm-triangle': 3,
  'triangle-choke': 3,
  armbar: 1,
  kimura: 2,
  americana: 4,
  'heel-hook': 1,
  kneebar: 4,
  'ankle-lock': 5,
  'darce-choke': 4,
  'anaconda-choke': 5,
  'von-flue-choke': 9,
  'neck-crank': 5,
  'calf-slicer': 8,
  'shoulder-choke': 5,
  'peruvian-necktie': 7,
  twister: 11,
  'north-south-choke': 5,
  omoplata: 6,
};

export const SUBMISSION_LABEL: Record<SubmissionName, string> = {
  'rear-naked-choke': 'rear naked choke',
  guillotine: 'guillotine',
  'arm-triangle': 'arm triangle',
  'triangle-choke': 'triangle choke',
  armbar: 'armbar',
  kimura: 'kimura',
  americana: 'americana',
  'heel-hook': 'heel hook',
  kneebar: 'kneebar',
  'ankle-lock': 'ankle lock',
  'darce-choke': "d'arce choke",
  'anaconda-choke': 'anaconda choke',
  'von-flue-choke': 'von flue choke',
  'neck-crank': 'neck crank',
  'calf-slicer': 'calf slicer',
  'shoulder-choke': 'shoulder choke',
  'peruvian-necktie': 'peruvian necktie',
  twister: 'twister',
  'north-south-choke': 'north south choke',
  omoplata: 'omoplata',
};

const JOINT_LOCKS: SubmissionName[] = ['armbar', 'kimura', 'americana', 'heel-hook', 'kneebar', 'ankle-lock', 'calf-slicer', 'omoplata', 'twister'];

/**
 * A submission is a staged sequence, not a single roll. Entry, secured, defense,
 * adjustment, resolution. Each stage emits its own event so the narrative can describe
 * the scramble honestly.
 */
export function resolveSubmission(ctx: ResolveCtx, attacker: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const defender = opponentOf(st, attacker);
  const action = dec.action as Extract<FightAction, { kind: 'submission' }>;
  const name = action.name;
  const pos = st.position;
  const difficulty = SUBMISSION_DIFFICULTY[name];
  let timeUsed = 0;

  const emit = (
    stage: 'entry' | 'secured' | 'defense' | 'adjustment' | 'resolution',
    result: FightActionResult,
    tags: string[],
    scoreImpact: number,
    damage = emptyDelta()
  ): void => {
    ctx.push({
      round: st.round,
      clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
      actorId: attacker.id,
      defenderId: defender.id,
      stateBefore: publicPosition(pos, attacker.idx),
      action: { kind: 'submission', name, stage },
      result,
      stateAfter: publicPosition(pos, attacker.idx),
      damage,
      staminaCost: 0,
      scoreImpact,
      importance: importanceOf(result, damage, tags),
      tags: ['submission', ...tags],
    });
  };

  // Stage 1: entry
  spendStamina(attacker, C.stamina.costs.submissionAttempt);
  timeUsed += C.timeCost.submissionStage * 0.6;
  const entryAtk = effective(st, attacker, 'submission-offense', { bonus: -difficulty });
  const entryDef = effective(st, defender, 'submission-defense');
  const entryP = clamp(C.submission.entryBase + sigmoid((entryAtk - entryDef) / C.submissionSpread) * 0.42, 0.03, 0.85);
  if (!ctx.rng.chance(entryP)) {
    emit('entry', 'defended', ['entry-failed'], 0.4);
    if (ctx.rng.chance(C.submission.positionLossOnFail)) {
      if (pos.zone === 'ground') {
        pos.ground = 'scramble';
        emitPositionLoss(ctx, attacker, defender);
      }
    }
    return { timeUsed, finish: NO_FINISH };
  }
  // Only a genuine attempt is recorded in the statistics. A failed grip that never
  // threatened anything is not a submission attempt on a scorecard or a stat sheet.
  bump(attacker, 'submissionAttempts');
  emit('entry', 'completed', ['entry-secured'], 1.4);

  // Stage 2: secured against active defense
  timeUsed += C.timeCost.submissionStage * 0.7;
  spendStamina(defender, C.stamina.costs.submissionAttempt * 1.15);
  const securedAtk = effective(st, attacker, 'submission-offense', { bonus: -difficulty * 0.5 });
  const securedDef = effective(st, defender, 'submission-defense', { bonus: defender.stamina < 40 ? -6 : 0 });
  const securedP = clamp(C.submission.securedBase + sigmoid((securedAtk - securedDef) / C.submissionSpread) * 0.4, 0.03, 0.8);
  if (!ctx.rng.chance(securedP)) {
    emit('defense', 'escaped', ['escaped'], 0.8);
    if (ctx.rng.chance(C.submission.positionLossOnFail * 1.4)) {
      if (pos.zone === 'ground') {
        pos.controller = defender.idx;
        pos.ground = ctx.rng.chance(0.5) ? 'half-guard' : 'guard';
        emitPositionLoss(ctx, attacker, defender);
      }
    }
    return { timeUsed, finish: NO_FINISH };
  }
  emit('secured', 'completed', ['submission-secured'], 2.2);

  // Stage 3: final adjustment. Fatigue and damage on the defender matter most here.
  timeUsed += C.timeCost.submissionStage * 0.8;
  const fatigueTerm = clamp((60 - defender.stamina) / 60, 0, 1) * C.submission.fatigueScale * 12;
  const finishAtk = effective(st, attacker, 'submission-offense', { bonus: fatigueTerm });
  const finishDef = effective(st, defender, 'submission-defense');
  const finishP = clamp(C.submission.finishBase + sigmoid((finishAtk - finishDef) / C.submissionSpread) * 0.27, 0.015, 0.78);

  if (ctx.rng.chance(finishP)) {
    const technical = ctx.rng.chance(C.submission.technicalChance);
    const dmg = emptyDelta();
    if (JOINT_LOCKS.includes(name)) dmg.joint = 12 + ctx.rng.next() * 20;
    addDamage(defender.damage, dmg);
    emit('resolution', technical ? 'technical-submission' : 'tapped', ['finish'], 6, dmg);
    return {
      timeUsed,
      finish: {
        method: technical ? 'technical-submission' : 'submission',
        winnerIdx: attacker.idx,
        submissionName: name,
      },
    };
  }

  // Survived. Joint locks still leave a mark.
  const dmg = emptyDelta();
  if (JOINT_LOCKS.includes(name) && ctx.rng.chance(0.45)) dmg.joint = 4 + ctx.rng.next() * 9;
  addDamage(defender.damage, dmg);
  emit('adjustment', 'escaped', ['survived'], 1.2, dmg);
  if (ctx.rng.chance(C.submission.positionLossOnFail)) {
    if (pos.zone === 'ground') {
      pos.controller = defender.idx;
      pos.ground = 'guard';
      emitPositionLoss(ctx, attacker, defender);
    }
  }
  return { timeUsed, finish: NO_FINISH };
}

function emitPositionLoss(ctx: ResolveCtx, attacker: SideState, defender: SideState): void {
  ctx.push({
    round: ctx.st.round,
    clockSecondsRemaining: Math.max(0, Math.round(ctx.st.clock)),
    actorId: defender.id,
    defenderId: attacker.id,
    stateBefore: publicPosition(ctx.st.position, defender.idx),
    action: { kind: 'grapple', name: 'reversal' },
    result: 'reversed',
    stateAfter: publicPosition(ctx.st.position, defender.idx),
    damage: emptyDelta(),
    staminaCost: 0,
    scoreImpact: 1.1,
    importance: 'major',
    tags: ['grappling', 'position-change'],
  });
}

// ---------------------------------------------------------------------------
// Movement, clinch entry and defensive actions
// ---------------------------------------------------------------------------

export function resolveMovement(ctx: ResolveCtx, actor: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const pos = st.position;
  const defender = opponentOf(st, actor);
  const action = dec.action as Extract<FightAction, { kind: 'movement' }>;
  const stateBefore = publicPosition(pos, actor.idx);
  const RANGES: ('long' | 'kick' | 'boxing' | 'pocket')[] = ['long', 'kick', 'boxing', 'pocket'];
  let timeUsed = C.timeCost.movement * (0.7 + ctx.rng.next() * 0.6);
  let result: FightActionResult = 'completed';
  const tags: string[] = ['movement'];

  const legs = totalLegDamage(actor.damage);
  const mobility = clamp(1 - legs / 70, 0.35, 1);

  switch (action.name) {
    case 'press-forward': {
      spendStamina(actor, C.stamina.costs.pressureMovement * 1.4);
      const cur = RANGES.indexOf(pos.range);
      const opposition = effective(st, defender, 'strike-defense') - effective(st, actor, 'strike-offense');
      const p = clamp(0.62 * mobility - opposition * 0.008, 0.15, 0.9);
      if (pos.zone === 'standing' && ctx.rng.chance(p) && cur < RANGES.length - 1) {
        pos.range = RANGES[cur + 1];
        pos.inactivitySeconds = 0;
      } else {
        result = 'no-effect';
      }
      break;
    }
    case 'retreat': {
      spendStamina(actor, C.stamina.costs.pressureMovement);
      const cur = RANGES.indexOf(pos.range);
      if (pos.zone === 'clinch') {
        const atk = effective(st, actor, 'clinch');
        const def = effective(st, defender, 'clinch');
        if (ctx.rng.chance(clamp(sigmoid((atk - def) / C.grappleSpread) * 0.8, 0.1, 0.85))) {
          resetToStanding(pos, 'boxing');
          tags.push('clinch-break');
        } else {
          result = 'defended';
        }
      } else if (cur > 0 && ctx.rng.chance(clamp(0.7 * mobility, 0.2, 0.92))) {
        pos.range = RANGES[cur - 1];
      } else {
        result = 'no-effect';
      }
      break;
    }
    case 'circle': {
      spendStamina(actor, C.stamina.costs.pressureMovement * 0.7);
      pos.inactivitySeconds += timeUsed * 0.4;
      break;
    }
    case 'feint': {
      spendStamina(actor, C.stamina.costs.pressureMovement * 0.5);
      timeUsed = C.timeCost.feint;
      tags.push('feint');
      break;
    }
    case 'reset': {
      if (pos.zone === 'clinch') {
        const atk = effective(st, actor, 'clinch');
        const def = effective(st, defender, 'clinch');
        if (ctx.rng.chance(clamp(sigmoid((atk - def) / C.grappleSpread) * 0.75, 0.1, 0.85))) {
          resetToStanding(pos, 'boxing');
          tags.push('clinch-break');
        } else {
          result = 'defended';
        }
      } else if (pos.downedIdx !== null) {
        pos.downedIdx = null;
        resetToStanding(pos, 'boxing');
        tags.push('let-up');
      } else {
        resetToStanding(pos, 'long');
      }
      break;
    }
    case 'recover': {
      timeUsed = C.timeCost.movement * 1.4;
      actor.stamina = clamp(actor.stamina + 1.4, 0, C.stamina.max);
      pos.inactivitySeconds += timeUsed;
      tags.push('recover');
      break;
    }
  }

  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: actor.id,
    defenderId: defender.id,
    stateBefore,
    action,
    result,
    stateAfter: publicPosition(pos, actor.idx),
    damage: emptyDelta(),
    staminaCost: 0,
    scoreImpact: 0,
    importance: 'trivial',
    tags,
  });

  return { timeUsed, finish: NO_FINISH };
}

export function resolveDefensiveAction(ctx: ResolveCtx, actor: SideState, dec: Decision): ResolveOutcome {
  const st = ctx.st;
  const pos = st.position;
  const defender = opponentOf(st, actor);
  const action = dec.action as Extract<FightAction, { kind: 'defense' }>;
  const timeUsed = C.timeCost.feint * (0.8 + ctx.rng.next() * 0.5);
  const tags = ['defense'];
  if (action.name === 'angle-exit' && pos.zone === 'standing') {
    const RANGES: ('long' | 'kick' | 'boxing' | 'pocket')[] = ['long', 'kick', 'boxing', 'pocket'];
    const cur = RANGES.indexOf(pos.range);
    if (cur > 0 && ctx.rng.chance(0.6)) pos.range = RANGES[cur - 1];
  }
  if (action.name === 'shell') {
    actor.stamina = clamp(actor.stamina + 0.6, 0, C.stamina.max);
    pos.inactivitySeconds += timeUsed;
  }
  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: actor.id,
    defenderId: defender.id,
    stateBefore: publicPosition(pos, actor.idx),
    action,
    result: 'completed',
    stateAfter: publicPosition(pos, actor.idx),
    damage: emptyDelta(),
    staminaCost: 0,
    scoreImpact: 0,
    importance: 'trivial',
    tags,
  });
  return { timeUsed, finish: NO_FINISH };
}

export function resolveClinchEntry(ctx: ResolveCtx, actor: SideState): ResolveOutcome {
  const st = ctx.st;
  const pos = st.position;
  const defender = opponentOf(st, actor);
  const stateBefore = publicPosition(pos, actor.idx);
  const spent = spendStamina(actor, C.stamina.costs.clinchWork);
  const atk = effective(st, actor, 'clinch');
  const def = effective(st, defender, 'clinch');
  const p = clamp(sigmoid((atk - def) / C.grappleSpread) * 0.85, 0.08, 0.88);
  const timeUsed = C.timeCost.clinchWork * (0.7 + ctx.rng.next() * 0.5);
  let result: FightActionResult = 'stuffed';
  if (ctx.rng.chance(p)) {
    pos.zone = 'clinch';
    pos.controller = actor.idx;
    pos.clinchKind = ctx.rng.chance(0.45) ? 'fence' : 'open';
    pos.heldSeconds = 0;
    pos.inactivitySeconds = 0;
    result = 'completed';
  }
  ctx.push({
    round: st.round,
    clockSecondsRemaining: Math.max(0, Math.round(st.clock - timeUsed)),
    actorId: actor.id,
    defenderId: defender.id,
    stateBefore,
    action: { kind: 'wrestle', name: 'body-lock' },
    result,
    stateAfter: publicPosition(pos, actor.idx),
    damage: emptyDelta(),
    staminaCost: spent,
    scoreImpact: result === 'completed' ? 0.4 : 0,
    importance: 'minor',
    tags: ['clinch-entry'],
  });
  return { timeUsed, finish: NO_FINISH };
}

export { isKick, isSpinning };
