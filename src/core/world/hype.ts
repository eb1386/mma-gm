import { clamp } from '../rng';
import { DIVISION_BY_ID } from '../config/divisions';
import { daysBetween, type IsoDate } from '../types/common';
import type { Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { FightHype, HypeMoment, Rivalry, RivalryType } from '../types/identity';
import { computeDrawingPower, totalFollowersOf } from './identity-utils';
import type { SaveGame } from '../types/save';

/**
 * Fight hype.
 *
 * Hype is what an audience expects from a matchup before it happens, tracked separately
 * for hardcore fans, casual fans, the local market and the media. It moves over time as
 * the build up plays out, and it can fall as well as rise.
 */

export function hypeStore(save: SaveGame): Record<string, FightHype> {
  const anySave = save as unknown as { hype?: Record<string, FightHype> };
  if (!anySave.hype) anySave.hype = {};
  return anySave.hype;
}

export function rivalryStore(save: SaveGame): Record<string, Rivalry> {
  const anySave = save as unknown as { rivalries?: Record<string, Rivalry> };
  if (!anySave.rivalries) anySave.rivalries = {};
  return anySave.rivalries;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function findRivalry(save: SaveGame, aId: string, bId: string): Rivalry | null {
  return rivalryStore(save)[pairKey(aId, bId)] ?? null;
}

export function escalateRivalry(
  save: SaveGame,
  aId: string,
  bId: string,
  type: RivalryType,
  delta: number,
  note: string
): Rivalry {
  const store = rivalryStore(save);
  const key = pairKey(aId, bId);
  let rivalry = store[key];
  if (!rivalry) {
    rivalry = {
      id: key,
      aId,
      bId,
      type,
      intensity: 0,
      startedOn: save.date,
      lastEventOn: save.date,
      resolved: false,
      history: [],
    };
    store[key] = rivalry;
  }
  rivalry.intensity = clamp(rivalry.intensity + delta, 0, 100);
  rivalry.lastEventOn = save.date;
  rivalry.resolved = rivalry.intensity < 8;
  rivalry.history.push({ date: save.date, note, delta });
  if (rivalry.history.length > 40) rivalry.history.shift();
  return rivalry;
}

function priorMeetingCount(save: SaveGame, aId: string, bId: string): number {
  let n = 0;
  for (const r of Object.values(save.history.results)) {
    if ((r.fighterAId === aId && r.fighterBId === bId) || (r.fighterAId === bId && r.fighterBId === aId)) n++;
  }
  return n;
}

/**
 * Computes hype for a booked bout. Called when the bout is made and refreshed weekly as
 * the build up progresses.
 */
export function computeHype(save: SaveGame, bout: Bout): FightHype {
  const a = save.fighters[bout.fighterAId];
  const b = save.fighters[bout.fighterBId];
  const store = hypeStore(save);
  const existing = store[bout.id];
  const moments: HypeMoment[] = existing?.moments ?? [];

  if (!a || !b) {
    const empty: FightHype = {
      boutId: bout.id,
      total: 0,
      hardcore: 0,
      casual: 0,
      regional: 0,
      media: 0,
      storyline: 'Details to be confirmed.',
      moments,
      projectedAttendance: null,
      projectedPpvBuys: null,
      updatedOn: save.date,
    };
    store[bout.id] = empty;
    return empty;
  }

  const drawA = a.fame ? a.fame.drawingPower : a.popularity;
  const drawB = b.fame ? b.fame.drawingPower : b.popularity;
  const recognition = ((a.fame?.recognition ?? a.popularity) + (b.fame?.recognition ?? b.popularity)) / 2;
  const hardcoreRespect = ((a.fame?.hardcoreRespect ?? 40) + (b.fame?.hardcoreRespect ?? 40)) / 2;
  const casualInterest = ((a.fame?.casualInterest ?? 30) + (b.fame?.casualInterest ?? 30)) / 2;
  const controversy = ((a.fame?.controversy ?? 10) + (b.fame?.controversy ?? 10)) / 2;

  let hardcore = hardcoreRespect * 0.5;
  let casual = casualInterest * 0.5;
  let media = recognition * 0.4 + controversy * 0.25;
  const storylineParts: string[] = [];

  // Championship and ranking stakes.
  if (bout.isTitleFight) {
    hardcore += 26;
    casual += 22;
    media += 22;
    storylineParts.push(`${DIVISION_BY_ID[bout.divisionId].name} championship`);
  } else if (bout.isInterimTitleFight) {
    hardcore += 18;
    casual += 14;
    media += 15;
    storylineParts.push('interim championship');
  } else {
    const rankA = a.ranking ?? 20;
    const rankB = b.ranking ?? 20;
    const best = Math.min(rankA, rankB);
    if (best <= 5) {
      hardcore += 18;
      casual += 8;
      media += 8;
      storylineParts.push('title eliminator stakes');
    } else if (best <= 10) {
      hardcore += 10;
      casual += 4;
    }
  }

  if (bout.isMainEvent) {
    casual += 8;
    media += 8;
  }

  // Rematches, trilogies and rivalries.
  const meetings = priorMeetingCount(save, a.id, b.id);
  if (meetings === 1) {
    hardcore += 12;
    casual += 8;
    media += 10;
    storylineParts.push('rematch');
  } else if (meetings >= 2) {
    hardcore += 18;
    casual += 12;
    media += 14;
    storylineParts.push('trilogy');
  }
  const rivalry = findRivalry(save, a.id, b.id);
  if (rivalry && !rivalry.resolved) {
    const boost = rivalry.intensity * 0.35;
    hardcore += boost;
    casual += boost * 0.8;
    media += boost;
    storylineParts.push(`${rivalry.type.replace('-', ' ')} rivalry`);
  }

  // Undefeated records and streaks.
  if (a.record.losses === 0 || b.record.losses === 0) {
    hardcore += 8;
    media += 6;
    storylineParts.push('an undefeated record on the line');
  }
  const bestStreak = Math.max(a.winStreak, b.winStreak);
  if (bestStreak >= 5) {
    hardcore += 6;
    storylineParts.push(`a ${bestStreak} fight win streak`);
  }

  // Finish reputations sell to casual audiences.
  const finishRate = (f: Fighter) => (f.methods.koWins + f.methods.subWins) / Math.max(1, f.record.wins);
  const combinedFinish = (finishRate(a) + finishRate(b)) / 2;
  casual += combinedFinish * 16;
  hardcore += combinedFinish * 6;
  if (combinedFinish > 0.6) storylineParts.push('two finishers');

  // Style contrast is what hardcore fans actually buy.
  const contrast =
    Math.abs(a.tendencies.takedownEntry - b.tendencies.takedownEntry) + Math.abs(a.tendencies.range - b.tendencies.range);
  hardcore += contrast * 9;
  if (contrast > 0.9) storylineParts.push('a clear style clash');

  // Star power dominates casual interest.
  casual += ((drawA + drawB) / 2) * 0.45;
  media += ((drawA + drawB) / 2) * 0.25;

  // Social reach.
  const reach = totalFollowersOf(a) + totalFollowersOf(b);
  const reachScore = clamp(Math.log10(Math.max(1, reach)) / 8, 0, 1) * 18;
  casual += reachScore;
  media += reachScore * 0.7;

  // Local interest.
  const event = save.events[bout.eventId];
  let regional = 20;
  if (event) {
    if (a.country === event.country) regional += 34;
    if (b.country === event.country) regional += 34;
    regional += ((drawA + drawB) / 2) * 0.2;
  }

  // Time decay: hype builds toward fight week rather than sitting flat.
  const daysOut = event ? daysBetween(save.date, event.date) : 30;
  const buildCurve = daysOut > 60 ? 0.82 : daysOut > 21 ? 0.92 : 1;

  const momentDelta = moments.reduce((s, m) => s + m.delta, 0);

  hardcore = clamp((hardcore + momentDelta * 0.8) * buildCurve, 0, 100);
  casual = clamp((casual + momentDelta) * buildCurve, 0, 100);
  media = clamp((media + momentDelta) * buildCurve, 0, 100);
  regional = clamp(regional * buildCurve, 0, 100);
  const total = clamp(hardcore * 0.32 + casual * 0.42 + media * 0.16 + regional * 0.1, 0, 100);

  const hype: FightHype = {
    boutId: bout.id,
    total,
    hardcore,
    casual,
    regional,
    media,
    storyline: storylineParts.length > 0 ? capitalize(storylineParts.join(', ')) : 'A divisional matchup',
    moments,
    projectedAttendance: null,
    projectedPpvBuys: null,
    updatedOn: save.date,
  };
  store[bout.id] = hype;
  return hype;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Records a hype moment, positive or negative, and refreshes the score. */
export function addHypeMoment(save: SaveGame, boutId: string, label: string, delta: number): void {
  const store = hypeStore(save);
  const hype = store[boutId];
  if (!hype) return;
  hype.moments.push({ date: save.date, label, delta });
  if (hype.moments.length > 24) hype.moments.shift();
  const bout = save.bouts[boutId];
  if (bout) computeHype(save, bout);
}

export function getHype(save: SaveGame, boutId: string): FightHype | null {
  return hypeStore(save)[boutId] ?? null;
}

/** Removes hype records for bouts that no longer exist, keeping a long save tidy. */
export function pruneHype(save: SaveGame): number {
  const store = hypeStore(save);
  let removed = 0;
  for (const id of Object.keys(store)) {
    const bout = save.bouts[id];
    if (!bout || bout.status === 'completed' || bout.status === 'canceled') {
      delete store[id];
      removed++;
    }
  }
  return removed;
}

export function hypeLabel(total: number): string {
  if (total >= 80) return 'Enormous';
  if (total >= 65) return 'Major';
  if (total >= 50) return 'Strong';
  if (total >= 35) return 'Moderate';
  if (total >= 20) return 'Modest';
  return 'Low';
}

export function updateAllHype(save: SaveGame, on: IsoDate): number {
  let n = 0;
  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled') continue;
    if (daysBetween(on, bout.date) > 120) continue;
    computeHype(save, bout);
    n++;
  }
  return n;
}

export { computeDrawingPower };
