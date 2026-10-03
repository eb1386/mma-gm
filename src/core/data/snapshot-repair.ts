import type { SaveGame } from '../types/save';
import type { SnapshotFile } from './snapshot';

/**
 * Restores sourced identity that an older snapshot got wrong.
 *
 * Careers started from the July roster carry 'Unknown' as the country of almost every real
 * fighter, because that snapshot's builder could not read most birthplaces. The save has no copy of
 * the raw profile, so it cannot repair itself, but the current snapshot has the right values under
 * the same fighter ids. Only sourced identity is copied: country, country code and hometown where
 * the save has none, and the official career statistics where the save has none. Nothing the
 * simulation has changed since the save began (ratings, records, rankings) is touched.
 */
export function needsSnapshotRepair(save: SaveGame): boolean {
  if (save.snapshotRepairedFrom) return false;
  for (const f of Object.values(save.fighters)) {
    if (!f.isRealPerson) continue;
    if (isUnknown(f.country) || !f.countryCode || f.officialStats === undefined) return true;
  }
  return false;
}

function isUnknown(country: string | null | undefined): boolean {
  return !country || country.trim() === '' || country.trim().toLowerCase() === 'unknown';
}

/** Returns how many fighters changed. Idempotent: a second run changes nothing. */
export function repairFromSnapshot(save: SaveGame, snapshot: SnapshotFile): number {
  const byId = new Map(snapshot.fighters.map((f) => [f.id, f]));
  let changed = 0;
  for (const f of Object.values(save.fighters)) {
    if (!f.isRealPerson) continue;
    const src = byId.get(f.id);
    if (!src) continue;
    let touched = false;
    if (isUnknown(f.country) && !isUnknown(src.country)) {
      f.country = src.country;
      f.countryCode = src.countryCode;
      if (!f.hometown && src.hometown) f.hometown = src.hometown;
      if (src.provenance?.country) f.provenance = { ...f.provenance, country: src.provenance.country };
      touched = true;
    } else if (!f.countryCode && src.countryCode && f.country === src.country) {
      f.countryCode = src.countryCode;
      touched = true;
    }
    if (f.officialStats === undefined && src.officialStats) {
      f.officialStats = src.officialStats;
      touched = true;
    }
    if (touched) changed++;
  }
  // Some real fighters have no published birthplace in any snapshot, so the check above would stay
  // true for ever. Recording the run makes it a one time repair.
  save.snapshotRepairedFrom = snapshot.meta.snapshotId;
  return changed;
}
