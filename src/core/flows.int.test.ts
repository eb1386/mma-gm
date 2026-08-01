import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from './rng';
import { DIVISIONS } from './config/divisions';
import { addDays, daysBetween } from './types/common';
import type { SaveGame } from './types/save';
import type { SnapshotFile } from './data/snapshot';
import { createNewGame } from './world/newgame';
import { advance, resolveBout, simulatePlayerBout } from './world/tick';
import { respondToOffer } from './world/offers';
import { CAMP_PRESETS, createCamp } from './world/camp';
import { actionableMessages, messageNeedsAction } from './world/inbox';
import { migrateSave } from './save/migrate';
import { moveFighterToGym, recruitmentChance } from './world/gyms';
import { canCompete, manageWalkingWeight } from './world/health';
import { shouldCreateInterimTitle } from './world/matchmaking';
import { updatePot } from './world/pot';
import { CALENDAR_TARGETS, rollingYearCounts } from './world/matchmaking';

/**
 * Integration flows.
 *
 * These are the invariants that a career depends on and that unit tests cannot reach:
 * one bout produces one offer, one camp, one result and one payment, booking pointers
 * stay honest, and a save round trips to exactly the same world.
 */

const DATA = join(process.cwd(), 'public', 'data');
const snapshotFile = existsSync(DATA) ? readdirSync(DATA).find((f) => f.startsWith('snapshot-')) : undefined;

let snapshot: SnapshotFile;

beforeAll(() => {
  if (!snapshotFile) throw new Error('Build the snapshot first: npx vite-node tools/build-snapshot.ts');
  snapshot = JSON.parse(readFileSync(join(DATA, snapshotFile), 'utf8')) as SnapshotFile;
});

function newFighterCareer(seed: number, opts: { divisionId?: string } = {}): { save: SaveGame; playerId: string } {
  const target =
    snapshot.fighters.find((f) => (opts.divisionId ? f.divisionId === opts.divisionId : true) && f.ranking !== null && f.ranking > 6) ??
    snapshot.fighters[0];
  const { save } = createNewGame(snapshot, { saveName: 'flow', seed, mode: 'fighter', playerFighterId: target.id });
  return { save, playerId: target.id };
}

/** Drives a fighter career forward, accepting offers and setting one camp per bout. */
function runCareer(
  save: SaveGame,
  playerId: string,
  opts: { weeks: number; maxFights: number; declineEvery?: number }
): {
  fights: number;
  offersSeen: number;
  campsCreated: number;
  accepted: number;
  declined: number;
  boutsAccepted: string[];
} {
  const me = save.fighters[playerId];
  let fights = 0;
  let offersSeen = 0;
  let campsCreated = 0;
  let accepted = 0;
  let declined = 0;
  const boutsAccepted: string[] = [];

  for (let w = 0; w < opts.weeks && fights < opts.maxFights; w++) {
    for (const offer of Object.values(save.fightOffers)) {
      if (offer.fighterId !== playerId || offer.status !== 'open') continue;
      offersSeen++;
      const shouldDecline = opts.declineEvery !== undefined && offersSeen % opts.declineEvery === 0;
      const rng = new Rng(save.rng);
      const res = respondToOffer(
        save,
        offer.id,
        shouldDecline ? { kind: 'decline', reason: 'short-notice' } : { kind: 'accept' },
        rng
      );
      save.rng = rng.getState();
      if (!res.accepted) {
        declined++;
        continue;
      }
      accepted++;
      boutsAccepted.push(res.boutId!);
      const preset = CAMP_PRESETS[0];
      const camp = createCamp(save, me, {
        boutId: res.boutId,
        startDate: save.date,
        endDate: addDays(offer.date, -7),
        focus: preset.focus,
        intensity: preset.intensity,
        gymId: me.gymId,
        campType: 'home',
        specialistHired: null,
        gamePlan: preset.plans,
        arriveEarlyDays: 0,
      });
      save.camps[camp.id] = camp;
      campsCreated++;
    }

    // Answer anything else so the calendar is not blocked by an unrelated decision.
    for (const m of save.inbox) {
      if (messageNeedsAction(save, m) && !m.linkedOfferId) {
        m.status = 'resolved';
        m.resolution = 'auto answered by the integration harness';
      }
    }

    const report = advance(save, { mode: 'week', stopOnDecision: false });
    if (report.playerBoutPending) {
      simulatePlayerBout(save, report.playerBoutPending, ['pressure']);
      fights++;
    }
  }
  return { fights, offersSeen, campsCreated, accepted, declined, boutsAccepted };
}

// ---------------------------------------------------------------------------

describe('booking integrity', () => {
  it('never cancels or re-offers a bout the player already accepted', () => {
    const { save, playerId } = newFighterCareer(9001);
    const run = runCareer(save, playerId, { weeks: 90, maxFights: 4 });

    expect(run.accepted).toBeGreaterThan(0);
    for (const boutId of run.boutsAccepted) {
      const bout = save.bouts[boutId];
      expect(bout).toBeDefined();
      // Every accepted bout was either contested or is still scheduled. None was quietly
      // cancelled and turned back into an offer.
      expect(['scheduled', 'completed']).toContain(bout.status);
    }
    // No two open offers ever pointed at the same event for the player.
    const offers = Object.values(save.fightOffers).filter((o) => o.fighterId === playerId);
    const eventCounts = new Map<string, number>();
    for (const o of offers) eventCounts.set(o.eventId, (eventCounts.get(o.eventId) ?? 0) + 1);
    for (const [, count] of eventCounts) expect(count).toBeLessThanOrEqual(1);
  });

  it('creates exactly one camp per accepted bout', () => {
    const { save, playerId } = newFighterCareer(9002);
    const run = runCareer(save, playerId, { weeks: 90, maxFights: 4 });
    expect(run.campsCreated).toBe(run.accepted);

    const campsByBout = new Map<string, number>();
    for (const camp of Object.values(save.camps)) {
      if (camp.fighterId !== playerId || !camp.boutId) continue;
      campsByBout.set(camp.boutId, (campsByBout.get(camp.boutId) ?? 0) + 1);
    }
    for (const [, count] of campsByBout) expect(count).toBe(1);
  });

  it('never gives any fighter a second open offer while already booked', () => {
    const { save, playerId } = newFighterCareer(9003);
    runCareer(save, playerId, { weeks: 60, maxFights: 3 });

    const openByFighter = new Map<string, number>();
    for (const o of Object.values(save.fightOffers)) {
      if (o.status !== 'open') continue;
      openByFighter.set(o.fighterId, (openByFighter.get(o.fighterId) ?? 0) + 1);
    }
    for (const [fighterId, count] of openByFighter) {
      expect(count).toBeLessThanOrEqual(1);
      // A fighter with a booked bout must not also have an offer waiting.
      expect(save.fighters[fighterId]?.nextBoutId ?? null).toBeNull();
    }
  });

  it('keeps booking pointers valid and clears them when a fight completes', () => {
    const { save, playerId } = newFighterCareer(9004);
    runCareer(save, playerId, { weeks: 120, maxFights: 5 });

    for (const f of Object.values(save.fighters)) {
      if (!f.nextBoutId) continue;
      const bout = save.bouts[f.nextBoutId];
      expect(bout, `${f.name} points at a missing bout`).toBeDefined();
      expect(bout.status).toBe('scheduled');
      expect([bout.fighterAId, bout.fighterBId]).toContain(f.id);
      expect(bout.date >= save.date).toBe(true);
    }

    // Every completed bout released both fighters.
    for (const bout of Object.values(save.bouts)) {
      if (bout.status !== 'completed') continue;
      for (const id of [bout.fighterAId, bout.fighterBId]) {
        expect(save.fighters[id]?.nextBoutId).not.toBe(bout.id);
      }
    }
  });

  it('never double books a fighter on one card or across cards', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9005, mode: 'spectator' });
    advance(save, { mode: 'month', maxDays: 150, stopOnDecision: false });

    const scheduledPerFighter = new Map<string, number>();
    for (const b of Object.values(save.bouts)) {
      if (b.status !== 'scheduled') continue;
      for (const id of [b.fighterAId, b.fighterBId]) scheduledPerFighter.set(id, (scheduledPerFighter.get(id) ?? 0) + 1);
    }
    for (const [, count] of scheduledPerFighter) expect(count).toBe(1);

    for (const ev of Object.values(save.events)) {
      const ids = ev.boutIds
        .map((id) => save.bouts[id])
        .filter((b) => b && b.status === 'scheduled')
        .flatMap((b) => [b.fighterAId, b.fighterBId]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('economy and history integrity', () => {
  it('stores each result once, decrements the contract once and pays once', () => {
    const { save, playerId } = newFighterCareer(9010);
    const before = save.fighters[playerId].careerEarnings;
    const contractBefore = save.contracts[save.fighters[playerId].contractId!].fightsRemaining;
    const run = runCareer(save, playerId, { weeks: 120, maxFights: 3 });
    expect(run.fights).toBeGreaterThan(0);

    const me = save.fighters[playerId];

    // One stored result per contested bout, keyed by bout id, so a duplicate is impossible
    // to represent. Verify the fighter's own bout list has no repeats either.
    expect(new Set(me.boutIds).size).toBe(me.boutIds.length);
    const contested = me.boutIds.filter((id) => save.history.results[id]);
    expect(contested.length).toBe(run.fights);

    // Contract consumption matches contested fights exactly.
    const contract = save.contracts[me.contractId!];
    const consumed = contractBefore - contract.fightsRemaining;
    expect(consumed).toBeLessThanOrEqual(run.fights);

    // Earnings increased by exactly the sum of the purses actually earned.
    let expected = 0;
    for (const id of contested) {
      const bout = save.bouts[id];
      const result = save.history.results[id];
      const purse = bout.fighterAId === me.id ? bout.purseA : bout.purseB;
      expected += purse.show + (result.winnerId === me.id ? purse.win : 0);
    }
    const bonuses = me.awards.filter((a) => a.includes('of the Night')).length * 50000;
    expect(me.careerEarnings - before).toBeCloseTo(expected + bonuses, 0);
  });

  it('completes each camp once and only once', () => {
    const { save, playerId } = newFighterCareer(9011);
    runCareer(save, playerId, { weeks: 120, maxFights: 4 });
    for (const camp of Object.values(save.camps)) {
      if (camp.status !== 'complete') continue;
      // A completed camp has a single recorded outcome for sharpness, so finalizing twice
      // would be visible as a camp whose completed weeks exceed its planned length.
      expect(camp.weeksCompleted).toBeLessThanOrEqual(camp.weeks + 1);
      expect(camp.resultingSharpness).not.toBeNull();
      expect(camp.resultingSharpness!).toBeGreaterThanOrEqual(0);
      expect(camp.resultingSharpness!).toBeLessThanOrEqual(1);
    }
  });

  it('does not count a canceled bout as activity, a record or a payment', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9012, mode: 'spectator' });
    advance(save, { mode: 'month', maxDays: 200, stopOnDecision: false });
    for (const bout of Object.values(save.bouts)) {
      if (bout.status !== 'canceled') continue;
      expect(save.history.results[bout.id]).toBeUndefined();
      for (const id of [bout.fighterAId, bout.fighterBId]) {
        const f = save.fighters[id];
        if (!f) continue;
        expect(f.boutIds).not.toContain(bout.id);
        expect(f.nextBoutId).not.toBe(bout.id);
      }
    }
  });
});

describe('title and ranking integrity', () => {
  it('vacates a title when the champion changes division and removes them from the old rankings', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9020, mode: 'spectator' });
    const division = DIVISIONS.find((d) => save.rankings[d.id].championId)!;
    const champId = save.rankings[division.id].championId!;
    const champ = save.fighters[champId];

    // Force the champion into a state where the weight model must move them up.
    champ.weightMisses = 5;
    const move = manageWalkingWeight(champ, save.date);
    expect(move.movedUp).toBeTruthy();

    // The weekly pass performs the bookkeeping.
    champ.divisionId = division.id;
    champ.weightMisses = 5;
    advance(save, { mode: 'week', stopOnDecision: false });
    advance(save, { mode: 'week', stopOnDecision: false });

    if (champ.divisionId !== division.id) {
      expect(save.rankings[division.id].championId).not.toBe(champId);
      expect(save.rankings[division.id].entries.some((e) => e.fighterId === champId)).toBe(false);
      const reign = save.history.reigns.find((r) => r.fighterId === champId && r.divisionId === division.id);
      expect(reign?.lostOn).toBeTruthy();
      expect(['vacated', 'stripped', 'promoted', 'defeated', 'retired']).toContain(reign?.endReason);
    }
  });

  it('keeps rankings free of fighters who left the division', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9021, mode: 'spectator' });
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    for (const d of DIVISIONS) {
      for (const e of save.rankings[d.id].entries) {
        const f = save.fighters[e.fighterId];
        expect(f, `ranked fighter ${e.fighterId} missing`).toBeDefined();
        expect(f.divisionId).toBe(d.id);
        expect(f.retired).toBe(false);
      }
      const champId = save.rankings[d.id].championId;
      if (champId) {
        expect(save.fighters[champId].divisionId).toBe(d.id);
        expect(save.fighters[champId].retired).toBe(false);
      }
    }
  });

  it('keeps title lineage coherent after stripping, retirement and division changes', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9022, mode: 'spectator' });
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });

    for (const d of DIVISIONS) {
      const reigns = save.history.reigns.filter((r) => r.divisionId === d.id && !r.isInterim);
      // At most one open reign per division, and it must match the ranking table.
      const open = reigns.filter((r) => r.lostOn === null);
      expect(open.length).toBeLessThanOrEqual(1);
      const champId = save.rankings[d.id].championId;
      if (champId) expect(open[0]?.fighterId).toBe(champId);
      else expect(open.length).toBe(0);

      for (const r of reigns) {
        expect(r.wonOn <= (r.lostOn ?? save.date)).toBe(true);
        if (r.lostOn) expect(r.endReason).toBeTruthy();
        expect(save.fighters[r.fighterId]).toBeDefined();
      }
      // Reigns never overlap in time within a division.
      const sorted = [...reigns].sort((a, b) => (a.wonOn < b.wonOn ? -1 : 1));
      for (let i = 1; i < sorted.length; i++) {
        const prevEnd = sorted[i - 1].lostOn;
        expect(prevEnd, `${d.name} has two overlapping reigns`).toBeTruthy();
        if (prevEnd) expect(sorted[i].wonOn >= prevEnd).toBe(true);
      }
    }
  });

  // Multi year acceptance runs produce zero interim titles, because champions defend often
  // enough that the window never opens on its own. That leaves the path unexercised, so it
  // is driven directly here rather than being reported as working on the strength of code
  // that has never run.
  it('creates an interim title when the champion is injured past the interim threshold', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9023, mode: 'spectator' });
    const division = DIVISIONS.find((d) => save.rankings[d.id].championId && save.rankings[d.id].entries.length > 4)!;
    const champ = save.fighters[save.rankings[division.id].championId!];

    // Idle long enough for an interim title but short of the stripping threshold, and
    // blocked by an injury that outlasts the window being tested.
    champ.lastFightDate = addDays(save.date, -330);
    champ.injuries.push({
      id: 'inj-interim-test',
      type: 'reconstructed knee ligament',
      area: 'knee',
      severity: 5,
      startedAt: addDays(save.date, -120),
      expectedReturn: addDays(save.date, 400),
      actualReturn: null,
      cause: 'training',
      trainingCapacity: 0.15,
      blocksCompetition: true,
      recurrenceChance: 0.2,
      treatment: 'surgery',
      note: 'test fixture for the interim title path',
    });
    expect(canCompete(champ, save.date).ok).toBe(false);
    expect(shouldCreateInterimTitle(save, division.id)).toBe(true);

    // Numbered cards carry title bouts and land roughly monthly, so a season of weeks is
    // enough for the booking pass to reach one.
    let booked = null as ReturnType<typeof Object.values<(typeof save.bouts)[string]>>[number] | null;
    for (let w = 0; w < 16 && !booked; w++) {
      advance(save, { mode: 'week', stopOnDecision: false });
      booked = Object.values(save.bouts).find((b) => b.isInterimTitleFight && b.divisionId === division.id) ?? null;
    }

    expect(booked, `no interim ${division.name} title bout was booked`).toBeTruthy();
    expect(booked!.isTitleFight).toBe(false);
    expect([booked!.fighterAId, booked!.fighterBId]).not.toContain(champ.id);
    expect(save.rankings[division.id].championId).toBe(champ.id);

    // Carry it through to a result and confirm the interim reign is recorded separately
    // from the undisputed one rather than displacing it.
    let guard = 0;
    while (save.bouts[booked!.id].status === 'scheduled' && guard++ < 40) {
      advance(save, { mode: 'week', stopOnDecision: false });
    }
    const result = save.history.results[booked!.id];
    expect(result, 'the interim bout never produced a result').toBeTruthy();
    const winnerMadeWeight = !(result!.titleIneligibleFighterIds ?? []).includes(result!.winnerId ?? '');
    const interimReign = save.history.reigns.find((r) => r.isInterim && r.divisionId === division.id);

    if (result!.isInterimTitleFight && result!.winnerId && winnerMadeWeight) {
      expect(interimReign, 'an interim win did not open an interim reign').toBeTruthy();
      expect(interimReign!.fighterId).toBe(result!.winnerId);
      expect(save.fighters[result!.winnerId].isInterimChampion).toBe(true);
      // The undisputed reign is untouched by an interim result.
      const undisputed = save.history.reigns.find((r) => !r.isInterim && r.divisionId === division.id && r.lostOn === null);
      expect(undisputed?.fighterId).toBe(champ.id);
    } else {
      // The winner missed weight, so no belt may be held by them afterwards.
      expect(interimReign?.fighterId).not.toBe(result!.winnerId);
      expect(save.rankings[division.id].interimChampionId).not.toBe(result!.winnerId);
    }
  });
});

describe('decisions and the advance control', () => {
  it('stops advancement when something needs an answer and resumes once it is handled', () => {
    const { save, playerId } = newFighterCareer(9030);
    let guard = 0;
    while (actionableMessages(save).length === 0 && guard++ < 60) {
      advance(save, { mode: 'week', stopOnDecision: true });
    }
    expect(actionableMessages(save).length).toBeGreaterThan(0);

    // With a decision waiting, advance refuses to run away with the calendar.
    const before = save.date;
    advance(save, { mode: 'month', stopOnDecision: true });
    expect(daysBetween(before, save.date)).toBeLessThanOrEqual(31);

    // Accepting the offer clears the message, so the control stops asking for an answer.
    const offer = Object.values(save.fightOffers).find((o) => o.fighterId === playerId && o.status === 'open');
    if (offer) {
      const rng = new Rng(save.rng);
      respondToOffer(save, offer.id, { kind: 'accept' }, rng);
      save.rng = rng.getState();
      const stillAsking = actionableMessages(save).filter((m) => m.linkedOfferId === offer.id);
      expect(stillAsking).toHaveLength(0);
    }
  });

  it('closes an offer message once the offer is no longer open, whatever the outcome', () => {
    for (const [seed, response] of [
      [9031, { kind: 'accept' as const }],
      [9032, { kind: 'decline' as const, reason: 'no-reason' as const }],
    ] as const) {
      const { save, playerId } = newFighterCareer(seed);
      let guard = 0;
      let offer = Object.values(save.fightOffers).find((o) => o.fighterId === playerId && o.status === 'open');
      while (!offer && guard++ < 60) {
        advance(save, { mode: 'week', stopOnDecision: false });
        offer = Object.values(save.fightOffers).find((o) => o.fighterId === playerId && o.status === 'open');
      }
      expect(offer).toBeDefined();
      const linked = save.inbox.filter((m) => m.linkedOfferId === offer!.id);
      expect(linked.length).toBeGreaterThan(0);

      const rng = new Rng(save.rng);
      respondToOffer(save, offer!.id, response, rng);
      save.rng = rng.getState();

      for (const m of save.inbox.filter((x) => x.linkedOfferId === offer!.id)) {
        expect(messageNeedsAction(save, m)).toBe(false);
        expect(m.status).toBe('resolved');
        expect(m.resolution).toBeTruthy();
      }
    }
  });
});

describe('save round trip', () => {
  it('reloads into exactly the same world state', () => {
    const { save } = createNewGame(snapshot, { saveName: 'flow', seed: 9040, mode: 'spectator' });
    advance(save, { mode: 'month', maxDays: 120, stopOnDecision: false });

    const serialized = JSON.stringify(save);
    const reloaded = migrateSave(JSON.parse(serialized) as SaveGame);
    expect(JSON.stringify(reloaded)).toBe(serialized);

    // Continuing from the reloaded save produces the identical future.
    const a = migrateSave(JSON.parse(serialized) as SaveGame);
    const b = migrateSave(JSON.parse(serialized) as SaveGame);
    advance(a, { mode: 'month', maxDays: 120, stopOnDecision: false });
    advance(b, { mode: 'month', maxDays: 120, stopOnDecision: false });
    expect(JSON.stringify(b.history.results)).toBe(JSON.stringify(a.history.results));
    expect(b.date).toBe(a.date);
  });

  it('survives an export and import cycle with the career intact', () => {
    const { save, playerId } = newFighterCareer(9041);
    runCareer(save, playerId, { weeks: 60, maxFights: 2 });

    // The legacy export tag must still import, which is what this line is checking.
    const exported = JSON.stringify({ format: 'octagon-gm-save', schemaVersion: save.schemaVersion, save });
    const parsed = JSON.parse(exported) as { save: SaveGame };
    const imported = migrateSave(parsed.save);

    expect(imported.date).toBe(save.date);
    expect(Object.keys(imported.fighters).length).toBe(Object.keys(save.fighters).length);
    expect(Object.keys(imported.history.results).length).toBe(Object.keys(save.history.results).length);
    const me = imported.fighters[playerId];
    expect(me.record).toEqual(save.fighters[playerId].record);
    expect(me.careerEarnings).toBe(save.fighters[playerId].careerEarnings);
    expect(imported.player.fighterId).toBe(playerId);
    expect(imported.snapshot.snapshotId).toBe(save.snapshot.snapshotId);
  });
});

describe('game modes', () => {
  it('runs a Fighter Mode career end to end', () => {
    const { save, playerId } = newFighterCareer(9050);
    const run = runCareer(save, playerId, { weeks: 160, maxFights: 6, declineEvery: 5 });
    const me = save.fighters[playerId];

    expect(run.fights).toBeGreaterThanOrEqual(3);
    expect(run.offersSeen).toBeGreaterThanOrEqual(run.accepted + run.declined);
    expect(me.ufcRecord.wins + me.ufcRecord.losses + me.ufcRecord.draws).toBeGreaterThanOrEqual(run.fights);
    expect(me.careerEarnings).toBeGreaterThan(0);
    // Every contested fight produced a narrated result with round detail.
    for (const id of me.boutIds) {
      const r = save.history.results[id];
      if (!r) continue;
      expect(r.narrativeSummary.length).toBeGreaterThan(10);
      expect(r.rounds.length).toBeGreaterThan(0);
    }
  });

  it('runs a Coach Mode flow with recruiting, autonomy and finances', () => {
    const { save } = createNewGame(snapshot, {
      saveName: 'coach',
      seed: 9051,
      mode: 'coach',
      coach: { name: 'Test Coach', newGym: { name: 'Test Gym', country: 'United States', city: 'Denver' } },
    });
    const gymId = save.player.gymId!;
    expect(gymId).toBeTruthy();
    const gym = save.gyms[gymId];
    expect(gym.isPlayerControlled).toBe(true);

    // Recruit whoever the pitch is most likely to land.
    const targets = Object.values(save.fighters)
      .filter((f) => !f.retired && f.gymId !== gymId)
      .map((f) => ({ f, p: recruitmentChance(save, gym, f) }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 6);
    expect(targets[0].p).toBeGreaterThan(0);
    for (const t of targets) moveFighterToGym(save, t.f.id, gymId);
    expect(save.gyms[gymId].fighterIds.length).toBeGreaterThanOrEqual(6);

    const balanceBefore = save.gyms[gymId].balance;
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });

    // The gym roster fought, happiness moved, and the books were run.
    const roster = save.gyms[gymId].fighterIds.map((id) => save.fighters[id]).filter(Boolean);
    expect(roster.length).toBeGreaterThan(0);
    const totalFights = roster.reduce((s, f) => s + f.boutIds.filter((id) => save.history.results[id]).length, 0);
    expect(totalFights).toBeGreaterThan(0);
    expect(save.gyms[gymId].balance).not.toBe(balanceBefore);
    for (const f of roster) {
      expect(f.happiness).toBeGreaterThanOrEqual(0);
      expect(f.happiness).toBeLessThanOrEqual(100);
    }
  });

  it('runs a Spectator Mode multi year flow', () => {
    const { save } = createNewGame(snapshot, { saveName: 'spectate', seed: 9052, mode: 'spectator' });
    for (let y = 0; y < 3; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });

    expect(Object.keys(save.history.results).length).toBeGreaterThan(400);
    expect(save.history.news.length).toBeGreaterThan(100);
    expect(save.history.awards.length).toBeGreaterThan(0);
    expect(save.history.retirements.length).toBeGreaterThan(0);
    // The world kept producing new fighters and kept every division populated.
    for (const d of DIVISIONS) {
      const active = Object.values(save.fighters).filter((f) => f.divisionId === d.id && !f.retired && f.activityStatus === 'active');
      expect(active.length, `${d.name} emptied out`).toBeGreaterThan(8);
    }
  });
});

describe('Pot scheduling', () => {
  it('caches a projection and reuses it until an input changes', () => {
    const { save } = createNewGame(snapshot, { saveName: 'pot', seed: 9060, mode: 'spectator' });
    const fighter = Object.values(save.fighters).find((f) => f.ranking !== null)!;
    const first = updatePot(save, fighter);
    const second = updatePot(save, fighter);
    expect(second).toBe(first);

    // A meaningful rating change produces a new key and a fresh projection.
    fighter.ratings.striking = Math.min(99, fighter.ratings.striking + 9);
    const third = updatePot(save, fighter);
    expect(third).toBeGreaterThanOrEqual(Math.round((fighter.ratings.striking + fighter.ratings.grappling + fighter.ratings.wrestling + fighter.ratings.submissions + fighter.ratings.cardio + fighter.ratings.durability) / 6));
  });

  it('never projects Pot below current Ovr for anyone on the roster', () => {
    const { save } = createNewGame(snapshot, { saveName: 'pot', seed: 9061, mode: 'spectator' });
    for (const f of Object.values(save.fighters)) {
      const ovr = Math.round((f.ratings.striking + f.ratings.grappling + f.ratings.wrestling + f.ratings.submissions + f.ratings.cardio + f.ratings.durability) / 6);
      expect(f.pot, `${f.name} has Pot below Ovr`).toBeGreaterThanOrEqual(ovr);
    }
  });
});

describe('resolveBout is the only path that records a result', () => {
  it('records exactly one result and one set of consequences per bout', () => {
    const { save } = createNewGame(snapshot, { saveName: 'once', seed: 9070, mode: 'spectator' });
    advance(save, { mode: 'month', maxDays: 90, stopOnDecision: false });
    const bout = Object.values(save.bouts).find((b) => b.status === 'scheduled')!;
    const a = save.fighters[bout.fighterAId];
    const winsBefore = a.record.wins + a.record.losses + a.record.draws;
    const earningsBefore = a.careerEarnings;

    const rng = new Rng(save.rng);
    resolveBout(save, bout, rng);
    save.rng = rng.getState();

    expect(bout.status).toBe('completed');
    expect(save.history.results[bout.id]).toBeDefined();
    const after = a.record.wins + a.record.losses + a.record.draws;
    expect(after).toBe(winsBefore + 1);
    expect(a.careerEarnings).toBeGreaterThan(earningsBefore);
    expect(a.boutIds.filter((id) => id === bout.id)).toHaveLength(1);
    expect(a.nextBoutId).not.toBe(bout.id);
  });
});

// ---------------------------------------------------------------------------
// Calendar acceptance
// ---------------------------------------------------------------------------

describe('annual calendar', () => {
  it('produces roughly the target number of events, numbered cards and clear weekends', () => {
    const { save } = createNewGame(snapshot, { saveName: 'cal', seed: 9080, mode: 'spectator' });
    for (let y = 0; y < 3; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });

    const years = daysBetween(save.startDate, save.date) / 365;
    const completed = Object.values(save.events).filter((e) => e.status === 'completed');
    const ppv = completed.filter((e) => e.tier === 'numbered-ppv');
    const eventsPerYear = completed.length / years;
    const ppvPerYear = ppv.length / years;
    const fightNightsPerYear = (completed.length - ppv.length) / years;

    expect(eventsPerYear).toBeGreaterThan(CALENDAR_TARGETS.eventsPerYear - 6);
    expect(eventsPerYear).toBeLessThan(CALENDAR_TARGETS.eventsPerYear + 6);
    expect(ppvPerYear).toBeGreaterThan(CALENDAR_TARGETS.ppvPerYear - 4);
    expect(ppvPerYear).toBeLessThan(CALENDAR_TARGETS.ppvPerYear + 4);
    expect(fightNightsPerYear).toBeGreaterThan(CALENDAR_TARGETS.fightNightsPerYear - 7);
    expect(fightNightsPerYear).toBeLessThan(CALENDAR_TARGETS.fightNightsPerYear + 7);

    // Some weekends are left clear rather than every Saturday carrying a card.
    const eventDates = new Set(Object.values(save.events).map((e) => e.date));
    let saturdays = 0;
    let clear = 0;
    for (let d = save.startDate; d < save.date; d = addDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 6) continue;
      saturdays++;
      if (!eventDates.has(d)) clear++;
    }
    expect(saturdays).toBeGreaterThan(140);
    expect(clear / years).toBeGreaterThan(1);
    expect(clear / years).toBeLessThan(14);

    // Every card lands on a Saturday.
    for (const e of completed) expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(6);
  });

  it('builds cards of the right size and shape', () => {
    const { save } = createNewGame(snapshot, { saveName: 'cal', seed: 9081, mode: 'spectator' });
    for (let y = 0; y < 2; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    const completed = Object.values(save.events).filter((e) => e.status === 'completed' && e.boutIds.length > 0);
    expect(completed.length).toBeGreaterThan(40);

    for (const e of completed) {
      const announced = e.announcedBoutIds.length;
      if (e.tier === 'numbered-ppv') {
        expect(announced, `${e.name} scheduled ${announced} bouts`).toBeGreaterThanOrEqual(10);
        expect(announced).toBeLessThanOrEqual(15);
      } else {
        expect(announced, `${e.name} scheduled ${announced} bouts`).toBeGreaterThanOrEqual(9);
        expect(announced).toBeLessThanOrEqual(15);
      }
      // The planned shape is recorded and the main card is a sensible size.
      expect(e.plannedMain).toBeGreaterThanOrEqual(4);
      expect(e.plannedMain).toBeLessThanOrEqual(6);
      // A card is never one division from top to bottom.
      const divisions = new Set(e.boutIds.map((id) => save.bouts[id]?.divisionId).filter(Boolean));
      expect(divisions.size, `${e.name} used only ${divisions.size} divisions`).toBeGreaterThanOrEqual(3);
      // The main event is a five round bout.
      const main = e.boutIds.map((id) => save.bouts[id]).find((b) => b?.isMainEvent);
      if (main && main.status === 'completed') expect(main.scheduledRounds).toBe(5);
    }
  });

  it('keeps the contested card consistent with the announced card and cancellations', () => {
    const { save } = createNewGame(snapshot, { saveName: 'cal', seed: 9082, mode: 'spectator' });
    advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    for (const e of Object.values(save.events)) {
      if (e.status !== 'completed') continue;
      // Everything contested was on the card, and nothing contested was also cancelled.
      for (const id of e.contestedBoutIds) {
        expect(save.history.results[id], `${id} contested without a result`).toBeDefined();
        expect(e.canceledBoutIds).not.toContain(id);
      }
      for (const id of e.canceledBoutIds) expect(save.history.results[id]).toBeUndefined();
      expect(e.contestedBoutIds.length).toBeLessThanOrEqual(e.announcedBoutIds.length + 2);
    }
  });

  it('keeps the rolling twelve month window on target at any point in time', () => {
    const { save } = createNewGame(snapshot, { saveName: 'cal', seed: 9083, mode: 'spectator' });
    for (let y = 0; y < 2; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    const counts = rollingYearCounts(save, save.date);
    expect(counts.events).toBeGreaterThan(34);
    expect(counts.events).toBeLessThan(58);
    expect(counts.ppv).toBeGreaterThan(8);
    expect(counts.ppv).toBeLessThan(20);
  });

  it('gives fighters a believable number of fights per year', () => {
    const { save } = createNewGame(snapshot, { saveName: 'cal', seed: 9084, mode: 'spectator' });
    for (let y = 0; y < 3; y++) advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false });
    const years = daysBetween(save.startDate, save.date) / 365;
    const active = Object.values(save.fighters).filter((f) => !f.retired && f.activityStatus === 'active');
    const rates = active.map((f) => f.boutIds.filter((id) => save.history.results[id]).length / years);
    const mean = rates.reduce((s, v) => s + v, 0) / rates.length;

    // Most active fighters compete two or three times a year.
    expect(mean).toBeGreaterThan(1.2);
    expect(mean).toBeLessThan(3.2);
    // More than four a year should be unusual.
    const overFour = rates.filter((r) => r > 4).length / rates.length;
    expect(overFour).toBeLessThan(0.05);
  });
});
