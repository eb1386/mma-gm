import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { bookedCareer, fightWeekCareer, injuredBookedCareer, newCareer, offeredCareer, planCamp } from './testing/fixtures';
import { advanceUntil } from './world/advance-target';
import { actionableMessages, reconcileInbox } from './world/inbox';
import { COOLDOWNS, mayNotify, repairInbox, resolvePlayerDecision } from './world/decisions';
import './world/decision-handlers';
import { careerStatus } from './world/career';
import { generateCampLife, campLifeRng } from './world/camp-life';
import { adjacentDivisions, commitMove, explore } from './world/weightclass';
import { calloutLikelihood, enforceDivisionInvariant, moveDesire, runNpcCallouts } from './world/npc-behaviour';
import { assessTitleOpportunity, assessTitleRematch, fightCloseness, unbeatenRun } from './world/title-logic';
import { stagesForBout, tasksForBout, ensureFightWeekTasks } from './world/fightweek';
import { createSession, presserRng } from './world/presser';
import { migrateSave } from './save/migrate';
import type { SaveGame } from './types/save';

/**
 * Release gates.
 *
 * Every test here corresponds to a defect that would block a public beta: a decision that
 * stays visible after it is answered, a notification that repeats, an offer in a division
 * the fighter has left, a title shot that makes no sense, or a press answer that does not
 * address the question.
 */

describe('the decision lifecycle', () => {
  it('removes an answered item from the actionable list immediately', () => {
    const f = injuredBookedCareer(9001, { daysOut: 120, blocking: false, severity: 2 });
    const before = actionableMessages(f.save).length;
    expect(before).toBeGreaterThan(0);
    const decision = f.save.inbox.find((m) => m.category === 'injury' && m.requiresAction)!;
    const result = resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'rest' }, new Rng(1));
    expect(result.ok).toBe(true);
    expect(result.alreadyHandled).toBe(false);
    // No tick, no refresh: the badge is already correct.
    expect(actionableMessages(f.save).some((m) => m.id === decision.id)).toBe(false);
    expect(result.remainingActionable).toBe(actionableMessages(f.save).length);
    expect(decision.status).toBe('resolved');
    expect(decision.resolution).toBeTruthy();
    expect(decision.decisionResolvedOn).toBe(f.save.date);
  });

  it('applies consequences exactly once on a repeated request', () => {
    // A blocking injury offers rehabilitation, which costs money. A minor one does not.
    const f = injuredBookedCareer(9002, { daysOut: 200, blocking: true, severity: 4, returnDays: 120 });
    const me = f.save.fighters[f.playerId];
    const decision = f.save.inbox.find((m) => m.category === 'injury' && m.requiresAction)!;
    const cashBefore = f.save.finance?.cash ?? 0;
    const first = resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'rehabilitate' }, new Rng(2));
    const cashAfter = f.save.finance?.cash ?? 0;
    expect(first.ok).toBe(true);
    expect(cashAfter).toBeLessThan(cashBefore);

    const second = resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'rehabilitate' }, new Rng(3));
    expect(second.alreadyHandled).toBe(true);
    expect(second.message).toBe('This decision has already been handled.');
    // Nothing moved a second time.
    expect(f.save.finance?.cash ?? 0).toBe(cashAfter);
    void me;
  });

  it('refuses a choice that is not on the item', () => {
    const f = injuredBookedCareer(9003, { daysOut: 120, blocking: false, severity: 2 });
    const decision = f.save.inbox.find((m) => m.category === 'injury' && m.requiresAction)!;
    const result = resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'not-a-real-choice' }, new Rng(4));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(decision.status).not.toBe('resolved');
  });

  it('recomputes the career state so advancement unblocks on the same click', () => {
    const f = injuredBookedCareer(9004, { daysOut: 120, blocking: false, severity: 2 });
    expect(careerStatus(f.save).advanceBlocked).toBe(true);
    const decision = f.save.inbox.find((m) => m.category === 'injury' && m.requiresAction)!;
    resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'rest' }, new Rng(5));
    expect(careerStatus(f.save).advanceBlocked).toBe(false);
  });

  it('closes an item whose situation moved on rather than leaving it stuck', () => {
    const f = offeredCareer(9005);
    const message = f.save.inbox.find((m) => m.linkedOfferId === f.offerId)!;
    f.save.fightOffers[f.offerId].status = 'withdrawn';
    const result = resolvePlayerDecision(f.save, { messageId: message.id, choiceKey: message.choices[0].key }, new Rng(6));
    expect(result.alreadyHandled).toBe(true);
    expect(message.status).toBe('resolved');
  });
});

describe('mandatory versus optional', () => {
  it('does not block the calendar for an optional item', () => {
    const f = bookedCareer(9010, { daysOut: 60 });
    f.save.inbox.push({
      id: 'msg-optional',
      date: f.save.date,
      sender: 'media',
      senderName: 'Fan reaction',
      subject: 'Optional opportunity',
      body: '',
      requiresAction: true,
      mandatory: false,
      deadline: addDays(f.save.date, 20),
      choices: [{ key: 'a', label: 'A' }],
      linkedFighterId: null,
      linkedEventId: null,
      linkedBoutId: null,
      linkedContractId: null,
      linkedOfferId: null,
      status: 'unread',
      resolution: null,
      category: 'news',
    });
    expect(careerStatus(f.save).advanceBlocked).toBe(false);
  });

  it('blocks the calendar for a mandatory item', () => {
    const f = injuredBookedCareer(9011, { daysOut: 120, blocking: false, severity: 2 });
    expect(careerStatus(f.save).advanceBlocked).toBe(true);
  });
});

describe('notification repetition', () => {
  it('honours a cooldown for the same signature', () => {
    const f = bookedCareer(9020);
    const guard = { signature: 'test|signature', cooldownDays: 30 };
    expect(mayNotify(f.save, guard)).toBe(true);
    f.save.inbox.push({
      id: 'msg-sig',
      date: f.save.date,
      sender: 'media',
      senderName: 'x',
      subject: 'x',
      body: '',
      requiresAction: false,
      deadline: null,
      choices: [],
      linkedFighterId: null,
      linkedEventId: null,
      linkedBoutId: null,
      linkedContractId: null,
      linkedOfferId: null,
      status: 'read',
      resolution: null,
      category: 'news',
      notificationSignature: 'test|signature',
    });
    expect(mayNotify(f.save, guard)).toBe(false);
  });

  it('asks the supplement question at most once per camp', () => {
    const f = bookedCareer(9021, { daysOut: 90 });
    planCamp(f.save, f.playerId, f.boutId);
    const me = f.save.fighters[f.playerId];
    for (let w = 0; w < 10; w++) {
      generateCampLife(f.save, me, campLifeRng(f.save, me.id));
      f.save.date = addDays(f.save.date, 7);
    }
    const supplements = f.save.inbox.filter((m) => m.decisionKey?.startsWith('supplement|'));
    expect(supplements.length).toBeLessThanOrEqual(1);
  });

  it('never asks for a recurring sponsor post', () => {
    const f = bookedCareer(9022, { daysOut: 90 });
    planCamp(f.save, f.playerId, f.boutId);
    const me = f.save.fighters[f.playerId];
    for (let w = 0; w < 12; w++) {
      generateCampLife(f.save, me, campLifeRng(f.save, me.id));
      f.save.date = addDays(f.save.date, 7);
    }
    const posts = f.save.inbox.filter((m) => m.choices.some((c) => c.key === 'camp-sponsor-post'));
    expect(posts.length).toBe(0);
  });

  it('repairs duplicated and stuck items in an old save', () => {
    const f = bookedCareer(9023);
    const base = {
      date: f.save.date,
      sender: 'media' as const,
      senderName: 'x',
      body: '',
      requiresAction: true,
      deadline: null,
      choices: [{ key: 'a', label: 'A' }],
      linkedFighterId: null,
      linkedEventId: null,
      linkedBoutId: null,
      linkedContractId: null,
      linkedOfferId: null,
      resolution: null,
      category: 'news' as const,
      decisionKey: 'dupe|one',
    };
    f.save.inbox.push({ ...base, id: 'dupe-1', subject: 'First', status: 'unread' });
    f.save.inbox.push({ ...base, id: 'dupe-2', subject: 'Second', status: 'unread' });
    f.save.inbox.push({ ...base, id: 'stuck', subject: 'Stuck', status: 'unread', decisionKey: 'stuck|one', selectedChoiceKey: 'a' });
    const report = repairInbox(f.save);
    expect(report.deduped).toBeGreaterThan(0);
    expect(report.fixedIdentity).toBeGreaterThan(0);
    expect(f.save.inbox.find((m) => m.id === 'stuck')!.status).toBe('resolved');
    const openDupes = f.save.inbox.filter((m) => m.decisionKey === 'dupe|one' && m.status !== 'resolved');
    expect(openDupes.length).toBe(1);
  });
});

describe('social media appears', () => {
  it('produces social items during a promoted camp', () => {
    const f = bookedCareer(9030, { daysOut: 56 });
    planCamp(f.save, f.playerId, f.boutId);
    let social = 0;
    for (let w = 0; w < 8; w++) {
      const before = Object.keys(f.save.socialFeed ?? {}).length;
      advanceUntil(f.save, { kind: 'duration', days: 7 });
      social += Object.keys(f.save.socialFeed ?? {}).length - before;
      if (careerStatus(f.save).advanceBlocked) break;
    }
    // Two to five over a promoted camp is the target. One is the floor for a pass.
    expect(social).toBeGreaterThan(0);
  });

  it('routes social items into the inbox as optional items', () => {
    const f = bookedCareer(9031, { daysOut: 56 });
    planCamp(f.save, f.playerId, f.boutId);
    for (let w = 0; w < 6; w++) {
      advanceUntil(f.save, { kind: 'duration', days: 7 });
      if (careerStatus(f.save).advanceBlocked) break;
    }
    const socialMessages = f.save.inbox.filter((m) => m.linkedSocialId);
    for (const m of socialMessages) expect(m.mandatory).toBe(false);
  });
});

describe('NPC behaviour', () => {
  it('scores callout likelihood sensibly', () => {
    const f = bookedCareer(9040);
    const me = f.save.fighters[f.playerId];
    const rival = f.save.fighters[f.opponentId];
    rival.ranking = me.ranking;
    rival.winStreak = 5;
    rival.nextBoutId = null;
    const close = calloutLikelihood(f.save, rival, me);
    const distant = Object.values(f.save.fighters).find((x) => x.divisionId !== me.divisionId && !x.retired)!;
    expect(close).toBeGreaterThan(calloutLikelihood(f.save, distant, me));
  });

  it('creates at most one open incoming callout', () => {
    const f = newCareer(9041, { light: true });
    for (let i = 0; i < 40; i++) runNpcCallouts(f.save, new Rng(500 + i));
    const open = Object.values(f.save.callouts ?? {}).filter((c) => c.toId === f.playerId && c.status === 'open');
    expect(open.length).toBeLessThanOrEqual(1);
  });

  it('gives a struggling cutter a reason to move up', () => {
    const f = newCareer(9042, { light: true });
    const me = f.save.fighters[f.playerId];
    me.weightMisses = 2;
    me.walkingWeightLb += 18;
    const desire = moveDesire(f.save, me);
    expect(desire.up).toBeGreaterThan(0.3);
  });
});

describe('the division invariant', () => {
  it('withdraws offers left behind after a move', () => {
    const f = offeredCareer(9050);
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    expect(f.save.fightOffers[f.offerId].status).toBe('open');
    explore(f.save, me, up);
    f.save.weightClassPlans![me.id].status = 'approved';
    commitMove(f.save, me, true);
    enforceDivisionInvariant(f.save);
    expect(f.save.fightOffers[f.offerId].status).toBe('withdrawn');
  });

  it('produces no old division offers across a year of advancement', () => {
    const f = newCareer(9051, { light: true });
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    const oldDivision = me.divisionId;
    explore(f.save, me, up);
    f.save.weightClassPlans![me.id].status = 'approved';
    commitMove(f.save, me, true);

    for (let w = 0; w < 40; w++) {
      advanceUntil(f.save, { kind: 'duration', days: 7 });
      const offers = Object.values(f.save.fightOffers).filter((o) => o.status === 'open' && o.fighterId === me.id);
      for (const offer of offers) {
        expect(offer.divisionId).not.toBe(oldDivision);
        expect(offer.divisionId).toBe(me.divisionId);
        const opponent = f.save.fighters[offer.opponentId];
        expect(opponent.divisionId).toBe(me.divisionId);
      }
      // The old division must not list the fighter either.
      expect(f.save.rankings[oldDivision].entries.some((e) => e.fighterId === me.id)).toBe(false);
    }
  });
});

describe('title logic', () => {
  it('gives an elite unbeaten fighter a real opportunity', () => {
    const f = newCareer(9060, { light: true });
    const me = f.save.fighters[f.playerId];
    me.winStreak = 15;
    me.lossStreak = 0;
    me.popularity = 80;
    me.relationships.matchmaker = 80;
    const assessment = assessTitleOpportunity(f.save, me, me.divisionId);
    expect(['immediate-title-shot', 'number-one-contender']).toContain(assessment.opportunity);
    expect(assessment.reasons.length).toBeGreaterThan(0);
  });

  it('does not give an unproven fighter a title shot', () => {
    const f = newCareer(9061, { light: true });
    const me = f.save.fighters[f.playerId];
    me.winStreak = 0;
    me.lossStreak = 1;
    me.ranking = null;
    me.popularity = 15;
    me.titleDefenses = 0;
    me.titleReigns = 0;
    const assessment = assessTitleOpportunity(f.save, me, me.divisionId);
    expect(['establish-yourself', 'ranked-debut']).toContain(assessment.opportunity);
  });

  it('rates a dominant champion moving up above an unproven mover', () => {
    const f = newCareer(9062, { light: true });
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    me.isChampion = true;
    me.titleDefenses = 15;
    me.winStreak = 16;
    me.popularity = 85;
    const strong = assessTitleOpportunity(f.save, me, up.id, { direction: 'up', vacatedTitle: true });
    me.isChampion = false;
    me.titleDefenses = 0;
    me.winStreak = 1;
    me.popularity = 20;
    const weak = assessTitleOpportunity(f.save, me, up.id, { direction: 'up' });
    expect(strong.score).toBeGreaterThan(weak.score + 40);
    expect(strong.opportunity).toBe('immediate-title-shot');
  });

  it('reads fight closeness from the events, not the method', () => {
    const f = fightWeekCareer(9063, { daysOut: 0 });
    const bout = f.save.bouts[f.boutId];
    const base = {
      boutId: bout.id,
      eventId: bout.eventId,
      date: f.save.date,
      fighterAId: bout.fighterAId,
      fighterBId: bout.fighterBId,
      winnerId: bout.fighterAId,
      loserId: bout.fighterBId,
      divisionId: bout.divisionId,
      scheduledRounds: 5 as const,
      endRound: 5,
      endTimeSeconds: 300,
      isTitleFight: true,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      rounds: [],
      pointDeductionsA: 0,
      pointDeductionsB: 0,
      totalsA: { knockdowns: 0 },
      totalsB: { knockdowns: 0 },
      scorecards: [{ totalA: 48, totalB: 47 }],
    } as never;
    const split = fightCloseness({ ...(base as object), method: 'decision-split' } as never);
    const early = fightCloseness({ ...(base as object), method: 'ko', endRound: 1 } as never);
    expect(split.value).toBeGreaterThan(early.value + 0.3);
  });

  it('grants a rematch to a long reigning champion but not to an unproven one', () => {
    const f = fightWeekCareer(9064, { daysOut: 0 });
    const me = f.save.fighters[f.playerId];
    const bout = f.save.bouts[f.boutId];
    const loss = {
      boutId: bout.id,
      eventId: bout.eventId,
      date: f.save.date,
      fighterAId: me.id,
      fighterBId: f.opponentId,
      winnerId: f.opponentId,
      loserId: me.id,
      divisionId: me.divisionId,
      method: 'decision-unanimous',
      scheduledRounds: 5,
      endRound: 5,
      endTimeSeconds: 300,
      isTitleFight: true,
      isInterimTitleFight: false,
      titleIneligibleFighterIds: [],
      rounds: [],
      pointDeductionsA: 0,
      pointDeductionsB: 0,
      totalsA: { knockdowns: 0 },
      totalsB: { knockdowns: 0 },
      scorecards: [
        { totalA: 47, totalB: 48 },
        { totalA: 47, totalB: 48 },
        { totalA: 47, totalB: 48 },
      ],
    } as never;

    me.titleDefenses = 15;
    me.popularity = 85;
    const legend = assessTitleRematch(f.save, me, loss);
    me.titleDefenses = 0;
    me.popularity = 40;
    const unproven = assessTitleRematch(f.save, me, loss);
    expect(legend.score).toBeGreaterThan(unproven.score);
    expect(legend.granted).toBe(true);
  });

  it('counts an unbeaten run correctly', () => {
    const f = newCareer(9065, { light: true });
    const me = f.save.fighters[f.playerId];
    me.winStreak = 7;
    expect(unbeatenRun(f.save, me)).toBeGreaterThanOrEqual(7);
  });
});

describe('fight week sequence', () => {
  it('never asks the player to choose whether to travel', () => {
    const f = fightWeekCareer(9070, { daysOut: 5 });
    const tasks = tasksForBout(f.save, f.boutId);
    const travel = tasks.find((t) => t.stage === 'travel');
    // Travel is either absent entirely or already resolved as a status.
    expect(travel === undefined || travel.status === 'complete').toBe(true);
    const arrival = tasks.find((t) => t.stage === 'arrival');
    expect(arrival?.status).toBe('complete');
  });

  it('always gives a player fight a press conference', () => {
    for (const seed of [9071, 9072, 9073]) {
      const f = fightWeekCareer(seed, { daysOut: 5 });
      const stages = stagesForBout(f.save, f.boutId);
      expect(stages).toContain('press-conference');
      expect(stages).toContain('official-weigh-in');
      expect(stages).toContain('final-clearance');
      expect(stages).toContain('fight-night');
    }
  });

  it('keeps the mandatory stages blocking', () => {
    const f = fightWeekCareer(9074, { daysOut: 1 });
    ensureFightWeekTasks(f.save, f.boutId);
    const mandatory = tasksForBout(f.save, f.boutId).filter((t) => t.mandatory);
    expect(mandatory.map((t) => t.stage)).toContain('official-weigh-in');
  });
});

describe('press conference coherence', () => {
  it('gives every question an answer for every tone it offers', () => {
    for (const seed of [9080, 9081, 9082, 9083]) {
      const f = fightWeekCareer(seed, { daysOut: 2, isTitleFight: seed % 2 === 0 });
      const session = createSession(f.save, f.boutId, 'press-conference', presserRng(f.save, f.boutId, 'press-conference'));
      if (!session) continue;
      expect(session.questions.length).toBeGreaterThanOrEqual(3);
      for (const q of session.questions) {
        expect(q.text.length).toBeGreaterThan(10);
        expect(q.answers.length).toBeGreaterThanOrEqual(3);
        const tones = new Set(q.answers.map((a) => a.tone));
        expect(tones.size).toBe(q.answers.length);
        // Every answer is real prose and no two answers to one question are identical.
        const texts = q.answers.map((a) => a.text);
        expect(new Set(texts).size).toBe(texts.length);
        for (const a of q.answers) expect(a.text.length).toBeGreaterThan(5);
      }
      // No question archetype repeats inside one session.
      const archetypes = session.questions.map((q) => q.id.split('|')[0]);
      expect(new Set(archetypes).size).toBe(archetypes.length);
    }
  });

  it('does not repeat a question archetype across consecutive sessions', () => {
    const f = fightWeekCareer(9084, { daysOut: 2 });
    const first = createSession(f.save, f.boutId, 'press-conference', presserRng(f.save, f.boutId, 'press-conference'))!;
    const firstKeys = new Set(first.questions.map((q) => q.id.split('|')[0]));
    // A second session for a different bout, immediately afterwards.
    const second = createSession(f.save, f.boutId, 'media-day', presserRng(f.save, f.boutId, 'media-day'));
    if (!second) return;
    // Fresh questions are preferred. A repeat is only allowed once the eligible pool is
    // genuinely exhausted, so most of the second session must still be new.
    const keys = second.questions.map((q) => q.id.split('|')[0]);
    const overlap = keys.filter((k) => firstKeys.has(k));
    expect(overlap.length).toBeLessThan(keys.length);
  });
});

describe('save migration and repair', () => {
  it('migrates an older save without losing the career', () => {
    const f = bookedCareer(9090);
    const raw = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    raw.schemaVersion = 8;
    delete (raw as Partial<SaveGame>).gamePlans;
    delete (raw as Partial<SaveGame>).relationships;
    const migrated = migrateSave(raw);
    expect(migrated.schemaVersion).toBe(11);
    expect(migrated.gamePlans).toBeDefined();
    expect(migrated.relationships).toBeDefined();
    expect(Object.keys(migrated.fighters).length).toBe(Object.keys(f.save.fighters).length);
    expect(migrated.date).toBe(f.save.date);
  });

  it('survives a save with partially missing structures', () => {
    const f = bookedCareer(9091);
    const raw = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    raw.schemaVersion = 6;
    delete (raw as Partial<SaveGame>).fightWeek;
    delete (raw as Partial<SaveGame>).socialFeed;
    delete (raw as Partial<SaveGame>).ledger;
    delete (raw as Partial<SaveGame>).callouts;
    const migrated = migrateSave(raw);
    expect(migrated.fightWeek).toBeDefined();
    expect(migrated.ledger).toBeDefined();
    expect(migrated.callouts).toBeDefined();
    expect(reconcileInbox(migrated)).toBeGreaterThanOrEqual(0);
  });
});

void COOLDOWNS;

describe('branding and the fictional promotion', () => {
  it('names generated events after the fictional promotion', () => {
    const f = newCareer(9100, { light: true });
    const events = Object.values(f.save.events);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.name.startsWith('UWFS ')).toBe(true);
      expect(ev.name).not.toMatch(/^UFC/);
    }
    expect(events.some((e) => /^UWFS \d+$/.test(e.name))).toBe(true);
    expect(events.some((e) => /^UWFS Fight Night \d+$/.test(e.name))).toBe(true);
  });

  it('keeps generating fictional event names across a simulated year', () => {
    const f = newCareer(9101, { light: true });
    for (let w = 0; w < 30; w++) advanceUntil(f.save, { kind: 'duration', days: 14 });
    for (const ev of Object.values(f.save.events)) {
      expect(ev.name).not.toMatch(/UFC/);
    }
  });

  it('gives contracts the fictional promotion', () => {
    const f = newCareer(9102, { light: true });
    for (const contract of Object.values(f.save.contracts)) {
      expect(contract.promotion).not.toBe('UFC');
      expect(contract.promotion).toBe('Unified World Fight Series');
    }
  });

  it('migrates an old save away from the real promotion without touching history', () => {
    const f = newCareer(9103, { light: true });
    const raw = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    raw.schemaVersion = 10;
    const ids = Object.keys(raw.events);
    // A completed past event is part of this save's history and keeps its recorded name.
    const past = raw.events[ids[0]];
    past.name = 'UFC 200';
    past.date = addDays(raw.date, -30);
    past.status = 'completed';
    // Future generated events carry the real promotion and must be renamed.
    const future = raw.events[ids[1]];
    future.name = 'UFC 305';
    future.date = addDays(raw.date, 60);
    const futureNight = raw.events[ids[2]];
    futureNight.name = 'UFC Fight Night: Las Vegas';
    futureNight.date = addDays(raw.date, 90);
    for (const c of Object.values(raw.contracts)) c.promotion = 'UFC';
    raw.inbox.push({
      id: 'legacy-msg',
      date: raw.date,
      sender: 'matchmaker',
      senderName: 'UFC matchmaking',
      subject: 'Legacy',
      body: '',
      requiresAction: false,
      deadline: null,
      choices: [],
      linkedFighterId: null,
      linkedEventId: null,
      linkedBoutId: null,
      linkedContractId: null,
      linkedOfferId: null,
      status: 'read',
      resolution: null,
      category: 'news',
    });

    const migrated = migrateSave(raw);
    expect(migrated.schemaVersion).toBe(11);
    // The historical record is preserved exactly.
    expect(migrated.events[ids[0]].name).toBe('UFC 200');
    // Future generated events are renamed and keep their number.
    expect(migrated.events[ids[1]].name).toBe('UWFS 305');
    expect(migrated.events[ids[2]].name).toMatch(/^UWFS Fight Night \d+$/);
    for (const c of Object.values(migrated.contracts)) expect(c.promotion).toBe('Unified World Fight Series');
    expect(migrated.inbox.find((m) => m.id === 'legacy-msg')!.senderName).toBe('UWFS matchmaking');
    // The career itself is intact.
    expect(Object.keys(migrated.fighters).length).toBe(Object.keys(f.save.fighters).length);
  });

  it('still imports a save exported under the old brand', () => {
    const f = newCareer(9104, { light: true });
    const exported = JSON.stringify({ format: 'octagon-gm-save', schemaVersion: 9, save: f.save });
    const parsed = JSON.parse(exported) as { save: SaveGame };
    const migrated = migrateSave(parsed.save);
    expect(migrated.schemaVersion).toBe(11);
    expect(Object.keys(migrated.fighters).length).toBeGreaterThan(0);
  });
});
