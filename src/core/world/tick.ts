import { DIFFICULTY } from '../config/calibration';
import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { narrateResult } from '../narrative/render';
import { applyDetail, detailForBout, shouldNarrate, shouldSummarizeRounds, type DetailContext, type SimDetail } from './detail';
import { clamp, Rng } from '../rng';
import { simulateFight, type FightSimOptions } from '../sim/engine';
import { planFit } from '../sim/plan';
import type { GamePlanKey, FightCardEvent } from '../types/world';
import { addDays, ageOn, dayOfWeek, daysBetween, formatDate, formatMoney, joinSentence, yearOf, type BoutId, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, METHOD_LABEL, type Bout, type FightResult } from '../types/fight';
import { ovrDisplayed, ovrRaw, RATING_KEYS, type Fighter, type RatingKey, historyRatings } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { autoCampFor, finalizeCamp, runCampWeek } from './camp';
import { compactSave } from './compaction';
import { liveCampOf, withLiveCampIndex } from './indexes';
import { applyPopularity, assignEventBonuses, computeLeverage, createContractOffer, decayPopularity, generateContract, popularityFromResult, purseForBout } from './economy';
import { applyDeltas, developWeek, evenFocus, notePeakOvr, potConfidenceFor, retirementChance } from './development';
import { invalidatePot, prunePotCache, refreshPotForAll, updatePot } from './pot';
import {
  GYM_DEBT_CHOICES,
  GYM_DEBT_REPUTATION_LOSS,
  GYM_RUNWAY_WARNING_MONTHS,
  moveFighterToGym,
  rollFighterAutonomy,
  runGymMonth,
  updateHappiness,
} from './gyms';
import { mayNotify } from './decisions';
import { computeSeasonAwards, newsForResult, pushNews, runHallOfFameVote } from './history';
import {
  canCompete,
  injuriesFromFight,
  manageWalkingWeight,
  medicalSuspensionFor,
  restRecovery,
  rollTrainingInjury,
  simulateWeightCut,
  trainingCapacityOf,
  wearFromFight,
  applyWear,
} from './health';
import { applyReplacement, bookEvent, cancelBout, CHAMPION_TURNAROUND_DAYS, findReplacement, findTitleReplacement, isAvailable, openOfferFighterIds, orderCard, regionOfFighter, scheduleEvents, TITLE_REBOOK_NOTICE_DAYS, titleBoutRoom } from './matchmaking';
import { inCampFighterIds } from './availability';
import { applyFightPurse, applyPpvPoints, creditWeightForfeits, paySponsorsForFight, runFinanceWeek } from './finance';
import { clearDopingState, clearExpiredSuspensions, runAntiDopingWeek } from './antidoping';
import { recordSocialHistory } from './identity';
import { bookBout, FIGHT_WEEK_DAYS, hasLiveBooking, releaseBooking } from './availability';
import { checkPlayerInjuries } from './injury-flow';
import { cutContext } from './weighin';
import { closeFightWeek, ensureFightWeekTasks, pendingStages, pruneFightWeek, stageLabel, tasksForBout } from './fightweek';
import { generateSocialItems, pruneSocial, socialRng } from './social';
import { campLifeRng, generateCampLife, seedGymRelationships } from './camp-life';
import { decayRelationships, openCallouts, pruneCallouts, recordFightBetween, resolveCallout } from './relationships';
import { enforceAbsentChampions, maybeSuggestMove, raiseForcedMoveDecision, settleOneFightMoves } from './weightclass';
import { assignOfficials, judgePersonasFor, recordOfficialOutcome, refereeTendencyFor } from './officials';
import { applyResultToContenders, fulfilContenderStatus, reviewContenderClaims } from './contender';
import { evaluateAllInterests, pruneMatchupInterests } from './matchup-interest';
import { runMatchupInterestPass } from './matchup-pass';
import { ensurePlayerDebut } from './debut';
import { existingTitleOffer, interimTitleJustification, rankChallengers, titleShotEligibility, unificationDue } from './title-eligibility';
import { cancelStaleDivisionBouts, enforceDivisionInvariant, runNpcCallouts, runNpcWeightClassMoves } from './npc-behaviour';
import { pruneGamePlans } from './gameplan-memory';
import { syncCareerState, recordAchievements, retireFighter } from './career';
import './decision-handlers';
import { PROMOTION_CONTRACTS, PROMOTION_NAME } from '../config/branding';
import { applyResultToRankings, applyTitleOutcome, reconcileChampionFlags, recomputeDivision, recomputePfp, seedDeposedChampion } from './rankings';
import { generateFighter } from './generator';
import { closeCompetingOffers, createFightOffer, expireOffers } from './offers';
import { addInboxMessage, messageNeedsAction, reconcileInbox, resolveMessagesForBout } from './inbox';
import { VENUE_CITIES } from './venues';
import { addHypeMoment, computeHype, escalateRivalry, pruneHype, updateAllHype, decayRivalries } from './hype';
import { businessStore, computeEventBusiness } from './business';
import {
  applyFameChange,
  applyFollowerChange,
  computeDrawingPower,
  decayFame,
  decaySocial,
  derivePublicLabels,
  fameFromResult,
  socialFromResult,
} from './identity';
import { ROSTER_TARGET_SCALE } from '../config/matchmaking';
import { featureEnabled } from '../types/save';
import { MATCHMAKING } from '../config/matchmaking';
import { mainRosterFighters, popularityScaleFor } from './circuit';
import { applyRegionalResult, promotionConfig, runRegionalWeek } from './regional';
import { REGIONAL_LEVELS } from '../config/regional';
import { applyBonusAward } from './finance';

/**
 * The world clock.
 *
 * advance() moves the simulation forward and returns a report of everything that
 * happened. It stops early whenever a decision requires the player, which is what makes
 * a single advance button safe to hold down.
 */

export type AdvanceMode = 'day' | 'week' | 'next-message' | 'next-event' | 'to-fight' | 'weigh-in' | 'month' | 'year';

export interface AdvanceOptions {
  mode: AdvanceMode;
  maxDays?: number;
  /**
   * Stop as soon as an inbox item needs an answer. Defaults to the player's setting. Passing false
   * explicitly also turns off the fight week stops, for callers that drive the world headless.
   */
  stopOnDecision?: boolean;
}

export interface AdvanceReport {
  from: IsoDate;
  to: IsoDate;
  daysAdvanced: number;
  eventsResolved: string[];
  headlines: string[];
  stoppedBecause: string | null;
  playerBoutPending: BoutId | null;
  /**
   * Advancement stopped because something arrived in the inbox.
   *
   * The caller uses this to take the player there. Stopping without saying where to look meant a
   * message could arrive, the clock could halt, and the player would be left on whatever page
   * they happened to be on with no indication of why nothing was moving.
   */
  inboxWaiting: boolean;
  /**
   * Advancement stopped for the player's fight week: it began, or a mandatory stage such as the
   * official weigh in came due. The caller takes the player to that fight week.
   */
  fightWeekBoutId?: BoutId | null;
}

function rngOf(save: SaveGame): Rng {
  const rng = new Rng(save.rng);
  return rng;
}

function persistRng(save: SaveGame, rng: Rng): void {
  save.rng = rng.getState();
}

// ---------------------------------------------------------------------------
// Fight resolution
// ---------------------------------------------------------------------------

function gamePlanForAi(fighter: Fighter, rng: Rng): GamePlanKey[] {
  const plans: GamePlanKey[] = [];
  if (fighter.tendencies.takedownEntry > 0.58) plans.push('takedown-pressure');
  else if (fighter.tendencies.pressure > 0.62) plans.push('pressure');
  else if (fighter.tendencies.counter > 0.6) plans.push('counter');
  else if (fighter.tendencies.range > 0.6) plans.push('outside-range');
  if (fighter.tendencies.submissionHunt > 0.62) plans.push('submission-hunting');
  else if (fighter.tendencies.topControl > 0.62) plans.push('top-control');
  if (fighter.tendencies.pace > 0.7 && fighter.ratings.cardio > 70) plans.push('high-pace');
  else if (fighter.ratings.cardio < 58) plans.push('conservative-pace');
  if (plans.length === 0) plans.push(rng.pick(['pressure', 'counter', 'outside-range'] as GamePlanKey[]));
  const chosen = plans.slice(0, 3);
  // A plan's effect now scales with how well it suits the fighter, so a habit alone is not a
  // reason to pick it: a striker who likes to shoot still does better without a wrestling plan.
  // Filtering after the choice keeps the rng draws exactly as they were.
  const fitting = chosen.filter((p) => planFit(p, fighter.ratings) >= 0.6);
  return fitting.length > 0 ? fitting : chosen;
}

export interface BoutPreparation {
  sharpness: number;
  tacticalFamiliarity: number;
  cutQuality: number;
  campQuality: number;
  shortNotice: boolean;
  gamePlan: GamePlanKey[];
}

/** Resolves weigh in for one side and returns the fight night preparation state. */
export function prepareSide(save: SaveGame, bout: Bout, fighter: Fighter, rng: Rng, playerPlan?: GamePlanKey[]): BoutPreparation {
  const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && c.boutId === bout.id);
  const noticeDays = daysBetween(bout.bookedOn, bout.date);
  const shortNotice = noticeDays < 24;

  let sharpness = camp?.resultingSharpness ?? null;
  let familiarity = camp?.resultingTacticalFamiliarity ?? null;
  if (camp && camp.status !== 'complete') {
    const finished = finalizeCamp(save, camp, rng);
    sharpness = finished.sharpness;
    familiarity = finished.tacticalFamiliarity;
  }
  if (sharpness === null) {
    // For a computer fighter with no camp record, the regional circuit's fighters above all, this
    // stands in for preparation the game does not model. The player's own fighter without a camp
    // skipped one, and that has to come out below any camp they could have set at the same notice:
    // at 0.62 it beat every camp under six weeks, for free. The draws are the same either way.
    const skipped = fighter.id === save.player.fighterId;
    const longMean = skipped ? 0.45 : 0.62;
    const shortMean = skipped ? 0.3 : 0.35;
    sharpness = shortNotice ? clamp(rng.normal(shortMean, 0.1), 0.1, 0.6) : clamp(rng.normal(longMean, 0.13), 0.2, 0.95);
    familiarity = shortNotice ? clamp(rng.normal(0.25, 0.1), 0.05, 0.5) : clamp(rng.normal(0.5, 0.13), 0.1, 0.85);
  }

  // The same conditions the official weigh in rolls under, from the one shared definition.
  const ctx = cutContext(save, bout, fighter);
  const cut = simulateWeightCut(
    fighter,
    {
      divisionId: bout.divisionId,
      isTitleFight: bout.isTitleFight,
      campWeeks: ctx.campWeeks,
      nutritionSupport: ctx.nutritionSupport,
      shortNotice: ctx.shortNotice,
      aggressiveness: 0.5,
    },
    save.date,
    rng
  );

  const isA = bout.fighterAId === fighter.id;

  // If this fighter already stepped on the official scale during fight week, that reading is the
  // record. Re-simulating the cut here overwrote the ruling the player was shown, discarded a
  // second attempt they had taken, and could turn a made weight into a miss after the fact.
  const officialState = save.weighIns?.[bout.id];
  const officialReading =
    officialState?.player?.fighterId === fighter.id
      ? officialState.player
      : officialState?.opponent?.fighterId === fighter.id
        ? officialState.opponent
        : null;

  const madeWeight = officialReading ? officialReading.madeWeight : cut.madeWeight;
  const weightLb = officialReading ? officialReading.weightLb : cut.weightLb;
  const cutQuality = officialReading ? officialReading.cutQuality : cut.cutQuality;
  // The roll above always happens, so the world rng draws the same values either way, but the wear
  // is the official cut's. Charging the fresh roll's wear billed a comfortable official cut as a
  // severe one, or the reverse. Readings saved before the wear was stored fall back to the roll.
  applyWear(fighter, officialReading?.wear ?? cut.wear, fighter.development.resilience);

  fighter.lastWeightCutQuality = cutQuality;
  const weighIn = { madeWeight, weightLb, cutQuality };
  if (isA) bout.weighInA = weighIn;
  else bout.weighInB = weighIn;

  // A miss that the official weigh in already recorded has had its consequences applied there.
  if (!madeWeight && !officialReading) {
    fighter.weightMisses++;
    bout.isCatchweight = true;
    // A fighter who misses weight cannot win or keep a championship in this bout, but the
    // bout stays a championship bout for the fighter who made weight. Recording who is
    // ineligible rather than dropping the belt outright is what lets the title still be
    // won by the other side. applyTitleOutcome reads this.
    if (isChampionshipBout(bout) && !bout.titleIneligibleFighterIds.includes(fighter.id)) {
      bout.titleIneligibleFighterIds.push(fighter.id);
    }
    const purse = isA ? bout.purseA : bout.purseB;
    const forfeit = Math.round((purse.show * cut.purseForfeitPct) / 100);
    if (isA) bout.purseA = { ...purse, show: purse.show - forfeit };
    else bout.purseB = { ...purse, show: purse.show - forfeit };
    // Kept on the bout so the ledger can show it, and so the side that made weight is paid it
    // once both have weighed in (creditWeightForfeits, after both sides are prepared).
    if (isA) bout.forfeitA = forfeit;
    else bout.forfeitB = forfeit;
    if (!save.events[bout.eventId]?.promotionId || fighter.id === save.player.fighterId) pushNews(save, {
      date: save.date,
      headline: `${fighter.name} misses weight`,
      body: `${cut.headline}. ${cut.detail}`,
      tags: ['weigh-in'],
      fighterIds: [fighter.id],
      importance: 2,
    });
  }

  return {
    sharpness: sharpness ?? 0.5,
    tacticalFamiliarity: familiarity ?? 0.4,
    cutQuality,
    campQuality: clamp((camp?.weeksCompleted ?? (shortNotice ? 2 : 7)) / 8, 0.2, 1),
    shortNotice,
    gamePlan: playerPlan ?? camp?.gamePlan ?? gamePlanForAi(fighter, rng),
  };
}

/** Runs a single bout and applies every consequence to the world. */
export function resolveBout(
  save: SaveGame,
  bout: Bout,
  rng: Rng,
  playerPlan?: GamePlanKey[],
  detailCtx: DetailContext = {}
): FightResult {
  const a = save.fighters[bout.fighterAId];
  const b = save.fighters[bout.fighterBId];
  const event = save.events[bout.eventId];

  // Officials are assigned before the fight, from the persistent roster. The assignment is
  // derived from the bout id rather than the simulation rng, so it cannot shift the result.
  // With persistent officials disabled the engine draws anonymous judges as it always did, which
  // is the cheaper path for a lower performance save.
  const regional = Boolean(save.events[bout.eventId]?.promotionId);
  // Regional cards are worked by local officials, not the main promotion's persistent roster.
  const assignment = featureEnabled(save.settings, 'persistentOfficials') && !regional
    ? assignOfficials(save, bout)
    : { judgeIds: [], refereeId: null };
  const hostEvent = save.events[bout.eventId];
  // A partisan crowd only exists when one fighter is at home and the other is not.
  const aHome = Boolean(hostEvent && a.country === hostEvent.country);
  const bHome = Boolean(hostEvent && b.country === hostEvent.country);
  const homeSide: -1 | 0 | 1 = aHome === bHome ? 0 : aHome ? 1 : -1;

  const prepA = prepareSide(save, bout, a, rng, save.player.fighterId === a.id ? playerPlan : undefined);
  const prepB = prepareSide(save, bout, b, rng, save.player.fighterId === b.id ? playerPlan : undefined);
  creditWeightForfeits(bout);

  const opts: FightSimOptions = {
    boutId: bout.id,
    eventId: bout.eventId,
    date: bout.date,
    divisionId: bout.divisionId,
    scheduledRounds: bout.scheduledRounds,
    isTitleFight: bout.isTitleFight,
    isInterimTitleFight: bout.isInterimTitleFight,
    titleIneligibleFighterIds: bout.titleIneligibleFighterIds,
    contractedWeightLb: bout.contractedWeightLb,
    settings: save.settings,
    seed: rng.nextUint32(),
    judges: judgePersonasFor(save, assignment, homeSide, bout.id),
    // Used by anonymous judges on a regional card or with persistent officials off.
    homeSide,
    refereeTendency: refereeTendencyFor(save, assignment) ?? undefined,
    a: { fighter: a, gamePlan: prepA.gamePlan, sharpness: prepA.sharpness, tacticalFamiliarity: prepA.tacticalFamiliarity, cutQuality: prepA.cutQuality, campQuality: prepA.campQuality, shortNotice: prepA.shortNotice },
    b: { fighter: b, gamePlan: prepB.gamePlan, sharpness: prepB.sharpness, tacticalFamiliarity: prepB.tacticalFamiliarity, cutQuality: prepB.cutQuality, campQuality: prepB.campQuality, shortNotice: prepB.shortNotice },
  };

  const result = simulateFight(opts);
  const detail: SimDetail = detailForBout(save, bout, detailCtx);
  narrateResult(
    result,
    { id: a.id, name: a.name, lastName: a.lastName, nickname: a.nickname },
    { id: b.id, name: b.name, lastName: b.lastName, nickname: b.nickname },
    { playByPlay: shouldNarrate(detail), roundSummaries: shouldSummarizeRounds(detail) }
  );
  applyDetail(result, detail);

  // Who held the belts going in. applyResult installs a new champion before the headline is
  // written, so a headline that read the live table called every new champion's win a defence.
  const beltsBefore = {
    championId: save.rankings[bout.divisionId]?.championId ?? null,
    interimChampionId: save.rankings[bout.divisionId]?.interimChampionId ?? null,
  };
  applyResult(save, bout, result, rng, prepA.shortNotice, prepB.shortNotice);
  // What the officials did is recorded against them, so a judge builds a history.
  if (!regional) recordOfficialOutcome(save, bout, result);
  // A regional result is news only when it is the player's.
  const playerInvolved = bout.fighterAId === save.player.fighterId || bout.fighterBId === save.player.fighterId;
  if (event && (!regional || playerInvolved)) newsForResult(save, result, event.name, beltsBefore);
  return result;
}

/**
 * Rating gains from having fought. Per rating, about a third of a point for a twenty two year old
 * who beats an equal opponent, up to around two thirds against a clearly better one, falling to
 * almost nothing past thirty, and to nothing at all for a rating already at the ceiling.
 */
export function fightExperience(fighter: Fighter, opponent: Fighter, won: boolean, drew: boolean, amateur: boolean, on: IsoDate): Partial<Record<RatingKey, number>> {
  const age = ageOn(fighter.birthDate, on) ?? fighter.ageAtSnapshot ?? 28;
  const youth = clamp((30 - age) / 10, 0, 1);
  const quality = clamp((ovrRaw(opponent.ratings) - ovrRaw(fighter.ratings) + 10) / 20, 0.2, 1.2);
  const outcome = won ? 1 : drew ? 0.8 : 0.65;
  const base = 0.55 * outcome * (0.35 + youth) * quality * (amateur ? 0.7 : 1);
  const out: Partial<Record<RatingKey, number>> = {};
  for (const key of RATING_KEYS) {
    const room = clamp((fighter.development.hiddenCeiling - fighter.ratings[key]) / 22, 0, 1.25);
    const gain = base * room;
    if (gain > 0.001) out[key] = gain;
  }
  return out;
}

/** Applies a completed result to both fighters, the rankings and the history. */
/**
 * The player's Pot after a fight.
 *
 * Pot was otherwise recomputed only in the year end pass, so a teenager gaining five Ovr a season
 * read a Pot a whole season stale, and could sit below Ovr. The player's own fighter is the one
 * whose Pot the player plans around, so it is refreshed after every fight and on each birthday.
 * Not for every fighter: the annual pass is the budget for the rest of the world. The projection
 * draws from its own seeded rng, so the world sequence is untouched.
 */
function refreshPlayerPotAfterFight(save: SaveGame, a: Fighter, b: Fighter): void {
  for (const f of [a, b]) if (f.id === save.player.fighterId) updatePot(save, f);
}

function isLeapYearOf(date: IsoDate): boolean {
  const y = yearOf(date);
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function applyResult(save: SaveGame, bout: Bout, result: FightResult, rng: Rng, shortNoticeA: boolean, shortNoticeB: boolean): void {
  const a = save.fighters[result.fighterAId];
  const b = save.fighters[result.fighterBId];
  const event = save.events[bout.eventId];
  // A regional bout counts on the professional record but never on the main promotion's, and an
  // amateur bout counts only on the amateur record.
  const regional = Boolean(event?.promotionId);
  const amateur = Boolean(bout.isAmateur);

  // The ranks both sides held going in, read before anything below moves the table, so the
  // upset record measures the gap that stood that night rather than where the two ended up.
  if (!regional) {
    const table = save.rankings[result.divisionId];
    const rankAt = (id: FighterId): number | null =>
      !table ? null : table.championId === id ? 0 : table.interimChampionId === id ? 1 : table.entries.find((e) => e.fighterId === id)?.rank ?? null;
    result.rankA = rankAt(result.fighterAId);
    result.rankB = rankAt(result.fighterBId);
  }

  save.history.results[result.boutId] = result;
  bout.status = 'completed';
  bout.resultId = result.boutId;

  for (const [fighter, opponent, purse] of [
    [a, b, bout.purseA],
    [b, a, bout.purseB],
  ] as [Fighter, Fighter, Bout['purseA']][]) {
    const won = result.winnerId === fighter.id;
    const drew = result.winnerId === null;

    fighter.boutIds.push(result.boutId);
    fighter.nextBoutId = null;
    fighter.lastFightDate = result.date;
    if (!regional && !fighter.octagonDebut) fighter.octagonDebut = result.date;
    const rec = amateur ? (fighter.amateurRecord ??= { wins: 0, losses: 0, draws: 0, noContests: 0 }) : fighter.record;
    const promo = regional ? { wins: 0, losses: 0, draws: 0, noContests: 0 } : fighter.ufcRecord;

    if (amateur) {
      if (won) {
        rec.wins++;
        fighter.winStreak++;
        fighter.lossStreak = 0;
      } else if (drew) {
        rec.draws++;
        fighter.winStreak = 0;
      } else {
        rec.losses++;
        fighter.lossStreak++;
        fighter.winStreak = 0;
      }
      fighter.momentum = clamp(fighter.momentum + (won ? 6 : drew ? 0 : -6), 0, 100);
    } else if (won) {
      rec.wins++;
      promo.wins++;
      fighter.winStreak++;
      fighter.lossStreak = 0;
      // A doctor, corner or retirement stoppage is a stoppage win, which `isFinish` has always
      // agreed with. Counting it as a decision made a fighter's finish rate, their derived public
      // labels and the finish record books all disagree with the result they actually got.
      if (
        result.method === 'ko' ||
        result.method === 'tko-strikes' ||
        result.method === 'tko-ground-strikes' ||
        result.method === 'doctor-stoppage' ||
        result.method === 'corner-stoppage' ||
        result.method === 'retirement'
      ) {
        fighter.methods.koWins++;
      } else if (result.method === 'submission' || result.method === 'technical-submission') {
        fighter.methods.subWins++;
      } else {
        fighter.methods.decWins++;
      }
      fighter.momentum = clamp(fighter.momentum + 12, 0, 100);
      fighter.morale = clamp(fighter.morale + 8, 0, 100);
    } else if (drew) {
      rec.draws++;
      promo.draws++;
      fighter.winStreak = 0;
    } else {
      rec.losses++;
      promo.losses++;
      fighter.lossStreak++;
      fighter.winStreak = 0;
      // The loss side classifies exactly as the win side does, so a fight cannot be a stoppage
      // for the winner and a decision for the loser.
      if (
        result.method === 'ko' ||
        result.method === 'tko-strikes' ||
        result.method === 'tko-ground-strikes' ||
        result.method === 'doctor-stoppage' ||
        result.method === 'corner-stoppage' ||
        result.method === 'retirement'
      ) {
        fighter.methods.koLosses++;
      } else if (result.method === 'submission' || result.method === 'technical-submission') {
        fighter.methods.subLosses++;
      } else {
        fighter.methods.decLosses++;
      }
      fighter.momentum = clamp(fighter.momentum - 16, 0, 100);
      fighter.morale = clamp(fighter.morale - 12, 0, 100);
    }

    // Pay. For the player every movement goes through the ledger, so manager commission,
    // the gym percentage, tax, travel and sponsorship are all visible and applied once.
    // Pay per view points are not known yet: the card's buys are only worked out once every bout
    // on it is over, so resolveEvent pays them (payPpvPoints).
    const earned = purse.show + (won ? purse.win : 0);
    fighter.careerEarnings += earned;
    fighter.lastPurse = earned;
    if (save.player.fighterId === fighter.id) {
      const split = applyFightPurse(save, fighter, result.boutId, { show: purse.show, win: purse.win, bonuses: 0 }, won);
      paySponsorsForFight(save, fighter, result.boutId, won, fighter.isChampion);
      void split;
    }

    // Contract consumption.
    const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
    if (contract) {
      contract.fightsRemaining = Math.max(0, contract.fightsRemaining - 1);
      if (contract.fightsRemaining === 0) contract.status = 'expired';
    }

    // Experience. A fight teaches what a camp cannot, most of all to a young fighter and most of all
    // against somebody better. Ratings used to move only through training, so a player who won fight
    // after fight barely improved and kept meeting opponents rated well above them, which is the
    // complaint players made most often. The gain is bounded by the fighter's hidden ceiling, so it
    // speeds a career toward its Pot rather than past it, and it draws nothing from the world rng.
    fighter.ratings = applyDeltas(fighter.ratings, fightExperience(fighter, opponent, won, drew, amateur, save.date));

    // Health.
    applyWear(fighter, wearFromFight(fighter, result, save), fighter.development.resilience);
    // Always drawn, because it consumes the shared world rng. Gating the call made the injuries
    // setting shift every later draw and change fight results, which is the determinism rule this
    // codebase has now broken four times. The setting decides whether the injuries are applied.
    const rolledInjuries = injuriesFromFight(fighter, result, rng);
    if (save.settings.injuriesEnabled) {
      fighter.injuries.push(...rolledInjuries);
      if (fighter.id === a.id) result.injuriesA = rolledInjuries.map((i) => i.type);
      else result.injuriesB = rolledInjuries.map((i) => i.type);
    }
    fighter.medicalSuspension = medicalSuspensionFor(fighter, result, rng);

    // Popularity, fame and reach. Attention and approval move separately.
    const eventRegion = VENUE_CITIES.find((v) => v.city === event?.city)?.region ?? 'north-america';
    const change = popularityFromResult(fighter, result, save, {
      isMainEvent: bout.isMainEvent,
      eventRegion,
      homeRegion: regionOfFighter(fighter),
    });
    // A win on a local card is not noticed the way a main promotion win is.
    const scale = popularityScaleFor(save, bout);
    if (scale !== 1) {
      change.delta *= scale;
      for (const k of Object.keys(change.regional)) change.regional[k] *= scale;
    }
    applyPopularity(fighter, change);
    applyFameChange(fighter, fameFromResult(fighter, result, bout.isMainEvent));
    applyFollowerChange(fighter, socialFromResult(fighter, result, bout.isMainEvent));
    fighter.publicLabels = derivePublicLabels(save, fighter);

    // Gym record.
    if (fighter.gymId) {
      const gym = save.gyms[fighter.gymId];
      if (gym) {
        if (won) gym.recentResults.wins++;
        else if (!drew) gym.recentResults.losses++;
      }
    }
    void opponent;
  }

  // A close or damaging fight leaves something between them.
  if (result.method === 'decision-split' || result.fightQuality > 78) {
    escalateRivalry(
      save,
      a.id,
      b.id,
      isChampionshipBout(bout) ? 'championship' : 'competitive',
      result.method === 'decision-split' ? 26 : 16,
      result.method === 'decision-split' ? 'a split decision neither man accepted' : 'a fight that demanded a second meeting'
    );
  }

  // The fight itself moves the relationship between the two fighters.
  recordFightBetween(save, a.id, b.id, result.boutId, result.winnerId, result.fightQuality > 70);

  if (regional) {
    // The regional circuit settles its own standings and belt. None of the main promotion's
    // rankings, titles or contender claims are touched by a regional bout.
    applyRegionalResult(save, bout, result, rng);
    refreshPlayerPotAfterFight(save, a, b);
    for (const f of [a, b]) {
      f.ratingHistory.push({
        date: result.date,
        ratings: historyRatings(f.ratings),
        ovr: ovrDisplayed(historyRatings(f.ratings)),
        pot: f.pot,
        longevity: f.longevity,
        reason: `after ${result.winnerId === f.id ? 'beating' : result.winnerId === null ? 'drawing with' : 'losing to'} ${f.id === a.id ? b.name : a.name}${amateur ? ' as an amateur' : ''}`,
      });
      notePeakOvr(f, result.date);
    }
    return;
  }

  // Rankings and titles.
  applyResultToRankings(save, result, shortNoticeA, shortNoticeB);
  // Read before the title outcome is applied, so a gym can be credited for crowning a champion
  // rather than for every title bout that champion subsequently wins.
  const championBefore = save.rankings[bout.divisionId]?.championId ?? null;
  const titleNotes = applyTitleOutcome(save, result);
  // Winning an eliminator earns the number one contender position, and the standing contender
  // losing gives it up. Without this an eliminator was a label that meant nothing.
  // Published here only, with the division tag and below title-change importance. They used to
  // go into titleNotes as well, so every contender headline appeared twice and the second copy
  // was weighted like a change of champion.
  for (const note of applyResultToContenders(save, bout, result)) {
    pushNews(save, {
      date: result.date,
      headline: note,
      body: result.narrativeSummary,
      tags: ['title', bout.divisionId],
      fighterIds: [bout.fighterAId, bout.fighterBId],
      importance: 3,
    });
  }
  // When the belt settles the ordinary way, the result headline already says who defended or
  // took it, so the matching plain note would be the same story twice at the same importance.
  // Notes that add something (a missed weight, a vacancy, an interim belt folded in) still run.
  const winnerName = result.winnerId ? save.fighters[result.winnerId]?.name : undefined;
  const headlined =
    event && (result.titleIneligibleFighterIds ?? []).length === 0 && winnerName
      ? new Set([
          `${winnerName} defends the title.`,
          `${winnerName} is the new champion.`,
          `${winnerName} defends the interim title.`,
          `${winnerName} wins the interim title.`,
        ])
      : new Set<string>();
  for (const note of titleNotes) {
    if (headlined.has(note)) continue;
    pushNews(save, { date: result.date, headline: note, body: result.narrativeSummary, tags: ['title'], fighterIds: [a.id, b.id], importance: 5 });
  }
  if (result.isTitleFight && result.winnerId && result.winnerId !== championBefore) {
    // Counted once, when a fighter first takes a belt. It used to be counted on every title bout
    // won, so a champion with five defences added six to their gym's total on their own and the
    // figure stopped meaning the number of champions the gym had produced.
    const winner = save.fighters[result.winnerId];
    if (winner.gymId && winner.titleReigns <= 1) {
      const gym = save.gyms[winner.gymId];
      if (gym) gym.championsProduced++;
    }
  }

  refreshPlayerPotAfterFight(save, a, b);
  // Rating history entry so a fighter page can show the shape of a career.
  for (const f of [a, b]) {
    f.ratingHistory.push({
      date: result.date,
      ratings: historyRatings(f.ratings),
      ovr: ovrDisplayed(historyRatings(f.ratings)),
      pot: f.pot,
      longevity: f.longevity,
      reason: `after ${result.winnerId === f.id ? 'beating' : result.winnerId === null ? 'drawing with' : 'losing to'} ${f.id === a.id ? b.name : a.name}`,
    });
    notePeakOvr(f, result.date);
  }
}

/**
 * What a fighter earns from their points on the gate for this bout.
 *
 * Contract terms express points as dollars per thousand buys, which is only meaningful on a card
 * that sells pay per view. A fight night pays none, and a contract without points pays none.
 */
function ppvPointsEarned(save: SaveGame, fighter: Fighter, buys: number | null): number {
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const rate = contract?.terms.ppvPoints ?? 0;
  if (rate <= 0) return 0;
  if (!buys || buys <= 0) return 0;
  return Math.round((buys / 1000) * rate);
}

/**
 * Pays every fighter on the card their points on the gate.
 *
 * Points used to be read while each bout was settled, before the card's buys existed, so they
 * were always zero: a champion who negotiated points earned exactly what one who did not earned.
 * The buys are passed in from the business figures just computed rather than read back from the
 * store, which is emptied when business depth is switched off. No rng is drawn here.
 */
function payPpvPoints(save: SaveGame, results: FightResult[], buys: number | null): void {
  if (!buys || buys <= 0) return;
  for (const r of results) {
    for (const fid of [r.fighterAId, r.fighterBId]) {
      const f = save.fighters[fid];
      if (!f) continue;
      const points = ppvPointsEarned(save, f, buys);
      if (points <= 0) continue;
      f.careerEarnings += points;
      f.lastPurse = (f.lastPurse ?? 0) + points;
      // The player's points pay commission, the gym's share and tax like the rest of the purse.
      if (save.player.fighterId === fid) applyPpvPoints(save, f, r.boutId, points);
    }
  }
}

/** Resolves every remaining bout on an event and closes it out. */
/** The bout a bonus belongs to, so the ledger entry points at the right fight. */
function bonusBoutIdFor(save: SaveGame, event: FightCardEvent, fighterId: string): string | null {
  for (const id of event.contestedBoutIds) {
    const bout = save.bouts[id];
    if (bout && (bout.fighterAId === fighterId || bout.fighterBId === fighterId)) return id;
  }
  return null;
}

export function resolveEvent(
  save: SaveGame,
  eventId: string,
  rng: Rng,
  detailCtx: DetailContext = {},
  /**
   * Results already resolved for this card before this call.
   *
   * The player's bout is resolved separately so the interface can play it back, which removed it
   * from this function's view of the card entirely: it was excluded from the contested list and
   * from bonus selection, so a player could never win Fight of the Night or a performance bonus
   * however good the fight was.
   */
  preResolved: FightResult[] = []
): FightResult[] {
  const event = save.events[eventId];
  if (!event || event.status === 'completed') return [];
  const results: FightResult[] = [...preResolved];

  event.weighInBoutIds = event.boutIds.filter((id) => save.bouts[id]?.status === 'scheduled');
  // Highest bout order first, which is the main event. The resolution order is part of the seeded
  // sequence, so it is deliberately left alone: changing it would change every fight in every
  // existing save. Anything that wants the main event must find it by its flag, not by position.
  const ordered = [...event.boutIds]
    .map((id) => save.bouts[id])
    .filter((b): b is Bout => Boolean(b) && b.status === 'scheduled')
    .sort((x, y) => y.boutOrder - x.boutOrder);

  for (const bout of ordered) {
    results.push(resolveBout(save, bout, rng, undefined, detailCtx));
  }

  event.contestedBoutIds = results.map((r) => r.boutId);
  if (event.promotionId) {
    // A regional card has no bonuses, no pay per view and no main promotion business. The crowd is
    // what the promotion's level draws.
    const promotion = promotionConfig(event.promotionId);
    const band = promotion ? REGIONAL_LEVELS[promotion.level].attendance : ([400, 1500] as [number, number]);
    const draw = results.reduce((sum, r) => sum + ((save.fighters[r.fighterAId]?.popularity ?? 0) + (save.fighters[r.fighterBId]?.popularity ?? 0)) / 2, 0) / Math.max(1, results.length);
    event.drawScore = Math.round(draw);
    event.attendance = Math.round(band[0] + (band[1] - band[0]) * clamp(draw / 25, 0.15, 1));
    event.status = 'completed';
    return results;
  }
  const bonuses = assignEventBonuses(results, event.bonusAmount, rng);
  event.fightOfTheNightBoutId = bonuses.fightOfTheNightBoutId;
  event.performanceBonusFighterIds = bonuses.performanceFighterIds;
  for (const fid of bonuses.performanceFighterIds) {
    const f = save.fighters[fid];
    if (f) {
      f.careerEarnings += event.bonusAmount;
      f.awards.push(`Performance of the Night, ${event.name}`);
      f.relationships.matchmaker = clamp(f.relationships.matchmaker + 3, 0, 100);
      if (f.fame) {
        f.fame.favorability = clamp(f.fame.favorability + 2.5, 1, 100);
        f.fame.hardcoreRespect = clamp(f.fame.hardcoreRespect + 3, 1, 100);
      }
      // Through the ledger, so the money survives. Adding it to `player.balance` directly meant
      // the next ledger write reset the balance from `finance.cash` and erased the award.
      if (save.player.fighterId === fid) {
        applyBonusAward(save, f, bonusBoutIdFor(save, event, fid), event.bonusAmount, `Performance of the Night, ${event.name}`);
      }
    }
  }
  for (const note of bonuses.notes) {
    pushNews(save, {
      date: save.date,
      headline: `${event.name} bonuses`,
      body: note,
      tags: ['bonus'],
      fighterIds: [],
      importance: 1,
    });
  }
  if (bonuses.fightOfTheNightBoutId) {
    const r = save.history.results[bonuses.fightOfTheNightBoutId];
    if (r) {
      for (const fid of [r.fighterAId, r.fighterBId]) {
        const f = save.fighters[fid];
        if (f) {
          f.careerEarnings += event.bonusAmount;
          f.awards.push(`Fight of the Night, ${event.name}`);
          f.relationships.matchmaker = clamp(f.relationships.matchmaker + 4, 0, 100);
          if (f.fame) {
            f.fame.favorability = clamp(f.fame.favorability + 3.5, 1, 100);
            f.fame.hardcoreRespect = clamp(f.fame.hardcoreRespect + 4.5, 1, 100);
          }
          if (save.player.fighterId === fid) {
            applyBonusAward(save, f, bonuses.fightOfTheNightBoutId, event.bonusAmount, `Fight of the Night, ${event.name}`);
          }
        }
      }
    }
  }

  // Always computed, because it consumes the shared world rng. Gating the call itself would make
  // a settings toggle shift every later draw and change the whole world, which is the determinism
  // rule this codebase has broken three times. The flag decides whether the figures are kept.
  const business = computeEventBusiness(save, event, rng);
  payPpvPoints(save, results, business.ppvBuys);
  if (!featureEnabled(save.settings, 'businessDepth')) {
    delete businessStore(save)[event.id];
  }
  void business;
  const venue = VENUE_CITIES.find((v) => v.city === event.city);
  const drawFactor = results.reduce((s, r) => {
    const a = save.fighters[r.fighterAId];
    const b = save.fighters[r.fighterBId];
    return s + ((a?.popularity ?? 0) + (b?.popularity ?? 0)) / 2;
  }, 0) / Math.max(1, results.length);
  event.drawScore = Math.round(drawFactor);
  event.attendance = venue ? Math.round(venue.capacity * clamp(0.55 + drawFactor / 160, 0.4, 1)) : null;
  event.status = 'completed';

  return results;
}

// ---------------------------------------------------------------------------
// Weekly world maintenance
// ---------------------------------------------------------------------------

/**
 * Keeps a decades long save from growing without bound.
 *
 * Full play by play for every fight ever contested is the single largest thing a save
 * stores. Recent fights and every fight the player was involved in keep their complete
 * event stream. Older fights keep their totals, scorecards, round scores and result,
 * which is everything the record books, fighter pages and history pages actually read.
 *
 * The tiers, counted back from the newest fight:
 * - up to 40: everything;
 * - 41 to 220: the closing ten events of the play by play, and every round statistic;
 * - 221 to 400: the closing ten events, with the round by round statistics dropped;
 * - beyond 400: no play by play, and the round notes and full precision damage readings go
 *   too. What is left is the result, totals, scorecards, round scores and recap.
 */
const KEEP_FULL_EVENTS_FIGHTS = 40;
/** Fights that keep their round by round statistics. */
const KEEP_ROUND_STATS_FIGHTS = 220;
/** Fights that keep a trimmed closing sequence. Beyond this the event stream is dropped. */
const KEEP_CLOSING_EVENTS_FIGHTS = 400;
/** Events kept from the end of a trimmed fight. */
const CLOSING_EVENTS = 10;

/**
 * How long the promotion waits before approaching a fighter it released.
 *
 * A deal that runs its course is renewed within a month. Being let go for refusing fights is a
 * different thing and costs the fighter most of a year in the wilderness, which is the point of
 * the sanction. It is a wait rather than a permanent exile: before this, a released player was
 * never approached again by anything, while the career screen promised an offer was coming.
 */
export const RELEASE_RETURN_DAYS = 300;

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function pruneHistory(save: SaveGame): { prunedEvents: number; prunedRounds: number; archived: number } {
  const results = Object.values(save.history.results).sort((a, b) => (a.date < b.date ? 1 : -1));
  let prunedEvents = 0;
  let prunedRounds = 0;
  let archived = 0;
  const playerId = save.player.fighterId;

  results.forEach((r, index) => {
    const playerFight = playerId !== null && (r.fighterAId === playerId || r.fighterBId === playerId);
    if (playerFight) return;
    if (index < KEEP_FULL_EVENTS_FIGHTS) return;
    // The closing sequence is kept so a finish can still be described accurately, then
    // dropped entirely once the fight is far enough into the past. The recap, totals,
    // scorecards and result survive either way. Counted only when something changes, so a
    // fight trimmed on an earlier pass is not counted again every week.
    if (index > KEEP_CLOSING_EVENTS_FIGHTS) {
      if (r.events.length > 0) {
        r.events = [];
        prunedEvents++;
      }
    } else if (r.events.length > CLOSING_EVENTS) {
      r.events = r.events.slice(-CLOSING_EVENTS);
      prunedEvents++;
    }
    if (index > KEEP_ROUND_STATS_FIGHTS) {
      for (const round of r.rounds) {
        if (round.statsA === undefined) continue;
        // Deleting the properties is what actually shrinks the save. Replacing them with
        // zeroed objects serializes to almost the same number of bytes.
        delete round.statsA;
        delete round.statsB;
        delete round.damageEndA;
        delete round.damageEndB;
        delete round.staminaEndA;
        delete round.staminaEndB;
        prunedRounds++;
      }
    }
    if (index > KEEP_CLOSING_EVENTS_FIGHTS && r.rounds.some((round) => round.summary !== '' || round.keyMomentSeq !== null)) {
      // The cold tier. A round note is only ever shown beside the play by play, which is gone by
      // now, and the key moment points into that same stream. The round scores stay, because
      // title rematch decisions read who won each round. The final damage and cost readings are
      // shown rounded on the fight page and are read by nothing else after the fight.
      for (const round of r.rounds) {
        round.summary = '';
        round.keyMomentSeq = null;
      }
      for (const d of [r.finalDamageA, r.finalDamageB]) {
        if (!d) continue;
        for (const k of Object.keys(d) as (keyof typeof d)[]) if (typeof d[k] === 'number') d[k] = round1(d[k]);
      }
      if (typeof r.finalStaminaA === 'number') r.finalStaminaA = round1(r.finalStaminaA);
      if (typeof r.finalStaminaB === 'number') r.finalStaminaB = round1(r.finalStaminaB);
      if (typeof r.longevityCostA === 'number') r.longevityCostA = round1(r.longevityCostA);
      if (typeof r.longevityCostB === 'number') r.longevityCostB = round1(r.longevityCostB);
      archived++;
    }
  });
  return { prunedEvents, prunedRounds, archived };
}

/**
 * Whether a new injury takes a fighter other than the player out of a booked bout.
 *
 * The player is never withdrawn here. Their injury becomes a decision with the booking attached,
 * raised by checkPlayerInjuries in the same weekly pass; withdrawing them first took the fight away
 * in silence and left the doctor saying no fight was booked. Other fighters are withdrawn only when
 * the injury will not clear at least a week before the bout. Any blocking injury used to be enough,
 * so a five week rib injury cost a fighter a booking four months away.
 */
function injuryForcesWithdrawal(injury: { blocksCompetition: boolean; expectedReturn: IsoDate }, bout: Bout): boolean {
  if (!injury.blocksCompetition) return false;
  return injury.expectedReturn > addDays(bout.date, -7);
}

/**
 * The last health check before a card. A fighter booked with an injury expected to clear in time
 * keeps the booking, so one whose recovery slipped, or who was hurt again, is withdrawn here rather
 * than walking out hurt. The player is not: their injury is a decision, and a medically contingent
 * booking of theirs is enforced when fight week begins.
 */
function fightWeekHealthCheck(save: SaveGame, rng: Rng, headlines: string[]): void {
  const playerFighterId = save.player.fighterId;
  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled') continue;
    const days = daysBetween(save.date, bout.date);
    if (days <= 0 || days > FIGHT_WEEK_DAYS + 1) continue;
    for (const id of [bout.fighterAId, bout.fighterBId]) {
      if (id === playerFighterId) continue;
      const f = save.fighters[id];
      if (!f || f.retired || canCompete(f, bout.date).ok) continue;
      withdrawFromBout(save, bout, id, 'an injury that did not clear in time', rng, headlines);
      break;
    }
  }
}

/**
 * The weekly pass runs with the live camp index in place, because it asks every fighter which camp
 * they are in, and several of the checks it calls ask again.
 */
function weeklyMaintenance(save: SaveGame, rng: Rng, headlines: string[]): void {
  withLiveCampIndex(save, () => runWeeklyMaintenance(save, rng, headlines));
}

function runWeeklyMaintenance(save: SaveGame, rng: Rng, headlines: string[]): void {
  const diff = DIFFICULTY[save.settings.difficulty];
  const playerFighterId = save.player.fighterId;

  // Safety sweep. A bout whose date has passed without being resolved would otherwise
  // hold both fighters out of matchmaking permanently.
  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled' || bout.date >= save.date) continue;
    const event = save.events[bout.eventId];
    if (event && event.status === 'announced') continue;
    cancelBout(save, bout, 'The bout was never contested and has been removed from the record.');
  }
  // Clear stale booking pointers.
  for (const f of Object.values(save.fighters)) {
    if (!f.nextBoutId) continue;
    const b = save.bouts[f.nextBoutId];
    if (!b || b.status !== 'scheduled') f.nextBoutId = null;
  }

  for (const fighter of Object.values(save.fighters)) {
    if (fighter.retired) continue;

    // Injury healing.
    for (const inj of fighter.injuries) {
      if (inj.actualReturn === null && inj.expectedReturn <= save.date) {
        inj.actualReturn = save.date;
        if (fighter.id === playerFighterId) {
          headlines.push(`${fighter.name} is cleared from ${inj.type.toLowerCase()}.`);
        }
      }
    }
    if (fighter.medicalSuspension && fighter.medicalSuspension.until <= save.date) {
      fighter.medicalSuspension = null;
    }
    if (clearExpiredSuspensions(save, fighter) && fighter.id === playerFighterId) {
      headlines.push(`${fighter.name} is eligible to compete again.`);
    }

    // Camps.
    const camp = liveCampOf(save, fighter.id);
    if (camp && camp.startDate <= save.date && camp.endDate > save.date) {
      const week = runCampWeek(save, camp, rng);
      if (fighter.id === playerFighterId) {
        for (const o of week.outcomes) headlines.push(`Camp: ${o.headline}.`);
      }
      if (week.injured && fighter.nextBoutId && fighter.id !== playerFighterId) {
        // A camp injury can force a withdrawal, judged on the injury this week added.
        const bout = save.bouts[fighter.nextBoutId];
        const fresh = fighter.injuries[fighter.injuries.length - 1];
        if (bout && fresh && injuryForcesWithdrawal(fresh, bout)) withdrawFromBout(save, bout, fighter.id, 'injured in camp', rng, headlines);
      }
    } else if (camp && camp.endDate <= save.date && camp.status !== 'complete') {
      finalizeCamp(save, camp, rng);
    } else {
      // Out of camp development and recovery.
      const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
      const capacity = trainingCapacityOf(fighter, save.date);
      const coachQuality = gym ? gym.staffIds.map((id) => save.staff[id]?.quality ?? 0).reduce((s, q, _, arr) => s + q / arr.length, 0) : 20;
      const deltas = developWeek(
        fighter,
        save.date,
        {
          // Capacity is applied once, by developWeek through trainingCapacity. Folding it in here
          // as well squared every injury's restriction.
          trainingQuality: 0.42,
          focus: evenFocus(),
          coaching: coachQuality,
          partners: gym ? gym.trainingPartners : { striking: 25, grappling: 25, wrestling: 25, submissions: 25, cardio: 25, durability: 25 },
          activity: fighter.lastFightDate ? clamp(1 - daysBetween(fighter.lastFightDate, save.date) / 500, 0, 1) : 0.4,
          longevity: fighter.longevity,
          difficultyScale: fighter.id === playerFighterId ? diff.developmentScale : 1,
          trainingCapacity: capacity,
        },
        rng
      );
      fighter.ratings = applyDeltas(fighter.ratings, deltas);
      notePeakOvr(fighter, save.date);
      restRecovery(fighter, 1);

      // The roll always happens, because it draws from the shared world rng. The setting decides
      // whether the injury is applied, not whether the draw occurs.
      if (gym) {
        const injury = rollTrainingInjury(
          fighter,
          {
            intensity: 0.42,
            hardSparring: gym.hardSparringTendency * 0.6,
            safety: gym.safety,
            cause: 'training',
            difficultyScale: fighter.id === playerFighterId ? diff.injuryScale : 1,
          },
          save.date,
          rng
        );
        if (injury && save.settings.injuriesEnabled) {
          fighter.injuries.push(injury);
          if (injury.severity >= 4) invalidatePot(save, fighter.id, 'major-injury');
          if (fighter.id === playerFighterId) headlines.push(`${injury.type} picked up in training.`);
          if (fighter.nextBoutId && fighter.id !== playerFighterId) {
            const bout = save.bouts[fighter.nextBoutId];
            if (bout && injuryForcesWithdrawal(injury, bout)) withdrawFromBout(save, bout, fighter.id, 'injured in training', rng, headlines);
          }
        }
      }
    }

    decayPopularity(fighter, save);
    decayFame(fighter, save);
    decaySocial(fighter, save);
    // Recorded for every fighter, not only the ones losing reach, so a growing account has a
    // history to show rather than a blank chart.
    recordSocialHistory(fighter, save);
    if (fighter.fame) fighter.fame.drawingPower = computeDrawingPower(fighter);
    updateHappiness(save, fighter);

    const previousDivision = fighter.divisionId;
    // A regional fighter other than the player keeps to the division the circuit runs. Their walking
    // weight is still managed; the division move, with its main promotion news, is not theirs to make.
    const isPlayer = fighter.id === playerFighterId;
    // Nobody changes division under a booked bout, which was cancelled later the same week for it,
    // and the player is never moved at all: their team asks them instead.
    const weight =
      fighter.circuit && !isPlayer
        ? { movedUp: null, wantsMove: null }
        : manageWalkingWeight(fighter, save.date, !isPlayer && !hasLiveBooking(save, fighter));
    if (isPlayer && weight.wantsMove) {
      const note = raiseForcedMoveDecision(save, fighter, weight.wantsMove);
      if (note) headlines.push(note);
    }
    // The vacate and table bookkeeping below is for the automatic move, which only an NPC makes.
    // The player's move goes through commitMove, which does its own.
    if (weight.movedUp) {
      const to = DIVISIONS.find((d) => d.id === weight.movedUp)!;
      // A champion who leaves the division vacates the title rather than holding it in a
      // weight class they no longer compete in.
      const oldTable = save.rankings[previousDivision];
      if (oldTable.championId === fighter.id) {
        oldTable.championId = null;
        fighter.isChampion = false;
        const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim);
        if (reign) {
          reign.lostOn = save.date;
          reign.endReason = 'vacated';
        }
        pushNews(save, {
          date: save.date,
          headline: `${DIVISIONS.find((d) => d.id === previousDivision)!.name} title is vacated`,
          body: `${fighter.name} is moving up and has vacated the title.`,
          tags: ['title', previousDivision],
          fighterIds: [fighter.id],
          importance: 5,
        });
      }
      if (oldTable.interimChampionId === fighter.id) {
        oldTable.interimChampionId = null;
        fighter.isInterimChampion = false;
      }
      oldTable.entries = oldTable.entries.filter((e) => e.fighterId !== fighter.id);
      invalidatePot(save, fighter.id, 'division-change');
      pushNews(save, {
        date: save.date,
        headline: `${fighter.name} moves up to ${to.name}`,
        body: `The cut is no longer sustainable. ${fighter.name} will campaign at ${to.name} and starts unranked in the new division.`,
        tags: ['roster', to.id],
        fighterIds: [fighter.id],
        importance: 2,
      });
    }
  }

  // Fighter autonomy in Coach Mode.
  if (save.player.gymId) {
    const gym = save.gyms[save.player.gymId];
    if (gym) {
      for (const fid of [...gym.fighterIds]) {
        const f = save.fighters[fid];
        if (!f || f.retired) continue;
        const action = rollFighterAutonomy(save, f, rng);
        if (action.kind === 'none') continue;
        if (action.kind === 'leave') {
          moveFighterToGym(save, f.id, action.newGymId);
          addInboxMessage(save, {
            sender: 'fighter',
            senderName: f.name,
            subject: `${f.name} is leaving the gym`,
            body: action.message,
            category: 'gym',
            requiresAction: false,
            choices: [{ key: 'ack', label: 'Acknowledge' }],
            linkedFighterId: f.id,
          });
          headlines.push(`${f.name} has left the gym.`);
        } else {
          addInboxMessage(save, {
            sender: 'fighter',
            senderName: f.name,
            subject: subjectForAutonomy(action.kind),
            body: action.message,
            category: 'gym',
            requiresAction: true,
            choices: choicesForAutonomy(action.kind),
            linkedFighterId: f.id,
          });
        }
      }
    }
  }

  // Rankings pass.
  const reasons = new Map<string, string>();
  for (const d of DIVISIONS) {
    const update = recomputeDivision(save, d.id, reasons);
    for (const c of update.changes) {
      const f = save.fighters[c.fighterId];
      if (!f) continue;
      if (save.player.fighterId === c.fighterId && c.from !== c.to) {
        addInboxMessage(save, {
          sender: 'system',
          senderName: 'Rankings update',
          subject: c.to === null ? 'Dropped out of the rankings' : `Now ranked number ${c.to}`,
          body:
            c.to === null
              ? `${f.name} is no longer in the divisional top fifteen. Reason: ${c.reason}.`
              : `${f.name} moves ${c.from === null ? 'into the rankings' : c.from > c.to ? `up from ${c.from}` : `down from ${c.from}`} to number ${c.to}. Reason: ${c.reason}.`,
          category: 'ranking',
          requiresAction: false,
          choices: [{ key: 'ack', label: 'Acknowledge' }],
          linkedFighterId: f.id,
        });
      }
    }
  }
  save.pfp = recomputePfp(save);

  // Career milestones, checked once a week against what the career has actually done.
  // The headline carries the name because the item sits in the world feed beside everyone else's
  // news, where a bare "First finish" read as nobody's. The stored label stays bare for the
  // achievements list, which is already the player's own.
  const milestoneName = save.player.fighterId ? save.fighters[save.player.fighterId]?.name : undefined;
  for (const label of recordAchievements(save)) {
    pushNews(save, {
      date: save.date,
      headline: milestoneName ? `${milestoneName}: ${label}` : label,
      body: `A career milestone: ${label.charAt(0).toLowerCase()}${label.slice(1)}.`,
      tags: ['career'],
      fighterIds: save.player.fighterId ? [save.player.fighterId] : [],
      importance: 2,
    });
  }

  // A fighter who moved up for a single bout goes home once that bout has happened.
  for (const note of settleOneFightMoves(save)) {
    pushNews(save, {
      date: save.date,
      headline: note,
      body: note,
      tags: ['division'],
      fighterIds: [],
      importance: 2,
    });
  }

  // Rivalries cool when nothing keeps them alive, and are forgotten once there is nothing left
  // in them. Without this they only ever climbed and the store never shrank.
  decayRivalries(save);

  // The tables are the record of who holds what, so the flags on the fighter are brought back
  // into line with them here rather than relying on every path that changes a title remembering
  // to clear the previous holder. One that did not left two fighters flagged as champion of the
  // same division.
  reconcileChampionFlags(save);

  // An interim champion is held to the same standard as an undisputed one. Nothing stripped or
  // expired them before, so an interim champion who was suspended, released or simply stopped
  // fighting kept the belt for ever, and the stale pointer blocked the division from ever
  // creating another interim title.
  for (const d of DIVISIONS) {
    const table = save.rankings[d.id];
    if (!table.interimChampionId) continue;
    const interim = save.fighters[table.interimChampionId];
    if (!interim) {
      table.interimChampionId = null;
      continue;
    }
    const booked = interim.nextBoutId ? save.bouts[interim.nextBoutId] : null;
    if (booked && booked.status === 'scheduled') continue;
    const quiet = interim.lastFightDate ? daysBetween(interim.lastFightDate, save.date) : 999;
    const unavailable = !canCompete(interim, save.date).ok;
    if (quiet > 550 || (unavailable && quiet > 430) || interim.retired || interim.activityStatus !== 'active') {
      table.interimChampionId = null;
      interim.isInterimChampion = false;
      const reign = save.history.reigns.find((r) => r.fighterId === interim.id && r.lostOn === null && r.isInterim);
      if (reign) {
        reign.lostOn = save.date;
        reign.endReason = 'stripped';
      }
      pushNews(save, {
        date: save.date,
        headline: `${interim.name} is stripped of the interim ${d.name} title`,
        body: `${quiet} days have passed without a defense of the interim championship. The interim title is vacant.`,
        tags: ['title', d.id],
        fighterIds: [interim.id],
        importance: 4,
      });
      headlines.push(`${d.name} interim title vacated.`);
    }
  }

  // A champion who cannot defend for long enough is stripped and the title is vacated,
  // which is what stops an injured or inactive champion from freezing a whole division.
  for (const d of DIVISIONS) {
    const table = save.rankings[d.id];
    if (!table.championId) continue;
    const champ = save.fighters[table.championId];
    if (!champ) {
      table.championId = null;
      continue;
    }
    // A champion with a defence already booked is not inactive, they are days from fighting.
    // Stripping them here vacated the belt while the bout stayed on the card flagged as a title
    // fight, which is the same contradiction from the other end. The retirement pass has always
    // had this exemption; the strip pass did not.
    const liveBooking = champ.nextBoutId ? save.bouts[champ.nextBoutId] : null;
    if (liveBooking && liveBooking.status === 'scheduled') continue;
    const inactive = champ.lastFightDate ? daysBetween(champ.lastFightDate, save.date) : 999;
    const blocked = !canCompete(champ, save.date).ok;
    if (inactive > 550 || (blocked && inactive > 430) || champ.retired || champ.activityStatus !== 'active') {
      table.championId = null;
      champ.isChampion = false;
      // Stripped for inactivity is still a former champion, and they rejoin the rankings near the
      // top rather than dropping out of the division they were champion of.
      seedDeposedChampion(save, d.id, champ.id);
      const reign = save.history.reigns.find((r) => r.fighterId === champ.id && r.lostOn === null && !r.isInterim);
      if (reign) {
        reign.lostOn = save.date;
        reign.endReason = 'stripped';
      }
      // An interim champion is promoted rather than leaving the division without a title.
      if (table.interimChampionId) {
        const promoted = save.fighters[table.interimChampionId];
        if (promoted) {
          table.championId = promoted.id;
          promoted.isChampion = true;
          promoted.isInterimChampion = false;
          promoted.titleReigns++;
          table.interimChampionId = null;
          const interimReign = save.history.reigns.find((r) => r.fighterId === promoted.id && r.lostOn === null && r.isInterim);
          if (interimReign) {
            interimReign.lostOn = save.date;
            interimReign.endReason = 'promoted';
          }
          save.history.reigns.push({
            id: `reign-${d.id}-${save.date}-${promoted.id}`,
            divisionId: d.id,
            fighterId: promoted.id,
            isInterim: false,
            wonOn: save.date,
            wonBoutId: null,
            lostOn: null,
            lostBoutId: null,
            defenses: 0,
            endReason: null,
          });
          pushNews(save, {
            date: save.date,
            headline: `${promoted.name} is promoted to undisputed ${d.name} champion`,
            body: `${champ.name} has been stripped of the title after ${inactive} days without a defense. The interim champion is elevated.`,
            tags: ['title', d.id],
            fighterIds: [promoted.id, champ.id],
            importance: 5,
          });
        }
      } else {
        // With the undisputed title vacant there is nothing for an interim belt to stand
        // in for, so a scheduled interim bout is upgraded rather than left to crown an
        // interim champion of a division that has no champion at all.
        for (const b of Object.values(save.bouts)) {
          if (b.status !== 'scheduled' || b.divisionId !== d.id || !b.isInterimTitleFight) continue;
          b.isInterimTitleFight = false;
          b.isTitleFight = true;
          b.bookingReason = joinSentence(b.bookingReason, 'Upgraded to an undisputed title bout after the championship was vacated.');
        }
        // An open interim offer has to be upgraded with the bouts. Leaving it alone let the player
        // accept an interim championship for a division that no longer had a champion to stand in
        // for, which is a belt that cannot mean anything.
        for (const o of Object.values(save.fightOffers)) {
          if (o.status !== 'open' || o.divisionId !== d.id || !o.isInterimTitleFight) continue;
          o.isInterimTitleFight = false;
          o.isTitleFight = true;
          o.reason = `${o.reason}. Upgraded to an undisputed title bout after the championship was vacated.`;
          o.rankingImplication = 'Undisputed championship on the line.';
        }
        pushNews(save, {
          date: save.date,
          headline: `${champ.name} is stripped of the ${d.name} title`,
          body: `${inactive} days have passed without a defense. The title is vacant and the next available contenders will fight for it.`,
          tags: ['title', d.id],
          fighterIds: [champ.id],
          importance: 5,
        });
      }
      headlines.push(`${d.name} title vacated.`);
    }
  }

  // Interim titles when a champion is unavailable for a long time. The condition holds for
  // months at a stretch, so the announcement is made once, when the interim bout is not
  // yet on the books, rather than every weekly pass.
  // The rule is the one the booking pass uses. A separate looser rule used to drive this news,
  // so it could announce an interim title the matchmaker would never make, or stay silent when
  // one was booked because the champion was suspended or campaigning elsewhere.
  for (const d of DIVISIONS) {
    const justification = interimTitleJustification(save, d.id);
    if (!justification.justified) continue;
    const alreadyAnnounced = save.history.news.some(
      (n) => n.tags.includes(d.id) && n.headline === `${d.name} interim title in play` && daysBetween(n.date, save.date) < 240
    );
    if (alreadyAnnounced) continue;
    pushNews(save, {
      date: save.date,
      headline: `${d.name} interim title in play`,
      body: `${justification.explanation} The next top contender bout in the division will be for the interim belt.`,
      tags: ['title', d.id],
      fighterIds: [],
      importance: 4,
    });
  }

  // Contract expiry and renewal. The regional circuit renews its own deals.
  for (const fighter of Object.values(save.fighters)) {
    if (fighter.retired || fighter.circuit) continue;
    const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
    // A released fighter is out of contract just as much as one whose deal ran out. Only the
    // expired case was handled, so a player released for refusing fights was never approached
    // again by anyone, for ever, while the career screen told them a new offer was coming.
    // A released player is out of contract just as much as one whose deal ran out, and only the
    // expired case was handled, so a player released for refusing fights was never approached
    // again while the career screen promised a new offer. This applies to the player alone: for
    // an NPC the branch below decides between re-signing and releasing, and letting a released
    // NPC back in re-released them every week and re-published the same news item for ever.
    const released = contract?.status === 'released' && fighter.id === playerFighterId;
    if (!contract || (contract.status !== 'expired' && !released)) continue;
    if (fighter.id === playerFighterId) {
      // One offer at a time. A fresh one is issued only after the previous one has been
      // off the table for a while, so ignoring a deal does not flood the inbox.
      const existing = Object.values(save.contractOffers).filter((o) => o.fighterId === fighter.id);
      if (existing.some((o) => o.status === 'open')) continue;
      const latest = existing.sort((x, y) => (x.createdOn > y.createdOn ? -1 : 1))[0];
      if (latest && daysBetween(latest.createdOn, save.date) < 28) continue;
      // A deal that ran out on a losing run is not renewed. The player used to be re-signed after
      // any record, so an 0-4 run ended in a fresh four fight deal while an NPC with the same
      // results was cut. The test is the NPC one with a margin, so one bad night does not end a
      // career: no leverage, no current win streak and at least two straight losses.
      if (!released && computeLeverage(fighter, save).score <= 22 && fighter.winStreak === 0 && fighter.lossStreak >= 2) {
        contract.status = 'released';
        contract.endCondition = 'released';
        // The release date is what the wait before any new approach is counted from. Without it
        // the next weekly pass would read the wait as served and re-offer at once.
        contract.endDate = save.date;
        fighter.activityStatus = 'released';
        addInboxMessage(save, {
          sender: 'contract-rep',
          senderName: PROMOTION_CONTRACTS,
          subject: 'Contract not renewed',
          body: `The current deal is complete and ${PROMOTION_NAME} is not renewing it. After ${fighter.lossStreak} straight losses, ${fighter.name} is released. The promotion does look again at fighters it has let go, but not for most of a year.`,
          category: 'contract',
          requiresAction: false,
          choices: [{ key: 'ack', label: 'Acknowledge' }],
          linkedFighterId: fighter.id,
        });
        pushNews(save, {
          date: save.date,
          headline: `${fighter.name} is released`,
          body: `${fighter.name} has been let go after ${fighter.lossStreak} straight losses.`,
          tags: ['roster'],
          fighterIds: [fighter.id],
          importance: 2,
        });
        continue;
      }
      // Being let go is not the same as a deal running its course. The promotion takes most of a
      // year to come back.
      if (released) {
        const since = contract.endDate ? daysBetween(contract.endDate, save.date) : RELEASE_RETURN_DAYS;
        if (since < RELEASE_RETURN_DAYS) continue;
      }
      const offer = createContractOffer(fighter, save, rng);
      save.contractOffers[offer.id] = offer;
      addInboxMessage(save, {
        sender: 'contract-rep',
        senderName: PROMOTION_CONTRACTS,
        subject: 'New contract offer',
        body: `The current deal is complete. A new offer is on the table. ${offer.leverageSummary}`,
        category: 'contract',
        requiresAction: true,
        deadline: offer.deadline,
        choices: [
          { key: 'open-negotiation', label: 'Open negotiation' },
        ],
        linkedFighterId: fighter.id,
        linkedOfferId: offer.id,
      });
    } else {
      // The promotion decides whether to re-sign or release.
      const leverage = computeLeverage(fighter, save).score;
      const keep = leverage > 22 || fighter.winStreak >= 1;
      if (keep) {
        const next = generateContract(fighter, save, rng, { isPlayerFighter: false });
        save.contracts[next.id] = next;
        fighter.contractId = next.id;
      } else {
        contract.status = 'released';
        fighter.activityStatus = 'released';
        pushNews(save, {
          date: save.date,
          headline: `${fighter.name} is released`,
          // A release follows any run without a win, so the streak can be one loss or none at all
          // (a draw or a no contest resets it), and "after 1 straight losses" read badly.
          body: `${fighter.name} has been let go ${
            fighter.lossStreak >= 2 ? `after ${fighter.lossStreak} straight losses` : fighter.lossStreak === 1 ? 'after a loss' : 'when the contract ran out'
          }.`,
          tags: ['roster'],
          fighterIds: [fighter.id],
          importance: 1,
        });
      }
    }
  }

  // Retirements.
  //
  // The draw happens for every eligible fighter whether or not retirement is switched on, because
  // it comes from the shared world rng: gating the loop would make the setting shift every later
  // draw and change fight results. This is the fifth place that mistake was made in this file.
  {
    const retirementsOn = save.settings.retirementEnabled;
    for (const fighter of Object.values(save.fighters)) {
      if (fighter.retired || fighter.id === playerFighterId) continue;
      if (fighter.nextBoutId) continue;
      // The circuit handles its own departures, without main promotion retirement news.
      if (fighter.circuit) continue;
      const weekly = retirementChance(fighter, save.date) / 52;
      const retires = rng.chance(weekly);
      if (retires && retirementsOn) {
        const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 34;
        retireFighter(
          save,
          fighter,
          fighter.longevity < 40 ? 'The accumulated damage made the decision.' : age >= 36 ? 'Age caught up with the career.' : 'The results stopped coming.'
        );
      }
    }
  }

  // New prospects entering the roster.
  const activeCount = mainRosterFighters(save).filter((f) => !f.retired && f.activityStatus === 'active').length;
  // The roster is scaled against what the calendar can actually give people to do. See
  // ROSTER_TARGET_SCALE for the arithmetic that ties it to the activity bands.
  const divisionTarget = (d: { targetRosterSize: number }) => Math.round(d.targetRosterSize * ROSTER_TARGET_SCALE);
  const targetCount = DIVISIONS.reduce((s, d) => s + divisionTarget(d), 0);
  if (activeCount < targetCount && rng.chance(0.55)) {
    const shortDivisions = DIVISIONS.filter(
      (d) => mainRosterFighters(save).filter((f) => f.divisionId === d.id && !f.retired && f.activityStatus === 'active').length < divisionTarget(d)
    );
    if (shortDivisions.length > 0) {
      const d = rng.pick(shortDivisions);
      const prospect = generateFighter(rng, {
        divisionId: d.id,
        targetOvr: rng.normalClamped(62, 5, 50, 76),
        spread: rng.range(5, 12),
        age: rng.int(21, 28),
        today: save.date,
        idNumber: ++save.counters.fighter,
      });
      save.fighters[prospect.id] = prospect;
      updatePot(save, prospect);
      prospect.potConfidence = potConfidenceFor(prospect, save.date);
      const contract = generateContract(prospect, save, rng, { isPlayerFighter: false });
      save.contracts[contract.id] = contract;
      prospect.contractId = contract.id;
      const gyms = Object.values(save.gyms).filter((g) => g.fighterIds.length < g.capacity);
      if (gyms.length > 0) moveFighterToGym(save, prospect.id, rng.weighted(gyms, (g) => g.reputation).id);
      const pathways = ['signed off a regional title run', 'signed after a contender series win', 'signed as a short notice replacement', 'signed after a regional tournament win'];
      pushNews(save, {
        date: save.date,
        headline: `${prospect.name} signs with the promotion`,
        body: `${prospect.name}, ${ageOn(prospect.birthDate, save.date) ?? prospect.ageAtSnapshot} years old out of ${prospect.country}, has been ${rng.pick(pathways)}. Record ${prospect.record.wins}-${prospect.record.losses}.`,
        tags: ['roster', d.id],
        fighterIds: [prospect.id],
        importance: 1,
      });
    }
  }

  // A champion who moved weight and never came back is stripped rather than holding a belt
  // in a division they have left.
  for (const note of enforceAbsentChampions(save)) {
    headlines.push(note);
    pushNews(save, {
      date: save.date,
      headline: note,
      body: note,
      tags: ['title'],
      fighterIds: [],
      importance: 3,
    });
  }
  // Refusals fade. Without this the counter was a lifetime total that permanently suppressed a
  // long career's offers for decisions taken years earlier.
  for (const fighter of Object.values(save.fighters)) {
    if (fighter.declinedOffers <= 0) continue;
    const since = fighter.lastDeclineOn ? daysBetween(fighter.lastDeclineOn, save.date) : 9999;
    if (since < DECLINE_FORGIVENESS_DAYS) continue;
    fighter.declinedOffers = Math.max(0, fighter.declinedOffers - 1);
    fighter.lastDeclineOn = save.date;
  }

  // Contender claims are reviewed before title fights are booked, so a lapsed or vacated claim
  // frees the division in the same pass rather than blocking it for another week.
  for (const note of reviewContenderClaims(save)) headlines.push(note);

  // Every live matchmaking interest is re-evaluated against the world once a week, so a
  // blocked matchup becomes eligible again the moment its blocker clears.
  evaluateAllInterests(save);

  // Keep the calendar populated and book cards that need bouts.
  scheduleEvents(save, rng, 200);
  // The regional circuit runs its own calendar, cards and call up review. Absent for every save
  // that did not start on it, so nothing here touches their random sequence.
  if (save.regional) runRegionalWeek(save, rng, headlines);

  // Championship bouts are made before anything else. Without this, the top contenders
  // get absorbed into ordinary matchups on nearer cards and the title picture never
  // resolves.
  bookTitleFights(save, rng, headlines);
  const upcoming = Object.values(save.events)
    .filter((e) => !e.promotionId && e.status === 'announced' && e.date > save.date && daysBetween(save.date, e.date) < 120)
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  for (const ev of upcoming) {
    const bookedBouts = ev.boutIds.filter((id) => save.bouts[id]?.status === 'scheduled').length;
    const daysOut = daysBetween(save.date, ev.date);
    // Booking ramps toward the card's own announced size. It stopped at twelve before, so a card
    // announced with thirteen or fourteen bouts was never filled past twelve.
    const full = ev.plannedBouts > 0 ? ev.plannedBouts : 12;
    const targetBooked = daysOut > 90 ? 2 : daysOut > 60 ? Math.round(full * 0.5) : daysOut > 35 ? Math.round(full * 0.83) : full;
    if (bookedBouts < targetBooked) {
      const booking = bookEvent(save, ev, rng);
      for (const b of booking.bouts) {
        computeHype(save, b);
        for (const fid of [b.fighterAId, b.fighterBId]) {
          if (fid === playerFighterId) continue;
          const f = save.fighters[fid];
          if (f) autoCampFor(save, f, b.id, b.date, rng);
        }
        // The player receives an offer rather than an assignment. The automatic booking
        // is undone first, releasing both pointers, so the offer starts from a clean state
        // and the opponent is free again if the player never answers.
        if (b.fighterAId === playerFighterId || b.fighterBId === playerFighterId) {
          const isA = b.fighterAId === playerFighterId;
          const opponentId = isA ? b.fighterBId : b.fighterAId;
          const f = save.fighters[playerFighterId!];
          const opp = save.fighters[opponentId];
          if (f && opp) {
            releaseBooking(save, f.id, b.id);
            releaseBooking(save, opp.id, b.id);
            b.status = 'canceled';
            b.cancelReason = 'converted into an offer for the player';
            ev.boutIds = ev.boutIds.filter((id) => id !== b.id);
            createFightOffer(save, f, opp, ev, rng, {
              isMainEvent: b.isMainEvent,
              isTitleFight: b.isTitleFight,
              isInterimTitleFight: b.isInterimTitleFight,
              scheduledRounds: b.scheduledRounds,
              reason: b.bookingReason,
              isReplacementSlot: false,
              // Without this the category was lost on conversion, so a player who accepted an
              // eliminator from a card could never be credited with winning one.
              bookingKind: b.bookingKind,
            });
          }
        }
      }
    }
  }

  expireOffers(save);
  updateAllHype(save, save.date);
  pruneHype(save);
  pruneHistory(save);
  // Once a month, on the same week the gym's books are run. Nothing here draws from the rng or
  // removes anything a later pass reads.
  if (Number(save.date.slice(8, 10)) <= 7) compactSave(save);

  fightWeekHealthCheck(save, rng, headlines);

  // Player facing flow. An injury with a fight booked becomes a decision that stops the
  // calendar, fight week tasks are generated once per bout, and social items arrive within
  // a weekly budget rather than flooding the inbox.
  if (playerFighterId) {
    const me = save.fighters[playerFighterId];
    if (me && !me.retired) {
      // Fight week first, so a contingent booking that is withdrawn does not get an injury
      // decision raised against it a moment before it goes.
      const booked = hasLiveBooking(save, me);
      if (booked && daysBetween(save.date, booked.date) <= FIGHT_WEEK_DAYS + 2) {
        startFightWeek(save, me, booked, rng, headlines);
      }
      checkPlayerInjuries(save);
      // Separate budgets. Sponsor and compliance items used to consume the whole allowance,
      // which is why social interactions almost never appeared.
      const social = featureEnabled(save.settings, 'mediaDepth')
        ? generateSocialItems(save, me, socialRng(save, me.id))
        : [];
      for (const item of social) {
        const message = addInboxMessage(save, {
          sender: item.source === 'opponent' || item.source === 'rival' || item.source === 'former-opponent' ? 'fighter' : 'media',
          senderName: item.sourceName,
          subject: item.headline,
          body: item.body,
          category: 'news',
          requiresAction: item.replies.length > 0,
          deadline: item.expiresOn,
          choices: item.replies.map((r) => ({ key: r.key, label: r.label, hint: r.risk ?? r.text.slice(0, 90) })),
          linkedFighterId: item.sourceFighterId,
        });
        message.linkedSocialId = item.id;
        // Tied to the bout as well, so the inbox closes a pre fight item once the fight is over
        // rather than leaving it answerable after the event.
        if (item.boutId) message.linkedBoutId = item.boutId;
        message.notificationSignature = `social|${item.signature}|${item.sourceFighterId ?? 'none'}`;
        message.decisionKey = message.notificationSignature;
        message.decisionCreatedOn = save.date;
        // Social items are opportunities. They never block the calendar.
        message.mandatory = false;
      }
      pruneSocial(save);
      pruneFightWeek(save);
      for (const note of runFinanceWeek(save, me)) headlines.push(note);
      // The pass always runs, because it draws from the shared world rng. Skipping the call would
      // shift every later draw and make a settings toggle change fight results. The flag decides
      // whether it applies anything: with it off the draws happen and nothing else does. Undoing
      // the consequences afterwards was not enough, because a finding had already suspended the
      // fighter, cancelled the bout and fined them, and the suspension was never lifted.
      const antiDoping = featureEnabled(save.settings, 'antiDoping');
      const dopingNotes = runAntiDopingWeek(save, me, rng, { apply: antiDoping });
      if (antiDoping) {
        for (const note of dopingNotes) headlines.push(note);
      } else {
        clearDopingState(save, me.id);
      }
      // Career life. This is how the gym, teammates, sponsors, the manager, the media and
      // the compliance systems actually reach the player rather than sitting on a page.
      seedGymRelationships(save, me);
      generateCampLife(save, me, campLifeRng(save, me.id));
      const suggestion = maybeSuggestMove(save, me, rng);
      if (suggestion) headlines.push(suggestion);
      decayRelationships(save);
      pruneCallouts(save);
      // Live matchmaking interest. A callout that went well, a rivalry the fans want and a
      // division debut all become real offers here rather than expiring unmentioned.
      // A fighter still on the regional circuit is not on the main promotion's radar for callout
      // fights, and main roster fighters do not call out somebody they have never heard of.
      const onCircuit = Boolean(me.circuit);
      const matchupPass = onCircuit ? { headlines: [] as string[] } : runMatchupInterestPass(save, me, rng);
      for (const note of matchupPass.headlines) headlines.push(note);
      // A debutant the card seeding has found nobody for gets the debut made directly. It uses its
      // own rng, so the world's sequence is unchanged.
      if (!onCircuit) {
        const debut = ensurePlayerDebut(save, me);
        if (debut) headlines.push(debut);
      }
      pruneMatchupInterests(save);
      pruneGamePlans(save);
      // Other fighters act too: they call the player out and occasionally change division.
      if (!onCircuit) for (const note of runNpcCallouts(save, rng)) headlines.push(note);
      // Any callout that has been sitting open long enough gets an answer.
      for (const callout of openCallouts(save)) {
        if (callout.fromId !== me.id) continue;
        if (daysBetween(callout.madeOn, save.date) < 5) continue;
        const answered = resolveCallout(save, callout.id, rng);
        if (answered?.responseText) {
          const target = save.fighters[callout.toId];
          const message = addInboxMessage(save, {
            sender: 'media',
            senderName: target?.name ?? 'The other camp',
            subject: `${target?.name ?? 'They'} answered your callout`,
            body: answered.responseText,
            category: 'career',
            requiresAction: false,
            deadline: null,
            choices: [],
            linkedFighterId: callout.toId,
          });
          message.linkedCalloutId = callout.id;
          headlines.push(answered.responseText);
        }
      }
    }
  }
  // Other fighters move divisions at a controlled rate, and every offer is checked against
  // the division its fighter is actually in.
  for (const move of runNpcWeightClassMoves(save, rng)) {
    const f = save.fighters[move.fighterId];
    const to = DIVISION_BY_ID[move.to as DivisionId];
    if (!f || !to) continue;
    pushNews(save, {
      date: save.date,
      headline: `${f.name} moves ${move.direction} to ${to.name}`,
      body: `${f.name} has left ${DIVISION_BY_ID[move.from as DivisionId].name} ${move.reason}. They start unranked at ${to.name}.`,
      tags: ['career', move.to],
      fighterIds: [f.id],
      importance: 3,
    });
    headlines.push(`${f.name} has moved to ${to.name}.`);
  }
  for (const boutId of cancelStaleDivisionBouts(save)) {
    const bout = save.bouts[boutId];
    if (bout) cancelBout(save, bout, 'a fighter changed division');
  }
  enforceDivisionInvariant(save);

  // The badge can never disagree with the list: anything already handled is closed here.
  reconcileInbox(save);
  syncCareerState(save);

  // Monthly gym finances for a player controlled gym.
  if (save.player.gymId && Number(save.date.slice(8, 10)) <= 7) {
    const gym = save.gyms[save.player.gymId];
    if (gym) {
      const month = runGymMonth(save, gym);
      // A month already closed by hand has nothing new to report.
      const settled = month.income !== 0 || month.costs !== 0;
      // Under two months of costs in the bank is worth a read, not just a line in the inbox.
      const lowRunway = settled && gym.balance >= 0 && gym.balance < month.costs * GYM_RUNWAY_WARNING_MONTHS;
      if (settled && gym.balance < 0) {
        // A gym in the red used to keep trading forever with nothing to show for it beyond a
        // number, which reached minus a million and a half in a three year coach save. Debt now
        // costs standing every month it lasts, and the owner is asked what to do about it.
        gym.reputation = Math.max(0, gym.reputation - GYM_DEBT_REPUTATION_LOSS);
      }
      if (settled) {
        const message = addInboxMessage(save, {
          sender: 'gym-owner',
          senderName: 'Gym finances',
          subject: `Monthly finances: ${month.net >= 0 ? 'surplus' : 'shortfall'}${lowRunway ? ', under two months of costs left' : ''}`,
          body: `${month.lines.join('. ')}. Net ${month.net >= 0 ? 'surplus' : 'shortfall'} of ${formatMoney(Math.abs(month.net))}. Balance is now ${formatMoney(gym.balance)}.${
            lowRunway ? ' At this rate the gym runs out of money within two months. More fighters, a lower payroll or a lower overhead would turn it around.' : ''
          }`,
          category: 'gym',
          requiresAction: lowRunway,
          choices: [{ key: 'ack', label: 'Acknowledge' }],
        });
        // A warning, not a reason to stop the calendar.
        if (lowRunway) message.mandatory = false;
      }
      const signature = `gym-debt|${gym.id}`;
      if (settled && gym.balance < 0 && mayNotify(save, { signature, cooldownDays: 60 })) {
        const own = save.finance?.cash ?? save.player.balance;
        const debt = addInboxMessage(save, {
          sender: 'gym-owner',
          senderName: 'Gym finances',
          subject: `${gym.name} is in debt`,
          body: `The gym closed the month ${formatMoney(-gym.balance)} in the red. Until the balance is back above zero, upgrades and hiring are frozen, the fighters feel the instability, and every month in debt costs the gym standing. You have ${formatMoney(Math.max(0, own))} of your own.`,
          category: 'gym',
          requiresAction: true,
          deadline: addDays(save.date, 30),
          choices: [
            { key: GYM_DEBT_CHOICES.cover, label: 'Cover it from your own money', hint: 'As far as your own money goes' },
            { key: GYM_DEBT_CHOICES.carry, label: 'Let the gym carry the debt', hint: 'Upgrades and hiring stay frozen, and the gym loses standing' },
          ],
        });
        debt.notificationSignature = signature;
        debt.decisionKey = signature;
        debt.decisionCreatedOn = save.date;
      }
    }
  }
}

/**
 * Books championship bouts. A champion who has been idle long enough is matched with the
 * highest ranked available contender on the next suitable card, and both are reserved
 * before general matchmaking runs.
 */
/** The shortest gap the promotion will accept between two meetings for the same belt. */
const TITLE_REMATCH_MIN_GAP_DAYS = 150;

/** How long the matchmaker holds a refusal against a fighter before one is forgiven. */
const DECLINE_FORGIVENESS_DAYS = 240;

function bookTitleFights(save: SaveGame, rng: Rng, headlines: string[]): void {
  const offerIds = openOfferFighterIds(save);
  const campIds = inCampFighterIds(save);
  const upcoming = Object.values(save.events)
    .filter((e) => e.status === 'announced' && !e.promotionId)
    .filter((e) => daysBetween(save.date, e.date) >= 40 && daysBetween(save.date, e.date) <= 160)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const bigCards = upcoming.filter((e) => e.tier === 'numbered-ppv' || e.tier === 'international');
  if (upcoming.length === 0) return;

  for (const d of DIVISIONS) {
    const table = save.rankings[d.id];

    // Skip divisions that already have a title bout on the books, or a title offer already sitting
    // with the player. Checking only scheduled bouts meant that a title offer made last week, which
    // the player had not yet answered, did not stop a second one being created for the same belt.
    const alreadyBooked = Object.values(save.bouts).some(
      (b) => b.status === 'scheduled' && b.divisionId === d.id && (b.isTitleFight || b.isInterimTitleFight)
    );
    if (alreadyBooked) continue;
    if (existingTitleOffer(save, d.id)) continue;

    const champion = table.championId ? save.fighters[table.championId] : null;
    const interim = table.interimChampionId ? save.fighters[table.interimChampionId] : null;

    // A vacant title is filled on whichever card comes first. Waiting for a numbered card
    // is what left divisions without a champion for months at a time.
    const cards = champion ? bigCards : upcoming;
    for (const card of cards) {
      const booked = new Set<string>();
      let scheduledOnCard = 0;
      for (const bid of card.boutIds) {
        const b = save.bouts[bid];
        if (b && b.status === 'scheduled') {
          scheduledOnCard++;
          booked.add(b.fighterAId);
          booked.add(b.fighterBId);
        }
      }
      // A championship bout still has to fit on the card. A full card is passed over in
      // favour of the next suitable one rather than being stretched beyond its shape.
      if (card.plannedBouts > 0 && scheduledOnCard >= card.plannedBouts) continue;
      // Nor is one card handed every belt in the promotion. Each division that finds this card
      // already carrying its share of championship bouts moves on to a later one.
      if (titleBoutRoom(save, card) <= 0) continue;
      // A championship booking outranks a routine offer, so a contender holding an ordinary
      // offer is still considered rather than being passed over for another six months.
      const ctx = {
        date: card.date,
        bookedFighterIds: booked,
        openOfferFighterIds: offerIds,
        inCampFighterIds: campIds,
        isChampionshipBooking: true,
      };

      // A vacant title is filled by the two highest ranked available contenders.
      let sideA: Fighter | null = null;
      let sideB: Fighter | null = null;
      let interimBout = false;

      // Every challenger below passes the shared eligibility gate, and the reason it gives
      // is what the player is shown. That is what stops an unranked fighter or somebody
      // coming off a loss from being handed a title shot with no explanation.
      let selectionReason = '';
      let unification = false;

      // A champion campaigning in another division cannot defend this belt. They are not in the
      // division, so booking them here would put them in two divisions at once, and the held title
      // arrangement already has its own deadline and strip.
      const championPresent = Boolean(champion && champion.divisionId === d.id);
      if (champion && !championPresent) continue;

      if (champion && championPresent && isAvailable(save, champion, ctx)) {
        const idleDays = champion.lastFightDate ? daysBetween(champion.lastFightDate, card.date) : 400;
        if (idleDays < CHAMPION_TURNAROUND_DAYS) continue;
        sideA = champion;
        // Unification takes priority over a routine defense. Once an interim champion
        // exists the division owes that fight before anything else.
        const due = unificationDue(save, d.id);
        if (interim && due.due && isAvailable(save, interim, ctx)) {
          sideB = interim;
          unification = true;
          selectionReason = due.explanation;
        } else {
          const ranked = rankChallengers(save, d.id, (f) => isAvailable(save, f, ctx));
          sideB = ranked[0]?.fighter ?? null;
          selectionReason = ranked[0]?.eligibility.selectionReason ?? '';
        }
      } else {
        if (!champion) {
          // Vacant title. The two strongest eligible claims contest it.
          const ranked = rankChallengers(save, d.id, (f) => isAvailable(save, f, ctx), { vacant: true });
          sideA = ranked[0]?.fighter ?? null;
          sideB = ranked[1]?.fighter ?? null;
          selectionReason = ranked[0]
            ? `The championship is vacant. ${ranked[0].eligibility.selectionReason}`
            : 'The championship is vacant.';
        } else {
          const justification = interimTitleJustification(save, d.id);
          if (justification.justified && !interim) {
            const ranked = rankChallengers(save, d.id, (f) => isAvailable(save, f, ctx), { interim: true });
            sideA = ranked[0]?.fighter ?? null;
            sideB = ranked[1]?.fighter ?? null;
            interimBout = true;
            selectionReason = justification.explanation;
          }
        }
      }

      if (!sideA || !sideB || sideA.id === sideB.id) continue;
      // Final guard before the booking. Both sides are checked against the gate one more
      // time with this bout excluded, so nothing that reached here by another route can slip
      // past the eligibility rules.
      const challengerCheck = titleShotEligibility(save, sideB, d.id, { vacant: !champion, interim: interimBout });
      if (!challengerCheck.eligible) continue;
      // The same limit ordinary matchmaking applies. Without it a championship pairing could be
      // remade every cycle, which is the one place a trilogy could quietly become a quadrilogy.
      let meetings = 0;
      let lastMeeting: string | null = null;
      for (const r of Object.values(save.history.results)) {
        const pair =
          (r.fighterAId === sideA.id && r.fighterBId === sideB.id) ||
          (r.fighterAId === sideB.id && r.fighterBId === sideA.id);
        if (!pair) continue;
        meetings++;
        if (!lastMeeting || r.date > lastMeeting) lastMeeting = r.date;
      }
      if (meetings >= MATCHMAKING.rematch.maxMeetings) continue;
      // An immediate championship rematch is allowed, because a title loss carries its own rematch
      // claim, but not one inside a couple of months.
      if (lastMeeting && daysBetween(lastMeeting, card.date) < TITLE_REMATCH_MIN_GAP_DAYS) continue;
      if (!selectionReason) selectionReason = challengerCheck.selectionReason;

      // A card has one main event. A second championship bout goes in as the co-main, and the
      // card is ordered properly once the bout stands.
      const cardHasMain = card.boutIds.some((id) => save.bouts[id]?.status === 'scheduled' && save.bouts[id].isMainEvent);
      const boutId = `bout-${++save.counters.bout}`;
      const bout: Bout = {
        id: boutId,
        eventId: card.id,
        date: card.date,
        fighterAId: sideA.id,
        fighterBId: sideB.id,
        divisionId: d.id,
        contractedWeightLb: DIVISION_BY_ID[d.id].limitLb,
        scheduledRounds: 5,
        isTitleFight: !interimBout,
        isInterimTitleFight: interimBout,
        titleIneligibleFighterIds: [],
        isMainEvent: !cardHasMain,
        isCoMain: cardHasMain,
        cardSegment: 'main',
        boutOrder: 99,
        isCatchweight: false,
        status: 'scheduled',
        resultId: null,
        bookedOn: save.date,
        replacementHistory: [],
        cancelReason: null,
        purseA: purseForBout(sideA.contractId ? save.contracts[sideA.contractId] : null, sideA, save, {
          isMainEvent: true,
          isTitleFight: true,
          shortNotice: false,
        }),
        purseB: purseForBout(sideB.contractId ? save.contracts[sideB.contractId] : null, sideB, save, {
          isMainEvent: true,
          isTitleFight: true,
          shortNotice: false,
        }),
        weighInA: null,
        weighInB: null,
        bookingReason: selectionReason || (interimBout
          ? `interim ${d.name} title bout with the champion unavailable`
          : champion
            ? `${d.name} title defense`
            : `vacant ${d.name} title bout`),
        bookingKind: unification ? 'unification' : interimBout ? 'interim-title' : 'title-fight',
      };

      const titleBooking = bookBout(save, bout);
      if (!titleBooking.created) {
        save.counters.bout--;
        continue;
      }
      computeHype(save, bout);

      const playerInvolved = save.player.fighterId === sideA.id || save.player.fighterId === sideB.id;
      if (playerInvolved) {
        const self = save.fighters[save.player.fighterId!];
        const opp = self.id === sideA.id ? sideB : sideA;
        releaseBooking(save, self.id, boutId);
        releaseBooking(save, opp.id, boutId);
        // The routine offer the player was holding is pulled, because the title shot replaces
        // it. Leaving it open would make the title offer itself impossible to create.
        closeCompetingOffers(save, self.id, '', 'Withdrawn: a championship opportunity came up instead.');
        self.offerCooldownUntil = null;
        bout.status = 'canceled';
        bout.cancelReason = 'converted into an offer for the player';
        card.boutIds = card.boutIds.filter((id) => id !== boutId);
        const offer = createFightOffer(save, self, opp, card, rng, {
          isMainEvent: true,
          isTitleFight: !interimBout,
          isInterimTitleFight: interimBout,
          scheduledRounds: 5,
          reason: bout.bookingReason,
          isReplacementSlot: false,
          bookingKind: bout.bookingKind,
        });
        // Nothing is booked until the player answers, so nothing is announced as booked. The
        // news used to say the bout was set even when the offer was later declined, or was never
        // created at all.
        if (offer) headlines.push(`${d.name} ${interimBout ? 'interim ' : ''}title shot offered to ${self.name} against ${opp.name}.`);
      } else {
        // The bout stands, so the claim is honoured now.
        fulfilContenderStatus(save, d.id, sideB.id, boutId);
        for (const f of [sideA, sideB]) autoCampFor(save, f, boutId, card.date, rng);
        orderCard(save, card);
        pushNews(save, {
          date: save.date,
          headline: `${sideA.name} against ${sideB.name} set for ${card.name}`,
          body: `The ${d.name} ${interimBout ? 'interim ' : ''}title will be on the line at ${card.name} in ${card.city} on ${formatDate(card.date)}.`,
          tags: ['title', d.id],
          fighterIds: [sideA.id, sideB.id],
          importance: 4,
        });
        headlines.push(`${d.name} title bout booked: ${sideA.name} against ${sideB.name}.`);
      }
      break;
    }
  }
}

function subjectForAutonomy(kind: string): string {
  switch (kind) {
    case 'request-attention':
      return 'Asking for more individual attention';
    case 'object-to-sparring':
      return 'Concerned about the sparring';
    case 'object-to-favoritism':
      return 'Feels overlooked';
    case 'request-corner-change':
      return 'Wants a different corner';
    case 'consider-leaving':
      return 'Considering leaving the gym';
    case 'change-division':
      return 'Wants to change divisions';
    default:
      return 'Message from a fighter';
  }
}

function choicesForAutonomy(kind: string) {
  switch (kind) {
    case 'request-attention':
      return [
        { key: 'accommodate', label: 'Give them dedicated time', hint: 'Improves their happiness, takes attention from others' },
        { key: 'decline', label: 'Explain that the room comes first', hint: 'Keeps the team balanced, costs this relationship' },
      ];
    case 'object-to-sparring':
      return [
        { key: 'reduce-sparring', label: 'Reduce hard sparring at the gym', hint: 'Safer room, slightly slower sharpening' },
        { key: 'hold-line', label: 'Keep the current sparring policy', hint: 'Keeps the edge, costs trust' },
      ];
    case 'object-to-favoritism':
      return [
        { key: 'rebalance', label: 'Rebalance attention across the roster', hint: 'Improves team morale, ranked fighters lose ground' },
        { key: 'explain', label: 'Explain the ranked fighters drive the gym', hint: 'Honest, unpopular' },
      ];
    case 'request-corner-change':
      return [
        { key: 'change-corner', label: 'Assign a different corner', hint: 'Improves the relationship' },
        { key: 'refuse', label: 'Keep the current corner', hint: 'Costs trust' },
      ];
    case 'consider-leaving':
      return [
        { key: 'talk', label: 'Sit down and talk it through', hint: 'A chance to change their mind' },
        { key: 'let-go', label: 'Let them make their own decision', hint: 'No intervention' },
      ];
    case 'change-division':
      return [
        { key: 'support', label: 'Support the move', hint: 'The fighter moves divisions' },
        { key: 'advise-against', label: 'Advise against it', hint: 'They may go anyway' },
      ];
    default:
      return [{ key: 'ack', label: 'Acknowledge' }];
  }
}

export function withdrawFromBout(save: SaveGame, bout: Bout, fighterId: string, reason: string, rng: Rng, headlines: string[]): void {
  const withdrawn = save.fighters[fighterId];
  const table = save.rankings[bout.divisionId];
  const wasChampionship = isChampionshipBout(bout);
  const holderWithdrew = table?.championId === fighterId || table?.interimChampionId === fighterId;
  // A challenger pulling out of a title bout is not filled the way any other bout is. The ordinary
  // replacement finder picked by ranking gap, so the champion was handed an unranked opponent on
  // months of notice and the belt came off the line, spending a defense slot on a prelim. With time
  // in hand the bout is called off and the title pass books a real challenger; close to the card
  // only somebody who passes the title gate on short notice may step in.
  const challengerWithdrew = wasChampionship && !holderWithdrew;
  if (challengerWithdrew && daysBetween(save.date, bout.date) > TITLE_REBOOK_NOTICE_DAYS) {
    const division = DIVISION_BY_ID[bout.divisionId];
    const remainingId = bout.fighterAId === fighterId ? bout.fighterBId : bout.fighterAId;
    const remaining = save.fighters[remainingId];
    cancelBout(save, bout, `${withdrawn?.name ?? 'The challenger'} withdrew: ${reason}. The title bout will be rebooked with a new challenger.`);
    pushNews(save, {
      date: save.date,
      headline: `${withdrawn?.name ?? 'The challenger'} out of the ${division.name} title bout`,
      body: `${withdrawn?.name ?? 'The challenger'} is out with ${reason}. With time before ${remaining?.name ?? 'the champion'} was due to fight, the promotion will rebook the title against a new challenger rather than fill the slot late.`,
      tags: ['title', bout.divisionId],
      fighterIds: [fighterId, remainingId],
      importance: 3,
    });
    headlines.push(`${division.name} title bout off: ${withdrawn?.name ?? 'the challenger'} withdrew.`);
    if (remainingId === save.player.fighterId) {
      addInboxMessage(save, {
        sender: 'replacement-coordinator',
        senderName: 'Matchmaking',
        subject: 'Title bout off',
        body: `${withdrawn?.name ?? 'The scheduled opponent'} is out with ${reason}. There is enough time to find a proper challenger, so this bout is off and the title will be rebooked against a new one.`,
        category: 'offer',
        requiresAction: false,
        choices: [{ key: 'ack', label: 'Acknowledge' }],
      });
    }
    return;
  }
  const replacement = challengerWithdrew ? findTitleReplacement(save, bout, fighterId) : findReplacement(save, bout, fighterId, rng);
  if (replacement && applyReplacement(save, bout, fighterId, replacement.fighter, replacement.reason)) {
    // A standing contender stepping in takes the shot their claim was for.
    if (isChampionshipBout(bout)) fulfilContenderStatus(save, bout.divisionId, replacement.fighter.id, bout.id);
    autoCampFor(save, replacement.fighter, bout.id, bout.date, rng);
    replacement.fighter.acceptedShortNotice++;
    addHypeMoment(save, bout.id, `${withdrawn?.name ?? 'A fighter'} withdrew and was replaced`, -12);
    pushNews(save, {
      date: save.date,
      headline: `${replacement.fighter.name} steps in`,
      body: `${withdrawn?.name ?? 'A fighter'} is out with ${reason}. ${replacement.fighter.name} is ${replacement.reason}.`,
      tags: ['replacement'],
      fighterIds: [replacement.fighter.id],
      importance: 2,
    });
    headlines.push(`${replacement.fighter.name} replaces ${withdrawn?.name ?? 'a withdrawn fighter'}.`);

    const remainingId = bout.fighterAId === replacement.fighter.id ? bout.fighterBId : bout.fighterAId;
    if (remainingId === save.player.fighterId) {
      const beltOff = wasChampionship && !isChampionshipBout(bout) ? ' The championship is no longer on the line.' : '';
      addInboxMessage(save, {
        sender: 'replacement-coordinator',
        senderName: 'Matchmaking',
        subject: 'Opponent change',
        body: `${withdrawn?.name ?? 'The scheduled opponent'} is out with ${reason}. ${replacement.fighter.name} has accepted the bout, ${replacement.reason}.${beltOff}`,
        category: 'offer',
        requiresAction: true,
        choices: [
          { key: 'accept-replacement', label: 'Accept the new opponent' },
          { key: 'decline-replacement', label: 'Withdraw from the bout', destructive: true },
        ],
        linkedBoutId: bout.id,
        linkedFighterId: replacement.fighter.id,
      });
    }
  } else {
    cancelBout(save, bout, `${withdrawn?.name ?? 'A fighter'} withdrew: ${reason}. No replacement was found.`);
    headlines.push('A bout has been canceled with no replacement available.');
    const remainingId = bout.fighterAId === fighterId ? bout.fighterBId : bout.fighterAId;
    if (remainingId === save.player.fighterId) {
      addInboxMessage(save, {
        sender: 'replacement-coordinator',
        senderName: 'Matchmaking',
        subject: 'Bout canceled',
        body: `${withdrawn?.name ?? 'The scheduled opponent'} is out with ${reason} and no replacement could be found in time. The bout is off.`,
        category: 'offer',
        requiresAction: false,
        choices: [{ key: 'ack', label: 'Acknowledge' }],
      });
    }
  }
}

/**
 * Opens fight week for the player's bout, enforcing a medically contingent booking first.
 *
 * A contingent offer says it is withdrawn automatically if the fighter is not cleared, and nothing
 * enforced that, so a fighter who never healed walked into fight week hurt. When the injury will
 * still be there on fight night, the player is withdrawn here and told so. Returns the fight week
 * tasks created, which is empty when they already existed or the bout was withdrawn.
 */
function startFightWeek(save: SaveGame, me: Fighter, bout: Bout, rng: Rng, headlines: string[]) {
  if (bout.medicallyContingent && tasksForBout(save, bout.id).length === 0 && !canCompete(me, bout.date).ok) {
    const event = save.events[bout.eventId];
    const reason = canCompete(me, bout.date).reason ?? 'not medically cleared';
    withdrawFromBout(save, bout, me.id, 'an injury that has not cleared', rng, headlines);
    resolveMessagesForBout(save, bout.id, `${me.name} was withdrawn: not medically cleared in time.`);
    for (const camp of Object.values(save.camps)) {
      if (camp.fighterId === me.id && (camp.status === 'planned' || camp.status === 'running')) camp.status = 'abandoned';
    }
    addInboxMessage(save, {
      sender: 'commission',
      senderName: 'Athletic commission',
      subject: 'Withdrawn: not medically cleared',
      body: `The bout at ${event?.name ?? 'the event'} on ${formatDate(bout.date)} was accepted on condition of medical clearance. You have not been cleared (${reason}), so you are withdrawn from it. Nothing is held against you for this.`,
      category: 'medical',
      requiresAction: false,
      choices: [],
      linkedEventId: event?.id ?? null,
    });
    headlines.push(`${me.name} is withdrawn from ${event?.name ?? 'the bout'}: not medically cleared.`);
    return [];
  }
  return ensureFightWeekTasks(save, bout.id);
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

function playerBoutOn(save: SaveGame, date: IsoDate): BoutId | null {
  const pid = save.player.fighterId;
  if (!pid) return null;
  const f = save.fighters[pid];
  if (!f?.nextBoutId) return null;
  const bout = save.bouts[f.nextBoutId];
  if (bout && bout.status === 'scheduled' && bout.date === date) return bout.id;
  return null;
}

export function pendingDecisions(save: SaveGame): number {
  let n = 0;
  for (const m of save.inbox) if (messageNeedsAction(save, m)) n++;
  return n;
}

/**
 * Decisions that are allowed to stop the clock: the same filter careerStatus uses. Optional items
 * such as a fan request or a sponsor post need an answer too, but counting them stopped a month
 * advance every week and threw the player onto the inbox for things that could wait. Fight offers
 * and treatment questions leave `mandatory` unset, so they still count.
 */
export function mandatoryDecisions(save: SaveGame): number {
  let n = 0;
  for (const m of save.inbox) if (m.mandatory !== false && messageNeedsAction(save, m)) n++;
  return n;
}

export function advance(save: SaveGame, opts: AdvanceOptions): AdvanceReport {
  const steps = advanceSteps(save, opts);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** The phrase every cancelled advance stops with, so the interface can tell it from a real stop. */
export const STOPPED_AT_REQUEST = 'Stopped at your request.';

/**
 * The advance loop, one simulated day at a time.
 *
 * It yields the new date after each day, so a caller can hand the main thread back to the browser
 * between days. A year advance late in a career is tens of seconds of simulation, and run in one
 * piece the page could not paint its progress or answer a tap until it ended. `advance` drains it
 * in one go, so the synchronous path, and every test, behaves exactly as it always has.
 *
 * `shouldCancel` is asked after each day. A day always finishes, so a cancelled advance leaves the
 * world exactly as a shorter advance would have.
 */
export function* advanceSteps(save: SaveGame, opts: AdvanceOptions, shouldCancel?: () => boolean): Generator<IsoDate, AdvanceReport, void> {
  const rng = rngOf(save);
  const from = save.date;
  const headlines: string[] = [];
  const eventsResolved: string[] = [];
  let stoppedBecause: string | null = null;
  let playerBoutPending: BoutId | null = null;

  const limits: Record<AdvanceMode, number> = {
    day: 1,
    week: 7,
    'next-message': 400,
    'next-event': 400,
    'to-fight': 400,
    'weigh-in': 400,
    month: 31,
    year: 366,
  };
  const maxDays = opts.maxDays ?? limits[opts.mode];
  const startingDecisions = mandatoryDecisions(save);
  // The message counter, not the inbox length. The inbox is capped, so once it was full its
  // length never grew again and nothing new could ever stop the clock.
  const startingMessages = save.counters.message ?? 0;
  let inboxWaiting = false;
  let fightWeekBoutId: BoutId | null = null;
  // A long advance stops at the start of fight week and at every mandatory stage. A single day
  // needs neither, because it stops anyway. These stops do not follow the player's inbox setting,
  // since a weigh in is not a message. A caller that passes stopOnDecision false explicitly is
  // driving the world headless, a test harness or the day by day target loop, and handles fight
  // week itself.
  const longAdvance = opts.mode !== 'day' && opts.stopOnDecision !== false;
  const stopOnDecision = opts.stopOnDecision ?? save.settings.autoAdvanceStopsOnDecision;
  const startMe = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const startBooking = startMe ? hasLiveBooking(save, startMe) : null;
  const inFightWeekAtStart = startBooking && daysBetween(save.date, startBooking.date) <= FIGHT_WEEK_DAYS ? startBooking.id : null;

  for (let day = 0; day < maxDays; day++) {
    // Stop before simulating a card the player is fighting on.
    const pb = playerBoutOn(save, save.date);
    if (pb) {
      playerBoutPending = pb;
      stoppedBecause = 'The player has a bout on this card.';
      save.pendingDecision = { kind: 'player-bout', messageId: null };
      break;
    }

    // Weigh in stop.
    if (opts.mode === 'weigh-in' && save.player.fighterId) {
      const f = save.fighters[save.player.fighterId];
      if (f?.nextBoutId) {
        const bout = save.bouts[f.nextBoutId];
        if (bout && daysBetween(save.date, bout.date) === 1) {
          stoppedBecause = 'Weigh in day.';
          break;
        }
      }
    }

    // Resolve any events today.
    const todaysEvents = Object.values(save.events).filter((e) => e.date === save.date && e.status === 'announced');
    for (const ev of todaysEvents) {
      const results = resolveEvent(save, ev.id, rng);
      if (results.length > 0) {
        eventsResolved.push(ev.name);
        // The main event is identified by its bout, not by its position in the results array.
        // resolveEvent returns the card in descending bout order, so the last entry is the opening
        // preliminary; taking it named a prelim winner as the main event winner every week.
        const main = results.find((r) => save.bouts[r.boutId]?.isMainEvent) ?? results[0];
        if (main) {
          const w = main.winnerId ? save.fighters[main.winnerId]?.name : null;
          headlines.push(`${ev.name}: ${w ? `${w} wins the main event` : 'the main event went to a draw'}.`);
        }
      }
      if (opts.mode === 'next-event') {
        stoppedBecause = `${ev.name} has been simulated.`;
      }
    }
    if (stoppedBecause && opts.mode === 'next-event') break;

    // Weekly maintenance on Mondays.
    if (dayOfWeek(save.date) === 1) {
      weeklyMaintenance(save, rng, headlines);
    }

    // Fight week tasks are created the day fight week actually begins, not on the next
    // Monday. Generating them in the weekly pass meant a bout on a Wednesday could reach
    // fight week with no stages at all, which is what made fight week feel skippable.
    const playerId = save.player.fighterId;
    if (playerId) {
      const me = save.fighters[playerId];
      const booked = me ? hasLiveBooking(save, me) : null;
      if (me && booked && daysBetween(save.date, booked.date) <= FIGHT_WEEK_DAYS + 1) {
        const created = startFightWeek(save, me, booked, rng, headlines);
        if (created.length > 0) headlines.push('Fight Week Begins.');
      }
    }

    // The player's Pot on their birthday, when the projection's age input moves. A 29 February
    // birthday is kept on the 28th in the years that have no 29th.
    if (playerId) {
      const me = save.fighters[playerId];
      const birthday = me?.birthDate?.slice(5);
      const today = save.date.slice(5);
      if (me && !me.retired && birthday && (birthday === today || (birthday === '02-29' && today === '02-28' && !isLeapYearOf(save.date)))) {
        updatePot(save, me);
      }
    }

    // Year end awards and Hall of Fame.
    if (save.date.slice(5) === '12-28') {
      const year = yearOf(save.date);
      computeSeasonAwards(save, year);
      runHallOfFameVote(save, year, rng);
      headlines.push(`Year end awards for ${year} announced.`);
      // Recompute Pot annually. Fighters whose inputs have not changed hit the cache, so
      // the annual pass costs only what actually moved.
      refreshPotForAll(save);
      prunePotCache(save);
      for (const f of Object.values(save.fighters)) {
        if (!f.retired) f.potConfidence = potConfidenceFor(f, save.date);
      }
    }

    save.date = addDays(save.date, 1);

    // Stop conditions.

    // Fight week. A week or a month press used to walk straight through it, past the official
    // weigh in, and land on fight night with the weight never made. These stops are not tied to
    // the inbox setting: a mandatory stage is not a message, and a player who turned message stops
    // off still has to weigh in. Fight day itself is left to the player bout stop above.
    if (longAdvance && playerId) {
      const me = save.fighters[playerId];
      const booked = me ? hasLiveBooking(save, me) : null;
      const daysOut = booked ? daysBetween(save.date, booked.date) : null;
      if (booked && daysOut !== null && daysOut > 0 && daysOut <= FIGHT_WEEK_DAYS) {
        const due = pendingStages(save, booked.id).find((t) => t.mandatory && t.dueOn <= save.date);
        if (due) {
          stoppedBecause = `${stageLabel(due.stage)} is due.`;
          fightWeekBoutId = booked.id;
          break;
        }
        // The day fight week begins, judged by the same window careerStatus uses. The tasks can
        // be created by the weekly pass or the daily check, so their creation is not the signal.
        const calendarSpan = opts.mode === 'week' || opts.mode === 'month' || opts.mode === 'year';
        if (calendarSpan && booked.id !== inFightWeekAtStart) {
          stoppedBecause = 'Fight week begins.';
          fightWeekBoutId = booked.id;
          break;
        }
      }
    }

    const decisionsNow = mandatoryDecisions(save);
    if (stopOnDecision && decisionsNow > startingDecisions) {
      stoppedBecause = 'A decision needs an answer in the inbox.';
      inboxWaiting = true;
      break;
    }
    // Anything new in the inbox stops a short advance, not only the items that demand an answer.
    // A camp report or a matchmaker note used to arrive silently while the days rolled past. A
    // week, a month or a year does not stop for it: optional and passive items stopped a month
    // advance every few days, so those are counted and reported when the advance ends instead.
    const newMessages = (save.counters.message ?? 0) - startingMessages;
    const stopsOnAnything = opts.mode === 'day' || opts.mode === 'next-message' || opts.mode === 'to-fight';
    // It stops without taking the player to the inbox. Anything that needs an answer stopped
    // the clock above; this is only so a new item is seen, not a summons.
    if (stopOnDecision && stopsOnAnything && newMessages > 0) {
      stoppedBecause = 'Something new is in the inbox.';
      break;
    }
    if (opts.mode === 'next-message' && pendingDecisions(save) > 0) {
      stoppedBecause = 'There is a message waiting.';
      inboxWaiting = true;
      break;
    }
    if (opts.mode === 'to-fight' && save.player.fighterId) {
      const f = save.fighters[save.player.fighterId];
      if (f?.nextBoutId) {
        const bout = save.bouts[f.nextBoutId];
        if (bout && bout.date === save.date) {
          stoppedBecause = 'Fight day.';
          break;
        }
      }
    }

    if (day + 1 < maxDays) {
      // The draw state lives in this loop until the end, so it is written back before handing over.
      // Nothing may change the world while an advance is running, but a save written meanwhile (the
      // page hidden mid advance) must still hold a sequence that matches its date.
      persistRng(save, rng);
      yield save.date;
      if (shouldCancel?.()) {
        stoppedBecause = STOPPED_AT_REQUEST;
        break;
      }
    }
  }

  persistRng(save, rng);
  save.updatedAt = new Date().toISOString();

  // Whatever arrived without stopping the clock is still reported, so it is not lost.
  const arrived = (save.counters.message ?? 0) - startingMessages;
  if (arrived > 0 && !inboxWaiting) headlines.push(`${arrived} new inbox item${arrived === 1 ? '' : 's'}.`);

  return {
    from,
    to: save.date,
    daysAdvanced: daysBetween(from, save.date),
    eventsResolved,
    headlines,
    stoppedBecause,
    playerBoutPending,
    inboxWaiting,
    fightWeekBoutId,
  };
}

/** Simulates the player's own bout, used by the fight viewer once the player is ready. */
export function simulatePlayerBout(save: SaveGame, boutId: BoutId, playerPlan: GamePlanKey[]): FightResult {
  const rng = rngOf(save);
  const bout = save.bouts[boutId];
  if (!bout) throw new Error('That bout no longer exists.');
  // A canceled bout is not a fight. Only an already recorded result was refused before, so
  // walking the fight week timeline after a withdrawal simulated a bout that had been called
  // off and wrote a real result, record, purse and ranking change from it.
  if (bout.status === 'canceled') {
    throw new Error('That bout was canceled and cannot be fought.');
  }
  // Only a booked bout on or after its date. The fight page offered Start from the event page
  // preview weeks out, and this ran the fight, completed the whole card and moved the career into
  // recovery with the calendar still two months back, skipping camp and fight week entirely.
  // The official weigh in is not checked here: headless harnesses fight on the day without one,
  // and resolveBout simulates the cut when no official reading exists. The fight page and
  // careerStatus both hold the player to it.
  // A fight already on record is returned as it stands. Running it again would apply a second
  // result to both records under the same id.
  const existing = bout.resultId ? save.history.results[bout.resultId] : undefined;
  if (existing) return existing;
  if (bout.status !== 'scheduled') {
    throw new Error('That bout is not scheduled to be fought.');
  }
  if (save.date < bout.date) {
    throw new Error(`Fight night is ${formatDate(bout.date)}.`);
  }
  // Recorded before the result touches either fighter, so the fight page can bill the bout as it
  // stood while the result is still being replayed.
  const fa = save.fighters[bout.fighterAId];
  const fb = save.fighters[bout.fighterBId];
  if (fa && fb) {
    bout.preFight = {
      recordA: { ...fa.record },
      recordB: { ...fb.record },
      amateurRecordA: fa.amateurRecord ? { ...fa.amateurRecord } : undefined,
      amateurRecordB: fb.amateurRecord ? { ...fb.amateurRecord } : undefined,
      longevityA: fa.longevity,
      longevityB: fb.longevity,
      rankingA: fa.ranking,
      rankingB: fb.ranking,
      championA: fa.isChampion,
      championB: fb.isChampion,
    };
  }
  const result = resolveBout(save, bout, rng, playerPlan);
  // Resolve the rest of the card around it, passing the player's result in so it is part of the
  // card for the contested list and for bonus selection.
  const event = save.events[bout.eventId];
  if (event) {
    resolveEvent(save, event.id, rng, {}, [result]);
  }
  // The fight itself is what final clearance and fight night lead to, so both close here. Nothing
  // closed them before, and a revisited fight week page offered 'Enter fight' for a finished bout.
  const winner = result.winnerId ? save.fighters[result.winnerId] : null;
  closeFightWeek(save, bout.id, winner ? `${winner.name} won by ${METHOD_LABEL[result.method]}.` : `${METHOD_LABEL[result.method]}.`);
  save.pendingDecision = null;
  persistRng(save, rng);
  return result;
}

export function upcomingEvents(save: SaveGame, limit = 12) {
  return Object.values(save.events)
    .filter((e) => e.status === 'announced' && e.date >= save.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, limit);
}

export function recentEvents(save: SaveGame, limit = 12) {
  return Object.values(save.events)
    .filter((e) => e.status === 'completed')
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .slice(0, limit);
}

export function describeAdvance(report: AdvanceReport): string {
  if (report.daysAdvanced === 0) return `No time passed. ${report.stoppedBecause ?? ''}`.trim();
  const range = report.daysAdvanced === 1 ? formatDate(report.from) : `${formatDate(report.from)} to ${formatDate(report.to)}`;
  return `${range}. ${report.eventsResolved.length} event${report.eventsResolved.length === 1 ? '' : 's'} resolved.${report.stoppedBecause ? ` ${report.stoppedBecause}` : ''}`;
}

export function isFinishMethod(r: FightResult): boolean {
  return isFinish(r.method);
}

export function purseSummaryFor(save: SaveGame, bout: Bout, fighterId: string): { show: number; win: number } {
  const fighter = save.fighters[fighterId];
  const contract = fighter?.contractId ? save.contracts[fighter.contractId] : null;
  return purseForBout(contract, fighter, save, {
    isMainEvent: bout.isMainEvent,
    isTitleFight: bout.isTitleFight,
    shortNotice: daysBetween(bout.bookedOn, bout.date) < 24,
  });
}
