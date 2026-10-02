import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { bookedCareer, createEvent, injuredBookedCareer, makeInjury, newCareer, planCamp } from './testing/fixtures';
import { advanceUntil } from './world/advance-target';
import { actionRoute, careerStatus } from './world/career';
import { addInboxMessage, messageNeedsAction, resolveMessage } from './world/inbox';
import { applyInjuryDecision, checkPlayerInjuries, choicesFor, type InjuryChoiceKey } from './world/injury-flow';
import { resolvePlayerDecision } from './world/decisions';
import { createFightOffer, respondToOffer } from './world/offers';
import { advance } from './world/tick';
import { pendingStages, tasksForBout } from './world/fightweek';
import { hasLiveBooking } from './world/availability';
import { runAntiDopingWeek, setPosture } from './world/antidoping';
import { migrateSave } from './save/migrate';
import type { SaveGame } from './types/save';

/**
 * The clock and the career state machine.
 *
 * Each of these was a way for a career to stop for good or for the calendar to walk past
 * something the player had to do: an injury that blocked with nothing to answer, an anti-doping
 * suspension that never ended, a month press that skipped the weigh in, and optional items that
 * stopped every month after a week.
 */

/** Either the calendar moves, or it is held by an open decision the player can answer. */
function expectNoSoftlock(save: SaveGame) {
  const status = careerStatus(save);
  if (!status.advanceBlocked) return;
  const route = actionRoute(status.action);
  expect(route?.startsWith('/inbox/')).toBe(true);
  const id = route!.slice('/inbox/'.length);
  const message = save.inbox.find((m) => m.id === id);
  expect(message && messageNeedsAction(save, message)).toBe(true);
}

/** Answers every mandatory item with its first choice, as a player clearing the inbox would. */
function answerMandatory(save: SaveGame, rng: Rng) {
  for (let pass = 0; pass < 5; pass++) {
    const open = save.inbox.filter((m) => m.mandatory !== false && messageNeedsAction(save, m) && m.choices.length > 0);
    if (open.length === 0) return;
    for (const m of open) {
      if (m.linkedOfferId && save.fightOffers[m.linkedOfferId]) {
        respondToOffer(save, m.linkedOfferId, { kind: 'decline', reason: 'no-reason' }, rng);
        continue;
      }
      resolvePlayerDecision(save, { messageId: m.id, choiceKey: m.choices[0].key }, rng);
    }
  }
}

describe('an injury with a booked fight never freezes the calendar', () => {
  const CHOICES: InjuryChoiceKey[] = ['rehabilitate', 'seek-specialist', 'continue-despite-risk', 'request-postponement', 'withdraw'];
  for (const choice of CHOICES) {
    it(`moves on after ${choice}`, () => {
      const f = injuredBookedCareer(7101, { blocking: true, severity: 4, returnDays: 80, daysOut: 60 });
      const decision = f.save.inbox.find((m) => m.category === 'injury' && messageNeedsAction(f.save, m))!;
      expect(decision.choices.some((c) => c.key === choice)).toBe(true);
      const result = resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: choice }, f.rng);
      expect(result.ok).toBe(true);
      expectNoSoftlock(f.save);
      if (!careerStatus(f.save).advanceBlocked) {
        // Short of fight week, which has its own mandatory stops.
        const moved = advanceUntil(f.save, { kind: 'duration', days: 40 });
        expect(moved.daysAdvanced).toBeGreaterThan(1);
        expectNoSoftlock(f.save);
      }
    });
  }

  it('does not block or point at the camp page after a medically contingent accept', () => {
    const f = newCareer(7102, { light: true });
    const me = f.save.fighters[f.playerId];
    me.injuries.push(makeInjury(f.save.date, { blocking: true, severity: 3, returnDays: 30 }));
    checkPlayerInjuries(f.save);
    const decision = f.save.inbox.find((m) => m.category === 'injury' && messageNeedsAction(f.save, m))!;
    resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'rest' }, f.rng);

    const opponent = Object.values(f.save.fighters).find((o) => o.id !== me.id && o.divisionId === me.divisionId && !o.retired && !o.nextBoutId)!;
    const event = createEvent(f.save, addDays(f.save.date, 80));
    const offer = createFightOffer(f.save, me, opponent, event, f.rng, {
      isMainEvent: false,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: 3,
      reason: 'contingent test',
      isReplacementSlot: false,
      medicallyContingent: true,
    })!;
    expect(offer.medicallyContingent).toBe(true);
    const outcome = respondToOffer(f.save, offer.id, { kind: 'accept' }, f.rng);
    expect(outcome.accepted).toBe(true);
    expect(f.save.bouts[outcome.boutId!].medicallyContingent).toBe(true);

    const status = careerStatus(f.save);
    expect(actionRoute(status.action)).not.toBe('/camp');
    expectNoSoftlock(f.save);
    const moved = advanceUntil(f.save, { kind: 'duration', days: 60 });
    expect(moved.daysAdvanced).toBeGreaterThan(1);
  });

  it('withdraws a contingent booking at fight week when the fighter never cleared', () => {
    const f = bookedCareer(7103, { daysOut: 20 });
    const bout = f.save.bouts[f.boutId];
    bout.medicallyContingent = true;
    const me = f.save.fighters[f.playerId];
    me.injuries.push(makeInjury(f.save.date, { blocking: true, severity: 3, returnDays: 60 }));
    // The player answered, so nothing is open; the condition is what pulls the bout.
    checkPlayerInjuries(f.save);
    const decision = f.save.inbox.find((m) => m.category === 'injury' && messageNeedsAction(f.save, m))!;
    resolvePlayerDecision(f.save, { messageId: decision.id, choiceKey: 'rehabilitate' }, f.rng);
    f.save.inbox.forEach((m) => {
      if (messageNeedsAction(f.save, m)) resolveMessage(f.save, m.id, m.choices[0]?.key ?? 'ack', 'test');
    });
    advance(f.save, { mode: 'day', maxDays: 20, stopOnDecision: false });
    for (let d = 0; d < 20 && hasLiveBooking(f.save, me); d++) advance(f.save, { mode: 'day', stopOnDecision: false });
    expect(hasLiveBooking(f.save, me)).toBeNull();
    expect(f.save.inbox.some((m) => m.subject === 'Withdrawn: not medically cleared')).toBe(true);
  });

  it('leaves a player injured in camp booked, with the decision to make', () => {
    let checked = 0;
    for (let seed = 9; seed < 40 && checked === 0; seed++) {
      const f = bookedCareer(seed, { daysOut: 105 });
      const camp = planCamp(f.save, f.playerId, f.boutId);
      camp.intensity = 1;
      const me = f.save.fighters[f.playerId];
      // Injury prone, so the camp actually produces one within the test.
      me.longevity = 0;
      const gym = me.gymId ? f.save.gyms[me.gymId] : null;
      if (gym) {
        gym.hardSparringTendency = 100;
        gym.safety = 0;
      }
      let injured = false;
      for (let week = 0; week < 10 && !injured; week++) {
        f.save.inbox.forEach((m) => {
          if (m.category !== 'injury' && messageNeedsAction(f.save, m)) resolveMessage(f.save, m.id, m.choices[0]?.key ?? 'ack', 'test');
        });
        const before = me.injuries.length;
        advance(f.save, { mode: 'day', maxDays: 7, stopOnDecision: false });
        injured = me.injuries.slice(before).some((i) => i.blocksCompetition);
      }
      if (!injured) continue;
      checked++;
      const bout = f.save.bouts[f.boutId];
      expect(bout.status).toBe('scheduled');
      expect([bout.fighterAId, bout.fighterBId]).toContain(me.id);
      const decision = f.save.inbox.find((m) => m.category === 'injury' && m.linkedBoutId === f.boutId && messageNeedsAction(f.save, m));
      expect(decision).toBeDefined();
      expect(decision!.choices.some((c) => c.key === 'withdraw')).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('a treatment choice is not read back as a setback', () => {
  for (const choice of ['continue-despite-risk', 'choose-surgery'] as InjuryChoiceKey[]) {
    it(`raises nothing a week after ${choice}`, () => {
      const f = injuredBookedCareer(7104, { blocking: true, severity: choice === 'choose-surgery' ? 5 : 4, returnDays: 80, daysOut: 60 });
      const me = f.save.fighters[f.playerId];
      const decision = f.save.inbox.find((m) => m.category === 'injury' && messageNeedsAction(f.save, m))!;
      const injury = me.injuries.find((i) => i.id === decision.linkedInjuryId)!;
      const outcome = applyInjuryDecision(f.save, me, injury, choice, new Rng(5));
      resolveMessage(f.save, decision.id, choice, outcome.message);
      f.save.date = addDays(f.save.date, 7);
      expect(checkPlayerInjuries(f.save)).toBe(0);
    });
  }

  it('does not offer surgery twice', () => {
    expect(choicesFor('requires-surgery', true, true).some((c) => c.key === 'choose-surgery')).toBe(false);
    expect(choicesFor('requires-surgery', true).some((c) => c.key === 'choose-surgery')).toBe(true);
  });

  it('only offers a medical evaluation when there is a date to be cleared for', () => {
    expect(choicesFor('blocks-temporarily', false).some((c) => c.key === 'request-evaluation')).toBe(false);
    expect(choicesFor('blocks-temporarily', true).some((c) => c.key === 'request-evaluation')).toBe(true);
    const f = newCareer(7105, { light: true });
    const me = f.save.fighters[f.playerId];
    const injury = makeInjury(f.save.date, { blocking: true, returnDays: 40 });
    me.injuries.push(injury);
    const outcome = applyInjuryDecision(f.save, me, injury, 'request-evaluation', new Rng(1));
    expect(outcome.message).not.toContain('this date');
  });
});

describe('long advances stop for fight week', () => {
  it('never reaches fight night with the official weigh in still pending', () => {
    const f = bookedCareer(7106, { daysOut: 12 });
    planCamp(f.save, f.playerId, f.boutId);
    const bout = f.save.bouts[f.boutId];
    let stoppedForWeighIn = false;
    for (let press = 0; press < 8; press++) {
      answerMandatory(f.save, f.rng);
      const status = careerStatus(f.save);
      if (status.advanceBlocked) {
        if (status.fightWeekStage === 'official-weigh-in') {
          stoppedForWeighIn = true;
          break;
        }
        continue;
      }
      const report = advance(f.save, { mode: 'month' });
      const weighIn = tasksForBout(f.save, f.boutId).find((t) => t.stage === 'official-weigh-in');
      if (f.save.date >= bout.date) expect(weighIn?.status === 'complete' || weighIn?.status === 'skipped').toBe(true);
      if (report.fightWeekBoutId) expect(report.fightWeekBoutId).toBe(f.boutId);
    }
    expect(stoppedForWeighIn).toBe(true);
    expect(f.save.date < bout.date).toBe(true);
  });

  it('routes fight day to fight week while the weigh in has not happened', () => {
    const f = bookedCareer(7107, { daysOut: 5 });
    advance(f.save, { mode: 'day', maxDays: 1, stopOnDecision: false });
    f.save.date = f.save.bouts[f.boutId].date;
    const status = careerStatus(f.save);
    expect(status.state).toBe('fight-week');
    expect(actionRoute(status.action)).toBe(`/fightweek/${f.boutId}`);
  });

  it('stops Advance to Fight Night on an optional stage as it comes due', () => {
    const f = bookedCareer(7108, { daysOut: 6, isTitleFight: true });
    // Fight week opens on the next tick, with nothing due yet.
    const result = advanceUntil(f.save, { kind: 'fight-day', boutId: f.boutId });
    const due = pendingStages(f.save, f.boutId);
    expect(f.save.date < f.save.bouts[f.boutId].date).toBe(true);
    expect(due.length).toBeGreaterThan(0);
    expect(result.daysAdvanced).toBeGreaterThan(0);
  });
});

describe('optional items do not stop a month', () => {
  it('advances a full month when nothing mandatory arrives', () => {
    const f = newCareer(7109, { light: true });
    const me = f.save.fighters[f.playerId];
    // No fight offers, so anything that arrives is optional or informational.
    me.offerCooldownUntil = addDays(f.save.date, 200);
    f.save.settings.autoAdvanceStopsOnDecision = true;
    answerMandatory(f.save, f.rng);
    const before = f.save.counters.message ?? 0;
    // An optional item waiting at the start does not count either.
    const optional = addInboxMessage(f.save, {
      sender: 'media',
      senderName: 'Media',
      subject: 'An optional request',
      body: 'Optional.',
      category: 'news',
      requiresAction: true,
      choices: [{ key: 'ok', label: 'Fine' }],
    });
    optional.mandatory = false;
    const report = advance(f.save, { mode: 'month' });
    if (report.inboxWaiting) {
      // Only something mandatory may stop it short.
      expect(f.save.inbox.some((m) => m.mandatory !== false && messageNeedsAction(f.save, m))).toBe(true);
    } else {
      expect(report.daysAdvanced).toBeGreaterThanOrEqual(28);
      expect((f.save.counters.message ?? 0)).toBeGreaterThan(before);
    }
  });
});

describe('a medical item that is not an injury', () => {
  it('does not call a healthy fighter hurt', () => {
    const f = bookedCareer(7110, { daysOut: 60 });
    planCamp(f.save, f.playerId, f.boutId);
    const m = addInboxMessage(f.save, {
      sender: 'gym-owner',
      senderName: 'Gym',
      subject: 'A new supplement in the gym',
      body: 'Test.',
      category: 'medical',
      requiresAction: true,
      choices: [{ key: 'check', label: 'Check it' }],
    });
    m.mandatory = true;
    const status = careerStatus(f.save);
    expect(status.state).not.toBe('injured-while-booked');
    expect(status.action?.label).not.toBe('Review Injury');
    expect(status.advanceBlocked).toBe(true);
    expect(actionRoute(status.action)).toBe(`/inbox/${m.id}`);
  });

  it('names an anti-doping sanction for what it is', () => {
    const f = newCareer(7111, { light: true });
    answerMandatory(f.save, f.rng);
    const m = addInboxMessage(f.save, {
      sender: 'commission',
      senderName: 'Anti-doping programme',
      subject: 'Adverse analytical finding',
      body: 'Test.',
      category: 'medical',
      requiresAction: true,
      choices: [
        { key: 'doping-accept', label: 'Accept the sanction' },
        { key: 'doping-appeal', label: 'Appeal it' },
      ],
    });
    const status = careerStatus(f.save);
    expect(status.state).toBe('compliance-decision');
    expect(status.action?.label).toBe('Answer the Commission');
    expect(actionRoute(status.action)).toBe(`/inbox/${m.id}`);
    expect(status.advanceBlocked).toBe(true);
  });
});

describe('anti-doping switched off', () => {
  it('draws the same values and changes nothing', () => {
    const off = newCareer(7112, { light: true });
    const on = newCareer(7112, { light: true });
    const meOff = off.save.fighters[off.playerId];
    const meOn = on.save.fighters[on.playerId];
    setPosture(off.save, meOff.id, 'questionable');
    setPosture(on.save, meOn.id, 'questionable');
    const inboxBefore = off.save.inbox.length;
    let found = false;
    for (let seed = 1; seed < 40000 && !found; seed++) {
      const a = new Rng(seed);
      const b = new Rng(seed);
      runAntiDopingWeek(off.save, meOff, a, { apply: false });
      runAntiDopingWeek(on.save, meOn, b, { apply: true });
      expect(a.getState()).toEqual(b.getState());
      found = meOn.antiDopingSuspension !== null && meOn.antiDopingSuspension !== undefined;
    }
    expect(found).toBe(true);
    expect(meOff.activityStatus).toBe('active');
    expect(meOff.antiDopingSuspension ?? null).toBeNull();
    expect(off.save.inbox.length).toBe(inboxBefore);
    expect(off.save.doping?.[meOff.id]?.findings.length ?? 0).toBe(0);
  });

  it('repairs a player left suspended with no sanction on load', () => {
    const f = newCareer(7113, { light: true });
    const me = f.save.fighters[f.playerId];
    me.activityStatus = 'suspended';
    me.antiDopingSuspension = null;
    const m = addInboxMessage(f.save, {
      sender: 'commission',
      senderName: 'Anti-doping programme',
      subject: 'Adverse analytical finding',
      body: 'Test.',
      category: 'medical',
      requiresAction: true,
      choices: [
        { key: 'doping-accept', label: 'Accept the sanction' },
        { key: 'doping-appeal', label: 'Appeal it' },
      ],
    });
    migrateSave(f.save);
    expect(me.activityStatus).toBe('active');
    expect(f.save.inbox.find((x) => x.id === m.id)?.status).toBe('resolved');
  });
});

describe('the inbox cap', () => {
  it('drops settled items first and never an open decision', () => {
    const f = newCareer(7114, { light: true });
    const open = addInboxMessage(f.save, {
      sender: 'matchmaker',
      senderName: 'Matchmaker',
      subject: 'Open decision',
      body: 'Test.',
      category: 'career',
      requiresAction: true,
      choices: [{ key: 'ok', label: 'Fine' }],
    });
    for (let i = 0; i < 3100; i++) {
      const m = addInboxMessage(f.save, { sender: 'system', senderName: 'System', subject: `Filler ${i}`, body: '', category: 'news', requiresAction: false, choices: [] });
      m.status = 'read';
    }
    expect(f.save.inbox.length).toBe(3000);
    expect(f.save.inbox.some((m) => m.id === open.id)).toBe(true);
  });
});
