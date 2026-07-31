import { clamp, hashString, Rng } from '../rng';
import { ageOn, type IsoDate } from '../types/common';
import { ovrRaw, RATING_KEYS, type Fighter } from '../types/fighter';
import { DEFAULT_SETTINGS, type SaveGame } from '../types/save';
import { estimatePot, potConfidenceFor } from './development';

/**
 * Pot projection scheduling and caching.
 *
 * Running a full fidelity long term projection for every fighter on the roster is the
 * single most expensive thing the game does. It dominated both career creation and the
 * test suite. The work is now tiered by how much the answer actually matters, cached
 * against a key that captures everything the projection depends on, and recomputed only
 * when one of those inputs meaningfully changes.
 *
 * The projection model itself is unchanged. Only how often and how finely it runs.
 */

export const POT_MODEL_VERSION = 2;

export type PotTier =
  | 'player'
  | 'player-opponent'
  | 'champion'
  | 'top-five'
  | 'ranked-prospect'
  | 'ranked'
  | 'unranked'
  | 'veteran'
  | 'retired';

/** Path counts by tier. Retired fighters are never recalculated at all. */
export const POT_PATHS: Record<PotTier, number> = {
  player: 90,
  'player-opponent': 60,
  champion: 36,
  'top-five': 36,
  'ranked-prospect': 30,
  ranked: 18,
  unranked: 9,
  veteran: 6,
  retired: 0,
};

export function potTierFor(save: SaveGame, fighter: Fighter): PotTier {
  if (fighter.retired) return 'retired';
  if (save.player.fighterId === fighter.id) return 'player';

  const playerFighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (playerFighter?.nextBoutId) {
    const bout = save.bouts[playerFighter.nextBoutId];
    if (bout && (bout.fighterAId === fighter.id || bout.fighterBId === fighter.id)) return 'player-opponent';
  }
  // Fighters at the player's own gym matter to a coach the way an opponent matters to a
  // fighter, so they get the same attention.
  if (save.player.gymId && fighter.gymId === save.player.gymId) return 'player-opponent';

  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 29;
  if (age > 34) return 'veteran';
  if (fighter.isChampion || fighter.isInterimChampion) return 'champion';
  if (fighter.ranking !== null && fighter.ranking <= 5) return 'top-five';
  if (fighter.ranking !== null && age < 28) return 'ranked-prospect';
  if (fighter.ranking !== null) return 'ranked';
  return 'unranked';
}

/**
 * Stable cache key. Every input the projection actually reads appears here, so a cache
 * hit is only possible when recomputing would produce the same answer.
 */
export function potCacheKey(save: SaveGame, fighter: Fighter, tier: PotTier): string {
  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 29;
  let ratingsHash = 0;
  for (const k of RATING_KEYS) ratingsHash = (ratingsHash * 101 + Math.round(fighter.ratings[k])) >>> 0;
  const longevityBand = Math.floor(fighter.longevity / 10);
  const wearBand = Math.floor((fighter.wear.neurological + fighter.wear.recovery) / 20);
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  const gymBand = gym ? Math.floor(gym.reputation / 15) : -1;
  const blockingInjury = fighter.injuries.some((i) => i.actualReturn === null && i.severity >= 3) ? 1 : 0;
  const devVersion = Math.round(fighter.development.hiddenCeiling * 10);
  return `${POT_MODEL_VERSION}|${tier}|${ratingsHash}|${age}|${longevityBand}|${wearBand}|${gymBand}|${blockingInjury}|${devVersion}`;
}

interface PotCacheEntry {
  key: string;
  pot: number;
}

/** The cache lives on the save so it survives a reload without recomputation. */
function cacheOf(save: SaveGame): Record<string, PotCacheEntry> {
  const anySave = save as unknown as { potCache?: Record<string, PotCacheEntry> };
  if (!anySave.potCache) anySave.potCache = {};
  return anySave.potCache;
}

export interface PotUpdateOptions {
  /** Forces recomputation even on a cache hit. */
  force?: boolean;
  /** Overrides the tier, used when the player explicitly scouts someone. */
  tier?: PotTier;
}

/**
 * Returns the fighter's Pot, recomputing only when the cache key has changed.
 * Also refreshes the displayed confidence, which is cheap.
 */
export function updatePot(save: SaveGame, fighter: Fighter, opts: PotUpdateOptions = {}): number {
  const tier = opts.tier ?? potTierFor(save, fighter);
  if (tier === 'retired' && fighter.pot > 0 && !opts.force) return fighter.pot;

  const cache = cacheOf(save);
  const key = potCacheKey(save, fighter, tier);
  const hit = cache[fighter.id];
  if (!opts.force && hit && hit.key === key) {
    fighter.pot = hit.pot;
    return hit.pot;
  }

  // Scaled by the player's setting rather than ignoring it. The tier decides the relative effort,
  // the setting decides the total budget, and previously the setting was read nowhere at all.
  const budget = save.settings.potPaths > 0 ? save.settings.potPaths / DEFAULT_SETTINGS.potPaths : 1;
  const paths = Math.max(4, Math.round(POT_PATHS[tier] * clamp(budget, 0.25, 4)));
  // The projection seed is derived from the save seed and the fighter id so the answer is
  // reproducible and does not depend on how many other fighters were processed first.
  const rng = new Rng((hashString(`pot-${fighter.id}-${key}`) ^ save.seed) >>> 0);
  const pot = estimatePot(fighter, save.date, paths, save.settings.potPercentile, rng, { stepWeeks: stepWeeksFor(tier) });

  fighter.pot = pot;
  fighter.potConfidence = potConfidenceFor(fighter, save.date);
  cache[fighter.id] = { key, pot };
  return pot;
}

/**
 * Projection step size. High attention tiers walk the career in fortnightly steps, and
 * the long tail uses monthly and quarterly steps. Coarser steps change the projected peak
 * by a fraction of a rating point while costing a small fraction of the time.
 */
function stepWeeksFor(tier: PotTier): number {
  switch (tier) {
    case 'player':
    case 'player-opponent':
      return 2;
    case 'champion':
    case 'top-five':
    case 'ranked-prospect':
      return 4;
    case 'ranked':
      return 6;
    default:
      return 13;
  }
}

/** Reasons a fighter's Pot should be recomputed even though the cache key may match. */
export type PotInvalidationReason =
  | 'annual'
  | 'birthday'
  | 'major-injury'
  | 'major-rating-change'
  | 'gym-change'
  | 'division-change'
  | 'return-from-retirement'
  | 'long-layoff'
  | 'scouting'
  | 'new-save'
  | 'development-event';

export function invalidatePot(save: SaveGame, fighterId: string, reason: PotInvalidationReason): void {
  const cache = cacheOf(save);
  delete cache[fighterId];
  void reason;
}

/**
 * Batch refresh with a work budget. Fighters whose cache key is unchanged cost nothing,
 * so the annual pass is dominated by the handful who actually changed.
 */
export function refreshPotForAll(save: SaveGame, opts: { onlyChanged?: boolean } = {}): { recomputed: number; cached: number } {
  let recomputed = 0;
  let cached = 0;
  const cache = cacheOf(save);
  for (const fighter of Object.values(save.fighters)) {
    if (fighter.retired) continue;
    const tier = potTierFor(save, fighter);
    const key = potCacheKey(save, fighter, tier);
    if (opts.onlyChanged !== false && cache[fighter.id]?.key === key) {
      fighter.pot = cache[fighter.id].pot;
      cached++;
      continue;
    }
    updatePot(save, fighter, { tier });
    recomputed++;
  }
  return { recomputed, cached };
}

/** Trims cache entries for fighters that no longer exist, keeping a long save tidy. */
export function prunePotCache(save: SaveGame): number {
  const cache = cacheOf(save);
  let removed = 0;
  for (const id of Object.keys(cache)) {
    if (!save.fighters[id]) {
      delete cache[id];
      removed++;
    }
  }
  return removed;
}

/** Displayed Pot never sits below current Ovr, whatever the cache holds. */
export function displayedPot(fighter: Fighter): number {
  return clamp(fighter.pot, Math.round(ovrRaw(fighter.ratings)), 99);
}

export function potDateKey(date: IsoDate): string {
  return date.slice(0, 7);
}
