/**
 * Branding.
 *
 * The game and the promotion inside it are named in exactly one place. The simulated
 * promotion is fictional: it is never called UFC, and no generated event carries a real
 * promotion's name.
 *
 * Real world facts about real athletes keep their real attribution. A sourced record or a
 * profile citation refers to the actual promotion those facts came from, because changing
 * that would misattribute a factual record. The rule is simple: anything the simulation
 * invents belongs to UWFS, and anything sourced keeps its real provenance.
 */

export const GAME_NAME = 'MMA GM';
export const GAME_TAGLINE = 'Free MMA career and management simulator';

/** The fictional promotion the simulation runs. */
export const PROMOTION_NAME = 'Unified World Fight Series';
export const PROMOTION_ABBREVIATION = 'UWFS';

/** Departments inside the promotion, used as inbox senders. */
export const PROMOTION_MATCHMAKING = `${PROMOTION_ABBREVIATION} matchmaking`;
export const PROMOTION_CONTRACTS = `${PROMOTION_ABBREVIATION} contracts`;
export const PROMOTION_MARKETING = `${PROMOTION_ABBREVIATION} marketing`;

/** Numbered card, for example UWFS 300. */
export function numberedEventName(number: number): string {
  return `${PROMOTION_ABBREVIATION} ${number}`;
}

/** Fight night, for example UWFS Fight Night 84. */
export function fightNightName(number: number): string {
  return `${PROMOTION_ABBREVIATION} Fight Night ${number}`;
}

/** A championship, for example UWFS Lightweight Champion. */
export function championTitle(divisionName: string): string {
  return `${PROMOTION_ABBREVIATION} ${divisionName} Champion`;
}

/** The disclaimer shown in the footer and in the documentation. */
export const DISCLAIMER =
  `${GAME_NAME} is an unofficial fan-made MMA simulation. It is not affiliated with, sponsored by, approved by, ` +
  `or endorsed by UFC, Zuffa, ${PROMOTION_ABBREVIATION} as a real organization, or any fighter represented in the game. ` +
  `${PROMOTION_ABBREVIATION} is a fictional promotion used by the simulation.`;
