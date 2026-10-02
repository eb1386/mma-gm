import { addDays } from '../types/common';
import type { Ratings } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { pruneCamps } from './camp';

/**
 * Save compaction.
 *
 * A career is meant to run for years, and the whole save is written to storage after nearly every
 * action. Before this, a save grew by six to nine megabytes per in game year, mostly from records
 * nothing would ever read again: closed camps, contracts that ended long ago and relationships
 * between fighters who have both retired. Each rule here removes only what no system or page reads,
 * and keeps everything about the player and the fighters the player looks after. No rule draws from
 * the rng or changes a value any simulation reads, so a compacted world plays out exactly as an
 * uncompacted one would.
 *
 * Every step is idempotent, which is what lets the load time repair run it on any save.
 */

/** How long after a contract ends before its record may be removed. */
export const ENDED_CONTRACT_KEEP_DAYS = 365;

export interface CompactionReport {
  camps: number;
  contracts: number;
  relationships: number;
  ratingSnapshots: number;
}

/** Fighters whose records the player sees in full: the player's own fighter and the player's gym. */
function lookedAfter(save: SaveGame): Set<string> {
  const ids = new Set<string>();
  if (save.player.fighterId) ids.add(save.player.fighterId);
  const gym = save.player.gymId ? save.gyms?.[save.player.gymId] : null;
  for (const id of gym?.fighterIds ?? []) ids.add(id);
  return ids;
}

/**
 * Removes contracts that ended more than a year ago and that nothing points at.
 *
 * A fighter's current contract, whatever its status, is what availability and the contract pages
 * read, so a contract any fighter still holds is kept. So is any contract an inbox message links to,
 * because a message whose contract is gone is treated as dead. The player's and the player's gym's
 * contracts are never removed.
 */
export function pruneEndedContracts(save: SaveGame): number {
  const cutoff = addDays(save.date, -ENDED_CONTRACT_KEEP_DAYS);
  const keep = lookedAfter(save);
  const held = new Set<string>();
  for (const f of Object.values(save.fighters)) if (f.contractId) held.add(f.contractId);
  for (const m of save.inbox ?? []) if (m.linkedContractId) held.add(m.linkedContractId);

  let removed = 0;
  for (const [id, c] of Object.entries(save.contracts)) {
    if (c.status !== 'expired' && c.status !== 'released' && c.status !== 'declined') continue;
    if (held.has(id) || keep.has(c.fighterId)) continue;
    // A deal that ran out of fights records no end date, so its signing date stands in. It is
    // older than the end it is standing in for, so this can only keep a record longer.
    const ended = c.endDate ?? c.signedOn ?? c.startDate;
    if (!ended || ended >= cutoff) continue;
    delete save.contracts[id];
    removed++;
  }
  return removed;
}

/**
 * Removes relationships between two fighters who have both retired.
 *
 * Retirement is final, so neither side will be matched, called out or written about again. The
 * relationship pages only list the player's own relationships, which are always kept.
 */
export function pruneRetiredRelationships(save: SaveGame): number {
  const store = save.relationships;
  if (!store) return 0;
  const keep = lookedAfter(save);
  let removed = 0;
  for (const [key, r] of Object.entries(store)) {
    if (keep.has(r.aId) || keep.has(r.bId)) continue;
    const a = save.fighters[r.aId];
    const b = save.fighters[r.bId];
    if (!a?.retired || !b?.retired) continue;
    delete store[key];
    removed++;
  }
  return removed;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Rounds the ratings stored in each fighter's rating history to two decimals.
 *
 * The history exists only for the fighter page's chart and table, which show whole numbers, and
 * full precision floats made it about a fifth of every fighter record. The live ratings the
 * simulation uses are never touched. Returns how many snapshots changed.
 */
export function roundRatingHistory(save: SaveGame): number {
  let changed = 0;
  for (const f of Object.values(save.fighters)) {
    for (const snap of f.ratingHistory ?? []) {
      const r: Ratings | undefined = snap.ratings;
      if (!r) continue;
      let touched = false;
      for (const k of Object.keys(r) as (keyof Ratings)[]) {
        const v = r[k];
        if (typeof v !== 'number') continue;
        const rounded = round2(v);
        if (rounded !== v) {
          r[k] = rounded;
          touched = true;
        }
      }
      if (touched) changed++;
    }
  }
  return changed;
}

/** Runs every compaction step. Safe to run at any time and on any save. */
export function compactSave(save: SaveGame): CompactionReport {
  return {
    camps: pruneCamps(save),
    contracts: pruneEndedContracts(save),
    relationships: pruneRetiredRelationships(save),
    ratingSnapshots: roundRatingHistory(save),
  };
}
