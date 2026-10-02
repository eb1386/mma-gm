import { describe, expect, it } from 'vitest';
import { loadSnapshot, newCareer, runWorld } from './testing/fixtures';
import { buildCreatedFighter, createNewGame, type CreateFighterInput } from './world/newgame';
import { CREATION_PRESETS } from './world/generator';
import { longevityFromWear } from './world/health';
import { migrateSave } from './save/migrate';
import { ageOn } from './types/common';
import { cleanNickname, parseGymLocation } from './data/real-fighter';

/**
 * Values that come from the real roster source: nicknames, countries, ages, official statistics and
 * gym locations, and the Longevity every fighter starts with. Each test is a rule a player noticed
 * broken: doubled quotes, a roster of Unknown countries, real fighters who never aged.
 */

function createdInput(overrides: Partial<CreateFighterInput> = {}): CreateFighterInput {
  const preset = CREATION_PRESETS.find((p) => p.key === 'balanced-prospect') ?? CREATION_PRESETS[0];
  const even = Math.floor(preset.points / 6);
  return {
    firstName: 'Alex',
    lastName: 'Vance',
    nickname: '"Iron"',
    country: 'United States',
    hometown: null,
    age: 25,
    heightIn: 70,
    walkingWeightLb: 176,
    divisionId: 'lightweight',
    build: 'balanced',
    reachIn: 72,
    stance: 'orthodox',
    gymId: null,
    presetKey: preset.key,
    allocation: { striking: even, grappling: even, wrestling: even, submissions: even, cardio: even, durability: even },
    startingRecord: { wins: 8, losses: 1 },
    ...overrides,
  };
}

describe('real roster snapshot data', () => {
  it('stores nicknames without the quotes the interface adds', () => {
    const snap = loadSnapshot();
    const quoted = snap.fighters.filter((f) => f.nickname && /^["“”]|["“”]$/.test(f.nickname));
    expect(quoted.map((f) => f.nickname)).toEqual([]);
    expect(snap.fighters.find((f) => f.id === 'ufc-joshua-van')?.nickname).toBe('The Fearless');
    expect(cleanNickname("Ragin'")).toBe("Ragin'");
    expect(cleanNickname('“The Fearless”')).toBe('The Fearless');
  });

  it('names a country for nearly every real fighter, with an ISO code', () => {
    const snap = loadSnapshot();
    const unknown = snap.fighters.filter((f) => f.country === 'Unknown').length;
    expect(unknown).toBeLessThanOrEqual(snap.fighters.length * 0.05);
    for (const f of snap.fighters) expect(f.countryCode).toMatch(/^[A-Z]{2}$/);
  });

  it('never stores placeholder official statistics or a card after the snapshot as the last one', () => {
    const snap = loadSnapshot();
    for (const f of snap.fighters) {
      const s = f.officialStats!;
      if ((s.takedownAvgPer15 ?? 0) > 0) expect(s.takedownAccuracyPct).not.toBe(0);
      expect(s.avgFightTime ?? '').not.toMatch(/^0+:00$/);
      if (s.strikeTarget) expect(s.strikeTarget.head + s.strikeTarget.body + s.strikeTarget.leg).toBeGreaterThan(0);
      if (s.lastEventDate) expect(s.lastEventDate <= snap.meta.snapshotDate).toBe(true);
    }
  });

  it('reads a gym city only from a location in the gym name', () => {
    expect(parseGymLocation('Xtreme Couture - Las Vegas, NV')).toEqual({ city: 'Las Vegas', country: 'United States', countryCode: 'US' });
    expect(parseGymLocation('MMA Factory - Paris, France')?.city).toBe('Paris');
    expect(parseGymLocation('American Top Team')).toBeNull();
    expect(parseGymLocation('KC Fight Base, Liverpool Combat Academy, The MMA Academy')).toBeNull();
    const snap = loadSnapshot();
    expect(snap.gyms.find((g) => g.name === 'Xtreme Couture - Las Vegas, NV')?.city).toBe('Las Vegas');
  });
});

describe('real fighters age', () => {
  it('estimates a birth date that gives the published age on the snapshot date', () => {
    const { save } = newCareer(41, { light: true });
    const real = Object.values(save.fighters).filter((f) => f.isRealPerson && f.ageAtSnapshot !== null);
    expect(real.length).toBeGreaterThan(100);
    for (const f of real) {
      expect(f.birthDateEstimated).toBe(true);
      expect(ageOn(f.birthDate, save.snapshot.snapshotDate)).toBe(f.ageAtSnapshot);
    }
  });

  it('is a year older after a year of play', () => {
    const { save } = newCareer(42, { light: true });
    const start = save.date;
    const before = new Map(
      Object.values(save.fighters)
        .filter((f) => f.isRealPerson)
        .map((f) => [f.id, ageOn(f.birthDate, start)!])
    );
    runWorld(save, 52);
    const diffs = [...before.entries()].map(([id, age]) => ageOn(save.fighters[id].birthDate, save.date)! - age);
    // 52 weeks is 364 days, so a fighter whose birthday falls on the last day of the year is not there yet.
    expect(diffs.filter((d) => d === 1).length).toBeGreaterThan(diffs.length * 0.99);
    expect(diffs.every((d) => d === 0 || d === 1)).toBe(true);
  });

  it('repairs a save made before the estimate, from the snapshot date rather than the save date', () => {
    const { save } = newCareer(43, { light: true });
    const van = save.fighters['ufc-joshua-van'];
    van.birthDate = null;
    delete van.birthDateEstimated;
    van.nickname = '"The Fearless"';
    save.date = '2029-10-05';
    migrateSave(save);
    expect(van.nickname).toBe('The Fearless');
    expect(van.birthDateEstimated).toBe(true);
    expect(ageOn(van.birthDate, save.snapshot.snapshotDate)).toBe(van.ageAtSnapshot);
    expect(ageOn(van.birthDate, save.date)).toBeGreaterThanOrEqual(van.ageAtSnapshot! + 3);
  });
});

describe('Longevity follows wear', () => {
  it('a created fighter keeps the Longevity they were made with', () => {
    const snap = loadSnapshot();
    const created = buildCreatedFighter(createdInput(), 7, snap.meta.snapshotDate);
    expect(created.nickname).toBe('Iron');
    expect(created.longevity).toBe(longevityFromWear(created.wear));
    expect(created.longevity).toBe(93);
    const { save } = createNewGame(snap, { saveName: 'lng', seed: 7, mode: 'fighter', createdFighter: created, settings: { potPaths: 6 } });
    const me = save.fighters[save.player.fighterId!];
    const start = me.longevity;
    runWorld(save, 3);
    expect(me.longevity).toBe(start);
  });

  it('every fighter in a new world has the Longevity its wear implies', () => {
    const { save } = newCareer(44, { light: true });
    for (const f of Object.values(save.fighters)) expect(f.longevity).toBe(longevityFromWear(f.wear));
  });
});
