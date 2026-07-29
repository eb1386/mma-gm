import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { clamp } from '../rng';
import { daysBetween, type FighterId } from '../types/common';
import { isFinish, type FightResult } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';

/**
 * Title opportunity and rematch priority.
 *
 * Both were previously implicit in the matchmaker, which meant a fighter on a fifteen fight
 * unbeaten run could move up and be given an unranked opponent, and a champion with one
 * defense could lose and never be seen again while a champion with no defenses got an
 * instant rematch. Both questions now have an explicit, explainable score.
 */

export type TitleOpportunity =
  | 'immediate-title-shot'
  | 'number-one-contender'
  | 'top-five-debut'
  | 'ranked-debut'
  | 'establish-yourself';

export const OPPORTUNITY_LABEL: Record<TitleOpportunity, string> = {
  'immediate-title-shot': 'Immediate title shot likely',
  'number-one-contender': 'Number one contender fight likely',
  'top-five-debut': 'Top five debut likely',
  'ranked-debut': 'Ranked debut likely',
  'establish-yourself': 'You will need to establish yourself',
};

export interface TitleOpportunityAssessment {
  score: number;
  opportunity: TitleOpportunity;
  reasons: string[];
  cautions: string[];
}

/** Consecutive fights without a loss, counting draws as unbeaten. */
export function unbeatenRun(save: SaveGame, fighter: Fighter): number {
  let run = 0;
  for (let i = fighter.boutIds.length - 1; i >= 0; i--) {
    const result = save.history.results[fighter.boutIds[i]];
    if (!result) continue;
    if (result.loserId === fighter.id) break;
    run++;
  }
  return Math.max(run, fighter.winStreak);
}

/**
 * How much leverage this fighter has for a title opportunity in a target division.
 *
 * Deliberately transparent: every contribution is a stated reason the interface can show.
 */
export function assessTitleOpportunity(
  save: SaveGame,
  fighter: Fighter,
  targetDivisionId: DivisionId,
  opts: { direction?: 'up' | 'down' | 'same'; vacatedTitle?: boolean; announced?: boolean } = {}
): TitleOpportunityAssessment {
  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = 0;

  const run = unbeatenRun(save, fighter);
  if (run >= 12) {
    score += 55;
    reasons.push(`${run} fights without a loss is the kind of run that skips the queue.`);
  } else if (run >= 8) {
    score += 40;
    reasons.push(`${run} straight without a loss puts you near the front.`);
  } else if (run >= 5) {
    score += 26;
    reasons.push(`A ${run} fight run is hard to ignore.`);
  } else if (run >= 3) {
    score += 14;
    reasons.push(`Three or more in a row counts for something.`);
  } else if (fighter.lossStreak > 0) {
    score -= 18;
    cautions.push('You are coming off a loss, which costs leverage.');
  }

  // Championship history is the strongest single input.
  if (fighter.isChampion) {
    score += 35;
    reasons.push('You are a reigning champion.');
  }
  const defenses = fighter.titleDefenses;
  if (defenses >= 10) {
    score += 45;
    reasons.push(`${defenses} title defenses is a historic reign and carries enormous weight.`);
  } else if (defenses >= 5) {
    score += 30;
    reasons.push(`${defenses} title defenses gives you real standing.`);
  } else if (defenses >= 2) {
    score += 16;
    reasons.push(`${defenses} title defenses counts in your favour.`);
  } else if (fighter.titleReigns > 0) {
    score += 8;
    reasons.push('You have held a title before.');
  }

  // Quality of recent opposition.
  const recent = fighter.boutIds
    .slice(-4)
    .map((id) => save.history.results[id])
    .filter((r): r is FightResult => Boolean(r));
  const beatRanked = recent.filter((r) => {
    if (r.winnerId !== fighter.id) return false;
    const otherId = r.fighterAId === fighter.id ? r.fighterBId : r.fighterAId;
    const other = save.fighters[otherId];
    return Boolean(other) && (other.isChampion || (other.ranking !== null && other.ranking <= 8));
  }).length;
  if (beatRanked >= 2) {
    score += 20;
    reasons.push('You have beaten more than one top eight opponent recently.');
  } else if (beatRanked === 1) {
    score += 10;
    reasons.push('You have a recent win over ranked opposition.');
  }

  if (fighter.ranking !== null && fighter.ranking <= 3) {
    score += 14;
    reasons.push(`Being ranked ${fighter.ranking} is close enough to matter.`);
  }

  score += clamp((fighter.popularity - 40) / 3, -8, 16);
  if (fighter.popularity > 70) reasons.push('You sell, and the promotion knows it.');
  score += clamp((fighter.relationships.matchmaker - 50) / 4, -8, 12);
  if (fighter.relationships.matchmaker < 35) cautions.push('Your standing with the matchmaker is poor.');

  // Direction of the move.
  if (opts.direction === 'up') {
    score -= 8;
    cautions.push('Moving up means proving yourself against bigger opponents.');
  } else if (opts.direction === 'down') {
    score -= 18;
    cautions.push('Moving down is treated with more caution, especially on the scale.');
    if (fighter.weightMisses > 0) {
      score -= 15;
      cautions.push('Your weight miss history counts against an immediate shot at a lower limit.');
    }
  }
  if (opts.vacatedTitle) {
    score += 18;
    reasons.push('You gave up a title to make this move, which the promotion takes seriously.');
  }
  if (opts.announced) {
    score += 5;
    reasons.push('The move was announced publicly, so there is momentum behind it.');
  }

  // Inactivity erodes everything.
  const idle = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, save.date) : 0;
  if (idle > 540) {
    score -= 25;
    cautions.push('You have been out for a long time.');
  } else if (idle > 365) {
    score -= 12;
    cautions.push('A year out costs momentum.');
  }

  // Is the target champion even available.
  const table = save.rankings[targetDivisionId];
  const champion = table?.championId ? save.fighters[table.championId] : null;
  if (!champion) {
    score += 12;
    reasons.push('The title there is vacant.');
  } else if (!canCompete(champion, save.date).ok) {
    score -= 10;
    cautions.push(`${champion.name} is not currently available.`);
  }
  // An established number one contender is in the way.
  const contender = (table?.entries ?? []).find((e) => e.rank === 1);
  if (contender && contender.fighterId !== fighter.id) {
    const other = save.fighters[contender.fighterId];
    if (other && (other.winStreak >= 3 || unbeatenRun(save, other) >= 4)) {
      score -= 12;
      cautions.push(`${other.name} has a strong claim as the next challenger.`);
    }
  }

  const opportunity: TitleOpportunity =
    score >= 85
      ? 'immediate-title-shot'
      : score >= 62
        ? 'number-one-contender'
        : score >= 42
          ? 'top-five-debut'
          : score >= 22
            ? 'ranked-debut'
            : 'establish-yourself';

  return { score: Math.round(score), opportunity, reasons, cautions };
}

// ---------------------------------------------------------------------------
// Fight closeness and rematch priority
// ---------------------------------------------------------------------------

export interface Closeness {
  /** 0 means one sided, 1 means as close as a fight gets. */
  value: number;
  descriptors: string[];
}

/**
 * How close a fight was, from the events rather than from the method alone.
 *
 * A split decision after fifteen close minutes and a first round knockout are both losses
 * and should not be treated the same way when deciding a rematch.
 */
export function fightCloseness(result: FightResult): Closeness {
  const descriptors: string[] = [];
  let value = 0.5;

  if (result.method === 'decision-split') {
    value = 0.92;
    descriptors.push('a split decision');
  } else if (result.method === 'decision-majority') {
    value = 0.82;
    descriptors.push('a majority decision');
  } else if (result.method === 'decision-unanimous') {
    // Look at the cards rather than the label.
    const margins = result.scorecards.map((c) => Math.abs(c.totalA - c.totalB));
    const avg = margins.reduce((s, m) => s + m, 0) / Math.max(1, margins.length);
    value = clamp(1 - (avg - 1) / 8, 0.2, 0.85);
    if (avg <= 2) descriptors.push('a one round decision');
    else if (avg >= 6) descriptors.push('a wide decision');
  } else if (isFinish(result.method)) {
    // A finish is only one sided when it came early and cleanly.
    const roundsShare = result.endRound / Math.max(1, result.scheduledRounds);
    value = clamp(0.15 + roundsShare * 0.45, 0.1, 0.62);
    if (result.endRound === 1) descriptors.push('a first round finish');
    else descriptors.push(`a round ${result.endRound} finish`);
  } else if (result.method === 'no-contest' || result.method === 'technical-draw') {
    value = 1;
    descriptors.push('an unresolved result');
  }

  // Round by round: winning rounds before losing raises closeness.
  const roundsWonByLoser = result.rounds.filter((r) => {
    const loserIsA = result.loserId === result.fighterAId;
    return loserIsA ? r.trueScoreA > 0 : r.trueScoreA < 0;
  }).length;
  if (roundsWonByLoser >= 2) {
    value = clamp(value + 0.12, 0, 1);
    descriptors.push(`the loser won ${roundsWonByLoser} rounds`);
  }

  // Knockdowns scored by the loser mean they had their moments.
  const loserKnockdowns = result.loserId === result.fighterAId ? result.totalsA.knockdowns : result.totalsB.knockdowns;
  if (loserKnockdowns > 0) {
    value = clamp(value + 0.1, 0, 1);
    descriptors.push('the loser scored a knockdown');
  }

  if (result.pointDeductionsA > 0 || result.pointDeductionsB > 0) {
    value = clamp(value + 0.08, 0, 1);
    descriptors.push('a point deduction affected the cards');
  }

  return { value: clamp(value, 0, 1), descriptors };
}

export interface RematchAssessment {
  score: number;
  granted: boolean;
  reasons: string[];
  blockers: string[];
}

/**
 * Whether a former champion has earned an immediate rematch.
 *
 * A long reign is genuine entitlement. No defenses is not, unless the fight itself was
 * close or controversial.
 */
export function assessTitleRematch(save: SaveGame, formerChampion: Fighter, lossResult: FightResult): RematchAssessment {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 0;

  const defenses = formerChampion.titleDefenses;
  if (defenses >= 10) {
    score += 70;
    reasons.push(`${defenses} successful defenses is a historic reign and carries an immediate claim.`);
  } else if (defenses >= 5) {
    score += 45;
    reasons.push(`${defenses} defenses gives a strong claim.`);
  } else if (defenses >= 2) {
    score += 25;
    reasons.push(`${defenses} defenses counts for something.`);
  } else if (defenses === 1) {
    score += 12;
    reasons.push('One defense gives a modest claim.');
  } else {
    reasons.push('You did not defend the title, so the claim rests on the fight itself.');
  }

  const closeness = fightCloseness(lossResult);
  const closenessPoints = Math.round(closeness.value * 45);
  score += closenessPoints;
  if (closeness.value >= 0.8) reasons.push(`It was ${closeness.descriptors.join(' and ')}, which is grounds on its own.`);
  else if (closeness.value <= 0.35) blockers.push(`It was ${closeness.descriptors.join(' and ')}, which weakens the case.`);

  if (lossResult.method === 'no-contest' || lossResult.method === 'technical-draw') {
    score += 30;
    reasons.push('The result was never properly settled.');
  }
  if (lossResult.pointDeductionsA > 0 || lossResult.pointDeductionsB > 0) {
    score += 10;
    reasons.push('A point deduction played a part.');
  }
  const ineligible = (lossResult.titleIneligibleFighterIds ?? []).length > 0;
  if (ineligible) {
    score += 15;
    reasons.push('Somebody missed weight, which the promotion treats as unfinished business.');
  }

  score += clamp((formerChampion.popularity - 45) / 2.5, -10, 20);
  if (formerChampion.popularity > 70) reasons.push('You are a draw, and the rematch sells.');

  // Blockers.
  if (formerChampion.retired) blockers.push('You have retired.');
  if (!canCompete(formerChampion, save.date).ok) blockers.push('You are not medically cleared.');
  const currentDivision = DIVISION_BY_ID[formerChampion.divisionId];
  if (lossResult.divisionId !== formerChampion.divisionId) {
    blockers.push(`You have moved to ${currentDivision.name} since that fight.`);
  }
  const priorRematches = formerChampion.boutIds
    .map((id) => save.history.results[id])
    .filter((r): r is FightResult => Boolean(r))
    .filter((r) => {
      const otherId = r.fighterAId === formerChampion.id ? r.fighterBId : r.fighterAId;
      const lossOtherId = lossResult.fighterAId === formerChampion.id ? lossResult.fighterBId : lossResult.fighterAId;
      return otherId === lossOtherId;
    }).length;
  if (priorRematches >= 3) blockers.push('You have already fought this opponent three times.');

  const granted = blockers.length === 0 && score >= 60;
  return { score: Math.round(score), granted, reasons, blockers };
}

/** Convenience: the most recent title loss for a fighter, if any. */
export function lastTitleLoss(save: SaveGame, fighterId: FighterId): FightResult | null {
  const fighter = save.fighters[fighterId];
  if (!fighter) return null;
  for (let i = fighter.boutIds.length - 1; i >= 0; i--) {
    const result = save.history.results[fighter.boutIds[i]];
    if (!result) continue;
    if (result.loserId !== fighterId) continue;
    if (!result.isTitleFight && !result.isInterimTitleFight) continue;
    return result;
  }
  return null;
}
