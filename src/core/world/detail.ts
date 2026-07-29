import type { Bout, FightResult } from '../types/fight';
import type { SaveGame } from '../types/save';

/**
 * Simulation detail levels.
 *
 * Every fight runs through the same engine, so the outcome distribution is identical at
 * every level. What changes is how much of the fight is written down afterwards. A twenty
 * year world contests tens of thousands of bouts, and keeping a full play by play for all
 * of them is what makes a save enormous and a year advance slow.
 *
 *   full      player fights, title fights, main events, rivalry and user selected fights
 *   standard  ranked and main card fights, and important prospects
 *   fast      ordinary background preliminaries and distant simulation
 *
 * Fast is not a different model. It is the same simulation with the narrative and the
 * event stream discarded, which is why it stays statistically calibrated by construction.
 */

export type SimDetail = 'full' | 'standard' | 'fast';

export interface DetailContext {
  /** Forces a level regardless of the bout, used by tests and by distant simulation. */
  override?: SimDetail;
}

export function detailForBout(save: SaveGame, bout: Bout, ctx: DetailContext = {}): SimDetail {
  if (ctx.override) return ctx.override;

  const playerId = save.player.fighterId;
  const playerGym = save.player.gymId;

  // Anything the player is part of is always recorded in full.
  if (playerId && (bout.fighterAId === playerId || bout.fighterBId === playerId)) return 'full';
  if (playerGym) {
    const a = save.fighters[bout.fighterAId];
    const b = save.fighters[bout.fighterBId];
    if (a?.gymId === playerGym || b?.gymId === playerGym) return 'full';
  }

  if (bout.isTitleFight || bout.isInterimTitleFight) return 'full';
  if (bout.isMainEvent) return 'full';

  const a = save.fighters[bout.fighterAId];
  const b = save.fighters[bout.fighterBId];
  const ranked = (a?.ranking ?? null) !== null || (b?.ranking ?? null) !== null;
  if (bout.isCoMain || ranked || bout.cardSegment === 'main') return 'standard';

  return 'fast';
}

/**
 * Applies a detail level to a finished result by discarding what that level does not
 * keep. Totals, scorecards, round summaries, the result itself and every consequence are
 * preserved at every level, so records, rankings and fighter pages never lose anything.
 */
export function applyDetail(result: FightResult, detail: SimDetail): FightResult {
  if (detail === 'full') return result;

  if (detail === 'standard') {
    // Keep the events that carried a meaningful moment so a recap can still be written.
    result.events = result.events.filter((e) => e.importance === 'major' || e.importance === 'decisive');
    return result;
  }

  // Fast: the closing sequence only, which is enough to describe how it ended.
  result.events = result.events.slice(-8);
  for (const round of result.rounds) round.summary = '';
  return result;
}

/** Whether commentary should be rendered at all for this level. */
export function shouldNarrate(detail: SimDetail): boolean {
  return detail !== 'fast';
}

/** Whether per round summaries should be written for this level. */
export function shouldSummarizeRounds(detail: SimDetail): boolean {
  return detail === 'full' || detail === 'standard';
}

export const DETAIL_LABEL: Record<SimDetail, string> = {
  full: 'Full detail',
  standard: 'Standard detail',
  fast: 'Fast',
};
