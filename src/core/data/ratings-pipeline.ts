import { DIVISION_BY_ID, type DivisionConfig, type DivisionId } from '../config/divisions';
import { clamp, remap } from '../rng';
import type { Confidence } from '../types/common';
import { RATING_KEYS, type RatingConfidence, type Ratings } from '../types/fighter';

/**
 * Rating derivation.
 *
 * The pipeline is transparent and reproducible: given the same sourced record and the
 * same configuration it always produces the same six ratings, and it reports which
 * evidence drove each one.
 *
 * Two independent channels of evidence are combined:
 *
 *   1. Performance channel. Per minute and per fifteen minute rate statistics from the
 *      official athlete profile, normalized against the division prior, shrunk toward
 *      that prior by sample size, and mapped through a bounded function.
 *
 *   2. Results channel. Official ranking and championship status. A ranking is the
 *      accumulated verdict on who a fighter has beaten, which is exactly the opponent
 *      quality information the rate statistics do not carry. The compliant source does
 *      not expose bout by bout opponent data, so ranking is used as the opponent
 *      adjustment proxy and is documented as such.
 *
 * Neither channel alone is trusted. A fighter with one spectacular statistical outlier
 * and no ranking does not become elite, and a highly ranked fighter with poor underlying
 * numbers does not stay untouched.
 */

export interface SourcedAthleteStats {
  slug: string;
  divisionId: DivisionId;
  rank: number | null;
  isChampion: boolean;
  isInterimChampion: boolean;
  pfpRank: number | null;
  age: number | null;
  heightIn: number | null;
  reachIn: number | null;
  record: { w: number; l: number; d: number } | null;
  winsByKo: number | null;
  winsBySub: number | null;
  winStreak: number | null;
  lossStreak: number | null;
  sigStrLandedPerMin: number | null;
  sigStrAbsorbedPerMin: number | null;
  sigStrDefensePct: number | null;
  takedownAvgPer15: number | null;
  takedownDefensePct: number | null;
  submissionAvgPer15: number | null;
  knockdownAvgPer15: number | null;
  avgFightTimeSeconds: number | null;
  sigStrLanded: number | null;
  sigStrAttempted: number | null;
  takedownsLanded: number | null;
  takedownsAttempted: number | null;
  strikeTarget: { headPct: number; bodyPct: number; legPct: number } | null;
  strikePosition: { standingPct: number; clinchPct: number; groundPct: number } | null;
  winMethod: { koPct: number; decPct: number; subPct: number } | null;
}

export interface RatingDerivation {
  ratings: Ratings;
  confidence: RatingConfidence;
  ovrConfidence: Confidence;
  /** Estimated cumulative UFC cage minutes, the sample size for the performance channel. */
  cageMinutes: number | null;
  estimatedUfcFights: number | null;
  /** Human readable evidence trail per rating, shown in the fighter data panel. */
  notes: Record<keyof Ratings, string[]>;
  missing: string[];
}

/** Shrinkage weight in cage minutes. Roughly three full fights of evidence. */
const PRIOR_MINUTES = 26;

/** Scale from a normalized z score to rating points. */
const Z_TO_POINTS = 9.0;

function z(value: number | null, mean: number, sd: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (sd <= 0) return 0;
  return (value - mean) / sd;
}

/**
 * Empirical Bayes shrinkage toward the division prior. A fighter with two fights of
 * evidence sits close to the division mean no matter how extreme the raw numbers are.
 */
function shrink(observedZ: number | null, minutes: number | null): number {
  if (observedZ === null) return 0;
  const n = minutes ?? 0;
  const weight = n / (n + PRIOR_MINUTES);
  return observedZ * weight;
}

/** Blends a set of weighted z scores, ignoring the ones with no evidence. */
function blend(parts: { z: number | null; w: number; note?: string }[], notes: string[]): number {
  let sum = 0;
  let weight = 0;
  for (const p of parts) {
    if (p.z === null) continue;
    sum += p.z * p.w;
    weight += p.w;
    if (p.note && Math.abs(p.z) > 0.6) {
      notes.push(`${p.note} ${p.z > 0 ? 'above' : 'below'} division norm`);
    }
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * The results channel. Converts official standing into an expected Ovr level. These
 * anchors define how good a ranked UFC fighter is on the 0 to 100 scale and are the main
 * lever for keeping the scale honest against the interpretation bands.
 */
export function rankPrior(rank: number | null, isChampion: boolean, isInterim: boolean, pfpRank: number | null): number {
  let base: number;
  if (isChampion) base = 86.5;
  else if (isInterim) base = 84.5;
  else if (rank === null) base = 66;
  else base = remap(rank, 1, 15, 83.5, 74.5);

  if (pfpRank !== null) {
    // Pound for pound standing is cross division evidence of exceptional quality.
    base = Math.max(base, remap(pfpRank, 1, 15, 89.5, 82));
  }
  return base;
}

function confidenceFromMinutes(minutes: number | null): Confidence {
  if (minutes === null) return 'very-low';
  if (minutes >= 140) return 'very-high';
  if (minutes >= 80) return 'high';
  if (minutes >= 40) return 'medium';
  if (minutes >= 15) return 'low';
  return 'very-low';
}

function pctToFraction(v: number | null): number | null {
  if (v === null) return null;
  return v > 1 ? v / 100 : v;
}

export function deriveRatings(s: SourcedAthleteStats): RatingDerivation {
  const division: DivisionConfig = DIVISION_BY_ID[s.divisionId];
  const p = division.priors;
  const notes: Record<keyof Ratings, string[]> = {
    striking: [],
    grappling: [],
    wrestling: [],
    submissions: [],
    cardio: [],
    durability: [],
  };
  const missing: string[] = [];

  // Sample size. Cumulative cage minutes are recoverable from the landed total and the
  // per minute rate, which is far better evidence than a raw fight count.
  let cageMinutes: number | null = null;
  if (s.sigStrLanded !== null && s.sigStrLandedPerMin !== null && s.sigStrLandedPerMin > 0.05) {
    cageMinutes = s.sigStrLanded / s.sigStrLandedPerMin;
  }
  const avgMin = s.avgFightTimeSeconds !== null ? s.avgFightTimeSeconds / 60 : null;
  const estimatedUfcFights = cageMinutes !== null && avgMin !== null && avgMin > 0.5 ? cageMinutes / avgMin : null;

  for (const [k, v] of Object.entries({
    sigStrLandedPerMin: s.sigStrLandedPerMin,
    sigStrAbsorbedPerMin: s.sigStrAbsorbedPerMin,
    sigStrDefensePct: s.sigStrDefensePct,
    takedownAvgPer15: s.takedownAvgPer15,
    takedownDefensePct: s.takedownDefensePct,
    submissionAvgPer15: s.submissionAvgPer15,
    knockdownAvgPer15: s.knockdownAvgPer15,
  })) {
    if (v === null) missing.push(k);
  }

  const strAcc = s.sigStrAttempted && s.sigStrAttempted > 0 && s.sigStrLanded !== null ? s.sigStrLanded / s.sigStrAttempted : null;
  const tdAcc = s.takedownsAttempted && s.takedownsAttempted > 0 && s.takedownsLanded !== null ? s.takedownsLanded / s.takedownsAttempted : null;
  const strDef = pctToFraction(s.sigStrDefensePct);
  const tdDef = pctToFraction(s.takedownDefensePct);

  // Raw normalized scores against the division prior.
  const zSlpm = z(s.sigStrLandedPerMin, p.slpm.mean, p.slpm.sd);
  const zSapm = z(s.sigStrAbsorbedPerMin, p.sapm.mean, p.sapm.sd);
  const zAcc = z(strAcc, p.strAcc.mean, p.strAcc.sd);
  const zDef = z(strDef, p.strDef.mean, p.strDef.sd);
  const zTdAvg = z(s.takedownAvgPer15, p.tdAvg.mean, p.tdAvg.sd);
  const zTdAcc = z(tdAcc, p.tdAcc.mean, p.tdAcc.sd);
  const zTdDef = z(tdDef, p.tdDef.mean, p.tdDef.sd);
  const zSub = z(s.submissionAvgPer15, p.subAvg.mean, p.subAvg.sd);
  const zKd = z(s.knockdownAvgPer15, p.kdAvg.mean, p.kdAvg.sd);

  const sh = (v: number | null) => shrink(v, cageMinutes);

  // ---- Striking -----------------------------------------------------------
  // Offense and defense together. Power is represented through knockdown rate rather
  // than as a separate visible rating.
  const strikingZ = blend(
    [
      { z: sh(zSlpm), w: 0.26, note: 'strike volume' },
      { z: sh(zAcc), w: 0.2, note: 'strike accuracy' },
      { z: sh(zDef), w: 0.22, note: 'strike defense' },
      { z: sh(zSapm) === 0 ? null : -sh(zSapm), w: 0.16, note: 'strikes absorbed' },
      { z: sh(zKd), w: 0.16, note: 'knockdown rate' },
    ],
    notes.striking
  );

  // ---- Wrestling ----------------------------------------------------------
  // Takedown volume is weighted lightly on purpose. A fighter who never shoots may still
  // be an excellent defensive wrestler, so defense carries the most weight here.
  const wrestlingZ = blend(
    [
      { z: sh(zTdAvg), w: 0.24, note: 'takedown volume' },
      { z: sh(zTdAcc), w: 0.24, note: 'takedown accuracy' },
      { z: sh(zTdDef), w: 0.42, note: 'takedown defense' },
      { z: sh(zSub) === 0 ? null : sh(zSub) * 0.3, w: 0.1 },
    ],
    notes.wrestling
  );

  // ---- Grappling ----------------------------------------------------------
  // Positional work is visible in where the strikes land. A high ground and clinch share
  // of significant strikes is the signature of a fighter who holds position.
  const groundShare = s.strikePosition ? s.strikePosition.groundPct / 100 : null;
  const clinchShare = s.strikePosition ? s.strikePosition.clinchPct / 100 : null;
  const zGroundShare = z(groundShare, 0.14, 0.11);
  const zClinchShare = z(clinchShare, 0.15, 0.09);
  if (s.strikePosition === null) missing.push('strikePosition');
  const grapplingZ = blend(
    [
      { z: sh(zGroundShare), w: 0.34, note: 'ground strike share' },
      { z: sh(zClinchShare), w: 0.2, note: 'clinch strike share' },
      { z: sh(zTdDef), w: 0.16, note: 'positional defense' },
      { z: sh(zSub), w: 0.16, note: 'submission threat' },
      { z: sh(zTdAcc), w: 0.14 },
    ],
    notes.grappling
  );

  // ---- Submissions --------------------------------------------------------
  // Offensive threat dominates, with the finish share as corroboration. Defensive
  // awareness enters through takedown and positional defense so that an elite grappler
  // is not treated as helpless when defending.
  const subWinShare = s.record && s.record.w > 0 && s.winsBySub !== null ? s.winsBySub / s.record.w : null;
  const zSubShare = z(subWinShare, 0.22, 0.17);
  const submissionsZ = blend(
    [
      { z: sh(zSub), w: 0.42, note: 'submission attempt rate' },
      { z: sh(zSubShare), w: 0.3, note: 'submission finish share' },
      { z: sh(zGroundShare), w: 0.14 },
      { z: sh(zTdDef), w: 0.14, note: 'grappling defense' },
    ],
    notes.submissions
  );

  // ---- Cardio -------------------------------------------------------------
  // Late round exposure is the evidence. A fighter who finishes early is not punished for
  // it, they are simply given lower confidence, which the shrinkage handles.
  const zFightTime = z(avgMin, 9.0, 3.0);
  const decShare = s.winMethod ? s.winMethod.decPct / 100 : null;
  const zDecShare = z(decShare, 0.42, 0.2);
  const ageForCardio = s.age ?? 29;
  const agePenalty = ageForCardio > 33 ? -(ageForCardio - 33) * 0.11 : 0;
  const cardioZ =
    blend(
      [
        { z: sh(zFightTime), w: 0.36, note: 'average fight time' },
        { z: sh(zDecShare), w: 0.24, note: 'decision share' },
        { z: sh(zSlpm), w: 0.24, note: 'sustained output' },
        { z: sh(zTdAvg), w: 0.16 },
      ],
      notes.cardio
    ) + agePenalty;
  if (agePenalty < -0.2) notes.cardio.push('age adjusted downward');

  // ---- Durability ---------------------------------------------------------
  // Absorbed volume, knockout losses and career mileage. A fighter who has never been
  // knocked out but has very little high level exposure does not get a free elite score,
  // because the shrinkage keeps a small sample near the division mean.
  const koLossShare = s.record && s.record.l > 0 && s.winMethod ? null : null;
  const lossCount = s.record?.l ?? 0;
  const zAbsorbed = sh(zSapm) === 0 ? null : -sh(zSapm);
  const zStrDefForDur = sh(zDef);
  const careerFights = s.record ? s.record.w + s.record.l + s.record.d : null;
  const mileagePenalty = careerFights !== null && careerFights > 24 ? -(careerFights - 24) * 0.03 : 0;
  const ageDurPenalty = ageForCardio > 34 ? -(ageForCardio - 34) * 0.1 : 0;
  const lossPenalty = lossCount > 4 ? -(lossCount - 4) * 0.07 : 0;
  const durabilityZ =
    blend(
      [
        { z: zAbsorbed, w: 0.4, note: 'strikes absorbed' },
        { z: zStrDefForDur, w: 0.3, note: 'defensive avoidance' },
        { z: sh(zTdDef), w: 0.14 },
        { z: sh(zKd) === 0 ? null : -sh(zKd) * 0.2, w: 0.16 },
      ],
      notes.durability
    ) +
    mileagePenalty +
    ageDurPenalty +
    lossPenalty;
  if (mileagePenalty < -0.2) notes.durability.push('long career mileage');
  if (ageDurPenalty < -0.2) notes.durability.push('age adjusted downward');
  void koLossShare;

  // ---- Combine the two channels ------------------------------------------
  const prior = rankPrior(s.rank, s.isChampion, s.isInterimChampion, s.pfpRank);
  const perf: Record<keyof Ratings, number> = {
    striking: strikingZ,
    grappling: grapplingZ,
    wrestling: wrestlingZ,
    submissions: submissionsZ,
    cardio: cardioZ,
    durability: durabilityZ,
  };

  // Recent form nudges the whole profile a little, since a long streak either way is
  // information the rate statistics smooth over.
  const streakAdj = clamp((s.winStreak ?? 0) * 0.26 - (s.lossStreak ?? 0) * 0.8, -2.6, 2.4);

  const ratings = {} as Ratings;
  for (const k of RATING_KEYS) {
    const value = prior + perf[k] * Z_TO_POINTS + streakAdj;
    ratings[k] = clamp(Math.round(value), 20, 98);
  }

  // The results channel constrains Ovr, but each individual rating is free to move well
  // away from it. This is what makes a one dimensional specialist look like one.
  const conf = confidenceFromMinutes(cageMinutes);
  const confidence: RatingConfidence = {
    striking: conf,
    grappling: s.strikePosition ? conf : downgrade(conf),
    wrestling: tdDef !== null ? conf : downgrade(conf),
    submissions: s.submissionAvgPer15 !== null ? conf : downgrade(conf),
    cardio: avgMin !== null ? conf : downgrade(conf),
    durability: s.sigStrAbsorbedPerMin !== null ? conf : downgrade(conf),
  };

  return {
    ratings,
    confidence,
    ovrConfidence: conf,
    cageMinutes,
    estimatedUfcFights,
    notes,
    missing,
  };
}

function downgrade(c: Confidence): Confidence {
  const order: Confidence[] = ['very-low', 'low', 'medium', 'high', 'very-high'];
  const i = order.indexOf(c);
  return order[Math.max(0, i - 1)];
}

/**
 * Derives behavioral tendencies from the same sourced statistics. Tendencies describe
 * what a fighter chooses to do, which is exactly what the target and position breakdowns
 * of their strikes reveal.
 */
export function deriveTendencies(s: SourcedAthleteStats, ratings: Ratings): Partial<Record<string, number>> {
  const out: Record<string, number> = {};
  const t = s.strikeTarget;
  const pos = s.strikePosition;
  if (t) {
    out.kicking = clamp(0.25 + (t.legPct / 100) * 2.6, 0.05, 1);
    out.bodyAttack = clamp(0.2 + (t.bodyPct / 100) * 2.2, 0.05, 1);
  }
  if (pos) {
    out.clinch = clamp(0.15 + (pos.clinchPct / 100) * 2.4, 0.05, 1);
    out.topControl = clamp(0.15 + (pos.groundPct / 100) * 2.2, 0.05, 1);
  }
  if (s.takedownAvgPer15 !== null) {
    out.takedownEntry = clamp(0.1 + s.takedownAvgPer15 / 6, 0.04, 1);
  }
  if (s.submissionAvgPer15 !== null) {
    out.submissionHunt = clamp(0.1 + s.submissionAvgPer15 / 3, 0.04, 1);
  }
  if (s.sigStrLandedPerMin !== null) {
    out.pace = clamp(0.15 + s.sigStrLandedPerMin / 9, 0.08, 1);
  }
  if (s.sigStrAbsorbedPerMin !== null && s.sigStrLandedPerMin !== null) {
    // A fighter who lands a lot and absorbs a lot fights in the pocket. A fighter who
    // lands a lot and absorbs little fights at range or counters.
    const ratio = s.sigStrAbsorbedPerMin / Math.max(0.4, s.sigStrLandedPerMin);
    out.pocket = clamp(0.2 + ratio * 0.7, 0.05, 1);
    out.range = clamp(1.05 - ratio * 0.7, 0.05, 1);
    out.counter = clamp(0.9 - ratio * 0.55, 0.05, 1);
  }
  if (s.knockdownAvgPer15 !== null) {
    out.finishSeeking = clamp(0.2 + s.knockdownAvgPer15 / 2.2, 0.05, 1);
  }
  out.chinTucking = clamp(0.3 + ratings.durability / 180, 0.05, 1);
  return out;
}

export const RATING_PIPELINE_VERSION = '1.0.0';
