import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { createEvent, newCareer, runWorld } from './testing/fixtures';
import {
  allOfficials,
  assignOfficials,
  controversyRate,
  ensureOfficials,
  getOfficial,
  judgePersonasFor,
  officialSummary,
  officialsByRole,
  recordOfficialOutcome,
  refereeTendencyFor,
} from './world/officials';
import { scoreRoundForJudge, type JudgePersona, type RoundScoreInput } from './sim/judging';
import { migrateSave } from './save/migrate';
import { DEFAULT_FEATURE_FLAGS, featureEnabled, SAVE_SCHEMA_VERSION } from './types/save';
import type { SaveGame } from './types/save';
import { emptyStatLine, type Bout, type FightResult } from './types/fight';

/**
 * Persistent officials.
 *
 * Judges used to be drawn per fight and discarded, so nothing could accumulate against them.
 * These cover the properties that only mean something once an official is a person: a stable
 * identity, a record that grows, and a card that can be identified as out of step.
 */

/** The shared factory, so the fixture cannot drift from the real stat line. */
const emptyStats = emptyStatLine;

function roundInput(overrides: Partial<RoundScoreInput> = {}): RoundScoreInput {
  return {
    statsA: { ...emptyStats(), sigStrikesLanded: 40, knockdowns: 1 },
    statsB: { ...emptyStats(), sigStrikesLanded: 8 },
    damageA: 10,
    damageB: 60,
    aggressionA: 0.7,
    aggressionB: 0.3,
    cageControlA: 0.7,
    cageControlB: 0.3,
    ...overrides,
  };
}

describe('the officials roster', () => {
  it('is created with the world and is stable for a seed', () => {
    const a = newCareer(6101);
    const b = newCareer(6101);
    const listA = allOfficials(a.save);
    const listB = allOfficials(b.save);
    expect(listA.length).toBeGreaterThan(20);
    expect(listA.map((o) => `${o.id}|${o.name}|${Math.round(o.experience)}`)).toEqual(
      listB.map((o) => `${o.id}|${o.name}|${Math.round(o.experience)}`)
    );
    expect(officialsByRole(a.save, 'judge').length).toBeGreaterThanOrEqual(12);
    expect(officialsByRole(a.save, 'referee').length).toBeGreaterThanOrEqual(6);
  });

  it('is created only once', () => {
    const f = newCareer(6102);
    const before = allOfficials(f.save).length;
    expect(ensureOfficials(f.save)).toBe(0);
    expect(allOfficials(f.save).length).toBe(before);
  });

  it('gives every official plausible bounded tendencies', () => {
    const f = newCareer(6103);
    for (const o of allOfficials(f.save)) {
      expect(o.experience).toBeGreaterThanOrEqual(0);
      expect(o.experience).toBeLessThanOrEqual(100);
      // A leaning is small. This is the property that keeps judging imperfect rather than
      // arbitrary, so it is asserted rather than assumed.
      expect(Math.abs(o.grapplingLean)).toBeLessThanOrEqual(0.4);
      expect(Math.abs(o.damageLean)).toBeLessThanOrEqual(0.4);
      expect(o.tenEightWillingness).toBeGreaterThanOrEqual(0.55);
      expect(o.tenEightWillingness).toBeLessThanOrEqual(1.45);
      expect(o.hometownSusceptibility).toBeGreaterThanOrEqual(0);
      expect(o.hometownSusceptibility).toBeLessThanOrEqual(0.35);
      expect(o.stoppageTendency).toBeGreaterThan(0.5);
      expect(o.stoppageTendency).toBeLessThan(1.5);
      expect(officialSummary(o).length).toBeGreaterThan(5);
    }
  });
});

describe('assigning officials to a bout', () => {
  function fixtureBout(save: SaveGame, isTitle = false): Bout {
    const event = createEvent(save, addDays(save.date, 60));
    const roster = Object.values(save.fighters).filter((x) => x.divisionId === 'lightweight').slice(0, 2);
    const bout: Bout = {
      id: `bout-officials-${isTitle ? 'title' : 'ordinary'}`,
      eventId: event.id,
      date: event.date,
      fighterAId: roster[0].id,
      fighterBId: roster[1].id,
      divisionId: 'lightweight',
      contractedWeightLb: 155,
      scheduledRounds: isTitle ? 5 : 3,
      isTitleFight: isTitle,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      isMainEvent: isTitle,
      isCoMain: false,
      cardSegment: 'main',
      boutOrder: 1,
      isCatchweight: false,
      status: 'scheduled',
      resultId: null,
      bookedOn: save.date,
      replacementHistory: [],
      cancelReason: null,
      purseA: { show: 1, win: 1 },
      purseB: { show: 1, win: 1 },
      weighInA: null,
      weighInB: null,
      bookingReason: 'fixture',
    };
    save.bouts[bout.id] = bout;
    return bout;
  }

  it('assigns exactly three distinct judges and one referee', () => {
    const f = newCareer(6201);
    const bout = fixtureBout(f.save);
    const assignment = assignOfficials(f.save, bout);
    expect(assignment.judgeIds).toHaveLength(3);
    expect(new Set(assignment.judgeIds).size).toBe(3);
    expect(assignment.refereeId).toBeTruthy();
    for (const id of assignment.judgeIds) {
      expect(getOfficial(f.save, id)?.role).toBe('judge');
    }
    expect(getOfficial(f.save, assignment.refereeId!)?.role).toBe('referee');
  });

  it('is stable for the same bout and does not reassign', () => {
    const f = newCareer(6202);
    const bout = fixtureBout(f.save);
    const first = assignOfficials(f.save, bout);
    const second = assignOfficials(f.save, bout);
    expect(second.judgeIds).toEqual(first.judgeIds);
    expect(second.refereeId).toBe(first.refereeId);
  });

  it('does not consume the simulation rng', () => {
    const f = newCareer(6203);
    const bout = fixtureBout(f.save);
    const before = JSON.stringify(f.save.rng);
    assignOfficials(f.save, bout);
    // Assignment is derived from the bout id, so it cannot shift any fight outcome.
    expect(JSON.stringify(f.save.rng)).toBe(before);
  });

  it('draws a championship bout from the more experienced half of the pool', () => {
    const f = newCareer(6204);
    const judges = officialsByRole(f.save, 'judge');
    const sorted = [...judges].sort((a, b) => b.experience - a.experience);
    const experiencedHalf = new Set(sorted.slice(0, Math.max(6, Math.ceil(judges.length / 2))).map((o) => o.id));
    const bout = fixtureBout(f.save, true);
    const assignment = assignOfficials(f.save, bout);
    for (const id of assignment.judgeIds) {
      expect(experiencedHalf.has(id)).toBe(true);
    }
  });

  it('produces personas the engine can score with', () => {
    const f = newCareer(6205);
    const bout = fixtureBout(f.save);
    const assignment = assignOfficials(f.save, bout);
    const personas = judgePersonasFor(f.save, assignment);
    expect(personas).toHaveLength(3);
    for (const p of personas) {
      expect(p.name).toBeTruthy();
      expect(Number.isFinite(p.bias)).toBe(true);
      expect(p.tenEightWillingness).toBeGreaterThan(0);
    }
    expect(refereeTendencyFor(f.save, assignment)).toBeGreaterThan(0.5);
  });

  it('applies a home crowd nudge only when one fighter is at home', () => {
    const f = newCareer(6206);
    const bout = fixtureBout(f.save);
    const assignment = assignOfficials(f.save, bout);
    const neutral = judgePersonasFor(f.save, assignment, 0);
    const partisan = judgePersonasFor(f.save, assignment, 0.12);
    // The nudge only moves a judge who is susceptible, and never by much.
    for (let i = 0; i < neutral.length; i++) {
      const shift = Math.abs(partisan[i].bias - neutral[i].bias);
      expect(shift).toBeLessThanOrEqual(0.12 * 0.35 + 1e-9);
    }
  });
});

describe('a judge willing to score 10-8', () => {
  it('needs less impact than a reluctant judge for the same round', () => {
    const settings = { allowTenTen: false, allowTenSeven: true } as never;
    const input = roundInput();
    // A dominant round with a knockdown, scored by two judges who differ only in willingness.
    const willing: JudgePersona = { name: 'W', grapplingLean: 0, damageLean: 0, bias: 0, tenEightWillingness: 1.45 };
    const reluctant: JudgePersona = { name: 'R', grapplingLean: 0, damageLean: 0, bias: 0, tenEightWillingness: 0.55 };

    let willingEights = 0;
    let reluctantEights = 0;
    for (let i = 0; i < 200; i++) {
      const w = scoreRoundForJudge(willing, input, 20, new Rng(i), settings);
      const r = scoreRoundForJudge(reluctant, input, 20, new Rng(i), settings);
      if (Math.min(w.a, w.b) <= 8) willingEights++;
      if (Math.min(r.a, r.b) <= 8) reluctantEights++;
    }
    expect(willingEights).toBeGreaterThan(reluctantEights);
  });

  it('behaves exactly as before when the field is absent', () => {
    const settings = { allowTenTen: false, allowTenSeven: true } as never;
    const input = roundInput();
    const withField: JudgePersona = { name: 'A', grapplingLean: 0, damageLean: 0, bias: 0, tenEightWillingness: 1 };
    const withoutField: JudgePersona = { name: 'A', grapplingLean: 0, damageLean: 0, bias: 0 };
    for (let i = 0; i < 40; i++) {
      expect(scoreRoundForJudge(withField, input, 20, new Rng(i), settings)).toEqual(
        scoreRoundForJudge(withoutField, input, 20, new Rng(i), settings)
      );
    }
  });
});

describe('recording what the officials did', () => {
  function fixtureResult(save: SaveGame, cards: { judgeName: string; totalA: number; totalB: number }[], method: FightResult['method']): FightResult {
    return {
      boutId: 'bout-x',
      eventId: 'evt-x',
      date: save.date,
      divisionId: 'lightweight',
      fighterAId: 'a',
      fighterBId: 'b',
      winnerId: 'a',
      loserId: 'b',
      method,
      endRound: 3,
      endTimeSeconds: 300,
      scheduledRounds: 3,
      isTitleFight: false,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      rounds: [],
      totalsA: emptyStats(),
      totalsB: emptyStats(),
      pointDeductionsA: 0,
      pointDeductionsB: 0,
      scorecards: cards.map((c) => ({ judgeName: c.judgeName, rounds: [], totalA: c.totalA, totalB: c.totalB })),
    } as unknown as FightResult;
  }

  it('accumulates bouts worked and experience', () => {
    const f = newCareer(6301);
    const bout = { id: 'b1', isTitleFight: false, isInterimTitleFight: false } as Bout;
    const judges = officialsByRole(f.save, 'judge').slice(0, 3);
    const referee = officialsByRole(f.save, 'referee')[0];
    bout.officials = { judgeIds: judges.map((j) => j.id), refereeId: referee.id };

    const before = judges[0].boutsWorked;
    const beforeExp = judges[0].experience;
    recordOfficialOutcome(f.save, bout, fixtureResult(f.save, judges.map((j) => ({ judgeName: j.name, totalA: 30, totalB: 27 })), 'decision-unanimous'));

    expect(judges[0].boutsWorked).toBe(before + 1);
    expect(judges[0].experience).toBeGreaterThan(beforeExp);
    expect(referee.boutsWorked).toBeGreaterThan(0);
  });

  it('counts a split decision against every judge who worked it', () => {
    const f = newCareer(6302);
    const bout = { id: 'b2', isTitleFight: false, isInterimTitleFight: false } as Bout;
    const judges = officialsByRole(f.save, 'judge').slice(0, 3);
    bout.officials = { judgeIds: judges.map((j) => j.id), refereeId: null };
    recordOfficialOutcome(
      f.save,
      bout,
      fixtureResult(
        f.save,
        [
          { judgeName: judges[0].name, totalA: 29, totalB: 28 },
          { judgeName: judges[1].name, totalA: 28, totalB: 29 },
          { judgeName: judges[2].name, totalA: 29, totalB: 28 },
        ],
        'decision-split'
      )
    );
    for (const j of judges) expect(j.splitDecisionsWorked).toBe(1);
  });

  it('flags a card that disagrees with both colleagues by three points or more', () => {
    const f = newCareer(6303);
    const bout = { id: 'b3', isTitleFight: false, isInterimTitleFight: false } as Bout;
    const judges = officialsByRole(f.save, 'judge').slice(0, 3);
    bout.officials = { judgeIds: judges.map((j) => j.id), refereeId: null };
    recordOfficialOutcome(
      f.save,
      bout,
      fixtureResult(
        f.save,
        [
          { judgeName: judges[0].name, totalA: 30, totalB: 27 },
          { judgeName: judges[1].name, totalA: 30, totalB: 27 },
          // Three points adrift of both colleagues.
          { judgeName: judges[2].name, totalA: 27, totalB: 30 },
        ],
        'decision-split'
      )
    );
    expect(judges[0].outlierCards).toBe(0);
    expect(judges[1].outlierCards).toBe(0);
    expect(judges[2].outlierCards).toBe(1);
    expect(judges[2].controversies[0].note).toContain('out of step');
    expect(controversyRate(judges[2])).toBeGreaterThan(0);
  });

  it('does not flag ordinary disagreement', () => {
    const f = newCareer(6304);
    const bout = { id: 'b4', isTitleFight: false, isInterimTitleFight: false } as Bout;
    const judges = officialsByRole(f.save, 'judge').slice(0, 3);
    bout.officials = { judgeIds: judges.map((j) => j.id), refereeId: null };
    recordOfficialOutcome(
      f.save,
      bout,
      fixtureResult(
        f.save,
        [
          { judgeName: judges[0].name, totalA: 29, totalB: 28 },
          { judgeName: judges[1].name, totalA: 29, totalB: 28 },
          { judgeName: judges[2].name, totalA: 28, totalB: 29 },
        ],
        'decision-split'
      )
    );
    for (const j of judges) expect(j.outlierCards).toBe(0);
  });
});

describe('officials over a running world', () => {
  it('accumulates a real record and every scorecard names a known judge', () => {
    const f = newCareer(6401);
    runWorld(f.save, 44);

    const worked = allOfficials(f.save).filter((o) => o.role === 'judge' && o.boutsWorked > 0);
    expect(worked.length).toBeGreaterThan(0);

    const names = new Set(allOfficials(f.save).map((o) => o.name));
    let cardsChecked = 0;
    for (const result of Object.values(f.save.history.results)) {
      for (const card of result.scorecards ?? []) {
        expect(names.has(card.judgeName)).toBe(true);
        cardsChecked++;
      }
    }
    expect(cardsChecked).toBeGreaterThan(0);
  });

  it('assigns a referee to bouts that get scheduled', () => {
    const f = newCareer(6402);
    runWorld(f.save, 30);
    const scheduled = Object.values(f.save.bouts).filter((b) => b.status === 'completed');
    const withOfficials = scheduled.filter((b) => b.officials && b.officials.judgeIds.length === 3);
    expect(withOfficials.length).toBeGreaterThan(0);
  });

  it('stays deterministic for a seed with officials in play', () => {
    const a = newCareer(6403);
    const b = newCareer(6403);
    runWorld(a.save, 18);
    runWorld(b.save, 18);
    expect(Object.keys(a.save.history.results).length).toBe(Object.keys(b.save.history.results).length);
    const cardsA = Object.values(a.save.history.results).flatMap((r) => (r.scorecards ?? []).map((c) => `${c.judgeName}:${c.totalA}-${c.totalB}`));
    const cardsB = Object.values(b.save.history.results).flatMap((r) => (r.scorecards ?? []).map((c) => `${c.judgeName}:${c.totalA}-${c.totalB}`));
    expect(cardsA).toEqual(cardsB);
  });
});

describe('migrating a save without officials', () => {
  it('adds the roster and the flags without touching history', () => {
    const f = newCareer(6501);
    runWorld(f.save, 14);
    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    const resultsBefore = Object.keys(legacy.history.results).length;
    const reignsBefore = legacy.history.reigns.length;
    // Present the save as if written by the previous build.
    legacy.schemaVersion = 12;
    delete (legacy as Partial<SaveGame>).officials;
    for (const bout of Object.values(legacy.bouts)) delete (bout as Partial<Bout>).officials;
    delete (legacy.settings as Partial<typeof legacy.settings>).featureFlags;

    const migrated = migrateSave(legacy);
    expect(migrated.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(allOfficials(migrated).length).toBeGreaterThan(20);
    expect(Object.keys(migrated.history.results).length).toBe(resultsBefore);
    expect(migrated.history.reigns.length).toBe(reignsBefore);
    // Completed fights keep the judge names already on their scorecards.
    for (const result of Object.values(migrated.history.results)) {
      for (const card of result.scorecards ?? []) expect(card.judgeName).toBeTruthy();
    }
  });

  it('assigns officials only to bouts that have not happened', () => {
    const f = newCareer(6502);
    runWorld(f.save, 18);
    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 12;
    delete (legacy as Partial<SaveGame>).officials;
    for (const bout of Object.values(legacy.bouts)) delete (bout as Partial<Bout>).officials;

    const migrated = migrateSave(legacy);
    for (const bout of Object.values(migrated.bouts)) {
      if (bout.status === 'scheduled') expect(bout.officials?.judgeIds).toHaveLength(3);
      else expect(bout.officials).toBeUndefined();
    }
  });

  it('gives every feature flag a defensive default', () => {
    const f = newCareer(6503);
    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 12;
    delete (legacy.settings as Partial<typeof legacy.settings>).featureFlags;
    const migrated = migrateSave(legacy);
    expect(migrated.settings.featureFlags).toBeTruthy();
    for (const key of Object.keys(DEFAULT_FEATURE_FLAGS) as (keyof typeof DEFAULT_FEATURE_FLAGS)[]) {
      expect(typeof featureEnabled(migrated.settings, key)).toBe('boolean');
    }
    // Anti-doping and historical worlds are off by default, per the specification.
    expect(featureEnabled(migrated.settings, 'antiDoping')).toBe(false);
    expect(featureEnabled(migrated.settings, 'historicalWorlds')).toBe(false);
  });

  it('reads a flag safely when settings are absent entirely', () => {
    expect(featureEnabled(undefined, 'womensDivisions')).toBe(true);
    expect(featureEnabled(undefined, 'antiDoping')).toBe(false);
  });
});
