import type { DivisionId } from '../config/divisions';
import type { ActivityStatus, IsoDate, Provenance } from '../types/common';
import type { SnapshotMeta } from '../types/save';

/**
 * Data provider abstraction.
 *
 * Every source produces the same normalized domain objects, so swapping a source is a
 * configuration change rather than a rewrite. Any adapter may report a capability as
 * unavailable, and the pipeline records that as an explicit gap instead of substituting
 * invented values.
 */

export interface NormalizedFighterRecord {
  sourceId: string;
  name: string;
  nickname: string | null;
  country: string | null;
  hometown: string | null;
  birthDate: IsoDate | null;
  age: number | null;
  heightIn: number | null;
  reachIn: number | null;
  legReachIn: number | null;
  stance: 'orthodox' | 'southpaw' | 'switch' | null;
  divisionId: DivisionId | null;
  divisionLabel: string | null;
  weightLb: number | null;
  status: ActivityStatus;
  gymName: string | null;
  fightingStyle: string | null;
  octagonDebut: IsoDate | null;
  record: { w: number; l: number; d: number } | null;
  winsByKo: number | null;
  winsBySub: number | null;
  winStreak: number | null;
  lossStreak: number | null;
  rank: number | null;
  isChampion: boolean;
  isInterimChampion: boolean;
  pfpRank: number | null;
  stats: {
    sigStrLandedPerMin: number | null;
    sigStrAbsorbedPerMin: number | null;
    sigStrDefensePct: number | null;
    takedownAvgPer15: number | null;
    takedownDefensePct: number | null;
    submissionAvgPer15: number | null;
    knockdownAvgPer15: number | null;
    avgFightTimeSeconds: number | null;
    sigStrLanded: number | null;
    sigStrAttempted: number | null;
    takedownsLanded: number | null;
    takedownsAttempted: number | null;
    strikeTarget: { headPct: number; bodyPct: number; legPct: number } | null;
    strikePosition: { standingPct: number; clinchPct: number; groundPct: number } | null;
    winMethod: { koPct: number; decPct: number; subPct: number } | null;
  };
  provenance: Record<string, Provenance>;
  missingFields: string[];
}

export interface NormalizedRanking {
  divisionId: DivisionId | 'pfp';
  championSourceId: string | null;
  interimChampionSourceId: string | null;
  entries: { rank: number; sourceId: string; name: string }[];
  capturedAt: string;
  sourceUrl: string;
}

export interface NormalizedEvent {
  sourceId: string;
  name: string;
  date: IsoDate;
  city: string | null;
  country: string | null;
  venue: string | null;
  boutSourceIds: string[];
}

export interface NormalizedBout {
  sourceId: string;
  eventSourceId: string;
  fighterASourceId: string;
  fighterBSourceId: string;
  divisionLabel: string | null;
  scheduledRounds: number | null;
  isTitleFight: boolean;
  result: {
    winnerSourceId: string | null;
    method: string;
    round: number;
    timeSeconds: number;
  } | null;
}

export type ProviderCapability =
  | 'fighter-index'
  | 'fighter-profile'
  | 'rankings'
  | 'events'
  | 'bouts'
  | 'round-statistics'
  | 'scheduled-fights'
  | 'official-results'
  | 'roster-changes';

export interface CapabilityReport {
  capability: ProviderCapability;
  available: boolean;
  reason?: string;
}

export interface DataProvider {
  readonly name: string;
  readonly sourceUrl: string;
  /** True when this source is operated or authorized by the rights holder. */
  readonly isOfficial: boolean;
  capabilities(): CapabilityReport[];
  fetchFighterIndex(): Promise<string[]>;
  fetchFighterProfile(sourceId: string): Promise<NormalizedFighterRecord | null>;
  fetchRankings(): Promise<NormalizedRanking[]>;
  fetchEvents(): Promise<NormalizedEvent[]>;
  fetchBouts(eventSourceId: string): Promise<NormalizedBout[]>;
  fetchScheduledFights(): Promise<NormalizedBout[]>;
}

/**
 * Name normalization used to reconcile the same person across sources. Diacritics are
 * folded, punctuation and generational suffixes are dropped, and the result is a stable
 * matching key. It is a matching aid only; the displayed name always keeps its original
 * form from the source.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuplicateResolution {
  keptSourceId: string;
  droppedSourceId: string;
  reason: string;
}

/**
 * Resolves duplicate fighter records. The same athlete legitimately appears more than
 * once in a rankings crawl, for example as a division champion and as a pound for pound
 * entry. The record with the most complete data wins.
 */
export function resolveDuplicates(records: NormalizedFighterRecord[]): {
  unique: NormalizedFighterRecord[];
  resolutions: DuplicateResolution[];
} {
  const byKey = new Map<string, NormalizedFighterRecord>();
  const resolutions: DuplicateResolution[] = [];
  for (const rec of records) {
    const key = normalizeName(rec.name) + '|' + (rec.birthDate ?? rec.age ?? '');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rec);
      continue;
    }
    const keepNew = rec.missingFields.length < existing.missingFields.length;
    const kept = keepNew ? rec : existing;
    const dropped = keepNew ? existing : rec;
    byKey.set(key, kept);
    resolutions.push({
      keptSourceId: kept.sourceId,
      droppedSourceId: dropped.sourceId,
      reason: `duplicate identity, kept the record with ${dropped.missingFields.length - kept.missingFields.length} fewer missing fields`,
    });
  }
  return { unique: [...byKey.values()], resolutions };
}

/**
 * Active roster determination. A fighter enters the default playable roster only with
 * positive evidence of current status. Anything uncertain is marked and excluded rather
 * than assumed active.
 */
export interface ActivityEvidence {
  officialStatus: string | null;
  hasCurrentRanking: boolean;
  recentFightWithinDays: number | null;
  hasScheduledFight: boolean;
  manualOverride: ActivityStatus | null;
}

export function determineActivityStatus(e: ActivityEvidence): { status: ActivityStatus; reason: string } {
  if (e.manualOverride) return { status: e.manualOverride, reason: 'manual correction file' };
  const official = (e.officialStatus ?? '').toLowerCase();
  if (official === 'retired') return { status: 'retired', reason: 'official profile status' };
  if (official === 'not fighting' || official === 'released') return { status: 'released', reason: 'official profile status' };
  if (official === 'suspended') return { status: 'suspended', reason: 'official profile status' };
  if (official === 'active') return { status: 'active', reason: 'official profile status' };
  if (e.hasCurrentRanking) return { status: 'active', reason: 'appears in the current official rankings' };
  if (e.hasScheduledFight) return { status: 'active', reason: 'has a scheduled bout' };
  if (e.recentFightWithinDays !== null && e.recentFightWithinDays <= 540) {
    return { status: 'active', reason: 'competed within the last eighteen months' };
  }
  if (e.recentFightWithinDays !== null) return { status: 'inactive', reason: 'no bout in over eighteen months' };
  return { status: 'unverified', reason: 'no evidence of current status' };
}

export interface SnapshotBuildResult {
  meta: SnapshotMeta;
  records: NormalizedFighterRecord[];
  rankings: NormalizedRanking[];
}
