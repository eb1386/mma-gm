import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { MATCHMAKING as M } from '../config/matchmaking';
import { clamp } from '../rng';
import { addDays, daysBetween, type FighterId, type IsoDate } from '../types/common';
import type { FightResult } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';
import { getRelationship, relationshipState } from './relationships';
import { existingTitleBout, titleShotEligibility, type TitleBlocker } from './title-eligibility';
import { fightCloseness } from './title-logic';
import { meetingsBetween } from './indexes';

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
  | 'move-not-completed'
  | 'not-earned'
  | 'rematch-not-earned';

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
  'not-earned': 'The promotion will not make this fight yet. The step up has not been earned on results.',
  'rematch-not-earned': 'The last meeting was not close enough to run back this soon.',
};

/**
 * The blocker text read from the target's side.
 *
 * The caller and target blockers are named for the two sides of the record, and the plain text is
 * written for the caller. When an opponent called the player out the player is the target, and
 * reading the caller text told them "You are already booked" about the fighter who was.
 */
const TARGET_VIEW_BLOCKER_TEXT: Partial<Record<MatchupBlocker, string>> = {
  'target-booked': MATCHUP_BLOCKER_TEXT['caller-booked'],
  'caller-booked': MATCHUP_BLOCKER_TEXT['target-booked'],
  'target-injured': MATCHUP_BLOCKER_TEXT['caller-injured'],
  'caller-injured': MATCHUP_BLOCKER_TEXT['target-injured'],
  'target-declined': 'You turned the fight down.',
  'target-unavailable': 'You are not available to be matched.',
  'move-not-completed': 'Their weight class move has not been completed yet.',
};

/** The blocker's text for whoever is reading it. */
export function blockerText(interest: MatchupInterest, blocker: MatchupBlocker, viewerId: FighterId | null): string {
  if (viewerId !== null && viewerId === interest.targetId) return TARGET_VIEW_BLOCKER_TEXT[blocker] ?? MATCHUP_BLOCKER_TEXT[blocker];
  return MATCHUP_BLOCKER_TEXT[blocker];
}

/** The side of the interest that is not the viewer. With no viewer on either side, the target. */
export function otherSide(interest: MatchupInterest, viewerId: FighterId | null): FighterId {
  return viewerId === interest.targetId ? interest.callerId : interest.targetId;
}

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
    // An expired matchup is finished. Keeping the old blockers left it reading as on hold.
    interest.blockers = [];
    interest.priority = 0;
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
  if (interest.source === 'callout' || interest.source === 'rivalry') {
    const gate = unearnedBlocker(save, caller, target);
    if (gate) blockers.push(gate);
  }

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

/** Title eligibility blockers that are about standing rather than circumstance. */
const STANDING_TITLE_BLOCKERS: readonly TitleBlocker[] = ['unranked-without-claim', 'coming-off-loss', 'contender-ahead'];

/**
 * Whether the promotion would refuse this pairing on merit, whatever was said in public.
 *
 * A callout or a feud is a reason to make a fight that is close to earned, not a way around every
 * rule the matchmaker applies to an ordinary card. Without this an unranked fighter at nought and
 * two who accepted a callout was handed the number three, then the champion in a non title three
 * rounder, then a rematch of a lopsided loss. The rules mirror the card gates in scoreCandidate.
 */
export function unearnedBlocker(save: SaveGame, caller: Fighter, target: Fighter): MatchupBlocker | null {
  if (caller.divisionId !== target.divisionId) return null;
  const table = save.rankings[target.divisionId];
  if (!table) return null;
  const rankOf = (f: Fighter): number | null => (table.championId === f.id ? 0 : f.ranking);

  // A fight with the champion is a title fight, and only somebody eligible for one gets it.
  const champion = table.championId === caller.id ? caller : table.championId === target.id ? target : null;
  if (champion) {
    const challenger = champion === caller ? target : caller;
    const eligibility = titleShotEligibility(save, challenger, target.divisionId, {
      vacant: false,
      ignoreBoutId: challenger.nextBoutId,
    });
    if (eligibility.blockers.some((b) => STANDING_TITLE_BLOCKERS.includes(b))) return 'not-earned';
  } else {
    const rankC = rankOf(caller);
    const rankT = rankOf(target);
    if (rankC !== null && rankT !== null) {
      if (Math.abs(rankC - rankT) > M.gate.interestMaxRankGap) return 'not-earned';
    } else if (rankC !== null || rankT !== null) {
      const unranked = rankC === null ? caller : target;
      const rankedAt = (rankC ?? rankT)!;
      const losing = unranked.ufcRecord.losses > unranked.ufcRecord.wins;
      const needed = rankedAt <= M.gate.contenderRank ? M.gate.prospectStreakForTopFive : M.gate.prospectStreakForRanked;
      if (losing || unranked.winStreak < needed) return 'not-earned';
    }
  }

  // The same rematch rule as an ordinary card: inside the cooldown, only a close fight is run back.
  let last: FightResult | null = null;
  for (const r of meetingsBetween(save, caller.id, target.id)) {
    if (!last || r.date > last.date) last = r;
  }
  if (last && daysBetween(last.date, save.date) < M.rematch.cooldownDays && fightCloseness(last).value < M.rematch.closenessRequired) {
    return 'rematch-not-earned';
  }
  return null;
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

/**
 * The reason line an offer or a bout carries when it came from an interest.
 *
 * Written for the viewer, the fighter the line is shown to. Either side can be the viewer: an
 * opponent calling the player out records the player as the target, and naming the target
 * unconditionally told the player "You called out" themselves. When the viewer is not the player
 * (a bout between two other fighters) the line is in the third person, because "you" there means
 * nobody.
 */
export function interestReason(save: SaveGame, interest: MatchupInterest, viewerId: FighterId | null): string {
  const division = DIVISION_BY_ID[interest.divisionId].name;
  const callerName = save.fighters[interest.callerId]?.name ?? 'the caller';
  const targetName = save.fighters[interest.targetId]?.name ?? 'the opponent';
  const isSide = viewerId !== null && (viewerId === interest.callerId || viewerId === interest.targetId);
  const secondPerson = isSide && viewerId === save.player.fighterId;
  if (!secondPerson) {
    switch (interest.source) {
      case 'callout':
        return `Successful callout. ${callerName} called out ${targetName} and the promotion has made the fight.`;
      case 'rivalry':
        return `Rivalry fight. The history between ${callerName} and ${targetName} sells itself.`;
      case 'division-debut':
        return `Divisional debut for ${callerName} at ${division} against ${targetName}.`;
      case 'title-claim':
        return `Title eliminator between ${callerName} and ${targetName}.`;
      case 'rematch-claim':
        return `Rematch between ${callerName} and ${targetName}.`;
      case 'unification':
        return `Unification fight between ${callerName} and ${targetName}.`;
    }
  }
  const viewerIsCaller = viewerId === interest.callerId;
  const name = viewerIsCaller ? targetName : callerName;
  switch (interest.source) {
    case 'callout':
      if (viewerIsCaller) return `Successful callout. You called out ${name} and the promotion has made the fight.`;
      return interest.opponentResponse === 'accepted'
        ? `${name} called you out, you accepted, and the promotion has made the fight.`
        : `${name} called you out and the promotion has made the fight.`;
    case 'rivalry':
      return `Rivalry fight. The history between you and ${name} sells itself.`;
    case 'division-debut':
      return viewerIsCaller
        ? `Divisional debut at ${division} against ${name}.`
        : `${name} makes a ${division} debut against you.`;
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
export function interestStatusLine(save: SaveGame, interest: MatchupInterest, viewerId: FighterId | null): string {
  // The name is the other side from the viewer's seat, never the viewer themselves.
  const name = save.fighters[otherSide(interest, viewerId)]?.name ?? 'them';
  switch (interest.eligibility) {
    case 'eligible':
      return interest.priority > 0.55
        ? `The promotion is working on ${name} next. Expect an offer.`
        : `Live with the matchmaker. ${name} is on the list but not agreed.`;
    case 'blocked':
      return interest.blockers.map((b) => blockerText(interest, b, viewerId)).join(' ');
    case 'fulfilled':
      return interest.resolution ?? 'The fight was made.';
    case 'rejected':
      return interest.resolution ?? (viewerId === interest.targetId ? 'You turned the fight down.' : `${name} is not taking the fight.`);
    case 'expired':
      return interest.resolution ?? 'The moment passed.';
  }
}
