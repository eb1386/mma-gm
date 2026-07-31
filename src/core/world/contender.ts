import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { addDays, daysBetween, type BoutId, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, type Bout, type FightResult } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';

/**
 * Number one contender status.
 *
 * A title eliminator used to be a label on a bout that nothing read afterwards. Winning one
 * conferred exactly nothing, so the promise the game made to the player, win this and you are
 * next, was never kept, and the matchmaker was free to hand the shot to somebody else. This is
 * the missing record: an earned, persistent, forfeitable claim on the next title shot in a
 * division.
 *
 * There is at most one standing contender per division. That is what makes the guarantee
 * meaningful, and it is enforced here rather than left to each caller.
 */

export type ContenderSource =
  | 'eliminator-win'
  | 'division-move'
  | 'title-loss-rematch'
  | 'interim-champion'
  | 'promotion-decision';

export const CONTENDER_SOURCE_TEXT: Record<ContenderSource, string> = {
  'eliminator-win': 'won a number one contender bout',
  'division-move': 'arrived in the division as a champion',
  'title-loss-rematch': 'earned an immediate rematch for the title',
  'interim-champion': 'holds the interim championship',
  'promotion-decision': 'was named the next challenger by the promotion',
};

/** How long a claim survives before the promotion moves on. */
export const CONTENDER_CLAIM_DAYS = 550;

/**
 * How long a claim is held open for an injured contender.
 *
 * Long enough that a serious injury does not cost the shot, short enough that a division is not
 * frozen for a year waiting for one fighter.
 */
export const CONTENDER_INJURY_GRACE_DAYS = 270;

export interface ContenderStatus {
  fighterId: FighterId;
  divisionId: DivisionId;
  source: ContenderSource;
  earnedOn: IsoDate;
  earnedBoutId: BoutId | null;
  /** The claim lapses on this date if it has not been honoured. */
  expiresOn: IsoDate;
  fulfilledOn: IsoDate | null;
  fulfilledBoutId: BoutId | null;
  forfeitedOn: IsoDate | null;
  forfeitReason: string | null;
  /** When the holder became unavailable, so the grace period runs from the injury not the claim. */
  unavailableSince?: IsoDate | null;
  note: string;
}

function store(save: SaveGame): Record<string, ContenderStatus> {
  if (!save.contenders) save.contenders = {};
  return save.contenders;
}

/** Every contender record, including historical ones. */
export function allContenderRecords(save: SaveGame): ContenderStatus[] {
  return Object.values(store(save));
}

/** The standing, unfulfilled, unforfeited contender for a division, if any. */
export function currentContender(save: SaveGame, divisionId: DivisionId): ContenderStatus | null {
  const record = store(save)[divisionId];
  if (!record) return null;
  if (record.fulfilledOn || record.forfeitedOn) return null;
  if (record.expiresOn < save.date) return null;
  const fighter = save.fighters[record.fighterId];
  if (!fighter || fighter.retired || fighter.activityStatus !== 'active') return null;
  if (fighter.divisionId !== divisionId) return null;
  return record;
}

/** The contender status this fighter holds, in any division. */
export function contenderStatusFor(save: SaveGame, fighterId: FighterId): ContenderStatus | null {
  for (const divisionId of Object.keys(store(save))) {
    const record = currentContender(save, divisionId as DivisionId);
    if (record && record.fighterId === fighterId) return record;
  }
  return null;
}

/**
 * Whether the standing contender is ready to take the fight right now.
 *
 * An injured contender keeps the claim rather than losing it, which is the difference between a
 * guarantee and a lottery. The claim only moves on when the grace period runs out.
 */
export function contenderAvailability(
  save: SaveGame,
  divisionId: DivisionId
): { record: ContenderStatus | null; ready: boolean; waitingReason: string | null } {
  const record = currentContender(save, divisionId);
  if (!record) return { record: null, ready: false, waitingReason: null };
  const fighter = save.fighters[record.fighterId];
  if (!fighter) return { record: null, ready: false, waitingReason: null };

  const health = canCompete(fighter, save.date);
  if (!health.ok) {
    // Measured from when they became unavailable, not from when the claim was earned. Running it
    // from the earn date meant a contender who got hurt months later had already used the grace
    // period up and lost the position immediately.
    const unavailableSince = record.unavailableSince ?? save.date;
    if (record.unavailableSince === undefined || record.unavailableSince === null) record.unavailableSince = save.date;
    const waited = daysBetween(unavailableSince, save.date);
    if (waited > CONTENDER_INJURY_GRACE_DAYS) {
      return { record, ready: false, waitingReason: `${fighter.name} has been unavailable too long to keep the claim.` };
    }
    return { record, ready: false, waitingReason: `${fighter.name} is the number one contender but is not cleared: ${health.reason}.` };
  }
  // Cleared again, so the clock resets for any future absence.
  if (record.unavailableSince) record.unavailableSince = null;
  if (fighter.nextBoutId) {
    return { record, ready: false, waitingReason: `${fighter.name} is the number one contender and is already booked.` };
  }
  return { record, ready: true, waitingReason: null };
}

/**
 * Whether the promotion may look past the standing contender.
 *
 * This is the explicit exception list the specification asks for. Skipping the contender for any
 * other reason is not permitted, and callers get a stated reason when it is.
 */
export function mayBypassContender(save: SaveGame, divisionId: DivisionId): { allowed: boolean; reason: string } {
  const { record, ready, waitingReason } = contenderAvailability(save, divisionId);
  if (!record) return { allowed: true, reason: '' };
  if (ready) {
    return { allowed: false, reason: `${save.fighters[record.fighterId]?.name ?? 'The number one contender'} has an earned claim on the next title shot.` };
  }
  const fighter = save.fighters[record.fighterId];
  const waited = daysBetween(record.earnedOn, save.date);
  // Inside the grace period the division waits. Beyond it, the claim gives way.
  if (fighter && !canCompete(fighter, save.date).ok && waited <= CONTENDER_INJURY_GRACE_DAYS) {
    return { allowed: false, reason: waitingReason ?? 'The number one contender is expected back.' };
  }
  return { allowed: true, reason: waitingReason ?? 'The number one contender cannot take the fight.' };
}

export interface GrantResult {
  granted: boolean;
  record: ContenderStatus | null;
  displaced: ContenderStatus | null;
  message: string;
}

/**
 * Grants number one contender status, replacing any previous holder.
 *
 * A newer earned claim supersedes an older one, because the alternative is a queue that never
 * clears. The displaced record is returned so the caller can report it.
 */
export function grantContenderStatus(
  save: SaveGame,
  fighter: Fighter,
  divisionId: DivisionId,
  source: ContenderSource,
  boutId: BoutId | null
): GrantResult {
  if (fighter.retired || fighter.activityStatus !== 'active') {
    return { granted: false, record: null, displaced: null, message: 'That fighter is not on the active roster.' };
  }
  const table = save.rankings[divisionId];
  if (table?.championId === fighter.id) {
    return { granted: false, record: null, displaced: null, message: 'The champion cannot be their own number one contender.' };
  }

  const s = store(save);
  const previous = currentContender(save, divisionId);
  if (previous && previous.fighterId === fighter.id) {
    // Already the contender. Earning it again refreshes the claim rather than duplicating it.
    previous.expiresOn = addDays(save.date, CONTENDER_CLAIM_DAYS);
    previous.source = source;
    previous.earnedOn = save.date;
    return { granted: true, record: previous, displaced: null, message: `${fighter.name} remains the number one contender.` };
  }
  if (previous) {
    previous.forfeitedOn = save.date;
    previous.forfeitReason = `${fighter.name} ${CONTENDER_SOURCE_TEXT[source]} and took over the contender position.`;
  }

  const record: ContenderStatus = {
    fighterId: fighter.id,
    divisionId,
    source,
    earnedOn: save.date,
    earnedBoutId: boutId,
    expiresOn: addDays(save.date, CONTENDER_CLAIM_DAYS),
    fulfilledOn: null,
    fulfilledBoutId: null,
    forfeitedOn: null,
    forfeitReason: null,
    note: `${fighter.name} ${CONTENDER_SOURCE_TEXT[source]}.`,
  };
  s[divisionId] = record;
  return {
    granted: true,
    record,
    displaced: previous,
    message: `${fighter.name} is the number one contender at ${DIVISION_BY_ID[divisionId].name}: they ${CONTENDER_SOURCE_TEXT[source]}.`,
  };
}

/** Marks the claim as honoured. Called when the title bout is actually made. */
export function fulfilContenderStatus(save: SaveGame, divisionId: DivisionId, fighterId: FighterId, boutId: BoutId): boolean {
  const record = currentContender(save, divisionId);
  if (!record || record.fighterId !== fighterId) return false;
  record.fulfilledOn = save.date;
  record.fulfilledBoutId = boutId;
  return true;
}

/**
 * Gives a claim back when the bout that consumed it never happened.
 *
 * A fighter who earned a title shot and then had it cancelled for reasons outside their control
 * has not used it up. Without this the claim was spent on a bout that was cancelled, withdrawn
 * from or replaced, and the fighter had to earn the position all over again.
 */
export function restoreContenderStatus(save: SaveGame, divisionId: DivisionId, boutId: BoutId): ContenderStatus | null {
  const record = store(save)[divisionId];
  if (!record) return null;
  if (record.fulfilledBoutId !== boutId) return null;
  const fighter = save.fighters[record.fighterId];
  if (!fighter || fighter.retired || fighter.activityStatus !== 'active') return null;
  if (fighter.divisionId !== divisionId) return null;
  record.fulfilledOn = null;
  record.fulfilledBoutId = null;
  // The clock is restarted, because the delay was not the fighter's doing.
  record.expiresOn = addDays(save.date, CONTENDER_CLAIM_DAYS);
  return record;
}

/**
 * Ends a claim for a stated reason.
 *
 * `onlyFighterId` guards the common mistake of ending a division's claim when the intent was to
 * end one particular fighter's claim. Without it, a fighter leaving a division would strip the
 * position from whoever else happened to hold it.
 */
export function forfeitContenderStatus(
  save: SaveGame,
  divisionId: DivisionId,
  reason: string,
  onlyFighterId?: FighterId
): ContenderStatus | null {
  const record = currentContender(save, divisionId);
  if (!record) return null;
  if (onlyFighterId && record.fighterId !== onlyFighterId) return null;
  record.forfeitedOn = save.date;
  record.forfeitReason = reason;
  return record;
}

/**
 * Applies a completed bout to contender status.
 *
 * This is the piece that was entirely missing. An eliminator now confers a real claim on the
 * winner, and a contender who loses any fight gives the claim up, which is what stops a queue
 * of stale contenders building up.
 */
export function applyResultToContenders(save: SaveGame, bout: Bout, result: FightResult): string[] {
  const notes: string[] = [];
  const divisionId = bout.divisionId;
  const winner = result.winnerId ? save.fighters[result.winnerId] : null;
  const loserId = result.loserId;

  // A championship bout consumes the claim regardless of who won it.
  if (isChampionshipBout(bout)) {
    const record = currentContender(save, divisionId);
    if (record && (record.fighterId === bout.fighterAId || record.fighterId === bout.fighterBId)) {
      record.fulfilledOn = save.date;
      record.fulfilledBoutId = bout.id;
    }
    return notes;
  }

  // The standing contender losing gives the position up. Winning does not extend it further.
  const standing = currentContender(save, divisionId);
  if (standing && loserId && standing.fighterId === loserId) {
    standing.forfeitedOn = save.date;
    standing.forfeitReason = 'Lost before the title shot could be made.';
    notes.push(`${save.fighters[loserId]?.name ?? 'The number one contender'} has lost the number one contender position.`);
  }

  // Winning an eliminator is what earns the claim.
  const wasEliminator = bout.bookingKind === 'eliminator' || bout.bookingKind === 'title-eliminator';
  // The claim belongs to the division the eliminator was contested in, and only to somebody who
  // actually competes there. A catchweight or cross division bout must not hand the position to a
  // fighter from elsewhere and displace the incumbent.
  if (wasEliminator && winner && !result.isTitleFight && winner.divisionId === divisionId) {
    const grant = grantContenderStatus(save, winner, divisionId, 'eliminator-win', bout.id);
    if (grant.granted) notes.push(grant.message);
  }

  return notes;
}

/**
 * Weekly upkeep.
 *
 * A claim lapses when it expires, when the holder leaves the division, retires or is released,
 * or when an injured holder outlasts the grace period. Every ending is recorded with a reason so
 * the interface can say what happened rather than the status silently disappearing.
 */
export function reviewContenderClaims(save: SaveGame): string[] {
  const notes: string[] = [];
  for (const [divisionId, record] of Object.entries(store(save))) {
    if (record.fulfilledOn || record.forfeitedOn) continue;
    const fighter = save.fighters[record.fighterId];
    const division = DIVISION_BY_ID[divisionId as DivisionId];
    if (!fighter) {
      record.forfeitedOn = save.date;
      record.forfeitReason = 'The fighter is no longer on the roster.';
      continue;
    }
    if (fighter.retired || fighter.activityStatus !== 'active') {
      record.forfeitedOn = save.date;
      record.forfeitReason = `${fighter.name} is no longer active.`;
      notes.push(`${fighter.name} has given up the ${division.name} number one contender position.`);
      continue;
    }
    if (fighter.divisionId !== divisionId) {
      record.forfeitedOn = save.date;
      record.forfeitReason = `${fighter.name} has moved to ${DIVISION_BY_ID[fighter.divisionId].name}.`;
      notes.push(`${fighter.name} has vacated the ${division.name} number one contender position by changing weight.`);
      continue;
    }
    if (record.expiresOn < save.date) {
      record.forfeitedOn = save.date;
      record.forfeitReason = 'The claim went unused for too long.';
      notes.push(`${fighter.name} has lost the ${division.name} number one contender position through inactivity.`);
      continue;
    }
    const clear = canCompete(fighter, save.date).ok;
    if (!clear && !record.unavailableSince) record.unavailableSince = save.date;
    if (clear && record.unavailableSince) record.unavailableSince = null;
    if (!clear && daysBetween(record.unavailableSince ?? save.date, save.date) > CONTENDER_INJURY_GRACE_DAYS) {
      record.forfeitedOn = save.date;
      record.forfeitReason = `${fighter.name} has been unavailable beyond the period the promotion will hold a title shot.`;
      notes.push(`${fighter.name} has lost the ${division.name} number one contender position after a long absence.`);
    }
  }
  return notes;
}

/** A readable line for the interface. */
export function contenderLine(save: SaveGame, divisionId: DivisionId): string | null {
  const { record, ready, waitingReason } = contenderAvailability(save, divisionId);
  if (!record) return null;
  const fighter = save.fighters[record.fighterId];
  if (!fighter) return null;
  if (ready) return `${fighter.name} is the number one contender and is next for the title. They ${CONTENDER_SOURCE_TEXT[record.source]}.`;
  return waitingReason;
}
