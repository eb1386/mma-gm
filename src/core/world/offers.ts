import { contractedWeight, DIVISION_BY_ID } from '../config/divisions';
import { clamp, Rng } from '../rng';
import { addDays, daysBetween, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, type Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { FightCardEvent, FightOffer } from '../types/world';
import type { SaveGame } from '../types/save';
import { purseForBout } from './economy';
import { addInboxMessage, resolveMessagesForOffer } from './inbox';
import { regionOfFighter } from './matchmaking';
import { travelDistanceKm, VENUE_CITIES } from './venues';
import { canCompete } from './health';
import { PROMOTION_MATCHMAKING } from '../config/branding';
import { bookBout, findExistingOffer, offerBlockReason, offerKey, OFFER_COOLDOWN_DAYS, recentlyDeclined, type OfferIdentity } from './availability';

/**
 * Fight offers.
 *
 * Declining is a legitimate choice with graded consequences rather than an automatic
 * career ending mistake. The consequence depends on why the fighter said no.
 */

export interface CreateOfferOptions {
  isMainEvent: boolean;
  isTitleFight: boolean;
  isInterimTitleFight: boolean;
  scheduledRounds: 3 | 5;
  reason: string;
  isReplacementSlot: boolean;
  /** The fighter is hurt now but the event is far enough out to be worth asking about. */
  medicallyContingent?: boolean;
}

export function rankingImplication(save: SaveGame, fighter: Fighter, opponent: Fighter, opts: CreateOfferOptions): string {
  if (opts.isInterimTitleFight) return 'Interim championship on the line.';
  if (opts.isTitleFight) return 'Undisputed championship on the line.';
  const table = save.rankings[fighter.divisionId];
  const oppRank = table.championId === opponent.id ? 0 : opponent.ranking;
  const ownRank = table.championId === fighter.id ? 0 : fighter.ranking;
  if (oppRank === null) return 'A win keeps the run going but does not move the rankings much.';
  if (ownRank === null) return `A win over the number ${oppRank} contender should be enough to enter the rankings.`;
  if (oppRank < ownRank) return `A win should move you up from ${ownRank} toward ${oppRank}.`;
  if (oppRank > ownRank) return `A win holds position at ${ownRank}. A loss drops you well down.`;
  return 'A tight matchup between fighters ranked next to each other.';
}

/**
 * Creates a fight offer, or returns the one that already exists.
 *
 * Every generator funnels through here. The identity key means a second pass over the same
 * card cannot put a duplicate of the same matchup in the inbox, and `offerBlockReason`
 * means a fighter who is booked, in camp, injured or already holding an offer is never
 * approached at all. Returns null when the offer is refused, with the reason recorded on
 * the returned refusal so callers can report a no-op rather than appearing to succeed.
 */
export function createFightOffer(
  save: SaveGame,
  fighter: Fighter,
  opponent: Fighter,
  event: FightCardEvent,
  _rng: Rng,
  opts: CreateOfferOptions
): FightOffer | null {
  const identity: OfferIdentity = {
    fighterId: fighter.id,
    opponentId: opponent.id,
    eventId: event.id,
    slot: opts.isMainEvent ? 'main' : 'card',
    offerType: opts.medicallyContingent
      ? 'medically-contingent'
      : opts.isReplacementSlot
        ? 'replacement'
        : opts.isInterimTitleFight
          ? 'interim-title'
          : opts.isTitleFight
            ? 'title'
            : 'ordinary',
    isReplacementSlot: opts.isReplacementSlot,
  };
  // A fighter who is hurt today but expected to be clear by the event is a contingent
  // approach, not an ordinary one. The caller does not have to know that; it is derived
  // here so every generator labels it the same way.
  const contingent = opts.medicallyContingent === true || (!canCompete(fighter, save.date).ok && canCompete(fighter, event.date).ok);
  if (contingent) identity.offerType = 'medically-contingent';

  const key = offerKey(identity);
  const existingId = findExistingOffer(save, key);
  if (existingId) return save.fightOffers[existingId];

  // The offer is refused outright when the fighter is spoken for. A replacement slot
  // relaxes turnaround and notice but never health, booking or an existing offer.
  const blocked = offerBlockReason(save, fighter, {
    eventDate: event.date,
    isReplacementSlot: opts.isReplacementSlot,
    allowMedicallyContingent: contingent,
  });
  if (blocked) return null;
  if (!opts.isReplacementSlot && recentlyDeclined(save, fighter.id, opponent.id, event.id)) return null;

  const noticeDays = daysBetween(save.date, event.date);
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const purse = purseForBout(contract, fighter, save, {
    isMainEvent: opts.isMainEvent,
    isTitleFight: isChampionshipBout(opts),
    shortNotice: noticeDays < 24,
  });
  const venue = VENUE_CITIES.find((v) => v.city === event.city);
  const offer: FightOffer = {
    id: `offer-${++save.counters.offer}`,
    fighterId: fighter.id,
    opponentId: opponent.id,
    eventId: event.id,
    eventName: event.name,
    date: event.date,
    city: event.city,
    country: event.country,
    divisionId: fighter.divisionId,
    contractedWeightLb: contractedWeight(fighter.divisionId, isChampionshipBout(opts)),
    scheduledRounds: opts.scheduledRounds,
    isMainEvent: opts.isMainEvent,
    isTitleFight: opts.isTitleFight,
    isInterimTitleFight: opts.isInterimTitleFight,
    isCatchweight: false,
    noticeDays,
    campWeeksAvailable: Math.max(0, Math.floor((noticeDays - 7) / 7)),
    showPay: purse.show,
    winBonus: purse.win,
    shortNoticeBonus: noticeDays < 24 ? (contract?.terms.shortNoticeBonus ?? 0) : 0,
    rankingImplication: rankingImplication(save, fighter, opponent, opts),
    travelKm: travelDistanceKm(regionOfFighter(fighter), venue?.region ?? 'north-america'),
    reason: opts.reason,
    createdOn: save.date,
    deadline: addDays(save.date, Math.min(10, Math.max(2, Math.floor(noticeDays / 3)))),
    isReplacementSlot: opts.isReplacementSlot,
    idempotencyKey: key,
    medicallyContingent: contingent,
    status: 'open',
    requestsUsed: 0,
  };
  save.fightOffers[offer.id] = offer;

  const health = canCompete(fighter, save.date);
  addInboxMessage(save, {
    sender: 'matchmaker',
    senderName: PROMOTION_MATCHMAKING,
    subject: `${contingent ? 'Medically contingent offer' : opts.isTitleFight ? 'Title fight offer' : opts.isInterimTitleFight ? 'Interim title fight offer' : opts.isMainEvent ? 'Main event offer' : 'Fight offer'}: ${opponent.name}`,
    body: `${event.name} in ${event.city}, ${event.country} on ${event.date}. ${opts.scheduledRounds} rounds at ${offer.contractedWeightLb} lb. ${noticeDays} days notice, about ${offer.campWeeksAvailable} weeks of camp. Reason for the offer: ${opts.reason}. ${offer.rankingImplication}${health.ok ? '' : ` Note: currently unavailable (${health.reason}).`}${contingent ? ' This offer is contingent on medical clearance in time for the event. It is withdrawn automatically if you are not cleared.' : ''}`,
    category: 'offer',
    requiresAction: true,
    deadline: offer.deadline,
    choices: [
      { key: 'open-offer', label: 'Review the offer' },
    ],
    linkedFighterId: opponent.id,
    linkedEventId: event.id,
    linkedOfferId: offer.id,
  });

  return offer;
}

export type OfferResponse =
  | { kind: 'accept' }
  | { kind: 'decline'; reason: 'injury' | 'short-notice' | 'money' | 'opponent' | 'unreasonable' | 'no-reason' }
  | { kind: 'request-date' }
  | { kind: 'request-opponent' }
  | { kind: 'request-money'; amount: number }
  | { kind: 'request-catchweight'; weightLb: number }
  | { kind: 'request-five-rounds' }
  | { kind: 'request-title-fight' }
  | { kind: 'request-more-time'; weeks: number }
  | { kind: 'volunteer-replacement' };

export interface OfferOutcome {
  accepted: boolean;
  boutId: string | null;
  message: string;
  relationshipDelta: number;
  newOffer: FightOffer | null;
}

/**
 * Applies the player's response. Consequences scale with context: an injured fighter
 * declining a two week notice bout is treated very differently from a healthy contender
 * turning down a third straight offer.
 */
export function respondToOffer(save: SaveGame, offerId: string, response: OfferResponse, rng: Rng): OfferOutcome {
  const offer = save.fightOffers[offerId];
  if (!offer || offer.status !== 'open') {
    return { accepted: false, boutId: null, message: 'That offer is no longer on the table.', relationshipDelta: 0, newOffer: null };
  }
  const fighter = save.fighters[offer.fighterId];
  const opponent = save.fighters[offer.opponentId];
  const event = save.events[offer.eventId];
  if (!fighter || !opponent || !event) {
    offer.status = 'withdrawn';
    resolveMessagesForOffer(save, offer.id, 'The bout is no longer available.');
    return { accepted: false, boutId: null, message: 'The bout is no longer available.', relationshipDelta: 0, newOffer: null };
  }

  if (response.kind === 'accept') {
    const bout = acceptOffer(save, offer);
    if (!bout) {
      // The booking transaction refused, which means one of the two fighters was taken
      // between the offer being made and answered. The offer closes rather than silently
      // appearing to succeed.
      offer.status = 'withdrawn';
      resolveMessagesForOffer(save, offer.id, 'The bout was no longer available to book.');
      return {
        accepted: false,
        boutId: null,
        message: 'That bout could not be booked. One of the fighters was matched elsewhere first.',
        relationshipDelta: 0,
        newOffer: null,
      };
    }
    offer.status = 'accepted';
    resolveMessagesForOffer(save, offer.id, `Accepted the bout against ${opponent.name}.`);
    fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker + (offer.noticeDays < 24 ? 8 : 3), 0, 100);
    if (offer.noticeDays < 24) fighter.acceptedShortNotice++;
    return {
      accepted: true,
      boutId: bout.id,
      message: `Bout agreed. ${fighter.name} faces ${opponent.name} at ${event.name} on ${event.date}.`,
      relationshipDelta: offer.noticeDays < 24 ? 8 : 3,
      newOffer: null,
    };
  }

  if (response.kind === 'decline') {
    offer.status = 'declined';
    fighter.offerCooldownUntil = addDays(save.date, OFFER_COOLDOWN_DAYS);
    const outcome = declineConsequence(save, fighter, offer, response.reason, rng);
    resolveMessagesForOffer(save, offer.id, `Declined the bout against ${opponent.name}. ${outcome.message}`);
    return { accepted: false, boutId: null, message: outcome.message, relationshipDelta: outcome.delta, newOffer: outcome.replacement };
  }

  // Requests. Each one costs a request slot; the matchmaker's patience is finite.
  offer.requestsUsed++;
  if (offer.requestsUsed > 2) {
    offer.status = 'withdrawn';
    resolveMessagesForOffer(save, offer.id, 'The matchmaker pulled the offer after too much back and forth.');
    fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 7, 0, 100);
    return {
      accepted: false,
      boutId: null,
      message: 'The matchmaker has run out of patience with the back and forth and pulled the offer.',
      relationshipDelta: -7,
      newOffer: null,
    };
  }

  const leverage = clamp(
    (fighter.ranking !== null ? 16 - fighter.ranking : 2) * 3 + fighter.popularity * 0.4 + fighter.relationships.matchmaker * 0.3,
    0,
    100
  );

  switch (response.kind) {
    case 'request-money': {
      const cap = offer.showPay * (1 + clamp(leverage / 190, 0.03, 0.5));
      if (response.amount <= cap) {
        const granted = Math.round(Math.min(response.amount, cap));
        offer.showPay = granted;
        return { accepted: false, boutId: null, message: `Purse increased to ${granted}. The offer stands.`, relationshipDelta: -1, newOffer: offer };
      }
      fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 3, 0, 100);
      return { accepted: false, boutId: null, message: 'That number is not happening for this bout. The original offer stands.', relationshipDelta: -3, newOffer: offer };
    }
    case 'request-date': {
      const later = Object.values(save.events)
        .filter((e) => e.status === 'announced' && daysBetween(offer.date, e.date) > 20 && daysBetween(offer.date, e.date) < 100)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (later && rng.chance(clamp(0.3 + leverage / 220, 0.15, 0.8))) {
        offer.eventId = later.id;
        offer.eventName = later.name;
        offer.date = later.date;
        offer.city = later.city;
        offer.country = later.country;
        offer.noticeDays = daysBetween(save.date, later.date);
        offer.campWeeksAvailable = Math.max(0, Math.floor((offer.noticeDays - 7) / 7));
        return { accepted: false, boutId: null, message: `Moved to ${later.name} on ${later.date}.`, relationshipDelta: -1, newOffer: offer };
      }
      return { accepted: false, boutId: null, message: 'No suitable later date is available. The original offer stands.', relationshipDelta: -2, newOffer: offer };
    }
    case 'request-opponent': {
      if (rng.chance(clamp(leverage / 260, 0.05, 0.4))) {
        offer.status = 'withdrawn';
        resolveMessagesForOffer(save, offer.id, 'The matchmaker will look for a different opponent.');
        return {
          accepted: false,
          boutId: null,
          message: 'The matchmaker will look at other options and come back with something else.',
          relationshipDelta: -4,
          newOffer: null,
        };
      }
      fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 5, 0, 100);
      return { accepted: false, boutId: null, message: 'This is the fight they want to make. The offer stands as is.', relationshipDelta: -5, newOffer: offer };
    }
    case 'request-catchweight': {
      const division = DIVISION_BY_ID[offer.divisionId];
      const delta = Math.abs(response.weightLb - division.limitLb);
      if (delta <= 6 && !offer.isTitleFight && rng.chance(0.55)) {
        offer.contractedWeightLb = response.weightLb;
        offer.isCatchweight = true;
        return { accepted: false, boutId: null, message: `Catchweight agreed at ${response.weightLb} lb.`, relationshipDelta: -1, newOffer: offer };
      }
      return { accepted: false, boutId: null, message: 'The bout stays at the division weight.', relationshipDelta: -2, newOffer: offer };
    }
    case 'request-five-rounds': {
      if (offer.isMainEvent || rng.chance(clamp(leverage / 300, 0.03, 0.3))) {
        offer.scheduledRounds = 5;
        return { accepted: false, boutId: null, message: 'Approved as a five round bout.', relationshipDelta: 0, newOffer: offer };
      }
      return { accepted: false, boutId: null, message: 'Five rounds are reserved for the main event on this card.', relationshipDelta: -1, newOffer: offer };
    }
    case 'request-title-fight': {
      const table = save.rankings[fighter.divisionId];
      const contenderReady = fighter.ranking !== null && fighter.ranking <= 3 && fighter.winStreak >= 2;
      const championAvailable = table.championId && !save.fighters[table.championId]?.nextBoutId;
      if (contenderReady && championAvailable && rng.chance(0.45)) {
        offer.status = 'withdrawn';
        resolveMessagesForOffer(save, offer.id, 'The matchmaker will put a title shot together instead.');
        return {
          accepted: false,
          boutId: null,
          message: 'The case has been heard. The matchmaker will put a title shot together instead of this bout.',
          relationshipDelta: 2,
          newOffer: null,
        };
      }
      return {
        accepted: false,
        boutId: null,
        message: contenderReady
          ? 'The title picture is not open right now. Win this one and the case makes itself.'
          : 'Not yet. There is more work to do before that conversation happens.',
        relationshipDelta: -2,
        newOffer: offer,
      };
    }
    case 'request-more-time': {
      const later = Object.values(save.events)
        .filter((e) => e.status === 'announced' && daysBetween(offer.date, e.date) >= response.weeks * 7 - 10)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (later && rng.chance(0.5)) {
        offer.eventId = later.id;
        offer.eventName = later.name;
        offer.date = later.date;
        offer.noticeDays = daysBetween(save.date, later.date);
        offer.campWeeksAvailable = Math.max(0, Math.floor((offer.noticeDays - 7) / 7));
        return { accepted: false, boutId: null, message: `Extra preparation time granted. Now on ${later.date}.`, relationshipDelta: -1, newOffer: offer };
      }
      return { accepted: false, boutId: null, message: 'The card is set. There is no more time available.', relationshipDelta: -2, newOffer: offer };
    }
    case 'volunteer-replacement': {
      return { accepted: false, boutId: null, message: 'Noted. The matchmaker will call first if a slot opens.', relationshipDelta: 4, newOffer: offer };
    }
  }
}

function acceptOffer(save: SaveGame, offer: FightOffer): Bout | null {
  const fighter = save.fighters[offer.fighterId];
  const opponent = save.fighters[offer.opponentId];
  const event = save.events[offer.eventId];
  const contractA = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const contractB = opponent.contractId ? save.contracts[opponent.contractId] : null;
  const shortNotice = offer.noticeDays < 24;

  const bout: Bout = {
    id: `bout-${++save.counters.bout}`,
    eventId: event.id,
    date: event.date,
    fighterAId: fighter.id,
    fighterBId: opponent.id,
    divisionId: offer.divisionId,
    contractedWeightLb: offer.contractedWeightLb,
    scheduledRounds: offer.scheduledRounds,
    isTitleFight: offer.isTitleFight,
    isInterimTitleFight: offer.isInterimTitleFight,
    titleIneligibleFighterIds: [],
    isMainEvent: offer.isMainEvent,
    isCoMain: false,
    cardSegment: offer.isMainEvent ? 'main' : 'main',
    boutOrder: offer.isMainEvent ? 12 : 8,
    isCatchweight: offer.isCatchweight,
    status: 'scheduled',
    resultId: null,
    bookedOn: save.date,
    replacementHistory: [],
    cancelReason: null,
    purseA: { show: offer.showPay, win: offer.winBonus },
    purseB: purseForBout(contractB, opponent, save, {
      isMainEvent: offer.isMainEvent,
      isTitleFight: isChampionshipBout(offer),
      shortNotice,
    }),
    weighInA: null,
    weighInB: null,
    bookingReason: offer.reason,
  };
  void contractA;

  // One transaction takes ownership of both fighters. Accepting also closes every other
  // offer either fighter is holding, so an accepted bout cannot leave a competing offer
  // live in the inbox.
  const booking = bookBout(save, bout);
  if (!booking.created) return null;
  closeCompetingOffers(save, fighter.id, offer.id, `${fighter.name} accepted another bout.`);
  closeCompetingOffers(save, opponent.id, offer.id, `${opponent.name} accepted another bout.`);
  return bout;
}

/** Withdraws every other open offer naming this fighter. Called the moment one is taken. */
export function closeCompetingOffers(save: SaveGame, fighterId: FighterId, keepOfferId: string, reason: string): number {
  let closed = 0;
  for (const other of Object.values(save.fightOffers)) {
    if (other.id === keepOfferId) continue;
    if (other.status !== 'open') continue;
    if (other.fighterId !== fighterId && other.opponentId !== fighterId) continue;
    other.status = 'withdrawn';
    resolveMessagesForOffer(save, other.id, reason);
    closed++;
  }
  return closed;
}

interface DeclineOutcome {
  message: string;
  delta: number;
  replacement: FightOffer | null;
}

function declineConsequence(
  save: SaveGame,
  fighter: Fighter,
  offer: FightOffer,
  reason: string,
  rng: Rng
): DeclineOutcome {
  const health = canCompete(fighter, save.date);
  const injured = !health.ok || reason === 'injury';
  const veryShortNotice = offer.noticeDays < 18;
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const obligated = contract ? contract.fightsRemaining > 0 : false;

  fighter.declinedOffers++;
  const recentDeclines = fighter.declinedOffers;

  // A genuine reason costs almost nothing.
  if (injured) {
    fighter.declinedOffers = Math.max(0, fighter.declinedOffers - 1);
    return {
      message: 'The matchmaker accepts the medical situation. No damage done.',
      delta: 0,
      replacement: null,
    };
  }
  if (veryShortNotice && reason === 'short-notice') {
    return {
      message: 'Turning down a bout on that little notice is understood. It is noted and nothing more.',
      delta: -1,
      replacement: null,
    };
  }
  if (reason === 'unreasonable' && (offer.travelKm > 12000 || offer.noticeDays < 21)) {
    return {
      message: 'The objection is taken on board. The matchmaker will come back with something more workable.',
      delta: -2,
      replacement: null,
    };
  }

  // Repeated refusals escalate.
  let delta: number;
  let message: string;
  if (recentDeclines <= 1) {
    delta = -5;
    message = 'The offer is turned down. The matchmaker moves on without much comment.';
  } else if (recentDeclines === 2) {
    delta = -10;
    message = 'A second refusal. The next offer is likely to be worse, and it may take longer to arrive.';
  } else if (recentDeclines === 3) {
    delta = -16;
    message = 'Three refusals. The matchmaker is openly unimpressed and the contract obligation is now a live issue.';
  } else {
    delta = -22;
    message = obligated
      ? 'Another refusal with fights still owed on the contract. Release is now a real possibility.'
      : 'Another refusal. There is very little goodwill left.';
  }

  fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker + delta, 0, 100);

  // Public criticism inside the fictional news system.
  if (recentDeclines >= 2) {
    save.history.news.unshift({
      id: `news-${++save.counters.news}`,
      date: save.date,
      headline: `${fighter.name} turns down another bout`,
      body: `${fighter.name} has declined the offer against ${save.fighters[offer.opponentId]?.name ?? 'the proposed opponent'}. It is the ${recentDeclines} refusal on record.`,
      tags: ['news'],
      fighterIds: [fighter.id],
      importance: 2,
    });
  }

  // Release risk.
  if (recentDeclines >= 4 && obligated && rng.chance(0.35)) {
    if (contract) contract.status = 'released';
    fighter.activityStatus = 'released';
    message += ' The promotion has terminated the agreement.';
  }

  return { message, delta, replacement: null };
}

export function expireOffers(save: SaveGame): void {
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    if (offer.deadline < save.date || offer.date <= save.date) {
      offer.status = 'expired';
      resolveMessagesForOffer(save, offer.id, 'The offer expired without an answer.');
      const f = save.fighters[offer.fighterId];
      if (f) {
        f.relationships.matchmaker = clamp(f.relationships.matchmaker - 4, 0, 100);
        // A cooling off period, so an unanswered offer is not immediately replaced by
        // another one on the next weekly pass.
        f.offerCooldownUntil = addDays(save.date, OFFER_COOLDOWN_DAYS);
      }
    }
  }
  for (const offer of Object.values(save.contractOffers)) {
    if (offer.status === 'open' && offer.deadline < save.date) {
      offer.status = 'expired';
      resolveMessagesForOffer(save, offer.id, 'The contract offer expired without an answer.');
    }
  }
}

export function openOffersFor(save: SaveGame, fighterId: FighterId): FightOffer[] {
  return Object.values(save.fightOffers).filter((o) => o.fighterId === fighterId && o.status === 'open');
}

export function offerDeadlinePassed(offer: FightOffer, today: IsoDate): boolean {
  return offer.deadline < today;
}
