import { CALIBRATION as C } from '../config/calibration';
import { clamp, Rng } from '../rng';
import type { JudgeScorecard, RoundStatLine } from '../types/fight';
import type { SaveSettings } from '../types/save';

export interface JudgePersona {
  name: string;
  /** Persistent lean toward striking or grappling. Small, never incompetence. */
  grapplingLean: number;
  damageLean: number;
  bias: number;
  /**
   * How readily this judge scores a round 10-8. 1 is the calibrated default, so a persona
   * without the field behaves exactly as before.
   */
  tenEightWillingness?: number;
}

const JUDGE_FIRST = [
  'D. Carter',
  'M. Beltran',
  'S. Okafor',
  'J. Rinaldi',
  'A. Novak',
  'T. Lindqvist',
  'R. Aoki',
  'P. Dufresne',
  'K. Whitaker',
  'L. Moreau',
  'C. Vasquez',
  'H. Nakamura',
  'B. Osei',
  'G. Petrov',
  'N. Haddad',
];

export function drawJudges(rng: Rng): JudgePersona[] {
  const names = rng.shuffle([...JUDGE_FIRST]).slice(0, 3);
  return names.map((name) => ({
    name,
    grapplingLean: rng.normalClamped(0, 0.16, -0.4, 0.4),
    damageLean: rng.normalClamped(0, 0.16, -0.4, 0.4),
    bias: rng.normal(0, C.judging.judgeBiasSd),
  }));
}

export interface RoundScoreInput {
  statsA: RoundStatLine;
  statsB: RoundStatLine;
  damageA: number;
  damageB: number;
  aggressionA: number;
  aggressionB: number;
  cageControlA: number;
  cageControlB: number;
}

/**
 * The true, unobserved merit of a round. Follows the criteria order of the unified rules:
 * effective striking and grappling first, aggression only when that is effectively even,
 * fighting area control only when the first two are effectively even.
 */
export function trueRoundScore(input: RoundScoreInput): number {
  const { statsA: a, statsB: b } = input;
  let primary = 0;
  primary += (a.sigStrikesLanded - b.sigStrikesLanded) * C.judging.strikeWeight;
  primary += (input.damageA - input.damageB) * C.judging.damageWeight * 0.1;
  primary += (a.knockdowns - b.knockdowns) * C.judging.knockdownWeight;
  primary += (a.takedownsLanded - b.takedownsLanded) * C.judging.takedownWeight;
  primary += (a.submissionAttempts - b.submissionAttempts) * C.judging.submissionAttemptWeight;
  primary += (a.controlSeconds - b.controlSeconds) * C.judging.controlWeight;

  if (Math.abs(primary) < C.judging.evenMargin) {
    primary += (input.aggressionA - input.aggressionB) * C.judging.aggressionWeight;
    if (Math.abs(primary) < C.judging.evenMargin) {
      primary += (input.cageControlA - input.cageControlB) * C.judging.cageControlWeight;
    }
  }
  return primary;
}

/**
 * How close to a finish the losing fighter came, on a 0 to 1 scale.
 *
 * A 10-8 is about impact, not about arithmetic. A fighter can land forty more strikes and
 * hold position for four minutes and still lose the round 10-9, because none of that hurt
 * anyone. Knockdowns, real damage and genuine submission danger are what separate a
 * dominant round from a scoring round.
 */
export function roundImpact(input: RoundScoreInput, aWins: boolean): number {
  const winner = aWins ? input.statsA : input.statsB;
  const loser = aWins ? input.statsB : input.statsA;
  // Damage figures are the damage each fighter took, so the loser's intake is what counts.
  const damageTaken = aWins ? input.damageB : input.damageA;
  const damageDealtBack = aWins ? input.damageA : input.damageB;

  const knockdowns = winner.knockdowns;
  const stuns = winner.stuns;
  const subs = winner.submissionAttempts;

  // Calibrated against the measured distribution: the round winner scores a knockdown in
  // about 21 percent of rounds and two or more in under 2 percent. One knockdown on its own
  // is therefore not a 10-8, or a fifth of all rounds would be scored wide.
  const knockdownImpact = knockdowns >= 3 ? 1 : knockdowns === 2 ? 0.86 : knockdowns === 1 ? 0.42 : 0;
  const stunImpact = Math.min(0.18, stuns * 0.06);
  const damageImpact = clamp01((damageTaken - damageDealtBack) / 70);
  const submissionImpact = Math.min(0.34, subs * 0.14);

  // Sustained one sided offense contributes only once it is genuinely lopsided. Measured
  // median share is 0.73 and the ninetieth percentile is 0.89, so nothing below that
  // should be pushing a round toward 10-8.
  const winnerOffense = winner.sigStrikesLanded + winner.takedownsLanded * 3 + winner.submissionAttempts * 2;
  const loserOffense = loser.sigStrikesLanded + loser.takedownsLanded * 3 + loser.submissionAttempts * 2;
  const share = winnerOffense + loserOffense > 8 ? winnerOffense / (winnerOffense + loserOffense) : 0.5;
  const dominanceImpact = clamp01((share - 0.86) / 0.12) * 0.32;

  return clamp01(knockdownImpact + stunImpact + damageImpact * 0.5 + submissionImpact + dominanceImpact);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Applies one judge's perception to the true merit and returns a 10 point must score.
 *
 * Two separate questions. Who won the round is the criteria comparison. Whether it was a
 * 10-8 is a question about impact, and it is deliberately hard to reach: the previous
 * version compared the raw criteria margin against fixed thresholds, and because that
 * margin is measured in landed strikes it crossed the 10-7 threshold in most rounds. Fifty
 * nine percent of all scored rounds were coming out 10-7.
 */
export function scoreRoundForJudge(
  judge: JudgePersona,
  input: RoundScoreInput,
  trueScore: number,
  rng: Rng,
  settings: SaveSettings
): { a: number; b: number } {
  const grapplingComponent =
    (input.statsA.takedownsLanded - input.statsB.takedownsLanded) * C.judging.takedownWeight +
    (input.statsA.controlSeconds - input.statsB.controlSeconds) * C.judging.controlWeight;
  const damageComponent = (input.damageA - input.damageB) * C.judging.damageWeight * 0.1;

  const perceived =
    trueScore +
    grapplingComponent * judge.grapplingLean +
    damageComponent * judge.damageLean +
    judge.bias +
    rng.normal(0, C.judging.judgeNoiseSd);

  const margin = Math.abs(perceived);
  const aWins = perceived > 0;

  if (settings.allowTenTen && margin < C.judging.evenMargin * 0.3) {
    return { a: 10, b: 10 };
  }

  // Impact decides the wide scores. A judge reads impact slightly differently from the
  // next judge, but they do not disagree about a knockdown.
  const impact = roundImpact(input, aWins);
  const perceivedImpact = impact + judge.damageLean * 0.06 + rng.normal(0, C.judging.impactNoiseSd);
  // A round has to be clearly won before it can be scored wide at all.
  const clearlyWon = margin >= C.judging.dominantMargin;

  let loserScore = 9;
  // A judge who is willing to score 10-8 needs slightly less impact to do it. The threshold
  // moves, the evidence required does not vanish.
  const tenEightThreshold = C.judging.tenEightImpact / clamp(judge.tenEightWillingness ?? 1, 0.55, 1.45);
  if (clearlyWon && perceivedImpact >= tenEightThreshold) loserScore = 8;
  // A 10-7 is meant to be extraordinary: the loser is nearly finished repeatedly and
  // contributes almost nothing. Three knockdowns is the gate, plus near total dominance of
  // the offense. Two knockdowns alone was still producing it in over two percent of rounds.
  const winnerStats = aWins ? input.statsA : input.statsB;
  const loserStats = aWins ? input.statsB : input.statsA;
  const winnerOffense = winnerStats.sigStrikesLanded + winnerStats.takedownsLanded * 3;
  const loserOffense = loserStats.sigStrikesLanded + loserStats.takedownsLanded * 3;
  const share = winnerOffense + loserOffense > 8 ? winnerOffense / (winnerOffense + loserOffense) : 0.5;
  if (
    settings.allowTenSeven &&
    loserScore === 8 &&
    perceivedImpact >= C.judging.tenSevenImpact &&
    winnerStats.knockdowns >= 3 &&
    share >= 0.95 &&
    margin >= C.judging.overwhelmingMargin
  ) {
    loserScore = 7;
  }

  return aWins ? { a: 10, b: loserScore } : { a: loserScore, b: 10 };
}

export interface DecisionOutcome {
  method: 'decision-unanimous' | 'decision-split' | 'decision-majority' | 'draw-unanimous' | 'draw-split' | 'draw-majority';
  winner: 'a' | 'b' | null;
  scorecards: JudgeScorecard[];
}

export function resolveDecision(
  judges: JudgePersona[],
  perRound: { a: number; b: number }[][],
  deductionsA: number,
  deductionsB: number
): DecisionOutcome {
  const scorecards: JudgeScorecard[] = judges.map((j, i) => {
    const rounds = perRound[i].map((r, idx) => ({ round: idx + 1, a: r.a, b: r.b }));
    const totalA = rounds.reduce((s, r) => s + r.a, 0) - deductionsA;
    const totalB = rounds.reduce((s, r) => s + r.b, 0) - deductionsB;
    return { judgeName: j.name, rounds, totalA, totalB };
  });

  let aCards = 0;
  let bCards = 0;
  let drawCards = 0;
  for (const card of scorecards) {
    if (card.totalA > card.totalB) aCards++;
    else if (card.totalB > card.totalA) bCards++;
    else drawCards++;
  }

  if (aCards === 3) return { method: 'decision-unanimous', winner: 'a', scorecards };
  if (bCards === 3) return { method: 'decision-unanimous', winner: 'b', scorecards };
  if (aCards === 2 && bCards === 1) return { method: 'decision-split', winner: 'a', scorecards };
  if (bCards === 2 && aCards === 1) return { method: 'decision-split', winner: 'b', scorecards };
  if (aCards === 2 && drawCards === 1) return { method: 'decision-majority', winner: 'a', scorecards };
  if (bCards === 2 && drawCards === 1) return { method: 'decision-majority', winner: 'b', scorecards };
  if (aCards === 1 && bCards === 1 && drawCards === 1) return { method: 'draw-split', winner: null, scorecards };
  if (drawCards === 3) return { method: 'draw-unanimous', winner: null, scorecards };
  if (drawCards === 2 && aCards === 1) return { method: 'draw-majority', winner: null, scorecards };
  if (drawCards === 2 && bCards === 1) return { method: 'draw-majority', winner: null, scorecards };
  return { method: 'draw-split', winner: null, scorecards };
}

/** Live unofficial estimate shown between rounds when exact scores are hidden. */
export function unofficialEstimate(trueScore: number): { label: string; confidence: string } {
  const m = Math.abs(trueScore);
  const leader = trueScore > 0 ? 'a' : 'b';
  if (m < C.judging.evenMargin) return { label: 'too close to call', confidence: 'low' };
  if (m < C.judging.dominantMargin) return { label: leader === 'a' ? 'narrow for A' : 'narrow for B', confidence: 'medium' };
  if (m < C.judging.overwhelmingMargin) return { label: leader === 'a' ? 'clear for A' : 'clear for B', confidence: 'high' };
  return { label: leader === 'a' ? 'dominant for A' : 'dominant for B', confidence: 'high' };
}

export function clampScore(v: number): number {
  return clamp(Math.round(v), 6, 10);
}
