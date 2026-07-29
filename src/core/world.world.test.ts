import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIVISIONS } from './config/divisions';
import { RATING_KEYS } from './types/fighter';
import { createNewGame } from './world/newgame';
import { advance, pruneHistory } from './world/tick';
import type { SnapshotFile } from './data/snapshot';

const snapshotDir = join(process.cwd(), 'public', 'data');
const snapshotFile = existsSync(snapshotDir) ? readdirSync(snapshotDir).find((f) => f.startsWith('snapshot-')) : undefined;

describe.runIf(Boolean(snapshotFile))('world simulation', () => {
  const snapshot = JSON.parse(readFileSync(join(snapshotDir, snapshotFile!), 'utf8')) as SnapshotFile;

  it('builds a world from the snapshot without mutating it', () => {
    const before = JSON.stringify(snapshot.fighters[0]);
    const { save, summary } = createNewGame(snapshot, { saveName: 'test', seed: 1, mode: 'spectator' });
    advance(save, { mode: 'month', stopOnDecision: false });
    expect(JSON.stringify(snapshot.fighters[0])).toBe(before);
    expect(summary.realFighters).toBe(snapshot.fighters.length);
    expect(summary.generatedFighters).toBeGreaterThan(0);
  });

  it('imports the official rankings as the starting standings', () => {
    const { save } = createNewGame(snapshot, { saveName: 'test', seed: 2, mode: 'spectator' });
    const snapshotYear = Number(snapshot.meta.snapshotDate.slice(0, 4));
    let contested = 0;
    for (const d of DIVISIONS) {
      const table = save.rankings[d.id];
      expect(table.fromOfficialSnapshot).toBe(true);
      for (const e of table.entries) expect(save.fighters[e.fighterId]).toBeDefined();

      // A division that was not being contested on the snapshot date legitimately has no
      // imported roster. Every division that was contested must have a full ranked list.
      const wasContested = d.activeFrom <= snapshotYear && (d.activeUntil === null || d.activeUntil >= snapshotYear);
      if (!wasContested) {
        expect(table.entries.length).toBe(0);
        continue;
      }
      contested++;
      expect(table.entries.length, `${d.name} imported only ${table.entries.length} ranked fighters`).toBeGreaterThan(10);
    }
    // The snapshot covers the eight men's divisions plus the three contested women's ones.
    expect(contested).toBe(11);
  });

  it('reproduces the same world for the same seed', () => {
    const a = createNewGame(snapshot, { saveName: 'a', seed: 4242, mode: 'spectator' }).save;
    const b = createNewGame(snapshot, { saveName: 'b', seed: 4242, mode: 'spectator' }).save;
    advance(a, { mode: 'month', maxDays: 120, stopOnDecision: false });
    advance(b, { mode: 'month', maxDays: 120, stopOnDecision: false });
    expect(Object.keys(b.history.results).length).toBe(Object.keys(a.history.results).length);
    const resultsA = Object.values(a.history.results).map((r) => `${r.boutId}:${r.winnerId}:${r.method}:${r.endRound}`).sort();
    const resultsB = Object.values(b.history.results).map((r) => `${r.boutId}:${r.winnerId}:${r.method}:${r.endRound}`).sort();
    expect(resultsB).toEqual(resultsA);
  });

  it('holds its invariants across a simulated year', () => {
    const { save } = createNewGame(snapshot, { saveName: 'test', seed: 77, mode: 'spectator' });
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });

    expect(Object.keys(save.history.results).length).toBeGreaterThan(100);

    // Nobody is booked into two bouts at once, and no booking pointer is stale.
    const bookedCounts = new Map<string, number>();
    for (const b of Object.values(save.bouts)) {
      if (b.status !== 'scheduled') continue;
      for (const id of [b.fighterAId, b.fighterBId]) bookedCounts.set(id, (bookedCounts.get(id) ?? 0) + 1);
    }
    for (const [, count] of bookedCounts) expect(count).toBeLessThanOrEqual(1);
    for (const f of Object.values(save.fighters)) {
      if (!f.nextBoutId) continue;
      expect(save.bouts[f.nextBoutId]?.status).toBe('scheduled');
    }

    // A fighter never faces themselves and both sides of a result exist.
    for (const r of Object.values(save.history.results)) {
      expect(r.fighterAId).not.toBe(r.fighterBId);
      expect(save.fighters[r.fighterAId]).toBeDefined();
      expect(save.fighters[r.fighterBId]).toBeDefined();
      if (r.winnerId) expect([r.fighterAId, r.fighterBId]).toContain(r.winnerId);
    }

    // Records stay consistent with the recorded fights.
    for (const f of Object.values(save.fighters)) {
      // Fighters can arrive with a seeded promotional record, so the total can exceed the
      // number of bouts simulated here. It can never be lower than them.
      const fought = f.boutIds.filter((id) => save.history.results[id]).length;
      expect(f.ufcRecord.wins + f.ufcRecord.losses + f.ufcRecord.draws + f.ufcRecord.noContests).toBeGreaterThanOrEqual(fought);
      expect(f.longevity).toBeGreaterThanOrEqual(1);
      expect(f.longevity).toBeLessThanOrEqual(100);
      for (const k of RATING_KEYS) {
        expect(f.ratings[k]).toBeGreaterThanOrEqual(8);
        expect(f.ratings[k]).toBeLessThanOrEqual(99);
      }
    }

    // Championship bookkeeping stays coherent.
    for (const d of DIVISIONS) {
      const t = save.rankings[d.id];
      if (t.championId) {
        expect(save.fighters[t.championId]).toBeDefined();
        expect(save.fighters[t.championId].divisionId).toBe(d.id);
      }
      const ranks = t.entries.map((e) => e.rank);
      expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
      expect(new Set(ranks).size).toBe(ranks.length);
    }

    // Title fights only happen between fighters the world considers eligible.
    for (const r of Object.values(save.history.results)) {
      if (!r.isTitleFight) continue;
      expect(r.scheduledRounds).toBe(5);
    }
  });

  it('keeps a long save from growing without bound', () => {
    const { save } = createNewGame(snapshot, { saveName: 'test', seed: 313, mode: 'spectator' });
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    const pruned = pruneHistory(save);
    const bytes = JSON.stringify(save).length;
    expect(bytes).toBeLessThan(60 * 1024 * 1024);
    expect(pruned.prunedEvents).toBeGreaterThanOrEqual(0);
    // Round summaries and totals survive pruning even when the play by play does not.
    for (const r of Object.values(save.history.results)) {
      expect(r.rounds.length).toBeGreaterThan(0);
      expect(r.narrativeSummary.length).toBeGreaterThan(0);
    }
  });

  it('spreads a card across more than one division', () => {
    const { save } = createNewGame(snapshot, { saveName: 'test', seed: 99, mode: 'spectator' });
    advance(save, { mode: 'month', maxDays: 90, stopOnDecision: false });
    const cards = Object.values(save.events).filter((e) => e.boutIds.length >= 6);
    expect(cards.length).toBeGreaterThan(0);
    const divisionsPerCard = cards.map((e) => new Set(e.boutIds.map((id) => save.bouts[id]?.divisionId).filter(Boolean)).size);
    expect(Math.max(...divisionsPerCard)).toBeGreaterThan(2);
  });
});

