import type { Bout } from '@core/types/fight';
import type { SaveGame } from '@core/types/save';
import type { FightCardEvent } from '@core/types/world';

/**
 * The bout a card is billed on, for any screen that shows one line per event.
 *
 * The flagged main event when there is one. A regional card without a title fight flags none, so
 * the fallback is the top billed bout that took place (the highest boutOrder, which is where the
 * player's own bout sits), rather than whichever bout happened to be booked first. A regional card
 * can flag a title bout in each of several divisions, so the pick is the same rule among those:
 * highest boutOrder, then card order. A canceled bout never headlines: the card was billed on
 * whatever was left.
 */
export function headliner(save: SaveGame, event: FightCardEvent): Bout | null {
  const bouts = event.boutIds.map((id) => save.bouts[id]).filter((b): b is Bout => Boolean(b));
  const live = bouts.filter((b) => b.status !== 'canceled' && (event.status !== 'completed' || Boolean(save.history.results[b.id])));
  const top = (list: Bout[]) => list.reduce<Bout | null>((best, b) => (!best || b.boutOrder > best.boutOrder ? b : best), null);
  return top(live.filter((b) => b.isMainEvent)) ?? top(live);
}
