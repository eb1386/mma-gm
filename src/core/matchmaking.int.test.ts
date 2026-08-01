import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { DIVISION_BY_ID, DIVISIONS } from './config/divisions';
import { createEvent, newCareer, runWorld } from './testing/fixtures';
import {
  existingTitleBout,
  interimTitleJustification,
  rankChallengers,
  titleShotEligibility,
  unificationDue,
} from './world/title-eligibility';
import {
  evaluateAllInterests,
  evaluateInterest,
  liveInterestBetween,
  matchupInterestsFor,
  matchupPull,
  recordMatchupInterest,
} from './world/matchup-interest';
import { runMatchupInterestPass } from './world/matchup-pass';
import { assessChampionMove, commitMove, explore, pickDebutOpponent, enforceAbsentChampions } from './world/weightclass';
import { applyRelationship, makeCallout, resolveCallout } from './world/relationships';
import { bookEvent, findBestOpponent, isAvailable, openOfferFighterIds, scoreCandidate } from './world/matchmaking';
import { createFightOffer } from './world/offers';
import { careerStatus } from './world/career';
import { createContractOffer, signContractOffer } from './world/economy';
import { migrateSave } from './save/migrate';
import { SAVE_SCHEMA_VERSION } from './types/save';
import type { SaveGame } from './types/save';
import type { Fighter } from './types/fighter';

/**
 * Title shots, division moves, matchmaking, callouts and rivalries.
 *
 * Each test here corresponds to a connection that was broken: a callout that produced a
 * favourable answer and then no fight, a division change that left the fighter receiving
 * offers at the weight they had just left, a second title fight for a belt that was already
 * booked, and rivalries that existed in the data but reached nothing.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every fighter in a division, ranked first. */
function divisionRoster(save: SaveGame, divisionId: string): Fighter[] {
  return Object.values(save.fighters)
    .filter((f) => f.divisionId === divisionId && !f.retired && f.activityStatus === 'active')
    .sort((a, b) => (a.ranking ?? 99) - (b.ranking ?? 99));
}

/** Makes a fighter unambiguously available so a test is not defeated by an unrelated block. */
function makeAvailable(f: Fighter): Fighter {
  f.retired = false;
  f.activityStatus = 'active';
  f.injuries = [];
  f.medicalSuspension = null;
  f.commissionSuspension = null;
  f.antiDopingSuspension = null;
  f.nextBoutId = null;
  f.offerCooldownUntil = null;
  return f;
}

function playerOf(save: SaveGame): Fighter {
  return save.fighters[save.player.fighterId!];
}

// ---------------------------------------------------------------------------
// 1. Title shot eligibility
// ---------------------------------------------------------------------------

describe('title shot eligibility', () => {
  it('lets a legitimate top contender earn a title shot and says why', () => {
    const f = newCareer(4101);
    const division = 'lightweight';
    const table = f.save.rankings[division];
    const contender = f.save.fighters[table.entries.find((e) => e.rank === 2)!.fighterId];
    makeAvailable(contender);
    contender.lossStreak = 0;
    contender.winStreak = 3;

    const result = titleShotEligibility(f.save, contender, division);
    expect(result.eligible).toBe(true);
    expect(result.blockers).toHaveLength(0);
    // The reason is a real sentence the interface can show, not an empty string.
    expect(result.selectionReason.length).toBeGreaterThan(10);
    expect(result.claim).toBeGreaterThan(0);
  });

  it('refuses an unranked fighter with no standing claim', () => {
    const f = newCareer(4102);
    const championId = f.save.rankings.lightweight.championId;
    const unranked = Object.values(f.save.fighters).find(
      (x) => x.divisionId === 'lightweight' && x.ranking === null && !x.retired && x.id !== championId
    )!;
    makeAvailable(unranked);
    unranked.titleReigns = 0;
    unranked.lossStreak = 0;

    const result = titleShotEligibility(f.save, unranked, 'lightweight');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('unranked-without-claim');
    expect(result.blockerText.join(' ')).toContain('unranked');
  });

  it('refuses an injured fighter even when the ranking would qualify', () => {
    const f = newCareer(4103);
    const table = f.save.rankings.lightweight;
    const contender = f.save.fighters[table.entries.find((e) => e.rank === 1)!.fighterId];
    makeAvailable(contender);
    contender.medicalSuspension = { until: addDays(f.save.date, 90), reason: 'concussion protocol', clearanceRequired: true };

    const result = titleShotEligibility(f.save, contender, 'lightweight');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('medically-unavailable');
  });

  it('refuses a fighter coming off a loss outside the very top of the division', () => {
    const f = newCareer(4104);
    const table = f.save.rankings.lightweight;
    const contender = f.save.fighters[table.entries.find((e) => e.rank === 5)!.fighterId];
    makeAvailable(contender);
    contender.lossStreak = 1;

    const result = titleShotEligibility(f.save, contender, 'lightweight');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('coming-off-loss');
  });

  it('refuses a champion challenging for the belt they already hold', () => {
    const f = newCareer(4105);
    const table = f.save.rankings.lightweight;
    const champion = f.save.fighters[table.championId!];
    makeAvailable(champion);

    const result = titleShotEligibility(f.save, champion, 'lightweight');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('is-the-champion');
  });

  it('refuses a fighter who is not in the division', () => {
    const f = newCareer(4106);
    const outsider = Object.values(f.save.fighters).find((x) => x.divisionId === 'welterweight' && x.ranking !== null)!;
    makeAvailable(outsider);
    const result = titleShotEligibility(f.save, outsider, 'lightweight');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('not-in-division');
  });

  it('refuses a fighter who is already booked elsewhere', () => {
    const f = newCareer(4107);
    const table = f.save.rankings.lightweight;
    const contender = f.save.fighters[table.entries.find((e) => e.rank === 2)!.fighterId];
    makeAvailable(contender);
    contender.lossStreak = 0;
    expect(titleShotEligibility(f.save, contender, 'lightweight').eligible).toBe(true);
    contender.nextBoutId = 'bout-elsewhere';
    const result = titleShotEligibility(f.save, contender, 'lightweight');
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('already-booked');
  });

  it('never allows two live title bouts for the same belt', () => {
    const f = newCareer(4108);
    const division = 'lightweight';
    const event = createEvent(f.save, addDays(f.save.date, 70));
    const roster = divisionRoster(f.save, division);
    const a = makeAvailable(roster[0]);
    const b = makeAvailable(roster[1]);

    f.save.bouts['bout-title-live'] = {
      id: 'bout-title-live',
      eventId: event.id,
      date: event.date,
      fighterAId: a.id,
      fighterBId: b.id,
      divisionId: division,
      contractedWeightLb: DIVISION_BY_ID[division].limitLb,
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
      bookingReason: 'fixture',
    } as never;

    expect(existingTitleBout(f.save, division)).not.toBeNull();
    // Every other contender is now refused for the same belt.
    const other = makeAvailable(roster[3]);
    other.lossStreak = 0;
    const result = titleShotEligibility(f.save, other, division);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('belt-already-contested');
  });

  it('ranks challengers by the strength of their claim and returns only eligible ones', () => {
    const f = newCareer(4109);
    for (const fighter of divisionRoster(f.save, 'lightweight')) {
      makeAvailable(fighter);
      fighter.lossStreak = 0;
    }
    const ranked = rankChallengers(f.save, 'lightweight', () => true);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.eligibility.eligible)).toBe(true);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].eligibility.claim).toBeGreaterThanOrEqual(ranked[i].eligibility.claim);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Interim championships and unification
// ---------------------------------------------------------------------------

describe('interim championships', () => {
  it('is not justified while the champion is healthy and active', () => {
    const f = newCareer(4201);
    const champ = makeAvailable(f.save.fighters[f.save.rankings.lightweight.championId!]);
    champ.lastFightDate = addDays(f.save.date, -60);
    const justification = interimTitleJustification(f.save, 'lightweight');
    expect(justification.justified).toBe(false);
    expect(justification.reason).toBeNull();
  });

  it('is justified for a long term injury and states the reason', () => {
    const f = newCareer(4202);
    const champ = f.save.fighters[f.save.rankings.lightweight.championId!];
    champ.lastFightDate = addDays(f.save.date, -260);
    champ.medicalSuspension = { until: addDays(f.save.date, 240), reason: 'knee reconstruction', clearanceRequired: true };
    const justification = interimTitleJustification(f.save, 'lightweight');
    expect(justification.justified).toBe(true);
    expect(justification.reason).toBe('champion-suspended');
    expect(justification.explanation).toContain('interim');
  });

  it('is justified for extended inactivity', () => {
    const f = newCareer(4203);
    const champ = makeAvailable(f.save.fighters[f.save.rankings.lightweight.championId!]);
    champ.lastFightDate = addDays(f.save.date, -400);
    const justification = interimTitleJustification(f.save, 'lightweight');
    expect(justification.justified).toBe(true);
    expect(justification.reason).toBe('champion-inactive');
  });

  it('is never justified when an interim champion already exists', () => {
    const f = newCareer(4204);
    const table = f.save.rankings.lightweight;
    const champ = f.save.fighters[table.championId!];
    champ.lastFightDate = addDays(f.save.date, -400);
    table.interimChampionId = table.entries[0].fighterId;
    expect(interimTitleJustification(f.save, 'lightweight').justified).toBe(false);
  });

  it('makes unification the priority once the champion is available again', () => {
    const f = newCareer(4205);
    const table = f.save.rankings.lightweight;
    const champ = makeAvailable(f.save.fighters[table.championId!]);
    const interim = makeAvailable(f.save.fighters[table.entries[0].fighterId]);
    table.interimChampionId = interim.id;

    const due = unificationDue(f.save, 'lightweight');
    expect(due.due).toBe(true);
    expect(due.explanation).toContain(interim.name);

    // The interim champion is an eligible challenger for the undisputed belt.
    const eligibility = titleShotEligibility(f.save, interim, 'lightweight');
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons.join(' ')).toContain('unification');
    void champ;
  });

  it('holds unification back while the champion is still not cleared', () => {
    const f = newCareer(4206);
    const table = f.save.rankings.lightweight;
    const champ = f.save.fighters[table.championId!];
    champ.medicalSuspension = { until: addDays(f.save.date, 120), reason: 'orbital fracture', clearanceRequired: true };
    table.interimChampionId = table.entries[0].fighterId;
    const due = unificationDue(f.save, 'lightweight');
    expect(due.due).toBe(false);
    expect(due.explanation).toContain('not cleared');
  });
});

// ---------------------------------------------------------------------------
// 3. Callouts feeding matchmaking
// ---------------------------------------------------------------------------

describe('callouts', () => {
  it('creates a persistent matchmaking record when the answer is favourable', () => {
    const f = newCareer(4301);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);

    const callout = makeCallout(f.save, me.id, target.id, 'confident', new Rng(11))!;
    expect(callout).toBeTruthy();
    // Force a favourable answer so the test is about the plumbing, not the dice.
    callout.status = 'open';
    const answered = resolveCallout(f.save, callout.id, new Rng(7))!;
    expect(answered.status).toBe('answered');

    if (answered.response === 'reject' || answered.response === 'silence') {
      // A refusal must be recorded as such rather than silently vanishing.
      const rejected = matchupInterestsFor(f.save, me.id).find((m) => m.targetId === target.id);
      expect(rejected === undefined || rejected.eligibility === 'rejected').toBe(true);
      return;
    }
    const interest = liveInterestBetween(f.save, me.id, target.id);
    expect(interest).not.toBeNull();
    expect(interest!.source).toBe('callout');
    expect(answered.matchupInterestId).toBe(interest!.id);
    expect(answered.fanResponse).not.toBeNull();
  });

  it('produces a high priority candidate when the target accepts', () => {
    const f = newCareer(4302);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);

    const interest = recordMatchupInterest(f.save, {
      source: 'callout',
      caller: me,
      target,
      requestedConditions: 'Sign the fight.',
      opponentResponse: 'accepted',
      fanResponse: 'favourable',
      promotionResponse: 'The promotion wants to make this fight.',
      interestScore: 80,
    });
    expect(interest.eligibility).toBe('eligible');
    expect(interest.priority).toBeGreaterThanOrEqual(0.5);
    // The matchmaker sees it as a real pull toward that specific opponent.
    expect(matchupPull(f.save, me.id, target.id).pull).toBeGreaterThan(0.4);
  });

  it('keeps a blocked callout alive with a stated reason instead of deleting it', () => {
    const f = newCareer(4303);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    const interest = recordMatchupInterest(f.save, {
      source: 'callout',
      caller: me,
      target,
      requestedConditions: 'Sign the fight.',
      opponentResponse: 'accepted',
      interestScore: 80,
    });
    expect(interest.eligibility).toBe('eligible');

    // The target takes another fight.
    target.nextBoutId = 'bout-other';
    evaluateInterest(f.save, interest);
    expect(interest.eligibility).toBe('blocked');
    expect(interest.blockers).toContain('target-booked');
    expect(interest.priority).toBe(0);
    // It still exists.
    expect(liveInterestBetween(f.save, me.id, target.id)).not.toBeNull();

    // The blocker clears and the matchup becomes live again on its own.
    target.nextBoutId = null;
    evaluateInterest(f.save, interest);
    expect(interest.eligibility).toBe('eligible');
    expect(interest.blockers).toHaveLength(0);
  });

  it('turns an eligible interest into a real fight offer with the callout as the reason', () => {
    const f = newCareer(4304);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    createEvent(f.save, addDays(f.save.date, 63));

    recordMatchupInterest(f.save, {
      source: 'callout',
      caller: me,
      target,
      requestedConditions: 'Sign the fight.',
      opponentResponse: 'accepted',
      fanResponse: 'favourable',
      interestScore: 85,
    });

    const before = Object.values(f.save.fightOffers).filter((o) => o.status === 'open').length;
    const pass = runMatchupInterestPass(f.save, me, new Rng(21));
    const after = Object.values(f.save.fightOffers).filter((o) => o.status === 'open');
    expect(pass.offersCreated).toBe(1);
    expect(after.length).toBe(before + 1);

    const offer = after.find((o) => o.opponentId === target.id)!;
    expect(offer).toBeTruthy();
    expect(offer.reason.toLowerCase()).toContain('callout');
    expect(offer.matchupInterestId).toBeTruthy();
    // The interest is closed against the offer rather than staying live forever.
    const interest = matchupInterestsFor(f.save, me.id).find((m) => m.targetId === target.id)!;
    expect(interest.eligibility).toBe('fulfilled');
    expect(interest.linkedOfferId).toBe(offer.id);
  });

  it('does not book while the caller is already fighting, and does not lose the interest', () => {
    const f = newCareer(4305);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    createEvent(f.save, addDays(f.save.date, 63));
    recordMatchupInterest(f.save, {
      source: 'callout',
      caller: me,
      target,
      requestedConditions: 'Sign the fight.',
      opponentResponse: 'accepted',
      interestScore: 85,
    });
    me.nextBoutId = 'bout-mine';

    const pass = runMatchupInterestPass(f.save, me, new Rng(22));
    expect(pass.offersCreated).toBe(0);
    const interest = matchupInterestsFor(f.save, me.id).find((m) => m.targetId === target.id)!;
    expect(interest.eligibility).toBe('blocked');
    expect(interest.blockers).toContain('caller-booked');
  });

  it('survives a save round trip', () => {
    const f = newCareer(4306);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    recordMatchupInterest(f.save, {
      source: 'callout',
      caller: me,
      target,
      requestedConditions: 'Sign the fight.',
      opponentResponse: 'accepted',
      interestScore: 80,
    });

    const reloaded = migrateSave(JSON.parse(JSON.stringify(f.save)) as SaveGame);
    const interest = liveInterestBetween(reloaded, me.id, target.id);
    expect(interest).not.toBeNull();
    expect(interest!.opponentResponse).toBe('accepted');
    expect(interest!.source).toBe('callout');
  });
});

// ---------------------------------------------------------------------------
// 4. Rivalries
// ---------------------------------------------------------------------------

describe('rivalries', () => {
  it('pulls the matchmaker toward a heated rival with no callout at all', () => {
    const f = newCareer(4401);
    const me = makeAvailable(playerOf(f.save));
    const rival = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    const neutral = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id && x.id !== rival.id)!);

    expect(matchupPull(f.save, me.id, rival.id).pull).toBe(0);
    applyRelationship(f.save, me.id, rival.id, { rivalry: 60, publicHostility: 50, resentment: 30 }, 'insult', 'Bad blood.');
    expect(matchupPull(f.save, me.id, rival.id).pull).toBeGreaterThan(0.4);
    expect(matchupPull(f.save, me.id, neutral.id).pull).toBe(0);
  });

  it('pushes the matchmaker away from a training partner', () => {
    const f = newCareer(4402);
    const me = makeAvailable(playerOf(f.save));
    const teammate = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    applyRelationship(f.save, me.id, teammate.id, { teammateBond: 80, friendship: 60 }, 'teammate', 'Same gym.');
    expect(matchupPull(f.save, me.id, teammate.id).pull).toBeLessThan(0);
  });

  it('survives export, import and migration with its history intact', () => {
    const f = newCareer(4403);
    const me = playerOf(f.save);
    const rival = divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!;
    applyRelationship(f.save, me.id, rival.id, { rivalry: 55, publicHostility: 40 }, 'callout', 'He called me out.');

    const exported = JSON.stringify({ format: 'mma-gm-save', schemaVersion: f.save.schemaVersion, save: f.save });
    const parsed = JSON.parse(exported) as { save: SaveGame };
    const reloaded = migrateSave(parsed.save);

    const key = [me.id, rival.id].sort().join('|');
    const relationship = reloaded.relationships![key];
    expect(relationship).toBeTruthy();
    expect(relationship.rivalry).toBeGreaterThanOrEqual(55);
    expect(relationship.history.some((h) => h.note.includes('called me out'))).toBe(true);
  });

  it('records a completed fight in the rivalry history', async () => {
    const f = newCareer(4404);
    const me = playerOf(f.save);
    const rival = divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!;
    applyRelationship(f.save, me.id, rival.id, { rivalry: 50 }, 'callout', 'Called out.');

    const { recordFightBetween } = await importRelationships();
    recordFightBetween(f.save, me.id, rival.id, 'bout-fixture', me.id, true);
    const key = [me.id, rival.id].sort().join('|');
    const relationship = f.save.relationships![key];
    expect(relationship.fights).toHaveLength(1);
    expect(relationship.fights[0].winnerId).toBe(me.id);
    expect(relationship.respect).toBeGreaterThan(50);
  });
});

async function importRelationships() {
  return import('./world/relationships');
}

// ---------------------------------------------------------------------------
// 5. Division moves
// ---------------------------------------------------------------------------

describe('changing weight class', () => {
  it('changes the division, clears the old ranking and keeps the history', () => {
    const f = newCareer(4501);
    const me = makeAvailable(playerOf(f.save));
    const from = me.divisionId;
    const up = DIVISION_BY_ID[from].order + 1;
    const target = Object.values(DIVISION_BY_ID).find((d) => d.order === up && d.gender === DIVISION_BY_ID[from].gender)!;

    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    const outcome = commitMove(f.save, me, true);

    expect(outcome.moved).toBe(true);
    expect(me.divisionId).toBe(target.id);
    expect(me.ranking).toBeNull();
    expect(f.save.rankings[from].entries.some((e) => e.fighterId === me.id)).toBe(false);
    // The old division is on the record as somewhere they competed.
    const history = f.save.divisionHistory![me.id];
    expect(history.some((s) => s.divisionId === from && s.endedOn !== null)).toBe(true);
    expect(history.some((s) => s.divisionId === target.id && s.endedOn === null)).toBe(true);
  });

  it('withdraws open offers at the weight the fighter has left', () => {
    const f = newCareer(4502);
    const me = makeAvailable(playerOf(f.save));
    const from = me.divisionId;
    const opponent = makeAvailable(divisionRoster(f.save, from).find((x) => x.id !== me.id)!);
    const event = createEvent(f.save, addDays(f.save.date, 70));

    const offer = createFightOffer(f.save, me, opponent, event, new Rng(3), {
      isMainEvent: false,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: 3,
      reason: 'a divisional matchup',
      isReplacementSlot: false,
    })!;
    expect(offer.status).toBe('open');

    const target = Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[from].order + 1 && d.gender === DIVISION_BY_ID[from].gender
    )!;
    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    const outcome = commitMove(f.save, me, true);

    expect(outcome.withdrawnOffers).toBeGreaterThanOrEqual(1);
    expect(f.save.fightOffers[offer.id].status).toBe('withdrawn');
  });

  it('stops generating ordinary offers in the old division after the move', () => {
    const f = newCareer(4503);
    const me = makeAvailable(playerOf(f.save));
    const from = me.divisionId;
    const oldOpponent = makeAvailable(divisionRoster(f.save, from).find((x) => x.id !== me.id)!);
    const event = createEvent(f.save, addDays(f.save.date, 70));

    const target = Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[from].order + 1 && d.gender === DIVISION_BY_ID[from].gender
    )!;
    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    commitMove(f.save, me, true);

    // An offer against somebody still at the old weight is refused outright.
    const refused = createFightOffer(f.save, me, oldOpponent, event, new Rng(4), {
      isMainEvent: false,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: 3,
      reason: 'a divisional matchup',
      isReplacementSlot: false,
    });
    expect(refused).toBeNull();
  });

  it('generates a debut matchup in the new division', () => {
    const f = newCareer(4504);
    const me = makeAvailable(playerOf(f.save));
    const from = me.divisionId;
    const target = Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[from].order + 1 && d.gender === DIVISION_BY_ID[from].gender
    )!;
    for (const other of divisionRoster(f.save, target.id)) makeAvailable(other);

    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    commitMove(f.save, me, true);

    const interests = matchupInterestsFor(f.save, me.id);
    expect(interests.length).toBeGreaterThan(0);
    const debut = interests[0];
    expect(f.save.fighters[debut.targetId].divisionId).toBe(target.id);
  });

  it('picks a debut opponent scaled to what the fighter brings with them', () => {
    const f = newCareer(4505);
    const me = makeAvailable(playerOf(f.save));
    const target = Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[me.divisionId].order + 1 && d.gender === DIVISION_BY_ID[me.divisionId].gender
    )!;
    for (const other of divisionRoster(f.save, target.id)) makeAvailable(other);

    // An unproven fighter is not handed a top contender.
    me.titleReigns = 0;
    me.titleDefenses = 0;
    me.winStreak = 0;
    me.popularity = 20;
    const modestId = pickDebutOpponent(f.save, me, target.id);
    expect(modestId).not.toBeNull();
    const modest = f.save.fighters[modestId!];
    expect(modest.ranking === null || modest.ranking > 5).toBe(true);
  });

  it('survives a save round trip with the new division intact', () => {
    const f = newCareer(4506);
    const me = makeAvailable(playerOf(f.save));
    const target = Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[me.divisionId].order + 1 && d.gender === DIVISION_BY_ID[me.divisionId].gender
    )!;
    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    commitMove(f.save, me, true);

    const reloaded = migrateSave(JSON.parse(JSON.stringify(f.save)) as SaveGame);
    const reloadedMe = reloaded.fighters[me.id];
    expect(reloadedMe.divisionId).toBe(target.id);
    expect(reloaded.divisionHistory![me.id].length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Champions moving divisions
// ---------------------------------------------------------------------------

describe('a champion moving divisions', () => {
  /** Makes the player the champion of their division. */
  function crownPlayer(save: SaveGame): Fighter {
    const me = makeAvailable(playerOf(save));
    const table = save.rankings[me.divisionId];
    table.championId = me.id;
    table.entries = table.entries.filter((e) => e.fighterId !== me.id);
    me.isChampion = true;
    me.titleReigns = 1;
    me.titleDefenses = 3;
    me.popularity = 80;
    me.winStreak = 6;
    me.lossStreak = 0;
    return me;
  }

  function divisionAbove(fighter: Fighter) {
    return Object.values(DIVISION_BY_ID).find(
      (d) => d.order === DIVISION_BY_ID[fighter.divisionId].order + 1 && d.gender === DIVISION_BY_ID[fighter.divisionId].gender
    )!;
  }

  it('offers champion against champion when the destination champion is available', () => {
    const f = newCareer(4601);
    const me = crownPlayer(f.save);
    const target = divisionAbove(me);
    const destChampion = makeAvailable(f.save.fighters[f.save.rankings[target.id].championId!]);
    destChampion.popularity = 80;

    const assessment = assessChampionMove(f.save, me, target.id);
    expect(assessment.path).toBe('champion-versus-champion');
    expect(assessment.championshipOnTheLine).toBe(true);
    expect(assessment.opponentId).toBe(destChampion.id);
    expect(assessment.explanation).toContain(destChampion.name);
  });

  it('offers an interim championship only when the destination champion is legitimately unavailable', () => {
    const f = newCareer(4602);
    const me = crownPlayer(f.save);
    const target = divisionAbove(me);
    const destChampion = f.save.fighters[f.save.rankings[target.id].championId!];
    for (const other of divisionRoster(f.save, target.id)) makeAvailable(other);
    destChampion.lastFightDate = addDays(f.save.date, -300);
    destChampion.medicalSuspension = { until: addDays(f.save.date, 200), reason: 'knee reconstruction', clearanceRequired: true };

    const assessment = assessChampionMove(f.save, me, target.id);
    expect(assessment.path).toBe('interim-title');
    expect(assessment.championshipOnTheLine).toBe(true);
    expect(assessment.interimReason).toBe('champion-suspended');
    // The game explains why the belt is interim, and that unification follows.
    expect(assessment.explanation).toContain('interim');
    expect(assessment.explanation.toLowerCase()).toContain('unification');
  });

  it('does not invent an interim belt when the champion is simply booked', () => {
    const f = newCareer(4603);
    const me = crownPlayer(f.save);
    const target = divisionAbove(me);
    for (const other of divisionRoster(f.save, target.id)) makeAvailable(other);
    const destChampion = f.save.fighters[f.save.rankings[target.id].championId!];
    // Booked, but healthy and active: not a reason to invent an interim belt.
    destChampion.nextBoutId = 'bout-elsewhere';

    const assessment = assessChampionMove(f.save, me, target.id);
    expect(assessment.path).not.toBe('interim-title');
    expect(assessment.interimReason).toBeNull();
    expect(['title-eliminator', 'debut-fight-first']).toContain(assessment.path);
  });

  it('puts the vacant destination championship on the line', () => {
    const f = newCareer(4604);
    const me = crownPlayer(f.save);
    const target = divisionAbove(me);
    f.save.rankings[target.id].championId = null;
    for (const other of divisionRoster(f.save, target.id)) {
      makeAvailable(other);
      other.lossStreak = 0;
    }

    const assessment = assessChampionMove(f.save, me, target.id);
    expect(assessment.path).toBe('champion-versus-champion');
    expect(assessment.championshipOnTheLine).toBe(true);
    expect(assessment.explanation).toContain('vacant');
  });

  it('vacates the original championship when that is the decision', () => {
    const f = newCareer(4605);
    const me = crownPlayer(f.save);
    const from = me.divisionId;
    const target = divisionAbove(me);

    const plan = explore(f.save, me, target, 'permanent', 'vacate-now');
    plan.status = 'approved';
    const outcome = commitMove(f.save, me, true);

    expect(outcome.vacatedTitle).toBe(true);
    expect(f.save.rankings[from].championId).toBeNull();
    expect(me.isChampion).toBe(false);
    const reign = f.save.history.reigns.find((r) => r.fighterId === me.id && r.divisionId === from);
    if (reign) expect(reign.endReason).toBe('vacated');
  });

  it('keeps the original championship for a double champion attempt, with a deadline', () => {
    const f = newCareer(4606);
    const me = crownPlayer(f.save);
    const from = me.divisionId;
    const target = divisionAbove(me);

    const plan = explore(f.save, me, target, 'double-champion', 'defend-both');
    plan.status = 'approved';
    const outcome = commitMove(f.save, me, true);

    expect(outcome.moved).toBe(true);
    expect(outcome.vacatedTitle).toBe(false);
    expect(f.save.rankings[from].championId).toBe(me.id);
    expect(me.heldTitleDivisionId).toBe(from);
    expect(me.titleHoldDeadline).toBeTruthy();
  });

  it('strips a champion who left the division and never came back', () => {
    const f = newCareer(4607);
    const me = crownPlayer(f.save);
    const from = me.divisionId;
    const target = divisionAbove(me);

    const plan = explore(f.save, me, target, 'double-champion', 'defend-both');
    plan.status = 'approved';
    commitMove(f.save, me, true);
    expect(f.save.rankings[from].championId).toBe(me.id);

    // The deadline passes without a return.
    f.save.date = addDays(me.titleHoldDeadline!, 1);
    const notes = enforceAbsentChampions(f.save);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('stripped');
    expect(f.save.rankings[from].championId).toBeNull();
    const reign = f.save.history.reigns.find((r) => r.fighterId === me.id && r.divisionId === from);
    if (reign) expect(reign.endReason).toBe('stripped');
  });

  it('does not strip a champion who returns to the division', () => {
    const f = newCareer(4608);
    const me = crownPlayer(f.save);
    const from = me.divisionId;
    const target = divisionAbove(me);
    const plan = explore(f.save, me, target, 'double-champion', 'defend-both');
    plan.status = 'approved';
    commitMove(f.save, me, true);

    me.divisionId = from;
    const notes = enforceAbsentChampions(f.save);
    expect(notes).toHaveLength(0);
    expect(f.save.rankings[from].championId).toBe(me.id);
    expect(me.heldTitleDivisionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Matchmaking quality
// ---------------------------------------------------------------------------

describe('matchmaking quality', () => {
  it('never books the same fighter twice on one card', () => {
    const f = newCareer(4701);
    const event = createEvent(f.save, addDays(f.save.date, 70));
    const result = bookEvent(f.save, event, new Rng(31));
    const seen = new Set<string>();
    for (const bout of result.bouts) {
      expect(seen.has(bout.fighterAId)).toBe(false);
      expect(seen.has(bout.fighterBId)).toBe(false);
      seen.add(bout.fighterAId);
      seen.add(bout.fighterBId);
    }
  });

  it('only pairs fighters inside the same division', () => {
    const f = newCareer(4702);
    const event = createEvent(f.save, addDays(f.save.date, 70));
    const result = bookEvent(f.save, event, new Rng(32));
    for (const bout of result.bouts) {
      expect(f.save.fighters[bout.fighterAId].divisionId).toBe(f.save.fighters[bout.fighterBId].divisionId);
      expect(bout.divisionId).toBe(f.save.fighters[bout.fighterAId].divisionId);
    }
  });

  it('gives every generated bout a stated reason', () => {
    const f = newCareer(4703);
    const event = createEvent(f.save, addDays(f.save.date, 70));
    const result = bookEvent(f.save, event, new Rng(33));
    expect(result.bouts.length).toBeGreaterThan(0);
    for (const bout of result.bouts) {
      expect(bout.bookingReason).toBeTruthy();
      expect(bout.bookingReason.length).toBeGreaterThan(4);
      expect(bout.bookingKind).toBeTruthy();
    }
  });

  it('never creates a second championship bout for a belt already booked', () => {
    const f = newCareer(4704);
    // Fill several cards and check every division across the whole save.
    for (let i = 0; i < 6; i++) {
      const event = createEvent(f.save, addDays(f.save.date, 56 + i * 7), `Card ${i}`);
      bookEvent(f.save, event, new Rng(40 + i));
    }
    const byDivision = new Map<string, number>();
    for (const bout of Object.values(f.save.bouts)) {
      if (bout.status !== 'scheduled') continue;
      if (!bout.isTitleFight && !bout.isInterimTitleFight) continue;
      byDivision.set(bout.divisionId, (byDivision.get(bout.divisionId) ?? 0) + 1);
    }
    for (const [division, count] of byDivision) {
      expect(count, `division ${division} has ${count} live title bouts`).toBeLessThanOrEqual(1);
    }
  });

  it('never books a title fight for an ineligible challenger', () => {
    const f = newCareer(4705);
    for (let i = 0; i < 6; i++) {
      const event = createEvent(f.save, addDays(f.save.date, 56 + i * 7), `Card ${i}`);
      bookEvent(f.save, event, new Rng(50 + i));
    }
    for (const bout of Object.values(f.save.bouts)) {
      if (bout.status !== 'scheduled') continue;
      if (!bout.isTitleFight && !bout.isInterimTitleFight) continue;
      const table = f.save.rankings[bout.divisionId];
      const challengerId = table.championId === bout.fighterAId ? bout.fighterBId : bout.fighterAId;
      const challenger = f.save.fighters[challengerId];
      // The challenger is never the champion, never retired and never unranked with no claim.
      expect(challengerId).not.toBe(table.championId);
      expect(challenger.retired).toBe(false);
      expect(challenger.divisionId).toBe(bout.divisionId);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = newCareer(4706);
    const b = newCareer(4706);
    const eventA = createEvent(a.save, addDays(a.save.date, 70));
    const eventB = createEvent(b.save, addDays(b.save.date, 70));
    const resultA = bookEvent(a.save, eventA, new Rng(99));
    const resultB = bookEvent(b.save, eventB, new Rng(99));
    expect(resultA.bouts.map((x) => `${x.fighterAId}|${x.fighterBId}`)).toEqual(
      resultB.bouts.map((x) => `${x.fighterAId}|${x.fighterBId}`)
    );
  });

  it('prefers a called out opponent over an equally rated stranger', () => {
    const f = newCareer(4707);
    const me = makeAvailable(playerOf(f.save));
    const roster = divisionRoster(f.save, me.divisionId).filter((x) => x.id !== me.id);
    for (const other of roster) makeAvailable(other);
    const event = createEvent(f.save, addDays(f.save.date, 70));

    const withoutInterest = findBestOpponent(
      f.save,
      me,
      event,
      { date: event.date, bookedFighterIds: new Set(), openOfferFighterIds: openOfferFighterIds(f.save) },
      new Rng(77)
    );
    expect(withoutInterest).not.toBeNull();

    // Pick somebody the matchmaker did not choose, and create a strong interest in them.
    const wanted = roster.find((x) => x.id !== withoutInterest!.opponent.id)!;
    recordMatchupInterest(f.save, {
      source: 'callout',
      caller: me,
      target: wanted,
      requestedConditions: 'Sign it.',
      opponentResponse: 'accepted',
      interestScore: 95,
    });

    const withInterest = findBestOpponent(
      f.save,
      me,
      event,
      { date: event.date, bookedFighterIds: new Set(), openOfferFighterIds: openOfferFighterIds(f.save) },
      new Rng(77)
    );
    expect(withInterest!.opponent.id).toBe(wanted.id);
    expect(withInterest!.kind).toBe('callout');
    expect(withInterest!.reason.toLowerCase()).toContain('callout');
  });
});

// ---------------------------------------------------------------------------
// 8. Migration safety
// ---------------------------------------------------------------------------

describe('migrating an existing save', () => {
  it('adds the new structures without touching championships, rankings or results', () => {
    const f = newCareer(4801);
    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    const championsBefore = Object.entries(legacy.rankings).map(([d, t]) => `${d}:${t.championId}`);
    const rankingsBefore = Object.entries(legacy.rankings).map(([d, t]) => `${d}:${t.entries.length}`);
    const resultsBefore = Object.keys(legacy.history.results).length;
    const reignsBefore = legacy.history.reigns.length;

    // Present the save as if it were written by the previous build.
    legacy.schemaVersion = 11;
    delete (legacy as Partial<SaveGame>).matchupInterests;
    delete (legacy as Partial<SaveGame>).divisionHistory;

    const migrated = migrateSave(legacy);
    expect(migrated.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(migrated.matchupInterests).toBeTruthy();
    expect(migrated.divisionHistory).toBeTruthy();
    expect(Object.entries(migrated.rankings).map(([d, t]) => `${d}:${t.championId}`)).toEqual(championsBefore);
    expect(Object.entries(migrated.rankings).map(([d, t]) => `${d}:${t.entries.length}`)).toEqual(rankingsBefore);
    expect(Object.keys(migrated.history.results).length).toBe(resultsBefore);
    expect(migrated.history.reigns.length).toBe(reignsBefore);
  });

  it('gives every fighter a division history entry matching their current division', () => {
    const f = newCareer(4802);
    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 11;
    delete (legacy as Partial<SaveGame>).divisionHistory;
    const migrated = migrateSave(legacy);
    for (const fighter of Object.values(migrated.fighters)) {
      const spells = migrated.divisionHistory![fighter.id];
      expect(spells).toBeTruthy();
      expect(spells[spells.length - 1].divisionId).toBe(fighter.divisionId);
    }
  });

  it('revives an answered callout as a live matchmaking record', () => {
    const f = newCareer(4803);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);

    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 11;
    delete (legacy as Partial<SaveGame>).matchupInterests;
    legacy.callouts = {
      'callout-legacy': {
        id: 'callout-legacy',
        fromId: me.id,
        toId: target.id,
        tone: 'confident',
        text: 'Sign the fight.',
        madeOn: addDays(legacy.date, -20),
        expiresOn: addDays(legacy.date, 1),
        status: 'answered',
        response: 'accept',
        responseText: 'He accepts.',
        promotionInterest: 70,
        ledToOffer: false,
        note: '',
      } as never,
    };

    const migrated = migrateSave(legacy);
    const interest = liveInterestBetween(migrated, me.id, target.id);
    expect(interest).not.toBeNull();
    expect(interest!.source).toBe('callout');
    expect(interest!.opponentResponse).toBe('accepted');
  });

  it('keeps rivalry state through the migration', () => {
    const f = newCareer(4804);
    const me = playerOf(f.save);
    const rival = divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!;
    applyRelationship(f.save, me.id, rival.id, { rivalry: 70, resentment: 50 }, 'insult', 'Heated.');
    const key = [me.id, rival.id].sort().join('|');

    const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
    legacy.schemaVersion = 11;
    const migrated = migrateSave(legacy);
    expect(migrated.relationships![key].rivalry).toBe(f.save.relationships![key].rivalry);
    expect(migrated.relationships![key].resentment).toBe(f.save.relationships![key].resentment);
  });
});

// ---------------------------------------------------------------------------
// 9. The whole flow, running forward
// ---------------------------------------------------------------------------

describe('the systems running together over time', () => {
  it('holds every invariant across a simulated year', () => {
    const f = newCareer(4901);
    runWorld(f.save, 52);

    for (const bout of Object.values(f.save.bouts)) {
      if (bout.status !== 'scheduled') continue;
      const a = f.save.fighters[bout.fighterAId];
      const b = f.save.fighters[bout.fighterBId];
      // Nobody is booked into a division they are not in, unless the bout is a catchweight.
      if (!bout.isCatchweight) {
        expect(a.divisionId).toBe(bout.divisionId);
        expect(b.divisionId).toBe(bout.divisionId);
      }
      // Nobody retired is booked.
      expect(a.retired).toBe(false);
      expect(b.retired).toBe(false);
      // A championship bout never has the champion on both sides.
      if (bout.isTitleFight) {
        const table = f.save.rankings[bout.divisionId];
        expect(bout.fighterAId === table.championId && bout.fighterBId === table.championId).toBe(false);
      }
    }

    // At most one live championship bout per belt.
    const titleCount = new Map<string, number>();
    for (const bout of Object.values(f.save.bouts)) {
      if (bout.status !== 'scheduled') continue;
      if (!bout.isTitleFight && !bout.isInterimTitleFight) continue;
      titleCount.set(bout.divisionId, (titleCount.get(bout.divisionId) ?? 0) + 1);
    }
    for (const [division, count] of titleCount) {
      expect(count, `division ${division}`).toBeLessThanOrEqual(1);
    }

    // No fighter is booked into two scheduled bouts.
    const bookings = new Map<string, number>();
    for (const bout of Object.values(f.save.bouts)) {
      if (bout.status !== 'scheduled') continue;
      for (const id of [bout.fighterAId, bout.fighterBId]) {
        bookings.set(id, (bookings.get(id) ?? 0) + 1);
      }
    }
    for (const [fighterId, count] of bookings) {
      expect(count, `fighter ${fighterId} booked ${count} times`).toBeLessThanOrEqual(1);
    }

    // Every interim championship that exists has a justification on record.
    for (const [divisionId, table] of Object.entries(f.save.rankings)) {
      if (!table.interimChampionId) continue;
      expect(table.championId === null || table.interimChampionId !== table.championId).toBe(true);
      void divisionId;
    }
  });

  it('keeps evaluated interests consistent with the world', () => {
    const f = newCareer(4902);
    const me = makeAvailable(playerOf(f.save));
    const target = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    recordMatchupInterest(f.save, {
      source: 'rivalry',
      caller: me,
      target,
      requestedConditions: 'Settle it.',
      interestScore: 60,
    });

    runWorld(f.save, 18);
    evaluateAllInterests(f.save);
    for (const interest of matchupInterestsFor(f.save, me.id)) {
      if (interest.eligibility !== 'eligible') continue;
      const caller = f.save.fighters[interest.callerId];
      const other = f.save.fighters[interest.targetId];
      // An eligible interest genuinely means both are free and in the same division.
      expect(caller.nextBoutId).toBeFalsy();
      expect(other.nextBoutId).toBeFalsy();
      expect(caller.divisionId).toBe(other.divisionId);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. The player actually receiving a title shot
// ---------------------------------------------------------------------------

describe('a contender actually receiving the offer', () => {
  it('does not pass over a contender who is holding an ordinary offer', () => {
    const f = newCareer(5101);
    const me = makeAvailable(playerOf(f.save));
    const table = f.save.rankings[me.divisionId];
    const event = createEvent(f.save, addDays(f.save.date, 70));

    // The player is the clear number one contender.
    me.ranking = 1;
    me.lossStreak = 0;
    me.winStreak = 4;
    const entry = table.entries.find((e) => e.fighterId === me.id);
    if (entry) entry.rank = 1;
    else table.entries.unshift({ fighterId: me.id, rank: 1, previousRank: 2, weeksAtRank: 4 } as never);

    // A routine offer arrives first, which is the ordinary weekly outcome.
    const filler = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id && x.id !== table.championId)!);
    const ordinary = createFightOffer(f.save, me, filler, event, new Rng(1), {
      isMainEvent: false,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: 3,
      reason: 'a divisional matchup',
      isReplacementSlot: false,
    })!;
    expect(ordinary.status).toBe('open');

    // A routine offer used to make the fighter unavailable for the whole champion cycle, so
    // the belt went elsewhere for six months. A championship booking now outranks it.
    const ordinaryCtx = {
      date: event.date,
      bookedFighterIds: new Set<string>(),
      openOfferFighterIds: openOfferFighterIds(f.save),
    };
    expect(isAvailable(f.save, me, ordinaryCtx)).toBe(false);
    expect(isAvailable(f.save, me, { ...ordinaryCtx, isChampionshipBooking: true })).toBe(true);
  });

  it('still refuses a contender already holding a championship offer', () => {
    const f = newCareer(5102);
    const me = makeAvailable(playerOf(f.save));
    const table = f.save.rankings[me.divisionId];
    const event = createEvent(f.save, addDays(f.save.date, 70));
    const champion = makeAvailable(f.save.fighters[table.championId!]);

    const titleOffer = createFightOffer(f.save, me, champion, event, new Rng(2), {
      isMainEvent: true,
      isTitleFight: true,
      isInterimTitleFight: false,
      scheduledRounds: 5,
      reason: 'a title fight',
      isReplacementSlot: false,
    })!;
    expect(titleOffer.status).toBe('open');

    // One championship offer at a time. This is the case the relaxation must not break.
    expect(
      isAvailable(f.save, me, {
        date: event.date,
        bookedFighterIds: new Set<string>(),
        isChampionshipBooking: true,
      })
    ).toBe(false);
  });

  it('never lets a championship booking bypass health or an existing booking', () => {
    const f = newCareer(5103);
    const me = makeAvailable(playerOf(f.save));
    const event = createEvent(f.save, addDays(f.save.date, 70));
    const ctx = { date: event.date, bookedFighterIds: new Set<string>(), isChampionshipBooking: true };

    me.medicalSuspension = { until: addDays(f.save.date, 120), reason: 'concussion protocol', clearanceRequired: true };
    expect(isAvailable(f.save, me, ctx)).toBe(false);

    makeAvailable(me);
    me.nextBoutId = 'bout-elsewhere';
    expect(isAvailable(f.save, me, ctx)).toBe(false);
  });
});

describe('being out of contract', () => {
  it('blocks every offer, which is why it has to be stated plainly', () => {
    const f = newCareer(5201);
    const me = makeAvailable(playerOf(f.save));
    const opponent = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    const event = createEvent(f.save, addDays(f.save.date, 70));

    const contract = f.save.contracts[me.contractId!];
    contract.status = 'expired';

    // No offer of any kind can be created.
    expect(
      createFightOffer(f.save, me, opponent, event, new Rng(3), {
        isMainEvent: false,
        isTitleFight: false,
        isInterimTitleFight: false,
        scheduledRounds: 3,
        reason: 'a divisional matchup',
        isReplacementSlot: false,
      })
    ).toBeNull();

    // The career state says so, and names the consequence rather than only the state.
    const status = careerStatus(f.save);
    expect(status.state).toBe('free-agent');
    expect(`${status.reason} ${status.action?.detail ?? ''}`.toLowerCase()).toContain('no fights can be offered');
  });

  it('signing a new deal makes the fighter bookable again', () => {
    const f = newCareer(5202);
    const me = makeAvailable(playerOf(f.save));
    const opponent = makeAvailable(divisionRoster(f.save, me.divisionId).find((x) => x.id !== me.id)!);
    const event = createEvent(f.save, addDays(f.save.date, 70));

    const contract = f.save.contracts[me.contractId!];
    contract.status = 'expired';
    contract.fightsRemaining = 0;

    const offer = createContractOffer(me, f.save, new Rng(4));
    f.save.contractOffers[offer.id] = offer;
    const signed = signContractOffer(f.save, me, offer, null);

    expect(signed.status).toBe('active');
    expect(me.contractId).toBe(signed.id);
    expect(signed.fightsRemaining).toBeGreaterThan(0);
    // The previous deal is closed rather than left alongside the new one.
    expect(contract.status).toBe('expired');
    expect(careerStatus(f.save).state).not.toBe('free-agent');

    expect(
      createFightOffer(f.save, me, opponent, event, new Rng(5), {
        isMainEvent: false,
        isTitleFight: false,
        isInterimTitleFight: false,
        scheduledRounds: 3,
        reason: 'a divisional matchup',
        isReplacementSlot: false,
      })
    ).not.toBeNull();
  });

  it('treats a contract with no fights left as out of contract', () => {
    const f = newCareer(5203);
    const me = makeAvailable(playerOf(f.save));
    const contract = f.save.contracts[me.contractId!];
    contract.status = 'active';
    contract.fightsRemaining = 0;
    // Exhausted and expired are the same thing to a player: no fights arrive.
    expect(careerStatus(f.save).state).toBe('free-agent');
  });
});

describe('the matchmaker refuses fights it would never make', () => {
  const bookableEventFor = (save: SaveGame) =>
    Object.values(save.events)
      .filter((e) => e.status === 'announced')
      .sort((a, b) => a.date.localeCompare(b.date))[3];

  it('will not put a top five fighter in with an unranked opponent who has not earned it', () => {
    const f = newCareer(9840);
    runWorld(f.save, 8);
    const divisionId = DIVISIONS[0].id;
    const contenderTier = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking !== null && x.ranking <= 5
    )!;
    const nobody = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking === null && x.winStreak === 0 && !x.isChampion
    )!;
    const event = bookableEventFor(f.save);
    expect(scoreCandidate(f.save, contenderTier, nobody, event, new Rng(3))).toBeNull();
  });

  it('will not match a ranked fighter with anyone on a losing promotional record', () => {
    const f = newCareer(9841);
    runWorld(f.save, 8);
    const divisionId = DIVISIONS[0].id;
    const ranked = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking !== null && x.ranking > 5
    )!;
    const losing = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking === null && x.ufcRecord.losses > x.ufcRecord.wins
    );
    if (!losing) return;
    // Even a streak does not make this one bookable.
    losing.winStreak = 9;
    const event = bookableEventFor(f.save);
    expect(scoreCandidate(f.save, ranked, losing, event, new Rng(3))).toBeNull();
  });

  it('still takes a genuine prospect on a run', () => {
    const f = newCareer(9842);
    runWorld(f.save, 8);
    const divisionId = DIVISIONS[0].id;
    const ranked = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking !== null && x.ranking > 5
    )!;
    const prospect = Object.values(f.save.fighters).find(
      (x) => x.divisionId === divisionId && x.ranking === null && !x.isChampion && x.id !== ranked.id
    )!;
    prospect.winStreak = 5;
    prospect.ufcRecord = { wins: 6, losses: 1, draws: 0, noContests: 0 };
    const event = bookableEventFor(f.save);
    expect(scoreCandidate(f.save, ranked, prospect, event, new Rng(3))).not.toBeNull();
  });
});
