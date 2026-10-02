import { contractedWeight, DIVISION_BY_ID } from '../config/divisions';
import { clamp, Rng } from '../rng';
import { addDays, daysBetween, formatDate, formatMoney, type FighterId, type IsoDate, joinSentence } from '../types/common';
import { isChampionshipBout, type Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { FightCardEvent, FightOffer } from '../types/world';
import type { SaveGame } from '../types/save';
import { purseForBout } from './economy';
import { managerFor } from './finance';
import { addInboxMessage, resolveMessagesForOffer } from './inbox';
import { CHAMPION_TURNAROUND_DAYS, regionOfFighter } from './matchmaking';
import { travelDistanceKm, VENUE_CITIES } from './venues';
import { activeInjuries, canCompete } from './health';
import { checkPlayerInjuries } from './injury-flow';
import { currentContender, fulfilContenderStatus, grantContenderStatus } from './contender';
import { PROMOTION_ABBREVIATION, PROMOTION_MATCHMAKING } from '../config/branding';
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
  /** The structured matchmaking category, carried onto the offer for the interface. */
  bookingKind?: string;
  /** The persistent matchmaking interest that produced this offer, when there was one. */
  matchupInterestId?: string | null;
  /** Who the inbox says the offer is from. Regional promotions have their own matchmakers. */
  senderName?: string;
  /** An amateur bout on the regional circuit. */
  isAmateur?: boolean;
  /** A regional championship, settled by the regional circuit rather than the main promotion. */
  regionalTitle?: boolean;
}

export function rankingImplication(save: SaveGame, fighter: Fighter, opponent: Fighter, opts: CreateOfferOptions): string {
  if (opts.isAmateur) return 'An amateur bout. It builds the amateur record and pays nothing.';
  if (opts.regionalTitle) return 'A regional championship on the line, the biggest thing a scout can see.';
  // A tryout is checked before the circuit, because the player is still on the circuit when it is
  // offered, and the regional rankings line told them the stakes were points when they are a contract.
  if (opts.bookingKind === 'tryout') return `A tryout. Win well and a ${PROMOTION_ABBREVIATION} contract follows. Lose and it is back to the circuit.`;
  if (fighter.circuit) return 'A win climbs the regional rankings and moves the call up closer.';
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
  // Nobody fights themselves. Every offer generator funnels through here, so this is the one
  // guard that holds whatever a caller gets wrong. A matchup interest where the player was the
  // target, not the caller, was booked as the player against the interest's target, which is the
  // player, and the offer that reached the inbox named the player as their own opponent.
  if (fighter.id === opponent.id) return null;
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
  // An offer is always at the fighter's current division. A fighter who has moved weight
  // must never be approached about a fight at the weight they left, which is what made a
  // division change feel like it had not taken effect.
  if (opponent.divisionId !== fighter.divisionId && !opts.isReplacementSlot) return null;

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
    baseShowPay: purse.show,
    shortNoticeBonus: noticeDays < 24 ? (contract?.terms.shortNoticeBonus ?? 0) : 0,
    rankingImplication: rankingImplication(save, fighter, opponent, opts),
    travelKm: travelDistanceKm(regionOfFighter(fighter), venue?.region ?? 'north-america'),
    reason: opts.reason,
    createdOn: save.date,
    deadline: addDays(save.date, Math.min(10, Math.max(2, Math.floor(noticeDays / 3)))),
    isReplacementSlot: opts.isReplacementSlot,
    bookingKind: opts.bookingKind,
    matchupInterestId: opts.matchupInterestId ?? null,
    isAmateur: opts.isAmateur || undefined,
    regionalTitle: opts.regionalTitle || undefined,
    idempotencyKey: key,
    medicallyContingent: contingent,
    status: 'open',
    requestsUsed: 0,
  };
  save.fightOffers[offer.id] = offer;

  const health = canCompete(fighter, save.date);
  // A championship offer answers the questions a player actually has before accepting: who
  // holds the belt, why they were picked, and what happens if they say no.
  const championship = isChampionshipBout(opts) ? championshipContext(save, fighter, opts) : '';
  addInboxMessage(save, {
    sender: 'matchmaker',
    senderName: opts.senderName ?? PROMOTION_MATCHMAKING,
    subject: `${contingent ? 'Medically contingent offer' : opts.bookingKind === 'tryout' ? 'Proving Ground tryout' : opts.isTitleFight ? 'Title fight offer' : opts.isInterimTitleFight ? 'Interim title fight offer' : opts.regionalTitle ? 'Regional title fight offer' : opts.isAmateur ? 'Amateur bout offer' : opts.isMainEvent ? 'Main event offer' : 'Fight offer'}: ${opponent.name}`,
    body: `${event.name} in ${event.city}, ${event.country} on ${formatDate(event.date)}. ${opts.scheduledRounds} rounds at ${offer.contractedWeightLb} lb. ${noticeDays} days notice, about ${offer.campWeeksAvailable} weeks of camp. Reason for the offer: ${joinSentence(opts.reason, '')} ${offer.rankingImplication}${championship}${health.ok ? '' : ` Note: currently unavailable (${health.reason}).`}${contingent ? ' This offer is contingent on medical clearance in time for the event. It is withdrawn automatically if you are not cleared.' : ''}`,
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

/**
 * The extra paragraph a championship offer carries.
 *
 * Declining a title shot is a legitimate choice, so the consequences are stated up front
 * rather than discovered afterwards.
 */
function championshipContext(save: SaveGame, fighter: Fighter, opts: CreateOfferOptions): string {
  const table = save.rankings[fighter.divisionId];
  const division = DIVISION_BY_ID[fighter.divisionId];
  const championId = opts.isInterimTitleFight ? table.interimChampionId : table.championId;
  const champion = championId ? save.fighters[championId] : null;
  const belt = opts.isInterimTitleFight ? `interim ${division.name} championship` : `${division.name} championship`;
  const holder = champion
    ? champion.id === fighter.id
      ? ` You are defending the ${belt}.`
      : ` ${champion.name} holds the ${belt}.`
    : ` The ${belt} is vacant.`;
  const declineNote =
    ' If you decline, the opportunity goes to the next eligible contender and you keep your ranking, but the matchmaker will remember it. Declining once does not close the door on a future title shot.';
  return `${holder}${declineNote}`;
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

/**
 * How a reply reads to the player. Carried on the outcome so the interface colours a refusal as a
 * refusal: it used to show every reply, a pulled offer included, in the green success style.
 */
export type OfferTone = 'good' | 'info' | 'bad';

export interface OfferOutcome {
  accepted: boolean;
  boutId: string | null;
  message: string;
  /** The change to the matchmaker relationship this reply actually applied. */
  relationshipDelta: number;
  newOffer: FightOffer | null;
  tone: OfferTone;
}

/** How long a volunteer stays on the short notice list. */
export const SHORT_NOTICE_LIST_DAYS = 120;

/** True while the fighter is on the short notice list. */
export function onShortNoticeList(fighter: Fighter, today: IsoDate): boolean {
  return Boolean(fighter.volunteeredShortNoticeUntil && fighter.volunteeredShortNoticeUntil >= today);
}

/**
 * Applies the player's response. Consequences scale with context: an injured fighter
 * declining a two week notice bout is treated very differently from a healthy contender
 * turning down a third straight offer.
 */
export function respondToOffer(save: SaveGame, offerId: string, response: OfferResponse, rng: Rng): OfferOutcome {
  const offer = save.fightOffers[offerId];
  if (!offer || offer.status !== 'open') {
    return { accepted: false, boutId: null, message: 'That offer is no longer on the table.', relationshipDelta: 0, newOffer: null, tone: 'bad' };
  }
  const fighter = save.fighters[offer.fighterId];
  const opponent = save.fighters[offer.opponentId];
  const event = save.events[offer.eventId];
  if (!fighter || !opponent || !event) {
    offer.status = 'withdrawn';
    resolveMessagesForOffer(save, offer.id, 'The bout is no longer available.');
    return { accepted: false, boutId: null, message: 'The bout is no longer available.', relationshipDelta: 0, newOffer: null, tone: 'bad' };
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
        tone: 'bad',
      };
    }
    offer.status = 'accepted';
    resolveMessagesForOffer(save, offer.id, `Accepted the bout against ${opponent.name}.`);
    fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker + (offer.noticeDays < 24 ? 8 : 3), 0, 100);
    if (offer.noticeDays < 24) fighter.acceptedShortNotice++;
    // An injury the player is carrying is judged against this booking now, not next Monday, so a
    // fight it cannot clear in time is a decision before the career status is next read.
    if (fighter.id === save.player.fighterId) checkPlayerInjuries(save);
    return {
      accepted: true,
      boutId: bout.id,
      message: `Bout agreed. ${fighter.name} faces ${opponent.name} at ${event.name} on ${formatDate(event.date)}.`,
      relationshipDelta: offer.noticeDays < 24 ? 8 : 3,
      newOffer: null,
      tone: 'good',
    };
  }

  if (response.kind === 'decline') {
    offer.status = 'declined';
    fighter.offerCooldownUntil = addDays(save.date, OFFER_COOLDOWN_DAYS);
    const outcome = declineConsequence(save, fighter, offer, response.reason, rng);
    resolveMessagesForOffer(save, offer.id, `Declined the bout against ${opponent.name}. ${outcome.message}`);
    return { accepted: false, boutId: null, message: outcome.message, relationshipDelta: outcome.delta, newOffer: outcome.replacement, tone: outcome.tone };
  }

  // Volunteering is not a request about this bout, so it costs no request slot. It used to take
  // one, which made a later legitimate request the one that pulled the offer. It is good for the
  // relationship once per spell on the list, not once per click, or it was free goodwill to farm.
  if (response.kind === 'volunteer-replacement') {
    if (onShortNoticeList(fighter, save.date)) {
      return { accepted: false, boutId: null, message: 'Already on the short notice list.', relationshipDelta: 0, newOffer: offer, tone: 'info' };
    }
    fighter.volunteeredShortNoticeUntil = addDays(save.date, SHORT_NOTICE_LIST_DAYS);
    const before = fighter.relationships.matchmaker;
    fighter.relationships.matchmaker = clamp(before + 4, 0, 100);
    return {
      accepted: false,
      boutId: null,
      message: `Noted. ${fighter.name} is on the short notice list until ${formatDate(fighter.volunteeredShortNoticeUntil)}, and the matchmaker will call first if a slot opens.`,
      relationshipDelta: fighter.relationships.matchmaker - before,
      newOffer: offer,
      tone: 'good',
    };
  }

  // A second money request after one was granted is answered without costing a slot. The purse is
  // settled, and the button says so, so this only catches an older page or a stale click.
  if (response.kind === 'request-money' && offer.moneyGranted) {
    return {
      accepted: false,
      boutId: null,
      message: `The purse was already raised once for this bout. It stays at ${formatMoney(offer.showPay)}.`,
      relationshipDelta: 0,
      newOffer: offer,
      tone: 'info',
    };
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
      tone: 'bad',
    };
  }

  // Every request branch reports the relationship change it costs, and it is applied here, once.
  // Most branches used to return a change that nothing applied, while two applied their own, so
  // the number on the outcome and the relationship disagreed.
  const outcome = resolveRequest(save, offer, fighter, event, response, rng);
  const before = fighter.relationships.matchmaker;
  fighter.relationships.matchmaker = clamp(before + outcome.relationshipDelta, 0, 100);
  return { ...outcome, relationshipDelta: fighter.relationships.matchmaker - before };
}

type RequestResponse = Exclude<OfferResponse, { kind: 'accept' } | { kind: 'decline' } | { kind: 'volunteer-replacement' }>;

/**
 * Re-prices an offer whose date moved.
 *
 * The short notice bonus was baked into the show pay when the offer was made, and a moved date
 * kept it, so asking for more time on a replacement slot paid a short notice purse for a full
 * camp. The purse is rebuilt from the contract for the new notice, and any raise the player had
 * already negotiated is carried over on top. Amateur bouts pay nothing and are left alone.
 */
function repriceOffer(save: SaveGame, offer: FightOffer, fighter: Fighter, previousNoticeDays: number): void {
  if (offer.isAmateur) return;
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const priced = (notice: number) =>
    purseForBout(contract, fighter, save, {
      isMainEvent: offer.isMainEvent,
      isTitleFight: isChampionshipBout({ isTitleFight: offer.isTitleFight, isInterimTitleFight: offer.isInterimTitleFight }),
      shortNotice: notice < 24,
    });
  const oldBase = priced(previousNoticeDays);
  const raise = Math.max(0, offer.showPay - oldBase.show);
  const next = priced(offer.noticeDays);
  offer.showPay = next.show + raise;
  offer.winBonus = next.win;
  offer.baseShowPay = next.show;
  offer.shortNoticeBonus = offer.noticeDays < 24 ? (contract?.terms.shortNoticeBonus ?? 0) : 0;
}

/** Moves an offer onto a later card and re-prices it for the new notice. */
function moveOffer(save: SaveGame, offer: FightOffer, fighter: Fighter, later: FightCardEvent): string {
  const previousNotice = offer.noticeDays;
  const hadBonus = offer.shortNoticeBonus > 0;
  offer.eventId = later.id;
  offer.eventName = later.name;
  offer.date = later.date;
  // The location moves with the card. It used to keep the old city, so the offer named one
  // place and the fight happened in another.
  offer.city = later.city;
  offer.country = later.country;
  offer.travelKm = travelDistanceKm(regionOfFighter(fighter), VENUE_CITIES.find((v) => v.city === later.city)?.region ?? 'north-america');
  offer.noticeDays = daysBetween(save.date, later.date);
  offer.campWeeksAvailable = Math.max(0, Math.floor((offer.noticeDays - 7) / 7));
  repriceOffer(save, offer, fighter, previousNotice);
  return hadBonus && offer.shortNoticeBonus === 0
    ? ` It is no longer short notice, so the short notice bonus comes off and the show pay is now ${formatMoney(offer.showPay)}.`
    : '';
}

function resolveRequest(save: SaveGame, offer: FightOffer, fighter: Fighter, event: FightCardEvent, response: RequestResponse, rng: Rng): OfferOutcome {
  const leverage = clamp(
    (fighter.ranking !== null ? 16 - fighter.ranking : 2) * 3 + fighter.popularity * 0.4 + fighter.relationships.matchmaker * 0.3,
    0,
    100
  );
  const result = (message: string, relationshipDelta: number, tone: OfferTone, newOffer: FightOffer | null = offer): OfferOutcome => ({
    accepted: false,
    boutId: null,
    message,
    relationshipDelta,
    newOffer,
    tone,
  });
  const tryout = offer.bookingKind === 'tryout';

  switch (response.kind) {
    case 'request-money': {
      // The ceiling is set from the purse the offer opened at, and only one raise is granted per
      // offer. It used to be set from the current figure with two asks allowed, so the asks
      // compounded to nearly double the contracted show pay and made the contract talks pointless.
      // A manager's negotiating skill is worth more room on a purse request.
      const base = offer.baseShowPay ?? offer.showPay;
      const cap = base * (1 + clamp((leverage + (managerFor(save, fighter.id)?.negotiation ?? 0) * 0.15) / 400, 0.02, 0.2));
      // Asking for less than the offer already pays is not a negotiation. The test used to be
      // only against the ceiling, so any number at or below it was granted, including a smaller
      // one or a negative one, and the purse was cut while the reply said it had gone up.
      if (response.amount > offer.showPay && response.amount <= cap) {
        const granted = Math.round(Math.min(response.amount, cap));
        offer.showPay = granted;
        offer.moneyGranted = true;
        return result(`Purse increased to ${formatMoney(granted)}. The offer stands.`, -1, 'good');
      }
      if (response.amount <= offer.showPay) {
        return result('That is at or below what is already on the table, so the offer stands as it is.', 0, 'info');
      }
      return result('That number is not happening for this bout. The original offer stands.', -3, 'bad');
    }
    case 'request-date': {
      // Only a card from the same promotion. A regional offer could otherwise move onto a main
      // promotion card, and a main promotion offer onto a regional one.
      const later = Object.values(save.events)
        .filter((e) => e.status === 'announced' && e.promotionId === event.promotionId && daysBetween(offer.date, e.date) > 20 && daysBetween(offer.date, e.date) < 100)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (later && rng.chance(clamp(0.3 + leverage / 220, 0.15, 0.8))) {
        const repriced = moveOffer(save, offer, fighter, later);
        return result(`Moved to ${later.name} on ${formatDate(later.date)}.${repriced}`, -1, 'good');
      }
      return result('No suitable later date is available. The original offer stands.', -2, 'info');
    }
    case 'request-opponent': {
      if (rng.chance(clamp(leverage / 260, 0.05, 0.4))) {
        offer.status = 'withdrawn';
        resolveMessagesForOffer(save, offer.id, 'The matchmaker will look for a different opponent.');
        return result('The matchmaker will look at other options and come back with something else.', -4, 'info', null);
      }
      return result('This is the fight they want to make. The offer stands as is.', -5, 'bad');
    }
    case 'request-catchweight': {
      const division = DIVISION_BY_ID[offer.divisionId];
      const delta = Math.abs(response.weightLb - division.limitLb);
      if (delta <= 6 && !isChampionshipBout(offer) && !offer.isCatchweight && rng.chance(0.55)) {
        offer.contractedWeightLb = response.weightLb;
        offer.isCatchweight = true;
        return result(`Catchweight agreed at ${response.weightLb} lb.`, -1, 'good');
      }
      return result('The bout stays at the division weight.', -2, 'bad');
    }
    case 'request-five-rounds': {
      if (tryout) return result('Tryouts are three rounds. That is the format.', 0, 'bad');
      if (offer.isMainEvent || rng.chance(clamp(leverage / 300, 0.03, 0.3))) {
        offer.scheduledRounds = 5;
        return result('Approved as a five round bout.', 0, 'good');
      }
      return result('Five rounds are reserved for the main event on this card.', -1, 'bad');
    }
    case 'request-title-fight': {
      if (tryout) return result('A tryout is for a contract, not a belt. Win it and the rest follows.', 0, 'bad');
      if (event.promotionId) {
        return result('The regional belt goes to the number one contender. Climb the regional rankings and the title fight comes to you.', 0, 'bad');
      }
      const table = save.rankings[fighter.divisionId];
      const contenderReady = fighter.ranking !== null && fighter.ranking <= 3 && fighter.winStreak >= 2;
      // A request cannot jump somebody who has already earned the shot. The offer stays open, so
      // asking does not cost the player the fight they were offered.
      const standing = currentContender(save, fighter.divisionId);
      if (standing && standing.fighterId !== fighter.id) {
        const holder = save.fighters[standing.fighterId];
        return result(`${holder?.name ?? 'Another fighter'} already holds the number one contender spot, so the next title shot is theirs. This offer is still open.`, 0, 'info');
      }
      // The champion has to be in the division and close enough to the end of their turnaround
      // that the title pass, which looks up to 160 days ahead, can actually make the fight.
      // Otherwise the promise was one the simulation never kept, and the player had given up a
      // real offer for it.
      const champion = table.championId ? save.fighters[table.championId] : null;
      const championIdle = champion?.lastFightDate ? daysBetween(champion.lastFightDate, save.date) : 400;
      const championAvailable =
        champion !== null &&
        champion.divisionId === fighter.divisionId &&
        !champion.nextBoutId &&
        championIdle + 160 >= CHAMPION_TURNAROUND_DAYS;
      if (contenderReady && championAvailable && rng.chance(0.45)) {
        // The decision is recorded as a real contender claim, which is what the title pass books
        // from. Only once it is held is the current offer withdrawn.
        const grant = grantContenderStatus(save, fighter, fighter.divisionId, 'promotion-decision', null);
        if (!grant.granted) return result(`${grant.message} This offer is still open.`, 0, 'info');
        const earliest = addDays(champion!.lastFightDate ?? save.date, CHAMPION_TURNAROUND_DAYS);
        const from = earliest > addDays(save.date, 40) ? earliest : addDays(save.date, 40);
        offer.status = 'withdrawn';
        resolveMessagesForOffer(save, offer.id, 'The promotion named you the number one contender instead.');
        return result(
          `The case has been heard. You are named the number one contender, and this bout is off. Expect the title offer for a card from about ${formatDate(from)} onward, once ${champion!.name} is ready to defend.`,
          2,
          'good',
          null
        );
      }
      return result(
        contenderReady
          ? 'The title picture is not open right now. Win this one and the case makes itself.'
          : 'Not yet. There is more work to do before that conversation happens.',
        -2,
        'bad'
      );
    }
    case 'request-more-time': {
      const later = Object.values(save.events)
        .filter((e) => e.status === 'announced' && e.promotionId === event.promotionId && daysBetween(offer.date, e.date) >= response.weeks * 7 - 10)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (later && rng.chance(0.5)) {
        const repriced = moveOffer(save, offer, fighter, later);
        return result(`Extra preparation time granted. Now on ${formatDate(later.date)}.${repriced}`, -1, 'good');
      }
      return result('The card is set. There is no more time available.', -2, 'bad');
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
    // Only when five rounds were actually negotiated. A championship bout and a main event get
    // five rounds from the card ordering pass anyway, and marking those as agreed made the bout
    // keep five rounds after losing the main event slot to a bigger fight, which is not what the
    // player agreed to and not how the card works.
    roundsAgreed: offer.scheduledRounds === 5 && !offer.isMainEvent && !isChampionshipBout(offer),
    isTitleFight: offer.isTitleFight,
    isInterimTitleFight: offer.isInterimTitleFight,
    titleIneligibleFighterIds: [],
    isMainEvent: offer.isMainEvent,
    isCoMain: false,
    // Provisional. The card ordering pass assigns the real segment and order once every bout on
    // the event is known. Both branches of the ternary that used to sit here were identical.
    cardSegment: 'main',
    boutOrder: offer.isMainEvent ? 12 : 8,
    isCatchweight: offer.isCatchweight,
    status: 'scheduled',
    resultId: null,
    bookedOn: save.date,
    replacementHistory: [],
    cancelReason: null,
    purseA: { show: offer.showPay, win: offer.winBonus },
    purseB: event.promotionId ? { show: offer.isAmateur ? 0 : offer.showPay, win: offer.isAmateur ? 0 : offer.winBonus } : purseForBout(contractB, opponent, save, {
      isMainEvent: offer.isMainEvent,
      isTitleFight: isChampionshipBout(offer),
      shortNotice,
    }),
    weighInA: null,
    weighInB: null,
    bookingReason: offer.reason,
    // The category has to survive acceptance. Without it a player who accepted an eliminator
    // would win it and be credited with nothing.
    bookingKind: offer.bookingKind,
    isAmateur: offer.isAmateur,
    regionalTitle: offer.regionalTitle,
    // Kept on the bout so the condition can be enforced when fight week begins.
    medicallyContingent: offer.medicallyContingent || undefined,
  };
  void contractA;

  // One transaction takes ownership of both fighters. Accepting also closes every other
  // offer either fighter is holding, so an accepted bout cannot leave a competing offer
  // live in the inbox.
  // The opponent is checked again at the moment of acceptance. An offer can sit open for days,
  // and nothing revalidated the other side, so a player could accept a bout against somebody who
  // had since been injured, suspended, released or booked elsewhere.
  // The offer being accepted must not count against its own opponent, so the open offer set is
  // built with this one excluded.
  const otherOfferHolders = new Set<FighterId>();
  for (const other of Object.values(save.fightOffers)) {
    if (other.id === offer.id || other.status !== 'open') continue;
    otherOfferHolders.add(other.fighterId);
    otherOfferHolders.add(other.opponentId);
  }
  const opponentBlocked = offerBlockReason(save, opponent, {
    eventDate: event.date,
    isReplacementSlot: offer.isReplacementSlot,
    openOfferFighterIds: otherOfferHolders,
  });
  if (opponentBlocked) return null;

  const booking = bookBout(save, bout);
  if (!booking.created) return null;
  // A championship offer consumes the contender claim only once it is actually accepted. Consuming
  // it when the offer was made would lose the position for a player who declined.
  if (isChampionshipBout(bout)) fulfilContenderStatus(save, bout.divisionId, fighter.id, bout.id);
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
  tone: OfferTone;
}

function declineConsequence(
  save: SaveGame,
  fighter: Fighter,
  offer: FightOffer,
  reason: string,
  rng: Rng
): DeclineOutcome {
  const health = canCompete(fighter, save.date);
  // The medical reason is checked against the medical record. The reason the player picked used
  // to count as proof, so a healthy fighter could turn down every offer for free. A fighter who
  // cannot compete at all (an injury that blocks, a suspension) declines for free whatever the
  // stated reason; a minor injury that does not block counts only when it is the reason given.
  const hurt = activeInjuries(fighter, save.date).length > 0;
  const injured = !health.ok || (reason === 'injury' && hurt);
  const falseClaim = reason === 'injury' && !injured;
  const veryShortNotice = offer.noticeDays < 18;
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const obligated = contract ? contract.fightsRemaining > 0 : false;

  fighter.declinedOffers++;
  fighter.lastDeclineOn = save.date;
  // Refusals fade. The counter was a lifetime total treated as a recent one, so a fifteen year
  // career carried penalties for offers turned down a decade earlier.
  const recentDeclines = fighter.declinedOffers;

  // A genuine reason costs almost nothing.
  if (injured) {
    fighter.declinedOffers = Math.max(0, fighter.declinedOffers - 1);
    return {
      message: 'The matchmaker accepts the medical situation. No damage done.',
      delta: 0,
      replacement: null,
      tone: 'info',
    };
  }
  // The soft reasons still cost the small amount they report. The figure was returned and never
  // applied, so the outcome and the relationship disagreed.
  if (veryShortNotice && reason === 'short-notice') {
    fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 1, 0, 100);
    return {
      message: 'Turning down a bout on that little notice is understood. It is noted and nothing more.',
      delta: -1,
      replacement: null,
      tone: 'info',
    };
  }
  if (reason === 'unreasonable' && (offer.travelKm > 12000 || offer.noticeDays < 21)) {
    fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 2, 0, 100);
    return {
      message: 'The objection is taken on board. The matchmaker will come back with something more workable.',
      delta: -2,
      replacement: null,
      tone: 'info',
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
  if (falseClaim) message += ' The medical team has no record of an injury.';

  fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker + delta, 0, 100);

  // Public criticism inside the fictional news system.
  if (recentDeclines >= 2) {
    save.history.news.unshift({
      id: `news-${++save.counters.news}`,
      date: save.date,
      headline: `${fighter.name} turns down another bout`,
      body: `${fighter.name} has declined the offer against ${save.fighters[offer.opponentId]?.name ?? 'the proposed opponent'}. That makes ${recentDeclines} refusals on record.`,
      tags: ['news'],
      fighterIds: [fighter.id],
      importance: 2,
    });
  }

  // Release risk.
  if (recentDeclines >= 4 && obligated && rng.chance(0.35)) {
    if (contract) {
      contract.status = 'released';
      contract.endCondition = 'released';
      contract.endDate = save.date;
    }
    fighter.activityStatus = 'released';
    message += ' The promotion has terminated the agreement.';
  }

  return { message, delta, replacement: null, tone: 'bad' };
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
