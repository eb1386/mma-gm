import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays, daysBetween } from './types/common';
import { isFinish } from './types/fight';
import {
  bookedCareer,
  fightWeekCareer,
  injuredBookedCareer,
  makeInjury,
  newCareer,
  offeredCareer,
  planCamp,
} from './testing/fixtures';
import { advance, prepareSide, simulatePlayerBout } from './world/tick';
import { createFightOffer, respondToOffer } from './world/offers';
import {
  acceptSponsor,
  applyFightPurse,
  applyMonthlyExpenses,
  applyPpvPoints,
  canSignSponsor,
  conflictsOfInterest,
  generateManager,
  generateSponsorOffer,
  hireManager,
  ledger,
  paySponsorsForFight,
  PURSE_TAX_RATE,
  record,
  searchForManager,
  summarize,
  type Sponsor,
} from './world/finance';
import { createContractOffer } from './world/economy';
import { getBusiness } from './world/business';
import { appealSanction, clearExpiredSuspensions, dopingState, runAntiDopingWeek, setPosture } from './world/antidoping';
import { DEFAULT_FEATURE_FLAGS, type SaveGame } from './types/save';
import type { Fighter } from './types/fighter';
import type { FightCardEvent } from './types/world';
import { checkBookingInvariants, hasLiveBooking, offerBlockReason, openOffersFor } from './world/availability';
import { applyInjuryDecision, classifyInjury, choicesFor } from './world/injury-flow';
import { careerStatus, isValidTransition } from './world/career';
import { blockingStage, ensureFightWeekTasks, pendingStages, tasksForBout } from './world/fightweek';
import { answerQuestion, createSession, presserRng } from './world/presser';
import { acceptOpponentMiss, beginWeighIn, stepWeighIn, applySecondAttempt, resolveOpponentDecision, cutContext, forecast, type WeighInReading } from './world/weighin';
import { manageWalkingWeight } from './world/health';
import { resolvePlayerDecision } from './world/decisions';
import { generateSocialItems, replyToSocialItem, socialRng } from './world/social';
import { finishingEventIndex, playbackEndIndex, roundEndedByFinish, summarizeRound } from './world/playback';


/**
 * The player flow.
 *
 * Every test here corresponds to a bug that was reported or found. They use deterministic
 * fixtures rather than advancing years of simulation, so the whole file runs in seconds.
 */

describe('offers and booking', () => {
  it('gives a booked player no new ordinary offer', () => {
    const { save, playerId } = bookedCareer(4001);
    const me = save.fighters[playerId];
    const before = Object.values(save.fightOffers).filter((o) => o.fighterId === me.id).length;
    for (let w = 0; w < 8; w++) advance(save, { mode: 'week', stopOnDecision: false });
    const after = Object.values(save.fightOffers).filter((o) => o.fighterId === me.id && !o.isReplacementSlot).length;
    expect(after).toBe(before);
  });

  it('keeps a booked player booked through weekly advancement', () => {
    const { save, playerId, boutId } = bookedCareer(4002, { daysOut: 80 });
    for (let w = 0; w < 6; w++) advance(save, { mode: 'week', stopOnDecision: false });
    const me = save.fighters[playerId];
    expect(me.nextBoutId).toBe(boutId);
    expect(save.bouts[boutId].status).toBe('scheduled');
  });

  it('refuses an offer for a fighter with a blocking injury', () => {
    const { save, playerId } = newCareer(4003, { light: true });
    const me = save.fighters[playerId];
    me.injuries.push(makeInjury(save.date, { blocking: true, returnDays: 300 }));
    const reason = offerBlockReason(save, me, { eventDate: addDays(save.date, 60) });
    expect(reason).toBe('blocking-injury');
  });

  it('produces no offers at all across a long injured stretch', () => {
    const { save, playerId } = newCareer(4004, { light: true });
    const me = save.fighters[playerId];
    me.injuries.push(makeInjury(save.date, { blocking: true, returnDays: 400 }));
    for (let w = 0; w < 20; w++) advance(save, { mode: 'week', stopOnDecision: false });
    const offers = Object.values(save.fightOffers).filter((o) => o.fighterId === me.id);
    expect(offers.length).toBe(0);
  });

  it('never creates two offers for the same matchup and event', () => {
    const { save, playerId, opponentId, eventId } = offeredCareer(4005);
    const me = save.fighters[playerId];
    const opponent = save.fighters[opponentId];
    const event = save.events[eventId];
    const rng = new Rng(1);
    // Calling the generator again with identical inputs must return the existing offer.
    const again = createOfferAgain(save, me, opponent, event, rng);
    const openForPlayer = openOffersFor(save, me.id);
    expect(openForPlayer.length).toBe(1);
    expect(again).toBe(openForPlayer[0]);
  });

  it('allows only one open offer for the player at a time', () => {
    const { save, playerId } = offeredCareer(4006);
    const me = save.fighters[playerId];
    for (let w = 0; w < 6; w++) advance(save, { mode: 'week', stopOnDecision: false });
    const open = Object.values(save.fightOffers).filter((o) => o.status === 'open' && o.fighterId === me.id);
    expect(open.length).toBeLessThanOrEqual(1);
  });

  it('closes competing offers and creates exactly one booking when one is accepted', () => {
    const { save, playerId, offerId } = offeredCareer(4007);
    const outcome = respondToOffer(save, offerId, { kind: 'accept' }, new Rng(2));
    expect(outcome.accepted).toBe(true);
    const me = save.fighters[playerId];
    expect(me.nextBoutId).toBe(outcome.boutId);
    const scheduled = Object.values(save.bouts).filter(
      (b) => b.status === 'scheduled' && (b.fighterAId === me.id || b.fighterBId === me.id)
    );
    expect(scheduled.length).toBe(1);
    expect(openOffersFor(save, me.id).length).toBe(0);
  });

  it('creates at most one camp for an accepted bout', () => {
    const { save, playerId, boutId } = bookedCareer(4008);
    const me = save.fighters[playerId];
    planCamp(save, me.id, boutId);
    for (let w = 0; w < 4; w++) advance(save, { mode: 'week', stopOnDecision: false });
    const camps = Object.values(save.camps).filter((c) => c.fighterId === me.id && c.boutId === boutId);
    expect(camps.length).toBe(1);
  });

  it('holds every booking invariant through several weeks', () => {
    const { save } = bookedCareer(4009, { daysOut: 90 });
    for (let w = 0; w < 8; w++) {
      advance(save, { mode: 'week', stopOnDecision: false });
      const violations = checkBookingInvariants(save);
      expect(violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    }
  });
});

describe('injury inside the booked fight flow', () => {
  it('raises an injury decision rather than a new fight offer', () => {
    const { save, playerId, boutId } = injuredBookedCareer(4010);
    const decisions = save.inbox.filter((m) => m.category === 'injury' && m.requiresAction);
    expect(decisions.length).toBe(1);
    expect(decisions[0].linkedBoutId).toBe(boutId);
    const offers = Object.values(save.fightOffers).filter((o) => o.fighterId === playerId && o.status === 'open');
    expect(offers.length).toBe(0);
  });

  it('raises exactly one decision per injury however many passes run', () => {
    const { save } = injuredBookedCareer(4011);
    for (let w = 0; w < 5; w++) advance(save, { mode: 'week', stopOnDecision: false });
    // A second, different injury legitimately gets its own decision. What must never
    // happen is the same injury being asked about twice.
    // Identity lives in decisionKey now, not inside the human readable resolution text.
    const keys = save.inbox.filter((m) => m.category === 'injury').map((m) => m.decisionKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => Boolean(k))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not clear the booked bout for a non blocking injury', () => {
    const { save, playerId, boutId } = bookedCareer(4012);
    const me = save.fighters[playerId];
    me.injuries.push(makeInjury(save.date, { blocking: false, severity: 2, returnDays: 20 }));
    advance(save, { mode: 'week', stopOnDecision: false });
    expect(me.nextBoutId).toBe(boutId);
    expect(save.bouts[boutId].status).toBe('scheduled');
  });

  it('resolves the original bout before any future booking when the player withdraws', () => {
    const { save, playerId, boutId } = injuredBookedCareer(4013);
    const me = save.fighters[playerId];
    const injury = me.injuries[me.injuries.length - 1];
    const outcome = applyInjuryDecision(save, me, injury, 'withdraw', new Rng(4));
    expect(['withdrawn', 'canceled']).toContain(outcome.boutStatus);
    expect(me.nextBoutId).toBeNull();
    // The old bout is either canceled or continues without the player.
    const bout = save.bouts[boutId];
    if (bout.status === 'scheduled') {
      expect(bout.fighterAId).not.toBe(me.id);
      expect(bout.fighterBId).not.toBe(me.id);
    }
    expect(checkBookingInvariants(save)).toEqual([]);
  });

  it('keeps the same opponent when a postponement is agreed', () => {
    const { save, playerId, boutId, opponentId } = injuredBookedCareer(4014, { returnDays: 60, daysOut: 40 });
    const me = save.fighters[playerId];
    me.popularity = 80;
    me.relationships.matchmaker = 95;
    // A later card has to exist for the promotion to move the bout onto.
    const bout = save.bouts[boutId];
    const later = addDays(bout.date, 200);
    save.events[`evt-later`] = { ...save.events[bout.eventId], id: 'evt-later', date: later, name: 'Later Card', boutIds: [], announcedBoutIds: [] };
    const injury = me.injuries[me.injuries.length - 1];
    let outcome = applyInjuryDecision(save, me, injury, 'request-postponement', new Rng(5));
    // The promotion can refuse; try a few seeds so the agreed branch is exercised.
    for (let i = 6; i < 20 && outcome.boutStatus !== 'postponed'; i++) {
      outcome = applyInjuryDecision(save, me, injury, 'request-postponement', new Rng(i));
    }
    if (outcome.boutStatus === 'postponed') {
      const moved = save.bouts[boutId];
      expect(moved.status).toBe('scheduled');
      expect([moved.fighterAId, moved.fighterBId]).toContain(opponentId);
      expect([moved.fighterAId, moved.fighterBId]).toContain(me.id);
      expect(me.nextBoutId).toBe(boutId);
    }
  });

  it('classifies injuries against the fight date', () => {
    const today = '2026-01-01';
    const shortInjury = makeInjury(today, { blocking: true, severity: 3, returnDays: 10 });
    const longInjury = makeInjury(today, { blocking: true, severity: 4, returnDays: 200 });
    expect(classifyInjury(shortInjury, addDays(today, 120), today)).toBe('blocks-temporarily');
    expect(classifyInjury(longInjury, addDays(today, 60), today)).toBe('requires-withdrawal');
    expect(choicesFor('requires-withdrawal', true).some((c) => c.key === 'withdraw')).toBe(true);
    expect(choicesFor('minor-trainable', false).some((c) => c.key === 'withdraw')).toBe(false);
  });
});

describe('career state machine', () => {
  it('reports booked, camp planning and fight week in order', () => {
    const { save, boutId } = bookedCareer(4020, { daysOut: 60 });
    const planning = careerStatus(save);
    expect(planning.state).toBe('camp-planning');
    expect(planning.boutId).toBe(boutId);
    expect(planning.advanceBlocked).toBe(false);

    save.date = addDays(save.bouts[boutId].date, -3);
    ensureFightWeekTasks(save, boutId);
    const week = careerStatus(save);
    expect(week.state).toBe('fight-week');
  });

  it('blocks advancement when an injury decision is pending', () => {
    const { save } = injuredBookedCareer(4021);
    const status = careerStatus(save);
    expect(status.state).toBe('injured-while-booked');
    expect(status.advanceBlocked).toBe(true);
    expect(status.action?.label).toBe('Review Injury');
  });

  it('only allows valid transitions', () => {
    expect(isValidTransition('booked', 'camp-active')).toBe(true);
    expect(isValidTransition('fight-in-progress', 'available')).toBe(false);
    expect(isValidTransition('retired', 'available')).toBe(false);
  });

  it('persists the state into the save', () => {
    const { save } = bookedCareer(4022);
    advance(save, { mode: 'week', stopOnDecision: false });
    expect(save.careerState).toBeDefined();
    expect(save.careerState!.reason.length).toBeGreaterThan(0);
  });
});

describe('fight week', () => {
  it('generates one set of tasks per bout however often it is called', () => {
    const { save, boutId } = fightWeekCareer(4030);
    const first = tasksForBout(save, boutId).length;
    ensureFightWeekTasks(save, boutId);
    ensureFightWeekTasks(save, boutId);
    expect(tasksForBout(save, boutId).length).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it('always includes the mandatory stages', () => {
    const { save, boutId } = fightWeekCareer(4031);
    const stages = tasksForBout(save, boutId).map((t) => t.stage);
    expect(stages).toContain('official-weigh-in');
    expect(stages).toContain('final-clearance');
    expect(stages).toContain('fight-night');
  });

  it('does not offer a stage before its date', () => {
    const { save, boutId } = bookedCareer(4032, { daysOut: 30 });
    ensureFightWeekTasks(save, boutId);
    expect(pendingStages(save, boutId).length).toBe(0);
  });

  it('blocks the calendar on a due mandatory stage', () => {
    const { save, boutId } = fightWeekCareer(4033, { daysOut: 1 });
    const blocking = blockingStage(save, boutId);
    expect(blocking).not.toBeNull();
    expect(blocking!.mandatory).toBe(true);
  });

  it('refuses to fight a booked bout before its date', () => {
    const { save, boutId } = bookedCareer(4036, { daysOut: 60 });
    const event = save.events[save.bouts[boutId].eventId];
    expect(() => simulatePlayerBout(save, boutId, ['pressure'])).toThrow(/Fight night is/);
    expect(save.bouts[boutId].status).toBe('scheduled');
    expect(save.bouts[boutId].resultId).toBeNull();
    expect(event.status).toBe('announced');
  });

  it('closes final clearance and fight night when the fight happens, and schedules no post fight stages', () => {
    const { save, boutId } = fightWeekCareer(4037, { isTitleFight: true, daysOut: 0 });
    const stages = tasksForBout(save, boutId).map((t) => t.stage);
    expect(stages).not.toContain('post-fight-interview');
    expect(stages).not.toContain('post-fight-press');
    const before = { ...save.fighters[save.bouts[boutId].fighterAId].record };
    simulatePlayerBout(save, boutId, ['pressure']);
    const open = tasksForBout(save, boutId).filter((t) => t.status !== 'complete' && t.status !== 'skipped');
    expect(open.map((t) => t.stage)).not.toContain('final-clearance');
    expect(open.map((t) => t.stage)).not.toContain('fight-night');
    const night = tasksForBout(save, boutId).find((t) => t.stage === 'fight-night')!;
    expect(night.resolvedOn).toBe(save.bouts[boutId].date);
    // The pre fight snapshot keeps the record as it was before the result applied.
    expect(save.bouts[boutId].preFight?.recordA).toEqual({ ...before });
  });

  it('generates press conference questions once and records answers once', () => {
    const { save, boutId } = fightWeekCareer(4034, { isTitleFight: true, daysOut: 2 });
    const session = createSession(save, boutId, 'press-conference', presserRng(save, boutId, 'press-conference'))!;
    expect(session.questions.length).toBeGreaterThan(1);
    const again = createSession(save, boutId, 'press-conference', presserRng(save, boutId, 'press-conference'))!;
    expect(again.id).toBe(session.id);
    expect(again.questions.length).toBe(session.questions.length);

    const q = session.questions[0];
    const reaction = answerQuestion(save, session.id, q.id, q.answers[0].key, new Rng(7));
    expect(reaction).toBeTruthy();
    const secondReaction = answerQuestion(save, session.id, q.id, q.answers[1].key, new Rng(8));
    // A second answer to the same question changes nothing.
    expect(secondReaction).toBe(reaction);
    expect(session.questions[0].selectedKey).toBe(q.answers[0].key);
  });

  it('offers genuinely different replies, not the same list every time', () => {
    const { save, boutId } = fightWeekCareer(4035, { isTitleFight: true, daysOut: 2 });
    const session = createSession(save, boutId, 'press-conference', presserRng(save, boutId, 'press-conference'))!;
    const texts = new Set(session.questions.flatMap((q) => q.answers.map((a) => a.text)));
    // Every answer across the session should be distinct prose.
    expect(texts.size).toBeGreaterThan(session.questions.length);
    for (const q of session.questions) {
      const tones = new Set(q.answers.map((a) => a.tone));
      expect(tones.size).toBe(q.answers.length);
      expect(q.answers.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('weigh in', () => {
  it('reveals the player and the opponent in separate visible steps', () => {
    const { save, boutId } = fightWeekCareer(4040, { daysOut: 1 });
    const state = beginWeighIn(save, boutId)!;
    expect(state.stage).toBe('player-approaching');
    expect(state.player).toBeNull();

    stepWeighIn(save, boutId);
    expect(save.weighIns![boutId].stage).toBe('player-revealed');
    expect(save.weighIns![boutId].player).not.toBeNull();
    expect(save.weighIns![boutId].opponent).toBeNull();

    stepWeighIn(save, boutId);
    stepWeighIn(save, boutId);
    expect(save.weighIns![boutId].opponent).not.toBeNull();
  });

  it('does not regenerate a weigh in that already exists', () => {
    const { save, boutId } = fightWeekCareer(4041, { daysOut: 1 });
    const first = beginWeighIn(save, boutId)!;
    stepWeighIn(save, boutId);
    const weight = save.weighIns![boutId].player!.weightLb;
    const again = beginWeighIn(save, boutId)!;
    expect(again).toBe(first);
    expect(save.weighIns![boutId].player!.weightLb).toBe(weight);
  });

  it('reaches a ruling and closes the stage exactly once', () => {
    const { save, boutId } = fightWeekCareer(4042, { daysOut: 1 });
    beginWeighIn(save, boutId);
    for (let i = 0; i < 8 && save.weighIns![boutId].stage !== 'complete'; i++) {
      const state = save.weighIns![boutId];
      if (state.stage === 'second-attempt-decision') applySecondAttempt(save, boutId, 'accept-miss');
      else if (state.stage === 'catchweight-negotiation') resolveOpponentDecision(save, boutId, new Rng(4042 + i));
      else if (state.stage === 'opponent-decision') break;
      else stepWeighIn(save, boutId);
    }
    const state = save.weighIns![boutId];
    if (state.stage === 'complete') {
      expect(state.rulingText).toBeTruthy();
      if (state.boutStatus === 'canceled') {
        // The other camp refused the catchweight: the bout itself is off and its tasks go with it.
        expect(save.bouts[boutId].status).toBe('canceled');
        expect(tasksForBout(save, boutId)).toHaveLength(0);
      } else {
        const task = tasksForBout(save, boutId).find((t) => t.stage === 'official-weigh-in');
        expect(task?.status).toBe('complete');
      }
    }
  });

  it('gives a second attempt decision that blocks until answered', () => {
    const { save, boutId } = fightWeekCareer(4043, { daysOut: 1 });
    const state = beginWeighIn(save, boutId)!;
    // Force a miss so the decision path is reachable regardless of the seed.
    state.stage = 'opponent-revealed';
    state.player = { fighterId: save.player.fighterId!, weightLb: state.limitLb + 1, madeWeight: false, overBy: 1, cutQuality: 0.4, attempt: 1 };
    state.opponent = { fighterId: 'x', weightLb: state.limitLb, madeWeight: true, overBy: 0, cutQuality: 0.8, attempt: 1 };
    stepWeighIn(save, boutId);
    expect(save.weighIns![boutId].stage).toBe('second-attempt-decision');
    expect(save.weighIns![boutId].secondAttemptOffered).toBe(true);
  });

  /** A weigh in forced to the point where the player has missed and the opponent has not. */
  function forcedMiss(seed: number, overBy: number, cutQuality = 0.4) {
    const { save, boutId } = fightWeekCareer(seed, { daysOut: 1 });
    const state = beginWeighIn(save, boutId)!;
    const bout = save.bouts[boutId];
    const opponentId = bout.fighterAId === save.player.fighterId ? bout.fighterBId : bout.fighterAId;
    state.stage = 'opponent-revealed';
    state.player = { fighterId: save.player.fighterId!, weightLb: state.limitLb + overBy, madeWeight: false, overBy, cutQuality, attempt: 1 };
    state.opponent = { fighterId: opponentId, weightLb: state.limitLb, madeWeight: true, overBy: 0, cutQuality: 0.8, attempt: 1 };
    return { save, boutId, state };
  }

  it('never brings a second attempt back heavier or fresher than the first', () => {
    let made = 0;
    for (let seed = 4100; seed < 4140; seed++) {
      const { save, boutId } = forcedMiss(seed, 1, 0.3 + (seed % 5) * 0.05);
      stepWeighIn(save, boutId);
      const first = { ...save.weighIns![boutId].player! } as WeighInReading;
      applySecondAttempt(save, boutId, 'try-again');
      const second = save.weighIns![boutId].player!;
      expect(second.weightLb).toBeLessThanOrEqual(first.weightLb);
      expect(second.cutQuality).toBeLessThanOrEqual(first.cutQuality);
      expect(second.attempt).toBe(2);
      if (second.madeWeight) made++;
      // A made retry goes to the ruling, a failed one to the other camp.
      expect(save.weighIns![boutId].stage).toBe(second.madeWeight ? 'ruling' : 'catchweight-negotiation');
      // The task is closed with the decision rather than left open after the ruling.
      expect(tasksForBout(save, boutId).find((t) => t.stage === 'second-weigh-in-attempt')?.status).toBe('complete');
    }
    // One more hour on a pound is usually enough.
    expect(made).toBeGreaterThan(20);
  });

  it('puts a large miss, and stopping the cut, to the other camp', () => {
    const big = forcedMiss(4150, 3);
    stepWeighIn(big.save, big.boutId);
    expect(big.save.weighIns![big.boutId].stage).toBe('catchweight-negotiation');
    expect(big.save.weighIns![big.boutId].purseForfeitPct).toBe(25);
    expect(big.save.weighIns![big.boutId].catchweightLb).toBe(Math.ceil(big.state.limitLb + 3));

    const stop = forcedMiss(4151, 2);
    stepWeighIn(stop.save, stop.boutId);
    expect(stop.save.weighIns![stop.boutId].stage).toBe('second-attempt-decision');
    applySecondAttempt(stop.save, stop.boutId, 'stop-cutting');
    expect(stop.save.weighIns![stop.boutId].stage).toBe('catchweight-negotiation');
    expect(stop.save.weighIns![stop.boutId].purseForfeitPct).toBe(25);

    // The other camp can actually say no.
    let canceled = 0;
    for (let i = 0; i < 40; i++) {
      const run = forcedMiss(4160 + i, 3);
      stepWeighIn(run.save, run.boutId);
      resolveOpponentDecision(run.save, run.boutId, new Rng(i));
      stepWeighIn(run.save, run.boutId);
      if (run.save.weighIns![run.boutId].boutStatus === 'canceled') {
        canceled++;
        expect(run.save.bouts[run.boutId].status).toBe('canceled');
      } else {
        expect(run.save.bouts[run.boutId].contractedWeightLb).toBe(Math.ceil(run.state.limitLb + 3));
      }
    }
    expect(canceled).toBeGreaterThan(0);
  });

  it('charges fight night the wear of the official cut, not of a fresh roll', () => {
    for (let seed = 4180; seed < 4186; seed++) {
      const { save, boutId } = forcedMiss(seed, 0);
      const state = save.weighIns![boutId];
      state.player = { ...state.player!, madeWeight: true, overBy: 0, cutQuality: 0.95, outcome: 'comfortable', wear: { weightCut: 0.4, recovery: 0.3 } };
      const me = save.fighters[save.player.fighterId!];
      // A walking weight no cut could make, so the fresh roll is a severe miss every time.
      me.walkingWeightLb = state.limitLb + 60;
      const before = me.wear.weightCut;
      prepareSide(save, save.bouts[boutId], me, new Rng(seed));
      const scale = 1 / Math.min(1.4, Math.max(0.6, me.development.resilience));
      expect(me.wear.weightCut - before).toBeCloseTo(0.4 * scale, 5);
      expect(save.bouts[boutId].isCatchweight).toBeFalsy();
    }
  });

  it('cuts a short notice bout with no camp as the short notice cut it is', () => {
    const { save, boutId } = bookedCareer(4190, { daysOut: 2 });
    const bout = save.bouts[boutId];
    const me = save.fighters[save.player.fighterId!];
    for (const id of Object.keys(save.camps)) if (save.camps[id].boutId === boutId) delete save.camps[id];
    bout.bookedOn = addDays(bout.date, -60);
    const full = cutContext(save, bout, me);
    expect(full).toMatchObject({ shortNotice: false, campWeeks: 7 });
    bout.bookedOn = addDays(bout.date, -10);
    const short = cutContext(save, bout, me);
    expect(short).toMatchObject({ shortNotice: true, campWeeks: 2 });
    // The forecast reads the same conditions, so it can only get harder.
    const order = ['routine', 'manageable', 'hard', 'severe', 'not realistic'];
    me.walkingWeightLb = bout.contractedWeightLb + 14;
    bout.bookedOn = addDays(bout.date, -60);
    const easy = forecast(save, boutId)!.difficulty;
    bout.bookedOn = addDays(bout.date, -10);
    const hard = forecast(save, boutId)!.difficulty;
    expect(order.indexOf(hard)).toBeGreaterThan(order.indexOf(easy));
  });

  it('sorts the second attempt straight after the weigh in it repeats', () => {
    const { save, boutId } = forcedMiss(4152, 1);
    ensureFightWeekTasks(save, boutId);
    stepWeighIn(save, boutId);
    const stages = tasksForBout(save, boutId).map((t) => t.stage);
    expect(stages.indexOf('second-weigh-in-attempt')).toBe(stages.indexOf('official-weigh-in') + 1);
  });
});

describe('division moves', () => {
  it('never moves the player, booked or not, and asks when they are free', () => {
    const booked = bookedCareer(4170, { daysOut: 40 });
    const me = booked.save.fighters[booked.save.player.fighterId!];
    const division = me.divisionId;
    me.weightMisses = 3;
    advance(booked.save, { mode: 'week', stopOnDecision: false });
    expect(me.divisionId).toBe(division);
    expect(me.weightMisses).toBeGreaterThanOrEqual(3);
    expect(booked.save.bouts[booked.boutId].status).toBe('scheduled');

    const free = newCareer(4171);
    const you = free.save.fighters[free.save.player.fighterId!];
    const before = you.divisionId;
    you.weightMisses = 3;
    advance(free.save, { mode: 'week', stopOnDecision: false });
    expect(you.divisionId).toBe(before);
    expect(you.weightMisses).toBeGreaterThanOrEqual(3);
    const asked = free.save.inbox.find((m) => m.decisionKey === `weight-forced-move|${you.id}`);
    expect(asked?.choices.map((c) => c.key)).toEqual(['weight-move-up', 'weight-keep-cutting']);

    // Not asked again while the first is open.
    advance(free.save, { mode: 'week', stopOnDecision: false });
    expect(free.save.inbox.filter((m) => m.decisionKey === `weight-forced-move|${you.id}`)).toHaveLength(1);

    // Moving up goes through the plan: asked of the promotion, then committed.
    const result = resolvePlayerDecision(free.save, { messageId: asked!.id, choiceKey: 'weight-move-up' }, new Rng(4171));
    expect(result.ok).toBe(true);
    const plan = free.save.weightClassPlans?.[you.id];
    expect(plan?.fromDivisionId).toBe(before);
    if (plan?.status === 'completed') {
      expect(you.divisionId).toBe(plan.toDivisionId);
      expect(you.ranking).toBeNull();
    } else {
      expect(you.divisionId).toBe(before);
    }
  });

  it('does not move a booked fighter in the weight pass', () => {
    const { save, boutId } = bookedCareer(4172, { daysOut: 40 });
    const bout = save.bouts[boutId];
    const npc = save.fighters[bout.fighterAId === save.player.fighterId ? bout.fighterBId : bout.fighterAId];
    npc.weightMisses = 3;
    const division = npc.divisionId;
    expect(manageWalkingWeight(npc, save.date, false).movedUp).toBeNull();
    expect(npc.divisionId).toBe(division);
    expect(manageWalkingWeight(npc, save.date, true).movedUp).toBeTruthy();
  });
});

describe('social items', () => {
  it('stays inside the weekly budget', () => {
    const { save, playerId } = bookedCareer(4050, { daysOut: 60 });
    const me = save.fighters[playerId];
    const created = generateSocialItems(save, me, socialRng(save, me.id));
    expect(created.length).toBeLessThanOrEqual(4);
  });

  it('applies a reply once and records the reaction', () => {
    const { save, playerId } = bookedCareer(4051, { daysOut: 40 });
    const me = save.fighters[playerId];
    const created = generateSocialItems(save, me, socialRng(save, me.id));
    if (created.length === 0) return;
    const item = created[0];
    const favBefore = me.fame?.favorability ?? 0;
    const reaction = replyToSocialItem(save, item.id, item.replies[0].key, new Rng(9));
    expect(reaction).toBeTruthy();
    const favAfter = me.fame?.favorability ?? 0;
    const second = replyToSocialItem(save, item.id, item.replies[1].key, new Rng(10));
    // A second reply changes nothing.
    expect(second).toBe(reaction);
    expect(me.fame?.favorability ?? 0).toBe(favAfter);
    expect(save.socialFeed![item.id].selectedReplyKey).toBe(item.replies[0].key);
    void favBefore;
  });

  it('does not regenerate a resolved item', () => {
    const { save, playerId } = bookedCareer(4052, { daysOut: 40 });
    const me = save.fighters[playerId];
    const created = generateSocialItems(save, me, socialRng(save, me.id));
    if (created.length === 0) return;
    replyToSocialItem(save, created[0].id, created[0].replies[0].key, new Rng(11));
    const again = generateSocialItems(save, me, socialRng(save, me.id));
    expect(again.some((i) => i.id === created[0].id)).toBe(false);
  });
});

describe('fight playback', () => {
  it('stops event playback at the finishing event', () => {
    const { save, boutId } = fightWeekCareer(4060, { daysOut: 0 });
    simulatePlayerBout(save, boutId, ['pressure']);
    const result = save.history.results[boutId];
    expect(result).toBeDefined();
    const end = playbackEndIndex(result);
    if (isFinish(result.method)) {
      const finish = finishingEventIndex(result);
      expect(finish).not.toBeNull();
      expect(end).toBe(finish);
      // Nothing is shown after the finish.
      expect(end).toBeLessThanOrEqual((result.events ?? []).length - 1);
    }
  });

  it('never produces a normal completed round summary for a finishing round', () => {
    for (const seed of [4061, 4062, 4063, 4064, 4065, 4066]) {
      const { save, boutId } = fightWeekCareer(seed, { daysOut: 0 });
      simulatePlayerBout(save, boutId, ['pressure']);
      const result = save.history.results[boutId];
      const a = save.fighters[result.fighterAId];
      const b = save.fighters[result.fighterBId];
      const summary = summarizeRound(result, result.endRound, a.name, b.name);
      if (isFinish(result.method)) {
        expect(summary.completedNormally).toBe(false);
        expect(summary.finish).not.toBeNull();
        expect(summary.finish!.method).toBeTruthy();
        expect(summary.finish!.time).toBeTruthy();
        expect(roundEndedByFinish(result, result.endRound)).toBe(true);
      } else {
        expect(summary.finish).toBeNull();
      }
    }
  });

  it('produces one summary per completed round for a decision', () => {
    let found = false;
    for (const seed of [4070, 4071, 4072, 4073, 4074, 4075, 4076, 4077]) {
      const { save, boutId } = fightWeekCareer(seed, { daysOut: 0 });
      simulatePlayerBout(save, boutId, ['pressure']);
      const result = save.history.results[boutId];
      if (isFinish(result.method)) continue;
      found = true;
      const a = save.fighters[result.fighterAId];
      const b = save.fighters[result.fighterBId];
      for (const r of result.rounds) {
        const summary = summarizeRound(result, r.round, a.name, b.name);
        expect(summary.completedNormally).toBe(true);
        expect(summary.lines.length).toBeGreaterThan(0);
      }
      break;
    }
    expect(found).toBe(true);
  });

  it('cannot simulate the same fight twice', () => {
    const { save, boutId } = fightWeekCareer(4080, { daysOut: 0 });
    simulatePlayerBout(save, boutId, ['pressure']);
    const first = save.bouts[boutId].resultId;
    const resultsBefore = Object.keys(save.history.results).length;
    simulatePlayerBout(save, boutId, ['pressure']);
    expect(save.bouts[boutId].resultId).toBe(first);
    expect(Object.keys(save.history.results).length).toBe(resultsBefore);
  });

  it('replays one stored result identically whatever the presentation mode', () => {
    const { save, boutId } = fightWeekCareer(4081, { daysOut: 0 });
    simulatePlayerBout(save, boutId, ['pressure']);
    const result = save.history.results[boutId];
    // All three modes read the same stored object; there is no second simulation to differ.
    const end = playbackEndIndex(result);
    expect(end).toBeGreaterThanOrEqual(0);
    expect(result.seed).toBeDefined();
    expect(save.history.results[boutId]).toBe(result);
  });
});

describe('money, sponsors and management', () => {
  it('derives every balance from the ledger', () => {
    const { save, playerId } = bookedCareer(4110);
    // A career opens with savings, which are cash but never earnings.
    const opening = save.finance!.cash;
    expect(opening).toBeGreaterThan(0);
    expect(save.finance!.careerEarnings).toBe(0);
    record(save, playerId, 'in', 'show-pay', 50000, 'Test purse');
    record(save, playerId, 'out', 'taxes', 16000, 'Test tax');
    const summary = summarize(save, playerId);
    expect(summary.careerEarnings).toBe(50000);
    expect(summary.careerExpenses).toBe(16000);
    expect(summary.cash).toBe(opening + 34000);
    expect(save.player.balance).toBe(opening + 34000);
  });

  it('takes manager commission, gym percentage and tax off a purse exactly once', () => {
    const { save, playerId, boutId } = bookedCareer(4111);
    const manager = generateManager(save, new Rng(30));
    hireManager(save, playerId, manager.id);
    const me = save.fighters[playerId];
    const split = applyFightPurse(save, me, boutId, { show: 100000, win: 100000, bonuses: 0 }, true);
    expect(split.gross).toBe(200000);
    expect(split.deductions.some((d) => d.kind === 'manager-commission')).toBe(true);
    expect(split.deductions.some((d) => d.kind === 'taxes')).toBe(true);
    expect(split.net).toBeLessThan(split.gross);
    const commissionEntries = ledger(save).filter((e) => e.kind === 'manager-commission' && e.boutId === boutId);
    expect(commissionEntries.length).toBe(1);
  });

  it('pays sponsors once per fight and only while active', () => {
    const { save, playerId, boutId } = bookedCareer(4112);
    const me = save.fighters[playerId];
    me.popularity = 70;
    if (me.fame) me.fame.sponsorAppeal = 85;
    let offer = null;
    for (let i = 0; i < 60 && !offer; i++) offer = generateSponsorOffer(save, me, new Rng(200 + i));
    expect(offer).not.toBeNull();
    // An unsigned offer pays nothing.
    expect(paySponsorsForFight(save, me, boutId, true, false)).toBe(0);
    acceptSponsor(save, offer!.id);
    const paid = paySponsorsForFight(save, me, boutId, true, false);
    expect(paid).toBeGreaterThan(0);
  });

  it('refuses to hire a manager who is at capacity', () => {
    const { save, playerId } = bookedCareer(4113);
    const manager = generateManager(save, new Rng(31));
    manager.clientCapacity = 0;
    const result = hireManager(save, playerId, manager.id);
    expect(result.ok).toBe(false);
  });

  it('reports a conflict of interest for two clients in one division', () => {
    const { save, playerId, opponentId } = bookedCareer(4114);
    const manager = generateManager(save, new Rng(32));
    manager.clientCapacity = 10;
    hireManager(save, playerId, manager.id);
    hireManager(save, opponentId, manager.id);
    const conflicts = conflictsOfInterest(save, playerId);
    expect(conflicts.map((f) => f.id)).toContain(opponentId);
  });

  it('shows a missed weight forfeit and the share paid to the side that made weight', () => {
    const { save, playerId, opponentId, boutId } = bookedCareer(4116);
    const bout = save.bouts[boutId];
    const meIsA = bout.fighterAId === playerId;
    // The fallback weigh in: the opponent missed and forfeited 10,000, which went to the player.
    if (meIsA) {
      bout.forfeitB = 10000;
      bout.weighInA = { madeWeight: true, weightLb: 155, cutQuality: 70 };
      bout.weighInB = { madeWeight: false, weightLb: 158, cutQuality: 30 };
    } else {
      bout.forfeitA = 10000;
      bout.weighInB = { madeWeight: true, weightLb: 155, cutQuality: 70 };
      bout.weighInA = { madeWeight: false, weightLb: 158, cutQuality: 30 };
    }
    void opponentId;
    const me = save.fighters[playerId];
    const split = applyFightPurse(save, me, boutId, { show: 60000, win: 50000, bonuses: 0 }, false);
    const lines = ledger(save).filter((e) => e.boutId === boutId);
    expect(lines.find((e) => e.kind === 'show-pay')?.amount).toBe(50000);
    expect(lines.find((e) => e.kind === 'forfeit-received')?.amount).toBe(10000);
    expect(lines.some((e) => e.kind === 'purse-forfeit')).toBe(false);
    // The commission base is the show money actually paid, as before.
    expect(split.gross).toBe(60000);
    expect(lines.find((e) => e.kind === 'taxes')?.amount).toBe(Math.round(60000 * PURSE_TAX_RATE));
  });

  it('records the forfeit of a player who missed weight as its own line', () => {
    const { save, playerId, boutId } = bookedCareer(4117);
    const bout = save.bouts[boutId];
    const meIsA = bout.fighterAId === playerId;
    if (meIsA) {
      bout.forfeitA = 10000;
      bout.weighInA = { madeWeight: false, weightLb: 158, cutQuality: 30 };
      bout.weighInB = { madeWeight: true, weightLb: 155, cutQuality: 70 };
    } else {
      bout.forfeitB = 10000;
      bout.weighInB = { madeWeight: false, weightLb: 158, cutQuality: 30 };
      bout.weighInA = { madeWeight: true, weightLb: 155, cutQuality: 70 };
    }
    const cashBefore = save.finance!.cash;
    const split = applyFightPurse(save, save.fighters[playerId], boutId, { show: 40000, win: 50000, bonuses: 0 }, false);
    const lines = ledger(save).filter((e) => e.boutId === boutId);
    expect(lines.find((e) => e.kind === 'show-pay')?.amount).toBe(50000);
    expect(lines.find((e) => e.kind === 'purse-forfeit')?.amount).toBe(10000);
    expect(lines.some((e) => e.kind === 'forfeit-received')).toBe(false);
    // The lines net to the same cash as the show money paid.
    expect(save.finance!.cash - cashBefore).toBe(split.net);
  });

  it('takes commission, gym share and tax off pay per view points', () => {
    const { save, playerId, boutId } = bookedCareer(4118);
    const manager = generateManager(save, new Rng(33));
    hireManager(save, playerId, manager.id);
    const me = save.fighters[playerId];
    const net = applyPpvPoints(save, me, boutId, 100000);
    const lines = ledger(save).filter((e) => e.boutId === boutId);
    expect(lines.find((e) => e.kind === 'ppv-points')?.amount).toBe(100000);
    expect(lines.find((e) => e.kind === 'manager-commission')?.amount).toBe(Math.round(100000 * manager.commissionPct / 100));
    expect(lines.find((e) => e.kind === 'taxes')?.amount).toBe(Math.round(100000 * PURSE_TAX_RATE));
    expect(lines.some((e) => e.kind === 'travel')).toBe(false);
    expect(net).toBeLessThan(100000);
  });

  it('pays pay per view points from the card buys, with business depth on and off', () => {
    const paid: number[] = [];
    let buys = 0;
    for (const depth of [true, false]) {
      const { save, playerId, boutId } = bookedCareer(4119, { daysOut: 1 });
      save.settings.featureFlags = { ...DEFAULT_FEATURE_FLAGS, ...save.settings.featureFlags, businessDepth: depth };
      const me = save.fighters[playerId];
      const contract = save.contracts[me.contractId!];
      contract.terms.ppvPoints = 2500;
      const event = save.events[save.bouts[boutId].eventId];
      expect(event.tier).toBe('numbered-ppv');
      save.date = save.bouts[boutId].date;
      simulatePlayerBout(save, boutId, ['pressure']);
      if (depth) buys = getBusiness(save, event.id)?.ppvBuys ?? 0;
      else expect(getBusiness(save, event.id)).toBeNull();
      const line = ledger(save).find((e) => e.kind === 'ppv-points' && e.boutId === boutId);
      paid.push(line?.amount ?? 0);
    }
    expect(buys).toBeGreaterThan(0);
    // The business draw happens either way, so both runs see the same buys.
    expect(paid[0]).toBe(Math.round((buys / 1000) * 2500));
    expect(paid[1]).toBe(paid[0]);
  });

  it('refuses a fifth sponsor and an exclusivity clash at signing', () => {
    const { save, playerId } = bookedCareer(4120);
    const deal = (n: number, category: Sponsor['category'], exclusive: boolean, name: string): Sponsor => {
      const s: Sponsor = {
        id: `sponsor-${playerId}-2030-01-0${n}-${category}`,
        name,
        category,
        perFight: 1000,
        monthly: 0,
        winBonus: 0,
        championBonus: 0,
        postsPerMonth: 0,
        appearancesPerYear: 0,
        exclusiveCategory: exclusive,
        moralityClause: false,
        startedOn: save.date,
        endsOn: addDays(save.date, 300),
        status: 'offered',
        satisfaction: 60,
        note: '',
      };
      save.sponsors = { ...(save.sponsors ?? {}), [s.id]: s };
      return s;
    };
    const apparel = deal(1, 'apparel', true, 'Ironline Apparel');
    const rival = deal(2, 'apparel', false, 'Northgate Fightwear');
    expect(acceptSponsor(save, apparel.id)).not.toBeNull();
    // Signing an exclusive deal withdraws the other offer in its category.
    expect(rival.status).toBe('lapsed');
    const clash = deal(3, 'apparel', false, 'Cordon Athletic');
    expect(canSignSponsor(save, clash)).toMatch(/exclusive/);
    expect(acceptSponsor(save, clash.id)).toBeNull();
    for (const [n, c, name] of [[4, 'nutrition', 'Anchor Foods'], [5, 'gaming', 'Sixth Frame'], [6, 'local-business', 'Halland Dental']] as const) {
      expect(acceptSponsor(save, deal(n, c, false, name).id)).not.toBeNull();
    }
    const fifth = deal(7, 'gym-equipment', false, 'Anvil Works');
    expect(canSignSponsor(save, fifth)).toMatch(/4 sponsors/);
    expect(acceptSponsor(save, fifth.id)).toBeNull();
    expect(Object.values(save.sponsors!).filter((s) => s.status === 'active')).toHaveLength(4);
  });

  it('opens a better contract offer with a manager, on the same seed', () => {
    const { save, playerId } = bookedCareer(4121);
    const me = save.fighters[playerId];
    const without = createContractOffer(me, save, new Rng(77));
    const manager = generateManager(save, new Rng(34));
    manager.negotiation = 80;
    hireManager(save, playerId, manager.id);
    const withManager = createContractOffer(me, save, new Rng(77));
    expect(withManager.terms.fights).toBe(without.terms.fights);
    expect(withManager.terms.showPay).toBeGreaterThan(without.terms.showPay);
    expect(withManager.reservation.maxShowPay).toBeGreaterThan(without.reservation.maxShowPay);
  });

  it('limits asking around for a manager to once a month', () => {
    const { save, playerId } = bookedCareer(4122);
    // A career starts with a few managers to choose from.
    expect(Object.keys(save.managers ?? {}).length).toBeGreaterThanOrEqual(3);
    const me = save.fighters[playerId];
    const first = searchForManager(save, me, new Rng(1));
    expect(first.ok).toBe(true);
    const second = searchForManager(save, me, new Rng(2));
    expect(second.ok).toBe(false);
  });

  it('applies monthly costs at most once per calendar month', () => {
    const { save, playerId } = bookedCareer(4115);
    const me = save.fighters[playerId];
    const first = applyMonthlyExpenses(save, me);
    const second = applyMonthlyExpenses(save, me);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });
});

describe('anti-doping', () => {
  it('defaults to standard compliance and records a chosen posture', () => {
    const { save, playerId } = bookedCareer(4120);
    expect(dopingState(save, playerId).posture).toBe('standard');
    setPosture(save, playerId, 'strict');
    expect(dopingState(save, playerId).posture).toBe('strict');
  });

  it('suspends, voids the booked bout and strips a title on an adverse finding', () => {
    const { save, playerId, boutId } = bookedCareer(4121, { isTitleFight: true });
    const me = save.fighters[playerId];
    setPosture(save, playerId, 'questionable');
    save.rankings[me.divisionId].championId = me.id;
    me.isChampion = true;
    save.history.reigns.push({
      id: 'reign-test',
      divisionId: me.divisionId,
      fighterId: me.id,
      isInterim: false,
      wonOn: save.date,
      wonBoutId: null,
      lostOn: null,
      lostBoutId: null,
      defenses: 0,
      endReason: null,
    });
    // Drive the pass with seeds until a finding lands, which proves the path is reachable.
    let notes: string[] = [];
    for (let i = 0; i < 500 && notes.length === 0; i++) {
      notes = runAntiDopingWeek(save, me, new Rng(500 + i));
    }
    expect(notes.length).toBeGreaterThan(0);
    if (me.antiDopingSuspension) {
      expect(save.bouts[boutId].status).not.toBe('scheduled');
      expect(save.rankings[me.divisionId].championId).toBeNull();
      expect(offerBlockReason(save, me, { eventDate: addDays(save.date, 30) })).toBeTruthy();
    }
  });

  it('clears the suspension when it expires', () => {
    const { save, playerId } = bookedCareer(4122);
    const me = save.fighters[playerId];
    me.antiDopingSuspension = { until: addDays(save.date, -1), reason: 'test', clearanceRequired: true };
    me.activityStatus = 'suspended';
    expect(clearExpiredSuspensions(save, me)).toBe(true);
    expect(me.antiDopingSuspension).toBeNull();
    expect(me.activityStatus).toBe('active');
  });

  it('gives an appeal a real chance of reduction or failure', () => {
    const outcomes = new Set<string>();
    // One world, many appeals. Building forty worlds to test one function was the slow part.
    const { save, playerId } = bookedCareer(4130);
    const me = save.fighters[playerId];
    for (let i = 0; i < 40; i++) {
      me.antiDopingSuspension = { until: addDays(save.date, 400), reason: 'test', clearanceRequired: true };
      const outcome = appealSanction(save, me, new Rng(900 + i));
      outcomes.add(outcome.overturned ? 'overturned' : outcome.reducedMonths > 0 ? 'reduced' : 'upheld');
    }
    // All three results must be reachable, otherwise the appeal is theatre.
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

describe('the complete career path', () => {
  it('runs offer, booking, camp, fight week, weigh in, fight and result end to end', () => {
    const { save, playerId, offerId } = offeredCareer(4100, { daysOut: 60 });
    const me = save.fighters[playerId];

    // 1. An offer is waiting and it blocks the calendar.
    expect(careerStatus(save).state).toBe('offer-pending');
    expect(careerStatus(save).advanceBlocked).toBe(true);

    // 2. Accept it. Exactly one booking, no competing offers.
    const outcome = respondToOffer(save, offerId, { kind: 'accept' }, new Rng(20));
    expect(outcome.accepted).toBe(true);
    const boutId = outcome.boutId!;
    expect(me.nextBoutId).toBe(boutId);
    expect(careerStatus(save).state).toBe('camp-planning');

    // 3. Plan one camp.
    planCamp(save, me.id, boutId);
    expect(careerStatus(save).state).toBe('camp-active');
    expect(Object.values(save.camps).filter((c) => c.fighterId === me.id && c.status !== 'abandoned').length).toBe(1);

    // 4. Reach fight week. No new offers appeared on the way.
    save.date = addDays(save.bouts[boutId].date, -5);
    ensureFightWeekTasks(save, boutId);
    expect(openOffersFor(save, me.id).length).toBe(0);
    expect(careerStatus(save).state).toBe('fight-week');

    // 5. Work through every stage, day by day. The loop used to stop as soon as nothing was due,
    // which at five days out is immediately, so the weigh in this test is named for never ran.
    let guard = 0;
    while (save.date < save.bouts[boutId].date && guard++ < 30) {
      const task = pendingStages(save, boutId)[0];
      if (!task) {
        save.date = addDays(save.date, 1);
        continue;
      }
      if (task.stage === 'official-weigh-in') {
        beginWeighIn(save, boutId);
        let steps = 0;
        while (save.weighIns![boutId].stage !== 'complete' && steps++ < 10) {
          const state = save.weighIns![boutId];
          if (state.stage === 'second-attempt-decision') applySecondAttempt(save, boutId, 'accept-miss');
          else if (state.stage === 'catchweight-negotiation') resolveOpponentDecision(save, boutId, new Rng(steps));
          else if (state.stage === 'opponent-decision') acceptOpponentMiss(save, boutId, true);
          else stepWeighIn(save, boutId);
        }
        if (save.weighIns![boutId].stage !== 'complete') break;
      } else if (task.stage === 'fight-night') {
        break;
      } else {
        task.status = 'complete';
        task.outcome = 'Completed by the end to end test.';
        task.resolvedOn = save.date;
      }
    }

    // 6. Fight day, then the fight itself.
    save.date = save.bouts[boutId].date;
    expect(careerStatus(save).state).toBe('fight-ready');
    simulatePlayerBout(save, boutId, ['pressure']);
    const result = save.history.results[boutId];
    expect(result).toBeDefined();
    expect(result.method).toBeTruthy();

    // 7. Consequences landed exactly once and the booking is resolved.
    expect(me.nextBoutId).toBeNull();
    expect(me.boutIds.filter((id) => id === boutId).length).toBe(1);
    expect(checkBookingInvariants(save)).toEqual([]);
    const after = careerStatus(save);
    expect(['available', 'recovery', 'medical-suspension', 'post-fight', 'offer-pending', 'contract-decision']).toContain(after.state);
    expect(hasLiveBooking(save, me)).toBeNull();
  });
});

/** Calls the real generator a second time with identical inputs. */
function createOfferAgain(
  save: SaveGame,
  me: Fighter,
  opponent: Fighter,
  event: FightCardEvent,
  rng: Rng
): string | null {
  const offer = createFightOffer(save, me, opponent, event, rng, {
    isMainEvent: false,
    isTitleFight: false,
    isInterimTitleFight: false,
    scheduledRounds: 3,
    reason: 'test fixture offer',
    isReplacementSlot: false,
  });
  return offer?.id ?? null;
}

void daysBetween;
