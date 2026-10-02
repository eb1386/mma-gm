import type { SaveGame } from '@core/types/save';
import type { FightCardEvent } from '@core/types/world';

/**
 * Bouts still on an upcoming card.
 *
 * Most cancellations take the bout out of event.boutIds, but not all of them (a regional call up
 * cancels in place), so counting boutIds alone showed a canceled bout as still on the card. The
 * Dashboard and the Calendar disagreed about the same event for the same reason.
 */
export function scheduledBoutCount(save: SaveGame, event: FightCardEvent): number {
  return event.boutIds.filter((id) => save.bouts[id]?.status === 'scheduled').length;
}

/** 'card TBA', '1 bout' or 'N bouts', for an upcoming card. */
export function scheduledBoutLabel(save: SaveGame, event: FightCardEvent): string {
  const n = scheduledBoutCount(save, event);
  return n === 0 ? 'card TBA' : `${n} bout${n === 1 ? '' : 's'}`;
}
