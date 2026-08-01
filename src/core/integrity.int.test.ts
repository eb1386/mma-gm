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
import { importSaveFromFile } from './save/store';
import { pruneLedger, record, summarize } from './world/finance';
import { createContractOffer, signContractOffer } from './world/economy';
import { CAMP_PRESETS, normalizeFocus, setFocusShare, transferFocusShare } from './world/camp';
import { RATING_KEYS } from './types/fighter';
import { findBestOpponent, type AvailabilityContext } from './world/matchmaking';
import { DIFFICULTY } from './config/calibration';
import { DIVISIONS } from './config/divisions';
import { addRankingPoints, recomputeDivision, reconcileChampionFlags, seedDeposedChampion } from './world/rankings';
import { ovrRaw } from './types/fighter';
import { DEFAULT_FEATURE_FLAGS, DEFAULT_SETTINGS, SAVE_SCHEMA_VERSION } from './types/save';
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

/**
 * The soonest announced event this fighter can actually be matched onto.
 *
 * The next card out is usually inside the division's camp and turnaround windows, which leaves
 * nobody to pick from and would make a matchmaking assertion vacuously true.
 */
function bookableEvent(save: SaveGame, fighter: Fighter) {
  const events = Object.values(save.events)
    .filter((e) => e.status === 'announced')
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const event of events) {
    const ctx: AvailabilityContext = { date: event.date, bookedFighterIds: new Set() };
    if (findBestOpponent(save, fighter, event, ctx, new Rng(1), 0)) return { event, ctx };
  }
  throw new Error('no event in the horizon has an available opponent');
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
    // Strict in both directions: a good camp is worth more than a neutral one, not merely no
    // worse. The positive half used to be clipped away by the final clamp.
    expect(good).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(bad);
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

describe('money always moves through the ledger', () => {
  it('has no production code writing the player balance directly', async () => {
    // `record` reconciles player.balance from finance.cash, so any write that touches one side
    // only is silently reverted by the next ledger write. This has caused three separate money
    // bugs: bonus awards, social fines and the contract signing bonus.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    for (const dir of ['src/core/world', 'src/ui/pages']) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
        if (name.includes('.test.') || name === 'finance.ts') continue;
        const text = readFileSync(join(dir, name), 'utf8');
        for (const [i, line] of text.split('\n').entries()) {
          if (/player\.balance\s*[+-]?=/.test(line)) offenders.push(`${name}:${i + 1}`);
          if (/finance(\.|\?\.)cash\s*[+-]?=/.test(line)) offenders.push(`${name}:${i + 1}`);
        }
      }
    }
    expect(offenders, `money written outside the ledger at ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps the balance and the ledger cash in step through a career', () => {
    const f = newCareer(9701);
    runWorld(f.save, 40);
    // The two representations must agree, because one is derived from the other.
    expect(f.save.player.balance).toBe(f.save.finance!.cash);
  });
});

describe('the invariants that have repeatedly broken', () => {
  it('never consumes the world rng inside a settings conditional', async () => {
    // Broken five times in this codebase. Gating a call that draws from the shared rng looks like
    // gating a feature and is actually gating a draw, which shifts every later draw and changes
    // every fight in the world. The setting must decide what is kept, never what is drawn.
    //
    // The first version of this guard looked back a fixed twelve lines and missed two live
    // offenders whose conditional opened further above. It now tracks brace depth, so a draw
    // anywhere inside a settings guarded block is found however long that block is.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    const DRAW = /\brng\.(chance|range|normal|pick|shuffle|int|nextUint32|normalClamped)\b/;
    const GUARD = /\bif\s*\(([^)]*)(save\.settings|featureEnabled|settings\.)/;

    const scan = (file: string): void => {
      const lines = readFileSync(file, 'utf8').split('\n');
      // Depth at which each open settings guard began, if any.
      const guardDepths: number[] = [];
      let depth = 0;
      for (const [i, line] of lines.entries()) {
        const opensGuard = GUARD.test(line) && line.includes('{');
        if (opensGuard) guardDepths.push(depth);
        if (DRAW.test(line) && guardDepths.length > 0) offenders.push(`${file}:${i + 1}`);
        for (const ch of line) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            while (guardDepths.length > 0 && guardDepths[guardDepths.length - 1] >= depth) guardDepths.pop();
          }
        }
      }
    };

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) scan(full);
      }
    };
    walk('src/core');
    expect(offenders, `rng drawn under a settings conditional at ${offenders.join(', ')}`).toEqual([]);
  });

  it('produces an identical world whether or not the business model is kept', () => {
    // businessDepth decides only whether the event economics figures are retained, so it must not
    // change a single fight. Injuries and anti-doping legitimately change what happens to
    // fighters, so they are expected to diverge and are not asserted here; what the rule above
    // protects is that they diverge through their effects rather than by moving the rng stream.
    const build = (business: boolean): string => {
      const f = newCareer(9801);
      f.save.settings.featureFlags = {
        ...(f.save.settings.featureFlags ?? DEFAULT_FEATURE_FLAGS),
        businessDepth: business,
      };
      runWorld(f.save, 26);
      return Object.values(f.save.history.results)
        .map((r) => `${r.boutId}:${r.winnerId}:${r.method}:${r.endRound}`)
        .sort()
        .join('|');
    };
    expect(build(false)).toBe(build(true));
  });
});

describe('no control lies to the player', () => {
  it('has every save setting read by something other than the settings screen', async () => {
    // Three settings controls shipped reading nothing: the playback speed, the exact live scores
    // and the projection path budget. A control that changes a stored value nobody reads is worse
    // than no control, because it tells the player they have changed something.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    let source = '';
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (entry.name.includes('.test.')) continue;
        // The settings screen writes them; it does not count as a reader.
        if (entry.name === 'Misc.tsx' || full.endsWith('types/save.ts')) continue;
        source += readFileSync(full, 'utf8');
      }
    };
    walk('src/core');
    walk('src/ui');

    const unread = Object.keys(DEFAULT_SETTINGS)
      .filter((key) => key !== 'featureFlags')
      .filter((key) => !source.includes(`settings.${key}`) && !source.includes(`'${key}'`));
    expect(unread, `settings read by nothing: ${unread.join(', ')}`).toEqual([]);
  });
});

describe('money reads correctly over a long career', () => {
  it('clears debt once the shortfall is paid back', () => {
    const f = newCareer(9801);
    // Spend past zero, then earn it back. Debt used to be a high water mark, so a single
    // overdraft marked the fighter as indebted for life and was deducted from net worth forever.
    record(f.save, playerOf(f.save).id, 'out', 'lifestyle', f.save.finance!.cash + 50000, 'Overspend');
    expect(f.save.finance!.debt).toBe(50000);
    expect(summarize(f.save, playerOf(f.save).id).netWorthEstimate).toBe(-50000);
    record(f.save, playerOf(f.save).id, 'in', 'show-pay', 250000, 'Show pay');
    expect(f.save.finance!.debt).toBe(0);
    expect(summarize(f.save, playerOf(f.save).id).netWorthEstimate).toBe(200000);
  });

  it('keeps the earnings breakdown intact when the ledger is pruned', () => {
    const f = newCareer(9802);
    const me = playerOf(f.save).id;
    for (let i = 0; i < 800; i++) record(f.save, me, 'in', 'show-pay', 100, `Show pay ${i}`);
    const beforePrune = summarize(f.save, me).incomeByKind.find((r) => r.kind === 'show-pay')?.amount ?? 0;
    const removed = pruneLedger(f.save);
    expect(removed).toBeGreaterThan(0);
    const afterPrune = summarize(f.save, me).incomeByKind.find((r) => r.kind === 'show-pay')?.amount ?? 0;
    // The breakdown is a running total, so pruning detail cannot shrink it.
    expect(afterPrune).toBe(beforePrune);
  });

  it('does not drop a payment made after the ledger has been pruned', () => {
    // The ledger id used to be derived from the ledger length, and pruning is the only thing that
    // shortens it, so afterwards the counter walked back over numbers that surviving entries
    // already held. A real payment then collided and vanished: no entry, no cash movement, and
    // the caller told the money had gone out.
    const f = newCareer(9807);
    const me = playerOf(f.save).id;
    for (let i = 0; i < 640; i++) record(f.save, me, 'out', 'nutrition', 10, `Supplies ${i}`);
    expect(pruneLedger(f.save)).toBeGreaterThan(0);
    const cashBefore = f.save.finance!.cash;
    const entriesBefore = f.save.ledger!.length;
    // Same date and same kind as entries that survived the prune.
    const entry = record(f.save, me, 'out', 'nutrition', 400, 'Camp supplies');
    expect(entry).not.toBeNull();
    expect(f.save.ledger!.length).toBe(entriesBefore + 1);
    expect(f.save.finance!.cash).toBe(cashBefore - 400);
  });

  it('records money only for the fighter the player is managing', () => {
    // The ledger totals are per fighter but cash and the career totals are one pot, so a ledger
    // entry naming anyone else would move the player's money and be invisible in their breakdown.
    const f = newCareer(9809);
    runWorld(f.save, 60);
    const others = f.save.ledger!.filter((e) => e.fighterId !== f.save.player.fighterId);
    expect(others.map((e) => `${e.kind}:${e.note}`)).toEqual([]);
  });

  it('never writes two ledger entries with the same id', () => {
    const f = newCareer(9808);
    runWorld(f.save, 90);
    const ids = f.save.ledger!.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the breakdown adding up to the career totals', () => {
    const f = newCareer(9803);
    runWorld(f.save, 60);
    const me = playerOf(f.save).id;
    const s = summarize(f.save, me);
    const income = s.incomeByKind.reduce((t, r) => t + r.amount, 0);
    const expense = s.expenseByKind.reduce((t, r) => t + r.amount, 0);
    expect(income).toBe(s.careerEarnings);
    expect(expense).toBe(s.careerExpenses);
  });
});

describe('difficulty changes the matchmaking without freezing it', () => {
  it('still varies the opponent chosen on a non default difficulty', () => {
    // The bias used to return a fixed index into the scored list, which made every matchup on a
    // non default difficulty the same single choice and skipped the draw that keeps a save varied.
    const f = newCareer(5501);
    runWorld(f.save, 12);
    const me = playerOf(f.save);
    const { event, ctx } = bookableEvent(f.save, me);
    const chosen = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      const pick = findBestOpponent(f.save, me, event, ctx, new Rng(7000 + seed), DIFFICULTY.hard.matchmakingBias);
      if (pick) chosen.add(pick.opponent.id);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('assigns a stronger opponent on a harder difficulty than on an easier one', () => {
    // Measured across eight careers, as the difference between the opponent's Ovr and the
    // player's. Three careers was too small a sample: the gap between neighbouring settings is
    // real but under a point, so a single unlucky draw could invert it and say nothing about
    // whether the setting works.
    const CAREERS = [5502, 5503, 5504, 5505, 5506, 5507, 5508, 5509];
    const worlds = CAREERS.map((seed) => {
      const f = newCareer(seed);
      runWorld(f.save, 12);
      const me = playerOf(f.save);
      return { save: f.save, me, ...bookableEvent(f.save, me) };
    });

    const meanGap = (bias: number) => {
      let total = 0;
      let n = 0;
      for (const w of worlds) {
        for (let seed = 0; seed < 30; seed++) {
          const pick = findBestOpponent(w.save, w.me, w.event, w.ctx, new Rng(8000 + seed), bias);
          if (pick) {
            total += ovrRaw(pick.opponent.ratings) - ovrRaw(w.me.ratings);
            n++;
          }
        }
      }
      expect(n).toBeGreaterThan(0);
      return total / n;
    };

    // Every step up in difficulty is a step up in the opponent handed out, and none of the four
    // settings is a duplicate of another. Two of them used to be inert.
    const easy = meanGap(DIFFICULTY.easy.matchmakingBias);
    const normal = meanGap(0);
    const hard = meanGap(DIFFICULTY.hard.matchmakingBias);
    const brutal = meanGap(DIFFICULTY.brutal.matchmakingBias);
    expect(easy).toBeLessThan(normal);
    expect(normal).toBeLessThan(hard);
    expect(hard).toBeLessThan(brutal);
  });
});

describe('a gym is credited for the fighters it gets ranked', () => {
  it('credits the starting roster, which arrives already ranked', () => {
    // The live counter only fires the first time a fighter is ranked, and every imported fighter
    // already carries a highest ranking, so without seeding at creation every real gym read zero
    // for the life of the save.
    const f = newCareer(9804);
    const total = Object.values(f.save.gyms).reduce((t, g) => t + g.rankedProduced, 0);
    const everRankedAtAGym = Object.values(f.save.fighters).filter((x) => x.highestRanking != null && x.gymId).length;
    expect(total).toBe(everRankedAtAGym);
  });

  it('counts each fighter once, the first time they are ranked', () => {
    const f = newCareer(9805);
    const before = Object.values(f.save.gyms).reduce((t, g) => t + g.rankedProduced, 0);
    runWorld(f.save, 80);
    const after = Object.values(f.save.gyms).reduce((t, g) => t + g.rankedProduced, 0);
    expect(after).toBeGreaterThanOrEqual(before);
    // Never more than the number of fighters who have ever been ranked and are at a gym.
    const everRanked = Object.values(f.save.fighters).filter((x) => x.highestRanking != null && x.gymId).length;
    expect(after).toBeLessThanOrEqual(everRanked);
  });
});

describe('the camp focus sliders are one camp, not six dials', () => {
  const total = (f: ReturnType<typeof normalizeFocus>) => RATING_KEYS.reduce((t, k) => t + f[k], 0);

  it('always adds up to the whole camp, whatever is moved', () => {
    // Every slider at the top used to give the same camp as every slider at the bottom, because
    // the share shown was each weight over their total. Nothing the player did to them mattered.
    let focus = normalizeFocus(CAMP_PRESETS[0].focus);
    expect(total(focus)).toBeCloseTo(1, 6);
    for (const [key, share] of [
      ['striking', 0.5],
      ['wrestling', 0.4],
      ['striking', 1],
      ['cardio', 0.3],
      ['cardio', 0],
      ['durability', 0.25],
    ] as const) {
      focus = setFocusShare(focus, key, share);
      expect(total(focus), `after setting ${key} to ${share}`).toBeCloseTo(1, 6);
      expect(focus[key]).toBeCloseTo(share, 6);
      for (const k of RATING_KEYS) expect(focus[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it('takes time from the others in proportion to what they had', () => {
    const focus = normalizeFocus({ striking: 0.4, grappling: 0.2, wrestling: 0.2, submissions: 0.1, cardio: 0.1, durability: 0 });
    const next = setFocusShare(focus, 'striking', 0.6);
    // Grappling and wrestling were equal before, so they stay equal after.
    expect(next.grappling).toBeCloseTo(next.wrestling, 6);
    // And each keeps its relative standing against the others.
    expect(next.grappling / next.submissions).toBeCloseTo(focus.grappling / focus.submissions, 6);
  });

  it('moves time from one area into its neighbour without changing the whole', () => {
    // This is what dragging a boundary does, and it is the only kind of change an allocation with
    // a fixed whole can undergo: what one area gains comes off the one beside it.
    let focus = normalizeFocus(CAMP_PRESETS[0].focus);
    const before = { ...focus };
    focus = transferFocusShare(focus, 'grappling', 'striking', 0.05);
    expect(total(focus)).toBeCloseTo(1, 6);
    expect(focus.striking).toBeCloseTo(before.striking + 0.05, 6);
    expect(focus.grappling).toBeCloseTo(before.grappling - 0.05, 6);
    // Nothing else moved.
    for (const k of RATING_KEYS) {
      if (k === 'striking' || k === 'grappling') continue;
      expect(focus[k]).toBeCloseTo(before[k], 6);
    }
  });

  it('stops at zero rather than letting an area go negative', () => {
    let focus = normalizeFocus(CAMP_PRESETS[0].focus);
    focus = transferFocusShare(focus, 'durability', 'striking', 5);
    expect(focus.durability).toBeCloseTo(0, 6);
    expect(total(focus)).toBeCloseTo(1, 6);
  });

  it('splits evenly when one area had taken the whole camp', () => {
    let focus = normalizeFocus(CAMP_PRESETS[0].focus);
    focus = setFocusShare(focus, 'striking', 1);
    for (const k of RATING_KEYS) if (k !== 'striking') expect(focus[k]).toBeCloseTo(0, 6);
    focus = setFocusShare(focus, 'striking', 0.5);
    expect(total(focus)).toBeCloseTo(1, 6);
    for (const k of RATING_KEYS) if (k !== 'striking') expect(focus[k]).toBeCloseTo(0.1, 6);
  });
});

describe('being released is a setback, not the end of a career', () => {
  it('approaches a released fighter again and lets them sign', () => {
    // A release set the contract status to released, and the renewal pass only looked at expired,
    // so the promotion never approached them again while the career screen promised a new deal.
    const f = newCareer(9814);
    const me = playerOf(f.save);
    const contract = f.save.contracts[me.contractId!];
    contract.status = 'released';
    contract.endCondition = 'released';
    contract.endDate = f.save.date;
    me.activityStatus = 'released';

    // Nothing arrives while the promotion is still cooling off.
    runWorld(f.save, 20);
    const early = Object.values(f.save.contractOffers).filter((o) => o.fighterId === me.id);
    expect(early.length).toBe(0);

    // It does arrive once the wait is served.
    runWorld(f.save, 40);
    const later = Object.values(f.save.contractOffers).filter((o) => o.fighterId === me.id);
    expect(later.length).toBeGreaterThan(0);
  });

  it('clears the released status when a new deal is signed', () => {
    const f = newCareer(9815);
    const me = playerOf(f.save);
    me.activityStatus = 'released';
    const offer = createContractOffer(me, f.save, new Rng(7));
    signContractOffer(f.save, me, offer, null);
    // Otherwise the contract is active while every availability check still refuses them.
    expect(me.activityStatus).toBe('active');
  });
});

describe('a bad save file is refused with a reason', () => {
  const asFile = (body: string) => ({ text: async () => body }) as unknown as File;

  it('names what is missing rather than leaking an internal error', async () => {
    // A file that passed the old one key check produced "Cannot read properties of undefined
    // (reading 'retirements')", which tells a player nothing about the file they chose.
    await expect(importSaveFromFile(asFile(JSON.stringify({ fighters: {} })))).rejects.toThrow(/is not an .* save/i);
    await expect(importSaveFromFile(asFile(JSON.stringify({ fighters: {} })))).rejects.toThrow(/player/);
  });

  it('refuses a file that is not readable as save data at all', async () => {
    await expect(importSaveFromFile(asFile('this is not json'))).rejects.toThrow(/not readable/i);
  });

  it('still refuses a save written by a newer build, saying so', async () => {
    const f = newCareer(9813);
    const future = JSON.parse(JSON.stringify(f.save));
    future.schemaVersion = 9999;
    await expect(importSaveFromFile(asFile(JSON.stringify(future)))).rejects.toThrow(/newer version/i);
  });
});

describe('losing a belt costs the belt, not everything that earned it', () => {
  it('puts a deposed champion back into the top three, not out of the rankings', () => {
    // A champion is kept out of the ranked entries while they hold the title, so their points sit
    // still for the length of the reign. Rejoining on that stale total could leave them outside
    // the fifteen entirely: a title fight lost on Saturday, unranked on Monday.
    const f = newCareer(9830);
    const divisionId = DIVISIONS[0].id;
    const table = f.save.rankings[divisionId];
    const champion = f.save.fighters[table.championId!];

    seedDeposedChampion(f.save, divisionId, champion.id);
    table.championId = null;
    champion.isChampion = false;
    recomputeDivision(f.save, divisionId, new Map());

    expect(champion.ranking).not.toBeNull();
    expect(champion.ranking!).toBeLessThanOrEqual(3);
  });

  it('does not displace a fighter who has earned a better standing', () => {
    const f = newCareer(9831);
    const divisionId = DIVISIONS[0].id;
    const table = f.save.rankings[divisionId];
    const champion = f.save.fighters[table.championId!];
    // Somebody with a commanding lead stays ahead of a returning champion.
    const leader = f.save.fighters[table.entries[0].fighterId];
    addRankingPoints(f.save, divisionId, leader.id, 500);

    seedDeposedChampion(f.save, divisionId, champion.id);
    table.championId = null;
    champion.isChampion = false;
    recomputeDivision(f.save, divisionId, new Map());

    expect(leader.ranking).toBe(1);
    expect(champion.ranking!).toBeLessThanOrEqual(3);
  });
});

describe('the ranking tables are the record of who holds a belt', () => {
  it('clears a champion flag that no table backs', () => {
    // The flag used to be cleared in six separate places and a path none of them covered left a
    // deposed champion still flagged, so a division could show two champions at once.
    const f = newCareer(9810);
    const division = DIVISIONS[0].id;
    const table = f.save.rankings[division];
    const pretender = Object.values(f.save.fighters).find(
      (x) => x.divisionId === division && x.id !== table.championId
    )!;
    pretender.isChampion = true;
    const corrections = reconcileChampionFlags(f.save);
    expect(corrections.length).toBeGreaterThan(0);
    expect(pretender.isChampion).toBe(false);
    const flagged = Object.values(f.save.fighters).filter((x) => x.isChampion && x.divisionId === division);
    expect(flagged.length).toBeLessThanOrEqual(1);
  });

  it('restores a champion flag the tables do back', () => {
    const f = newCareer(9811);
    const division = DIVISIONS[0].id;
    const champion = f.save.fighters[f.save.rankings[division].championId!];
    expect(champion).toBeDefined();
    champion.isChampion = false;
    reconcileChampionFlags(f.save);
    expect(champion.isChampion).toBe(true);
  });

  it('changes nothing when the flags already agree', () => {
    const f = newCareer(9812);
    runWorld(f.save, 30);
    expect(reconcileChampionFlags(f.save)).toEqual([]);
  });
});

describe('a gym is credited once per champion, not once per title win', () => {
  it('does not add to the total when a champion defends', () => {
    const f = newCareer(9806);
    runWorld(f.save, 120);
    // A gym cannot have produced more champions than it has had distinct fighters hold a belt.
    for (const gym of Object.values(f.save.gyms)) {
      const everChampion = Object.values(f.save.fighters).filter(
        (x) => x.gymId === gym.id && (x.isChampion || x.titleReigns > 0)
      ).length;
      const defencesHere = Object.values(f.save.fighters)
        .filter((x) => x.gymId === gym.id)
        .reduce((t, x) => t + x.titleDefenses, 0);
      // The old counter added one per title bout won, so any gym with a defending champion
      // would exceed the number of fighters who have ever held a belt there.
      if (defencesHere > 0) expect(gym.championsProduced).toBeLessThanOrEqual(everChampion);
    }
  });
});
