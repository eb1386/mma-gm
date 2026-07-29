import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { bookedCareer, injuredBookedCareer, makeInjury, newCareer, offeredCareer, planCamp } from './testing/fixtures';
import { advanceUntil, suggestTarget, targetLabel } from './world/advance-target';
import { careerStatus } from './world/career';
import { actionableMessages, reconcileInbox, resolveMessage } from './world/inbox';
import { applyInjuryDecision } from './world/injury-flow';
import { recallPlan, rememberPlan } from './world/gameplan-memory';
import {
  applyRelationship,
  assessCallout,
  ensureRelationship,
  makeCallout,
  relationshipState,
  resolveCallout,
} from './world/relationships';
import { adjacentDivisions, commitMove, evaluateOption, explore, requestApproval } from './world/weightclass';
import { generateCampLife, applyCampChoice, campLifeRng } from './world/camp-life';
import { migrateSave } from './save/migrate';
import type { SaveGame } from './types/save';

/**
 * The career flow.
 *
 * These cover the exact failures reported in the refinement pass: camp advancement that
 * appeared to do nothing, an injury that asked every week, an inbox badge that disagreed
 * with the list, and game plans that reset on remount.
 */

describe('advancement actions are explicit', () => {
  it('gives camp an advance-target action, not a route to guess from', () => {
    const f = bookedCareer(8001, { daysOut: 56 });
    planCamp(f.save, f.playerId, f.boutId);
    const status = careerStatus(f.save);
    expect(status.state).toBe('camp-active');
    expect(status.action?.kind).toBe('advance-target');
    expect(status.action?.label).toBe('Advance to Fight Week');
    if (status.action?.kind === 'advance-target') {
      expect(status.action.target.kind).toBe('fight-week');
    }
  });

  it('reaches fight week in one call when nothing interrupts', () => {
    const f = bookedCareer(8002, { daysOut: 49 });
    planCamp(f.save, f.playerId, f.boutId);
    const me = f.save.fighters[f.playerId];
    // Remove the injury risk so this measures advancement, not luck.
    me.longevity = 100;
    const before = f.save.date;
    const status = careerStatus(f.save);
    if (status.action?.kind !== 'advance-target') throw new Error('camp action is not an advance target');
    const result = advanceUntil(f.save, status.action.target);
    expect(f.save.date).not.toBe(before);
    expect(result.daysAdvanced).toBeGreaterThan(7);
    // Either it arrived, or it stopped for a stated reason. Never silently nothing.
    if (result.reachedTarget) {
      expect(result.stateAfter).toBe('fight-week');
      expect(result.navigateTo).toContain('/fightweek/');
    } else {
      expect(result.stoppedBecause).toBeTruthy();
    }
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('creates fight week tasks exactly once when fight week is reached', () => {
    const f = bookedCareer(8003, { daysOut: 21 });
    planCamp(f.save, f.playerId, f.boutId);
    advanceUntil(f.save, { kind: 'fight-week', boutId: f.boutId });
    const tasks = Object.values(f.save.fightWeek ?? {}).filter((t) => t.boutId === f.boutId);
    if (f.save.bouts[f.boutId].status === 'scheduled') {
      expect(tasks.length).toBeGreaterThan(0);
      const stages = tasks.map((t) => t.stage);
      expect(new Set(stages).size).toBe(stages.length);
    }
  });

  it('stops at a real decision and says why', () => {
    const f = injuredBookedCareer(8004, { daysOut: 60 });
    const result = advanceUntil(f.save, { kind: 'fight-week', boutId: f.boutId });
    expect(result.reachedTarget).toBe(false);
    expect(result.stoppedBecause).toBeTruthy();
    expect(result.mandatoryAction).toBeTruthy();
    expect(result.navigateTo).toBeTruthy();
  });

  it('resumes advancement after the decision is answered', () => {
    const f = injuredBookedCareer(8005, { daysOut: 90, blocking: false, severity: 2, returnDays: 14 });
    const decision = f.save.inbox.find((m) => m.category === 'injury' && m.requiresAction)!;
    const me = f.save.fighters[f.playerId];
    const injury = me.injuries.find((i) => i.id === decision.linkedInjuryId)!;
    const outcome = applyInjuryDecision(f.save, me, injury, 'reduce-intensity', new Rng(1));
    resolveMessage(f.save, decision.id, 'reduce-intensity', outcome.message);
    expect(careerStatus(f.save).advanceBlocked).toBe(false);
    const result = advanceUntil(f.save, { kind: 'duration', days: 14 });
    expect(result.daysAdvanced).toBeGreaterThan(0);
  });

  it('reports being already there rather than pretending to move', () => {
    const f = bookedCareer(8006, { daysOut: 3 });
    const result = advanceUntil(f.save, { kind: 'fight-week', boutId: f.boutId });
    expect(result.daysAdvanced).toBe(0);
    expect(result.stoppedBecause).toBeTruthy();
  });

  it('suggests a sensible target for every situation', () => {
    const booked = bookedCareer(8007, { daysOut: 40 });
    expect(targetLabel(suggestTarget(booked.save))).toBe('Advance to Fight Week');
    const free = newCareer(8008, { light: true });
    expect(['Advance Until Next Offer', 'Advance Until Recovered']).toContain(targetLabel(suggestTarget(free.save)));
  });
});

describe('one decision per injury', () => {
  it('does not ask again for twelve weeks after treatment is chosen', () => {
    const f = injuredBookedCareer(8010, { daysOut: 200, blocking: false, severity: 2, returnDays: 30 });
    const me = f.save.fighters[f.playerId];
    const decision = f.save.inbox.find((m) => m.category === 'injury' && m.requiresAction)!;
    const injury = me.injuries.find((i) => i.id === decision.linkedInjuryId)!;
    const outcome = applyInjuryDecision(f.save, me, injury, 'rest', new Rng(2));
    resolveMessage(f.save, decision.id, 'rest', outcome.message);

    const seen = new Set(f.save.inbox.filter((m) => m.linkedInjuryId === injury.id).map((m) => m.id));
    for (let w = 0; w < 12; w++) advanceUntil(f.save, { kind: 'duration', days: 7 });
    const fresh = f.save.inbox.filter((m) => m.linkedInjuryId === injury.id && !seen.has(m.id));
    expect(fresh.length).toBe(0);
  });

  it('records the treatment so it continues automatically', () => {
    const f = injuredBookedCareer(8011, { daysOut: 120 });
    const me = f.save.fighters[f.playerId];
    const injury = me.injuries[me.injuries.length - 1];
    applyInjuryDecision(f.save, me, injury, 'rehabilitate', new Rng(3));
    expect(f.save.injuryTreatments?.[injury.id]?.treatment).toBe('rehabilitate');
    expect(f.save.injuryTreatments?.[injury.id]?.expectedReturnAtChoice).toBeTruthy();
  });

  it('gives a separate injury its own decision', () => {
    const f = injuredBookedCareer(8012, { daysOut: 200, blocking: false, severity: 2 });
    const me = f.save.fighters[f.playerId];
    const first = me.injuries[me.injuries.length - 1];
    applyInjuryDecision(f.save, me, first, 'rest', new Rng(4));
    const before = f.save.inbox.filter((m) => m.category === 'injury').length;
    me.injuries.push({ ...makeInjury(f.save.date, { blocking: false, severity: 3 }), id: 'inj-second' });
    advanceUntil(f.save, { kind: 'duration', days: 8 });
    const after = f.save.inbox.filter((m) => m.category === 'injury').length;
    expect(after).toBeGreaterThan(before);
  });
});

describe('the inbox badge matches the list', () => {
  it('counts only items whose linked object is still open', () => {
    const f = offeredCareer(8020);
    expect(actionableMessages(f.save).length).toBe(1);
    // Close the offer behind the message. The badge must drop immediately.
    const offer = f.save.fightOffers[f.offerId];
    offer.status = 'withdrawn';
    expect(actionableMessages(f.save).length).toBe(0);
  });

  it('ignores an item whose deadline has passed', () => {
    const f = offeredCareer(8021);
    const message = f.save.inbox.find((m) => m.linkedOfferId === f.offerId)!;
    message.deadline = addDays(f.save.date, -1);
    expect(actionableMessages(f.save).length).toBe(0);
  });

  it('closes stale items when the world is reconciled', () => {
    const f = offeredCareer(8022);
    f.save.fightOffers[f.offerId].status = 'accepted';
    const closed = reconcileInbox(f.save);
    expect(closed).toBeGreaterThan(0);
    expect(actionableMessages(f.save).length).toBe(0);
  });

  it('ignores a message about a fighter who no longer exists', () => {
    const f = bookedCareer(8023);
    f.save.inbox.push({
      id: 'msg-ghost',
      date: f.save.date,
      sender: 'media',
      senderName: 'Ghost',
      subject: 'Ghost message',
      body: '',
      requiresAction: true,
      deadline: null,
      choices: [{ key: 'x', label: 'x' }],
      linkedFighterId: 'no-such-fighter',
      linkedEventId: null,
      linkedBoutId: null,
      linkedContractId: null,
      linkedOfferId: null,
      status: 'unread',
      resolution: null,
      category: 'news',
    });
    expect(actionableMessages(f.save).some((m) => m.id === 'msg-ghost')).toBe(false);
  });
});

describe('game plans are remembered', () => {
  it('recalls the last plan rather than resetting', () => {
    const f = bookedCareer(8030);
    rememberPlan(f.save, f.boutId, 'camp', ['counter', 'leg-kick-attack']);
    const recalled = recallPlan(f.save, f.boutId, 'camp');
    expect(recalled.plans).toEqual(['counter', 'leg-kick-attack']);
    expect(recalled.remembered).toBe(true);
  });

  it('inherits the camp plan for pre fight planning', () => {
    const f = bookedCareer(8031);
    rememberPlan(f.save, f.boutId, 'camp', ['top-control']);
    const recalled = recallPlan(f.save, f.boutId, 'preFight');
    expect(recalled.plans).toEqual(['top-control']);
    expect(recalled.source).toBe('this bout camp');
  });

  it('uses the last general plan for a brand new booking', () => {
    const f = bookedCareer(8032);
    rememberPlan(f.save, f.boutId, 'camp', ['high-pace']);
    const recalled = recallPlan(f.save, 'a-different-bout', 'camp');
    expect(recalled.plans).toEqual(['high-pace']);
    expect(recalled.source).toBe('your last game plan');
  });

  it('survives a save round trip', () => {
    const f = bookedCareer(8033);
    rememberPlan(f.save, f.boutId, 'camp', ['fence-wrestling']);
    const reloaded = migrateSave(JSON.parse(JSON.stringify(f.save)) as SaveGame);
    expect(recallPlan(reloaded, f.boutId, 'camp').plans).toEqual(['fence-wrestling']);
  });
});

describe('relationships and callouts', () => {
  it('derives the state from tracked values', () => {
    const f = bookedCareer(8040);
    const r = ensureRelationship(f.save, f.playerId, f.opponentId);
    expect(relationshipState(r)).toBe('stranger');
    applyRelationship(f.save, f.playerId, f.opponentId, { friendship: 45, familiarity: 30 }, 'social-friendly', 'Got on well.');
    expect(['friendly', 'friend']).toContain(relationshipState(f.save.relationships![[f.playerId, f.opponentId].sort().join('|')]));
    applyRelationship(f.save, f.playerId, f.opponentId, { rivalry: 60, resentment: 50, publicHostility: 50, friendship: -40 }, 'insult', 'It turned.');
    expect(['heated-rival', 'bitter-rival', 'enemy']).toContain(
      relationshipState(f.save.relationships![[f.playerId, f.opponentId].sort().join('|')])
    );
  });

  it('a friendship can deteriorate into a rivalry', () => {
    const f = bookedCareer(8041);
    applyRelationship(f.save, f.playerId, f.opponentId, { friendship: 60, trust: 50, familiarity: 40 }, 'training', 'Training partners.');
    const key = [f.playerId, f.opponentId].sort().join('|');
    expect(['friend', 'close-friend', 'friendly']).toContain(relationshipState(f.save.relationships![key]));
    applyRelationship(f.save, f.playerId, f.opponentId, { friendship: -55, resentment: 65, rivalry: 60, publicHostility: 55 }, 'betrayal', 'It broke down.');
    expect(['heated-rival', 'bitter-rival', 'enemy']).toContain(relationshipState(f.save.relationships![key]));
  });

  it('assesses a callout honestly before it is made', () => {
    const f = bookedCareer(8042);
    const assessment = assessCallout(f.save, f.playerId, f.opponentId, null);
    expect(assessment.acceptanceChance).toBeGreaterThan(0);
    expect(assessment.acceptanceChance).toBeLessThanOrEqual(0.95);
    expect(assessment.targetName).toBeTruthy();
    expect(Array.isArray(assessment.reasons)).toBe(true);
  });

  it('a callout can be accepted or rejected and never books a fight by itself', () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const f = bookedCareer(8043);
      const callout = makeCallout(f.save, f.playerId, f.opponentId, 'confident', new Rng(100 + i));
      expect(callout).not.toBeNull();
      const resolved = resolveCallout(f.save, callout!.id, new Rng(200 + i));
      outcomes.add(resolved!.response!);
      // A callout never creates a booking on its own.
      expect(resolved!.ledToOffer).toBe(false);
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('an aggressive callout raises hostility more than a respectful one', () => {
    const a = bookedCareer(8044);
    makeCallout(a.save, a.playerId, a.opponentId, 'respectful', new Rng(9));
    const respectful = a.save.relationships![[a.playerId, a.opponentId].sort().join('|')].publicHostility;
    const b = bookedCareer(8044);
    makeCallout(b.save, b.playerId, b.opponentId, 'personal', new Rng(9));
    const personal = b.save.relationships![[b.playerId, b.opponentId].sort().join('|')].publicHostility;
    expect(personal).toBeGreaterThan(respectful);
  });
});

describe('weight class moves', () => {
  it('offers the adjacent divisions for the same gender', () => {
    const f = newCareer(8050, { light: true });
    const me = f.save.fighters[f.playerId];
    const { up, down } = adjacentDivisions(me);
    expect(up || down).toBeTruthy();
    if (up) expect(up.gender).toBe(me.divisionId.startsWith('womens') ? 'women' : 'men');
  });

  it('shows benefits and costs without revealing hidden ratings', () => {
    const f = newCareer(8051, { light: true });
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    const option = evaluateOption(f.save, me, up);
    expect(option.benefits.length).toBeGreaterThan(0);
    expect(option.costs.length).toBeGreaterThan(0);
    expect(option.weightDifficulty).toBeTruthy();
    // Nothing numeric about the fighter's own ratings leaks out.
    expect(JSON.stringify(option)).not.toContain('striking');
  });

  it('moves the fighter and resets the ranking when committed', () => {
    const f = newCareer(8052, { light: true });
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    const from = me.divisionId;
    explore(f.save, me, up);
    const plan = f.save.weightClassPlans![me.id];
    plan.status = 'approved';
    const outcome = commitMove(f.save, me, true);
    expect(outcome.moved).toBe(true);
    expect(me.divisionId).toBe(up.id);
    expect(me.ranking).toBeNull();
    expect(f.save.rankings[from].entries.some((e) => e.fighterId === me.id)).toBe(false);
  });

  it('vacates the title when a champion moves', () => {
    const f = newCareer(8053, { light: true });
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    f.save.rankings[me.divisionId].championId = me.id;
    me.isChampion = true;
    f.save.history.reigns.push({
      id: 'reign-wc-test',
      divisionId: me.divisionId,
      fighterId: me.id,
      isInterim: false,
      wonOn: f.save.date,
      wonBoutId: null,
      lostOn: null,
      lostBoutId: null,
      defenses: 0,
      endReason: null,
    });
    const from = me.divisionId;
    explore(f.save, me, up);
    f.save.weightClassPlans![me.id].status = 'approved';
    const outcome = commitMove(f.save, me, true);
    expect(outcome.vacatedTitle).toBe(true);
    expect(f.save.rankings[from].championId).toBeNull();
    expect(me.isChampion).toBe(false);
  });

  it('refuses to move with a fight booked', () => {
    const f = bookedCareer(8054);
    const me = f.save.fighters[f.playerId];
    const { up } = adjacentDivisions(me);
    if (!up) return;
    explore(f.save, me, up);
    f.save.weightClassPlans![me.id].status = 'approved';
    const outcome = commitMove(f.save, me, false);
    expect(outcome.moved).toBe(false);
    expect(outcome.message).toContain('booked');
  });

  it('lets the promotion refuse a request', () => {
    const results = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const f = newCareer(8055, { light: true });
      const me = f.save.fighters[f.playerId];
      const { down } = adjacentDivisions(me);
      if (!down) return;
      explore(f.save, me, down);
      const plan = requestApproval(f.save, me, new Rng(300 + i));
      results.add(plan!.status);
    }
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('career life reaches the player', () => {
  it('generates camp items within a budget', () => {
    const f = bookedCareer(8060, { daysOut: 50 });
    planCamp(f.save, f.playerId, f.boutId);
    const me = f.save.fighters[f.playerId];
    const created = generateCampLife(f.save, me, campLifeRng(f.save, me.id));
    expect(created.length).toBeLessThanOrEqual(3);
  });

  it('applies a camp choice once and records the outcome', () => {
    const f = bookedCareer(8061, { daysOut: 50 });
    planCamp(f.save, f.playerId, f.boutId);
    const me = f.save.fighters[f.playerId];
    generateCampLife(f.save, me, campLifeRng(f.save, me.id));
    const item = f.save.inbox.find((m) => m.decisionKey?.startsWith('camp-life-') && m.choices.length > 0);
    if (!item) return;
    const first = applyCampChoice(f.save, item.id, item.choices[0].key, new Rng(7));
    expect(first.length).toBeGreaterThan(0);
    const second = applyCampChoice(f.save, item.id, item.choices[0].key, new Rng(8));
    expect(second).toBe(first);
    expect(item.status).toBe('resolved');
  });

  it('does not flood the inbox with mandatory items', () => {
    const f = bookedCareer(8062, { daysOut: 90 });
    planCamp(f.save, f.playerId, f.boutId);
    for (let w = 0; w < 8; w++) advanceUntil(f.save, { kind: 'duration', days: 7 });
    const openMandatory = f.save.inbox.filter(
      (m) => m.requiresAction && m.status !== 'resolved' && m.status !== 'expired' && m.decisionKey?.startsWith('camp-life-')
    );
    expect(openMandatory.length).toBeLessThanOrEqual(2);
  });
});
