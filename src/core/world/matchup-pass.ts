import { addDays, daysBetween } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { FightCardEvent } from '../types/world';
import type { SaveGame } from '../types/save';
import type { Rng } from '../rng';
import { PROMOTION_MATCHMAKING } from '../config/branding';
import { DIVISION_BY_ID } from '../config/divisions';
import { addInboxMessage } from './inbox';
import { createFightOffer } from './offers';
import { isAvailable, openOfferFighterIds, titleBoutRoom } from './matchmaking';
import { titleShotEligibility } from './title-eligibility';
import { inCampFighterIds } from './availability';
import {
  evaluateAllInterests,
  interestReason,
  interestStatusLine,
  matchupInterestsFor,
  otherSide,
  recordMatchupInterest,
  type MatchupInterest,
} from './matchup-interest';
import { mayNotify } from './decisions';
import { currentContender } from './contender';

/**
 * The weekly matchmaking interest pass.
 *
 * This is what closes the loop the player could previously see was open: a callout that went
 * well, and then silence. Every live interest is re-evaluated against the world, an eligible
 * one with real promotion backing is converted into an actual fight offer, and one whose
 * blocker has changed is reported to the player with the reason.
 */

export interface MatchupPassResult {
  headlines: string[];
  offersCreated: number;
  reported: number;
}

/** The threshold at which the promotion stops considering and starts booking. */
export const BOOKING_PRIORITY = 0.5;

/**
 * Finds an event far enough out to build a camp around.
 *
 * A callout fight is not a short notice booking, so the window starts at six weeks.
 */
function suitableEvents(save: SaveGame): FightCardEvent[] {
  return Object.values(save.events)
    .filter((e) => !e.promotionId)
    .filter((e) => e.status === 'announced')
    .filter((e) => {
      const days = daysBetween(save.date, e.date);
      return days >= 42 && days <= 150;
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Turns one eligible interest into an offer, if a card and both fighters allow it.
 *
 * Returns the offer id, or null with the reason recorded on the interest.
 */
function tryBook(save: SaveGame, interest: MatchupInterest, player: Fighter, rng: Rng): string | null {
  // The opponent is whichever side of the interest the player is not. The player can be the
  // target as easily as the caller, because an opponent calling the player out records the
  // interest that way round, and reading `targetId` unconditionally booked the player against
  // themselves.
  const otherId = otherSide(interest, player.id);
  const target = save.fighters[otherId];
  if (!target || target.id === player.id) return null;
  const offerIds = openOfferFighterIds(save);
  const campIds = inCampFighterIds(save);

  // A fight with the division's champion is a title fight or it is not made. Booked as an ordinary
  // three rounder it put the belt holder in a bout they could lose without losing the belt, and an
  // unranked fighter who accepted a callout walked into it. evaluateInterest has already refused a
  // challenger without the standing for a title shot; this checks the rest, such as the belt
  // already being on the line elsewhere, on the day.
  const table = save.rankings[player.divisionId];
  const championId = table?.championId ?? null;
  const titleFight = championId === player.id || championId === target.id;
  if (titleFight) {
    const challenger = championId === player.id ? target : player;
    if (!titleShotEligibility(save, challenger, player.divisionId, { vacant: false }).eligible) return null;
  }

  for (const event of suitableEvents(save)) {
    const ctx = {
      date: event.date,
      bookedFighterIds: new Set<string>(),
      openOfferFighterIds: offerIds,
      inCampFighterIds: campIds,
      isChampionshipBooking: titleFight,
    };
    if (!isAvailable(save, target, ctx)) continue;
    if (titleFight && titleBoutRoom(save, event) <= 0) continue;
    const main = titleFight || interest.interestScore >= 70;
    const offer = createFightOffer(save, player, target, event, rng, {
      isMainEvent: main,
      isTitleFight: titleFight,
      isInterimTitleFight: false,
      scheduledRounds: main ? 5 : 3,
      reason: titleFight
        ? `${interestReason(save, interest, player.id)} The ${DIVISION_BY_ID[player.divisionId].name} championship is on the line.`
        : interestReason(save, interest, player.id),
      isReplacementSlot: false,
      // A contender bout must be labelled as an eliminator so that winning it grants the number
      // one contender position. The interest source alone is not a matchmaking category. With a
      // contender already standing the win cannot take the spot, so it is not called one.
      bookingKind: titleFight
        ? 'title-fight'
        : interest.source === 'title-claim'
          ? currentContender(save, player.divisionId)
            ? 'ranked-matchup'
            : 'eliminator'
          : interest.source,
      matchupInterestId: interest.id,
    });
    if (offer) {
      interest.eligibility = 'fulfilled';
      interest.linkedOfferId = offer.id;
      interest.resolution = `The promotion made the fight. The offer is in your inbox for ${event.name}.`;
      return offer.id;
    }
  }
  return null;
}

/**
 * Runs the pass for the player.
 *
 * Only the player's interests generate inbox traffic. Interests between other fighters are
 * still evaluated, because they feed the matchmaker's scoring on every card.
 */
export function runMatchupInterestPass(save: SaveGame, player: Fighter, rng: Rng): MatchupPassResult {
  const headlines: string[] = [];
  let offersCreated = 0;
  let reported = 0;

  evaluateAllInterests(save);

  for (const interest of matchupInterestsFor(save, player.id)) {
    if (interest.eligibility === 'fulfilled' || interest.eligibility === 'rejected') continue;

    // Eligible and backed. The promotion books it.
    if (interest.eligibility === 'eligible' && interest.priority >= BOOKING_PRIORITY && !player.nextBoutId) {
      const offerId = tryBook(save, interest, player, rng);
      if (offerId) {
        offersCreated++;
        const otherName = save.fighters[otherSide(interest, player.id)]?.name ?? 'your opponent';
        // Only the caller asked for it. When the opponent called the player out, saying "the
        // fight you asked for" credited the player with somebody else's callout.
        headlines.push(
          interest.callerId === player.id
            ? `The fight you asked for against ${otherName} has been made.`
            : `The fight with ${otherName} has been made.`
        );
        continue;
      }
      // No card worked this week. That is not a failure, and the interest stays live.
      interest.resolution = null;
    }

    // A lapsed matchup is over. Reporting it said "the matchup stays on the list and will be
    // looked at again", which was not true, and the interface already shows the expiry.
    if (interest.eligibility === 'expired') continue;

    // Report a change of state once. The signature includes the state so the player hears
    // about a blocker clearing, but is not told the same thing every week.
    const state = `${interest.eligibility}|${interest.blockers.join(',')}`;
    if (interest.lastReportedState === state) continue;
    const firstReport = interest.lastReportedState === null;
    interest.lastReportedState = state;

    // The very first evaluation of a brand new interest is not news. The callout screen has
    // already told the player what happened.
    if (firstReport && interest.eligibility === 'eligible') continue;

    const signature = `matchup|${interest.id}|${state}`;
    if (!mayNotify(save, { signature, cooldownDays: 30 })) continue;

    // The other side from the player. Reading the target named the player as their own opponent
    // whenever somebody else had made the callout.
    const target = save.fighters[otherSide(interest, player.id)];
    if (!target) continue;
    const message = addInboxMessage(save, {
      sender: 'matchmaker',
      senderName: PROMOTION_MATCHMAKING,
      subject:
        interest.eligibility === 'eligible'
          ? `Negotiations open: ${target.name}`
          : `Update on the ${target.name} fight`,
      body:
        interest.eligibility === 'eligible'
          ? `The blocker on the fight with ${target.name} has cleared and it is back with the matchmaker. ${interestStatusLine(save, interest, player.id)}`
          : `${interestStatusLine(save, interest, player.id)} The matchup stays on the list and will be looked at again.`,
      category: 'career',
      requiresAction: false,
      deadline: null,
      choices: [],
      linkedFighterId: target.id,
    });
    // The guard above reads this. Without it the guard never matched anything, and a state that
    // flipped back and forth was reported again on every flip.
    message.notificationSignature = signature;
    reported++;
  }

  return { headlines, offersCreated, reported };
}

/**
 * Creates the debut interest for a fighter who has just changed division.
 *
 * Without this a moved fighter joins the unranked pool and waits for the ordinary card
 * seeding to notice them, which is what made a weight class change look like nothing had
 * happened. The debut is a real, prioritised matchmaking candidate.
 */
export function seedDivisionDebut(save: SaveGame, fighter: Fighter, opponentId: string | null, reasonLine: string): MatchupInterest | null {
  if (!opponentId) return null;
  const opponent = save.fighters[opponentId];
  if (!opponent) return null;
  return recordMatchupInterest(save, {
    source: 'division-debut',
    caller: fighter,
    target: opponent,
    requestedConditions: `A debut at ${DIVISION_BY_ID[fighter.divisionId].name}.`,
    opponentResponse: null,
    fanResponse: null,
    promotionResponse: reasonLine,
    interestScore: 72,
    lifespanDays: 200,
  });
}

/** How long an interest survives with no movement before the promotion lets it go. */
export const INTEREST_LIFESPAN_DAYS = 150;

/** Convenience for the interface: the date an interest lapses. */
export function interestExpiry(save: SaveGame): string {
  return addDays(save.date, INTEREST_LIFESPAN_DAYS);
}
