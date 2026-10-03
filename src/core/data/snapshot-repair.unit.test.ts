import { describe, expect, it } from 'vitest';
import { loadSnapshot } from '../testing/fixtures';
import { createNewGame } from '../world/newgame';
import { needsSnapshotRepair, repairFromSnapshot } from './snapshot-repair';

describe('repairing an older save from the current snapshot', () => {
  it('restores unknown countries and missing official stats without touching simulated state', () => {
    const snapshot = loadSnapshot();
    const { save } = createNewGame(snapshot, { saveName: 'old', seed: 77, mode: 'spectator', settings: { potPaths: 6 } });
    // Make it look like a career started from the July roster, which never had the repair run.
    delete save.snapshotRepairedFrom;
    const real = Object.values(save.fighters).filter((f) => f.isRealPerson).slice(0, 40);
    for (const f of real) {
      f.country = 'Unknown';
      f.countryCode = '';
      f.hometown = null;
      delete f.officialStats;
      f.record.wins += 3; // a simulated change the repair must leave alone
    }
    expect(needsSnapshotRepair(save)).toBe(true);
    const ratingsBefore = JSON.stringify(real.map((f) => f.ratings));

    const changed = repairFromSnapshot(save, snapshot);
    expect(changed).toBe(40);
    for (const f of real) {
      const src = snapshot.fighters.find((s) => s.id === f.id)!;
      expect(f.country).toBe(src.country);
      expect(f.countryCode).toBe(src.countryCode);
      expect(f.officialStats).toBeTruthy();
      expect(f.record.wins).toBe(src.record.wins + 3);
    }
    expect(JSON.stringify(real.map((f) => f.ratings))).toBe(ratingsBefore);
    expect(needsSnapshotRepair(save)).toBe(false);
    expect(repairFromSnapshot(save, snapshot)).toBe(0);
  });
});
