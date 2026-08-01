import { BUILDS } from '../config/builds';
import { clamp, percentile, Rng } from '../rng';
import { addDays, ageOn, type IsoDate } from '../types/common';
import { ovrDisplayed, ovrRaw, RATING_KEYS, type Fighter, type RatingKey, type Ratings } from '../types/fighter';

/**
 * Aging and development.
 *
 * Development is weekly and driven by training input, individual profile, age, wear and
 * competition. Pot is never a force that pulls ratings upward: it is a projection
 * produced by running this same model forward many times.
 */

interface AgeCurve {
  /** Age at which this rating stops improving from age alone. */
  peak: number;
  /** How steeply this rating falls after the peak. */
  decline: number;
  /** How much of this rating is technique that survives athletic decline. */
  technical: number;
}

/**
 * Rating specific curves. Technique heavy ratings keep improving later and fall slower.
 * Explosive ratings peak earlier and fall faster.
 */
const AGE_CURVES: Record<RatingKey, AgeCurve> = {
  striking: { peak: 31, decline: 0.55, technical: 0.7 },
  grappling: { peak: 32, decline: 0.45, technical: 0.8 },
  wrestling: { peak: 28, decline: 0.95, technical: 0.45 },
  submissions: { peak: 33, decline: 0.35, technical: 0.9 },
  cardio: { peak: 28, decline: 0.9, technical: 0.25 },
  durability: { peak: 26, decline: 1.15, technical: 0.15 },
};

/** Base weekly rating movement at full training input and unlimited room. */
const BASE_WEEKLY_GAIN = 0.075;

/** Base weekly decline at one year past the curve peak. */
const BASE_WEEKLY_DECLINE = 0.016;

export interface DevelopmentInput {
  /** Training quality for this week, 0 to 1. Zero means no training at all. */
  trainingQuality: number;
  /** How the week's work was split across the six areas. Values sum to one. */
  focus: Record<RatingKey, number>;
  /** Coaching quality available, 0 to 100. */
  coaching: number;
  /** Training partner quality by area, 0 to 100. */
  partners: Record<RatingKey, number>;
  /** Competitive activity in the last year, 0 to 1. Inactivity costs sharpness. */
  activity: number;
  /** Current Longevity, 0 to 100. */
  longevity: number;
  /** Difficulty multiplier on all gains. */
  difficultyScale: number;
  /** Injury restriction, 0 to 1, where 1 is unrestricted. */
  trainingCapacity: number;
}

export function evenFocus(): Record<RatingKey, number> {
  const f = {} as Record<RatingKey, number>;
  for (const k of RATING_KEYS) f[k] = 1 / 6;
  return f;
}

function ageMultiplier(key: RatingKey, age: number, profile: Fighter['development']): number {
  const curve = AGE_CURVES[key];
  const peak = curve.peak + (profile.peakAge - 29.5);
  if (age <= peak) {
    // Growth capacity tapers as the peak approaches rather than stopping abruptly.
    return clamp(1 - Math.pow(clamp((age - 18) / Math.max(1, peak - 18), 0, 1), 2.1) * 0.6, 0.25, 1.1);
  }
  return 0;
}

function declineMultiplier(key: RatingKey, age: number, profile: Fighter['development'], build: string): number {
  const curve = AGE_CURVES[key];
  const peak = curve.peak + (profile.peakAge - 29.5);
  if (age <= peak) return 0;
  const yearsPast = age - peak;
  const buildAging = BUILDS[build as keyof typeof BUILDS]?.agingRate ?? 1;
  return yearsPast * curve.decline * profile.declineRate * buildAging;
}

/**
 * Advances training development. Returns the rating deltas rather than mutating, so
 * callers can log them into the fighter's rating history.
 *
 * The weeks parameter lets a projection walk a career in coarser steps. Deterministic
 * terms scale linearly with the number of weeks; the random term scales with the square
 * root, which is how the variance of a sum of independent weekly draws actually behaves.
 * A quarterly step therefore produces the same expected path and the same spread as
 * thirteen weekly steps, at a fraction of the cost.
 */
export function developWeek(
  fighter: Fighter,
  date: IsoDate,
  input: DevelopmentInput,
  rng: Rng,
  weeks = 1
): Partial<Record<RatingKey, number>> {
  const age = ageOn(fighter.birthDate, date) ?? fighter.ageAtSnapshot ?? 28;
  const profile = fighter.development;
  const deltas: Partial<Record<RatingKey, number>> = {};

  // Wear reduces the body's ability to convert work into improvement.
  const longevityFactor = clamp(0.45 + (input.longevity / 100) * 0.7, 0.3, 1.1);

  for (const key of RATING_KEYS) {
    const current = fighter.ratings[key];
    const room = clamp((profile.hiddenCeiling - current) / 22, -1, 1.25);
    const coachTerm = 0.45 + (input.coaching / 100) * 0.85;
    const partnerTerm = 0.5 + (input.partners[key] / 100) * 0.7;
    const focusTerm = input.focus[key] * 6;

    let delta = 0;

    if (room > 0) {
      delta +=
        weeks *
        BASE_WEEKLY_GAIN *
        input.trainingQuality *
        input.trainingCapacity *
        focusTerm *
        profile.affinity[key] *
        profile.coachability *
        profile.growthRate *
        coachTerm *
        partnerTerm *
        ageMultiplier(key, age, profile) *
        room *
        longevityFactor *
        input.difficultyScale;
    }

    const decline = declineMultiplier(key, age, profile, fighter.build);
    if (decline > 0) {
      const curve = AGE_CURVES[key];
      // Technique holds up. Athletic qualities do not. Training slows decline, never
      // reverses it once the athletic component is gone.
      const trainingOffset = 1 - input.trainingQuality * input.trainingCapacity * 0.4;
      delta -= weeks * BASE_WEEKLY_DECLINE * decline * (1 - curve.technical * 0.55) * trainingOffset;
    }

    // Inactivity costs sharpness in the areas that need live repetition most.
    if (input.activity < 0.5) {
      delta -= weeks * (0.5 - input.activity) * 0.012 * (1 - AGE_CURVES[key].technical * 0.6);
    }

    // Accumulated damage pulls Durability and Cardio down independently of age.
    if (key === 'durability') delta -= weeks * (1 - input.longevity / 100) * 0.02;
    if (key === 'cardio') delta -= weeks * (1 - input.longevity / 100) * 0.012;

    delta += rng.normal(0, 0.03 * Math.sqrt(weeks));

    if (Math.abs(delta) > 0.0005) deltas[key] = delta;
  }

  return deltas;
}

export function applyDeltas(ratings: Ratings, deltas: Partial<Record<RatingKey, number>>): Ratings {
  const out = { ...ratings };
  for (const k of RATING_KEYS) {
    const d = deltas[k];
    if (d) out[k] = clamp(out[k] + d, 8, 99);
  }
  return out;
}

/**
 * Records a new career high in Ovr, if this is one.
 *
 * Called from every path that changes ratings. The peak used to be sampled only on fight nights,
 * so a fighter who improved in camp and then declined never had that improvement recorded, and
 * the figure the fighter page calls a career peak could sit below where the fighter stood at the
 * moment it was read.
 */
export function notePeakOvr(fighter: Fighter, date: IsoDate): void {
  const now = ovrDisplayed(fighter.ratings);
  if (now > fighter.peakOvr) {
    fighter.peakOvr = now;
    fighter.peakOvrDate = date;
  }
}

/**
 * Pot estimation.
 *
 * Runs the development model forward many times with independent random variation and
 * returns an optimistic percentile of the projected peak Ovr. Pot is therefore an
 * estimate produced by the same model that drives actual development, not a separate
 * hidden number that development chases.
 *
 * A fighter can fail to reach Pot, and can exceed it when the projection was pessimistic.
 */
export interface PotProjectionOptions {
  /** Weeks advanced per projection step. Larger is faster and slightly coarser. */
  stepWeeks?: number;
  /** Years of career to project. */
  horizonYears?: number;
}

export function estimatePot(
  fighter: Fighter,
  date: IsoDate,
  paths: number,
  pctile: number,
  rng: Rng,
  opts: PotProjectionOptions = {}
): number {
  const age = ageOn(fighter.birthDate, date) ?? fighter.ageAtSnapshot ?? 28;
  const currentOvr = ovrRaw(fighter.ratings);
  const peaks: number[] = [];
  const focus = evenFocus();

  for (let p = 0; p < paths; p++) {
    // Each path draws its own plausible training environment and individual variation.
    const pathProfile: Fighter['development'] = {
      ...fighter.development,
      growthRate: clamp(fighter.development.growthRate * (0.75 + rng.next() * 0.55), 0.3, 2),
      declineRate: clamp(fighter.development.declineRate * (0.8 + rng.next() * 0.45), 0.3, 2),
      hiddenCeiling: clamp(fighter.development.hiddenCeiling + rng.normal(0, 3.5), currentOvr - 4, 99),
    };
    const simFighter: Fighter = { ...fighter, development: pathProfile, ratings: { ...fighter.ratings } };
    const input: DevelopmentInput = {
      trainingQuality: clamp(0.6 + rng.next() * 0.4, 0, 1),
      focus,
      coaching: clamp(rng.normal(66, 12), 20, 96),
      partners: {
        striking: 66,
        grappling: 66,
        wrestling: 66,
        submissions: 66,
        cardio: 66,
        durability: 66,
      },
      activity: clamp(0.5 + rng.next() * 0.5, 0, 1),
      longevity: fighter.longevity,
      difficultyScale: 1,
      trainingCapacity: 1,
    };

    let peak = currentOvr;
    let simAge = age;
    // Twelve years forward is enough to cover any realistic career arc.
    const stepWeeks = Math.max(1, opts.stepWeeks ?? 4);
    const horizonYears = opts.horizonYears ?? 12;
    const steps = Math.ceil((52 * horizonYears) / stepWeeks);
    for (let step = 0; step < steps && simAge < 42; step++) {
      // Projected forward from the real date. It used to walk a fabricated calendar starting in
      // the year 2000, and `developWeek` derives age from the birth date whenever there is one,
      // so every real fighter was projected as a child: growth ran at its maximum and the aging
      // decline never applied at all. The snapshot age is still updated for the generated
      // fighters who have no birth date and fall back to it.
      const simDate = addDays(date, step * stepWeeks * 7);
      simFighter.ageAtSnapshot = Math.floor(simAge);
      const deltas = developWeek(simFighter, simDate, input, rng, stepWeeks);
      simFighter.ratings = applyDeltas(simFighter.ratings, deltas);
      const ovr = ovrRaw(simFighter.ratings);
      if (ovr > peak) peak = ovr;
      simAge += stepWeeks / 52;
      // Wear accumulates slowly across a projected career.
      input.longevity = clamp(input.longevity - 0.035 * stepWeeks, 10, 100);
    }
    peaks.push(peak);
  }

  peaks.sort((a, b) => a - b);
  return clamp(Math.round(percentile(peaks, pctile)), Math.round(currentOvr), 99);
}

/** Confidence in a Pot estimate falls with how far the projection has to reach. */
export function potConfidenceFor(fighter: Fighter, date: IsoDate): Fighter['potConfidence'] {
  const age = ageOn(fighter.birthDate, date) ?? fighter.ageAtSnapshot ?? 28;
  const fights = fighter.ufcRecord.wins + fighter.ufcRecord.losses + fighter.ufcRecord.draws;
  if (age >= 33) return 'high';
  if (age >= 30 && fights >= 6) return 'high';
  if (age >= 28) return 'medium';
  if (fights >= 8) return 'medium';
  if (fights >= 3) return 'low';
  return 'very-low';
}

/**
 * Retirement model. Considers age, Longevity, recent results, ranking and finances. There
 * is no forced retirement age; a fighter with the health and the results can continue.
 */
export function retirementChance(fighter: Fighter, date: IsoDate): number {
  const age = ageOn(fighter.birthDate, date) ?? fighter.ageAtSnapshot ?? 28;
  if (age < 27) return 0;
  let p = 0;
  p += Math.pow(clamp((age - 30) / 12, 0, 1), 2) * 0.22;
  p += clamp((45 - fighter.longevity) / 45, 0, 1) * 0.2;
  p += clamp(fighter.lossStreak - 1, 0, 4) * 0.045;
  if (fighter.isChampion) p *= 0.25;
  if (fighter.ranking !== null && fighter.ranking <= 5) p *= 0.45;
  if (fighter.ranking === null) p *= 1.5;
  if (fighter.morale < 30) p *= 1.35;
  return clamp(p, 0, 0.6);
}

/** Snapshot of the six ratings for the fighter's rating history. */
export function ratingSnapshotFor(fighter: Fighter, date: IsoDate, reason: string) {
  return {
    date,
    ratings: { ...fighter.ratings },
    ovr: Math.round(ovrRaw(fighter.ratings)),
    pot: fighter.pot,
    longevity: fighter.longevity,
    reason,
  };
}
