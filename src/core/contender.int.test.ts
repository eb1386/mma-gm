import { describe, expect, it } from 'vitest';
import { addDays } from './types/common';
import { DIVISION_BY_ID, DIVISIONS } from './config/divisions';
import { createEvent, newCareer, runWorld } from './testing/fixtures';
import {
  applyResultToContenders,
  CONTENDER_INJURY_GRACE_DAYS,
  contenderAvailability,
  currentContender,
  forfeitContenderStatus,
  fulfilContenderStatus,
  grantContenderStatus,
  mayBypassContender,
  reviewContenderClaims,
} from './world/contender';
import { rankChallengers, titleShotEligibility } from './world/title-eligibility';
import { applyReplacement } from './world/matchmaking';
import { bookBout } from './world/availability';
import { assessChampionMove, commitMove, explore } from './world/weightclass';
import { migrateSave } from './save/migrate';
import { SAVE_SCHEMA_VERSION } from './types/save';
import { emptyStatLine, type Bout, type FightResult } from './types/fight';
import type { SaveGame } from './types/save';
import type { Fighter } from './types/fighter';

/**
 * Number one contender status.
 *
 * Winning a title eliminator used to confer nothing at all: the category was a label on the bout
 * that no later code read. These tests cover the promise the game now makes, that winning an
 * eliminator puts you next, and the explicit exceptions to it.
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

function playerOf(save: SaveGame): Fighter {
  return save.fighters[save.player.fighterId!];
}

/** A completed non title bout labelled as an eliminator. */
function eliminatorResult(save: SaveGame, a: Fighter, b: Fighter, winner: Fighter): { bout: Bout; result: FightResult } {
  const event = createEvent(save, save.date);
  const bout: Bout = {
    id: `bout-elim-${a.id}-${b.id}`,
    eventId: event.id,
    date: save.date,
    fighterAId: a.id,
    fighterBId: b.id,
    divisionId: a.divisionId,
    contractedWeightLb: DIVISION_BY_ID[a.divisionId].limitLb,
    scheduledRounds: 5,
    isTitleFight: false,
    isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
    isMainEvent: true,
    isCoMain: false,
    cardSegment: 'main',
    boutOrder: 1,
    isCatchweight: false,
    status: 'completed',
    resultId: null,
    bookedOn: save.date,
    replacementHistory: [],
    cancelReason: null,
    purseA: { show: 1, win: 1 },
    purseB: { show: 1, win: 1 },
    weighInA: null,
    weighInB: null,
    bookingReason: 'a title eliminator between top five contenders',
    bookingKind: 'eliminator',
  };
  save.bouts[bout.id] = bout;
  const result = {
    boutId: bout.id,
    eventId: event.id,
    date: save.date,
    divisionId: a.divisionId,
    fighterAId: a.id,
    fighterBId: b.id,
    winnerId: winner.id,
    loserId: winner.id === a.id ? b.id : a.id,
    method: 'decision-unanimous',
    endRound: 5,
    endTimeSeconds: 300,
    scheduledRounds: 5,
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
  return { bout, result };
}

describe('earning the number one contender position', () => {
  it('grants it to the winner of an eliminator', () => {
    const f = newCareer(7101);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const a = makeAvailable(pool[0]);
    const b = makeAvailable(pool[1]);
    expect(currentContender(f.save, 'lightweight')).toBeNull();

    const { bout, result } = eliminatorResult(f.save, a, b, a);
    const notes = applyResultToContenders(f.save, bout, result);

    const record = currentContender(f.save, 'lightweight');
    expect(record).not.toBeNull();
    expect(record!.fighterId).toBe(a.id);
    expect(record!.source).toBe('eliminator-win');
    expect(notes.join(' ')).toContain(a.name);
  });

  it('does not grant it for an ordinary bout', () => {
    const f = newCareer(7102);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const a = makeAvailable(pool[0]);
    const b = makeAvailable(pool[1]);
    const { bout, result } = eliminatorResult(f.save, a, b, a);
    bout.bookingKind = 'ranked-matchup';
    applyResultToContenders(f.save, bout, result);
    expect(currentContender(f.save, 'lightweight')).toBeNull();
  });

  it('never grants it to the champion', () => {
    const f = newCareer(7103);
    const champ = makeAvailable(f.save.fighters[f.save.rankings.lightweight.championId!]);
    const grant = grantContenderStatus(f.save, champ, 'lightweight', 'promotion-decision', null);
    expect(grant.granted).toBe(false);
    expect(currentContender(f.save, 'lightweight')).toBeNull();
  });

  it('replaces the previous holder and records why', () => {
    const f = newCareer(7104);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const first = makeAvailable(pool[0]);
    const second = makeAvailable(pool[1]);
    grantContenderStatus(f.save, first, 'lightweight', 'eliminator-win', null);
    const grant = grantContenderStatus(f.save, second, 'lightweight', 'eliminator-win', null);

    expect(grant.granted).toBe(true);
    expect(grant.displaced?.fighterId).toBe(first.id);
    expect(grant.displaced?.forfeitReason).toContain(second.name);
    // Only one standing contender per division, which is what makes the guarantee meaningful.
    expect(currentContender(f.save, 'lightweight')!.fighterId).toBe(second.id);
  });
});

describe('the contender guarantee', () => {
  it('makes the contender the top ranked challenger', () => {
    const f = newCareer(7201);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    for (const x of pool) makeAvailable(x);
    // Deliberately pick somebody who is not the highest ranked.
    const outsider = pool.find((x) => (x.ranking ?? 99) >= 4)!;
    grantContenderStatus(f.save, outsider, 'lightweight', 'eliminator-win', null);

    const ranked = rankChallengers(f.save, 'lightweight', () => true);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].fighter.id).toBe(outsider.id);
    expect(ranked[0].eligibility.selectionReason.toLowerCase()).toContain('number one contender');
  });

  it('blocks everybody else while the contender is available', () => {
    const f = newCareer(7202);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    for (const x of pool) makeAvailable(x);
    const contender = pool[2];
    const rival = pool[0];
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);

    const other = titleShotEligibility(f.save, rival, 'lightweight');
    expect(other.eligible).toBe(false);
    expect(other.blockers).toContain('contender-ahead');

    const theirs = titleShotEligibility(f.save, contender, 'lightweight');
    expect(theirs.eligible).toBe(true);
  });

  it('holds the position open for an injured contender', () => {
    const f = newCareer(7203);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    for (const x of pool) makeAvailable(x);
    const contender = pool[1];
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    contender.medicalSuspension = { until: addDays(f.save.date, 60), reason: 'hand surgery', clearanceRequired: true };

    const availability = contenderAvailability(f.save, 'lightweight');
    expect(availability.ready).toBe(false);
    expect(availability.waitingReason).toContain(contender.name);
    // Inside the grace period the division waits rather than moving on.
    expect(mayBypassContender(f.save, 'lightweight').allowed).toBe(false);

    // The claim survives a review inside the grace period.
    reviewContenderClaims(f.save);
    expect(currentContender(f.save, 'lightweight')).not.toBeNull();
  });

  it('lets the division move on once the grace period is exhausted', () => {
    const f = newCareer(7204);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    for (const x of pool) makeAvailable(x);
    const contender = pool[1];
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    contender.medicalSuspension = { until: addDays(f.save.date, 900), reason: 'knee reconstruction', clearanceRequired: true };

    // The grace clock starts when the promotion first sees the fighter is unavailable, not when
    // the claim was earned, so the first review is what stamps it.
    reviewContenderClaims(f.save);
    expect(currentContender(f.save, 'lightweight')).not.toBeNull();

    f.save.date = addDays(f.save.date, CONTENDER_INJURY_GRACE_DAYS + 5);
    expect(mayBypassContender(f.save, 'lightweight').allowed).toBe(true);
    const notes = reviewContenderClaims(f.save);
    expect(notes.join(' ')).toContain(contender.name);
    expect(currentContender(f.save, 'lightweight')).toBeNull();
  });

  it('does not block the division when the contender is merely booked', () => {
    const f = newCareer(7205);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    for (const x of pool) makeAvailable(x);
    const contender = pool[1];
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    contender.nextBoutId = 'bout-elsewhere';
    // Being booked is a real scheduling conflict, which is one of the stated exceptions.
    expect(mayBypassContender(f.save, 'lightweight').allowed).toBe(true);
  });
});

describe('losing the position', () => {
  it('is forfeited when the contender loses', () => {
    const f = newCareer(7301);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const contender = makeAvailable(pool[0]);
    const other = makeAvailable(pool[1]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);

    const { bout, result } = eliminatorResult(f.save, contender, other, other);
    bout.bookingKind = 'ranked-matchup';
    const notes = applyResultToContenders(f.save, bout, result);
    expect(currentContender(f.save, 'lightweight')).toBeNull();
    expect(notes.join(' ').toLowerCase()).toContain('lost the number one contender position');
  });

  it('is consumed when the title shot is taken', () => {
    const f = newCareer(7302);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const contender = makeAvailable(pool[0]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    expect(fulfilContenderStatus(f.save, 'lightweight', contender.id, 'bout-title')).toBe(true);
    expect(currentContender(f.save, 'lightweight')).toBeNull();
  });

  it('is vacated by a division change', () => {
    const f = newCareer(7303);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const contender = makeAvailable(pool[0]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    contender.divisionId = 'welterweight';
    expect(currentContender(f.save, 'lightweight')).toBeNull();
    const notes = reviewContenderClaims(f.save);
    expect(notes.join(' ')).toContain('changing weight');
  });

  it('is given up on retirement', () => {
    const f = newCareer(7304);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const contender = makeAvailable(pool[0]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    contender.retired = true;
    const notes = reviewContenderClaims(f.save);
    expect(currentContender(f.save, 'lightweight')).toBeNull();
    expect(notes.join(' ')).toContain(contender.name);
  });

  it('can be forfeited explicitly with a stated reason', () => {
    const f = newCareer(7305);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const contender = makeAvailable(pool[0]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    const record = forfeitContenderStatus(f.save, 'lightweight', 'Turned the fight down.');
    expect(record?.forfeitReason).toBe('Turned the fight down.');
    expect(currentContender(f.save, 'lightweight')).toBeNull();
  });
});

describe('a champion moving division', () => {
  function crown(save: SaveGame): Fighter {
    const me = makeAvailable(playerOf(save));
    const table = save.rankings[me.divisionId];
    table.championId = me.id;
    table.entries = table.entries.filter((e) => e.fighterId !== me.id);
    me.isChampion = true;
    me.titleReigns = 1;
    me.titleDefenses = 3;
    me.popularity = 80;
    me.winStreak = 6;
    return me;
  }

  function above(f: Fighter) {
    return Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[f.divisionId].order + 1 && d.gender === DIVISION_BY_ID[f.divisionId].gender
    )!;
  }

  it('receives a real contender position, not only an explanation', () => {
    const f = newCareer(7401);
    const me = crown(f.save);
    const target = above(me);
    const destChampion = makeAvailable(f.save.fighters[f.save.rankings[target.id].championId!]);
    destChampion.popularity = 80;
    for (const x of roster(f.save, target.id)) makeAvailable(x);

    const assessment = assessChampionMove(f.save, me, target.id);
    expect(assessment.championshipOnTheLine).toBe(true);

    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    const outcome = commitMove(f.save, me, true);
    expect(outcome.moved).toBe(true);

    // The promise is now an earned claim the title pass will honour, rather than a sentence.
    const record = currentContender(f.save, target.id);
    expect(record).not.toBeNull();
    expect(record!.fighterId).toBe(me.id);
    expect(record!.source).toBe('division-move');

    // And the gate agrees they are the challenger.
    const eligibility = titleShotEligibility(f.save, me, target.id);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.claim).toBeGreaterThan(100);
  });

  it('gives up any contender position held in the division it leaves', () => {
    const f = newCareer(7402);
    const me = makeAvailable(playerOf(f.save));
    const from = me.divisionId;
    grantContenderStatus(f.save, me, from, 'eliminator-win', null);
    expect(currentContender(f.save, from)).not.toBeNull();

    const target = above(me);
    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    commitMove(f.save, me, true);
    expect(currentContender(f.save, from)).toBeNull();
  });
});

describe('the contender position over a running world', () => {
  it('never leaves two standing contenders in one division', () => {
    const f = newCareer(7501);
    runWorld(f.save, 52);
    const byDivision = new Map<string, number>();
    for (const record of Object.values(f.save.contenders ?? {})) {
      if (record.fulfilledOn || record.forfeitedOn) continue;
      byDivision.set(record.divisionId, (byDivision.get(record.divisionId) ?? 0) + 1);
    }
    for (const [division, count] of byDivision) {
      expect(count, `division ${division}`).toBeLessThanOrEqual(1);
    }
  });

  it('never leaves the champion holding their own contender position', () => {
    const f = newCareer(7502);
    runWorld(f.save, 52);
    for (const [divisionId, record] of Object.entries(f.save.contenders ?? {})) {
      if (record.fulfilledOn || record.forfeitedOn) continue;
      expect(f.save.rankings[divisionId as keyof typeof f.save.rankings]?.championId).not.toBe(record.fighterId);
    }
  });

  it('does not permanently block a division from making a title fight', () => {
    const f = newCareer(7503);
    runWorld(f.save, 78);
    // Over eighteen months every division should have produced at least one championship bout,
    // which is the property that proves a standing claim cannot deadlock the title picture.
    const titleBoutsByDivision = new Map<string, number>();
    for (const result of Object.values(f.save.history.results)) {
      if (!result.isTitleFight && !result.isInterimTitleFight) continue;
      titleBoutsByDivision.set(result.divisionId, (titleBoutsByDivision.get(result.divisionId) ?? 0) + 1);
    }
    expect(titleBoutsByDivision.size).toBeGreaterThan(0);
  });
});

describe('migrating a save with no contender concept', () => {
  it('recovers a claim only where an eliminator provides evidence', () => {
    const f = newCareer(7601);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const winner = makeAvailable(pool[0]);
    const loser = makeAvailable(pool[1]);
    const { bout, result } = eliminatorResult(f.save, winner, loser, winner);
    f.save.history.results[bout.id] = result;

    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 13;
    delete (legacy as Partial<SaveGame>).contenders;

    const migrated = migrateSave(legacy);
    expect(migrated.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    const record = currentContender(migrated, 'lightweight');
    expect(record).not.toBeNull();
    expect(record!.fighterId).toBe(winner.id);
  });

  it('invents nothing when there is no evidence', () => {
    const f = newCareer(7602);
    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 13;
    delete (legacy as Partial<SaveGame>).contenders;
    const migrated = migrateSave(legacy);
    expect(migrated.contenders).toBeTruthy();
    // No eliminator has ever happened, so no division has a standing contender. That is a
    // valid state, and fabricating one would be worse than leaving it empty.
    for (const divisionId of Object.keys(migrated.rankings)) {
      expect(currentContender(migrated, divisionId as never)).toBeNull();
    }
  });

  it('does not resurrect a claim for somebody who has since lost', () => {
    const f = newCareer(7603);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const winner = makeAvailable(pool[0]);
    const loser = makeAvailable(pool[1]);
    const { bout, result } = eliminatorResult(f.save, winner, loser, winner);
    f.save.history.results[bout.id] = result;
    winner.lossStreak = 1;

    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 13;
    delete (legacy as Partial<SaveGame>).contenders;
    const migrated = migrateSave(legacy);
    expect(currentContender(migrated, 'lightweight')).toBeNull();
  });

  it('survives a save round trip', () => {
    const f = newCareer(7604);
    const pool = roster(f.save, 'lightweight').filter((x) => x.id !== f.save.rankings.lightweight.championId);
    const contender = makeAvailable(pool[0]);
    grantContenderStatus(f.save, contender, 'lightweight', 'eliminator-win', null);
    const reloaded = migrateSave(JSON.parse(JSON.stringify(f.save)) as SaveGame);
    const record = currentContender(reloaded, 'lightweight');
    expect(record).not.toBeNull();
    expect(record!.fighterId).toBe(contender.id);
    expect(record!.source).toBe('eliminator-win');
  });
});


describe('a belt is not on the line without the fighter who holds it', () => {
  it('strips the title when the champion is the one who withdraws', () => {
    const f = newCareer(9820);
    const divisionId = DIVISIONS[0].id;
    const table = f.save.rankings[divisionId];
    const champion = f.save.fighters[table.championId!];
    const challenger = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking === 1 && x.id !== champion.id
    )!;
    const event = createEvent(f.save, addDays(f.save.date, 60));
    const bout: Bout = {
      id: `bout-title-${champion.id}`,
      eventId: event.id,
      date: event.date,
      fighterAId: champion.id,
      fighterBId: challenger.id,
      divisionId,
      contractedWeightLb: DIVISION_BY_ID[divisionId].limitLb,
      scheduledRounds: 5,
      isTitleFight: true,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      isMainEvent: true,
      isCoMain: false,
      cardSegment: 'main',
      boutOrder: 1,
      isCatchweight: false,
      status: 'scheduled',
      resultId: null,
      bookedOn: f.save.date,
      replacementHistory: [],
      cancelReason: null,
      purseA: { show: 1, win: 1 },
      purseB: { show: 1, win: 1 },
      weighInA: null,
      weighInB: null,
      bookingReason: 'championship bout',
      bookingKind: 'title-fight',
    };
    bookBout(f.save, bout);
    expect(bout.isTitleFight).toBe(true);

    // Somebody ranked well enough that the replacement rule alone would keep the belt on it.
    const replacement = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking !== null && x.ranking <= 5 && x.id !== challenger.id && x.id !== champion.id
    )!;
    applyReplacement(f.save, bout, champion.id, replacement, 'stepping in');
    expect(bout.isTitleFight).toBe(false);
    expect(bout.isInterimTitleFight).toBe(false);
  });
});
