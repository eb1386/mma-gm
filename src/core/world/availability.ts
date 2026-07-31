import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { addDays, daysBetween, type BoutId, type EventId, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, type Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { activeInjuries, canCompete } from './health';

/**
 * The single authority on whether a fighter may be offered or booked a fight, and the
 * single place a booking is created, moved or torn down.
 *
 * Before this existed, availability was decided independently by the matchmaker, the title
 * pass, the replacement finder and the player offer path. Each knew about some of the
 * reasons a fighter is spoken for and none knew about all of them, so an injured fighter
 * could still be offered a bout and a booked fighter could be reached from a path that did
 * not check the booking. Everything now goes through `offerBlockReason` and `bookBout`.
 */

/** Every reason a fighter cannot take an ordinary new fight, in the order they are tested. */
export type BlockReason =
  | 'retired'
  | 'deceased'
  | 'released'
  | 'not-active'
  | 'inactive-no-return-date'
  | 'booked'
  | 'accepted-awaiting-bout'
  | 'in-camp'
  | 'fight-week'
  | 'awaiting-bout-resolution'
  | 'blocking-injury'
  | 'medical-suspension'
  | 'commission-suspension'
  | 'anti-doping-suspension'
  | 'open-offer'
  | 'negotiating'
  | 'recently-declined-this-matchup'
  | 'offer-cooldown'
  | 'duplicate-offer'
  | 'no-contract'
  | 'contract-exhausted'
  | 'turnaround-too-short'
  | 'camp-too-short';

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  retired: 'Retired.',
  deceased: 'No longer living.',
  released: 'Not under contract to the promotion.',
  'not-active': 'Not on the active roster.',
  'inactive-no-return-date': 'Inactive with no return date given.',
  booked: 'Already booked for a fight.',
  'accepted-awaiting-bout': 'Has already accepted a fight.',
  'in-camp': 'In an active fight camp.',
  'fight-week': 'In fight week.',
  'awaiting-bout-resolution': 'Waiting on the status of a booked fight.',
  'blocking-injury': 'Carrying an injury that prevents competition.',
  'medical-suspension': 'Under medical suspension.',
  'commission-suspension': 'Under commission suspension.',
  'anti-doping-suspension': 'Under an anti-doping suspension.',
  'open-offer': 'Already has an offer on the table.',
  negotiating: 'Already negotiating an offer.',
  'recently-declined-this-matchup': 'Recently turned down this matchup.',
  'offer-cooldown': 'Too soon after the last offer was closed.',
  'duplicate-offer': 'This exact offer already exists.',
  'no-contract': 'Not under an active contract.',
  'contract-exhausted': 'No fights left on the contract.',
  'turnaround-too-short': 'Too soon after the last fight.',
  'camp-too-short': 'Not enough notice to prepare.',
};

/** Days after an offer is declined or expires before that fighter is approached again. */
export const OFFER_COOLDOWN_DAYS = 21;
/** Days a specific matchup stays off the table after it is turned down. */
export const MATCHUP_COOLDOWN_DAYS = 120;
/** Fight week begins this many days before the event. */
export const FIGHT_WEEK_DAYS = 6;
/** Buffer beyond an expected return date before a medically contingent offer is allowed. */
export const MEDICAL_CONTINGENT_BUFFER_DAYS = 28;

export interface AvailabilityOptions {
  /** The date of the event being filled. Health and turnaround are judged against it. */
  eventDate: IsoDate;
  /** Fighters already taken by the pass in progress. */
  takenFighterIds?: ReadonlySet<FighterId>;
  /** Precomputed set of fighters with an open offer, so a pass is not quadratic. */
  openOfferFighterIds?: ReadonlySet<FighterId>;
  /** Precomputed set of fighters in an active camp, for the same reason. */
  inCampFighterIds?: ReadonlySet<FighterId>;
  /** A replacement slot relaxes turnaround and camp length, not health or booking. */
  isReplacementSlot?: boolean;
  /** Allows an offer for an event beyond the expected return of a blocking injury. */
  allowMedicallyContingent?: boolean;
  /**
   * This is a championship booking.
   *
   * A title shot outranks a routine fight, so an ordinary open offer and a recent offer
   * cooldown no longer disqualify the fighter. Without this, being offered a preliminary bout
   * on Monday silently cost a top contender the title shot that was decided on Tuesday, and
   * the belt went elsewhere for another six months. Health, an existing booking and an open
   * championship offer still block.
   */
  isChampionshipBooking?: boolean;
}

/** True when a bout id still refers to a bout this fighter is actually scheduled for. */
export function hasLiveBooking(save: SaveGame, fighter: Fighter): Bout | null {
  if (!fighter.nextBoutId) return null;
  const bout = save.bouts[fighter.nextBoutId];
  if (!bout) return null;
  if (bout.status !== 'scheduled') return null;
  if (bout.fighterAId !== fighter.id && bout.fighterBId !== fighter.id) return null;
  return bout;
}

/** The fighter's active camp, if any. A fighter may only ever have one. */
export function activeCampFor(save: SaveGame, fighterId: FighterId): { id: string; boutId: BoutId | null } | null {
  for (const camp of Object.values(save.camps)) {
    if (camp.fighterId !== fighterId) continue;
    if (camp.status === 'planned' || camp.status === 'running') return { id: camp.id, boutId: camp.boutId };
  }
  return null;
}

/** Open offers naming this fighter on either side. */
export function openOffersFor(save: SaveGame, fighterId: FighterId): string[] {
  const out: string[] = [];
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    if (offer.fighterId === fighterId || offer.opponentId === fighterId) out.push(offer.id);
  }
  return out;
}

/**
 * The reason this fighter cannot be offered an ordinary new fight, or null when they can.
 *
 * Order matters only for the message the caller shows. Every condition is checked.
 */
export function offerBlockReason(save: SaveGame, fighter: Fighter, opts: AvailabilityOptions): BlockReason | null {
  const { eventDate } = opts;

  if (fighter.retired) return 'retired';
  switch (fighter.activityStatus) {
    case 'deceased':
      return 'deceased';
    case 'released':
      return 'released';
    case 'retired':
      return 'retired';
    case 'active':
      break;
    case 'inactive':
      if (!fighter.expectedReturnDate) return 'inactive-no-return-date';
      break;
    default:
      return 'not-active';
  }

  if (opts.takenFighterIds?.has(fighter.id)) return 'booked';
  const live = hasLiveBooking(save, fighter);
  if (live) {
    if (daysBetween(save.date, live.date) <= FIGHT_WEEK_DAYS) return 'fight-week';
    return 'booked';
  }
  // A booking pointer that no longer resolves means the fighter is waiting on a decision
  // about a bout that was pulled. They are not free until that is settled.
  if (fighter.nextBoutId && !save.bouts[fighter.nextBoutId]) return 'awaiting-bout-resolution';

  // Scanning every camp per candidate is quadratic in a long save, so a booking pass
  // passes the set in once.
  if (opts.inCampFighterIds) {
    if (opts.inCampFighterIds.has(fighter.id)) return 'in-camp';
  } else if (activeCampFor(save, fighter.id)) {
    return 'in-camp';
  }

  // Health is judged twice. A fighter must be clear on the day of the event, and a fighter
  // who is hurt today is only approached at all under the contingent rules below. Checking
  // the event date alone was how an injured fighter still received ordinary offers: a card
  // four months out fell past the expected return, so the offer looked perfectly healthy.
  const healthAtEvent = canCompete(fighter, eventDate);
  if (!healthAtEvent.ok) {
    if (fighter.medicalSuspension && fighter.medicalSuspension.until > eventDate) return 'medical-suspension';
    return 'blocking-injury';
  }

  const healthNow = canCompete(fighter, save.date);
  if (!healthNow.ok) {
    if (fighter.medicalSuspension && fighter.medicalSuspension.until > save.date) return 'medical-suspension';
    if (!opts.allowMedicallyContingent) return 'blocking-injury';
    // A contingent offer is only sensible when the event is comfortably past the expected
    // return, and only one may be open at a time.
    const blocking = activeInjuries(fighter, save.date).filter((i) => i.blocksCompetition);
    const latestReturn = blocking
      .map((i) => i.expectedReturn)
      .sort()
      .pop();
    if (!latestReturn) return 'blocking-injury';
    if (eventDate < addDays(latestReturn, MEDICAL_CONTINGENT_BUFFER_DAYS)) return 'blocking-injury';
    for (const other of Object.values(save.fightOffers)) {
      if (other.status !== 'open') continue;
      if (other.fighterId !== fighter.id) continue;
      if (other.medicallyContingent) return 'open-offer';
    }
  }
  if (fighter.commissionSuspension && fighter.commissionSuspension.until > eventDate) return 'commission-suspension';
  if (fighter.antiDopingSuspension && fighter.antiDopingSuspension.until > eventDate) return 'anti-doping-suspension';

  if (opts.isChampionshipBooking) {
    // Only another championship offer stands in the way of this one.
    const competingTitleOffer = Object.values(save.fightOffers).some(
      (o) => o.status === 'open' && (o.fighterId === fighter.id || o.opponentId === fighter.id) && (o.isTitleFight || o.isInterimTitleFight)
    );
    if (competingTitleOffer) return 'open-offer';
  } else {
    const offers = opts.openOfferFighterIds
      ? opts.openOfferFighterIds.has(fighter.id)
        ? ['x']
        : []
      : openOffersFor(save, fighter.id);
    if (offers.length > 0) return 'open-offer';

    if (fighter.offerCooldownUntil && fighter.offerCooldownUntil > save.date) return 'offer-cooldown';
  }

  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  if (!contract || contract.status !== 'active') return 'no-contract';
  if (contract.fightsRemaining <= 0) return 'contract-exhausted';

  if (!opts.isReplacementSlot) {
    if (fighter.lastFightDate && daysBetween(fighter.lastFightDate, eventDate) < 35) return 'turnaround-too-short';
    if (daysBetween(save.date, eventDate) < 21) return 'camp-too-short';
  }

  return null;
}

export function canOffer(save: SaveGame, fighter: Fighter, opts: AvailabilityOptions): boolean {
  return offerBlockReason(save, fighter, opts) === null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface OfferIdentity {
  fighterId: FighterId;
  opponentId: FighterId;
  eventId: EventId;
  /** Which slot on the card this offer is for. Main event and prelim are distinct offers. */
  slot: string;
  offerType: 'ordinary' | 'title' | 'interim-title' | 'replacement' | 'medically-contingent';
  isReplacementSlot: boolean;
}

/**
 * A stable key for an offer. Regenerating the same offer must return the existing one
 * rather than adding a second copy to the inbox.
 */
export function offerKey(id: OfferIdentity): string {
  return [id.fighterId, id.opponentId, id.eventId, id.slot, id.offerType, id.isReplacementSlot ? 'r' : 'n'].join('|');
}

/** An existing open offer with this identity, if one is already on the table. */
export function findExistingOffer(save: SaveGame, key: string): string | null {
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    if (offer.idempotencyKey === key) return offer.id;
  }
  return null;
}

/** True when this fighter turned down this opponent recently enough for it to still sting. */
export function recentlyDeclined(save: SaveGame, fighterId: FighterId, opponentId: FighterId, eventId: EventId): boolean {
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.fighterId !== fighterId) continue;
    if (offer.status !== 'declined' && offer.status !== 'expired') continue;
    if (offer.opponentId !== opponentId) continue;
    if (offer.eventId === eventId) return true;
    if (daysBetween(offer.createdOn, save.date) < MATCHUP_COOLDOWN_DAYS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Booking transactions
// ---------------------------------------------------------------------------

export interface BookingResult {
  bout: Bout | null;
  created: boolean;
  reason: string | null;
}

/**
 * Creates a bout and takes ownership of both fighters, or refuses.
 *
 * This is the only place `nextBoutId` is set. Callers that used to assign it themselves
 * could leave one side pointing at a bout the other side had already left.
 */
export function bookBout(save: SaveGame, bout: Bout): BookingResult {
  const a = save.fighters[bout.fighterAId];
  const b = save.fighters[bout.fighterBId];
  if (!a || !b) return { bout: null, created: false, reason: 'One of the fighters no longer exists.' };
  if (a.id === b.id) return { bout: null, created: false, reason: 'A fighter cannot face themselves.' };
  const liveA = hasLiveBooking(save, a);
  const liveB = hasLiveBooking(save, b);
  if (liveA && liveA.id !== bout.id) return { bout: null, created: false, reason: `${a.name} is already booked.` };
  if (liveB && liveB.id !== bout.id) return { bout: null, created: false, reason: `${b.name} is already booked.` };

  save.bouts[bout.id] = bout;
  bout.status = 'scheduled';
  a.nextBoutId = bout.id;
  b.nextBoutId = bout.id;

  const event = save.events[bout.eventId];
  if (event) {
    if (!event.boutIds.includes(bout.id)) event.boutIds.push(bout.id);
    if (!event.announcedBoutIds) event.announcedBoutIds = [];
    if (!event.announcedBoutIds.includes(bout.id)) event.announcedBoutIds.push(bout.id);
  }
  return { bout, created: true, reason: null };
}

/** Clears a booking pointer only when it still refers to the bout being released. */
export function releaseBooking(save: SaveGame, fighterId: FighterId, boutId: BoutId): void {
  const f = save.fighters[fighterId];
  if (!f) return;
  if (f.nextBoutId === boutId) f.nextBoutId = null;

  // A camp exists for a specific bout. Releasing the booking without closing it left a camp
  // running forever against a fight that was no longer happening, which the load time repair then
  // silently abandoned, so loading a save changed it. Closing it here means no caller can leak one.
  for (const camp of Object.values(save.camps)) {
    if (camp.fighterId !== fighterId || camp.boutId !== boutId) continue;
    if (camp.status !== 'planned' && camp.status !== 'running') continue;
    camp.status = 'abandoned';
    camp.outcomes.push({
      week: camp.weeksCompleted,
      key: 'camp-closed',
      headline: 'Camp closed',
      detail: 'The bout this camp was built for is no longer on the books.',
      severity: 'bad',
    });
  }
}

/**
 * Moves a booked bout to a new date, keeping both fighters and the booking intact.
 * Used when a bout is postponed rather than canceled.
 */
export function postponeBout(save: SaveGame, bout: Bout, toEventId: EventId, reason: string): BookingResult {
  const target = save.events[toEventId];
  if (!target) return { bout: null, created: false, reason: 'That card does not exist.' };
  const from = save.events[bout.eventId];
  if (from) {
    from.boutIds = from.boutIds.filter((id) => id !== bout.id);
    from.announcedBoutIds = (from.announcedBoutIds ?? []).filter((id) => id !== bout.id);
  }
  bout.eventId = toEventId;
  bout.date = target.date;
  bout.bookingReason = `${bout.bookingReason}. ${reason}`;
  if (!target.boutIds.includes(bout.id)) target.boutIds.push(bout.id);
  if (!target.announcedBoutIds) target.announcedBoutIds = [];
  if (!target.announcedBoutIds.includes(bout.id)) target.announcedBoutIds.push(bout.id);
  // Both fighters stay booked. Their pointers already refer to this bout.
  const a = save.fighters[bout.fighterAId];
  const b = save.fighters[bout.fighterBId];
  if (a) a.nextBoutId = bout.id;
  if (b) b.nextBoutId = bout.id;
  return { bout, created: false, reason: null };
}

/** Swaps one side of an existing bout rather than creating a second booking. */
export function replaceSide(save: SaveGame, bout: Bout, outgoingId: FighterId, incoming: Fighter, reason: string): BookingResult {
  const isA = bout.fighterAId === outgoingId;
  if (!isA && bout.fighterBId !== outgoingId) return { bout: null, created: false, reason: 'That fighter is not in this bout.' };
  const live = hasLiveBooking(save, incoming);
  if (live && live.id !== bout.id) return { bout: null, created: false, reason: `${incoming.name} is already booked.` };

  releaseBooking(save, outgoingId, bout.id);
  if (isA) bout.fighterAId = incoming.id;
  else bout.fighterBId = incoming.id;
  incoming.nextBoutId = bout.id;
  bout.replacementHistory.push({ replacedFighterId: outgoingId, newFighterId: incoming.id, on: save.date, reason });
  return { bout, created: false, reason: null };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

export interface Invariant {
  code: string;
  message: string;
  fighterId?: FighterId;
  boutId?: BoutId;
}

/**
 * Checks the structural invariants the booking system is supposed to guarantee.
 *
 * This is deliberately cheap enough to run inside tests on every advance. It returns
 * findings rather than throwing so a caller can decide whether a violation is fatal.
 */
export function checkBookingInvariants(save: SaveGame): Invariant[] {
  const out: Invariant[] = [];

  const scheduledByFighter = new Map<FighterId, BoutId[]>();
  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled') continue;
    for (const fid of [bout.fighterAId, bout.fighterBId]) {
      const list = scheduledByFighter.get(fid) ?? [];
      list.push(bout.id);
      scheduledByFighter.set(fid, list);
    }
  }

  for (const [fid, bouts] of scheduledByFighter) {
    if (bouts.length > 1) {
      out.push({ code: 'two-scheduled-bouts', message: `${save.fighters[fid]?.name ?? fid} is scheduled for ${bouts.length} bouts.`, fighterId: fid });
    }
  }

  const campCount = new Map<FighterId, number>();
  for (const camp of Object.values(save.camps)) {
    if (camp.status !== 'planned' && camp.status !== 'running') continue;
    campCount.set(camp.fighterId, (campCount.get(camp.fighterId) ?? 0) + 1);
  }
  for (const [fid, n] of campCount) {
    if (n > 1) out.push({ code: 'multiple-active-camps', message: `${save.fighters[fid]?.name ?? fid} has ${n} active camps.`, fighterId: fid });
  }

  const offerSeen = new Map<string, string>();
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    const key = offer.idempotencyKey ?? offerKey({
      fighterId: offer.fighterId,
      opponentId: offer.opponentId,
      eventId: offer.eventId,
      slot: offer.isMainEvent ? 'main' : 'card',
      offerType: offer.isTitleFight ? 'title' : offer.isInterimTitleFight ? 'interim-title' : 'ordinary',
      isReplacementSlot: offer.isReplacementSlot,
    });
    const prior = offerSeen.get(key);
    if (prior) out.push({ code: 'duplicate-offer', message: `Offers ${prior} and ${offer.id} are the same matchup on the same card.` });
    else offerSeen.set(key, offer.id);
  }

  for (const fighter of Object.values(save.fighters)) {
    if (!fighter.nextBoutId) continue;
    const bout = save.bouts[fighter.nextBoutId];
    if (!bout) {
      out.push({ code: 'dangling-booking', message: `${fighter.name} points at a bout that does not exist.`, fighterId: fighter.id, boutId: fighter.nextBoutId });
      continue;
    }
    if (bout.status !== 'scheduled') {
      out.push({ code: 'stale-booking', message: `${fighter.name} points at a ${bout.status} bout.`, fighterId: fighter.id, boutId: bout.id });
      continue;
    }
    if (bout.fighterAId !== fighter.id && bout.fighterBId !== fighter.id) {
      out.push({ code: 'foreign-booking', message: `${fighter.name} points at a bout they are not in.`, fighterId: fighter.id, boutId: bout.id });
      continue;
    }
    // A booked fighter must not also be carrying an open ordinary offer.
    for (const offer of Object.values(save.fightOffers)) {
      if (offer.status !== 'open') continue;
      if (offer.fighterId !== fighter.id) continue;
      if (offer.isReplacementSlot) continue;
      out.push({ code: 'booked-with-open-offer', message: `${fighter.name} is booked and still has open offer ${offer.id}.`, fighterId: fighter.id });
    }
  }

  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled') continue;
    const a = save.fighters[bout.fighterAId];
    const b = save.fighters[bout.fighterBId];
    if (a && a.nextBoutId !== bout.id) {
      out.push({ code: 'unreferenced-booking', message: `${a.name} does not point back at scheduled bout ${bout.id}.`, fighterId: a.id, boutId: bout.id });
    }
    if (b && b.nextBoutId !== bout.id) {
      out.push({ code: 'unreferenced-booking', message: `${b.name} does not point back at scheduled bout ${bout.id}.`, fighterId: b.id, boutId: bout.id });
    }
  }

  return out;
}

/** Throws on the first invariant violation. Used by tests and development builds. */
export function assertBookingInvariants(save: SaveGame): void {
  const found = checkBookingInvariants(save);
  if (found.length > 0) {
    throw new Error(`Booking invariant violated (${found.length}): ${found.map((f) => `[${f.code}] ${f.message}`).join(' | ')}`);
  }
}

/** Human readable summary of why a fighter is unavailable, for the interface. */
export function availabilityNote(save: SaveGame, fighter: Fighter, eventDate: IsoDate): string {
  const reason = offerBlockReason(save, fighter, { eventDate });
  if (!reason) return 'Available.';
  return BLOCK_REASON_TEXT[reason];
}

/** Divisional limit helper used by the weigh in screens. */
export function limitsFor(divisionId: DivisionId, bout: Bout): { limit: number; allowance: number; titleLimit: number } {
  const d = DIVISION_BY_ID[divisionId];
  return {
    limit: bout.contractedWeightLb,
    allowance: isChampionshipBout(bout) ? 0 : d.nonTitleAllowanceLb,
    titleLimit: d.limitLb,
  };
}


/** Builds the active camp set once per booking pass. */
export function inCampFighterIds(save: SaveGame): Set<FighterId> {
  const ids = new Set<FighterId>();
  for (const camp of Object.values(save.camps)) {
    if (camp.status === 'planned' || camp.status === 'running') ids.add(camp.fighterId);
  }
  return ids;
}
