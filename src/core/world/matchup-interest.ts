import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { clamp } from '../rng';
import { addDays, daysBetween, type FighterId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';
import { getRelationship, relationshipState } from './relationships';
import { existingTitleBout } from './title-eligibility';

/**
 * Persistent matchmaking interest.
 *
 * A callout used to change a relationship number and nothing else. The matchmaker read a
 * decaying pressure value, and if the two fighters did not happen to be seeded onto the same
 * card in the same week the whole thing evaporated with no explanation. That is what made a
 * successful callout feel fake.
 *
 * A matchup interest is the missing object. It survives in the save, it is re-evaluated every
 * week, it records exactly what is blocking it, and the matchmaker consumes it as a real
 * candidate rather than as a scoring nudge. When it produces a fight, the offer says so.
 */

export type MatchupSource = 'callout' | 'rivalry' | 'division-debut' | 'title-claim' | 'rematch-claim' | 'unification';

export const MATCHUP_SOURCE_LABEL: Record<MatchupSource, string> = {
  callout: 'Successful callout',
  rivalry: 'Rivalry fight',
  'division-debut': 'Divisional debut',
  'title-claim': 'Title eliminator',
  'rematch-claim': 'Rematch claim',
  unification: 'Unification fight',
};

export type MatchupEligibility = 'eligible' | 'blocked' | 'expired' | 'fulfilled' | 'rejected';

export type MatchupBlocker =
  | 'target-booked'
  | 'caller-booked'
  | 'target-injured'
  | 'caller-injured'
  | 'different-divisions'
  | 'target-declined'
  | 'promotion-uninterested'
  | 'title-obligation'
  | 'target-unavailable'
  | 'move-not-completed';

export const MATCHUP_BLOCKER_TEXT: Record<MatchupBlocker, string> = {
  'target-booked': 'They are already booked for another fight. The matchup can be revisited afterwards.',
  'caller-booked': 'You are already booked. This is on hold until that fight is done.',
  'target-injured': 'They are not medically cleared right now.',
  'caller-injured': 'You are not medically cleared right now.',
  'different-divisions': 'You are in different divisions. One of you would have to move.',
  'target-declined': 'They turned the fight down.',
  'promotion-uninterested': 'The promotion does not consider this fight competitive enough to make.',
  'title-obligation': 'A championship obligation in the division takes priority.',
  'target-unavailable': 'They are not available to be matched.',
  'move-not-completed': 'Your weight class move has not been completed yet.',
};

export interface MatchupInterest {
  id: string;
  source: MatchupSource;
  callerId: FighterId;
  targetId: FighterId;
  divisionId: DivisionId;
  createdOn: IsoDate;
  expiresOn: IsoDate;
  /** What the caller asked for, in their own words where one exists. */
  requestedConditions: string;
  /** The target's answer, when there is one. */
  opponentResponse: string | null;
  fanResponse: string | null;
  promotionResponse: string | null;
  /** 0 to 100. Drives matchmaking priority. */
  interestScore: number;
  /** How much this pulls the matchmaker, 0 to 1. */
  priority: number;
  rivalryEffect: number;
  eligibility: MatchupEligibility;
  blockers: MatchupBlocker[];
  /** Set when an offer was generated from this interest. */
  linkedOfferId: string | null;
  linkedBoutId: string | null;
  resolution: string | null;
  /** Set once the player has been told the current state, so they are not told twice. */
  lastReportedState: string | null;
}

function interestStore(save: SaveGame): Record<string, MatchupInterest> {
  if (!save.matchupInterests) save.matchupInterests = {};
  return save.matchupInterests;
}

export function allMatchupInterests(save: SaveGame): MatchupInterest[] {
  return Object.values(interestStore(save));
}

export function matchupInterestsFor(save: SaveGame, fighterId: FighterId): MatchupInterest[] {
  return allMatchupInterests(save)
    .filter((m) => m.callerId === fighterId || m.targetId === fighterId)
    .sort((a, b) => (a.createdOn < b.createdOn ? 1 : -1));
}

/** The live interest between two specific fighters, if any. */
export function liveInterestBetween(save: SaveGame, aId: FighterId, bId: FighterId): MatchupInterest | null {
  for (const m of allMatchupInterests(save)) {
    if (m.eligibility === 'expired' || m.eligibility === 'fulfilled' || m.eligibility === 'rejected') continue;
    const pair = (m.callerId === aId && m.targetId === bId) || (m.callerId === bId && m.targetId === aId);
    if (pair) return m;
  }
  return null;
}

export interface CreateInterestInput {
  source: MatchupSource;
  caller: Fighter;
  target: Fighter;
  requestedConditions: string;
  opponentResponse?: string | null;
  fanResponse?: string | null;
  promotionResponse?: string | null;
  interestScore: number;
  /** Days the interest stays live before it lapses. */
  lifespanDays?: number;
}

/**
 * Records a matchmaking interest, or refreshes the one that already exists.
 *
 * Two callouts at the same target do not create two records. The second one raises the
 * interest and pushes the expiry out, which is what repeating yourself actually achieves.
 */
export function recordMatchupInterest(save: SaveGame, input: CreateInterestInput): MatchupInterest {
  const existing = liveInterestBetween(save, input.caller.id, input.target.id);
  const lifespan = input.lifespanDays ?? 150;
  if (existing) {
    existing.interestScore = clamp(Math.max(existing.interestScore, input.interestScore) + 5, 0, 100);
    existing.expiresOn = addDays(save.date, lifespan);
    if (input.opponentResponse) existing.opponentResponse = input.opponentResponse;
    if (input.fanResponse) existing.fanResponse = input.fanResponse;
    if (input.promotionResponse) existing.promotionResponse = input.promotionResponse;
    evaluateInterest(save, existing);
    return existing;
  }

  const rel = getRelationship(save, input.caller.id, input.target.id);
  const id = `matchup-${input.caller.id}-${input.target.id}-${save.date}`;
  const interest: MatchupInterest = {
    id,
    source: input.source,
    callerId: input.caller.id,
    targetId: input.target.id,
    divisionId: input.target.divisionId,
    createdOn: save.date,
    expiresOn: addDays(save.date, lifespan),
    requestedConditions: input.requestedConditions,
    opponentResponse: input.opponentResponse ?? null,
    fanResponse: input.fanResponse ?? null,
    promotionResponse: input.promotionResponse ?? null,
    interestScore: clamp(input.interestScore, 0, 100),
    priority: 0,
    rivalryEffect: rel?.rivalry ?? 0,
    eligibility: 'eligible',
    blockers: [],
    linkedOfferId: null,
    linkedBoutId: null,
    resolution: null,
    lastReportedState: null,
  };
  interestStore(save)[id] = interest;
  evaluateInterest(save, interest);
  return interest;
}

/**
 * Re-evaluates one interest against the world as it stands today.
 *
 * This is the heart of the fix. A blocked matchup is not deleted, it is marked blocked with
 * the reason, and when the blocker clears it becomes eligible again on the next pass.
 */
export function evaluateInterest(save: SaveGame, interest: MatchupInterest): MatchupInterest {
  if (interest.eligibility === 'fulfilled' || interest.eligibility === 'rejected') return interest;

  const caller = save.fighters[interest.callerId];
  const target = save.fighters[interest.targetId];
  if (!caller || !target) {
    interest.eligibility = 'expired';
    interest.resolution = 'One of the fighters is no longer on the roster.';
    return interest;
  }

  if (interest.expiresOn < save.date) {
    interest.eligibility = 'expired';
    interest.resolution = interest.resolution ?? 'The moment passed and the promotion moved on.';
    return interest;
  }

  const blockers: MatchupBlocker[] = [];
  if (target.retired || target.activityStatus !== 'active') blockers.push('target-unavailable');
  if (!canCompete(target, save.date).ok) blockers.push('target-injured');
  if (!canCompete(caller, save.date).ok) blockers.push('caller-injured');
  if (target.nextBoutId) blockers.push('target-booked');
  if (caller.nextBoutId) blockers.push('caller-booked');
  if (caller.divisionId !== target.divisionId) blockers.push('different-divisions');

  // A championship bout already scheduled in the division outranks an ordinary matchup
  // between two fighters who are not in it.
  const titleBout = existingTitleBout(save, target.divisionId);
  if (titleBout && (titleBout.fighterAId === target.id || titleBout.fighterBId === target.id)) {
    blockers.push('title-obligation');
  }

  if (interest.opponentResponse === 'declined') blockers.push('target-declined');
  if (interest.interestScore < 18) blockers.push('promotion-uninterested');

  interest.blockers = blockers;
  interest.divisionId = target.divisionId;
  interest.rivalryEffect = getRelationship(save, caller.id, target.id)?.rivalry ?? interest.rivalryEffect;
  interest.eligibility = blockers.length === 0 ? 'eligible' : 'blocked';

  // Priority. An eligible interest with a strong response is close to a booking instruction;
  // a blocked one contributes nothing until it clears.
  const accepted = interest.opponentResponse === 'accepted';
  const base = interest.interestScore / 100;
  const rivalryBoost = clamp(interest.rivalryEffect / 200, 0, 0.4);
  interest.priority = interest.eligibility === 'eligible' ? clamp(base * 0.6 + (accepted ? 0.35 : 0.1) + rivalryBoost, 0, 1) : 0;

  return interest;
}

/** Re-evaluates every live interest. Called once per weekly pass. */
export function evaluateAllInterests(save: SaveGame): { eligible: number; blocked: number; expired: number } {
  let eligible = 0;
  let blocked = 0;
  let expired = 0;
  for (const interest of allMatchupInterests(save)) {
    evaluateInterest(save, interest);
    if (interest.eligibility === 'eligible') eligible++;
    else if (interest.eligibility === 'blocked') blocked++;
    else if (interest.eligibility === 'expired') expired++;
  }
  return { eligible, blocked, expired };
}

/** Marks an interest as having produced a fight. */
export function fulfilInterest(interest: MatchupInterest, offerId: string | null, boutId: string | null): void {
  interest.eligibility = 'fulfilled';
  interest.linkedOfferId = offerId;
  interest.linkedBoutId = boutId;
  interest.resolution = 'The fight was made.';
}

/** The reason line an offer carries when it came from an interest. */
export function interestReason(save: SaveGame, interest: MatchupInterest): string {
  const target = save.fighters[interest.targetId];
  const name = target?.name ?? 'the opponent';
  switch (interest.source) {
    case 'callout':
      return `Successful callout. You called out ${name} and the promotion has made the fight.`;
    case 'rivalry':
      return `Rivalry fight. The history between you and ${name} sells itself.`;
    case 'division-debut':
      return `Divisional debut at ${DIVISION_BY_ID[interest.divisionId].name} against ${name}.`;
    case 'title-claim':
      return `Title eliminator against ${name}.`;
    case 'rematch-claim':
      return `Rematch against ${name}.`;
    case 'unification':
      return `Unification fight against ${name}.`;
  }
}

/**
 * How much this pairing should pull the matchmaker, 0 to 1.
 *
 * Replaces the old callout only pressure. Rivalry now contributes on its own, so two fighters
 * with genuine history are matched even when neither of them said anything publicly.
 */
export function matchupPull(save: SaveGame, aId: FighterId, bId: FighterId): { pull: number; interest: MatchupInterest | null } {
  const interest = liveInterestBetween(save, aId, bId);
  let pull = interest && interest.eligibility === 'eligible' ? interest.priority : 0;

  const rel = getRelationship(save, aId, bId);
  if (rel) {
    const state = relationshipState(rel);
    if (state === 'enemy' || state === 'bitter-rival') pull = Math.max(pull, 0.7);
    else if (state === 'heated-rival') pull = Math.max(pull, 0.5);
    else if (state === 'professional-rival') pull = Math.max(pull, 0.25);
    // Two fighters who genuinely will not fight each other are pushed apart, not pulled.
    if (state === 'training-partner') pull = -1;
    else if (state === 'close-friend') pull = Math.min(pull, -0.5);
  }
  return { pull: clamp(pull, -1, 1), interest };
}

/** Drops interests that have been resolved long enough to be history. */
export function pruneMatchupInterests(save: SaveGame, keepDays = 500): number {
  const s = interestStore(save);
  let removed = 0;
  for (const id of Object.keys(s)) {
    const m = s[id];
    if (daysBetween(m.createdOn, save.date) > keepDays) {
      delete s[id];
      removed++;
    }
  }
  return removed;
}

/**
 * A short sentence describing where an interest currently stands.
 *
 * Used by the interface and by the weekly update message so the player is never left with a
 * callout that simply vanished.
 */
export function interestStatusLine(save: SaveGame, interest: MatchupInterest): string {
  const target = save.fighters[interest.targetId];
  const name = target?.name ?? 'them';
  switch (interest.eligibility) {
    case 'eligible':
      return interest.priority > 0.55
        ? `The promotion is working on ${name} next. Expect an offer.`
        : `Live with the matchmaker. ${name} is on the list but not agreed.`;
    case 'blocked':
      return interest.blockers.map((b) => MATCHUP_BLOCKER_TEXT[b]).join(' ');
    case 'fulfilled':
      return interest.resolution ?? 'The fight was made.';
    case 'rejected':
      return interest.resolution ?? `${name} is not taking the fight.`;
    case 'expired':
      return interest.resolution ?? 'The moment passed.';
  }
}
