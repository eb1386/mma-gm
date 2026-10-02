import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An in memory stand in for idb-keyval, so the store's writes can be counted. Node has no
 * IndexedDB, and what matters here is which keys were written and when, not the browser's store.
 */
const kv = vi.hoisted(() => {
  const data = new Map<unknown, unknown>();
  const writes: unknown[][] = [];
  return { data, writes };
});
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (k: unknown) => kv.data.get(k)),
  set: vi.fn(async (k: unknown, v: unknown) => {
    kv.writes.push([k]);
    kv.data.set(k, v);
  }),
  setMany: vi.fn(async (entries: [unknown, unknown][]) => {
    kv.writes.push(entries.map(([k]) => k));
    for (const [k, v] of entries) kv.data.set(k, v);
  }),
  update: vi.fn(async (k: unknown, fn: (old: unknown) => unknown) => {
    kv.writes.push([k]);
    kv.data.set(k, fn(kv.data.get(k)));
  }),
  keys: vi.fn(async () => [...kv.data.keys()]),
  createStore: vi.fn(),
  promisifyRequest: vi.fn(),
}));

import { newCareer } from '../testing/fixtures';
import { importSaveFromText, listSaves, saveExportFileName, saveGame } from './store';
import { migrateSave } from './migrate';

const asText = (save: unknown) => JSON.stringify({ format: 'mma-gm-save', save });

beforeEach(() => {
  kv.data.clear();
  kv.writes.length = 0;
});

describe('schema 22 moves the old calendar default and nothing else', () => {
  const fixture = newCareer(5150, { light: true });
  const at = (eventsPerMonth: number) => {
    const save = structuredClone(fixture.save);
    save.schemaVersion = 21;
    save.settings.eventsPerMonth = eventsPerMonth;
    return migrateSave(save).settings.eventsPerMonth;
  };

  it('moves 3.83, the old default, to 4', () => {
    expect(at(3.83)).toBe(4);
  });

  it('leaves a value the player chose alone', () => {
    expect(at(3.8)).toBe(3.8);
    expect(at(5)).toBe(5);
  });
});

describe('importing a damaged save writes nothing', () => {
  const fixture = newCareer(5151, { light: true });

  it('refuses a save with no snapshot, and leaves storage untouched', async () => {
    const broken = structuredClone(fixture.save) as unknown as Record<string, unknown>;
    delete broken.snapshot;
    await expect(importSaveFromText(asText(broken))).rejects.toThrow(/damaged.*snapshot/i);
    expect(kv.writes).toHaveLength(0);
    expect(kv.data.size).toBe(0);
  });

  it('refuses a save with no gyms or no valid mode', async () => {
    const noGyms = structuredClone(fixture.save) as unknown as Record<string, unknown>;
    delete noGyms.gyms;
    await expect(importSaveFromText(asText(noGyms))).rejects.toThrow(/gyms/i);
    const badMode = structuredClone(fixture.save);
    (badMode.player as { mode: string }).mode = 'manager';
    await expect(importSaveFromText(asText(badMode))).rejects.toThrow(/fighter, a coach or a spectator/i);
    expect(kv.writes).toHaveLength(0);
  });

  it('refuses a career whose fighter is missing from the file', async () => {
    const orphan = structuredClone(fixture.save);
    orphan.player.fighterId = 'nobody';
    await expect(importSaveFromText(asText(orphan))).rejects.toThrow(/fighter is not in the file/i);
    expect(kv.writes).toHaveLength(0);
  });

  it('imports a whole save in one write, with a name that tells it from the original', async () => {
    await saveGame(structuredClone(fixture.save));
    kv.writes.length = 0;
    const nameless = structuredClone(fixture.save);
    const imported = await importSaveFromText(asText(fixture.save));
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0]).toHaveLength(3);
    expect(imported.saveName).toBe(`${fixture.save.saveName} (imported)`);
    const list = await listSaves();
    expect(list).toHaveLength(2);
    // The card summary travels with the index entry.
    expect(list.every((e) => e.summary?.state)).toBe(true);
    // A save with no name gets one, and the export file name never comes out empty.
    (nameless as { saveName: unknown }).saveName = undefined;
    expect(migrateSave(nameless).saveName).toBe('Imported career');
    expect(saveExportFileName({ ...fixture.save, saveName: 'Карьера' })).toBe(`mma-gm-career-${fixture.save.date}.json`);
  });

  it('rebuilds a lost index from the stored saves rather than showing none', async () => {
    await saveGame(structuredClone(fixture.save));
    kv.data.delete('octagon-save-index');
    const list = await listSaves();
    expect(list.map((e) => e.saveId)).toEqual([fixture.save.saveId]);
  });
});
