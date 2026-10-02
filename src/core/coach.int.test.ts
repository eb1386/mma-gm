import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from './rng';
import { addDays } from './types/common';
import type { SaveGame } from './types/save';
import type { SnapshotFile } from './data/snapshot';
import { createNewGame } from './world/newgame';
import {
  buyGymUpgrade,
  generateStaffCandidates,
  hireStaff,
  moveFighterToGym,
  pitchFighter,
  recruitmentChance,
  runGymMonth,
  staffCandidateRng,
  switchGym,
} from './world/gyms';
import { decayRelationships, ensureRelationship, relationshipState } from './world/relationships';

/**
 * Coach Mode: running a gym.
 *
 * A pitch that can be repeated until it lands, an upgrade that keeps taking money once it does
 * nothing, a hiring pool that offers the person just hired, and a new gym that cannot pay its own
 * rent are each a gym the player cannot really run.
 */

const DATA = join(process.cwd(), 'public', 'data');
const snapshotFile = existsSync(DATA) ? readdirSync(DATA).find((f) => f.startsWith('snapshot-')) : undefined;

let snapshot: SnapshotFile;

beforeAll(() => {
  if (!snapshotFile) throw new Error('Build the snapshot first: npx vite-node tools/build-snapshot.ts');
  snapshot = JSON.parse(readFileSync(join(DATA, snapshotFile), 'utf8')) as SnapshotFile;
});

function coachSave(seed: number): SaveGame {
  return createNewGame(snapshot, {
    saveName: 'coach',
    seed,
    mode: 'coach',
    coach: { name: 'Test Coach', newGym: { name: 'Test Gym', country: 'United States', city: 'Denver' } },
  }).save;
}

describe('Coach Mode gym', () => {
  it('remembers a refused pitch and will not take another one during the cooldown', () => {
    const save = coachSave(9061);
    const gym = save.gyms[save.player.gymId!];
    const candidates = Object.values(save.fighters).filter((f) => !f.retired && f.gymId !== gym.id && recruitmentChance(save, gym, f) > 0);
    const refused = candidates.find((f) => !pitchFighter(save, gym.id, f.id).joined);
    expect(refused).toBeTruthy();
    expect(gym.pitchRefusals?.[refused!.id]).toBe(save.date);
    expect(recruitmentChance(save, gym, refused!)).toBe(0);
    const again = pitchFighter(save, gym.id, refused!.id);
    expect(again.joined).toBe(false);
    expect(again.message).toContain('turned you down');
    save.date = addDays(save.date, 61);
    expect(pitchFighter(save, gym.id, refused!.id).message).not.toContain('not ready to hear it again');
  });

  it('offers a fresh candidate pool after a hire', () => {
    const save = coachSave(9062);
    const gym = save.gyms[save.player.gymId!];
    const first = generateStaffCandidates(save, gym, 'striking-coach', staffCandidateRng(save, 'striking-coach'));
    const pick = first[0];
    const hired = hireStaff(save, gym, pick.role, new Rng(`${save.seed}-hire-${pick.id}`), pick.quality);
    hired.name = pick.name;
    const second = generateStaffCandidates(save, gym, 'striking-coach', staffCandidateRng(save, 'striking-coach'));
    expect(second.map((c) => c.name)).not.toContain(pick.name);
  });

  it('refuses an upgrade that would change nothing', () => {
    const save = coachSave(9063);
    const gym = save.gyms[save.player.gymId!];
    gym.balance = 1_000_000;
    gym.culture = 99;
    expect(buyGymUpgrade(save, gym.id, 'culture').ok).toBe(false);
    expect(gym.balance).toBe(1_000_000);
  });

  it('a fresh gym with a working roster is near break even', () => {
    const save = coachSave(9064);
    const gym = save.gyms[save.player.gymId!];
    expect(gym.monthlyCosts).toBeLessThan(12_500);
    const recruits = Object.values(save.fighters)
      .filter((f) => !f.retired && !f.circuit && f.gymId !== gym.id)
      .slice(0, 8);
    for (const f of recruits) moveFighterToGym(save, f.id, gym.id);
    save.date = addDays(save.date, 40);
    expect(Math.abs(runGymMonth(save, gym).net)).toBeLessThan(5000);
  });
});

describe('relationships after a gym change', () => {
  it('old teammates are no longer training partners after switchGym', () => {
    const save = coachSave(9065);
    const from = Object.values(save.gyms).find((g) => g.fighterIds.length >= 2 && !g.isPlayerControlled)!;
    const [a, b] = from.fighterIds.map((id) => save.fighters[id]);
    const r = ensureRelationship(save, a.id, b.id);
    r.friendship = 60;
    expect(relationshipState(r)).toBe('training-partner');
    const to = Object.values(save.gyms).find((g) => g.id !== from.id && !g.isPlayerControlled)!;
    expect(switchGym(save, a, to.id).ok).toBe(true);
    expect(relationshipState(r)).toBe('former-teammate');
  });

  it('drift does not move lastEventOn', () => {
    const save = coachSave(9066);
    const [a, b] = Object.values(save.fighters);
    const r = ensureRelationship(save, a.id, b.id);
    r.rivalry = 50;
    const lastEvent = r.lastEventOn;
    const start = save.date;
    for (let d = 7; d <= 400; d += 7) {
      save.date = addDays(start, d);
      decayRelationships(save);
    }
    expect(r.lastEventOn).toBe(lastEvent);
    expect(r.rivalry).toBeLessThan(50);
  });
});
