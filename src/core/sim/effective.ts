import { CALIBRATION as C } from '../config/calibration';
import { clamp } from '../rng';
import { GROUND_VALUE, opponentOf, totalLegDamage, type FightState, type SideState } from './state';

/**
 * Contested domains. Each blends the six ratings differently. This blend is the only
 * place where concepts such as takedown defense, chin or fight IQ exist: they are
 * derived here from the six, never stored as a seventh rating.
 */
export type Domain =
  | 'strike-offense'
  | 'strike-defense'
  | 'power'
  | 'takedown-offense'
  | 'takedown-defense'
  | 'ground-offense'
  | 'ground-defense'
  | 'submission-offense'
  | 'submission-defense'
  | 'scramble'
  | 'clinch'
  | 'recovery';

const BLEND: Record<Domain, Partial<Record<keyof SideState['base'], number>>> = {
  'strike-offense': { striking: 0.86, cardio: 0.08, wrestling: 0.06 },
  'strike-defense': { striking: 0.7, durability: 0.14, cardio: 0.1, grappling: 0.06 },
  power: { striking: 0.74, durability: 0.16, wrestling: 0.1 },
  'takedown-offense': { wrestling: 0.78, grappling: 0.14, cardio: 0.08 },
  'takedown-defense': { wrestling: 0.66, grappling: 0.2, durability: 0.08, cardio: 0.06 },
  'ground-offense': { grappling: 0.72, wrestling: 0.16, submissions: 0.12 },
  'ground-defense': { grappling: 0.68, wrestling: 0.18, submissions: 0.08, durability: 0.06 },
  'submission-offense': { submissions: 0.74, grappling: 0.2, cardio: 0.06 },
  'submission-defense': { submissions: 0.44, grappling: 0.4, durability: 0.1, cardio: 0.06 },
  scramble: { wrestling: 0.42, grappling: 0.4, cardio: 0.18 },
  clinch: { wrestling: 0.44, grappling: 0.3, striking: 0.16, cardio: 0.1 },
  recovery: { cardio: 0.6, durability: 0.4 },
};

function blended(side: SideState, domain: Domain): number {
  const w = BLEND[domain];
  let sum = 0;
  let weight = 0;
  for (const key of Object.keys(w) as (keyof SideState['base'])[]) {
    const k = w[key] as number;
    sum += side.base[key] * k;
    weight += k;
  }
  return weight > 0 ? sum / weight : 50;
}

/** Fatigue penalty grows once stamina drops below the threshold. */
export function fatiguePenalty(side: SideState): number {
  const deficit = C.stamina.fatigueThreshold - side.stamina;
  if (deficit <= 0) return 0;
  // Quadratic so the last twenty points of gas hurt far more than the first twenty.
  const linear = deficit * C.stamina.fatiguePenaltyPerPoint;
  const extra = Math.pow(Math.max(0, deficit - 25) / 10, 2) * 0.9;
  return linear + extra;
}

export function damagePenalty(side: SideState, domain: Domain): number {
  const d = side.damage;
  let p = d.head * C.damage.headPenaltyPerPoint;
  p += d.body * C.damage.bodyPenaltyPerPoint;
  const legs = totalLegDamage(d);
  // Leg damage matters most for movement, kicking and shooting, least for submissions.
  const legWeight =
    domain === 'strike-offense' || domain === 'takedown-offense'
      ? 1
      : domain === 'strike-defense' || domain === 'takedown-defense'
        ? 0.8
        : 0.25;
  p += legs * C.damage.legPenaltyPerPoint * legWeight;
  p += d.balance * 0.09;
  if (side.stunSecondsRemaining > 0) p += C.stun.abilityPenalty;
  return p;
}

export function injuryPenalty(side: SideState, domain: Domain): number {
  let p = 0;
  for (const inj of side.injuryEffects) {
    if (inj.blocksKicks && domain === 'strike-offense') p += inj.penalty * 0.7;
    else if (inj.blocksTakedowns && (domain === 'takedown-offense' || domain === 'scramble')) p += inj.penalty;
    else p += inj.penalty * 0.4;
  }
  return p;
}

/** Physical advantage that applies only where it plausibly should. */
function physicalModifier(st: FightState, side: SideState, domain: Domain): number {
  const pos = st.position;
  if (domain === 'strike-offense' || domain === 'strike-defense') {
    if (pos.zone !== 'standing') return side.heightAdvantage * C.striking.heightAdvantagePerInch * 0.3;
    // Reach only pays at range. In the pocket it is close to worthless and long limbs
    // can be a liability, which is why the pocket multiplier goes slightly negative.
    const rangeMult = pos.range === 'long' ? 1 : pos.range === 'kick' ? 0.8 : pos.range === 'boxing' ? 0.35 : -0.18;
    return (
      side.reachAdvantage * C.striking.reachAdvantagePerInch * rangeMult +
      side.heightAdvantage * C.striking.heightAdvantagePerInch * (rangeMult > 0 ? 1 : 0.2)
    );
  }
  if (domain === 'takedown-offense') {
    // Shorter, more compact fighters change levels more efficiently.
    return -side.heightAdvantage * 0.16;
  }
  if (domain === 'takedown-defense' || domain === 'clinch') {
    return side.heightAdvantage * 0.12;
  }
  return 0;
}

/** Position specific competence. Being on the bottom is not the same as being bad. */
function positionModifier(st: FightState, side: SideState, domain: Domain): number {
  const pos = st.position;
  if (pos.zone !== 'ground') return 0;
  const isController = pos.controller === side.idx;
  const value = GROUND_VALUE[pos.ground];
  const signed = isController ? value - 0.5 : 0.5 - value;
  switch (domain) {
    case 'ground-offense':
      return signed * 26;
    case 'ground-defense':
      return signed * 14;
    case 'submission-offense':
      // The back and mount are where submissions actually happen.
      return signed * (pos.ground === 'back' || pos.ground === 'mount' ? 30 : 16);
    case 'submission-defense':
      return signed * 12;
    case 'strike-offense':
      return signed * 20;
    case 'strike-defense':
      return signed * 10;
    default:
      return 0;
  }
}

/**
 * Composure from age and experience. Peaks in the early thirties, small either way.
 * Deliberately capped so a veteran never outclasses a better fighter on this alone.
 */
function composureModifier(side: SideState): number {
  return side.composure;
}

export interface EffectiveOptions {
  /** Extra situational modifier from the calling site, for example a game plan bonus. */
  bonus?: number;
  /** Ignore fatigue, used by the AI when reasoning about a fresh opponent. */
  ignoreFatigue?: boolean;
}

/**
 * The single entry point for every opposed check in the engine.
 *
 * effective = blended rating
 *           + camp sharpness + tactical familiarity + experience + composure
 *           + physical + position + caller bonus
 *           - fatigue - damage - injury - cut penalty - camp penalty
 */
export function effective(st: FightState, side: SideState, domain: Domain, opts: EffectiveOptions = {}): number {
  const base = blended(side, domain);
  const camp = side.sharpness * C.fight.sharpnessMax;
  const tactical = domain === 'strike-defense' || domain === 'takedown-defense' || domain === 'submission-defense'
    ? side.tacticalFamiliarity * C.fight.familiarityMax
    : side.tacticalFamiliarity * C.fight.familiarityMax * 0.55;
  const exp = side.experienceBonus;
  const phys = physicalModifier(st, side, domain);
  const posMod = positionModifier(st, side, domain);
  const fatigue = opts.ignoreFatigue ? 0 : fatiguePenalty(side);
  const dmg = damagePenalty(side, domain);
  const inj = injuryPenalty(side, domain);

  const value =
    base +
    camp +
    tactical +
    exp +
    side.nightForm +
    composureModifier(side) +
    phys +
    posMod +
    (opts.bonus ?? 0) -
    fatigue -
    dmg -
    inj -
    side.cutPenalty -
    side.campPenalty;

  return clamp(value, 1, 140);
}

/** Convenience for a head to head check between the two sides. */
export function contest(
  st: FightState,
  attacker: SideState,
  attackerDomain: Domain,
  defenderDomain: Domain,
  spread: number,
  bonus = 0
): { atk: number; def: number; delta: number; spread: number } {
  const defender = opponentOf(st, attacker);
  const atk = effective(st, attacker, attackerDomain, { bonus });
  const def = effective(st, defender, defenderDomain);
  return { atk, def, delta: atk - def, spread };
}

/** Stamina cost scaled by the fighter's cardio rating and division. */
export function staminaCost(side: SideState, base: number): number {
  const cardioScale = 1 + ((60 - side.base.cardio) / 100) * C.stamina.cardioCostScale;
  return base * Math.max(0.45, cardioScale) * side.fatigueFactor;
}

export function spendStamina(side: SideState, base: number): number {
  const cost = staminaCost(side, base);
  side.stamina = clamp(side.stamina - cost, 0, C.stamina.max);
  return cost;
}

export function recoverStamina(side: SideState, seconds: number, intensity: number): void {
  const bodyPenalty = 1 - clamp(side.damage.body * C.stamina.bodyDamageRecoveryPenalty, 0, 0.7);
  const cardioScale = 0.6 + (side.base.cardio / 100) * 0.9;
  const gained = C.stamina.passiveRecoveryPerSecond * seconds * (1 - clamp(intensity, 0, 1)) * cardioScale * bodyPenalty;
  side.stamina = clamp(side.stamina + gained, 0, C.stamina.max);
}
