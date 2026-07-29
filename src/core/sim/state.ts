import type { DamageDelta, FightPosition, GamePlanKey } from '../types';
import type { Fighter, Ratings, Tendencies } from '../types/fighter';
import type { DivisionConfig } from '../config/divisions';
import { emptyStatLine, type RoundStatLine } from '../types/fight';

/**
 * Internal position model.
 *
 * The public FightPosition enum is perspective dependent (top-mount versus bottom-mount).
 * Carrying that in the live state would double every transition table, so the engine
 * stores a neutral position plus a controller index and projects the public value only
 * when it emits an event.
 */
export type Zone = 'standing' | 'clinch' | 'ground';

export type StandingRange = 'long' | 'kick' | 'boxing' | 'pocket';

export type GroundPosition =
  | 'guard'
  | 'half-guard'
  | 'side-control'
  | 'mount'
  | 'back'
  | 'turtle'
  | 'leg-entanglement'
  | 'scramble';

export interface PositionState {
  zone: Zone;
  range: StandingRange;
  clinchKind: 'open' | 'fence';
  /** Index of the fighter with the controlling position in clinch and on the ground. */
  controller: 0 | 1;
  ground: GroundPosition;
  /** Set for the seconds immediately after a knockdown. */
  downedIdx: 0 | 1 | null;
  /** Seconds since anything meaningful happened. Drives referee stand ups. */
  inactivitySeconds: number;
  /** Seconds spent in the current position, used for control time accounting. */
  heldSeconds: number;
}

/** Dominance value of a ground position for the controller, 0 to 1. */
export const GROUND_VALUE: Record<GroundPosition, number> = {
  guard: 0.34,
  'half-guard': 0.5,
  'side-control': 0.66,
  mount: 0.84,
  back: 0.92,
  turtle: 0.6,
  'leg-entanglement': 0.55,
  scramble: 0.5,
};

export interface ActiveInjuryEffect {
  area: string;
  penalty: number;
  blocksKicks: boolean;
  blocksTakedowns: boolean;
}

/**
 * Behavioral profile derived once at setup from tendencies plus the chosen game plan.
 * These are desires, not abilities. A fighter who wants the takedown badly is not better
 * at takedowns, only more willing to spend stamina attempting them.
 */
export interface PlanProfile {
  pressure: number;
  distance: number;
  takedown: number;
  ground: number;
  submission: number;
  clinch: number;
  legKick: number;
  bodyAttack: number;
  pace: number;
  staminaMult: number;
  finishSeeking: number;
  caution: number;
  counter: number;
  protectInjury: boolean;
  avoidStrength: boolean;
}

export interface SideState {
  idx: 0 | 1;
  id: string;
  fighter: Fighter;
  /** Base ratings after camp, injury and cut adjustments are baked in once at setup. */
  base: Ratings;
  tendencies: Tendencies;
  gamePlan: GamePlanKey[];
  division: DivisionConfig;

  stamina: number;
  damage: DamageDelta;
  stunSecondsRemaining: number;
  knockdownsTaken: number;
  knockdownsScored: number;
  /** Clean strikes landed on this fighter without a meaningful reply. */
  unansweredAgainst: number;
  vulnerableSecondsRemaining: number;

  /** Static modifiers computed once at fight setup. */
  reachAdvantage: number;
  heightAdvantage: number;
  sharpness: number;
  tacticalFamiliarity: number;
  experienceBonus: number;
  /** Drawn once per fight. Fighters have good nights and bad nights. */
  nightForm: number;
  cutPenalty: number;
  campPenalty: number;
  injuryEffects: ActiveInjuryEffect[];
  composure: number;
  powerFactor: number;
  fatigueFactor: number;

  /** Live tactical state chosen by the AI. */
  plan: PlanProfile;
  aggression: number;
  paceTarget: number;
  wantsGround: boolean;
  wantsDistance: boolean;
  protectingLead: boolean;
  desperate: boolean;

  roundStats: RoundStatLine;
  fightStats: RoundStatLine;
  pointDeductions: number;
  fouls: number;

  /** Set when the fighter is finished. */
  finishedBy: string | null;
}

export interface FightSetupSide {
  fighter: Fighter;
  gamePlan: GamePlanKey[];
  sharpness: number;
  tacticalFamiliarity: number;
  cutQuality: number;
  campQuality: number;
  shortNotice: boolean;
}

export interface FightState {
  a: SideState;
  b: SideState;
  position: PositionState;
  round: number;
  clock: number;
  scheduledRounds: 3 | 5;
  seq: number;
  over: boolean;
  refereeTendency: number;
  totalSeconds: number;
}

export function otherIdx(i: 0 | 1): 0 | 1 {
  return i === 0 ? 1 : 0;
}

export function sideByIdx(st: FightState, i: 0 | 1): SideState {
  return i === 0 ? st.a : st.b;
}

export function opponentOf(st: FightState, side: SideState): SideState {
  return side.idx === 0 ? st.b : st.a;
}

export function zeroDamage(): DamageDelta {
  return { head: 0, body: 0, legLeft: 0, legRight: 0, cut: 0, swelling: 0, balance: 0, joint: 0 };
}

export function addDamage(target: DamageDelta, delta: DamageDelta): void {
  target.head += delta.head;
  target.body += delta.body;
  target.legLeft += delta.legLeft;
  target.legRight += delta.legRight;
  target.cut += delta.cut;
  target.swelling += delta.swelling;
  target.balance += delta.balance;
  target.joint += delta.joint;
}

export function totalLegDamage(d: DamageDelta): number {
  return Math.max(d.legLeft, d.legRight) + Math.min(d.legLeft, d.legRight) * 0.35;
}

export function freshStats(): RoundStatLine {
  return emptyStatLine();
}

/** Projects the neutral internal position into the public perspective dependent enum. */
export function publicPosition(pos: PositionState, actorIdx: 0 | 1): FightPosition {
  if (pos.downedIdx !== null) return 'knockdown';
  if (pos.zone === 'standing') {
    switch (pos.range) {
      case 'long':
        return 'long-range';
      case 'kick':
        return 'kick-range';
      case 'boxing':
        return 'boxing-range';
      case 'pocket':
        return 'pocket';
    }
  }
  if (pos.zone === 'clinch') {
    return pos.clinchKind === 'fence' ? 'fence-clinch' : 'open-clinch';
  }
  const isController = pos.controller === actorIdx;
  switch (pos.ground) {
    case 'scramble':
      return 'scramble';
    case 'leg-entanglement':
      return 'leg-entanglement';
    case 'guard':
      return isController ? 'top-guard' : 'bottom-guard';
    case 'half-guard':
      return isController ? 'top-half-guard' : 'bottom-half-guard';
    case 'side-control':
      return isController ? 'top-side-control' : 'bottom-side-control';
    case 'mount':
      return isController ? 'top-mount' : 'bottom-mount';
    case 'back':
      return isController ? 'back-control' : 'back-taken';
    case 'turtle':
      return isController ? 'turtle-top' : 'turtle-bottom';
  }
}

export function isGroundControlPosition(pos: PositionState): boolean {
  return pos.zone === 'ground' && pos.ground !== 'scramble';
}

export function startingPosition(): PositionState {
  return {
    zone: 'standing',
    range: 'long',
    clinchKind: 'open',
    controller: 0,
    ground: 'guard',
    downedIdx: null,
    inactivitySeconds: 0,
    heldSeconds: 0,
  };
}

/** Resets to a neutral standing position after a referee break or a round start. */
export function resetToStanding(pos: PositionState, range: StandingRange = 'long'): void {
  pos.zone = 'standing';
  pos.range = range;
  pos.ground = 'guard';
  pos.downedIdx = null;
  pos.inactivitySeconds = 0;
  pos.heldSeconds = 0;
}
