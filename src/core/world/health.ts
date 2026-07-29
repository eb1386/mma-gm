import { BUILDS } from '../config/builds';
import { CALIBRATION as C, DIFFICULTY } from '../config/calibration';
import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { clamp, Rng } from '../rng';
import { addDays, ageOn, type IsoDate } from '../types/common';
import type { FightResult } from '../types/fight';
import type { Fighter, Injury, WearComponents } from '../types/fighter';
import type { SaveGame } from '../types/save';

/**
 * Health: injuries, weight management and the Longevity model.
 *
 * Longevity is remaining career resilience. It sits outside Ovr, declines from the real
 * cost of competing and training, and only partly recovers with rest. The interface shows
 * one Longevity number plus a plain language health report. There is no graphic medical
 * detail anywhere in the game.
 */

// ---------------------------------------------------------------------------
// Longevity
// ---------------------------------------------------------------------------

export function longevityFromWear(w: WearComponents): number {
  // Neurological wear dominates because it is the least recoverable.
  const weighted =
    w.neurological * 0.34 + w.facial * 0.1 + w.joint * 0.18 + w.body * 0.12 + w.weightCut * 0.11 + w.recovery * 0.15;
  return clamp(Math.round(100 - weighted), 1, 100);
}

export interface WearDelta {
  neurological?: number;
  facial?: number;
  joint?: number;
  body?: number;
  weightCut?: number;
  recovery?: number;
}

export function applyWear(fighter: Fighter, delta: WearDelta, resilience: number): void {
  const scale = 1 / clamp(resilience, 0.6, 1.4);
  for (const [k, v] of Object.entries(delta)) {
    const key = k as keyof WearComponents;
    fighter.wear[key] = clamp(fighter.wear[key] + (v ?? 0) * scale, 0, 100);
  }
  fighter.longevity = longevityFromWear(fighter.wear);
}

/** Wear produced by one completed fight, derived from the actual damage taken. */
export function wearFromFight(fighter: Fighter, result: FightResult, save: SaveGame): WearDelta {
  const isA = result.fighterAId === fighter.id;
  const damage = isA ? result.finalDamageA : result.finalDamageB;
  const opponentDamage = isA ? result.finalDamageB : result.finalDamageA;
  const lost = result.loserId === fighter.id;
  const L = C.longevity;
  const diff = DIFFICULTY[save.settings.difficulty];
  const isPlayer = save.player.fighterId === fighter.id;
  const scale = isPlayer ? diff.longevityScale : 1;

  const knockdowns = isA ? result.totalsB.knockdowns : result.totalsA.knockdowns;
  const koLoss = lost && (result.method === 'ko' || result.method === 'tko-strikes' || result.method === 'tko-ground-strikes');

  return {
    neurological: (damage.head * L.perHeadDamage + knockdowns * L.perKnockdown + (koLoss ? L.perKoLoss : 0)) * scale,
    facial: (damage.cut * L.perCut * 0.4 + damage.swelling * 0.01) * scale,
    joint: (damage.joint * L.perJointDamage + (isA ? result.totalsB.takedownsLanded : result.totalsA.takedownsLanded) * 0.06) * scale,
    body: (damage.body * L.perBodyDamage + (damage.legLeft + damage.legRight) * L.perLegDamage) * scale,
    recovery: ((result.scheduledRounds === 5 ? L.perChampionshipRound * result.endRound : 0) + result.endRound * 0.12) * scale,
    weightCut: 0,
  };
  void opponentDamage;
}

/** Weekly rest recovery. Neurological wear is mostly permanent by design. */
export function restRecovery(fighter: Fighter, weeks: number): void {
  const L = C.longevity;
  const perm = L.permanentFraction;
  const rate = L.restRecoveryPerWeek * weeks;
  fighter.wear.recovery = clamp(fighter.wear.recovery - rate * 1.4, 0, 100);
  fighter.wear.body = clamp(fighter.wear.body - rate * 1.1, 0, 100);
  fighter.wear.facial = clamp(fighter.wear.facial - rate * 1.3, 0, 100);
  fighter.wear.joint = clamp(fighter.wear.joint - rate * 0.5, 0, 100);
  fighter.wear.weightCut = clamp(fighter.wear.weightCut - rate * 0.9, 0, 100);
  fighter.wear.neurological = clamp(fighter.wear.neurological - rate * (1 - perm), 0, 100);
  fighter.longevity = longevityFromWear(fighter.wear);
}

// ---------------------------------------------------------------------------
// Injuries
// ---------------------------------------------------------------------------

interface InjuryTemplate {
  type: string;
  area: Injury['area'];
  severity: Injury['severity'];
  weeksMin: number;
  weeksMax: number;
  trainingCapacity: number;
  blocksCompetition: boolean;
  recurrence: number;
  wear: WearDelta;
}

const INJURY_TABLE: InjuryTemplate[] = [
  { type: 'Hand fracture', area: 'hand', severity: 4, weeksMin: 8, weeksMax: 16, trainingCapacity: 0.45, blocksCompetition: true, recurrence: 0.22, wear: { joint: 5 } },
  { type: 'Broken orbital bone', area: 'face', severity: 4, weeksMin: 8, weeksMax: 14, trainingCapacity: 0.4, blocksCompetition: true, recurrence: 0.18, wear: { facial: 9 } },
  { type: 'Torn knee ligament', area: 'knee', severity: 5, weeksMin: 22, weeksMax: 44, trainingCapacity: 0.2, blocksCompetition: true, recurrence: 0.28, wear: { joint: 14 } },
  { type: 'Knee sprain', area: 'knee', severity: 2, weeksMin: 3, weeksMax: 7, trainingCapacity: 0.6, blocksCompetition: false, recurrence: 0.24, wear: { joint: 4 } },
  { type: 'Shoulder labrum tear', area: 'shoulder', severity: 4, weeksMin: 16, weeksMax: 30, trainingCapacity: 0.35, blocksCompetition: true, recurrence: 0.26, wear: { joint: 10 } },
  { type: 'Shoulder strain', area: 'shoulder', severity: 2, weeksMin: 3, weeksMax: 6, trainingCapacity: 0.65, blocksCompetition: false, recurrence: 0.2, wear: { joint: 3 } },
  { type: 'Rib injury', area: 'ribs', severity: 3, weeksMin: 5, weeksMax: 10, trainingCapacity: 0.5, blocksCompetition: true, recurrence: 0.16, wear: { body: 6 } },
  { type: 'Back strain', area: 'back', severity: 3, weeksMin: 4, weeksMax: 9, trainingCapacity: 0.55, blocksCompetition: false, recurrence: 0.3, wear: { joint: 5 } },
  { type: 'Ankle sprain', area: 'ankle', severity: 2, weeksMin: 2, weeksMax: 6, trainingCapacity: 0.6, blocksCompetition: false, recurrence: 0.25, wear: { joint: 3 } },
  { type: 'Foot fracture', area: 'foot', severity: 3, weeksMin: 6, weeksMax: 12, trainingCapacity: 0.45, blocksCompetition: true, recurrence: 0.15, wear: { joint: 5 } },
  { type: 'Elbow hyperextension', area: 'elbow', severity: 3, weeksMin: 5, weeksMax: 11, trainingCapacity: 0.5, blocksCompetition: true, recurrence: 0.22, wear: { joint: 7 } },
  { type: 'Neck strain', area: 'neck', severity: 3, weeksMin: 4, weeksMax: 8, trainingCapacity: 0.5, blocksCompetition: false, recurrence: 0.24, wear: { neurological: 3, joint: 4 } },
  { type: 'Concussion protocol', area: 'head', severity: 4, weeksMin: 6, weeksMax: 14, trainingCapacity: 0.25, blocksCompetition: true, recurrence: 0.3, wear: { neurological: 12 } },
  { type: 'Deep laceration', area: 'face', severity: 2, weeksMin: 2, weeksMax: 5, trainingCapacity: 0.75, blocksCompetition: false, recurrence: 0.2, wear: { facial: 5 } },
  { type: 'Hip flexor strain', area: 'hip', severity: 2, weeksMin: 3, weeksMax: 6, trainingCapacity: 0.6, blocksCompetition: false, recurrence: 0.22, wear: { joint: 3 } },
];

export function createInjury(
  template: InjuryTemplate,
  cause: Injury['cause'],
  on: IsoDate,
  rng: Rng,
  severityScale = 1
): Injury {
  const weeks = Math.round(rng.range(template.weeksMin, template.weeksMax) * severityScale);
  const effects: Injury['effects'] = {};
  switch (template.area) {
    case 'knee':
    case 'ankle':
    case 'foot':
    case 'hip':
      effects.wrestling = -template.severity * 1.8;
      effects.cardio = -template.severity * 0.8;
      break;
    case 'shoulder':
    case 'elbow':
    case 'hand':
      effects.striking = -template.severity * 2.0;
      effects.grappling = -template.severity * 0.9;
      break;
    case 'back':
    case 'ribs':
      effects.cardio = -template.severity * 1.4;
      effects.wrestling = -template.severity * 1.1;
      break;
    case 'head':
    case 'neck':
      effects.durability = -template.severity * 2.2;
      break;
    default:
      effects.durability = -template.severity * 0.8;
  }
  return {
    id: `inj-${on}-${template.area}-${Math.floor(rng.next() * 1e6)}`,
    type: template.type,
    area: template.area,
    severity: template.severity,
    startedAt: on,
    expectedReturn: addDays(on, weeks * 7),
    actualReturn: null,
    cause,
    trainingCapacity: template.trainingCapacity,
    effects,
    blocksCompetition: template.blocksCompetition,
    recurrenceChance: template.recurrence,
    treatment: 'rest',
    note: `${template.type}. Expected recovery about ${weeks} weeks.`,
  };
}

export interface InjuryRiskContext {
  /** Training intensity for the week, 0 to 1. */
  intensity: number;
  /** Hard sparring tendency of the gym, 0 to 100. */
  hardSparring: number;
  /** Gym safety, 0 to 100. */
  safety: number;
  /** Cause to record if an injury occurs. */
  cause: Injury['cause'];
  /** Difficulty scaling. */
  difficultyScale: number;
}

export function rollTrainingInjury(fighter: Fighter, ctx: InjuryRiskContext, on: IsoDate, rng: Rng): Injury | null {
  const age = ageOn(fighter.birthDate, on) ?? fighter.ageAtSnapshot ?? 28;
  const longevityRisk = 1 + (1 - fighter.longevity / 100) * 1.5;
  const ageRisk = 1 + clamp((age - 30) / 22, 0, 0.7);
  const sparringRisk = 0.6 + (ctx.hardSparring / 100) * 1.1;
  const safetyFactor = 1.35 - (ctx.safety / 100) * 0.7;
  const recurring = fighter.injuries.some((i) => i.actualReturn !== null && i.recurrenceChance > 0.24) ? 1.2 : 1;

  const base = 0.0075 * ctx.intensity * longevityRisk * ageRisk * sparringRisk * safetyFactor * recurring * ctx.difficultyScale;
  if (!rng.chance(clamp(base, 0, 0.12))) return null;

  // A previously injured area is the most likely to go again.
  const past = fighter.injuries.filter((i) => rng.chance(i.recurrenceChance));
  if (past.length > 0) {
    const tmpl = INJURY_TABLE.find((t) => t.area === rng.pick(past).area);
    if (tmpl) return createInjury(tmpl, ctx.cause, on, rng, 0.85);
  }
  const weighted = rng.weighted(INJURY_TABLE, (t) => 6 - t.severity);
  return createInjury(weighted, ctx.cause, on, rng);
}

/** Injuries produced by a fight, derived from the damage actually taken. */
export function injuriesFromFight(fighter: Fighter, result: FightResult, rng: Rng): Injury[] {
  const isA = result.fighterAId === fighter.id;
  const damage = isA ? result.finalDamageA : result.finalDamageB;
  const out: Injury[] = [];

  if (damage.cut > 40 && rng.chance(clamp(damage.cut / 200, 0, 0.6))) {
    out.push(createInjury(INJURY_TABLE.find((t) => t.type === 'Deep laceration')!, 'fight', result.date, rng));
  }
  if (damage.joint > 14 && rng.chance(clamp(damage.joint / 90, 0, 0.5))) {
    const tmpl = rng.pick(INJURY_TABLE.filter((t) => t.area === 'elbow' || t.area === 'knee' || t.area === 'shoulder'));
    out.push(createInjury(tmpl, 'fight', result.date, rng));
  }
  const koLoss = result.loserId === fighter.id && (result.method === 'ko' || result.method === 'tko-strikes' || result.method === 'tko-ground-strikes');
  if (koLoss && rng.chance(0.35)) {
    out.push(createInjury(INJURY_TABLE.find((t) => t.type === 'Concussion protocol')!, 'fight', result.date, rng));
  }
  if (damage.head > 70 && rng.chance(0.18)) {
    out.push(createInjury(INJURY_TABLE.find((t) => t.type === 'Broken orbital bone')!, 'fight', result.date, rng));
  }
  const strikesThrown = isA ? result.totalsA.totalStrikesAttempted : result.totalsB.totalStrikesAttempted;
  if (strikesThrown > 90 && rng.chance(0.07)) {
    out.push(createInjury(INJURY_TABLE.find((t) => t.type === 'Hand fracture')!, 'fight', result.date, rng));
  }
  return out;
}

/** Standard commission medical suspension following a bout. */
export function medicalSuspensionFor(fighter: Fighter, result: FightResult, rng: Rng): Fighter['medicalSuspension'] {
  const lost = result.loserId === fighter.id;
  const koLoss = lost && (result.method === 'ko' || result.method === 'tko-strikes' || result.method === 'tko-ground-strikes');
  const isA = result.fighterAId === fighter.id;
  const damage = isA ? result.finalDamageA : result.finalDamageB;

  let days = 7;
  let reason = 'Standard post fight rest period.';
  if (koLoss) {
    days = rng.int(45, 90);
    reason = 'Mandatory rest following a knockout loss.';
  } else if (damage.head > 60) {
    days = rng.int(30, 60);
    reason = 'Rest period following significant head trauma.';
  } else if (damage.cut > 45) {
    days = rng.int(21, 45);
    reason = 'Rest period for a facial laceration to heal.';
  } else if (result.endRound >= 4) {
    days = rng.int(14, 30);
    reason = 'Rest period following a long fight.';
  }
  return {
    until: addDays(result.date, days),
    reason,
    clearanceRequired: koLoss || damage.head > 60,
  };
}

export function activeInjuries(fighter: Fighter, on: IsoDate): Injury[] {
  return fighter.injuries.filter((i) => i.actualReturn === null && i.expectedReturn >= on);
}

export function canCompete(fighter: Fighter, on: IsoDate): { ok: boolean; reason: string | null } {
  if (fighter.retired) return { ok: false, reason: 'retired' };
  if (fighter.medicalSuspension && fighter.medicalSuspension.until > on) {
    return { ok: false, reason: `medically suspended until ${fighter.medicalSuspension.until}` };
  }
  const blocking = activeInjuries(fighter, on).filter((i) => i.blocksCompetition);
  if (blocking.length > 0) return { ok: false, reason: `injured: ${blocking[0].type}` };
  return { ok: true, reason: null };
}

export function trainingCapacityOf(fighter: Fighter, on: IsoDate): number {
  let cap = 1;
  for (const inj of activeInjuries(fighter, on)) cap = Math.min(cap, inj.trainingCapacity);
  return cap;
}

// ---------------------------------------------------------------------------
// Weight management
// ---------------------------------------------------------------------------

/**
 * How much weight this fighter can take off without the cut going badly. It falls with
 * age and accumulated cut stress, which is why veterans end up moving up in division.
 */
export function healthyCutFor(fighter: Fighter, age: number): number {
  const build = BUILDS[fighter.build] ?? BUILDS.balanced;
  return (
    28 *
    (1 - clamp((age - 31) / 30, 0, 0.28)) *
    (0.78 + (fighter.longevity / 100) * 0.3) *
    (1 - clamp(fighter.wear.weightCut / 260, 0, 0.22)) /
    build.cutDifficulty
  );
}

/**
 * Fighters manage their own walking weight. Someone who can no longer take twenty pounds
 * off safely does not keep trying and missing: they carry less between fights, and when
 * even that stops working they move up. Called once a week per fighter.
 */
/**
 * The heaviest a fighter can sensibly walk around at for their division: the divisional
 * norm, capped by what their own frame can still take off safely.
 *
 * This is the single definition. Fighter creation clamps to it and the weekly management
 * pass drifts toward it. They used to disagree, so newly created fighters started carrying
 * more than they could cut and missed weight far too often in their first months.
 */
export function sustainableWalkingWeight(fighter: Fighter, on: IsoDate): number {
  const division = DIVISION_BY_ID[fighter.divisionId];
  const age = ageOn(fighter.birthDate, on) ?? fighter.ageAtSnapshot ?? 28;
  const healthy = healthyCutFor(fighter, age);
  return division.limitLb + Math.min(division.typicalWalkAroundOverLb, healthy * 0.92);
}

/** Clamps a starting walking weight down to the sustainable figure. Never raises it. */
export function clampWalkingWeight(fighter: Fighter, on: IsoDate): void {
  fighter.walkingWeightLb = Math.min(fighter.walkingWeightLb, Math.round(sustainableWalkingWeight(fighter, on) * 2) / 2);
}

export function manageWalkingWeight(fighter: Fighter, on: IsoDate): { movedUp: DivisionId | null } {
  const division = DIVISION_BY_ID[fighter.divisionId];
  const age = ageOn(fighter.birthDate, on) ?? fighter.ageAtSnapshot ?? 28;
  const healthy = healthyCutFor(fighter, age);
  const targetOver = Math.min(division.typicalWalkAroundOverLb, healthy * 0.92);
  const targetWalking = division.limitLb + targetOver;
  // Weight is carried, not switched. It drifts toward the sustainable figure.
  fighter.walkingWeightLb = fighter.walkingWeightLb + (targetWalking - fighter.walkingWeightLb) * 0.06;

  // When the frame no longer fits the division at all, move up.
  const minimumViableOver = 4;
  if (targetOver < minimumViableOver || fighter.weightMisses >= 3) {
    const heavier = DIVISIONS.find((d) => d.order === division.order + 1);
    if (heavier) {
      fighter.divisionId = heavier.id;
      if (!fighter.eligibleDivisions.includes(heavier.id)) fighter.eligibleDivisions.push(heavier.id);
      fighter.walkingWeightLb = heavier.limitLb + Math.min(heavier.typicalWalkAroundOverLb, healthy * 0.9);
      fighter.weightMisses = 0;
      fighter.ranking = null;
      return { movedUp: heavier.id };
    }
  }
  return { movedUp: null };
}

export type WeightCutOutcome =
  | 'comfortable'
  | 'difficult'
  | 'severe'
  | 'missed-small'
  | 'missed-badly'
  | 'pulled-out';

export interface WeightCutResult {
  outcome: WeightCutOutcome;
  weightLb: number;
  madeWeight: boolean;
  /** 0 to 1. Feeds directly into the fight engine as a conditioning penalty. */
  cutQuality: number;
  wear: WearDelta;
  purseForfeitPct: number;
  headline: string;
  detail: string;
}

export interface WeightCutInput {
  divisionId: DivisionId;
  isTitleFight: boolean;
  campWeeks: number;
  /** 0 to 1 quality of nutrition support available. */
  nutritionSupport: number;
  shortNotice: boolean;
  /** Player instruction on how aggressively to cut, 0 to 1. */
  aggressiveness: number;
}

/**
 * Weight cutting model. There is no risk free maximum cut: pushing the cut harder buys
 * nothing except a higher chance of arriving depleted or missing weight entirely.
 */
export function simulateWeightCut(fighter: Fighter, input: WeightCutInput, on: IsoDate, rng: Rng): WeightCutResult {
  const division = DIVISION_BY_ID[input.divisionId];
  const limit = division.limitLb + (input.isTitleFight ? 0 : division.nonTitleAllowanceLb);
  const walking = fighter.walkingWeightLb;
  const cutLb = Math.max(0, walking - limit);

  const age = ageOn(fighter.birthDate, on) ?? fighter.ageAtSnapshot ?? 28;
  // A healthy cut for a professional at this level is a large number. The model is
  // calibrated so that a routine cut is routine and only genuine outliers miss weight,
  // which matches how often weight misses actually happen.
  const healthyCut = healthyCutFor(fighter, age);
  // healthyCutFor already accounts for build difficulty and accumulated cut wear. Applying
  // either of them again here squared them, which is what made hard cutting builds, and
  // busy champions who had taken years of cuts, miss weight several times too often. The
  // fighter's own weight management responds to healthyCutFor, so keeping both terms there
  // is also what lets them carry less rather than repeatedly failing.
  const strain =
    (cutLb / Math.max(6, healthyCut)) *
    (input.shortNotice ? 1.35 : 1) *
    (1 + clamp(0.55 - input.nutritionSupport, 0, 0.55)) *
    (1 + clamp((6 - input.campWeeks) / 12, 0, 0.5)) *
    (0.85 + input.aggressiveness * 0.35);

  const roll = rng.normal(strain, 0.2);
  let outcome: WeightCutOutcome;
  let over = 0;

  if (roll < 0.95) outcome = 'comfortable';
  else if (roll < 1.15) outcome = 'difficult';
  else if (roll < 1.38) outcome = 'severe';
  else if (roll < 1.62) {
    outcome = 'missed-small';
    over = Math.round(rng.range(0.5, 2) * 2) / 2;
  } else if (roll < 1.9) {
    outcome = 'missed-badly';
    over = Math.round(rng.range(2.5, 7) * 2) / 2;
  } else {
    outcome = 'pulled-out';
    over = Math.round(rng.range(4, 12) * 2) / 2;
  }

  // Repeated misses make the next cut worse, not better.
  if (fighter.weightMisses >= 2 && outcome === 'comfortable' && rng.chance(0.3)) outcome = 'difficult';

  const cutQuality =
    outcome === 'comfortable'
      ? clamp(rng.range(0.85, 1), 0, 1)
      : outcome === 'difficult'
        ? clamp(rng.range(0.62, 0.84), 0, 1)
        : outcome === 'severe'
          ? clamp(rng.range(0.38, 0.6), 0, 1)
          : outcome === 'missed-small'
            ? clamp(rng.range(0.3, 0.5), 0, 1)
            : clamp(rng.range(0.15, 0.34), 0, 1);

  const wear: WearDelta = {
    weightCut: outcome === 'comfortable' ? 0.4 : outcome === 'difficult' ? 1.1 : outcome === 'severe' ? C.longevity.perSevereCut : C.longevity.perSevereCut * 1.5,
    recovery: outcome === 'severe' || outcome.startsWith('missed') ? 1.2 : 0.3,
  };

  const headlines: Record<WeightCutOutcome, string> = {
    comfortable: 'Made weight comfortably',
    difficult: 'Difficult cut',
    severe: 'Severe cut',
    'missed-small': `Missed weight by ${over} lb`,
    'missed-badly': `Missed weight badly by ${over} lb`,
    'pulled-out': 'Could not complete the cut',
  };
  const details: Record<WeightCutOutcome, string> = {
    comfortable: 'Weight came off on schedule and rehydration went well.',
    difficult: 'The last few pounds were a grind. Expect to feel it in the later rounds.',
    severe: 'A rough cut. Conditioning and durability will both be down on the night.',
    'missed-small': 'The bout goes ahead at catchweight with a purse forfeit.',
    'missed-badly': 'A large miss. The bout is at catchweight, the purse takes a heavy hit, and any title is not on the line.',
    'pulled-out': 'The cut could not be completed safely and the bout is off.',
  };

  return {
    outcome,
    weightLb: limit + over,
    madeWeight: over === 0,
    cutQuality,
    wear,
    purseForfeitPct: outcome === 'missed-small' ? 20 : outcome === 'missed-badly' ? 30 : 0,
    headline: headlines[outcome],
    detail: details[outcome],
  };
}

/** Plain language health report shown on the fighter page. No graphic detail. */
export function healthReport(fighter: Fighter): { label: string; value: number; note: string }[] {
  const band = (v: number) => (v < 18 ? 'minimal' : v < 38 ? 'noticeable' : v < 58 ? 'significant' : v < 78 ? 'heavy' : 'severe');
  return [
    { label: 'Head and neurological', value: Math.round(fighter.wear.neurological), note: `${band(fighter.wear.neurological)} accumulated wear` },
    { label: 'Facial and cuts', value: Math.round(fighter.wear.facial), note: `${band(fighter.wear.facial)} scar tissue` },
    { label: 'Joints', value: Math.round(fighter.wear.joint), note: `${band(fighter.wear.joint)} joint wear` },
    { label: 'Body', value: Math.round(fighter.wear.body), note: `${band(fighter.wear.body)} body wear` },
    { label: 'Weight cutting', value: Math.round(fighter.wear.weightCut), note: `${band(fighter.wear.weightCut)} cumulative cut stress` },
    { label: 'Recovery capacity', value: Math.round(fighter.wear.recovery), note: `${band(fighter.wear.recovery)} loss of recovery speed` },
  ];
}
