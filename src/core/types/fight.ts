import type { BoutId, EventId, FighterId, IsoDate } from './common';
import type { DivisionId } from '../config/divisions';

/** Explicit fight positions. Every action is legal only from a defined set of these. */
export type FightPosition =
  | 'long-range'
  | 'kick-range'
  | 'boxing-range'
  | 'pocket'
  | 'open-clinch'
  | 'fence-clinch'
  | 'takedown-attempt'
  | 'scramble'
  | 'knockdown'
  | 'top-guard'
  | 'bottom-guard'
  | 'top-half-guard'
  | 'bottom-half-guard'
  | 'top-side-control'
  | 'bottom-side-control'
  | 'top-mount'
  | 'bottom-mount'
  | 'back-control'
  | 'back-taken'
  | 'turtle-top'
  | 'turtle-bottom'
  | 'leg-entanglement'
  | 'standing-reset';

export const STANDING_POSITIONS: FightPosition[] = [
  'long-range',
  'kick-range',
  'boxing-range',
  'pocket',
  'standing-reset',
];

export const CLINCH_POSITIONS: FightPosition[] = ['open-clinch', 'fence-clinch'];

export const GROUND_POSITIONS: FightPosition[] = [
  'top-guard',
  'bottom-guard',
  'top-half-guard',
  'bottom-half-guard',
  'top-side-control',
  'bottom-side-control',
  'top-mount',
  'bottom-mount',
  'back-control',
  'back-taken',
  'turtle-top',
  'turtle-bottom',
  'leg-entanglement',
];

export type StrikeAction =
  | 'jab'
  | 'cross'
  | 'hook'
  | 'uppercut'
  | 'overhand'
  | 'combination'
  | 'body-punch'
  | 'low-kick'
  | 'calf-kick'
  | 'body-kick'
  | 'head-kick'
  | 'front-kick'
  | 'side-kick'
  | 'spinning-kick'
  | 'knee'
  | 'flying-knee'
  | 'elbow'
  | 'spinning-elbow'
  | 'clinch-strike'
  | 'ground-strike'
  | 'ground-elbow';

export type DefensiveAction =
  | 'shell'
  | 'slip'
  | 'pull'
  | 'block'
  | 'parry'
  | 'check'
  | 'counter'
  | 'angle-exit'
  | 'level-change-feint';

export type WrestlingAction =
  | 'single-leg'
  | 'double-leg'
  | 'body-lock'
  | 'outside-trip'
  | 'inside-trip'
  | 'foot-sweep'
  | 'hip-throw'
  | 'reactive-takedown'
  | 'catch-kick-takedown'
  | 'fence-takedown'
  | 'mat-return'
  | 'sprawl'
  | 'whizzer'
  | 'underhook-defense'
  | 'stand-up'
  | 'wall-walk';

export type GrapplingAction =
  | 'pass-guard'
  | 'advance-position'
  | 'hold-position'
  | 'posture-up'
  | 'sweep'
  | 'reversal'
  | 'guard-recovery'
  | 'turtle-transition'
  | 'scramble-reset'
  | 'take-back'
  | 'escape-back'
  | 'rest-in-position';

export type SubmissionName =
  | 'rear-naked-choke'
  | 'guillotine'
  | 'arm-triangle'
  | 'triangle-choke'
  | 'armbar'
  | 'kimura'
  | 'americana'
  | 'heel-hook'
  | 'kneebar'
  | 'ankle-lock'
  | 'darce-choke'
  | 'anaconda-choke'
  | 'von-flue-choke'
  | 'neck-crank'
  | 'calf-slicer'
  | 'shoulder-choke'
  | 'peruvian-necktie'
  | 'twister'
  | 'north-south-choke'
  | 'omoplata';

export type SubmissionStage = 'entry' | 'secured' | 'defense' | 'adjustment' | 'resolution';

export type FightAction =
  | { kind: 'strike'; name: StrikeAction }
  | { kind: 'defense'; name: DefensiveAction }
  | { kind: 'wrestle'; name: WrestlingAction }
  | { kind: 'grapple'; name: GrapplingAction }
  | { kind: 'submission'; name: SubmissionName; stage: SubmissionStage }
  | { kind: 'movement'; name: 'circle' | 'press-forward' | 'retreat' | 'feint' | 'reset' | 'recover' }
  | { kind: 'referee'; name: 'stand-up' | 'warning' | 'point-deduction' | 'timeout' | 'doctor-check' | 'break' };

export type FightActionResult =
  | 'clean-land'
  | 'partial-land'
  | 'blocked'
  | 'slipped'
  | 'missed'
  | 'countered'
  | 'completed'
  | 'stuffed'
  | 'partial'
  | 'reversed'
  | 'escaped'
  | 'defended'
  | 'tapped'
  | 'technical-submission'
  | 'no-effect'
  | 'stalled';

export interface DamageDelta {
  head: number;
  body: number;
  legLeft: number;
  legRight: number;
  cut: number;
  swelling: number;
  balance: number;
  joint: number;
}

export const ZERO_DAMAGE: DamageDelta = {
  head: 0,
  body: 0,
  legLeft: 0,
  legRight: 0,
  cut: 0,
  swelling: 0,
  balance: 0,
  joint: 0,
};

export type EventImportance = 'trivial' | 'minor' | 'notable' | 'major' | 'decisive';

export interface FightEvent {
  seq: number;
  round: number;
  clockSecondsRemaining: number;
  actorId: FighterId;
  defenderId: FighterId;
  stateBefore: FightPosition;
  action: FightAction;
  target?: 'head' | 'body' | 'leg';
  result: FightActionResult;
  stateAfter: FightPosition;
  damage: DamageDelta;
  staminaCost: number;
  /** Round score contribution for the actor. Judges consume this, not the prose. */
  scoreImpact: number;
  importance: EventImportance;
  tags: string[];
  /** Rendered narration. Written after the fact by the narrative layer. */
  text?: string;
}

export interface RoundStatLine {
  sigStrikesLanded: number;
  sigStrikesAttempted: number;
  totalStrikesLanded: number;
  totalStrikesAttempted: number;
  headLanded: number;
  headAttempted: number;
  bodyLanded: number;
  bodyAttempted: number;
  legLanded: number;
  legAttempted: number;
  distanceLanded: number;
  distanceAttempted: number;
  clinchLanded: number;
  clinchAttempted: number;
  groundLanded: number;
  groundAttempted: number;
  knockdowns: number;
  stuns: number;
  counters: number;
  combinations: number;
  takedownsLanded: number;
  takedownsAttempted: number;
  submissionAttempts: number;
  reversals: number;
  controlSeconds: number;
  groundControlSeconds: number;
  clinchControlSeconds: number;
  fouls: number;
}

export function emptyStatLine(): RoundStatLine {
  return {
    sigStrikesLanded: 0,
    sigStrikesAttempted: 0,
    totalStrikesLanded: 0,
    totalStrikesAttempted: 0,
    headLanded: 0,
    headAttempted: 0,
    bodyLanded: 0,
    bodyAttempted: 0,
    legLanded: 0,
    legAttempted: 0,
    distanceLanded: 0,
    distanceAttempted: 0,
    clinchLanded: 0,
    clinchAttempted: 0,
    groundLanded: 0,
    groundAttempted: 0,
    knockdowns: 0,
    stuns: 0,
    counters: 0,
    combinations: 0,
    takedownsLanded: 0,
    takedownsAttempted: 0,
    submissionAttempts: 0,
    reversals: 0,
    controlSeconds: 0,
    groundControlSeconds: 0,
    clinchControlSeconds: 0,
    fouls: 0,
  };
}

export function addStatLines(a: RoundStatLine, b: RoundStatLine): RoundStatLine {
  const out = {} as RoundStatLine;
  for (const k of Object.keys(a) as (keyof RoundStatLine)[]) out[k] = a[k] + b[k];
  return out;
}

export type FinishMethod =
  | 'ko'
  | 'tko-strikes'
  | 'tko-ground-strikes'
  | 'submission'
  | 'technical-submission'
  | 'doctor-stoppage'
  | 'corner-stoppage'
  | 'retirement'
  | 'decision-unanimous'
  | 'decision-split'
  | 'decision-majority'
  | 'draw-unanimous'
  | 'draw-split'
  | 'draw-majority'
  | 'disqualification'
  | 'no-contest'
  | 'technical-decision'
  | 'technical-draw';

export const METHOD_LABEL: Record<FinishMethod, string> = {
  ko: 'KO',
  'tko-strikes': 'TKO (strikes)',
  'tko-ground-strikes': 'TKO (ground and pound)',
  submission: 'Submission',
  'technical-submission': 'Technical submission',
  'doctor-stoppage': 'TKO (doctor stoppage)',
  'corner-stoppage': 'TKO (corner stoppage)',
  retirement: 'TKO (retirement)',
  'decision-unanimous': 'Decision (unanimous)',
  'decision-split': 'Decision (split)',
  'decision-majority': 'Decision (majority)',
  'draw-unanimous': 'Draw (unanimous)',
  'draw-split': 'Draw (split)',
  'draw-majority': 'Draw (majority)',
  disqualification: 'DQ',
  'no-contest': 'No contest',
  'technical-decision': 'Technical decision',
  'technical-draw': 'Technical draw',
};

/**
 * True for any championship bout, undisputed or interim.
 *
 * `isTitleFight` on its own means the undisputed title, because an interim bout sets it
 * false and `isInterimTitleFight` true. Anything that asks "is a belt on the line" wants
 * this predicate; only the code that moves the undisputed title should read the raw flag.
 */
export function isChampionshipBout(x: { isTitleFight: boolean; isInterimTitleFight: boolean }): boolean {
  return x.isTitleFight || x.isInterimTitleFight;
}

export function isFinish(m: FinishMethod): boolean {
  return (
    m === 'ko' ||
    m === 'tko-strikes' ||
    m === 'tko-ground-strikes' ||
    m === 'submission' ||
    m === 'technical-submission' ||
    m === 'doctor-stoppage' ||
    m === 'corner-stoppage' ||
    m === 'retirement'
  );
}

export function isDecision(m: FinishMethod): boolean {
  return m.startsWith('decision-') || m.startsWith('draw-') || m === 'technical-decision' || m === 'technical-draw';
}

export interface JudgeScorecard {
  judgeName: string;
  rounds: { round: number; a: number; b: number }[];
  totalA: number;
  totalB: number;
}

export interface RoundResult {
  round: number;
  /**
   * Per round detail. Optional because deep history is compacted: fights far enough in
   * the past keep their result, totals, scorecards and summaries, and give up the round
   * by round breakdown. Nothing that records, rankings or fighter pages read is lost.
   */
  statsA?: RoundStatLine;
  statsB?: RoundStatLine;
  /** Unofficial internal score used by judges before perception noise. */
  trueScoreA: number;
  trueScoreB: number;
  damageEndA?: DamageDelta;
  damageEndB?: DamageDelta;
  staminaEndA?: number;
  staminaEndB?: number;
  summary: string;
  keyMomentSeq: number | null;
  endedFight: boolean;
}

export interface FightResult {
  boutId: BoutId;
  eventId: EventId;
  date: IsoDate;
  fighterAId: FighterId;
  fighterBId: FighterId;
  winnerId: FighterId | null;
  loserId: FighterId | null;
  method: FinishMethod;
  submissionName: SubmissionName | null;
  finishingStrike: StrikeAction | null;
  endRound: number;
  endTimeSeconds: number;
  scheduledRounds: 3 | 5;
  divisionId: DivisionId;
  isTitleFight: boolean;
  isInterimTitleFight: boolean;
  /** Copied from the bout at fight time so a stored result explains its own title outcome. */
  titleIneligibleFighterIds: FighterId[];
  contractedWeightLb: number;
  rounds: RoundResult[];
  totalsA: RoundStatLine;
  totalsB: RoundStatLine;
  scorecards: JudgeScorecard[];
  pointDeductionsA: number;
  pointDeductionsB: number;
  events: FightEvent[];
  finalDamageA: DamageDelta;
  finalDamageB: DamageDelta;
  finalStaminaA: number;
  finalStaminaB: number;
  longevityCostA: number;
  longevityCostB: number;
  injuriesA: string[];
  injuriesB: string[];
  performanceBonusIds: FighterId[];
  fightOfTheNight: boolean;
  fightQuality: number;
  narrativeSummary: string;
  seed: number;
}

export type BoutStatus = 'scheduled' | 'completed' | 'canceled' | 'postponed';

export interface Bout {
  id: BoutId;
  eventId: EventId;
  date: IsoDate;
  fighterAId: FighterId;
  fighterBId: FighterId;
  divisionId: DivisionId;
  contractedWeightLb: number;
  scheduledRounds: 3 | 5;
  isTitleFight: boolean;
  isInterimTitleFight: boolean;
  /**
   * Fighters who forfeited their claim on the belt by missing weight. Empty means the
   * championship is on the line for both sides in the normal way.
   */
  titleIneligibleFighterIds: FighterId[];
  isMainEvent: boolean;
  isCoMain: boolean;
  cardSegment: 'main' | 'prelim' | 'early-prelim';
  boutOrder: number;
  isCatchweight: boolean;
  status: BoutStatus;
  resultId: string | null;
  bookedOn: IsoDate;
  replacementHistory: { replacedFighterId: FighterId; newFighterId: FighterId; on: IsoDate; reason: string }[];
  cancelReason: string | null;
  /** Purses agreed at booking. Simulated game values. */
  purseA: { show: number; win: number };
  purseB: { show: number; win: number };
  weighInA: { madeWeight: boolean; weightLb: number; cutQuality: number } | null;
  weighInB: { madeWeight: boolean; weightLb: number; cutQuality: number } | null;
  bookingReason: string;
  /** The structured matchmaking category, so the interface can label why this fight exists. */
  bookingKind?: string;
  /** The judges and referee assigned to this bout, resolved against `save.officials`. */
  officials?: { judgeIds: string[]; refereeId: string | null };
}
