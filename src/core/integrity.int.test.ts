import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import { bookedCareer, newCareer, runWorld } from './testing/fixtures';
import { runGymMonth } from './world/gyms';
import { simulatePlayerBout } from './world/tick';
import { createCamp, finalizeCamp, CAMP_FORM_BASELINE, estimateCampCost } from './world/camp';
import { performSocialAction, socialActionAllowance, SOCIAL_ACTIONS_PER_WEEK, decaySocial, recordSocialHistory } from './world/identity';
import { rememberPlan, recallPlan } from './world/gameplan-memory';
import { migrateSave } from './save/migrate';
import { SAVE_SCHEMA_VERSION } from './types/save';
import type { SaveGame } from './types/save';
import type { Fighter } from './types/fighter';

/**
 * Integrity of the systems that were declared but not connected.
 *
 * Each of these covers a case where a value was written and never read, an action had no cost, or
 * a control could be repeated for unlimited benefit.
 */

function playerOf(save: SaveGame): Fighter {
  return save.fighters[save.player.fighterId!];
}

describe('the gym month can only be settled once', () => {
  it('refuses a second settlement in the same month', () => {
    const f = newCareer(9101);
    const gym = Object.values(f.save.gyms)[0];
    const first = runGymMonth(f.save, gym);
    const second = runGymMonth(f.save, gym);
    expect(first.net === 0 && second.net === 0).toBe(false);
    // The second call is a no-op that says so, rather than crediting the gym twice.
    expect(second.income).toBe(0);
    expect(second.costs).toBe(0);
    expect(second.lines.join(' ')).toContain('already been settled');
  });

  it('allows a settlement again in the following month', () => {
    const f = newCareer(9102);
    const gym = Object.values(f.save.gyms)[0];
    runGymMonth(f.save, gym);
    f.save.date = addDays(f.save.date, 40);
    const next = runGymMonth(f.save, gym);
    expect(next.lines.join(' ')).not.toContain('already been settled');
  });
});

describe('camp form reaches fight night', () => {
  it('a good camp produces more sharpness than a bad one', () => {
    const build = (form: number): number => {
      const f = newCareer(9201);
      const me = playerOf(f.save);
      const camp = createCamp(f.save, me, {
        boutId: null,
        startDate: f.save.date,
        endDate: addDays(f.save.date, 56),
        focus: { striking: 1, grappling: 1, wrestling: 1, submissions: 1, cardio: 1, durability: 1 },
        intensity: 0.5,
        gymId: me.gymId,
        campType: 'home',
        specialistHired: null,
        gamePlan: ['pressure'],
        arriveEarlyDays: 0,
      });
      f.save.camps[camp.id] = camp;
      // A moderate camp, so sharpness is not already saturated at its ceiling where a form
      // penalty would be invisible.
      camp.weeksCompleted = 4;
      // Camp life is what moves form, and it used to reach nothing at all.
      me.campSharpness = form;
      return finalizeCamp(f.save, camp, new Rng(5)).sharpness;
    };
    const good = build(90);
    const neutral = build(CAMP_FORM_BASELINE);
    const bad = build(10);
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeGreaterThanOrEqual(neutral);
    expect(neutral).toBeGreaterThanOrEqual(bad);
  });

  it('resets form when a camp begins, so a previous camp does not follow the fighter', () => {
    const f = newCareer(9202);
    const me = playerOf(f.save);
    me.campSharpness = 5;
    createCamp(f.save, me, {
      boutId: null,
      startDate: f.save.date,
      endDate: addDays(f.save.date, 42),
      focus: { striking: 1, grappling: 1, wrestling: 1, submissions: 1, cardio: 1, durability: 1 },
      intensity: 0.6,
      gymId: me.gymId,
      campType: 'home',
      specialistHired: null,
      gamePlan: ['pressure'],
      arriveEarlyDays: 0,
    });
    expect(me.campSharpness).toBe(CAMP_FORM_BASELINE);
  });

  it('prices a camp without creating one', () => {
    const f = newCareer(9203);
    const me = playerOf(f.save);
    const before = f.save.counters.camp;
    const setup = {
      boutId: null,
      startDate: f.save.date,
      endDate: addDays(f.save.date, 56),
      focus: { striking: 1, grappling: 1, wrestling: 1, submissions: 1, cardio: 1, durability: 1 },
      intensity: 0.7,
      gymId: me.gymId,
      campType: 'home' as const,
      specialistHired: null,
      gamePlan: ['pressure' as const],
      arriveEarlyDays: 0,
    };
    const quoted = estimateCampCost(f.save, setup);
    // The estimate must not touch the persisted counter, which the old preview did on every render.
    expect(f.save.counters.camp).toBe(before);
    // And the quote must match what is actually charged.
    expect(createCamp(f.save, me, setup).cost).toBe(quoted.cost);
  });
});

describe('social actions are decisions, not a free button', () => {
  it('limits deliberate posts to a weekly allowance', () => {
    const f = newCareer(9301);
    const me = playerOf(f.save);
    expect(socialActionAllowance(f.save, me).remaining).toBe(SOCIAL_ACTIONS_PER_WEEK);
    for (let i = 0; i < SOCIAL_ACTIONS_PER_WEEK; i++) {
      performSocialAction(f.save, me, 'training-footage', new Rng(i));
    }
    const allowance = socialActionAllowance(f.save, me);
    expect(allowance.remaining).toBe(0);
    expect(allowance.reason).toBeTruthy();
  });

  it('does not count going quiet against the allowance', () => {
    const f = newCareer(9302);
    const me = playerOf(f.save);
    performSocialAction(f.save, me, 'go-silent', new Rng(1));
    expect(socialActionAllowance(f.save, me).remaining).toBe(SOCIAL_ACTIONS_PER_WEEK);
  });

  it('does not record going quiet as a post, so the reach decay it promises can happen', () => {
    const f = newCareer(9303);
    const me = playerOf(f.save);
    me.social!.lastPostOn = null;
    performSocialAction(f.save, me, 'go-silent', new Rng(1));
    // The idle clock is what drives the decay. Stamping it here cancelled the whole point.
    expect(me.social!.lastPostOn).toBeNull();
  });

  it('charges for a social media manager and refuses a second one', () => {
    const f = newCareer(9304);
    const me = playerOf(f.save);
    f.save.finance!.cash = 500_000;
    const before = f.save.finance!.cash;
    const first = performSocialAction(f.save, me, 'hire-social-manager', new Rng(1));
    expect(first.succeeded).not.toBe(false);
    expect(f.save.finance!.cash).toBeLessThan(before);

    me.social!.engagement = 95;
    const second = performSocialAction(f.save, me, 'hire-social-manager', new Rng(2));
    expect(second.succeeded).toBe(false);
  });

  it('records follower history for a fighter who is growing, not only one who is fading', () => {
    const f = newCareer(9305);
    const me = playerOf(f.save);
    me.social!.history = [];
    // A fighter with no decay at all: recent fight, recent post, no losses.
    me.lastFightDate = f.save.date;
    me.social!.lastPostOn = f.save.date;
    me.lossStreak = 0;
    f.save.date = `${f.save.date.slice(0, 8)}03`;
    decaySocial(me, f.save);
    recordSocialHistory(me, f.save);
    expect(me.social!.history.length).toBeGreaterThan(0);
  });
});

describe('remembered game plans', () => {
  it('remembers clearing every selection', () => {
    const f = newCareer(9401);
    rememberPlan(f.save, 'bout-x', 'camp', ['pressure']);
    expect(recallPlan(f.save, 'bout-x', 'camp').plans).toEqual(['pressure']);
    rememberPlan(f.save, 'bout-x', 'camp', []);
    // An empty plan is a decision. Discarding it silently restored the previous one, both when
    // writing it and when reading it back.
    expect(recallPlan(f.save, 'bout-x', 'camp').plans).toEqual([]);
  });
});

describe('the player is part of their own card', () => {
  it('records every completed bout on a card as contested', () => {
    const f = newCareer(9501);
    runWorld(f.save, 60);

    let checked = 0;
    for (const event of Object.values(f.save.events)) {
      if (event.status !== 'completed') continue;
      const completed = event.boutIds.filter((id) => f.save.bouts[id]?.status === 'completed');
      if (completed.length === 0) continue;
      checked++;
      // Every bout that happened is on the card's contested list, which is what bonus selection
      // reads. A bout resolved outside this list is invisible to bonuses however good it was.
      for (const id of completed) {
        expect(event.contestedBoutIds, `event ${event.id}`).toContain(id);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('includes a separately resolved player bout in the card', () => {
    // simulatePlayerBout resolves the player's fight and then the rest of the card. The player's
    // result has to be handed back in, or it is missing from the contested list and invisible to
    // bonus selection however good the fight was.
    const f = bookedCareer(9502, { daysOut: 30 });
    f.save.date = f.save.bouts[f.boutId].date;
    const result = simulatePlayerBout(f.save, f.boutId, ['pressure']);
    expect(result.boutId).toBe(f.boutId);

    const event = f.save.events[f.save.bouts[f.boutId].eventId];
    expect(event.contestedBoutIds).toContain(f.boutId);
  });
});

describe('migrations stay safe', () => {
  it('migrates from every earlier schema without losing the career', () => {
    const f = newCareer(9601);
    runWorld(f.save, 12);
    const champions = Object.entries(f.save.rankings).map(([d, t]) => `${d}:${t.championId}`);
    const results = Object.keys(f.save.history.results).length;

    for (let from = 9; from < SAVE_SCHEMA_VERSION; from++) {
      const legacy = JSON.parse(JSON.stringify(f.save)) as SaveGame;
      legacy.schemaVersion = from;
      const migrated = migrateSave(legacy);
      expect(migrated.schemaVersion, `from schema ${from}`).toBe(SAVE_SCHEMA_VERSION);
      expect(Object.keys(migrated.history.results).length, `from schema ${from}`).toBe(results);
      expect(Object.entries(migrated.rankings).map(([d, t]) => `${d}:${t.championId}`), `from schema ${from}`).toEqual(champions);
    }
  });
});
