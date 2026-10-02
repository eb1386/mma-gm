import type { Fighter } from '../types/fighter';
import type { Bout, FightResult } from '../types/fight';
import type { SaveGame } from '../types/save';
import type { FightCardEvent } from '../types/world';
import { REGIONAL_LEVELS, REGIONAL_PROMOTION_BY_ID } from '../config/regional';

/**
 * Who belongs to which world.
 *
 * The regional circuit shares the save with the main promotion: its fighters are real fighters
 * and its cards are real cards, so every fight runs through the same engine, camp and fight week.
 * What keeps the two apart is this module. Every main promotion system that walks the roster or
 * the calendar asks these questions first, and a fighter or card on the circuit is never ranked,
 * matched, crowned or counted by the main promotion.
 *
 * It is a leaf module on purpose: it imports nothing that imports it back, so any file can use it.
 */

/** True for a fighter competing on a regional circuit rather than for the main promotion. */
export function isCircuitFighter(f: Fighter | null | undefined): boolean {
  return Boolean(f?.circuit);
}

/** True for a fighter who belongs to the main promotion's world, signed or not. */
export function onMainRoster(f: Fighter | null | undefined): f is Fighter {
  return Boolean(f) && !f!.circuit;
}

/** True for a card run by a regional promotion, including the main promotion's tryouts. */
export function isRegionalEvent(e: FightCardEvent | null | undefined): boolean {
  return Boolean(e?.promotionId);
}

export function isRegionalBout(save: SaveGame, bout: Bout | null | undefined): boolean {
  if (!bout) return false;
  return isRegionalEvent(save.events[bout.eventId]);
}

/**
 * True for a stored result that belongs in the main promotion's books.
 *
 * Every fight in the save, regional and amateur ones included, is written to the same results
 * map, so a reader that walks it unfiltered put local headliners in Most main events and a
 * sixteen year old's amateur submission at the top of Fastest finish. The event decides, not the
 * fighter: a called up fighter's circuit flag is already cleared, and their regional fights must
 * still stay out. A result whose event or bout is no longer in the save counts as main, so old
 * history keeps its place.
 */
export function isMainResult(save: SaveGame, r: FightResult): boolean {
  if (isRegionalEvent(save.events[r.eventId])) return false;
  return !save.bouts[r.boutId]?.isAmateur;
}

/** The main promotion's fighters, the population every main promotion pass should walk. */
export function mainRosterFighters(save: SaveGame): Fighter[] {
  const out: Fighter[] = [];
  for (const f of Object.values(save.fighters)) if (!f.circuit) out.push(f);
  return out;
}

/** The main promotion's cards. */
export function mainEvents(save: SaveGame): FightCardEvent[] {
  const out: FightCardEvent[] = [];
  for (const e of Object.values(save.events)) if (!e.promotionId) out.push(e);
  return out;
}

/**
 * What a regional fighter's training costs, against what a main promotion fighter pays.
 *
 * A gym does not charge a local fighter on two thousand dollar purses what it charges a ranked
 * contender. Without this a regional career was in debt by its second camp and never recovered,
 * which is not how anybody actually comes up through the sport.
 */
export function trainingCostScale(f: Fighter | null | undefined): number {
  if (!f?.circuit) return 1;
  const promotion = REGIONAL_PROMOTION_BY_ID[f.circuit.replace(/:am$/, '')];
  if (!promotion) return 0.2;
  if (f.circuit.endsWith(':am')) return 0.08;
  return promotion.level === 1 ? 0.12 : promotion.level === 2 ? 0.2 : 0.35;
}

/**
 * What a sponsor pays a fighter on this stage, against what it pays a main promotion fighter.
 *
 * Sponsorship was sized from appeal alone, and appeal barely moves with the stage, so a sixteen
 * year old amateur on unpaid local cards drew the same twenty five thousand dollar a fight deals
 * as a ranked contender, and the whole regional path stopped needing a purse at all. Brands pay
 * for an audience, and a local card's audience is a few hundred people.
 */
export function sponsorStageScale(f: Fighter | null | undefined): number {
  if (!f?.circuit) return 1;
  if (f.circuit.endsWith(':am')) return 0.02;
  const promotion = REGIONAL_PROMOTION_BY_ID[f.circuit];
  if (!promotion) return 0.05;
  return promotion.level === 1 ? 0.05 : promotion.level === 2 ? 0.1 : 0.2;
}

/**
 * What fight week travel costs on this card, against a main promotion card.
 *
 * Read from the event rather than the fighter, because the circuit is cleared on the call up
 * fight and that bout is still a local card. A flat main promotion figure charged an unpaid amateur
 * twelve hundred dollars to drive across town, and took most of a level one show purse.
 */
export function eventTravelScale(save: SaveGame, bout: Bout | null | undefined): number {
  if (!bout) return 1;
  const event = save.events[bout.eventId];
  if (!event?.promotionId) return 1;
  if (bout.isAmateur) return 0.1;
  const promotion = REGIONAL_PROMOTION_BY_ID[event.promotionId];
  if (!promotion) return 0.3;
  return promotion.level === 1 ? 0.15 : promotion.level === 2 ? 0.3 : 0.6;
}

/** How much a result on this fighter's stage moves popularity, against a main promotion result. */
export function popularityScaleFor(save: SaveGame, bout: Bout): number {
  const event = save.events[bout.eventId];
  if (!event?.promotionId) return 1;
  const promotion = REGIONAL_PROMOTION_BY_ID[event.promotionId];
  if (!promotion) return 0.45;
  return bout.isAmateur ? 0.08 : REGIONAL_LEVELS[promotion.level].popularityScale;
}
