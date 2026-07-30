import { addDays, daysBetween } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { FightCardEvent } from '../types/world';
import type { SaveGame } from '../types/save';
import type { Rng } from '../rng';
import { PROMOTION_MATCHMAKING } from '../config/branding';
import { DIVISION_BY_ID } from '../config/divisions';
import { addInboxMessage } from './inbox';
import { createFightOffer } from './offers';
import { isAvailable, openOfferFighterIds } from './matchmaking';
import { inCampFighterIds } from './availability';
import {
  evaluateAllInterests,
  interestReason,
  interestStatusLine,
  matchupInterestsFor,
  recordMatchupInterest,
  type MatchupInterest,
} from './matchup-interest';
import { mayNotify } from './decisions';

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
  const target = save.fighters[interest.targetId];
  if (!target) return null;
  const offerIds = openOfferFighterIds(save);
  const campIds = inCampFighterIds(save);

  for (const event of suitableEvents(save)) {
    const ctx = { date: event.date, bookedFighterIds: new Set<string>(), openOfferFighterIds: offerIds, inCampFighterIds: campIds };
    if (!isAvailable(save, target, ctx)) continue;
    const offer = createFightOffer(save, player, target, event, rng, {
      isMainEvent: interest.interestScore >= 70,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: interest.interestScore >= 70 ? 5 : 3,
      reason: interestReason(save, interest),
      isReplacementSlot: false,
      bookingKind: interest.source,
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
        headlines.push(`The fight you asked for against ${save.fighters[interest.targetId]?.name ?? 'your target'} has been made.`);
        continue;
      }
      // No card worked this week. That is not a failure, and the interest stays live.
      interest.resolution = null;
    }

    // Report a change of state once. The signature includes the state so the player hears
    // about a blocker clearing, but is not told the same thing every week.
    const state = `${interest.eligibility}|${interest.blockers.join(',')}`;
    if (interest.lastReportedState === state) continue;
    const firstReport = interest.lastReportedState === null;
    interest.lastReportedState = state;

    // The very first evaluation of a brand new interest is not news. The callout screen has
    // already told the player what happened.
    if (firstReport && interest.eligibility === 'eligible') continue;

    if (!mayNotify(save, { signature: `matchup|${interest.id}|${state}`, cooldownDays: 30 })) continue;

    const target = save.fighters[interest.targetId];
    if (!target) continue;
    addInboxMessage(save, {
      sender: 'matchmaker',
      senderName: PROMOTION_MATCHMAKING,
      subject:
        interest.eligibility === 'eligible'
          ? `Negotiations open: ${target.name}`
          : `Update on the ${target.name} fight`,
      body:
        interest.eligibility === 'eligible'
          ? `The blocker on the fight with ${target.name} has cleared and it is back with the matchmaker. ${interestStatusLine(save, interest)}`
          : `${interestStatusLine(save, interest)} The matchup stays on the list and will be looked at again.`,
      category: 'career',
      requiresAction: false,
      deadline: null,
      choices: [],
      linkedFighterId: target.id,
    });
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
