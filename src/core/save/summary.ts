import type { IsoDate } from '../types/common';
import type { SaveGame } from '../types/save';
import { careerStatus, type CareerState } from '../world/career';
import { DIVISION_BY_ID } from '../config/divisions';

/**
 * What a save card on the landing screen shows about a career.
 *
 * It is written into the save index with every save. The landing screen used to read and migrate
 * every full save (tens of megabytes each, after a few seasons) just to fill in these few lines,
 * and did it again after every rename, copy and delete. The index is small, so the cards now draw
 * from it alone and a full save is read only to open it.
 */
export interface CareerSummary {
  state: CareerState;
  /** How long the career has been in this state. Only the save knows this; it cannot be recomputed. */
  stateSince: IsoDate | null;
  reason: string | null;
  nextAction: string | null;
  opponent: string | null;
  fightDate: IsoDate | null;
  injury: string | null;
  /** The date the longest running suspension ends, formatted by whoever shows it. */
  suspensionUntil: IsoDate | null;
  /** The division's display name, not its id. */
  division: string | null;
}

export function summarizeCareer(save: SaveGame): CareerSummary {
  const status = careerStatus(save);
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  // Only a suspension still running. The record of one that has ended stays on the fighter, and
  // the card used to report it on a fighter who was free to compete.
  const live = (until: IsoDate | null | undefined) => (until && until > save.date ? until : null);
  const suspension =
    live(me?.antiDopingSuspension?.until) ?? live(me?.medicalSuspension?.until) ?? live(me?.commissionSuspension?.until);
  // The live status is authoritative for what to do next. The persisted record is what carries
  // how long this has been the case, which nothing can work out after the fact.
  const persisted = save.careerState?.state === status.state ? save.careerState : null;
  return {
    state: status.state,
    stateSince: persisted?.since ?? null,
    reason: persisted?.reason ?? status.reason,
    nextAction: status.action?.label ?? null,
    opponent: status.opponentName,
    fightDate: status.eventDate,
    injury: status.injurySummary,
    suspensionUntil: suspension,
    division: me ? (DIVISION_BY_ID[me.divisionId]?.name ?? me.divisionId) : null,
  };
}
