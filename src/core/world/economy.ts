import { DIFFICULTY } from '../config/calibration';
import { clamp, Rng } from '../rng';
import { addDays, ageOn, daysBetween, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, type FightResult } from '../types/fight';
import { PROMOTION_NAME } from '../config/branding';
import type { Fighter } from '../types/fighter';
import type { Contract, ContractOffer, ContractTerms, NegotiationRound } from '../types/world';
import type { SaveGame } from '../types/save';
import { record } from './finance';

/**
 * Money, leverage and popularity.
 *
 * Every contract in the game is a simulated game object. Real fighter pay is not public,
 * so nothing here is presented as a reported figure, and every generated contract carries
 * isSimulated true plus a visible label in the interface.
 *
 * Ovr is deliberately absent from every formula in this file. Pay follows draw and
 * results, which is why a popular finisher outside the top ten can out earn a technically
 * superior but unmarketable contender.
 */

export interface LeverageProfile {
  /** 0 to 100 composite of everything the promotion actually pays for. */
  score: number;
  components: { label: string; value: number }[];
  summary: string;
}

export function computeLeverage(fighter: Fighter, save: SaveGame): LeverageProfile {
  const table = save.rankings[fighter.divisionId];
  const isChampion = table.championId === fighter.id;
  const components: { label: string; value: number }[] = [];

  const rankValue = isChampion ? 34 : fighter.ranking !== null ? clamp(26 - fighter.ranking * 1.5, 3, 26) : 2;
  components.push({ label: 'Ranking and title status', value: rankValue });

  const pfpValue = fighter.pfpRanking !== null ? clamp(14 - fighter.pfpRanking * 0.8, 2, 14) : 0;
  if (pfpValue > 0) components.push({ label: 'Pound for pound standing', value: pfpValue });

  const popValue = (fighter.popularity / 100) * 24;
  components.push({ label: 'Drawing power', value: popValue });

  const totalUfc = fighter.ufcRecord.wins + fighter.ufcRecord.losses + fighter.ufcRecord.draws;
  const finishes = fighter.methods.koWins + fighter.methods.subWins;
  const finishRate = fighter.record.wins > 0 ? finishes / fighter.record.wins : 0;
  const excitement = finishRate * 10;
  components.push({ label: 'Finish rate', value: excitement });

  const streakValue = clamp(fighter.winStreak * 1.7 - fighter.lossStreak * 3.4, -12, 12);
  components.push({ label: 'Recent form', value: streakValue });

  const reliability = clamp(8 - fighter.declinedOffers * 1.6 + fighter.acceptedShortNotice * 1.4, -6, 10);
  components.push({ label: 'Reliability', value: reliability });

  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 29;
  const runway = clamp((34 - age) * 0.8, -8, 6);
  components.push({ label: 'Remaining career projection', value: runway });

  const activity = fighter.lastFightDate ? clamp(6 - daysBetween(fighter.lastFightDate, save.date) / 90, -6, 6) : -3;
  components.push({ label: 'Activity', value: activity });

  const experience = clamp(totalUfc * 0.35, 0, 8);
  components.push({ label: 'Promotional experience', value: experience });

  const score = clamp(
    components.reduce((s, c) => s + c.value, 0),
    1,
    100
  );

  const top = [...components].sort((a, b) => b.value - a.value)[0];
  const bottom = [...components].sort((a, b) => a.value - b.value)[0];
  const summary =
    score > 70
      ? `Strong position. ${top.label} is doing most of the work.`
      : score > 45
        ? `Moderate leverage. ${top.label} helps, ${bottom.label.toLowerCase()} does not.`
        : `Weak position. ${bottom.label} is the problem.`;

  return { score, components, summary };
}

/**
 * Base show pay for a bout. A tiered curve rather than a linear function of leverage,
 * because promotional pay in practice clusters into bands.
 */
export function baseShowPay(leverage: number, isChampion: boolean, isMainEvent: boolean, difficultyPayScale: number): number {
  let pay: number;
  if (isChampion) pay = 460000;
  else if (leverage >= 78) pay = 300000;
  else if (leverage >= 66) pay = 175000;
  else if (leverage >= 55) pay = 110000;
  else if (leverage >= 45) pay = 72000;
  else if (leverage >= 34) pay = 46000;
  else if (leverage >= 24) pay = 30000;
  else pay = 18000;

  if (isMainEvent) pay *= 1.2;
  return Math.round(pay * difficultyPayScale);
}

export interface ContractGenerationOptions {
  isPlayerFighter: boolean;
  fights?: number;
  note?: string;
}

/**
 * Creates a simulated contract. Used both to seed the roster at new game time and to
 * issue a fresh deal when one expires.
 */
export function generateContract(
  fighter: Fighter,
  save: SaveGame,
  rng: Rng,
  opts: ContractGenerationOptions
): Contract {
  const leverage = computeLeverage(fighter, save).score;
  const diff = DIFFICULTY[save.settings.difficulty];
  const table = save.rankings[fighter.divisionId];
  const isChampion = table.championId === fighter.id;
  const show = baseShowPay(leverage, isChampion, false, opts.isPlayerFighter ? diff.payScale : 1);
  const fights = opts.fights ?? (isChampion ? 4 : leverage > 60 ? 4 : rng.int(3, 4));

  const terms: ContractTerms = {
    fights,
    showPay: show,
    winBonus: Math.round(show * (isChampion ? 1.0 : leverage > 55 ? 0.9 : 1.0)),
    signingBonus: leverage > 62 ? Math.round(show * rng.range(0.15, 0.45)) : 0,
    ppvPoints: isChampion || leverage > 82 ? Math.round(rng.range(1.2, 3.4) * 1000) : 0,
    championEscalator: isChampion ? Math.round(show * 0.25) : 0,
    mainEventBonus: leverage > 55 ? Math.round(show * 0.12) : 0,
    shortNoticeBonus: Math.round(show * 0.2),
    guaranteedMinimum: 0,
    performanceBonusEligible: true,
    exclusive: true,
  };

  const id = `contract-${fighter.id}-${save.date}`;
  return {
    id,
    fighterId: fighter.id,
    promotion: PROMOTION_NAME,
    startDate: save.date,
    endCondition: 'fights-exhausted',
    endDate: null,
    terms,
    fightsRemaining: fights,
    status: 'active',
    isSimulated: true,
    minimumTurnaroundDays: 42,
    injuryExtension: true,
    championClause: isChampion,
    weightClassClause: fighter.divisionId,
    negotiationHistory: [],
    signedOn: save.date,
    note:
      opts.note ??
      'Simulated game contract. Real fighter contract terms are not public, so every figure on this deal is generated by the game rather than reported.',
  };
}

/**
 * Builds a negotiable offer with a hidden reservation range. The promotion will not
 * accept every counter, and repeated aggressive counters exhaust its patience.
 */
export function createContractOffer(fighter: Fighter, save: SaveGame, rng: Rng): ContractOffer {
  const leverage = computeLeverage(fighter, save);
  const diff = DIFFICULTY[save.settings.difficulty];
  const table = save.rankings[fighter.divisionId];
  const isChampion = table.championId === fighter.id;
  const opening = baseShowPay(leverage.score, isChampion, false, diff.payScale);

  // The opening offer sits below what the promotion will actually pay.
  const openingDiscount = clamp(0.72 + (leverage.score / 100) * 0.12, 0.6, 0.9);
  const terms: ContractTerms = {
    fights: isChampion ? 4 : rng.int(3, 4),
    showPay: Math.round(opening * openingDiscount),
    winBonus: Math.round(opening * openingDiscount),
    signingBonus: 0,
    ppvPoints: 0,
    championEscalator: isChampion ? Math.round(opening * 0.2) : 0,
    mainEventBonus: leverage.score > 55 ? Math.round(opening * 0.1) : 0,
    shortNoticeBonus: Math.round(opening * 0.18),
    guaranteedMinimum: 0,
    performanceBonusEligible: true,
    exclusive: true,
  };

  // Reservation values scale with leverage and with the difficulty setting.
  const headroom = (1 + (leverage.score / 100) * 0.75) * diff.negotiationScale;
  return {
    id: `coffer-${fighter.id}-${save.date}`,
    fighterId: fighter.id,
    terms,
    createdOn: save.date,
    deadline: addDays(save.date, 14),
    reservation: {
      maxShowPay: Math.round(opening * clamp(headroom, 0.85, 2.1)),
      maxWinBonus: Math.round(opening * clamp(headroom * 0.95, 0.8, 2.0)),
      maxSigningBonus: leverage.score > 55 ? Math.round(opening * 0.5 * diff.negotiationScale) : 0,
      maxPpvPoints: isChampion || leverage.score > 80 ? Math.round(3500 * diff.negotiationScale) : 0,
      patience: clamp(2 + Math.round(leverage.score / 26), 2, 6),
    },
    roundsUsed: 0,
    status: 'open',
    leverageSummary: leverage.summary,
  };
}

export type NegotiationAction =
  | { kind: 'accept' }
  | { kind: 'reject' }
  | { kind: 'walk-away' }
  | { kind: 'counter'; terms: Partial<ContractTerms> };

export interface NegotiationResponse {
  outcome: 'accepted' | 'countered' | 'rejected' | 'withdrawn';
  offer: ContractOffer;
  message: string;
  round: NegotiationRound;
}

/**
 * Promotion side negotiation logic. It concedes toward its reservation, splits the
 * difference on reasonable asks, refuses asks beyond the reservation, and walks away when
 * patience runs out.
 */
export function respondToCounter(
  offer: ContractOffer,
  action: NegotiationAction,
  save: SaveGame,
  rng: Rng
): NegotiationResponse {
  const now = save.date;
  const mk = (accepted: boolean | null, message: string): NegotiationRound => ({
    on: now,
    by: 'promotion',
    terms: { ...offer.terms },
    message,
    accepted,
  });

  if (action.kind === 'accept') {
    offer.status = 'accepted';
    return { outcome: 'accepted', offer, message: 'Terms agreed.', round: mk(true, 'Terms agreed.') };
  }
  if (action.kind === 'reject' || action.kind === 'walk-away') {
    offer.status = 'rejected';
    return {
      outcome: 'rejected',
      offer,
      message: 'The promotion notes the refusal and moves on for now.',
      round: mk(false, 'Offer refused.'),
    };
  }

  offer.roundsUsed++;
  const want = action.terms;
  const res = offer.reservation;

  // How aggressive is the ask relative to what the promotion will pay.
  const askShow = want.showPay ?? offer.terms.showPay;
  const askWin = want.winBonus ?? offer.terms.winBonus;
  const askSign = want.signingBonus ?? offer.terms.signingBonus;
  const askPpv = want.ppvPoints ?? offer.terms.ppvPoints;

  const overreach =
    Math.max(0, askShow / Math.max(1, res.maxShowPay) - 1) +
    Math.max(0, askWin / Math.max(1, res.maxWinBonus) - 1) +
    Math.max(0, askSign / Math.max(1, res.maxSigningBonus || 1) - 1) * 0.4 +
    Math.max(0, askPpv / Math.max(1, res.maxPpvPoints || 1) - 1) * 0.4;

  if (offer.roundsUsed > res.patience) {
    offer.status = 'withdrawn';
    return {
      outcome: 'withdrawn',
      offer,
      message: 'The promotion has stopped responding. The offer is off the table.',
      round: mk(false, 'Negotiation ended without agreement.'),
    };
  }

  if (overreach > 0.55) {
    // A large overreach costs a negotiating round and gets almost nothing.
    const nudge = 1 + rng.range(0.005, 0.02);
    offer.terms.showPay = Math.min(res.maxShowPay, Math.round(offer.terms.showPay * nudge));
    return {
      outcome: 'countered',
      offer,
      message: 'That is well beyond what they are prepared to do. They restate their position with a token increase.',
      round: mk(null, 'Counter rejected as unrealistic.'),
    };
  }

  // Reasonable ask: concede a share of the gap, larger when leverage is high.
  const concession = clamp(0.45 + (res.patience - offer.roundsUsed) * 0.07 - overreach * 0.5, 0.1, 0.75);
  const move = (current: number, ask: number, cap: number) => {
    if (ask <= current) return current;
    const target = Math.min(ask, cap);
    return Math.round(current + (target - current) * concession);
  };

  offer.terms.showPay = move(offer.terms.showPay, askShow, res.maxShowPay);
  offer.terms.winBonus = move(offer.terms.winBonus, askWin, res.maxWinBonus);
  offer.terms.signingBonus = move(offer.terms.signingBonus, askSign, res.maxSigningBonus);
  offer.terms.ppvPoints = move(offer.terms.ppvPoints, askPpv, res.maxPpvPoints);
  if (want.fights !== undefined) {
    // Fight count is cheap to concede within a band.
    offer.terms.fights = clamp(want.fights, 2, 6);
  }
  if (want.guaranteedMinimum !== undefined && want.guaranteedMinimum <= res.maxShowPay * 0.8) {
    offer.terms.guaranteedMinimum = want.guaranteedMinimum;
  }

  const closed =
    offer.terms.showPay >= res.maxShowPay * 0.97 && offer.terms.winBonus >= res.maxWinBonus * 0.97;

  return {
    outcome: 'countered',
    offer,
    message: closed
      ? 'They have come up to their ceiling. There is nothing left to move.'
      : 'They come up, but not all the way.',
    round: mk(null, 'Counter offer issued.'),
  };
}

/** Purse for a specific bout, derived from the contract plus the bout's circumstances. */
export function purseForBout(
  contract: Contract | null,
  fighter: Fighter,
  save: SaveGame,
  opts: { isMainEvent: boolean; isTitleFight: boolean; shortNotice: boolean }
): { show: number; win: number } {
  const diff = DIFFICULTY[save.settings.difficulty];
  if (!contract) {
    const leverage = computeLeverage(fighter, save).score;
    const show = baseShowPay(leverage, false, opts.isMainEvent, diff.payScale);
    return { show, win: show };
  }
  let show = contract.terms.showPay;
  let win = contract.terms.winBonus;
  if (opts.isMainEvent) show += contract.terms.mainEventBonus;
  if (opts.isTitleFight) show += contract.terms.championEscalator;
  if (opts.shortNotice) show += contract.terms.shortNoticeBonus;
  if (contract.terms.guaranteedMinimum > show + win) {
    show = contract.terms.guaranteedMinimum - win;
  }
  return { show: Math.round(show), win: Math.round(win) };
}

// ---------------------------------------------------------------------------
// Popularity
// ---------------------------------------------------------------------------

export interface PopularityChange {
  delta: number;
  regional: Record<string, number>;
  reasons: string[];
}

/**
 * Popularity is tracked separately from skill and moves on what an audience notices:
 * finishes, championships, main events, streaks and how entertaining the fight was.
 */
export function popularityFromResult(
  fighter: Fighter,
  result: FightResult,
  _save: SaveGame,
  opts: { isMainEvent: boolean; eventRegion: string; homeRegion: string | null }
): PopularityChange {
  const won = result.winnerId === fighter.id;
  const reasons: string[] = [];
  let delta = 0;

  if (won) {
    delta += 2.4;
    reasons.push('win');
    if (isFinish(result.method)) {
      delta += result.method === 'ko' ? 5.2 : result.method === 'submission' ? 4.2 : 3.4;
      reasons.push('finish');
    }
    if (isChampionshipBout(result)) {
      delta += result.isTitleFight ? 8 : 5.5;
      reasons.push(result.isTitleFight ? 'title fight win' : 'interim title fight win');
    }
    if (fighter.winStreak >= 4) {
      delta += 1.6;
      reasons.push('win streak');
    }
  } else if (result.winnerId === null) {
    delta += 0.4;
  } else {
    delta -= 1.6;
    reasons.push('loss');
    if (isFinish(result.method)) {
      delta -= 1.6;
      reasons.push('finished');
    }
  }

  if (opts.isMainEvent) {
    delta += 1.5;
    reasons.push('main event exposure');
  }
  if (result.fightQuality > 74) {
    delta += 2.6;
    reasons.push('exciting fight');
  } else if (result.fightQuality < 32) {
    delta -= 1.1;
    reasons.push('dull fight');
  }
  if (result.fightOfTheNight) {
    delta += 3.2;
    reasons.push('fight of the night');
  }

  // Diminishing returns as popularity climbs.
  const scale = 1 - (fighter.popularity / 100) * 0.55;
  delta *= delta > 0 ? scale : 1;

  const regional: Record<string, number> = {};
  regional[opts.eventRegion] = delta * 1.5;
  if (opts.homeRegion) regional[opts.homeRegion] = (regional[opts.homeRegion] ?? 0) + delta * 1.8;

  return { delta, regional, reasons };
}

export function applyPopularity(fighter: Fighter, change: PopularityChange): void {
  fighter.popularity = clamp(fighter.popularity + change.delta, 1, 100);
  for (const [region, v] of Object.entries(change.regional)) {
    fighter.regionalPopularity[region] = clamp((fighter.regionalPopularity[region] ?? fighter.popularity) + v, 1, 100);
  }
}

/** Weekly popularity drift toward a resting level set by standing and activity. */
export function decayPopularity(fighter: Fighter, save: SaveGame): void {
  const table = save.rankings[fighter.divisionId];
  const restingLevel = table.championId === fighter.id ? 78 : fighter.ranking !== null ? clamp(58 - fighter.ranking * 1.8, 12, 58) : 10;
  const inactiveDays = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, save.date) : 400;
  const pull = inactiveDays > 240 ? 0.09 : 0.03;
  fighter.popularity = clamp(fighter.popularity + (restingLevel - fighter.popularity) * pull, 1, 100);
}

/**
 * Performance and fight bonus assignment for a completed card.
 *
 * A weak card does not produce a Fight of the Night award, and when no fight was close
 * the extra award goes to a third performance instead. Selection weighs action, drama,
 * difficulty of the finish and the circumstances rather than fight quality alone.
 */
export interface BonusAward {
  fightOfTheNightBoutId: string | null;
  performanceFighterIds: string[];
  notes: string[];
}

/** Minimum fight quality before a card is considered to have produced a standout fight. */
const FIGHT_OF_THE_NIGHT_THRESHOLD = 58;

export function assignEventBonuses(results: FightResult[], _bonusAmount: number, rng: Rng): BonusAward {
  const notes: string[] = [];
  if (results.length === 0) return { fightOfTheNightBoutId: null, performanceFighterIds: [], notes };

  // Fight of the Night wants a competitive, action heavy fight, not simply the highest
  // scoring one. A one sided shutout is not a fight of the night however good it looked.
  const fotnCandidates = results
    .map((r) => {
      const a = r.totalsA;
      const b = r.totalsB;
      const closeness = 1 - Math.abs(a.sigStrikesLanded - b.sigStrikesLanded) / Math.max(20, a.sigStrikesLanded + b.sigStrikesLanded);
      const drama = (a.knockdowns + b.knockdowns) * 6 + (a.submissionAttempts + b.submissionAttempts) * 4;
      const wentLong = r.endRound >= r.scheduledRounds ? 8 : 0;
      const lateFinish = isFinish(r.method) && r.endRound >= 3 ? 10 : 0;
      return { r, score: r.fightQuality + closeness * 22 + drama + wentLong + lateFinish + rng.range(0, 6) };
    })
    .sort((x, y) => y.score - x.score);

  const best = fotnCandidates[0];
  const awardFotn = best.r.fightQuality >= FIGHT_OF_THE_NIGHT_THRESHOLD;
  if (!awardFotn) notes.push('No Fight of the Night was awarded. Nothing on the card warranted it.');

  // Performance bonuses reward the finish itself: how difficult, how decisive, how late,
  // and whether the winner was the underdog or came in on short notice.
  const finishes = results.filter((r) => isFinish(r.method) && r.winnerId);
  const ranked = finishes
    .map((r) => {
      const methodScore =
        r.method === 'ko' ? 18 : r.method === 'submission' ? 16 : r.method === 'technical-submission' ? 14 : r.method === 'tko-strikes' ? 10 : 6;
      const speed = Math.max(0, 4 - r.endRound) * 4;
      const lateDrama = r.endRound >= 4 ? 10 : 0;
      const comeback = r.winnerId === r.fighterAId ? r.totalsB.knockdowns * 5 : r.totalsA.knockdowns * 5;
      const titleWeight = r.isTitleFight ? 6 : r.isInterimTitleFight ? 4 : 0;
      return { r, score: r.fightQuality * 0.5 + methodScore + speed + lateDrama + comeback + titleWeight + rng.range(0, 8) };
    })
    .sort((x, y) => y.score - x.score);

  // Two performances normally, three when there is no Fight of the Night to award. A fighter who
  // is already taking Fight of the Night is not eligible for a performance award as well: one
  // fight earns one bonus.
  const slots = awardFotn ? 2 : 3;
  const fotnFighterIds = awardFotn ? [best.r.fighterAId, best.r.fighterBId] : [];
  const performanceFighterIds = ranked
    .filter((x) => Boolean(x.r.winnerId) && !fotnFighterIds.includes(x.r.winnerId!))
    .slice(0, slots)
    .map((x) => x.r.winnerId!);
  if (performanceFighterIds.length === 0) notes.push('No finish on the card earned a performance bonus.');
  if (!awardFotn && performanceFighterIds.length === 3) notes.push('A third performance bonus was awarded in place of Fight of the Night.');

  // Written onto the results before anything reads them, and recorded on each result so the field
  // is not a persisted shape that nothing ever fills in.
  if (awardFotn) best.r.fightOfTheNight = true;
  for (const r of results) {
    r.performanceBonusIds = performanceFighterIds.filter((id) => id === r.fighterAId || id === r.fighterBId);
  }
  return { fightOfTheNightBoutId: awardFotn ? best.r.boutId : null, performanceFighterIds, notes };
}

export interface BonusRecord {
  fighterId: string;
  name: string;
  bonuses: number;
  earnings: number;
  rate: number;
}

/** Career bonus leaders, derived from the awards recorded on each fighter. */
export function bonusLeaders(save: SaveGame, bonusAmount = 50000): BonusRecord[] {
  return Object.values(save.fighters)
    .map((f) => {
      const bonuses = f.awards.filter((a) => a.includes('of the Night')).length;
      const fights = f.boutIds.filter((id) => save.history.results[id]).length;
      return {
        fighterId: f.id,
        name: f.name,
        bonuses,
        earnings: bonuses * bonusAmount,
        rate: fights > 0 ? bonuses / fights : 0,
      };
    })
    .filter((r) => r.bonuses > 0)
    .sort((a, b) => b.bonuses - a.bonuses);
}

export function contractSummaryLine(c: Contract): string {
  return `${c.terms.fights} fights, ${c.fightsRemaining} remaining. Simulated terms.`;
}

export function nextContractDate(c: Contract, from: IsoDate): IsoDate {
  return c.endDate ?? addDays(from, 365);
}

/**
 * Signs an agreed contract offer.
 *
 * This used to live inside the contract screen, which meant the one state transition that
 * decides whether a fighter can be booked at all had no test coverage and no other caller
 * could reach it. A fighter with no active contract is refused by every offer path, so a
 * player who never completes this step is quietly frozen out of the sport.
 */
export function signContractOffer(save: SaveGame, fighter: Fighter, offer: ContractOffer, round: NegotiationRound | null): Contract {
  const current = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const next: Contract = {
    id: `contract-${fighter.id}-${save.date}`,
    fighterId: fighter.id,
    promotion: PROMOTION_NAME,
    startDate: save.date,
    endCondition: 'fights-exhausted',
    endDate: null,
    terms: { ...offer.terms },
    fightsRemaining: offer.terms.fights,
    status: 'active',
    isSimulated: true,
    minimumTurnaroundDays: 42,
    injuryExtension: true,
    championClause: fighter.isChampion,
    weightClassClause: fighter.divisionId,
    negotiationHistory: [...(current?.negotiationHistory ?? []), ...(round ? [round] : [])],
    signedOn: save.date,
    note: 'Simulated game contract agreed through negotiation. Real fighter contract terms are not public.',
  };
  // The previous deal is closed rather than left sitting alongside the new one.
  if (current && current.status !== 'expired') current.status = 'expired';
  save.contracts[next.id] = next;
  fighter.contractId = next.id;
  // Signing again is what ends a release. Without this the contract was active while every
  // availability check still read the fighter as released, so they could not be matched.
  if (fighter.activityStatus === 'released') fighter.activityStatus = 'active';
  if (offer.terms.signingBonus > 0) {
    fighter.careerEarnings += offer.terms.signingBonus;
    if (save.player.fighterId === fighter.id) {
      record(save, fighter.id, 'in', 'signing-bonus', offer.terms.signingBonus, 'Signing bonus');
    }
  }
  return next;
}
