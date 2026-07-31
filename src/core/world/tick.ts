import { DIFFICULTY } from '../config/calibration';
import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { narrateResult } from '../narrative/render';
import { applyDetail, detailForBout, shouldNarrate, shouldSummarizeRounds, type DetailContext, type SimDetail } from './detail';
import { clamp, Rng } from '../rng';
import { simulateFight, type FightSimOptions } from '../sim/engine';
import type { GamePlanKey } from '../types/world';
import { addDays, ageOn, dayOfWeek, daysBetween, formatDate, yearOf, type BoutId, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, type Bout, type FightResult } from '../types/fight';
import { ovrDisplayed, type Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { autoCampFor, finalizeCamp, runCampWeek } from './camp';
import { applyPopularity, assignEventBonuses, computeLeverage, createContractOffer, decayPopularity, generateContract, popularityFromResult, purseForBout } from './economy';
import { applyDeltas, developWeek, evenFocus, potConfidenceFor, retirementChance } from './development';
import { invalidatePot, prunePotCache, refreshPotForAll, updatePot } from './pot';
import { moveFighterToGym, rollFighterAutonomy, runGymMonth, updateHappiness } from './gyms';
import { computeSeasonAwards, newsForResult, pushNews, retirementNews, runHallOfFameVote } from './history';
import {
  activeInjuries,
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
import { applyReplacement, bookEvent, cancelBout, CHAMPION_TURNAROUND_DAYS, findReplacement, isAvailable, openOfferFighterIds, regionOfFighter, scheduleEvents, shouldCreateInterimTitle } from './matchmaking';
import { inCampFighterIds } from './availability';
import { applyFightPurse, paySponsorsForFight, runFinanceWeek } from './finance';
import { clearExpiredSuspensions, runAntiDopingWeek } from './antidoping';
import { recordSocialHistory } from './identity';
import { bookBout, FIGHT_WEEK_DAYS, hasLiveBooking, releaseBooking } from './availability';
import { checkPlayerInjuries } from './injury-flow';
import { ensureFightWeekTasks, pruneFightWeek } from './fightweek';
import { generateSocialItems, pruneSocial, socialRng } from './social';
import { campLifeRng, generateCampLife, seedGymRelationships } from './camp-life';
import { decayRelationships, openCallouts, pruneCallouts, recordFightBetween, resolveCallout } from './relationships';
import { enforceAbsentChampions, maybeSuggestMove } from './weightclass';
import { assignOfficials, judgePersonasFor, recordOfficialOutcome, refereeTendencyFor } from './officials';
import { applyResultToContenders, forfeitContenderStatus, fulfilContenderStatus, reviewContenderClaims } from './contender';
import { evaluateAllInterests, pruneMatchupInterests } from './matchup-interest';
import { runMatchupInterestPass } from './matchup-pass';
import { existingTitleOffer, interimTitleJustification, rankChallengers, titleShotEligibility, unificationDue } from './title-eligibility';
import { cancelStaleDivisionBouts, enforceDivisionInvariant, runNpcCallouts, runNpcWeightClassMoves } from './npc-behaviour';
import { pruneGamePlans } from './gameplan-memory';
import { syncCareerState } from './career';
import './decision-handlers';
import { PROMOTION_CONTRACTS } from '../config/branding';
import { applyResultToRankings, applyTitleOutcome, recomputeDivision, recomputePfp } from './rankings';
import { generateFighter } from './generator';
import { closeCompetingOffers, createFightOffer, expireOffers } from './offers';
import { addInboxMessage, messageNeedsAction, reconcileInbox } from './inbox';
import { VENUE_CITIES } from './venues';
import { addHypeMoment, computeHype, escalateRivalry, pruneHype, updateAllHype } from './hype';
import { computeEventBusiness } from './business';
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
  /** Stop as soon as an inbox item needs an answer. */
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
  return plans.slice(0, 3);
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
    sharpness = shortNotice ? clamp(rng.normal(0.35, 0.1), 0.1, 0.6) : clamp(rng.normal(0.62, 0.13), 0.2, 0.95);
    familiarity = shortNotice ? clamp(rng.normal(0.25, 0.1), 0.05, 0.5) : clamp(rng.normal(0.5, 0.13), 0.1, 0.85);
  }

  const cut = simulateWeightCut(
    fighter,
    {
      divisionId: bout.divisionId,
      isTitleFight: bout.isTitleFight,
      campWeeks: camp?.weeksCompleted ?? (shortNotice ? 2 : 7),
      nutritionSupport: fighter.gymId && save.gyms[fighter.gymId]?.staffIds.some((id) => save.staff[id]?.role === 'nutrition') ? 0.9 : 0.5,
      shortNotice,
      aggressiveness: 0.5,
    },
    save.date,
    rng
  );
  applyWear(fighter, cut.wear, fighter.development.resilience);

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
    pushNews(save, {
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
  const assignment = featureEnabled(save.settings, 'persistentOfficials')
    ? assignOfficials(save, bout)
    : { judgeIds: [], refereeId: null };
  const hostEvent = save.events[bout.eventId];
  // A partisan crowd only exists when one fighter is at home and the other is not.
  const aHome = Boolean(hostEvent && a.country === hostEvent.country);
  const bHome = Boolean(hostEvent && b.country === hostEvent.country);
  const homeAdvantage = aHome === bHome ? 0 : aHome ? 0.12 : -0.12;

  const prepA = prepareSide(save, bout, a, rng, save.player.fighterId === a.id ? playerPlan : undefined);
  const prepB = prepareSide(save, bout, b, rng, save.player.fighterId === b.id ? playerPlan : undefined);

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
    judges: judgePersonasFor(save, assignment, homeAdvantage),
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

  applyResult(save, bout, result, rng, prepA.shortNotice, prepB.shortNotice);
  // What the officials did is recorded against them, so a judge builds a history.
  recordOfficialOutcome(save, bout, result);
  if (event) newsForResult(save, result, event.name);
  return result;
}

/** Applies a completed result to both fighters, the rankings and the history. */
export function applyResult(save: SaveGame, bout: Bout, result: FightResult, rng: Rng, shortNoticeA: boolean, shortNoticeB: boolean): void {
  const a = save.fighters[result.fighterAId];
  const b = save.fighters[result.fighterBId];
  const event = save.events[bout.eventId];

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

    if (won) {
      fighter.record.wins++;
      fighter.ufcRecord.wins++;
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
      fighter.record.draws++;
      fighter.ufcRecord.draws++;
      fighter.winStreak = 0;
    } else {
      fighter.record.losses++;
      fighter.ufcRecord.losses++;
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

    // Health.
    applyWear(fighter, wearFromFight(fighter, result, save), fighter.development.resilience);
    if (save.settings.injuriesEnabled) {
      const injuries = injuriesFromFight(fighter, result, rng);
      fighter.injuries.push(...injuries);
      if (fighter.id === a.id) result.injuriesA = injuries.map((i) => i.type);
      else result.injuriesB = injuries.map((i) => i.type);
    }
    fighter.medicalSuspension = medicalSuspensionFor(fighter, result, rng);

    // Popularity, fame and reach. Attention and approval move separately.
    const eventRegion = VENUE_CITIES.find((v) => v.city === event?.city)?.region ?? 'north-america';
    const change = popularityFromResult(fighter, result, save, {
      isMainEvent: bout.isMainEvent,
      eventRegion,
      homeRegion: regionOfFighter(fighter),
    });
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

  // Rankings and titles.
  applyResultToRankings(save, result, shortNoticeA, shortNoticeB);
  const titleNotes = applyTitleOutcome(save, result);
  // Winning an eliminator earns the number one contender position, and the standing contender
  // losing gives it up. Without this an eliminator was a label that meant nothing.
  for (const note of applyResultToContenders(save, bout, result)) {
    titleNotes.push(note);
    pushNews(save, {
      date: save.date,
      headline: note,
      body: note,
      tags: ['title', bout.divisionId],
      fighterIds: [bout.fighterAId, bout.fighterBId],
      importance: 3,
    });
  }
  for (const note of titleNotes) {
    pushNews(save, { date: result.date, headline: note, body: result.narrativeSummary, tags: ['title'], fighterIds: [a.id, b.id], importance: 5 });
  }
  if (result.isTitleFight && result.winnerId) {
    const winner = save.fighters[result.winnerId];
    if (winner.gymId) {
      const gym = save.gyms[winner.gymId];
      if (gym) gym.championsProduced++;
    }
  }

  // Rating history entry so a fighter page can show the shape of a career.
  for (const f of [a, b]) {
    f.ratingHistory.push({
      date: result.date,
      ratings: { ...f.ratings },
      ovr: ovrDisplayed(f.ratings),
      pot: f.pot,
      longevity: f.longevity,
      reason: `after ${result.winnerId === f.id ? 'beating' : result.winnerId === null ? 'drawing with' : 'losing to'} ${f.id === a.id ? b.name : a.name}`,
    });
    if (ovrDisplayed(f.ratings) > f.peakOvr) {
      f.peakOvr = ovrDisplayed(f.ratings);
      f.peakOvrDate = result.date;
    }
  }
}

/** Resolves every remaining bout on an event and closes it out. */
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
      if (save.player.fighterId === fid) save.player.balance += event.bonusAmount;
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
          if (save.player.fighterId === fid) save.player.balance += event.bonusAmount;
        }
      }
    }
  }

  // Event economics is the heaviest per event computation, so a save that has it switched off
  // skips it rather than computing figures nothing will read.
  if (featureEnabled(save.settings, 'businessDepth')) computeEventBusiness(save, event, rng);
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
 * event stream. Older fights keep their totals, scorecards, round summaries and result,
 * which is everything the record books, fighter pages and history pages actually read.
 */
const KEEP_FULL_EVENTS_FIGHTS = 40;
/** Fights that keep their round by round statistics. */
const KEEP_ROUND_STATS_FIGHTS = 220;
/** Fights that keep a trimmed closing sequence. Beyond this the event stream is dropped. */
const KEEP_CLOSING_EVENTS_FIGHTS = 400;

export function pruneHistory(save: SaveGame): { prunedEvents: number; prunedRounds: number } {
  const results = Object.values(save.history.results).sort((a, b) => (a.date < b.date ? 1 : -1));
  let prunedEvents = 0;
  let prunedRounds = 0;
  const playerId = save.player.fighterId;

  results.forEach((r, index) => {
    const playerFight = playerId !== null && (r.fighterAId === playerId || r.fighterBId === playerId);
    if (playerFight) return;
    if (index < KEEP_FULL_EVENTS_FIGHTS) return;
    if (r.events.length > 0) {
      // The closing sequence is kept so a finish can still be described accurately, then
      // dropped entirely once the fight is far enough into the past. The recap, totals,
      // scorecards and result survive either way.
      r.events = index > KEEP_CLOSING_EVENTS_FIGHTS ? [] : r.events.slice(-10);
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
      if (r.events.length > 0) r.events = [];
    }
  });
  return { prunedEvents, prunedRounds };
}

function weeklyMaintenance(save: SaveGame, rng: Rng, headlines: string[]): void {
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
    const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && (c.status === 'planned' || c.status === 'running'));
    if (camp && camp.startDate <= save.date && camp.endDate > save.date) {
      const week = runCampWeek(save, camp, rng);
      if (fighter.id === playerFighterId) {
        for (const o of week.outcomes) headlines.push(`Camp: ${o.headline}.`);
      }
      if (week.injured && fighter.nextBoutId) {
        // A camp injury can force a withdrawal.
        const bout = save.bouts[fighter.nextBoutId];
        const blocking = activeInjuries(fighter, save.date).some((i) => i.blocksCompetition);
        if (bout && blocking) withdrawFromBout(save, bout, fighter.id, 'injured in camp', rng, headlines);
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
          trainingQuality: 0.42 * capacity,
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
      restRecovery(fighter, 1);

      if (save.settings.injuriesEnabled && gym) {
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
        if (injury) {
          fighter.injuries.push(injury);
          if (injury.severity >= 4) invalidatePot(save, fighter.id, 'major-injury');
          if (fighter.id === playerFighterId) headlines.push(`${injury.type} picked up in training.`);
          if (fighter.nextBoutId && injury.blocksCompetition) {
            const bout = save.bouts[fighter.nextBoutId];
            if (bout) withdrawFromBout(save, bout, fighter.id, 'injured in training', rng, headlines);
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
    const weight = manageWalkingWeight(fighter, save.date);
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
      if (fighter.id === playerFighterId) headlines.push(`Moved up to ${to.name}.`);
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
    const inactive = champ.lastFightDate ? daysBetween(champ.lastFightDate, save.date) : 999;
    const blocked = !canCompete(champ, save.date).ok;
    if (inactive > 550 || (blocked && inactive > 430) || champ.retired || champ.activityStatus !== 'active') {
      table.championId = null;
      champ.isChampion = false;
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
          b.bookingReason = `${b.bookingReason}. Upgraded to an undisputed title bout after the championship was vacated.`;
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
  for (const d of DIVISIONS) {
    if (!shouldCreateInterimTitle(save, d.id)) continue;
    const alreadyAnnounced = save.history.news.some(
      (n) => n.tags.includes(d.id) && n.headline === `${d.name} interim title in play` && daysBetween(n.date, save.date) < 240
    );
    if (alreadyAnnounced) continue;
    pushNews(save, {
      date: save.date,
      headline: `${d.name} interim title in play`,
      body: `With the champion inactive, the next top contender bout in the ${d.name} division will be for an interim title.`,
      tags: ['title', d.id],
      fighterIds: [],
      importance: 4,
    });
  }

  // Contract expiry and renewal.
  for (const fighter of Object.values(save.fighters)) {
    if (fighter.retired) continue;
    const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
    if (!contract || contract.status !== 'expired') continue;
    if (fighter.id === playerFighterId) {
      // One offer at a time. A fresh one is issued only after the previous one has been
      // off the table for a while, so ignoring a deal does not flood the inbox.
      const existing = Object.values(save.contractOffers).filter((o) => o.fighterId === fighter.id);
      if (existing.some((o) => o.status === 'open')) continue;
      const latest = existing.sort((x, y) => (x.createdOn > y.createdOn ? -1 : 1))[0];
      if (latest && daysBetween(latest.createdOn, save.date) < 28) continue;
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
          body: `${fighter.name} has been let go after ${fighter.lossStreak} straight losses.`,
          tags: ['roster'],
          fighterIds: [fighter.id],
          importance: 1,
        });
      }
    }
  }

  // Retirements.
  if (save.settings.retirementEnabled) {
    for (const fighter of Object.values(save.fighters)) {
      if (fighter.retired || fighter.id === playerFighterId) continue;
      if (fighter.nextBoutId) continue;
      const weekly = retirementChance(fighter, save.date) / 52;
      if (rng.chance(weekly)) {
        fighter.retired = true;
        fighter.retirementDate = save.date;
        fighter.activityStatus = 'retired';
        const table = save.rankings[fighter.divisionId];
        // A retiring fighter gives up whatever they hold. Clearing only the undisputed belt left a
        // retired fighter listed as interim champion, and the strip pass would later promote them
        // into the vacancy they had just created.
        if (table.interimChampionId === fighter.id) {
          table.interimChampionId = null;
          fighter.isInterimChampion = false;
          const interimReign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && r.isInterim);
          if (interimReign) {
            interimReign.lostOn = save.date;
            interimReign.endReason = 'retired';
          }
        }
        // A contender position is given up too, so the division is not left waiting on somebody
        // who will never fight again.
        forfeitContenderStatus(save, fighter.divisionId, `${fighter.name} has retired.`, fighter.id);
        if (table.championId === fighter.id) {
          table.championId = null;
          fighter.isChampion = false;
          const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim);
          if (reign) {
            reign.lostOn = save.date;
            reign.endReason = 'retired';
          }
          pushNews(save, {
            date: save.date,
            headline: `${DIVISIONS.find((d) => d.id === fighter.divisionId)!.name} title is vacant`,
            body: `${fighter.name} has retired as champion. The title is vacated.`,
            tags: ['title', fighter.divisionId],
            fighterIds: [fighter.id],
            importance: 5,
          });
        }
        const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 34;
        retirementNews(
          save,
          fighter,
          fighter.longevity < 40 ? 'The accumulated damage made the decision.' : age >= 36 ? 'Age caught up with the career.' : 'The results stopped coming.',
          save.date
        );
      }
    }
  }

  // New prospects entering the roster.
  const activeCount = Object.values(save.fighters).filter((f) => !f.retired && f.activityStatus === 'active').length;
  // The roster is scaled against what the calendar can actually give people to do. See
  // ROSTER_TARGET_SCALE for the arithmetic that ties it to the activity bands.
  const divisionTarget = (d: { targetRosterSize: number }) => Math.round(d.targetRosterSize * ROSTER_TARGET_SCALE);
  const targetCount = DIVISIONS.reduce((s, d) => s + divisionTarget(d), 0);
  if (activeCount < targetCount && rng.chance(0.55)) {
    const shortDivisions = DIVISIONS.filter(
      (d) => Object.values(save.fighters).filter((f) => f.divisionId === d.id && !f.retired && f.activityStatus === 'active').length < divisionTarget(d)
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
        body: `${prospect.name}, ${prospect.ageAtSnapshot} years old out of ${prospect.country}, has been ${rng.pick(pathways)}. Record ${prospect.record.wins}-${prospect.record.losses}.`,
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
  // Contender claims are reviewed before title fights are booked, so a lapsed or vacated claim
  // frees the division in the same pass rather than blocking it for another week.
  for (const note of reviewContenderClaims(save)) headlines.push(note);

  // Every live matchmaking interest is re-evaluated against the world once a week, so a
  // blocked matchup becomes eligible again the moment its blocker clears.
  evaluateAllInterests(save);

  // Keep the calendar populated and book cards that need bouts.
  scheduleEvents(save, rng, 200);

  // Championship bouts are made before anything else. Without this, the top contenders
  // get absorbed into ordinary matchups on nearer cards and the title picture never
  // resolves.
  bookTitleFights(save, rng, headlines);
  const upcoming = Object.values(save.events)
    .filter((e) => e.status === 'announced' && e.date > save.date && daysBetween(save.date, e.date) < 120)
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  for (const ev of upcoming) {
    const bookedBouts = ev.boutIds.filter((id) => save.bouts[id]?.status === 'scheduled').length;
    const daysOut = daysBetween(save.date, ev.date);
    const targetBooked = daysOut > 90 ? 2 : daysOut > 60 ? 6 : daysOut > 35 ? 10 : 12;
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

  // Player facing flow. An injury with a fight booked becomes a decision that stops the
  // calendar, fight week tasks are generated once per bout, and social items arrive within
  // a weekly budget rather than flooding the inbox.
  if (playerFighterId) {
    const me = save.fighters[playerFighterId];
    if (me && !me.retired) {
      checkPlayerInjuries(save);
      const booked = hasLiveBooking(save, me);
      if (booked && daysBetween(save.date, booked.date) <= FIGHT_WEEK_DAYS + 2) {
        ensureFightWeekTasks(save, booked.id);
      }
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
        message.notificationSignature = `social|${item.signature}|${item.sourceFighterId ?? 'none'}`;
        message.decisionKey = message.notificationSignature;
        message.decisionCreatedOn = save.date;
        // Social items are opportunities. They never block the calendar.
        message.mandatory = false;
      }
      pruneSocial(save);
      pruneFightWeek(save);
      for (const note of runFinanceWeek(save, me)) headlines.push(note);
      // The anti-doping system is optional and off by default. The save recorded that and nothing
      // read it, so a player who turned it off still got tested.
      if (featureEnabled(save.settings, 'antiDoping')) {
        for (const note of runAntiDopingWeek(save, me, rng)) headlines.push(note);
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
      const matchupPass = runMatchupInterestPass(save, me, rng);
      for (const note of matchupPass.headlines) headlines.push(note);
      pruneMatchupInterests(save);
      pruneGamePlans(save);
      // Other fighters act too: they call the player out and occasionally change division.
      for (const note of runNpcCallouts(save, rng)) headlines.push(note);
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
      addInboxMessage(save, {
        sender: 'gym-owner',
        senderName: 'Gym finances',
        subject: `Monthly finances: ${month.net >= 0 ? 'surplus' : 'shortfall'}`,
        body: `${month.lines.join('. ')}. Net ${month.net >= 0 ? 'surplus' : 'shortfall'} of ${Math.abs(month.net)}. Balance is now ${Math.round(gym.balance)}.`,
        category: 'gym',
        requiresAction: false,
        choices: [{ key: 'ack', label: 'Acknowledge' }],
      });
    }
  }
}

/**
 * Books championship bouts. A champion who has been idle long enough is matched with the
 * highest ranked available contender on the next suitable card, and both are reserved
 * before general matchmaking runs.
 */
function bookTitleFights(save: SaveGame, rng: Rng, headlines: string[]): void {
  const offerIds = openOfferFighterIds(save);
  const campIds = inCampFighterIds(save);
  const upcoming = Object.values(save.events)
    .filter((e) => e.status === 'announced')
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

      if (champion && isAvailable(save, champion, ctx)) {
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
      if (!selectionReason) selectionReason = challengerCheck.selectionReason;

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
        isMainEvent: true,
        isCoMain: false,
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
        createFightOffer(save, self, opp, card, rng, {
          isMainEvent: true,
          isTitleFight: !interimBout,
          isInterimTitleFight: interimBout,
          scheduledRounds: 5,
          reason: bout.bookingReason,
          isReplacementSlot: false,
          bookingKind: bout.bookingKind,
        });
      } else {
        // The bout stands, so the claim is honoured now.
        fulfilContenderStatus(save, d.id, sideB.id, boutId);
        for (const f of [sideA, sideB]) autoCampFor(save, f, boutId, card.date, rng);
      }

      pushNews(save, {
        date: save.date,
        headline: `${sideA.name} against ${sideB.name} set for ${card.name}`,
        body: `The ${d.name} ${interimBout ? 'interim ' : ''}title will be on the line at ${card.name} in ${card.city} on ${card.date}.`,
        tags: ['title', d.id],
        fighterIds: [sideA.id, sideB.id],
        importance: 4,
      });
      headlines.push(`${d.name} title bout booked: ${sideA.name} against ${sideB.name}.`);
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
  const replacement = findReplacement(save, bout, fighterId, rng);
  const withdrawn = save.fighters[fighterId];
  if (replacement) {
    applyReplacement(save, bout, fighterId, replacement.fighter, replacement.reason);
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
      addInboxMessage(save, {
        sender: 'replacement-coordinator',
        senderName: 'Matchmaking',
        subject: 'Opponent change',
        body: `${withdrawn?.name ?? 'The scheduled opponent'} is out with ${reason}. ${replacement.fighter.name} has accepted the bout, ${replacement.reason}.`,
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

export function advance(save: SaveGame, opts: AdvanceOptions): AdvanceReport {
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
  const startingDecisions = pendingDecisions(save);

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
      if (booked && daysBetween(save.date, booked.date) <= FIGHT_WEEK_DAYS + 1) {
        const created = ensureFightWeekTasks(save, booked.id);
        if (created.length > 0) headlines.push('Fight Week Begins.');
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
    const decisionsNow = pendingDecisions(save);
    if ((opts.stopOnDecision ?? save.settings.autoAdvanceStopsOnDecision) && decisionsNow > startingDecisions) {
      stoppedBecause = 'A decision needs an answer in the inbox.';
      break;
    }
    if (opts.mode === 'next-message' && decisionsNow > 0) {
      stoppedBecause = 'There is a message waiting.';
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
  }

  persistRng(save, rng);
  save.updatedAt = new Date().toISOString();

  return {
    from,
    to: save.date,
    daysAdvanced: daysBetween(from, save.date),
    eventsResolved,
    headlines,
    stoppedBecause,
    playerBoutPending,
  };
}

/** Simulates the player's own bout, used by the fight viewer once the player is ready. */
export function simulatePlayerBout(save: SaveGame, boutId: BoutId, playerPlan: GamePlanKey[]): FightResult {
  const rng = rngOf(save);
  const bout = save.bouts[boutId];
  const result = resolveBout(save, bout, rng, playerPlan);
  // Resolve the rest of the card around it, passing the player's result in so it is part of the
  // card for the contested list and for bonus selection.
  const event = save.events[bout.eventId];
  if (event) {
    resolveEvent(save, event.id, rng, {}, [result]);
  }
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
