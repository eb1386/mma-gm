import type { DivisionId } from '../config/divisions';
import type { FighterId, GymId } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { Gym, GymStaff } from '../types/world';
import type { SnapshotMeta } from '../types/save';

/**
 * A snapshot is an immutable record of sourced real world facts plus the ratings derived
 * from them. It contains no simulated history. Creating a new game copies a snapshot into
 * the save, after which the save's world diverges and never writes back here.
 */
export interface SnapshotFile {
  meta: SnapshotMeta;
  fighters: Fighter[];
  gyms: Gym[];
  staff: GymStaff[];
  rankings: {
    divisionId: DivisionId;
    championId: FighterId | null;
    interimChampionId: FighterId | null;
    entries: { rank: number; fighterId: FighterId }[];
  }[];
  pfp: { entries: { rank: number; fighterId: FighterId }[] };
  gymNameToId: Record<string, GymId>;
}

export interface SnapshotIndexEntry {
  snapshotId: string;
  snapshotDate: string;
  label: string;
  file: string;
  fighterCount: number;
  isLatest: boolean;
}

export interface SnapshotIndex {
  snapshots: SnapshotIndexEntry[];
  generatedAt: string;
}

declare const __VITE_BASE__: string | undefined;

/** Base path for bundled snapshot files. Works under any deployment sub path. */
function dataBase(): string {
  const meta = import.meta as unknown as { env?: { BASE_URL?: string } };
  return `${meta.env?.BASE_URL ?? '/'}data/`;
}
const BASE = dataBase();
void (typeof __VITE_BASE__);

export async function loadSnapshotIndex(): Promise<SnapshotIndex> {
  const res = await fetch(`${BASE}snapshots.json`);
  if (!res.ok) throw new Error(`Could not load the snapshot index (${res.status}).`);
  return (await res.json()) as SnapshotIndex;
}

export async function loadSnapshot(file: string): Promise<SnapshotFile> {
  const res = await fetch(`${BASE}${file}`);
  if (!res.ok) throw new Error(`Could not load snapshot ${file} (${res.status}).`);
  return (await res.json()) as SnapshotFile;
}

/** Summary of what is real and what is a model estimate, shown on the data page. */
export function snapshotProvenanceSummary(snap: SnapshotFile): {
  sourcedFields: number;
  derivedRatings: number;
  unknownFields: number;
  sources: string[];
} {
  let sourced = 0;
  let unknown = 0;
  const sources = new Set<string>();
  for (const f of snap.fighters) {
    for (const [, prov] of Object.entries(f.provenance)) {
      sourced++;
      sources.add(prov.source);
    }
    if (f.birthDate === null) unknown++;
    if (f.heightIn === null) unknown++;
    if (f.reachIn === null) unknown++;
  }
  return {
    sourcedFields: sourced,
    derivedRatings: snap.fighters.length * 6,
    unknownFields: unknown,
    sources: [...sources],
  };
}
