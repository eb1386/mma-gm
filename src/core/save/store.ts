import { get, set, del, keys } from 'idb-keyval';
import type { SaveGame, SaveIndexEntry } from '../types/save';
import { SAVE_SCHEMA_VERSION } from '../types/save';
import { migrateSave } from './migrate';
import { GAME_NAME } from '../config/branding';

/**
 * Export format tag.
 *
 * The legacy tag is still accepted on import, so a career exported before the rename still
 * loads. Import does not require the tag at all: it only needs the save object.
 */
export const SAVE_FORMAT = 'mma-gm-save';
export const LEGACY_SAVE_FORMATS = ['octagon-gm-save'];

/**
 * Save persistence.
 *
 * Saves live in IndexedDB because a long career is far larger than local storage allows.
 * Every save also exports to a single JSON file so a career can be moved between
 * machines or archived.
 */

const SAVE_PREFIX = 'octagon-save:';
const INDEX_KEY = 'octagon-save-index';
const AUTOSAVE_KEY = 'octagon-autosave-id';

function saveKey(id: string): string {
  return `${SAVE_PREFIX}${id}`;
}

export async function listSaves(): Promise<SaveIndexEntry[]> {
  const index = (await get<SaveIndexEntry[]>(INDEX_KEY)) ?? [];
  return [...index].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
}

function indexEntryFor(save: SaveGame): SaveIndexEntry {
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  return {
    saveId: save.saveId,
    saveName: save.saveName,
    mode: save.player.mode,
    date: save.date,
    updatedAt: save.updatedAt,
    fighterName: fighter?.name ?? null,
    gymName: gym?.name ?? null,
    snapshotId: save.snapshot.snapshotId,
    schemaVersion: save.schemaVersion,
  };
}

export async function saveGame(save: SaveGame): Promise<void> {
  save.updatedAt = new Date().toISOString();
  await set(saveKey(save.saveId), save);
  const index = (await get<SaveIndexEntry[]>(INDEX_KEY)) ?? [];
  const next = index.filter((e) => e.saveId !== save.saveId);
  next.push(indexEntryFor(save));
  await set(INDEX_KEY, next);
  await set(AUTOSAVE_KEY, save.saveId);
}

export async function loadGame(saveId: string): Promise<SaveGame | null> {
  const raw = await get<SaveGame>(saveKey(saveId));
  if (!raw) return null;
  return migrateSave(raw);
}

export async function deleteSave(saveId: string): Promise<void> {
  await del(saveKey(saveId));
  const index = (await get<SaveIndexEntry[]>(INDEX_KEY)) ?? [];
  await set(
    INDEX_KEY,
    index.filter((e) => e.saveId !== saveId)
  );
}

export async function lastPlayedSaveId(): Promise<string | null> {
  return (await get<string>(AUTOSAVE_KEY)) ?? null;
}

export async function renameSave(saveId: string, name: string): Promise<void> {
  const save = await loadGame(saveId);
  if (!save) return;
  save.saveName = name;
  await saveGame(save);
}

/** Rebuilds the index by scanning the store. Used if the index is ever lost. */
export async function repairIndex(): Promise<SaveIndexEntry[]> {
  const allKeys = (await keys()) as string[];
  const entries: SaveIndexEntry[] = [];
  for (const k of allKeys) {
    if (typeof k !== 'string' || !k.startsWith(SAVE_PREFIX)) continue;
    const save = await get<SaveGame>(k);
    if (save) entries.push(indexEntryFor(save));
  }
  await set(INDEX_KEY, entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

export function exportSaveToBlob(save: SaveGame): Blob {
  const payload = {
    format: SAVE_FORMAT,
    schemaVersion: SAVE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    save,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export function downloadSave(save: SaveGame): void {
  const blob = exportSaveToBlob(save);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mma-gm-${save.saveName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${save.date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function importSaveFromFile(file: File): Promise<SaveGame> {
  const text = await file.text();
  const parsed = JSON.parse(text) as { format?: string; save?: SaveGame } | SaveGame;
  const save = 'save' in parsed && parsed.save ? parsed.save : (parsed as SaveGame);
  if (!save || typeof save !== 'object' || !('fighters' in save)) {
    throw new Error(`That file is not an ${GAME_NAME} save.`);
  }
  const migrated = migrateSave(save);
  // A fresh id avoids overwriting an existing save with the same identifier.
  migrated.saveId = `save-import-${Date.now().toString(36)}`;
  await saveGame(migrated);
  return migrated;
}

/** Rough size of a save in bytes, shown on the load screen. */
export function estimateSaveSize(save: SaveGame): number {
  return JSON.stringify(save).length;
}
