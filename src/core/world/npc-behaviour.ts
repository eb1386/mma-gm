import { DIVISION_BY_ID } from '../config/divisions';
import { mainRosterFighters } from './circuit';
import { clamp, Rng } from '../rng';
import { addDays, ageOn, daysBetween, type FighterId } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { hasLiveBooking, offerBlockReason } from './availability';
import { healthyCutFor } from './health';
import { addInboxMessage } from './inbox';
import { COOLDOWNS, mayNotify } from './decisions';
import { calloutPressure, getRelationship, makeCallout, relationshipState, type CalloutTone } from './relationships';
import { adjacentDivisions, carriedWalkingWeight, frameFitsDivision } from './weightclass';
import { forfeitContenderStatus, grantContenderStatus } from './contender';
import { assessChampionMove } from './weightclass';
import { dial } from './identity';

/**
 * What other fighters do on their own.
 *
 * The player could call people out and change division; nobody else could. A world where
 * only the player acts does not feel like a division, so NPC fighters now initiate
 * callouts and occasionally move weight class, at rates that stay meaningful.
 */

/** How likely this fighter is to call the player out, from 0 to 1. */
export function calloutLikelihood(save: SaveGame, npc: Fighter, player: Fighter): number {
  if (npc.id === player.id || npc.retired) return 0;
  if (npc.divisionId !== player.divisionId) {
    // Only a title picture or an existing rivalry crosses divisions.
    const rel = getRelationship(save, npc.id, player.id);
    if (!rel || rel.rivalry < 45) return 0;
  }
  const npcRank = npc.isChampion ? 0 : (npc.ranking ?? 99);
  const playerRank = player.isChampion ? 0 : (player.ranking ?? 99);
  if (npcRank > 15 && playerRank > 15) return 0;
  const rel = getRelationship(save, npc.id, player.id);
  // A ranked fighter does not call down to somebody outside the rankings. There is nothing in it
  // for them, and it is what had the champion and the whole top ten calling out a debutant. A
  // real feud or an earlier meeting is the exception, because then there is a story to sell.
  if (playerRank > 15 && npcRank <= 15 && !((rel?.rivalry ?? 0) >= 45 || (rel?.fights.length ?? 0) > 0)) return 0;

  let score = 0;
  // Ranking proximity: calling out someone six places away is normal, twenty is not.
  const gap = Math.abs(npcRank - playerRank);
  if (gap <= 3) score += 0.35;
  else if (gap <= 7) score += 0.22;
  else if (gap <= 12) score += 0.08;

  // Calling up is the normal direction.
  if (playerRank < npcRank) score += 0.15;
  if (player.isChampion) score += 0.2;

  if (npc.winStreak >= 3) score += 0.15;
  if (npc.winStreak >= 5) score += 0.1;
  if (npc.lossStreak > 0) score -= 0.2;

  const state = relationshipState(rel);
  if (state === 'bitter-rival' || state === 'enemy') score += 0.4;
  else if (state === 'heated-rival') score += 0.28;
  else if (state === 'professional-rival') score += 0.12;
  else if (state === 'training-partner' || state === 'close-friend') score -= 0.6;
  // An unfinished rematch is a strong pull.
  if (rel && rel.fights.length > 0 && rel.fights[rel.fights.length - 1].winnerId === player.id) score += 0.2;

  // Popularity helps a callout land, but across a gap of more than twelve places it is not a reason
  // to make one, so on its own it can never carry such a callout past the candidate filter.
  const popularity = clamp((npc.popularity - 40) / 200, -0.1, 0.15);
  score += gap > 12 ? Math.min(0, popularity) : popularity;
  // A fighter who is busy has nothing to gain by calling anyone out.
  if (hasLiveBooking(save, npc)) score -= 0.5;
  // The dials are stored 0 to 100. Read raw they multiplied the score by about forty, so every
  // fighter with any reason at all sat at the cap and the ranking of who wants this most was lost.
  const ego = dial(npc.personality, 'ego');
  const temper = dial(npc.personality, 'temper');
  score *= 0.6 + ego * 0.5 + temper * 0.2;
  return clamp(score, 0, 0.9);
}

export function toneFor(save: SaveGame, npc: Fighter, playerId: FighterId, rng: Rng): CalloutTone {
  const state = relationshipState(getRelationship(save, npc.id, playerId));
  if (state === 'bitter-rival' || state === 'enemy') return rng.chance(0.6) ? 'personal' : 'aggressive';
  if (state === 'heated-rival') return rng.chance(0.5) ? 'aggressive' : 'confident';
  // Dials are 0 to 100. Read raw, every callout was aggressive.
  const temper = dial(npc.personality, 'temper');
  if (temper > 0.7) return 'aggressive';
  const charisma = dial(npc.personality, 'charisma');
  if (charisma > 0.65) return 'promotional';
  return rng.chance(0.5) ? 'confident' : 'respectful';
}

/**
 * Gives NPC fighters a chance to call the player out. At most one per pass, and never more
 * than one open at a time.
 */
export function runNpcCallouts(save: SaveGame, rng: Rng): string[] {
  const playerId = save.player.fighterId;
  if (!playerId) return [];
  const player = save.fighters[playerId];
  if (!player || player.retired) return [];

  // One open incoming callout at a time.
  const openIncoming = Object.values(save.callouts ?? {}).some((c) => c.toId === playerId && c.status === 'open');
  if (openIncoming) return [];
  if (!mayNotify(save, { signature: `npc-callout|${playerId}`, cooldownDays: COOLDOWNS.callout })) return [];

  const candidates = mainRosterFighters(save).filter((f) => !f.retired && f.id !== playerId);
  const scored = candidates
    .map((f) => ({ f, p: calloutLikelihood(save, f, player) }))
    .filter((x) => x.p > 0.12)
    .sort((a, b) => b.p - a.p)
    .slice(0, 8);
  if (scored.length === 0) return [];

  const pick = rng.weighted(scored, (x) => x.p);
  // The weekly chance is deliberately modest so this stays an event, not a routine.
  if (!rng.chance(pick.p * 0.16)) return [];

  const tone = toneFor(save, pick.f, playerId, rng);
  const callout = makeCallout(save, pick.f.id, playerId, tone, rng);
  if (!callout) return [];

  const message = addInboxMessage(save, {
    sender: 'fighter',
    senderName: pick.f.name,
    subject: `${pick.f.name} has called you out`,
    body: `${callout.text}\n\nIt is already being written up. How you answer will shape whether the promotion takes the fight seriously.`,
    category: 'career',
    requiresAction: true,
    deadline: addDays(save.date, 14),
    choices: [
      { key: 'callout-accept', label: 'Accept publicly', hint: 'Puts real pressure on the matchmaker. It does not book the fight.' },
      { key: 'callout-reject', label: 'Turn it down publicly', hint: 'Costs nothing but goodwill with the fans.' },
      { key: 'callout-respectful', label: 'Answer respectfully', hint: 'Keeps it professional.' },
      { key: 'callout-aggressive', label: 'Answer in kind', hint: 'Raises the temperature and the hype.' },
      { key: 'callout-ignore', label: 'Say nothing', hint: 'Gives them nothing to work with.' },
    ],
    linkedFighterId: pick.f.id,
  });
  message.linkedCalloutId = callout.id;
  message.decisionKey = `npc-callout|${playerId}`;
  message.notificationSignature = `npc-callout|${playerId}`;
  message.decisionCreatedOn = save.date;
  // A callout is an opportunity, not something that should freeze a career.
  message.mandatory = false;
  return [`${pick.f.name} has called you out.`];
}

// ---------------------------------------------------------------------------
// NPC weight class movement
// ---------------------------------------------------------------------------

export interface NpcMoveDecision {
  fighterId: FighterId;
  from: string;
  to: string;
  direction: 'up' | 'down';
  reason: string;
}

/** How badly this fighter wants to change division, from 0 to 1. */
/**
 * How much a champion's desire to move is damped.
 *
 * Heavily, because a title is the reason to stay. The two reliefs are the two reasons a champion
 * really does move: they have defended enough that the division holds nothing new, or the weight
 * cut has stopped being survivable.
 */
export const CHAMPION_MOVE_DAMPING = 0.25;
export const CHAMPION_CLEARED_OUT_RELIEF = 0.25;
export const CHAMPION_HARD_CUT_RELIEF = 0.2;

/** The desire a fighter needs before they move up a division. */
export const UP_MOVE_THRESHOLD = 0.35;
/**
 * The desire a fighter needs before they move down. Lower than the step up, because the reasons
 * to move down are fewer and smaller: every term of the down desire together tops out at 0.30,
 * so sharing the 0.35 bar made a move down impossible and every NPC move in a long save was
 * upward, piling lightweights into welterweight and thinning the lighter divisions out.
 */
export const DOWN_MOVE_THRESHOLD = 0.22;
/** The share of weekly moves that go down when somebody has a real reason to. Rarer than up. */
export const DOWN_MOVE_SHARE = 0.25;

export function moveDesire(save: SaveGame, f: Fighter): { up: number; down: number } {
  if (f.retired || hasLiveBooking(save, f)) return { up: 0, down: 0 };
  const division = DIVISION_BY_ID[f.divisionId];
  const age = ageOn(f.birthDate, save.date) ?? f.ageAtSnapshot ?? 28;
  const healthy = healthyCutFor(f, age);
  const cut = Math.max(0, f.walkingWeightLb - division.limitLb);
  const strain = cut / Math.max(6, healthy);

  let up = 0;
  // The cut is the main reason anyone moves up.
  if (strain > 0.9) up += 0.4;
  else if (strain > 0.8) up += 0.18;
  up += Math.min(0.3, f.weightMisses * 0.15);
  if (age > 33) up += 0.12;
  if (f.lossStreak >= 2) up += 0.1;
  // A fighter stuck outside the rankings for a long time looks for a new road.
  if (f.ranking === null && f.weeksRanked === 0) up += 0.08;

  let down = 0;
  // Moving down is rarer and is about finding a title path.
  if (strain < 0.45 && age < 31) down += 0.16;
  // A fighter who could make the weight below without wrecking themselves has the option at all.
  // Walking weights sit close to a full cut for almost everyone outside heavyweight, so the light
  // for the division term above almost never applies, and without this no NPC below heavyweight
  // had any reason to look down.
  const below = adjacentDivisions(f).down;
  if (below && age < 33 && f.walkingWeightLb - below.limitLb <= healthy * 1.15) down += 0.1;
  if (f.ranking !== null && f.ranking > 8) down += 0.08;
  // Stuck outside the rankings, the same new road the step up offers.
  if (f.ranking === null && f.weeksRanked === 0) down += 0.06;
  if (f.lossStreak >= 2) down += 0.06;
  if (f.weightMisses > 0) down -= 0.3;

  // A champion or a top contender has every reason to stay.
  if (f.isChampion) {
    // Until the cut stops being survivable, or there is nobody left in the division to fight.
    // A flat quarter put every champion under the candidate threshold no matter what, so no NPC
    // champion could ever move weight and the whole double champion path, the held title
    // deadline and the contender granted on arrival were unreachable for anyone but the player.
    const clearedOut = clamp(f.titleDefenses / 4, 0, 1);
    up *= CHAMPION_MOVE_DAMPING + clearedOut * CHAMPION_CLEARED_OUT_RELIEF + (strain > 0.9 ? CHAMPION_HARD_CUT_RELIEF : 0);
    down *= 0.2;
  } else if ((f.ranking ?? 99) <= 5) {
    up *= 0.5;
    down *= 0.5;
  }
  return { up: clamp(up, 0, 0.9), down: clamp(down, 0, 0.7) };
}

/**
 * Moves a small number of NPC fighters between divisions.
 *
 * Rate limited hard: this runs weekly across the whole roster, so the per fighter chance is
 * tiny. The target is a small minority of active fighters moving in a year, not churn.
 */
export function runNpcWeightClassMoves(save: SaveGame, rng: Rng): NpcMoveDecision[] {
  const moves: NpcMoveDecision[] = [];
  const playerId = save.player.fighterId;
  const roster = mainRosterFighters(save).filter((f) => !f.retired && f.id !== playerId);
  // At most one move a week across the entire roster.
  if (!rng.chance(0.35)) return moves;

  const candidates = roster
    .map((f) => ({ f, desire: moveDesire(save, f) }))
    .map((x) => {
      // The direction is whichever desire actually cleared its own bar. A fighter who passed on
      // the way down with a larger but still insufficient wish to move up used to be sent up.
      const upPasses = x.desire.up > UP_MOVE_THRESHOLD;
      const downPasses = x.desire.down > DOWN_MOVE_THRESHOLD;
      const goUp = upPasses && (!downPasses || x.desire.up >= x.desire.down);
      return { ...x, goUp, passes: upPasses || downPasses, weight: goUp ? x.desire.up : x.desire.down };
    })
    .filter((x) => x.passes);
  if (candidates.length === 0) return moves;

  // The two directions are drawn from separately. The step up pool runs to a hundred or more in a
  // normal week and the step down pool to a handful, so one weighted draw over both never once
  // picked a move down. A fighter looking down is only counted when the weight below is one they
  // can actually make, so a draw from that pool is not spent on a move the frame check refuses.
  const ups = candidates.filter((x) => x.goUp);
  const downs = candidates.filter((x) => {
    if (x.goUp) return false;
    const below = adjacentDivisions(x.f).down;
    return below !== null && frameFitsDivision(x.f, below, ageOn(x.f.birthDate, save.date) ?? x.f.ageAtSnapshot ?? 28).ok;
  });
  if (ups.length === 0 && downs.length === 0) return moves;
  const pool = downs.length > 0 && (ups.length === 0 || rng.chance(DOWN_MOVE_SHARE)) ? downs : ups;
  const pick = rng.weighted(pool, (x) => x.weight);
  const goUp = pick.goUp;
  const { up, down } = adjacentDivisions(pick.f);
  const target = goUp ? up : down;
  if (!target) return moves;
  // The body has to fit the destination. Without this a fighter could keep stepping up until a
  // lightweight stood in the light heavyweight rankings, because each move used to inflate the
  // walking weight to the new division and make them "too big" all over again.
  const age = ageOn(pick.f.birthDate, save.date) ?? pick.f.ageAtSnapshot ?? 28;
  if (!frameFitsDivision(pick.f, target, age).ok) return moves;

  const from = DIVISION_BY_ID[pick.f.divisionId];
  const oldTable = save.rankings[from.id];
  // Read before the block below, which clears both of the things it reads. Computed afterwards,
  // as it was, this was always false, so no NPC champion ever carried their standing into a new
  // division and every one of them arrived as an unranked newcomer.
  const wasChampion = oldTable?.championId === pick.f.id || pick.f.isChampion;
  if (oldTable) {
    oldTable.entries = oldTable.entries.filter((e) => e.fighterId !== pick.f.id);
    if (oldTable.championId === pick.f.id) {
      oldTable.championId = null;
      pick.f.isChampion = false;
      const reign = save.history.reigns.find((r) => r.fighterId === pick.f.id && r.lostOn === null && !r.isInterim);
      if (reign) {
        reign.lostOn = save.date;
        reign.endReason = 'vacated';
      }
    }
    if (oldTable.interimChampionId === pick.f.id) {
      oldTable.interimChampionId = null;
      pick.f.isInterimChampion = false;
    }
  }

  // A champion who moves carries their standing with them, exactly as the player's move does.
  // Without this an NPC champion arrived unranked with no claim on anything and was matched as a
  // newcomer, which is the treatment the design explicitly rules out.

  pick.f.divisionId = target.id;
  pick.f.ranking = null;
  pick.f.previousRanking = null;
  pick.f.weeksRanked = 0;
  if (!pick.f.eligibleDivisions.includes(target.id)) pick.f.eligibleDivisions.push(target.id);
  pick.f.walkingWeightLb = carriedWalkingWeight(pick.f);
  pick.f.weightMisses = 0;

  if (wasChampion) {
    const assessment = assessChampionMove(save, pick.f, target.id);
    if (assessment.championshipOnTheLine) {
      grantContenderStatus(save, pick.f, target.id, 'division-move', null);
    }
  }
  // A contender position belongs to the division it was earned in.
  forfeitContenderStatus(save, from.id, `${pick.f.name} moved to ${target.name}.`, pick.f.id);

  const reason = goUp
    ? pick.f.weightMisses > 0
      ? 'after repeated trouble on the scale'
      : 'saying the cut had become unsustainable'
    : 'looking for a faster route to a title';
  moves.push({ fighterId: pick.f.id, from: from.id, to: target.id, direction: goUp ? 'up' : 'down', reason });
  return moves;
}

/**
 * Withdraws every open offer that is no longer valid for the fighter's current division.
 *
 * This is the invariant that stops a fighter receiving an offer in the division they just
 * left. Returns the ids of offers that were withdrawn.
 */
export function enforceDivisionInvariant(save: SaveGame): string[] {
  const withdrawn: string[] = [];
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    const fighter = save.fighters[offer.fighterId];
    const opponent = save.fighters[offer.opponentId];
    if (!fighter || !opponent) continue;
    // A catchweight or explicitly cross division bout is allowed to differ.
    if (offer.isCatchweight) continue;
    if (offer.divisionId === fighter.divisionId && opponent.divisionId === fighter.divisionId) continue;
    offer.status = 'withdrawn';
    withdrawn.push(offer.id);
  }
  return withdrawn;
}

/** Cancels scheduled bouts a fighter is no longer eligible for after a division change. */
export function cancelStaleDivisionBouts(save: SaveGame): string[] {
  const stale: string[] = [];
  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled') continue;
    if (bout.isCatchweight) continue;
    const a = save.fighters[bout.fighterAId];
    const b = save.fighters[bout.fighterBId];
    if (!a || !b) continue;
    if (a.divisionId === bout.divisionId && b.divisionId === bout.divisionId) continue;
    stale.push(bout.id);
  }
  return stale;
}

/** Matchmaking pressure from callouts, so an accepted callout actually means something. */
export function pressureBetween(save: SaveGame, aId: FighterId, bId: FighterId): number {
  return calloutPressure(save, aId, bId);
}

/** True when this fighter could be offered something right now, for the callout screen. */
export function availableSoon(save: SaveGame, f: Fighter): boolean {
  return offerBlockReason(save, f, { eventDate: addDays(save.date, 60) }) === null;
}

export { daysBetween };
