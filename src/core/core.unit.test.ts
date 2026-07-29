import { describe, expect, it } from 'vitest';
import { clamp, percentile, Rng } from './rng';
import { CALIBRATION } from './config/calibration';
import { DIVISIONS, DIVISION_BY_ID, contractedWeight, divisionFromLabel, divisionsForGender, divisionsInYear } from './config/divisions';
import { BUILDS } from './config/builds';
import { ovrDisplayed, ovrRaw, RATING_KEYS, type Ratings } from './types/fighter';
import { addDays, ageOn, dayOfWeek, daysBetween, formatMoney } from './types/common';
import { isDecision, isFinish, type FightResult, type FinishMethod } from './types/fight';
import { DEFAULT_SETTINGS, type SaveGame } from './types/save';
import { simulateFight } from './sim/engine';
import { narrateResult } from './narrative/render';
import { generateFighter } from './world/generator';
import { estimatePot } from './world/development';
import { deriveRatings, rankPrior } from './data/ratings-pipeline';
import { determineActivityStatus, normalizeName, resolveDuplicates } from './data/provider';
import { migrateSave } from './save/migrate';
import { longevityFromWear, simulateWeightCut } from './world/health';
import { applyTitleOutcome } from './world/rankings';

// ---------------------------------------------------------------------------
// Random number generator
// ---------------------------------------------------------------------------

describe('deterministic rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 500 }, () => a.next());
    const seqB = Array.from({ length: 500 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 50 }, (_, i) => new Rng(1).next() + i * 0);
    const b = Array.from({ length: 50 }, (_, i) => new Rng(2).next() + i * 0);
    expect(a[0]).not.toEqual(b[0]);
  });

  it('round trips its state through serialization', () => {
    const a = new Rng(999);
    for (let i = 0; i < 37; i++) a.next();
    const state = JSON.parse(JSON.stringify(a.getState()));
    const b = new Rng(state);
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });

  it('stays inside the unit interval and covers it', () => {
    const rng = new Rng(7);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 200000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeLessThan(0.001);
    expect(max).toBeGreaterThan(0.999);
  });

  it('has an approximately uniform distribution', () => {
    const rng = new Rng(31337);
    const buckets = new Array(10).fill(0);
    const n = 200000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]++;
    for (const b of buckets) expect(Math.abs(b - n / 10) / (n / 10)).toBeLessThan(0.05);
  });

  it('weights a weighted pick roughly in proportion', () => {
    const rng = new Rng(55);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 20000; i++) {
      const pick = rng.weighted(['a', 'b'] as const, (x) => (x === 'a' ? 3 : 1));
      counts[pick]++;
    }
    expect(counts.a / (counts.a + counts.b)).toBeGreaterThan(0.72);
    expect(counts.a / (counts.a + counts.b)).toBeLessThan(0.78);
  });
});

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

describe('Ovr', () => {
  it('is exactly the unweighted mean of the six ratings', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 500; i++) {
      const r: Ratings = {
        striking: rng.int(10, 99),
        grappling: rng.int(10, 99),
        wrestling: rng.int(10, 99),
        submissions: rng.int(10, 99),
        cardio: rng.int(10, 99),
        durability: rng.int(10, 99),
      };
      const expected = (r.striking + r.grappling + r.wrestling + r.submissions + r.cardio + r.durability) / 6;
      expect(ovrRaw(r)).toBeCloseTo(expected, 10);
      expect(ovrDisplayed(r)).toBe(Math.round(expected));
    }
  });

  it('is unaffected by which rating holds the value', () => {
    const a: Ratings = { striking: 90, grappling: 50, wrestling: 50, submissions: 50, cardio: 50, durability: 50 };
    const b: Ratings = { striking: 50, grappling: 50, wrestling: 50, submissions: 50, cardio: 50, durability: 90 };
    expect(ovrRaw(a)).toBe(ovrRaw(b));
  });

  it('exposes exactly six visible performance ratings', () => {
    expect(RATING_KEYS).toHaveLength(6);
    expect([...RATING_KEYS].sort()).toEqual(['cardio', 'durability', 'grappling', 'striking', 'submissions', 'wrestling']);
  });
});

describe('Pot', () => {
  it('never projects below current Ovr', () => {
    const rng = new Rng(88);
    for (let i = 0; i < 12; i++) {
      const f = generateFighter(rng, { divisionId: 'lightweight', targetOvr: rng.range(50, 90), today: '2026-01-01', idNumber: i });
      const pot = estimatePot(f, '2026-01-01', 24, 0.72, new Rng(i));
      expect(pot).toBeGreaterThanOrEqual(Math.round(ovrRaw(f.ratings)));
      expect(pot).toBeLessThanOrEqual(99);
    }
  });

  it('projects more headroom for a young fighter than an old one at equal ability', () => {
    const rng = new Rng(2024);
    let youngGain = 0;
    let oldGain = 0;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const young = generateFighter(rng, { divisionId: 'welterweight', targetOvr: 70, age: 22, today: '2026-01-01', idNumber: i });
      const old = generateFighter(rng, { divisionId: 'welterweight', targetOvr: 70, age: 36, today: '2026-01-01', idNumber: 1000 + i });
      youngGain += estimatePot(young, '2026-01-01', 24, 0.72, new Rng(i)) - ovrRaw(young.ratings);
      oldGain += estimatePot(old, '2026-01-01', 24, 0.72, new Rng(i)) - ovrRaw(old.ratings);
    }
    expect(youngGain / n).toBeGreaterThan(oldGain / n);
  });
});

// ---------------------------------------------------------------------------
// Rating derivation
// ---------------------------------------------------------------------------

describe('rating derivation pipeline', () => {
  const base = {
    slug: 'test',
    divisionId: 'lightweight' as const,
    rank: 5,
    isChampion: false,
    isInterimChampion: false,
    pfpRank: null,
    age: 29,
    heightIn: 70,
    reachIn: 72,
    record: { w: 20, l: 3, d: 0 },
    winsByKo: 8,
    winsBySub: 5,
    winStreak: 3,
    lossStreak: null,
    sigStrLandedPerMin: 4.2,
    sigStrAbsorbedPerMin: 2.9,
    sigStrDefensePct: 62,
    takedownAvgPer15: 2.4,
    takedownDefensePct: 78,
    submissionAvgPer15: 1.1,
    knockdownAvgPer15: 0.7,
    avgFightTimeSeconds: 690,
    sigStrLanded: 800,
    sigStrAttempted: 1700,
    takedownsLanded: 22,
    takedownsAttempted: 50,
    strikeTarget: { headPct: 60, bodyPct: 25, legPct: 15 },
    strikePosition: { standingPct: 70, clinchPct: 15, groundPct: 15 },
    winMethod: { koPct: 40, decPct: 35, subPct: 25 },
  };

  it('is reproducible for identical input', () => {
    expect(deriveRatings(base).ratings).toEqual(deriveRatings(base).ratings);
  });

  it('keeps every rating inside the documented bounds', () => {
    const d = deriveRatings(base);
    for (const k of RATING_KEYS) {
      expect(d.ratings[k]).toBeGreaterThanOrEqual(20);
      expect(d.ratings[k]).toBeLessThanOrEqual(98);
    }
  });

  it('shrinks a tiny sample toward the division prior', () => {
    const bigSample = deriveRatings({ ...base, sigStrLanded: 1600, sigStrAttempted: 3200 });
    const tinySample = deriveRatings({ ...base, sigStrLanded: 30, sigStrAttempted: 60 });
    const prior = rankPrior(base.rank, false, false, null);
    // With almost no evidence the result must sit closer to the prior anchor.
    expect(Math.abs(ovrRaw(tinySample.ratings) - prior)).toBeLessThan(Math.abs(ovrRaw(bigSample.ratings) - prior) + 0.001);
    expect(tinySample.ovrConfidence).toBe('very-low');
  });

  it('rates a champion above an unranked fighter with the same statistics', () => {
    const champ = deriveRatings({ ...base, isChampion: true, rank: 0 });
    const unranked = deriveRatings({ ...base, rank: null });
    expect(ovrRaw(champ.ratings)).toBeGreaterThan(ovrRaw(unranked.ratings));
  });

  it('reports missing source fields rather than inventing them', () => {
    const sparse = deriveRatings({ ...base, takedownDefensePct: null, submissionAvgPer15: null, knockdownAvgPer15: null });
    expect(sparse.missing).toContain('takedownDefensePct');
    expect(sparse.missing).toContain('submissionAvgPer15');
  });
});

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

describe('data provider helpers', () => {
  it('normalizes names for cross source matching', () => {
    expect(normalizeName('José Aldó Jr.')).toBe('jose aldo');
    expect(normalizeName("Conor  McGregor")).toBe('conor mcgregor');
  });

  it('resolves duplicates by keeping the more complete record', () => {
    const mk = (sourceId: string, missing: string[]) =>
      ({ sourceId, name: 'Same Person', birthDate: null, age: 30, missingFields: missing }) as never;
    const { unique, resolutions } = resolveDuplicates([mk('a', ['x', 'y']), mk('b', ['x'])]);
    expect(unique).toHaveLength(1);
    expect(resolutions).toHaveLength(1);
    expect(unique[0].sourceId).toBe('b');
  });

  it('never marks a fighter active without positive evidence', () => {
    expect(
      determineActivityStatus({ officialStatus: null, hasCurrentRanking: false, recentFightWithinDays: null, hasScheduledFight: false, manualOverride: null }).status
    ).toBe('unverified');
    expect(
      determineActivityStatus({ officialStatus: 'Active', hasCurrentRanking: false, recentFightWithinDays: null, hasScheduledFight: false, manualOverride: null }).status
    ).toBe('active');
    expect(
      determineActivityStatus({ officialStatus: 'Retired', hasCurrentRanking: true, recentFightWithinDays: 10, hasScheduledFight: true, manualOverride: null }).status
    ).toBe('retired');
  });
});

// ---------------------------------------------------------------------------
// Divisions and configuration
// ---------------------------------------------------------------------------

describe('divisions', () => {
  it('covers the eight men\u2019s divisions with the correct limits', () => {
    expect(divisionsForGender('men').map((d) => d.limitLb)).toEqual([125, 135, 145, 155, 170, 185, 205, 265]);
  });

  it("covers the women's divisions with the correct limits", () => {
    expect(divisionsForGender('women').map((d) => d.limitLb)).toEqual([115, 125, 135, 145]);
  });

  it('gives every division a distinct profile rather than reusing one set of priors', () => {
    const signatures = DIVISIONS.map(
      (d) =>
        `${d.priors.heightIn.mean}|${d.priors.slpm.mean}|${d.priors.kdAvg.mean}|${d.targetRosterSize}|${d.ageProfile.mean}|${d.finishRateTarget}`
    );
    expect(new Set(signatures).size).toBe(DIVISIONS.length);
    for (const d of DIVISIONS) {
      expect(d.ageProfile.min).toBeLessThan(d.ageProfile.max);
      expect(d.finishRateTarget).toBeGreaterThan(0.2);
      expect(d.finishRateTarget).toBeLessThan(0.8);
      expect(d.gender === 'men' || d.gender === 'women').toBe(true);
    }
  });

  it('knows which divisions existed in a given year', () => {
    const y2000 = divisionsInYear(2000).map((d) => d.id);
    expect(y2000).toContain('heavyweight');
    expect(y2000).not.toContain('womens-strawweight');
    expect(y2000).not.toContain('flyweight');
    const y2020 = divisionsInYear(2020).map((d) => d.id);
    expect(y2020).toContain('womens-strawweight');
    expect(y2020).toContain('womens-featherweight');
    // A division that has been retired drops out of later years.
    expect(divisionsInYear(2026).map((d) => d.id)).not.toContain('womens-featherweight');
  });

  it('applies the one pound allowance to non title bouts only', () => {
    expect(contractedWeight('lightweight', true)).toBe(155);
    expect(contractedWeight('lightweight', false)).toBe(156);
    // Heavyweight has no allowance.
    expect(contractedWeight('heavyweight', false)).toBe(265);
  });

  it('maps source division labels including women\u2019s divisions', () => {
    expect(divisionFromLabel('Light Heavyweight Division')).toBe('light-heavyweight');
    expect(divisionFromLabel("Women's Flyweight")).toBe('womens-flyweight');
    expect(divisionFromLabel('Women&#039;s Strawweight')).toBe('womens-strawweight');
    expect(divisionFromLabel('Flyweight')).toBe('flyweight');
    expect(divisionFromLabel(null)).toBeNull();
    expect(divisionFromLabel('Catchweight')).toBeNull();
  });

  it('gives every build a tradeoff rather than a strict advantage', () => {
    for (const build of Object.values(BUILDS)) {
      if (build.id === 'balanced') continue;
      const biases = Object.values(build.ratingBias);
      const hasUpside = biases.some((v) => v > 0) || build.leverage > 1 || build.cutDifficulty < 1;
      const hasDownside =
        biases.some((v) => v < 0) || build.fatigue > 1 || build.cutDifficulty > 1 || build.takedownLeverage < 1 || build.agingRate > 1;
      expect(hasUpside && hasDownside).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

describe('calendar helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('identifies days of the week', () => {
    // 2026-07-29 is a Wednesday.
    expect(dayOfWeek('2026-07-29')).toBe(3);
  });

  it('computes age with the birthday boundary', () => {
    expect(ageOn('2000-07-30', '2026-07-29')).toBe(25);
    expect(ageOn('2000-07-29', '2026-07-29')).toBe(26);
    expect(ageOn(null, '2026-07-29')).toBeNull();
  });

  it('formats currency in en-US', () => {
    expect(formatMoney(1234567)).toBe('$1,234,567');
    expect(formatMoney(null)).toBe('Unknown');
  });
});

// ---------------------------------------------------------------------------
// Fight engine
// ---------------------------------------------------------------------------

function buildBout(seed: number, ovrA = 78, ovrB = 78, rounds: 3 | 5 = 3) {
  const rng = new Rng(seed);
  const a = generateFighter(rng, { divisionId: 'lightweight', targetOvr: ovrA, today: '2026-01-01', idNumber: 1 });
  const b = generateFighter(rng, { divisionId: 'lightweight', targetOvr: ovrB, today: '2026-01-01', idNumber: 2 });
  return {
    boutId: `t-${seed}`,
    eventId: 'test',
    date: '2026-01-01',
    divisionId: 'lightweight' as const,
    scheduledRounds: rounds,
    isTitleFight: false,
    isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
    contractedWeightLb: 156,
    settings: DEFAULT_SETTINGS,
    seed,
    a: { fighter: a, gamePlan: [], sharpness: 0.7, tacticalFamiliarity: 0.5, cutQuality: 0.9, campQuality: 0.9, shortNotice: false },
    b: { fighter: b, gamePlan: [], sharpness: 0.7, tacticalFamiliarity: 0.5, cutQuality: 0.9, campQuality: 0.9, shortNotice: false },
  };
}

describe('fight engine', () => {
  it('is fully deterministic for the same inputs', () => {
    for (const seed of [1, 42, 9001]) {
      const x = simulateFight(buildBout(seed));
      const y = simulateFight(buildBout(seed));
      expect(y.method).toBe(x.method);
      expect(y.winnerId).toBe(x.winnerId);
      expect(y.endRound).toBe(x.endRound);
      expect(y.endTimeSeconds).toBe(x.endTimeSeconds);
      expect(y.events.length).toBe(x.events.length);
      expect(y.totalsA).toEqual(x.totalsA);
      expect(y.totalsB).toEqual(x.totalsB);
    }
  });

  it('produces different fights for different seeds', () => {
    const results = [1, 2, 3, 4, 5, 6].map((s) => simulateFight(buildBout(s)));
    const signatures = new Set(results.map((r) => `${r.method}-${r.endRound}-${r.totalsA.sigStrikesLanded}`));
    expect(signatures.size).toBeGreaterThan(3);
  });

  it('never ends outside the scheduled rounds', () => {
    for (let seed = 0; seed < 60; seed++) {
      const three = simulateFight(buildBout(seed, 75, 75, 3));
      expect(three.endRound).toBeLessThanOrEqual(3);
      const five = simulateFight(buildBout(seed + 500, 75, 75, 5));
      expect(five.endRound).toBeLessThanOrEqual(5);
    }
  });

  it('keeps landed strikes at or below attempts in every recorded dimension', () => {
    for (let seed = 0; seed < 40; seed++) {
      const r = simulateFight(buildBout(seed));
      for (const t of [r.totalsA, r.totalsB]) {
        expect(t.sigStrikesLanded).toBeLessThanOrEqual(t.sigStrikesAttempted);
        expect(t.totalStrikesLanded).toBeLessThanOrEqual(t.totalStrikesAttempted);
        expect(t.sigStrikesLanded).toBeLessThanOrEqual(t.totalStrikesLanded);
        expect(t.takedownsLanded).toBeLessThanOrEqual(t.takedownsAttempted);
        expect(t.headLanded + t.bodyLanded + t.legLanded).toBe(t.sigStrikesLanded);
        expect(t.distanceLanded + t.clinchLanded + t.groundLanded).toBe(t.sigStrikesLanded);
      }
    }
  });

  it('scores every completed round on the ten point must system when it goes to the judges', () => {
    let decisions = 0;
    for (let seed = 0; seed < 120 && decisions < 12; seed++) {
      const r = simulateFight(buildBout(seed, 74, 74, 3));
      if (!isDecision(r.method)) continue;
      decisions++;
      expect(r.scorecards).toHaveLength(3);
      for (const card of r.scorecards) {
        expect(card.rounds.length).toBe(r.rounds.length);
        for (const round of card.rounds) {
          expect(Math.max(round.a, round.b)).toBe(10);
          expect(Math.min(round.a, round.b)).toBeGreaterThanOrEqual(7);
          expect(Math.min(round.a, round.b)).toBeLessThanOrEqual(10);
        }
      }
    }
    expect(decisions).toBeGreaterThan(0);
  });

  it('gives a much better fighter a clear but not certain edge', () => {
    let strongWins = 0;
    const n = 220;
    for (let seed = 0; seed < n; seed++) {
      const opts = buildBout(seed + 7000, 88, 66);
      const r = simulateFight(opts);
      if (r.winnerId === opts.a.fighter.id) strongWins++;
    }
    const rate = strongWins / n;
    expect(rate).toBeGreaterThan(0.7);
    expect(rate).toBeLessThan(0.995);
  });

  it('produces realistic outcome distributions over a batch', () => {
    const rng = new Rng(20260728);
    const counts: Record<string, number> = {};
    let totalMinutes = 0;
    let sigLanded = 0;
    let takedowns = 0;
    let subAttempts = 0;
    const n = 700;
    for (let i = 0; i < n; i++) {
      const division = rng.pick(DIVISIONS);
      const a = generateFighter(rng, { divisionId: division.id, targetOvr: rng.normalClamped(72, 8, 45, 95), today: '2026-01-01', idNumber: i * 2 });
      const b = generateFighter(rng, { divisionId: division.id, targetOvr: rng.normalClamped(72, 8, 45, 95), today: '2026-01-01', idNumber: i * 2 + 1 });
      const r = simulateFight({
        boutId: `b${i}`,
        eventId: 'batch',
        date: '2026-01-01',
        divisionId: division.id,
        scheduledRounds: 3,
        isTitleFight: false,
        isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
        contractedWeightLb: division.limitLb + 1,
        settings: DEFAULT_SETTINGS,
        seed: rng.nextUint32(),
        a: { fighter: a, gamePlan: [], sharpness: 0.7, tacticalFamiliarity: 0.5, cutQuality: 0.85, campQuality: 0.85, shortNotice: false },
        b: { fighter: b, gamePlan: [], sharpness: 0.7, tacticalFamiliarity: 0.5, cutQuality: 0.85, campQuality: 0.85, shortNotice: false },
      });
      const cat = isFinish(r.method) ? 'finish' : 'decision';
      counts[cat] = (counts[cat] ?? 0) + 1;
      const minutes = (r.endRound - 1) * 5 + r.endTimeSeconds / 60;
      totalMinutes += minutes;
      sigLanded += r.totalsA.sigStrikesLanded + r.totalsB.sigStrikesLanded;
      takedowns += r.totalsA.takedownsLanded + r.totalsB.takedownsLanded;
      subAttempts += r.totalsA.submissionAttempts + r.totalsB.submissionAttempts;
    }
    const finishRate = (counts.finish ?? 0) / n;
    const slpm = sigLanded / 2 / totalMinutes;
    const td15 = (takedowns / 2 / totalMinutes) * 15;
    const sub15 = (subAttempts / 2 / totalMinutes) * 15;

    // These bands are the shape of publicly reported aggregate outcomes and are the
    // calibration targets for this engine.
    expect(finishRate).toBeGreaterThan(0.35);
    expect(finishRate).toBeLessThan(0.6);
    expect(slpm).toBeGreaterThan(3.0);
    expect(slpm).toBeLessThan(5.0);
    expect(td15).toBeGreaterThan(0.9);
    expect(td15).toBeLessThan(2.6);
    expect(sub15).toBeGreaterThan(0.2);
    expect(sub15).toBeLessThan(1.3);
  });

  it('keeps every calibration constant in configuration', () => {
    expect(CALIBRATION.round.seconds).toBe(300);
    expect(CALIBRATION.actionSpread).toBeGreaterThan(0);
    expect(CALIBRATION.stamina.max).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

describe('narrative engine', () => {
  it('renders text for the meaningful events and never repeats a line back to back', () => {
    const opts = buildBout(4242, 82, 78, 5);
    const r = simulateFight(opts);
    narrateResult(
      r,
      { id: opts.a.fighter.id, name: opts.a.fighter.name, lastName: opts.a.fighter.lastName, nickname: null },
      { id: opts.b.fighter.id, name: opts.b.fighter.name, lastName: opts.b.fighter.lastName, nickname: null }
    );
    const texts = r.events.map((e) => e.text).filter(Boolean) as string[];
    expect(texts.length).toBeGreaterThan(30);
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
  });

  it('writes round summaries tied to the round statistics and avoids generic filler', () => {
    const opts = buildBout(777, 80, 80, 3);
    const r = simulateFight(opts);
    narrateResult(
      r,
      { id: opts.a.fighter.id, name: opts.a.fighter.name, lastName: opts.a.fighter.lastName, nickname: null },
      { id: opts.b.fighter.id, name: opts.b.fighter.name, lastName: opts.b.fighter.lastName, nickname: null }
    );
    for (const round of r.rounds) {
      expect(round.summary.length).toBeGreaterThan(20);
      expect(round.summary.toLowerCase()).not.toContain('both fighters had success');
      const namesMentioned = round.summary.includes(opts.a.fighter.lastName) || round.summary.includes(opts.b.fighter.lastName);
      expect(namesMentioned).toBe(true);
    }
    expect(r.narrativeSummary.length).toBeGreaterThan(20);
  });

  it('never emits a banned dash character in generated commentary', () => {
    // Built from code points so this file does not itself contain the banned characters.
    const banned = [0x2014, 0x2015, 0x2e3a, 0x2e3b, 0xfe58].map((c) => String.fromCodePoint(c));
    for (let seed = 0; seed < 12; seed++) {
      const opts = buildBout(seed + 100, 80, 75, 5);
      const r = simulateFight(opts);
      narrateResult(
        r,
        { id: opts.a.fighter.id, name: opts.a.fighter.name, lastName: opts.a.fighter.lastName, nickname: 'The Test' },
        { id: opts.b.fighter.id, name: opts.b.fighter.name, lastName: opts.b.fighter.lastName, nickname: null }
      );
      const all = [...r.events.map((e) => e.text ?? ''), ...r.rounds.map((x) => x.summary), r.narrativeSummary].join(' ');
      for (const ch of banned) expect(all).not.toContain(ch);
    }
  });
});

// ---------------------------------------------------------------------------
// Health and weight
// ---------------------------------------------------------------------------

describe('health model', () => {
  it('maps wear onto Longevity monotonically', () => {
    const light = longevityFromWear({ neurological: 5, facial: 5, joint: 5, body: 5, weightCut: 5, recovery: 5 });
    const heavy = longevityFromWear({ neurological: 70, facial: 70, joint: 70, body: 70, weightCut: 70, recovery: 70 });
    expect(light).toBeGreaterThan(heavy);
    expect(light).toBeLessThanOrEqual(100);
    expect(heavy).toBeGreaterThanOrEqual(1);
  });

  it('misses weight rarely under normal conditions and often under extreme ones', () => {
    const rng = new Rng(5150);
    const normal = generateFighter(rng, { divisionId: 'welterweight', targetOvr: 75, age: 28, build: 'balanced', today: '2026-01-01', idNumber: 1 });
    normal.walkingWeightLb = 192;
    let normalMisses = 0;
    for (let i = 0; i < 400; i++) {
      const cut = simulateWeightCut(normal, { divisionId: 'welterweight', isTitleFight: false, campWeeks: 8, nutritionSupport: 0.8, shortNotice: false, aggressiveness: 0.5 }, '2026-01-01', rng);
      if (!cut.madeWeight) normalMisses++;
    }
    expect(normalMisses / 400).toBeLessThan(0.12);

    const extreme = generateFighter(rng, { divisionId: 'welterweight', targetOvr: 75, age: 38, build: 'heavy-frame', today: '2026-01-01', idNumber: 2 });
    extreme.walkingWeightLb = 214;
    extreme.longevity = 25;
    extreme.wear.weightCut = 80;
    let extremeMisses = 0;
    for (let i = 0; i < 400; i++) {
      const cut = simulateWeightCut(extreme, { divisionId: 'welterweight', isTitleFight: true, campWeeks: 2, nutritionSupport: 0.2, shortNotice: true, aggressiveness: 1 }, '2026-01-01', rng);
      if (!cut.madeWeight) extremeMisses++;
    }
    expect(extremeMisses).toBeGreaterThan(normalMisses);
  });

  // Fighters used to be created carrying more weight than the same model said they could
  // take off, so a fresh roster missed weight several times too often until the weekly pass
  // had drifted everyone down over a couple of months.
  it('creates fighters at a walking weight they can actually cut to', () => {
    const rng = new Rng(7788);
    for (const division of DIVISIONS) {
      let misses = 0;
      const n = 40;
      for (let i = 0; i < n; i++) {
        const f = generateFighter(rng, { divisionId: division.id, targetOvr: 72, age: rng.int(23, 36), today: '2026-01-01', idNumber: i });
        const cut = simulateWeightCut(
          f,
          { divisionId: division.id, isTitleFight: false, campWeeks: 8, nutritionSupport: 0.7, shortNotice: false, aggressiveness: 0.5 },
          '2026-01-01',
          rng
        );
        if (!cut.madeWeight) misses++;
      }
      expect(misses / n, `${division.name} misses weight too often at creation`).toBeLessThan(0.15);
    }
  });
});

describe('title eligibility when a fighter misses weight', () => {
  const base = {
    divisionId: 'lightweight' as const,
    boutId: 'bout-x',
    date: '2026-05-01',
    fighterAId: 'champ',
    fighterBId: 'challenger',
    isInterimTitleFight: false,
  };

  function world(): SaveGame {
    const save = {
      date: '2026-05-01',
      fighters: {
        champ: { id: 'champ', name: 'Champ', isChampion: true, isInterimChampion: false, titleReigns: 1, titleDefenses: 0 },
        challenger: { id: 'challenger', name: 'Challenger', isChampion: false, isInterimChampion: false, titleReigns: 0, titleDefenses: 0 },
      },
      rankings: { lightweight: { divisionId: 'lightweight', championId: 'champ', interimChampionId: null, entries: [] } },
      history: {
        reigns: [
          { id: 'r1', divisionId: 'lightweight', fighterId: 'champ', isInterim: false, wonOn: '2025-01-01', wonBoutId: 'b0', lostOn: null, lostBoutId: null, defenses: 0, endReason: null },
        ],
      },
    } as unknown as SaveGame;
    return save;
  }

  function outcome(winner: string, loser: string, ineligible: string[]): SaveGame {
    const save = world();
    applyTitleOutcome(save, {
      ...base,
      winnerId: winner,
      loserId: loser,
      isTitleFight: true,
      titleIneligibleFighterIds: ineligible,
    } as unknown as FightResult);
    return save;
  }

  it('lets the fighter who made weight win the title', () => {
    const save = outcome('challenger', 'champ', ['champ']);
    expect(save.rankings.lightweight.championId).toBe('challenger');
    expect(save.fighters.challenger.isChampion).toBe(true);
  });

  it('vacates the title when the champion misses weight and wins', () => {
    const save = outcome('champ', 'challenger', ['champ']);
    expect(save.rankings.lightweight.championId).toBeNull();
    expect(save.fighters.champ.isChampion).toBe(false);
    expect(save.history.reigns[0].endReason).toBe('stripped');
  });

  it('vacates the title when the champion made weight but lost to someone who did not', () => {
    const save = outcome('challenger', 'champ', ['challenger']);
    expect(save.rankings.lightweight.championId).toBeNull();
    expect(save.fighters.challenger.isChampion).toBe(false);
    expect(save.history.reigns[0].endReason).toBe('defeated');
  });

  it('keeps the title with the champion who made weight and won', () => {
    const save = outcome('champ', 'challenger', ['challenger']);
    expect(save.rankings.lightweight.championId).toBe('champ');
    expect(save.fighters.champ.titleDefenses).toBe(1);
  });

  it('vacates the title when both fighters miss weight', () => {
    const save = outcome('challenger', 'champ', ['champ', 'challenger']);
    expect(save.rankings.lightweight.championId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Save migration
// ---------------------------------------------------------------------------

describe('save migration', () => {
  it('upgrades an older save and repairs missing structures', () => {
    const old = {
      schemaVersion: 1,
      date: '2026-01-01',
      settings: { difficulty: 'normal' },
      fighters: {},
      gyms: {},
      staff: {},
      contracts: {},
      events: {},
      bouts: {},
      history: { results: {}, reigns: [], news: [], awards: [], hallOfFame: [] },
    } as never;
    const migrated = migrateSave(old);
    expect(migrated.schemaVersion).toBeGreaterThan(1);
    expect(migrated.pfp).toBeDefined();
    expect(migrated.camps).toBeDefined();
    expect(migrated.counters).toBeDefined();
    expect(migrated.rankings.lightweight).toBeDefined();
    expect(migrated.settings.potPaths).toBeGreaterThan(0);
  });

  it('refuses a save written by a newer schema', () => {
    expect(() => migrateSave({ schemaVersion: 9999 } as never)).toThrow(/newer version/);
  });
});

// ---------------------------------------------------------------------------
// World simulation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Utility maths
// ---------------------------------------------------------------------------

describe('maths helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('classifies methods correctly', () => {
    const finishes: FinishMethod[] = ['ko', 'tko-strikes', 'submission', 'doctor-stoppage'];
    for (const m of finishes) expect(isFinish(m)).toBe(true);
    expect(isFinish('decision-unanimous')).toBe(false);
    expect(isDecision('decision-split')).toBe(true);
    expect(isDecision('ko')).toBe(false);
  });

  it('keeps division priors internally consistent', () => {
    for (const d of DIVISIONS) {
      expect(DIVISION_BY_ID[d.id]).toBe(d);
      expect(d.priors.reachIn.mean).toBeGreaterThan(d.priors.heightIn.mean - 2);
      expect(d.floorLb).toBeLessThan(d.limitLb);
    }
  });
});
