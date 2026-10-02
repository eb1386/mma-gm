import { get, set, keys, setMany, update, createStore, promisifyRequest, type UseStore } from 'idb-keyval';
import type { SaveGame, SaveIndexEntry } from '../types/save';
import { SAVE_SCHEMA_VERSION } from '../types/save';
import { migrateSave } from './migrate';
import { summarizeCareer } from './summary';
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

/**
 * The store idb-keyval uses by default, opened by name for the one write it has no helper for: a
 * delete and a put in the same transaction. It is opened on first use, because opening it at import
 * would touch IndexedDB in places that have none, such as the test runner.
 */
let keyvalStore: UseStore | null = null;
function defaultStore(): UseStore {
  if (!keyvalStore) keyvalStore = createStore('keyval-store', 'keyval');
  return keyvalStore;
}

/**
 * Every write to the index goes through this queue.
 *
 * The index is read, changed and written back, so two writes that overlapped (the autosave of one
 * career and the copy of another, say) could each read the old index and the second would drop
 * the first one's entry. One at a time, neither can.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work);
  writeQueue = run.catch(() => undefined);
  return run;
}

function isSaveKey(k: IDBValidKey): k is string {
  return typeof k === 'string' && k.startsWith(SAVE_PREFIX);
}

export async function listSaves(): Promise<SaveIndexEntry[]> {
  let index = (await get<SaveIndexEntry[]>(INDEX_KEY)) ?? [];
  // An index that is missing or empty while careers are stored means the index write was lost, not
  // that there are no careers. Rebuilding reads every full save, so it only happens in that case.
  if (index.length === 0 && (await keys()).some(isSaveKey)) index = await repairIndex();
  return [...index].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
}

function indexEntryFor(save: SaveGame): SaveIndexEntry {
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  let summary: SaveIndexEntry['summary'];
  try {
    summary = summarizeCareer(save);
  } catch {
    // The card can do without its detail. A summary must never be the reason a save is not written.
    summary = undefined;
  }
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
    summary,
  };
}

/**
 * Writes the save, its index entry and the last played id in one transaction.
 *
 * They were three separate writes, so a failure after the first left a career stored that the
 * list never showed. The index entry is also worked out before anything is written: a save it
 * cannot describe (a damaged import with no snapshot) used to leave a full record behind with no
 * entry, which nothing listed and nothing could delete.
 */
export function saveGame(save: SaveGame): Promise<void> {
  return serialized(async () => {
    save.updatedAt = new Date().toISOString();
    const entry = indexEntryFor(save);
    const index = (await get<SaveIndexEntry[]>(INDEX_KEY)) ?? [];
    const next = index.filter((e) => e.saveId !== save.saveId);
    next.push(entry);
    await setMany([
      [saveKey(save.saveId), save],
      [INDEX_KEY, next],
      [AUTOSAVE_KEY, save.saveId],
    ]);
  });
}

/**
 * Rewrites one career's index entry from a save already in memory, without writing the save.
 *
 * Used to fill in the card summary for an entry an older build wrote, and to keep the card in step
 * with the career being played between its writes.
 */
export function updateIndexEntry(save: SaveGame): Promise<SaveIndexEntry> {
  return serialized(async () => {
    const entry = indexEntryFor(save);
    await update<SaveIndexEntry[]>(INDEX_KEY, (index) => {
      const list = index ?? [];
      // Only an entry that still exists is replaced. A career deleted meanwhile stays deleted.
      return list.some((e) => e.saveId === save.saveId) ? list.map((e) => (e.saveId === save.saveId ? entry : e)) : list;
    });
    return entry;
  });
}

export async function loadGame(saveId: string): Promise<SaveGame | null> {
  const raw = await get<SaveGame>(saveKey(saveId));
  if (!raw) return null;
  return migrateSave(raw);
}

/** Removes the record and its index entry together, so neither can outlive the other. */
export function deleteSave(saveId: string): Promise<void> {
  return serialized(() =>
    defaultStore()('readwrite', (store) => {
      store.delete(saveKey(saveId));
      const read = store.get(INDEX_KEY);
      read.onsuccess = () => {
        const index = (read.result as SaveIndexEntry[] | undefined) ?? [];
        store.put(
          index.filter((e) => e.saveId !== saveId),
          INDEX_KEY
        );
      };
      return promisifyRequest(store.transaction);
    })
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

/**
 * Rebuilds the index by scanning the store. Used when the index is lost.
 *
 * A record that cannot be described is skipped, not deleted: it may be the only copy of someone's
 * career, and it can still be reached by a later build that understands it.
 */
export function repairIndex(): Promise<SaveIndexEntry[]> {
  return serialized(async () => {
    const allKeys = await keys();
    const entries: SaveIndexEntry[] = [];
    for (const k of allKeys) {
      if (!isSaveKey(k)) continue;
      try {
        const raw = await get<SaveGame>(k);
        if (!raw) continue;
        let save = raw;
        try {
          save = migrateSave(raw);
        } catch {
          // Described as it is stored. Opening it will report why it cannot be upgraded.
        }
        entries.push(indexEntryFor(save));
      } catch {
        // Not a save this build can list.
      }
    }
    await set(INDEX_KEY, entries);
    return entries;
  });
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

/** The text of an export file. The device backup in the iPhone app is the same format, so it restores through import. */
export function exportSaveToText(save: SaveGame): string {
  const payload = {
    format: SAVE_FORMAT,
    schemaVersion: SAVE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    save,
  };
  return JSON.stringify(payload);
}

export function exportSaveToBlob(save: SaveGame): Blob {
  return new Blob([exportSaveToText(save)], { type: 'application/json' });
}

export function saveExportFileName(save: SaveGame): string {
  // A name with no Latin letters or digits (a name in Cyrillic, say) left nothing between the
  // dashes, and a save with no name at all threw here.
  const slug = (save.saveName ?? '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `mma-gm-${slug || 'career'}-${save.date}.json`;
}

/**
 * The parts of a save without which there is no world to load.
 *
 * Checked before migration rather than after, because the migration walks these structures and a
 * file missing one of them produced an internal error like "Cannot read properties of undefined
 * (reading 'retirements')". That tells a player nothing about the file they chose.
 */
const REQUIRED_SAVE_KEYS = ['fighters', 'player', 'date', 'rankings', 'history', 'events', 'bouts'] as const;

function missingSaveKeys(save: unknown): string[] {
  if (!save || typeof save !== 'object') return [...REQUIRED_SAVE_KEYS];
  const record = save as Record<string, unknown>;
  return REQUIRED_SAVE_KEYS.filter((k) => record[k] === undefined || record[k] === null);
}

const PLAYER_MODES = new Set(['fighter', 'coach', 'spectator']);

/**
 * Structure that has to be right before migration can run. The required keys only say a field is
 * present; these say the world can be rebuilt from it. A file with no snapshot left a full record
 * stored with no index entry and the internal error "Cannot read properties of undefined", and a
 * file with no gyms imported "successfully" and crashed the gyms page.
 */
function structuralProblem(save: SaveGame): string | null {
  const record = save as unknown as Record<string, unknown>;
  const snapshot = record.snapshot as { snapshotId?: unknown } | undefined;
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId) {
    return 'It does not say which roster snapshot the world was built from.';
  }
  if (!record.gyms || typeof record.gyms !== 'object') return 'It has no gyms.';
  const player = record.player as { mode?: unknown } | undefined;
  if (!player || typeof player !== 'object' || !PLAYER_MODES.has(String(player.mode))) {
    return 'It does not say whether the career is a fighter, a coach or a spectator.';
  }
  return null;
}

/** After migration: the player has to point at someone who exists. */
function playerProblem(save: SaveGame): string | null {
  if (save.player.fighterId && !save.fighters[save.player.fighterId]) {
    return "The career's fighter is not in the file.";
  }
  if (save.player.gymId && !save.gyms[save.player.gymId]) {
    return "The career's gym is not in the file.";
  }
  return null;
}

export interface ImportOptions {
  /**
   * Keeps the save's own id. Only for restoring a career's own backup, which has to stay the same
   * career; an import from a file always gets a fresh id so it can never overwrite a career.
   */
  keepSaveId?: boolean;
}

/** Validates, upgrades and stores a save from the text of an export file. Nothing is written unless all of it passes. */
export async function importSaveFromText(text: string, opts: ImportOptions = {}): Promise<SaveGame> {
  let parsed: { format?: string; save?: SaveGame } | SaveGame;
  try {
    parsed = JSON.parse(text) as { format?: string; save?: SaveGame } | SaveGame;
  } catch {
    throw new Error(`That file is not readable as ${GAME_NAME} save data.`);
  }
  const save = parsed && typeof parsed === 'object' && 'save' in parsed && parsed.save ? parsed.save : (parsed as SaveGame);
  const missing = missingSaveKeys(save);
  if (missing.length > 0) {
    throw new Error(
      `That file is not an ${GAME_NAME} save. It is missing ${missing.length === REQUIRED_SAVE_KEYS.length ? 'everything a save needs' : missing.join(', ')}.`
    );
  }
  const broken = structuralProblem(save);
  if (broken) throw new Error(`That save file is damaged. ${broken}`);
  let migrated: SaveGame;
  try {
    migrated = migrateSave(save);
  } catch (err) {
    // A save from a newer build reports that clearly and is worth passing through as it is.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('newer version')) throw err;
    throw new Error(`That save could not be upgraded to this version of ${GAME_NAME}. ${message}`);
  }
  const orphaned = playerProblem(migrated);
  if (orphaned) throw new Error(`That save file is damaged. ${orphaned}`);
  if (!opts.keepSaveId || !migrated.saveId) {
    // A fresh id avoids overwriting an existing save with the same identifier.
    migrated.saveId = `save-import-${Date.now().toString(36)}`;
    // Two cards with the same name and nothing to tell them apart is how the wrong one gets deleted.
    const names = new Set((await listSaves()).map((e) => e.saveName));
    if (names.has(migrated.saveName)) migrated.saveName = `${migrated.saveName} (imported)`;
  }
  await saveGame(migrated);
  return migrated;
}

export async function importSaveFromFile(file: File): Promise<SaveGame> {
  return importSaveFromText(await file.text());
}

/**
 * Rough size of a save, in characters of its export, which is close to bytes for this data. Shown
 * in Settings. It serialises the whole world, so it is never called while drawing a page.
 */
export function estimateSaveSize(save: SaveGame): number {
  return JSON.stringify(save).length;
}
