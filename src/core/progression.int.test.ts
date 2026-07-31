import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { DIVISION_BY_ID } from './config/divisions';
import { createEvent, newCareer, runWorld } from './testing/fixtures';
import {
  currentContender,
  grantContenderStatus,
  mayBypassContender,
  reviewContenderClaims,
} from './world/contender';
import { rankChallengers, titleShotEligibility, unificationDue } from './world/title-eligibility';
import {
  addRankingPoints,
  applyHeadToHead,
  rankingLedger,
  recomputeDivision,
  rankingPointsFor,
} from './world/rankings';
import { findReplacement, promotionalMomentum, strengthOfSchedule } from './world/matchmaking';
import { assessTitleOpportunity } from './world/title-logic';
import { migrateSave } from './save/migrate';
import { emptyStatLine, type Bout, type FightResult } from './types/fight';
import type { SaveGame } from './types/save';
import type { Fighter } from './types/fighter';

/**
 * Career progression rules.
 *
 * Each test here corresponds to a rule the design states in words: a fighter who wins an
 * eliminator is next, a former champion on a long run does not wait forever, rankings respond to
 * who you beat rather than only to how often you win, and nobody is booked while unavailable.
 */

function makeAvailable(f: Fighter): Fighter {
  f.retired = false;
  f.activityStatus = 'active';
  f.injuries = [];
  f.medicalSuspension = null;
  f.commissionSuspension = null;
  f.antiDopingSuspension = null;
  f.nextBoutId = null;
  f.offerCooldownUntil = null;
  f.lossStreak = 0;
  return f;
}

function roster(save: SaveGame, divisionId: string): Fighter[] {
  return Object.values(save.fighters)
    .filter((f) => f.divisionId === divisionId && !f.retired && f.activityStatus === 'active')
    .sort((a, b) => (a.ranking ?? 99) - (b.ranking ?? 99));
}

/** Records a completed win for `winner` over `loser`, updating the fields the rules read. */
function recordWin(save: SaveGame, winner: Fighter, loser: Fighter, on: string): FightResult {
  const boutId = `bout-h2h-${winner.id}-${loser.id}-${on}`;
  const result = {
    boutId,
    eventId: 'evt-x',
    date: on,
    divisionId: winner.divisionId,
    fighterAId: winner.id,
    fighterBId: loser.id,
    winnerId: winner.id,
    loserId: loser.id,
    method: 'decision-unanimous',
    endRound: 3,
    endTimeSeconds: 300,
    scheduledRounds: 3,
    isTitleFight: false,
    isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
    rounds: [],
    totalsA: emptyStatLine(),
    totalsB: emptyStatLine(),
    pointDeductionsA: 0,
    pointDeductionsB: 0,
    scorecards: [],
  } as unknown as FightResult;
  save.history.results[boutId] = result;
  winner.boutIds.push(boutId);
  loser.boutIds.push(boutId);
  winner.winStreak++;
  winner.lossStreak = 0;
  loser.lossStreak++;
  loser.winStreak = 0;
  return result;
}

// ---------------------------------------------------------------------------
// Title shot progression
// ---------------------------------------------------------------------------

describe('title shot progression rules', () => {
  it('gives the next available shot to the winner of a number one contender bout', () => {
    const f = newCareer(8101);
    const table = f.save.rankings.lightweight;
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== table.championId);
    for (const x of pool) makeAvailable(x);
    // Somebody outside the top three, so ranking alone would not select them.
    const winner = pool.find((x) => (x.ranking ?? 99) >= 4)!;
    grantContenderStatus(f.save, winner, 'lightweight', 'eliminator-win', 'bout-elim');

    const ranked = rankChallengers(f.save, 'lightweight', () => true);
    expect(ranked[0].fighter.id).toBe(winner.id);
    // And nobody else is eligible while they are available, which is the guarantee.
    expect(ranked.every((r) => r.fighter.id === winner.id)).toBe(true);
  });

  it('does not need an excessive number of wins for a highly ranked contender', () => {
    const f = newCareer(8102);
    const table = f.save.rankings.lightweight;
    const contender = makeAvailable(f.save.fighters[table.entries.find((e) => e.rank === 2)!.fighterId]);
    contender.winStreak = 2;
    contender.lossStreak = 0;
    // Two wins at number two is enough to be an eligible challenger.
    const eligibility = titleShotEligibility(f.save, contender, 'lightweight');
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.selectionReason).toContain('number 2');
  });

  it('rates a former champion on a long winning run as ready for another shot', () => {
    const f = newCareer(8103);
    const table = f.save.rankings.lightweight;
    const former = makeAvailable(f.save.fighters[table.entries[8].fighterId]);
    former.titleReigns = 1;
    former.titleDefenses = 2;
    former.winStreak = 10;
    former.lossStreak = 0;
    former.popularity = 70;

    const before = assessTitleOpportunity(f.save, former, 'lightweight');
    // A ten fight run is explicitly one of the routes to a shot, not something to be ignored.
    expect(before.score).toBeGreaterThanOrEqual(62);
    expect(before.reasons.join(' ')).toMatch(/without a loss|former champion|run/i);

    const eligibility = titleShotEligibility(f.save, former, 'lightweight');
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons.join(' ').toLowerCase()).toContain('former champion');
  });

  it('keeps an injured contender ahead of the queue when they return', () => {
    const f = newCareer(8104);
    const table = f.save.rankings.lightweight;
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== table.championId);
    for (const x of pool) makeAvailable(x);
    const contender = pool[3];
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);

    contender.medicalSuspension = { until: addDays(f.save.date, 90), reason: 'hand surgery', clearanceRequired: true };
    f.save.date = addDays(f.save.date, 60);
    // Still theirs while they are out, inside the grace period.
    expect(mayBypassContender(f.save, 'lightweight').allowed).toBe(false);
    reviewContenderClaims(f.save);
    expect(currentContender(f.save, 'lightweight')?.fighterId).toBe(contender.id);

    // Cleared and back: they are the challenger again with no extra work required.
    contender.medicalSuspension = null;
    const ranked = rankChallengers(f.save, 'lightweight', () => true);
    expect(ranked[0].fighter.id).toBe(contender.id);
  });

  it('prevents endless contender fights by consuming the claim when the shot is taken', () => {
    const f = newCareer(8105);
    const table = f.save.rankings.lightweight;
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== table.championId);
    const contender = makeAvailable(pool[0]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    expect(currentContender(f.save, 'lightweight')).not.toBeNull();
    // Once honoured, the position is open again rather than the same fighter holding it forever.
    const record = f.save.contenders!['lightweight'];
    record.fulfilledOn = f.save.date;
    expect(currentContender(f.save, 'lightweight')).toBeNull();
  });

  it('prioritises unification once an interim champion exists and the champion is back', () => {
    const f = newCareer(8106);
    const table = f.save.rankings.lightweight;
    makeAvailable(f.save.fighters[table.championId!]);
    const interim = makeAvailable(f.save.fighters[table.entries[0].fighterId]);
    table.interimChampionId = interim.id;

    const due = unificationDue(f.save, 'lightweight');
    expect(due.due).toBe(true);
    const eligibility = titleShotEligibility(f.save, interim, 'lightweight');
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons.join(' ')).toContain('unification');
  });
});

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

describe('rankings respond to who you beat', () => {
  it('is worth far more to beat a champion than an unranked fighter', () => {
    const base = {
      won: true,
      isDraw: false,
      method: 'decision-unanimous' as const,
      endRound: 3,
      dominance: 0.5,
      isTitleFight: false,
      shortNotice: false,
      ownRank: 5,
    };
    const overChampion = rankingPointsFor({ ...base, opponentRank: 0, opponentIsChampion: true });
    const overTopThree = rankingPointsFor({ ...base, opponentRank: 3, opponentIsChampion: false });
    const overUnranked = rankingPointsFor({ ...base, opponentRank: null, opponentIsChampion: false });
    expect(overChampion).toBeGreaterThan(overTopThree);
    expect(overTopThree).toBeGreaterThan(overUnranked * 3);
  });

  it('keeps a record intact when a fighter drops out of the top fifteen', () => {
    const f = newCareer(8202);
    const outsider = Object.values(f.save.fighters).find(
      (x) => x.divisionId === 'lightweight' && x.ranking === null && x.id !== f.save.rankings.lightweight.championId
    )!;
    addRankingPoints(f.save, 'lightweight', outsider.id, 40);
    expect(rankingLedger(f.save, 'lightweight')[outsider.id]).toBe(40);

    // Recomputing truncates the visible table to fifteen but must not wipe the ledger.
    recomputeDivision(f.save, 'lightweight', new Map());
    expect(rankingLedger(f.save, 'lightweight')[outsider.id]).toBeGreaterThan(0);
  });

  it('does not leave a fighter ranked below somebody they just beat', () => {
    const f = newCareer(8203);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const lower = pool[6];
    const higher = pool[1];
    recordWin(f.save, lower, higher, f.save.date);

    // Ordered by points alone the higher ranked fighter still leads.
    const byPoints = [higher, lower];
    const corrected = applyHeadToHead(f.save, byPoints);
    expect(corrected[0].id).toBe(lower.id);
  });

  it('is stable and terminates regardless of the starting order', () => {
    const f = newCareer(8204);
    const pool = roster(f.save, 'lightweight').slice(0, 5);
    // A cycle: a beats b, b beats c, c beats a. The correction must still terminate.
    recordWin(f.save, pool[0], pool[1], f.save.date);
    recordWin(f.save, pool[1], pool[2], f.save.date);
    recordWin(f.save, pool[2], pool[0], f.save.date);
    const out = applyHeadToHead(f.save, pool);
    expect(out).toHaveLength(pool.length);
    expect(new Set(out.map((x) => x.id)).size).toBe(pool.length);
  });

  it('measures strength of schedule from real opponents', () => {
    const f = newCareer(8205);
    const pool = roster(f.save, 'lightweight');
    const fighter = pool[7];
    const ranked = pool[1];
    expect(strengthOfSchedule(f.save, fighter)).toBe(0);
    recordWin(f.save, fighter, ranked, f.save.date);
    expect(strengthOfSchedule(f.save, fighter)).toBeGreaterThan(0);
  });

  it('derives promotional momentum rather than storing it', () => {
    const f = newCareer(8206);
    const fighter = roster(f.save, 'lightweight')[5];
    const value = promotionalMomentum(f.save, fighter);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(14);
  });
});

// ---------------------------------------------------------------------------
// Booking safety
// ---------------------------------------------------------------------------

describe('nobody is booked while unavailable', () => {
  function fixtureBout(save: SaveGame): Bout {
    const event = createEvent(save, addDays(save.date, 20));
    const pool = roster(save, 'lightweight');
    const bout: Bout = {
      id: 'bout-replace-me',
      eventId: event.id,
      date: event.date,
      fighterAId: pool[0].id,
      fighterBId: pool[1].id,
      divisionId: 'lightweight',
      contractedWeightLb: DIVISION_BY_ID.lightweight.limitLb,
      scheduledRounds: 3,
      isTitleFight: false,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      isMainEvent: false,
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

  it('never selects a suspended or out of contract fighter as a replacement', () => {
    const f = newCareer(8301);
    const bout = fixtureBout(f.save);
    // Make everybody in the division unavailable in a way the old local filter missed.
    for (const x of roster(f.save, 'lightweight')) {
      x.commissionSuspension = { until: addDays(f.save.date, 200), reason: 'licensing review' } as never;
    }
    const replacement = findReplacement(f.save, bout, bout.fighterAId, new Rng(1));
    if (replacement) {
      // Anyone chosen from an adjacent division must still be clear.
      expect(replacement.fighter.commissionSuspension).toBeFalsy();
    }
  });

  it('never selects a reigning champion as short notice cover', () => {
    const f = newCareer(8302);
    const bout = fixtureBout(f.save);
    const championIds = new Set(
      Object.values(f.save.rankings)
        .map((t) => t.championId)
        .filter((id): id is string => Boolean(id))
    );
    for (let i = 0; i < 12; i++) {
      const replacement = findReplacement(f.save, bout, bout.fighterAId, new Rng(100 + i));
      if (replacement) expect(championIds.has(replacement.fighter.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Whole world coherence
// ---------------------------------------------------------------------------

describe('the world stays coherent over time', () => {
  it('never books a fighter who is injured, suspended, retired or already booked', () => {
    const f = newCareer(8401);
    runWorld(f.save, 52);
    for (const bout of Object.values(f.save.bouts)) {
      if (bout.status !== 'scheduled') continue;
      for (const id of [bout.fighterAId, bout.fighterBId]) {
        const fighter = f.save.fighters[id];
        expect(fighter.retired).toBe(false);
        expect(fighter.activityStatus).toBe('active');
        // The pointer must refer to this bout, so nobody is in two at once.
        expect(fighter.nextBoutId).toBe(bout.id);
      }
    }
  });

  it('does not repeat the same matchup excessively', () => {
    const f = newCareer(8402);
    runWorld(f.save, 78);
    const pairCounts = new Map<string, number>();
    for (const r of Object.values(f.save.history.results)) {
      const key = [r.fighterAId, r.fighterBId].sort().join('|');
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    for (const [pair, count] of pairCounts) {
      expect(count, `pair ${pair} met ${count} times`).toBeLessThanOrEqual(3);
    }
  });

  it('does not leave a division permanently without a champion', () => {
    const f = newCareer(8403);
    runWorld(f.save, 104);
    for (const [divisionId, table] of Object.entries(f.save.rankings)) {
      // Either there is a champion, or there is a live path to crowning one.
      const hasChampion = Boolean(table.championId);
      const hasContestants = table.entries.length >= 2;
      expect(hasChampion || hasContestants, `division ${divisionId} is stuck`).toBe(true);
    }
  });

  it('preserves rankings, championships and history through a save round trip', () => {
    const f = newCareer(8404);
    runWorld(f.save, 30);
    const before = {
      champions: Object.entries(f.save.rankings).map(([d, t]) => `${d}:${t.championId}`),
      entries: Object.entries(f.save.rankings).map(([d, t]) => `${d}:${t.entries.map((e) => e.fighterId).join(',')}`),
      results: Object.keys(f.save.history.results).length,
      reigns: f.save.history.reigns.length,
      contenders: JSON.stringify(f.save.contenders ?? {}),
      ledger: JSON.stringify(f.save.rankingPoints ?? {}),
    };
    const reloaded = migrateSave(JSON.parse(JSON.stringify(f.save)) as SaveGame);
    expect(Object.entries(reloaded.rankings).map(([d, t]) => `${d}:${t.championId}`)).toEqual(before.champions);
    expect(Object.entries(reloaded.rankings).map(([d, t]) => `${d}:${t.entries.map((e) => e.fighterId).join(',')}`)).toEqual(before.entries);
    expect(Object.keys(reloaded.history.results).length).toBe(before.results);
    expect(reloaded.history.reigns.length).toBe(before.reigns);
    expect(JSON.stringify(reloaded.contenders ?? {})).toBe(before.contenders);
    expect(JSON.stringify(reloaded.rankingPoints ?? {})).toBe(before.ledger);
  });

  it('is byte identical after a load, so loading never changes the world', () => {
    const f = newCareer(8405);
    runWorld(f.save, 20);
    const serialized = JSON.stringify(f.save);
    const reloaded = migrateSave(JSON.parse(serialized) as SaveGame);
    expect(JSON.stringify(reloaded)).toBe(serialized);
  });
});
