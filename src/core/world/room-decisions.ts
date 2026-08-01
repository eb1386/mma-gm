import { clamp } from '../rng';
import { Rng } from '../rng';
import type { InboxMessage } from '../types/world';
import type { SaveGame } from '../types/save';
import { cancelBout } from './matchmaking';
import { moveFighterToGym } from './gyms';
import { DIVISIONS, DIVISION_BY_ID } from '../config/divisions';
import type { Fighter } from '../types/fighter';

/** The room choices that act on one named fighter, and so need that fighter to still be here. */
const ROOM_CHOICES_ABOUT_A_FIGHTER = new Set([
  'accommodate',
  'decline',
  'hold-line',
  'explain',
  'change-corner',
  'refuse',
  'talk',
  'let-go',
  'support',
  'advise-against',
]);

/**
 * Room management decisions: the ones a coach answers about their own gym and roster.
 *
 * These lived inside the inbox page, in a switch the page could never reach, because every
 * category they belong to is handled by the decision transaction and the handler for those
 * categories fell through to the camp life code, which returns immediately when there is no
 * player fighter. In Coach Mode there never is one, so every one of these decisions was a no-op
 * that reported success. They live here now, where the transaction runs them.
 */
export function applyRoomChoice(save: SaveGame, message: InboxMessage, choiceKey: string, rng: Rng): string | null {
  let resolution: string | null = null;
  let leaves = false;

  // A decision about somebody who has already gone is not a decision any more. These items are
  // raised weeks before they are answered, and a fighter can leave in the meantime, so answering
  // one used to tell the player that a fighter at another gym had agreed to stay, and dock the
  // happiness of everyone still in the room for attention given to somebody who was not there.
  if (message.linkedFighterId && ROOM_CHOICES_ABOUT_A_FIGHTER.has(choiceKey)) {
    const subject = save.fighters[message.linkedFighterId];
    if (!subject) return 'That fighter is no longer on the roster.';
    if (save.player.gymId && subject.gymId !== save.player.gymId) {
      return `${subject.name} has already left the gym, so there is nothing to answer.`;
    }
  }
  switch (choiceKey) {
    case 'accommodate': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        f.happiness = clamp(f.happiness + 12, 0, 100);
        f.relationships.player = clamp(f.relationships.player + 10, 0, 100);
        // Attention given to one fighter is attention taken from the rest of the room.
        const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
        for (const other of gym?.fighterIds ?? []) {
          if (other === f.id) continue;
          const o = save.fighters[other];
          if (o) o.happiness = clamp(o.happiness - 2, 0, 100);
        }
        resolution = `Gave ${f.name} dedicated time. The rest of the room noticed.`;
      }
      break;
    }
    case 'decline': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        f.relationships.player = clamp(f.relationships.player - 9, 0, 100);
        f.happiness = clamp(f.happiness - 6, 0, 100);
        resolution = `Told ${f.name} the room comes first.`;
      }
      break;
    }
    case 'reduce-sparring': {
      const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
      if (gym) {
        gym.hardSparringTendency = clamp(gym.hardSparringTendency - 18, 0, 100);
        gym.safety = clamp(gym.safety + 7, 0, 100);
        for (const id of gym.fighterIds) {
          const o = save.fighters[id];
          if (o) o.happiness = clamp(o.happiness + 5, 0, 100);
        }
        resolution = 'Hard sparring has been cut back across the gym.';
      }
      break;
    }
    case 'hold-line': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        f.relationships.player = clamp(f.relationships.player - 12, 0, 100);
        f.happiness = clamp(f.happiness - 9, 0, 100);
        resolution = 'The sparring policy stands.';
      }
      break;
    }
    case 'rebalance': {
      const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
      if (gym) {
        for (const id of gym.fighterIds) {
          const o = save.fighters[id];
          if (!o) continue;
          if (o.ranking === null) o.happiness = clamp(o.happiness + 7, 0, 100);
          else o.happiness = clamp(o.happiness - 5, 0, 100);
        }
        gym.culture = clamp(gym.culture + 4, 0, 100);
        resolution = 'Attention has been spread more evenly across the roster.';
      }
      break;
    }
    case 'explain': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) f.relationships.player = clamp(f.relationships.player - 5, 0, 100);
      resolution = 'Explained the position. It was not well received.';
      break;
    }
    case 'change-corner': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        f.relationships.coach = clamp(f.relationships.coach + 18, 0, 100);
        f.happiness = clamp(f.happiness + 7, 0, 100);
        resolution = `${f.name} will have a different corner team.`;
      }
      break;
    }
    case 'refuse': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) f.relationships.player = clamp(f.relationships.player - 10, 0, 100);
      resolution = 'The corner stays as it is.';
      break;
    }
    case 'talk': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        const persuaded = rng.chance(clamp(0.3 + f.relationships.player / 200, 0.2, 0.8));
        if (persuaded) {
          f.happiness = clamp(f.happiness + 16, 0, 100);
          f.relationships.player = clamp(f.relationships.player + 8, 0, 100);
          resolution = `${f.name} has agreed to stay, for now.`;
        } else {
          leaves = true;
          resolution = `${f.name} listened, and is leaving anyway.`;
        }
      }
      break;
    }
    case 'let-go': {
      leaves = true;
      resolution = 'Left the decision with the fighter, and they have gone.';
      break;
    }
    case 'support': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        f.relationships.player = clamp(f.relationships.player + 8, 0, 100);
        // Backing it means it happens. Both answers used to be text and the fighter stayed
        // exactly where they were either way.
        const moved = moveFighterDivision(save, f, 'up');
        resolution = moved
          ? `Backed the move, and ${f.name} is now at ${DIVISION_BY_ID[f.divisionId].name}.`
          : `Backed the move, but there is nowhere for ${f.name} to go.`;
      }
      break;
    }
    case 'advise-against': {
      const f = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
      if (f) {
        // The fighter has autonomy and may go ahead regardless.
        const goesAnyway = rng.chance(0.45);
        f.relationships.player = clamp(f.relationships.player - 6, 0, 100);
        const moved = goesAnyway && moveFighterDivision(save, f, 'up');
        resolution = moved
          ? `${f.name} moved up to ${DIVISION_BY_ID[f.divisionId].name} regardless of the advice.`
          : `${f.name} has agreed to stay in the division.`;
      }
      break;
    }
    case 'accept-replacement': {
      resolution = 'Accepted the replacement opponent.';
      break;
    }
    case 'decline-replacement': {
      const bout = message.linkedBoutId ? save.bouts[message.linkedBoutId] : null;
      if (bout) {
        // The one transaction that owns cancellation. This used to hand roll the pointers and
        // the event card, which left the camp running, the linked messages unresolved and any
        // contender claim consumed against a bout that never happened.
        cancelBout(save, bout, 'The player withdrew after an opponent change.');
        const self = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
        if (self) self.relationships.matchmaker = clamp(self.relationships.matchmaker - 8, 0, 100);
      }
      resolution = 'Withdrew from the bout after the opponent change.';
      break;
    }
  }

  // A fighter leaves only when the answer says they do. Keying this off the subject line meant a
  // fighter the player had just persuaded to stay was moved out of the gym anyway, under a
  // resolution saying they had agreed to stay.
  if (leaves && message.linkedFighterId) {
    const f = save.fighters[message.linkedFighterId];
    if (f && save.player.gymId && f.gymId === save.player.gymId) moveFighterToGym(save, f.id, null);
  }

  return resolution;
}

/**
 * Moves a fighter one division in the given direction, if there is one they can compete in.
 *
 * Same rule as the automatic move in health.ts: the next division of the same gender that is
 * still contested, rather than the next one by order, which runs straight through both genders
 * and past retired divisions.
 */
function moveFighterDivision(save: SaveGame, fighter: Fighter, direction: 'up' | 'down'): boolean {
  const from = DIVISION_BY_ID[fighter.divisionId];
  const candidates = DIVISIONS.filter(
    (d) => d.gender === from.gender && d.activeUntil === null && (direction === 'up' ? d.order > from.order : d.order < from.order)
  ).sort((a, b) => (direction === 'up' ? a.order - b.order : b.order - a.order));
  const to = candidates[0];
  if (!to) return false;
  const table = save.rankings[from.id];
  if (table) table.entries = table.entries.filter((e) => e.fighterId !== fighter.id);
  fighter.divisionId = to.id;
  fighter.ranking = null;
  fighter.previousRanking = null;
  fighter.weeksRanked = 0;
  fighter.weightMisses = 0;
  fighter.walkingWeightLb = to.limitLb + Math.min(to.typicalWalkAroundOverLb, Math.max(2, fighter.walkingWeightLb - from.limitLb));
  if (!fighter.eligibleDivisions.includes(to.id)) fighter.eligibleDivisions.push(to.id);
  return true;
}
