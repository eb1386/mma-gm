import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { daysBetween, type BoutId, type FighterId } from '../types/common';
import { isChampionshipBout, type Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';
import { assessTitleOpportunity, unbeatenRun } from './title-logic';
import { CONTENDER_SOURCE_TEXT, currentContender, mayBypassContender } from './contender';

/**
 * The single gate every championship booking passes through.
 *
 * Title fights used to be creatable from four independent places: the weekly title pass,
 * ordinary card seeding, the replacement finder and the player offer path. Each carried its
 * own idea of who was eligible, which is how an unranked fighter coming off two losses could
 * be handed a belt on one path while another path refused the same booking. Everything that
 * can put a championship on the line now asks this module, so there is exactly one answer.
 */

export type TitleBlocker =
  | 'not-in-division'
  | 'retired'
  | 'inactive-roster'
  | 'medically-unavailable'
  | 'already-booked'
  | 'is-the-champion'
  | 'belt-already-contested'
  | 'unranked-without-claim'
  | 'coming-off-loss'
  | 'contender-ahead'
  | 'no-championship-to-contest';

export const TITLE_BLOCKER_TEXT: Record<TitleBlocker, string> = {
  'not-in-division': 'They do not compete in that division.',
  retired: 'They have retired.',
  'inactive-roster': 'They are not on the active roster.',
  'medically-unavailable': 'They are not medically cleared.',
  'already-booked': 'They are already booked for another bout.',
  'is-the-champion': 'A champion cannot challenge for their own championship.',
  'belt-already-contested': 'That championship is already on the line in a scheduled bout.',
  'unranked-without-claim': 'They are unranked and have no standing claim to a title shot.',
  'coming-off-loss': 'They are coming off a loss with nothing else to justify the shot.',
  'contender-ahead': 'Another fighter holds an earned number one contender position and is available.',
  'no-championship-to-contest': 'There is no championship to contest in that division.',
};

export interface TitleEligibility {
  eligible: boolean;
  /** Set when eligible. The sentence shown to the player explaining the selection. */
  selectionReason: string;
  blockers: TitleBlocker[];
  /** Human readable blocker sentences, in the same order. */
  blockerText: string[];
  /** Supporting reasons, whether or not the fighter is eligible. */
  reasons: string[];
  /** Higher means a stronger claim. Used to order contenders. */
  claim: number;
}

export interface TitleEligibilityOptions {
  /** The bout being considered, so an existing booking for it is not treated as a conflict. */
  ignoreBoutId?: BoutId | null;
  /** True when the belt is vacant, which relaxes the ranking requirement slightly. */
  vacant?: boolean;
  /** True for an interim championship. */
  interim?: boolean;
  /** A replacement steps in late and is held to a higher ranking bar, never a lower one. */
  shortNotice?: boolean;
  /** Set when the challenger is arriving from another division. */
  arrivingFrom?: DivisionId | null;
}

/** The scheduled bout that already puts this division's belt on the line, if any. */
export function existingTitleBout(save: SaveGame, divisionId: DivisionId, ignoreBoutId?: BoutId | null): Bout | null {
  for (const b of Object.values(save.bouts)) {
    if (b.status !== 'scheduled') continue;
    if (b.divisionId !== divisionId) continue;
    if (ignoreBoutId && b.id === ignoreBoutId) continue;
    if (!isChampionshipBout(b)) continue;
    return b;
  }
  return null;
}

/** The open offer that already puts this division's belt on the line, if any. */
export function existingTitleOffer(save: SaveGame, divisionId: DivisionId): { id: string; fighterId: FighterId } | null {
  for (const o of Object.values(save.fightOffers)) {
    if (o.status !== 'open') continue;
    if (o.divisionId !== divisionId) continue;
    if (!o.isTitleFight && !o.isInterimTitleFight) continue;
    return { id: o.id, fighterId: o.fighterId };
  }
  return null;
}

/**
 * Whether a challenger may be booked for this division's championship.
 *
 * The ranking bar is deliberately not absolute. A former champion on a comeback run, a
 * champion arriving from another division and a fighter who has beaten the number one
 * contender all have real claims that a pure ranking check would refuse, so each is an
 * explicit named route rather than an exception buried in a score.
 */
export function titleShotEligibility(
  save: SaveGame,
  challenger: Fighter,
  divisionId: DivisionId,
  opts: TitleEligibilityOptions = {}
): TitleEligibility {
  const blockers: TitleBlocker[] = [];
  const reasons: string[] = [];
  const table = save.rankings[divisionId];
  const division = DIVISION_BY_ID[divisionId];
  let claim = 0;

  const arrivingFrom = opts.arrivingFrom ?? null;
  const inDivision = challenger.divisionId === divisionId;
  if (!inDivision && !arrivingFrom) blockers.push('not-in-division');
  if (challenger.retired) blockers.push('retired');
  if (challenger.activityStatus !== 'active' && !challenger.retired) blockers.push('inactive-roster');
  if (!canCompete(challenger, save.date).ok) blockers.push('medically-unavailable');

  const booked = challenger.nextBoutId && challenger.nextBoutId !== opts.ignoreBoutId;
  if (booked) blockers.push('already-booked');

  const isUndisputedChampion = table?.championId === challenger.id;
  const isInterimChampion = table?.interimChampionId === challenger.id;
  // Challenging for the belt you already hold is meaningless. Unifying against the interim
  // holder is not, so an interim champion challenging for the undisputed belt is allowed.
  if (isUndisputedChampion && !opts.interim) blockers.push('is-the-champion');
  if (isInterimChampion && opts.interim) blockers.push('is-the-champion');

  if (!table) blockers.push('no-championship-to-contest');
  const contested = existingTitleBout(save, divisionId, opts.ignoreBoutId);
  if (contested) blockers.push('belt-already-contested');

  // ---- Claim routes. Any one of them satisfies the standing requirement. ----
  let hasClaim = false;
  const rank = isUndisputedChampion ? 0 : challenger.ranking;

  // An earned number one contender position outranks everything else. This is the route that
  // makes winning an eliminator mean something, and it is deliberately first so that no other
  // consideration can quietly outweigh it.
  const standing = currentContender(save, divisionId);
  if (standing && standing.fighterId === challenger.id) {
    hasClaim = true;
    claim += 200;
    reasons.push(`They are the number one contender: they ${CONTENDER_SOURCE_TEXT[standing.source]}.`);
  } else if (standing && !opts.vacant && !opts.interim && !isInterimChampion) {
    // Somebody else holds the position. Passing them over needs one of the stated reasons.
    //
    // A vacant or interim championship is exempt because it takes two fighters to contest one.
    // Blocking everybody except the standing contender left those bouts with a single eligible
    // name and made them impossible to book at all.
    //
    // The interim champion is exempt too. Unification is a debt the division already owes, and a
    // contender claim earned afterwards must not stop the two belts being merged.
    const bypass = mayBypassContender(save, divisionId);
    if (!bypass.allowed) blockers.push('contender-ahead');
    else if (bypass.reason) reasons.push(`The number one contender cannot take the fight: ${bypass.reason}`);
  }

  if (isInterimChampion) {
    hasClaim = true;
    claim += 95;
    reasons.push('They hold the interim championship, so a unification bout is the obvious next fight.');
  }
  if (rank !== null && rank <= 5) {
    hasClaim = true;
    claim += 90 - rank * 6;
    reasons.push(`They are the number ${rank} contender.`);
  } else if (rank !== null && rank <= 10) {
    // Ranked but outside the top five needs something extra alongside the ranking.
    const run = unbeatenRun(save, challenger);
    if (run >= 3) {
      hasClaim = true;
      claim += 60 - rank * 2 + run * 3;
      reasons.push(`Ranked ${rank} on a ${run} fight unbeaten run.`);
    } else {
      reasons.push(`Ranked ${rank}, which is not on its own enough.`);
      claim += 20;
    }
  }

  // Beating the number one contender is a claim in itself regardless of ranking.
  const numberOne = (table?.entries ?? []).find((e) => e.rank === 1);
  if (numberOne && numberOne.fighterId !== challenger.id) {
    const beatThem = challenger.boutIds.some((id) => {
      const r = save.history.results[id];
      if (!r || r.winnerId !== challenger.id) return false;
      const otherId = r.fighterAId === challenger.id ? r.fighterBId : r.fighterAId;
      return otherId === numberOne.fighterId && daysBetween(r.date, save.date) < 550;
    });
    if (beatThem) {
      hasClaim = true;
      claim += 70;
      const other = save.fighters[numberOne.fighterId];
      reasons.push(`They beat ${other?.name ?? 'the number one contender'}, who is the number one contender.`);
    }
  }

  // A former champion on a comeback run.
  if (challenger.titleReigns > 0) {
    const run = unbeatenRun(save, challenger);
    if (run >= 3) {
      hasClaim = true;
      claim += 55 + Math.min(20, challenger.titleDefenses * 4);
      reasons.push(`A former champion on a ${run} fight run back toward the title.`);
    }
  }

  // A champion arriving from another division carries their standing with them.
  if (arrivingFrom) {
    const fromTable = save.rankings[arrivingFrom];
    const wasChampion = fromTable?.championId === challenger.id || challenger.isChampion;
    const assessment = assessTitleOpportunity(save, challenger, divisionId, {
      direction: DIVISION_BY_ID[arrivingFrom].order < division.order ? 'up' : 'down',
    });
    if (wasChampion) {
      hasClaim = true;
      claim += 85;
      reasons.push(`They arrive as the ${DIVISION_BY_ID[arrivingFrom].name} champion.`);
    } else if (assessment.score >= 62) {
      hasClaim = true;
      claim += assessment.score;
      reasons.push(`They arrive from ${DIVISION_BY_ID[arrivingFrom].name} with a strong case: ${assessment.reasons[0] ?? 'a long unbeaten run'}`);
    }
  }

  if (opts.vacant && rank !== null && rank <= 8) {
    hasClaim = true;
    claim += 30;
    reasons.push('The championship is vacant, which opens the field.');
  }

  if (!hasClaim) blockers.push('unranked-without-claim');

  // Coming off a loss. A loss in a title fight that produced a live rematch claim is handled
  // by the former champion route above, so anything reaching here is an ordinary defeat.
  if (challenger.lossStreak > 0 && !isInterimChampion) {
    const excused = rank !== null && rank <= 2 && challenger.lossStreak === 1 && (contested === null);
    if (!excused) blockers.push('coming-off-loss');
    else reasons.push('A single loss at the very top of the division is not enough to lose the position.');
  }

  if (opts.shortNotice && (rank === null || rank > 8) && !isInterimChampion) {
    blockers.push('unranked-without-claim');
  }

  claim += Math.min(20, challenger.popularity * 0.15);

  const eligible = blockers.length === 0;
  const selectionReason = eligible ? (reasons[0] ?? `They are the leading available contender at ${division.name}.`) : '';

  return {
    eligible,
    selectionReason,
    blockers,
    blockerText: blockers.map((b) => TITLE_BLOCKER_TEXT[b]),
    reasons,
    claim: Math.round(claim),
  };
}

/**
 * Ranks the available challengers for a division, best claim first.
 *
 * Only eligible fighters are returned, so a caller cannot accidentally book somebody the
 * gate would have refused.
 */
export function rankChallengers(
  save: SaveGame,
  divisionId: DivisionId,
  filter: (f: Fighter) => boolean,
  opts: TitleEligibilityOptions = {}
): { fighter: Fighter; eligibility: TitleEligibility }[] {
  const out: { fighter: Fighter; eligibility: TitleEligibility }[] = [];
  const table = save.rankings[divisionId];
  const pool = new Set<FighterId>();
  for (const e of table?.entries ?? []) pool.add(e.fighterId);
  if (table?.interimChampionId) pool.add(table.interimChampionId);
  // The standing contender must always be considered, even when they are not in the ranked
  // entries. A champion who has just arrived from another division is unranked by definition,
  // and leaving them out of the pool while the contender-ahead blocker refused everybody else
  // would freeze the division with no challenger at all.
  const standing = currentContender(save, divisionId);
  if (standing) pool.add(standing.fighterId);
  for (const id of pool) {
    const f = save.fighters[id];
    if (!f || !filter(f)) continue;
    const eligibility = titleShotEligibility(save, f, divisionId, opts);
    if (!eligibility.eligible) continue;
    out.push({ fighter: f, eligibility });
  }
  out.sort((a, b) => b.eligibility.claim - a.eligibility.claim);
  return out;
}

// ---------------------------------------------------------------------------
// Interim championships
// ---------------------------------------------------------------------------

export type InterimReason =
  | 'champion-injured'
  | 'champion-suspended'
  | 'champion-inactive'
  | 'champion-in-other-division'
  | 'champion-contract-dispute';

export const INTERIM_REASON_TEXT: Record<InterimReason, string> = {
  'champion-injured': 'the champion is recovering from a long term injury',
  'champion-suspended': 'the champion is serving an extended medical suspension',
  'champion-inactive': 'the champion has been inactive well beyond the promotion tolerance',
  'champion-in-other-division': 'the champion is campaigning in another division',
  'champion-contract-dispute': 'the champion is not under an active agreement',
};

export interface InterimJustification {
  justified: boolean;
  reason: InterimReason | null;
  explanation: string;
}

/**
 * Whether crowning an interim champion is justified right now.
 *
 * An interim belt exists because the division cannot wait for the champion, never because
 * the scheduler failed to find them a date. Every path that could create one calls this, and
 * the reason it returns is stored on the bout so the game can say why the belt is interim.
 */
export function interimTitleJustification(save: SaveGame, divisionId: DivisionId): InterimJustification {
  const table = save.rankings[divisionId];
  const none: InterimJustification = { justified: false, reason: null, explanation: '' };
  if (!table?.championId || table.interimChampionId) return none;
  const champ = save.fighters[table.championId];
  if (!champ) return none;

  const idle = champ.lastFightDate ? daysBetween(champ.lastFightDate, save.date) : 999;
  const health = canCompete(champ, save.date);

  let reason: InterimReason | null = null;
  if (champ.medicalSuspension && daysBetween(save.date, champ.medicalSuspension.until) > 150) {
    reason = 'champion-suspended';
  } else if (!health.ok && idle > 200) {
    reason = 'champion-injured';
  } else if (champ.divisionId !== divisionId) {
    reason = 'champion-in-other-division';
  } else if (champ.activityStatus !== 'active') {
    reason = 'champion-contract-dispute';
  } else if (idle > 330) {
    reason = 'champion-inactive';
  }

  if (!reason) return none;
  return {
    justified: true,
    reason,
    explanation: `An interim ${DIVISION_BY_ID[divisionId].name} championship is being contested because ${INTERIM_REASON_TEXT[reason]}.`,
  };
}

/**
 * Whether a unification bout is now the priority in this division.
 *
 * Once an interim champion exists, the division owes the fans one fight before anything
 * else. This is what stops an interim belt from quietly becoming permanent.
 */
export function unificationDue(save: SaveGame, divisionId: DivisionId): { due: boolean; explanation: string } {
  const table = save.rankings[divisionId];
  if (!table?.championId || !table.interimChampionId) return { due: false, explanation: '' };
  const champ = save.fighters[table.championId];
  const interim = save.fighters[table.interimChampionId];
  if (!champ || !interim) return { due: false, explanation: '' };
  if (!canCompete(champ, save.date).ok) {
    return { due: false, explanation: `${champ.name} is still not cleared, so unification has to wait.` };
  }
  return {
    due: true,
    explanation: `${champ.name} is available again, so unification with interim champion ${interim.name} is the priority in the division.`,
  };
}
