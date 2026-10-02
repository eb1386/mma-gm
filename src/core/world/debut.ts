import { PROMOTION_ABBREVIATION } from '../config/branding';
import { MATCHMAKING as M } from '../config/matchmaking';
import { clamp, hashString, Rng } from '../rng';
import { daysBetween } from '../types/common';
import { ovrDisplayed, type Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import type { FightCardEvent, FightOffer } from '../types/world';
import { inCampFighterIds, offerBlockReason } from './availability';
import { mainRosterFighters } from './circuit';
import { potConfidenceFor } from './development';
import { generateContract } from './economy';
import { generateFighter } from './generator';
import { moveFighterToGym } from './gyms';
import { isAvailable, openOfferFighterIds } from './matchmaking';
import { createFightOffer } from './offers';
import { updatePot } from './pot';

/**
 * The player's promotional debut.
 *
 * A debut is against another newcomer, and the card gates in scoreCandidate hold every pairing to
 * that. The gates are right, but on their own they left a player with nobody to fight: a fresh
 * division has only fifteen or so unranked newcomers, almost all of them well above a raw prospect,
 * and the pool shrinks as a save ages. A created Ovr 48 prospect on the main roster got no offer in
 * seven months, and a fighter called up from the regional circuit waited sixteen months for a debut
 * the call up had promised against a newcomer.
 *
 * So the player's debut is made directly rather than left to the card seeding: a real newcomer
 * close to the player's level when one is free, and otherwise a newly signed one, which is how a
 * promotion actually finds a debut opponent. This is for the player only. The gates themselves are
 * unchanged, so a debuting roster fighter is never handed a stronger opponent.
 */

/** The widest Ovr gap, either way, between the player and a debut opponent. */
export const DEBUT_OPPONENT_MAX_OVR_GAP = 5;
/** How long a main roster debutant waits for the card seeding before the debut is made directly. */
export const DEBUT_WAIT_DAYS = 35;
/** The window for the debut card: a full camp out, and not so far that the wait drags on. */
export const DEBUT_EARLIEST_DAYS = 42;
export const DEBUT_LATEST_DAYS = 90;
/**
 * About where the weakest newcomers on a fresh main roster sit. A created fighter below it is
 * outclassed by the whole division, so the new game screen recommends the regional start.
 */
export const MAIN_START_NEWCOMER_FLOOR = 55;

const promotionalFights = (f: Fighter) => f.ufcRecord.wins + f.ufcRecord.losses + f.ufcRecord.draws + f.ufcRecord.noContests;

/** True for a player on the main roster who has not yet had a promotional fight. */
export function isMainRosterDebutant(f: Fighter): boolean {
  return !f.circuit && f.ranking === null && !f.isChampion && promotionalFights(f) === 0;
}

/**
 * A debut opponent for the player on this card: an unranked newcomer with at most
 * `debutOpponentMaxFights` promotional fights, within a few points of Ovr, and free to fight. When
 * nobody fits, a newcomer close to the player's level is signed for the occasion.
 */
export function debutOpponentFor(save: SaveGame, player: Fighter, event: FightCardEvent, rng: Rng): Fighter {
  const ctx = {
    date: event.date,
    bookedFighterIds: new Set<string>(),
    openOfferFighterIds: openOfferFighterIds(save),
    inCampFighterIds: inCampFighterIds(save),
  };
  const mine = ovrDisplayed(player.ratings);
  const fits = mainRosterFighters(save)
    .filter(
      (f) =>
        f.id !== player.id &&
        f.divisionId === player.divisionId &&
        !f.retired &&
        f.ranking === null &&
        !f.isChampion &&
        promotionalFights(f) <= M.gate.debutOpponentMaxFights &&
        Math.abs(ovrDisplayed(f.ratings) - mine) <= DEBUT_OPPONENT_MAX_OVR_GAP
    )
    .filter((f) => isAvailable(save, f, ctx))
    // The closest match first, and the order is fixed so the same save always makes the same debut.
    .sort((a, b) => Math.abs(ovrDisplayed(a.ratings) - mine) - Math.abs(ovrDisplayed(b.ratings) - mine) || (a.id < b.id ? -1 : 1));
  if (fits.length > 0) return fits[0];
  return signDebutNewcomer(save, player, rng);
}

/** Signs a fictional newcomer near the player's level, with an empty promotional record. */
function signDebutNewcomer(save: SaveGame, player: Fighter, rng: Rng): Fighter {
  const mine = ovrDisplayed(player.ratings);
  const f = generateFighter(rng, {
    divisionId: player.divisionId,
    targetOvr: clamp(mine + rng.range(-3, 3), 30, 90),
    spread: rng.range(5, 9),
    age: rng.int(21, 28),
    today: save.date,
    idNumber: ++save.counters.fighter,
  });
  f.ufcRecord = { wins: 0, losses: 0, draws: 0, noContests: 0 };
  f.ranking = null;
  save.fighters[f.id] = f;
  updatePot(save, f);
  f.potConfidence = potConfidenceFor(f, save.date);
  const contract = generateContract(f, save, rng, { isPlayerFighter: false });
  save.contracts[contract.id] = contract;
  f.contractId = contract.id;
  const gyms = Object.values(save.gyms).filter((g) => g.fighterIds.length < g.capacity);
  if (gyms.length > 0) moveFighterToGym(save, f.id, rng.weighted(gyms, (g) => g.reputation + 10).id);
  return f;
}

/**
 * Makes the player's debut offer on the first main card in the window the player can take.
 *
 * Uses its own rng, seeded from the save and the date, so making the debut does not shift the
 * world's sequence. Returns the offer, or null when no card in range will have them.
 */
export function offerPlayerDebut(save: SaveGame, player: Fighter): FightOffer | null {
  const rng = new Rng(hashString(`debut|${save.seed}|${player.id}|${save.date}`));
  const events = Object.values(save.events)
    .filter((e) => !e.promotionId && e.status === 'announced')
    .filter((e) => {
      const days = daysBetween(save.date, e.date);
      return days >= DEBUT_EARLIEST_DAYS && days <= DEBUT_LATEST_DAYS;
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const event of events) {
    // A medical suspension from the fight that earned the call up has to be over by fight night.
    if (offerBlockReason(save, player, { eventDate: event.date })) continue;
    const opponent = debutOpponentFor(save, player, event, rng);
    const offer = createFightOffer(save, player, opponent, event, rng, {
      // A debut does not headline the card.
      isMainEvent: false,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: 3,
      reason: `A ${PROMOTION_ABBREVIATION} debut against another newcomer`,
      isReplacementSlot: false,
      bookingKind: 'debut',
    });
    if (offer) return offer;
  }
  return null;
}

/**
 * The weekly check for a player debutant the card seeding has not found a fight for.
 *
 * After `DEBUT_WAIT_DAYS` on the main roster with no booking and no open offer, the debut is made
 * directly. Returns a headline when an offer was made.
 */
export function ensurePlayerDebut(save: SaveGame, player: Fighter): string | null {
  if (!isMainRosterDebutant(player) || player.retired || player.nextBoutId) return null;
  const since = save.regional?.callUp?.calledUpOn ?? save.startDate;
  if (!since || daysBetween(since, save.date) < DEBUT_WAIT_DAYS) return null;
  const holding = Object.values(save.fightOffers).some(
    (o) => o.status === 'open' && (o.fighterId === player.id || o.opponentId === player.id)
  );
  if (holding) return null;
  const offer = offerPlayerDebut(save, player);
  if (!offer) return null;
  const opponent = save.fighters[offer.opponentId];
  return `A ${PROMOTION_ABBREVIATION} debut has been offered against ${opponent?.name ?? 'another newcomer'}.`;
}
