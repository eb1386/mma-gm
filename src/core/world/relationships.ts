import { clamp, Rng } from '../rng';
import { addDays, daysBetween, type FighterId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { liveInterestBetween, recordMatchupInterest } from './matchup-interest';
import { escalateRivalry } from './hype';

/**
 * Relationships between fighters.
 *
 * Rivalry already existed as a single intensity number. This adds the other half: respect,
 * friendship, trust and hostility, so two fighters can be close friends, respectful
 * opponents, or people who genuinely dislike each other, and the state is derived from the
 * tracked values rather than being a label that can drift away from them.
 */

export interface Relationship {
  aId: FighterId;
  bId: FighterId;
  /** Regard for the other fighter as a fighter. 0 to 100. */
  respect: number;
  /** Personal warmth. 0 to 100. */
  friendship: number;
  /** How well they know each other. Rises with every interaction. 0 to 100. */
  familiarity: number;
  /** Competitive edge. 0 to 100. */
  rivalry: number;
  /** Personal grievance. 0 to 100. */
  resentment: number;
  trust: number;
  /** Hostility expressed in public, which drives hype. */
  publicHostility: number;
  /** Hostility they actually feel, which drives behaviour. */
  privateHostility: number;
  teammateBond: number;
  mentorBond: number;
  startedOn: IsoDate;
  lastEventOn: IsoDate;
  history: { date: IsoDate; note: string; kind: RelationshipEventKind }[];
  /** Fights between them, oldest first. */
  fights: { boutId: string; date: IsoDate; winnerId: FighterId | null }[];
}

export type RelationshipEventKind =
  | 'social-friendly'
  | 'social-hostile'
  | 'callout'
  | 'insult'
  | 'compliment'
  | 'fight'
  | 'press'
  | 'faceoff'
  | 'training'
  | 'support'
  | 'betrayal'
  | 'teammate'
  | 'mentorship';

export type RelationshipState =
  | 'stranger'
  | 'acquaintance'
  | 'friendly'
  | 'friend'
  | 'close-friend'
  | 'training-partner'
  | 'former-teammate'
  | 'respected-opponent'
  | 'professional-rival'
  | 'heated-rival'
  | 'bitter-rival'
  | 'enemy';

export const RELATIONSHIP_LABEL: Record<RelationshipState, string> = {
  stranger: 'Stranger',
  acquaintance: 'Acquaintance',
  friendly: 'Friendly',
  friend: 'Friend',
  'close-friend': 'Close friend',
  'training-partner': 'Training partner',
  'former-teammate': 'Former teammate',
  'respected-opponent': 'Respected opponent',
  'professional-rival': 'Professional rival',
  'heated-rival': 'Heated rival',
  'bitter-rival': 'Bitter rival',
  enemy: 'Enemy',
};

function key(aId: FighterId, bId: FighterId): string {
  return [aId, bId].sort().join('|');
}

function store(save: SaveGame): Record<string, Relationship> {
  if (!save.relationships) save.relationships = {};
  return save.relationships;
}

export function getRelationship(save: SaveGame, aId: FighterId, bId: FighterId): Relationship | null {
  return store(save)[key(aId, bId)] ?? null;
}

export function ensureRelationship(save: SaveGame, aId: FighterId, bId: FighterId): Relationship {
  const s = store(save);
  const k = key(aId, bId);
  if (!s[k]) {
    const a = save.fighters[aId];
    const b = save.fighters[bId];
    const teammates = Boolean(a?.gymId && a.gymId === b?.gymId);
    s[k] = {
      aId: [aId, bId].sort()[0],
      bId: [aId, bId].sort()[1],
      respect: 50,
      friendship: teammates ? 55 : 20,
      familiarity: teammates ? 60 : 5,
      rivalry: 0,
      resentment: 0,
      trust: teammates ? 60 : 40,
      publicHostility: 0,
      privateHostility: 0,
      teammateBond: teammates ? 60 : 0,
      mentorBond: 0,
      startedOn: save.date,
      lastEventOn: save.date,
      history: [],
      fights: [],
    };
  }
  return s[k];
}

/**
 * The state, derived from the tracked values.
 *
 * Nothing stores a label. Two fighters who have fought three times and respect each other
 * come out as respected opponents even though nobody ever set that.
 */
export function relationshipState(r: Relationship | null): RelationshipState {
  if (!r) return 'stranger';
  if (r.teammateBond > 55) return 'training-partner';
  if (r.teammateBond > 15 && r.friendship > 35) return 'former-teammate';
  const hostility = Math.max(r.publicHostility, r.privateHostility);
  if (hostility > 75 && r.resentment > 60) return 'enemy';
  if (r.rivalry > 70 && r.resentment > 45) return 'bitter-rival';
  if (r.rivalry > 45 && hostility > 35) return 'heated-rival';
  if (r.rivalry > 30 && r.respect > 55) return 'respected-opponent';
  if (r.rivalry > 25) return 'professional-rival';
  if (r.friendship > 75) return 'close-friend';
  if (r.friendship > 55) return 'friend';
  if (r.friendship > 35) return 'friendly';
  if (r.familiarity > 15) return 'acquaintance';
  return 'stranger';
}

export interface RelationshipDelta {
  respect?: number;
  friendship?: number;
  familiarity?: number;
  rivalry?: number;
  resentment?: number;
  trust?: number;
  publicHostility?: number;
  privateHostility?: number;
  teammateBond?: number;
  mentorBond?: number;
}

/** Applies a change and records why. Every value is clamped to 0 to 100. */
export function applyRelationship(
  save: SaveGame,
  aId: FighterId,
  bId: FighterId,
  delta: RelationshipDelta,
  kind: RelationshipEventKind,
  note: string
): Relationship {
  const r = ensureRelationship(save, aId, bId);
  const before = relationshipState(r);
  for (const [field, value] of Object.entries(delta)) {
    const k = field as keyof RelationshipDelta;
    const current = r[k] as number;
    (r[k] as number) = clamp(current + (value ?? 0), 0, 100);
  }
  // Any interaction at all makes them better known to each other.
  r.familiarity = clamp(r.familiarity + 2, 0, 100);
  r.lastEventOn = save.date;
  r.history.push({ date: save.date, note, kind });
  if (r.history.length > 40) r.history.splice(0, r.history.length - 40);

  const after = relationshipState(r);
  if (after !== before) {
    r.history.push({ date: save.date, note: `The relationship is now ${RELATIONSHIP_LABEL[after].toLowerCase()}.`, kind });
  }
  return r;
}

/** Records a completed fight between two fighters and its relational effect. */
export function recordFightBetween(save: SaveGame, aId: FighterId, bId: FighterId, boutId: string, winnerId: FighterId | null, wasWar: boolean): void {
  const r = ensureRelationship(save, aId, bId);
  r.fights.push({ boutId, date: save.date, winnerId });
  // A hard, competitive fight usually raises respect on both sides.
  applyRelationship(
    save,
    aId,
    bId,
    wasWar
      ? { respect: 14, rivalry: 8, familiarity: 20, privateHostility: -6 }
      : { respect: 6, rivalry: 5, familiarity: 15 },
    'fight',
    wasWar ? 'A hard fight that both of them will remember.' : 'They shared the cage.'
  );
}

/** Fighters this fighter would rather not face, and how strongly. */
export function reluctantOpponents(save: SaveGame, fighterId: FighterId): { opponentId: FighterId; reason: string; strength: number }[] {
  const out: { opponentId: FighterId; reason: string; strength: number }[] = [];
  for (const r of Object.values(store(save))) {
    if (r.aId !== fighterId && r.bId !== fighterId) continue;
    const otherId = r.aId === fighterId ? r.bId : r.aId;
    const state = relationshipState(r);
    if (state === 'training-partner') out.push({ opponentId: otherId, reason: 'Current training partner.', strength: 0.95 });
    else if (state === 'close-friend') out.push({ opponentId: otherId, reason: 'A close friend outside the cage.', strength: 0.75 });
    else if (state === 'friend') out.push({ opponentId: otherId, reason: 'A friend.', strength: 0.45 });
    else if (state === 'former-teammate') out.push({ opponentId: otherId, reason: 'A former teammate.', strength: 0.3 });
  }
  return out;
}

/** Fighters who want this fight badly, which the matchmaker weighs. */
export function eagerOpponents(save: SaveGame, fighterId: FighterId): { opponentId: FighterId; reason: string; strength: number }[] {
  const out: { opponentId: FighterId; reason: string; strength: number }[] = [];
  for (const r of Object.values(store(save))) {
    if (r.aId !== fighterId && r.bId !== fighterId) continue;
    const otherId = r.aId === fighterId ? r.bId : r.aId;
    const state = relationshipState(r);
    if (state === 'bitter-rival' || state === 'enemy') out.push({ opponentId: otherId, reason: 'Bad blood that wants settling.', strength: 0.9 });
    else if (state === 'heated-rival') out.push({ opponentId: otherId, reason: 'A heated rivalry.', strength: 0.7 });
    else if (state === 'respected-opponent' && r.fights.length > 0) out.push({ opponentId: otherId, reason: 'Unfinished business.', strength: 0.5 });
  }
  return out;
}

/** All relationships involving a fighter, most recently active first. */
export function relationshipsFor(save: SaveGame, fighterId: FighterId): { other: Fighter; relationship: Relationship; state: RelationshipState }[] {
  const out: { other: Fighter; relationship: Relationship; state: RelationshipState }[] = [];
  for (const r of Object.values(store(save))) {
    if (r.aId !== fighterId && r.bId !== fighterId) continue;
    const otherId = r.aId === fighterId ? r.bId : r.aId;
    const other = save.fighters[otherId];
    if (!other) continue;
    out.push({ other, relationship: r, state: relationshipState(r) });
  }
  return out.sort((x, y) => (x.relationship.lastEventOn < y.relationship.lastEventOn ? 1 : -1));
}

/** Relationships drift toward neutral when nothing happens for a long time. */
export function decayRelationships(save: SaveGame): number {
  let touched = 0;
  for (const r of Object.values(store(save))) {
    const idle = daysBetween(r.lastEventOn, save.date);
    if (idle < 120) continue;
    const step = Math.min(4, Math.floor(idle / 120));
    r.rivalry = clamp(r.rivalry - step, 0, 100);
    r.publicHostility = clamp(r.publicHostility - step, 0, 100);
    r.privateHostility = clamp(r.privateHostility - step * 0.6, 0, 100);
    r.resentment = clamp(r.resentment - step * 0.5, 0, 100);
    r.lastEventOn = save.date;
    touched++;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

export type CalloutTone = 'respectful' | 'confident' | 'aggressive' | 'personal' | 'promotional';

export const CALLOUT_TONE_LABEL: Record<CalloutTone, string> = {
  respectful: 'Respectful',
  confident: 'Confident',
  aggressive: 'Aggressive',
  personal: 'Personal',
  promotional: 'Promotional',
};

export type CalloutResponse =
  | 'accept'
  | 'reject'
  | 'counter-callout'
  | 'insult'
  | 'respectful-answer'
  | 'silence'
  | 'future-promise';

export interface Callout {
  id: string;
  fromId: FighterId;
  toId: FighterId;
  tone: CalloutTone;
  text: string;
  madeOn: IsoDate;
  expiresOn: IsoDate;
  status: 'open' | 'answered' | 'expired';
  response: CalloutResponse | null;
  responseText: string | null;
  /** The promotion's view, which is what actually decides whether a fight gets made. */
  promotionInterest: number;
  /** Whether an offer resulted. A callout never books a fight by itself. */
  ledToOffer: boolean;
  /** How the fans took it, which the promotion weighs alongside the answer. */
  fanResponse: 'favourable' | 'mixed' | 'unfavourable' | null;
  /**
   * The persistent matchmaking record this callout produced, when it produced one.
   * Follow this to find out what actually happened to the fight.
   */
  matchupInterestId: string | null;
  note: string;
}

export interface CalloutAssessment {
  targetName: string;
  divisionName: string;
  ranking: string;
  available: boolean;
  availabilityNote: string;
  rankingGap: number;
  acceptanceChance: number;
  promotionInterest: number;
  expectedHype: number;
  relationship: RelationshipState;
  reasons: string[];
  warnings: string[];
}

/**
 * What the player is told before they commit to a callout.
 *
 * The honest version: most callouts do not produce a fight, and the reasons are visible.
 */
export function assessCallout(save: SaveGame, fromId: FighterId, toId: FighterId, blockReason: string | null): CalloutAssessment {
  const from = save.fighters[fromId];
  const to = save.fighters[toId];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const rel = getRelationship(save, fromId, toId);
  const state = relationshipState(rel);

  const fromRank = from.isChampion ? 0 : (from.ranking ?? 99);
  const toRank = to.isChampion ? 0 : (to.ranking ?? 99);
  const gap = fromRank - toRank;

  let acceptance = 0.4;
  if (gap > 0) {
    acceptance -= Math.min(0.3, gap * 0.03);
    warnings.push(`${to.name} is ranked above you. Calling up is a harder sell.`);
  } else {
    acceptance += Math.min(0.25, -gap * 0.02);
    reasons.push('You are the higher ranked fighter, which makes this an easy fight for them to accept.');
  }
  if (state === 'bitter-rival' || state === 'heated-rival' || state === 'enemy') {
    acceptance += 0.3;
    reasons.push('There is already bad blood. They want this.');
  }
  if (state === 'training-partner' || state === 'close-friend') {
    acceptance -= 0.5;
    warnings.push('You are close. They are unlikely to take this and it will cost you the relationship.');
  }
  if (to.divisionId !== from.divisionId) {
    acceptance -= 0.25;
    warnings.push('A different division. Somebody would have to move.');
  }
  if (blockReason) {
    acceptance -= 0.3;
    warnings.push(`${to.name} is not available: ${blockReason}`);
  }

  const hype = clamp((from.popularity + to.popularity) / 2 + (rel?.rivalry ?? 0) * 0.4, 0, 100);
  const promotionInterest = clamp(
    hype * 0.6 + (to.divisionId === from.divisionId ? 20 : 0) + (toRank < 6 && fromRank < 6 ? 20 : 0) - Math.abs(gap) * 1.5,
    0,
    100
  );
  if (promotionInterest < 25) warnings.push('The promotion has shown little interest in this matchup.');
  else if (promotionInterest > 60) reasons.push('The promotion would like to make this fight.');

  return {
    targetName: to.name,
    divisionName: to.divisionId,
    ranking: to.isChampion ? 'Champion' : to.ranking !== null ? `Ranked ${to.ranking}` : 'Unranked',
    available: !blockReason,
    availabilityNote: blockReason ?? 'Available to be matched.',
    rankingGap: gap,
    acceptanceChance: clamp(acceptance, 0.02, 0.95),
    promotionInterest,
    expectedHype: hype,
    relationship: state,
    reasons,
    warnings,
  };
}

const CALLOUT_TEXT: Record<CalloutTone, string[]> = {
  respectful: ['{to}, you have earned every bit of your position. I want that fight next.', 'Nothing but respect, {to}. Let us find out.'],
  confident: ['{to}. Name the date. I will be there.', 'I have watched enough of {to}. That is a fight I win.'],
  aggressive: ['{to} has been avoiding this. Sign it or say why not.', 'I want {to} and I want him hurt.'],
  personal: ['{to} knows exactly what he said. He can say it to my face on fight night.', 'This one is personal with {to}. Everyone knows why.'],
  promotional: ['{to} against me sells itself. Make the fight.', 'Give the fans {to} and me. Nobody else in this division comes close.'],
};

const TONE_EFFECT: Record<CalloutTone, RelationshipDelta> = {
  respectful: { respect: 8, rivalry: 6, publicHostility: 2 },
  confident: { rivalry: 10, publicHostility: 5, respect: 2 },
  aggressive: { rivalry: 18, publicHostility: 16, resentment: 8, respect: -4 },
  personal: { rivalry: 22, publicHostility: 20, resentment: 18, privateHostility: 15, respect: -8, friendship: -15 },
  promotional: { rivalry: 8, publicHostility: 4 },
};

function calloutStore(save: SaveGame): Record<string, Callout> {
  if (!save.callouts) save.callouts = {};
  return save.callouts;
}

/** Makes a callout. It never books a fight; it changes the relationship and the pressure. */
export function makeCallout(save: SaveGame, fromId: FighterId, toId: FighterId, tone: CalloutTone, rng: Rng): Callout | null {
  const from = save.fighters[fromId];
  const to = save.fighters[toId];
  if (!from || !to || fromId === toId) return null;
  const s = calloutStore(save);
  const id = `callout-${fromId}-${toId}-${save.date}`;
  if (s[id]) return s[id];

  const text = rng.pick(CALLOUT_TEXT[tone]).replace(/\{to\}/g, to.name);
  const assessment = assessCallout(save, fromId, toId, null);
  const callout: Callout = {
    id,
    fromId,
    toId,
    tone,
    text,
    madeOn: save.date,
    expiresOn: addDays(save.date, 21),
    status: 'open',
    response: null,
    responseText: null,
    promotionInterest: assessment.promotionInterest,
    ledToOffer: false,
    fanResponse: null,
    matchupInterestId: null,
    note: 'The matchmaker still decides whether this fight gets made.',
  };
  s[id] = callout;
  applyRelationship(save, fromId, toId, TONE_EFFECT[tone], 'callout', `${from.name} called out ${to.name}.`);
  return callout;
}

/** The target answers. Personality and the relationship both matter. */
export function resolveCallout(save: SaveGame, calloutId: string, rng: Rng): Callout | null {
  const callout = calloutStore(save)[calloutId];
  if (!callout || callout.status !== 'open') return callout ?? null;
  const from = save.fighters[callout.fromId];
  const to = save.fighters[callout.toId];
  if (!from || !to) return callout;

  const assessment = assessCallout(save, callout.fromId, callout.toId, null);
  const ego = to.personality?.ego ?? 0.5;
  const temper = to.personality?.temper ?? 0.5;

  let response: CalloutResponse;
  if (rng.chance(assessment.acceptanceChance)) {
    response = 'accept';
  } else if (callout.tone === 'personal' || callout.tone === 'aggressive') {
    response = temper > 0.6 ? 'insult' : rng.chance(0.4) ? 'counter-callout' : 'reject';
  } else if (ego > 0.65) {
    response = rng.chance(0.5) ? 'counter-callout' : 'reject';
  } else if (rng.chance(0.3)) {
    response = 'silence';
  } else if (rng.chance(0.5)) {
    response = 'respectful-answer';
  } else {
    response = 'future-promise';
  }

  applyCalloutResponse(save, callout, response, to.name, from.name);
  return callout;
}

/**
 * Everything that follows from a callout being answered: the fan reaction, the persistent record
 * the matchmaker reads for months, and the relationship movement.
 *
 * One function, because there are two answerers. An NPC answering runs through `resolveCallout`
 * above. The player answering used to run through the inbox handler, which set the response label
 * and returned a sentence and did nothing else at all, so accepting a callout aimed at the player
 * had no consequence of any kind: no rivalry, no relationship change, and above all no matchup
 * interest, which is the record that actually makes the fight happen.
 */
export function applyCalloutResponse(
  save: SaveGame,
  callout: Callout,
  response: CalloutResponse,
  toName: string,
  fromName: string
): void {
  const from = save.fighters[callout.fromId];
  const to = save.fighters[callout.toId];
  if (!from || !to) return;
  const assessment = assessCallout(save, callout.fromId, callout.toId, null);

  callout.response = response;
  callout.status = 'answered';
  callout.responseText = callout.responseText ?? responseTextFor(response, toName, fromName);

  // The fans have a view, and it is part of whether the promotion makes the fight.
  const fanFavour = clamp(
    (from.popularity + to.popularity) / 2 +
      (callout.tone === 'personal' ? 12 : callout.tone === 'aggressive' ? 8 : callout.tone === 'promotional' ? 6 : 0) +
      (response === 'accept' ? 15 : response === 'insult' || response === 'counter-callout' ? 12 : response === 'silence' ? -12 : 0),
    0,
    100
  );
  callout.fanResponse = fanFavour >= 55 ? 'favourable' : fanFavour >= 32 ? 'mixed' : 'unfavourable';

  // This is the part that used to be missing. A callout now leaves a persistent record the
  // matchmaker reads for months, instead of a relationship nudge that evaporated.
  const positive = response === 'accept' || response === 'counter-callout' || response === 'respectful-answer' || response === 'future-promise' || response === 'insult';
  if (positive) {
    const interest = recordMatchupInterest(save, {
      source: 'callout',
      caller: from,
      target: to,
      requestedConditions: callout.text,
      // A rejection does not reach this branch at all: it takes the path below, which marks any
      // live interest rejected. The declined case used to be written here, where it was dead.
      opponentResponse: response === 'accept' ? 'accepted' : 'open to it',
      fanResponse: callout.fanResponse,
      promotionResponse:
        assessment.promotionInterest > 60
          ? 'The promotion wants to make this fight.'
          : assessment.promotionInterest > 30
            ? 'The promotion is interested but not committed.'
            : 'The promotion is not sold on this matchup.',
      interestScore: clamp(
        assessment.promotionInterest * 0.5 + fanFavour * 0.3 + (response === 'accept' ? 25 : 8),
        0,
        100
      ),
      lifespanDays: response === 'accept' ? 180 : 120,
    });
    callout.matchupInterestId = interest.id;
  } else {
    callout.matchupInterestId = null;
    if (response === 'reject') {
      const existing = liveInterestBetween(save, from.id, to.id);
      if (existing) {
        existing.eligibility = 'rejected';
        existing.resolution = `${to.name} turned the fight down.`;
      }
    }
  }

  const effects: Record<CalloutResponse, RelationshipDelta> = {
    accept: { rivalry: 12, respect: 6, publicHostility: 4 },
    reject: { rivalry: 6, resentment: 6, publicHostility: 3 },
    'counter-callout': { rivalry: 20, publicHostility: 14, respect: 4 },
    insult: { rivalry: 24, publicHostility: 22, resentment: 18, privateHostility: 14, respect: -6 },
    'respectful-answer': { respect: 12, rivalry: 4, publicHostility: -4 },
    silence: { rivalry: 4, resentment: 4 },
    'future-promise': { rivalry: 6, respect: 4 },
  };
  applyRelationship(save, callout.fromId, callout.toId, effects[response], 'callout', callout.responseText);
  // The relationship carries its own rivalry number, but the rivalry the game actually gates on
  // lives in its own store, and a callout never touched it. So a public exchange that reads as a
  // feud everywhere it is displayed could not unlock the confrontational faceoff option, and did
  // not pull the two together in matchmaking.
  const heat = effects[response].rivalry ?? 0;
  if (heat > 0) {
    escalateRivalry(save, callout.fromId, callout.toId, 'personal', heat, callout.responseText ?? 'a callout');
  }
}

function responseTextFor(response: CalloutResponse, toName: string, fromName: string): string {
  switch (response) {
    case 'accept':
      return `${toName} accepts. He says he will sign whatever the promotion sends over.`;
    case 'reject':
      return `${toName} turns it down flat. He says there is nothing in it for him.`;
    case 'counter-callout':
      return `${toName} answers with a callout of his own, and names a bigger fight.`;
    case 'insult':
      return `${toName} responds with something that will be on every highlight reel by tonight.`;
    case 'respectful-answer':
      return `${toName} answers politely. He says he would take it if the promotion made it.`;
    case 'silence':
      return `${toName} says nothing at all. ${fromName} is left talking to himself.`;
    case 'future-promise':
      return `${toName} says the fight makes sense, but not yet.`;
  }
}

export function openCallouts(save: SaveGame): Callout[] {
  return Object.values(calloutStore(save)).filter((c) => c.status === 'open' && c.expiresOn >= save.date);
}

export function calloutsFor(save: SaveGame, fighterId: FighterId): Callout[] {
  return Object.values(calloutStore(save))
    .filter((c) => c.fromId === fighterId || c.toId === fighterId)
    .sort((a, b) => (a.madeOn < b.madeOn ? 1 : -1));
}

/** Expires old callouts and drops ancient ones. */
export function pruneCallouts(save: SaveGame, keepDays = 400): number {
  const s = calloutStore(save);
  let removed = 0;
  for (const id of Object.keys(s)) {
    const c = s[id];
    if (c.status === 'open' && c.expiresOn < save.date) {
      c.status = 'expired';
      c.responseText = 'The callout went unanswered and the moment passed.';
    }
    if (daysBetween(c.madeOn, save.date) > keepDays) {
      delete s[id];
      removed++;
    }
  }
  return removed;
}

/** How much a callout should push the matchmaker, from 0 to 1. */
export function calloutPressure(save: SaveGame, aId: FighterId, bId: FighterId): number {
  const relevant = Object.values(calloutStore(save)).filter(
    (c) =>
      ((c.fromId === aId && c.toId === bId) || (c.fromId === bId && c.toId === aId)) &&
      daysBetween(c.madeOn, save.date) < 120
  );
  if (relevant.length === 0) return 0;
  const accepted = relevant.some((c) => c.response === 'accept');
  const heat = relevant.some((c) => c.response === 'insult' || c.response === 'counter-callout');
  return clamp((accepted ? 0.6 : 0.25) + (heat ? 0.3 : 0), 0, 1);
}
