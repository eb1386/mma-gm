import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays, type BoutId } from './types/common';
import type { FightResult } from './types/fight';
import type { SaveGame } from './types/save';
import { DIVISION_BY_ID } from './config/divisions';
import { NAME_BANKS } from './data/names';
import { PROMOTION_MARKETING } from './config/branding';
import { bookedCareer, createEvent, newCareer } from './testing/fixtures';
import { bookBout } from './world/availability';
import { ensureFightWeekTasks } from './world/fightweek';
import { computeHype, hypeStore } from './world/hype';
import { createSession, faceoffChoices, presserRng } from './world/presser';
import { buildContext, generateSocialItems, marketingSenderFor, pruneSocial, replyToSocialItem, socialRng } from './world/social';
import { availableSocialActions, performSocialAction } from './world/identity';
import { buildCampContext } from './world/camp-life';
import { migrateSave } from './save/migrate';

/**
 * Who people are called and what the media says about them.
 *
 * Women's divisions used to be filled with men's names and every line of media text called
 * the other fighter "he". Media items also outlived the fights they were about, repeated the
 * same questions inside one fight week, and promised effects that never happened.
 */

const MALE_PRONOUN = /\b(he|him|his|himself)\b/i;

/** A booked bout for a career in the given division, built the way bookedCareer builds one. */
function bookedIn(seed: number, divisionId: string, opts: { daysOut?: number; isTitleFight?: boolean } = {}) {
  const fixture = newCareer(seed, { light: true, divisionId });
  const { save, playerId } = fixture;
  const me = save.fighters[playerId];
  const opponent = Object.values(save.fighters).find(
    (f) => f.id !== me.id && f.divisionId === me.divisionId && !f.retired && !f.nextBoutId
  )!;
  const date = addDays(save.date, opts.daysOut ?? 3);
  const event = createEvent(save, date);
  const boutId: BoutId = `bout-fixture-${++save.counters.bout}`;
  const booking = bookBout(save, {
    id: boutId,
    eventId: event.id,
    date,
    fighterAId: me.id,
    fighterBId: opponent.id,
    divisionId: me.divisionId,
    contractedWeightLb: DIVISION_BY_ID[me.divisionId].limitLb,
    scheduledRounds: opts.isTitleFight ? 5 : 3,
    isTitleFight: opts.isTitleFight ?? false,
    isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
    isMainEvent: opts.isTitleFight ?? false,
    isCoMain: false,
    cardSegment: 'main',
    boutOrder: 10,
    isCatchweight: false,
    status: 'scheduled',
    resultId: null,
    bookedOn: save.date,
    replacementHistory: [],
    cancelReason: null,
    purseA: { show: 50000, win: 50000 },
    purseB: { show: 50000, win: 50000 },
    weighInA: null,
    weighInB: null,
    bookingReason: 'test fixture booking',
  });
  if (!booking.created) throw new Error(`Could not book: ${booking.reason}`);
  return { ...fixture, boutId, opponentId: opponent.id };
}

/** Records a finished fight for the player, as the history would hold it. */
function recordResult(save: SaveGame, meId: string, method: FightResult['method'], daysAgo: number): void {
  const me = save.fighters[meId];
  const id = `bout-history-${method}-${daysAgo}`;
  const date = addDays(save.date, -daysAgo);
  save.history.results[id] = { id, boutId: id, date, fighterAId: me.id, fighterBId: 'x', winnerId: null, loserId: me.id, method } as unknown as FightResult;
  me.boutIds.push(id);
  me.lastFightDate = date;
}

describe('names', () => {
  it('gives every generated fighter in a women\'s division a woman\'s first name', () => {
    const { save } = newCareer(7101, { light: true });
    const womens = new Set(NAME_BANKS.flatMap((b) => b.firstFemale));
    const generated = Object.values(save.fighters).filter(
      (f) => !f.isRealPerson && DIVISION_BY_ID[f.divisionId]?.gender === 'women'
    );
    expect(generated.length).toBeGreaterThan(0);
    for (const f of generated) expect(womens.has(f.firstName)).toBe(true);
  });

  it('renames a generated woman with a man\'s name in an older save, once, and leaves real fighters alone', () => {
    const { save, playerId } = newCareer(7102, { light: true });
    const generated = Object.values(save.fighters).find(
      (f) => !f.isRealPerson && f.id !== playerId && DIVISION_BY_ID[f.divisionId]?.gender === 'women'
    )!;
    generated.firstName = 'Marcus';
    generated.lastName = 'Orlov';
    generated.countryCode = 'RU';
    generated.name = 'Marcus Orlov';
    const real = Object.values(save.fighters).find((f) => f.isRealPerson && DIVISION_BY_ID[f.divisionId]?.gender === 'women')!;
    const realName = real.name;
    const raw = JSON.parse(JSON.stringify(save)) as SaveGame;
    const once = migrateSave(raw);
    const renamed = once.fighters[generated.id];
    expect(NAME_BANKS.find((b) => b.code === 'RU')!.firstFemale).toContain(renamed.firstName);
    expect(renamed.lastName).toBe('Orlova');
    expect(renamed.name).toBe(`${renamed.firstName} Orlova`);
    expect(once.fighters[real.id].name).toBe(realName);
    const twice = migrateSave(JSON.parse(JSON.stringify(once)) as SaveGame);
    expect(twice.fighters[generated.id].name).toBe(renamed.name);
  });
});

describe('pronouns in media text', () => {
  it('never calls a women\'s strawweight opponent he or him', () => {
    for (const seed of [7111, 7112, 7113]) {
      const f = bookedIn(seed, 'womens-strawweight', { daysOut: 3, isTitleFight: seed % 2 === 0 });
      ensureFightWeekTasks(f.save, f.boutId);
      const texts: string[] = [];
      for (const kind of ['media-day', 'press-conference'] as const) {
        const session = createSession(f.save, f.boutId, kind, presserRng(f.save, f.boutId, kind));
        for (const q of session?.questions ?? []) {
          texts.push(q.text);
          for (const a of q.answers) texts.push(a.text);
        }
      }
      for (const c of faceoffChoices(80, f.save.fighters[f.opponentId])) texts.push(c.label, c.detail);
      const me = f.save.fighters[f.playerId];
      for (const item of generateSocialItems(f.save, me, socialRng(f.save, me.id))) {
        texts.push(item.headline, item.body, ...item.replies.map((r) => r.text));
      }
      for (const t of texts) expect(t, t).not.toMatch(MALE_PRONOUN);
      // And the text does talk about her, so the check above is not passing on silence.
      expect(texts.some((t) => /\b(she|her|She|Her)\b/.test(t))).toBe(true);
    }
  });
});

describe('press sessions in one fight week', () => {
  it('does not ask the press conference what media day already asked', () => {
    for (const seed of [7121, 7122, 7123]) {
      const f = bookedCareer(seed, { daysOut: 3, isTitleFight: true });
      const media = createSession(f.save, f.boutId, 'media-day', presserRng(f.save, f.boutId, 'media-day'))!;
      const press = createSession(f.save, f.boutId, 'press-conference', presserRng(f.save, f.boutId, 'press-conference'))!;
      const asked = new Set(media.questions.map((q) => q.id.split('|')[0]));
      const repeats = press.questions.filter((q) => asked.has(q.id.split('|')[0]));
      // A repeat is only allowed to reach the minimum of three questions.
      if (repeats.length > 0) expect(press.questions.length).toBe(3);
      expect(press.questions.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('social actions', () => {
  it('puts a successful callout into the booked fight\'s hype', () => {
    const f = bookedIn(7131, 'lightweight', { daysOut: 30 });
    const save = f.save;
    const me = save.fighters[f.playerId];
    computeHype(save, save.bouts[f.boutId]);
    let added = false;
    for (let seed = 1; seed < 60 && !added; seed++) {
      if (me.social) me.social.actionsThisWeek = 0;
      const before = hypeStore(save)[f.boutId]?.moments.length ?? 0;
      const out = performSocialAction(save, me, 'callout', new Rng(seed));
      const after = hypeStore(save)[f.boutId]?.moments.length ?? 0;
      if (out.succeeded) {
        expect(after).toBe(before + 1);
        added = true;
      } else {
        expect(after).toBe(before);
      }
    }
    expect(added).toBe(true);
  });

  it('offers no callout without a booked opponent and no title demand to a champion', () => {
    const { save, playerId } = newCareer(7132, { light: true });
    const me = save.fighters[playerId];
    me.nextBoutId = null;
    const keys = availableSocialActions(save, me).map((a) => a.key);
    expect(keys).not.toContain('callout');
    expect(keys).not.toContain('compliment-opponent');
    expect(keys).not.toContain('announce-injury');
    me.isChampion = true;
    expect(availableSocialActions(save, me).map((a) => a.key)).not.toContain('demand-title-shot');
    const refused = performSocialAction(save, me, 'callout', new Rng(1));
    expect(refused.succeeded).toBe(false);
  });
});

describe('social items', () => {
  it('raises no scorecard argument after a knockout', () => {
    const f = bookedIn(7141, 'lightweight', { daysOut: 30 });
    const me = f.save.fighters[f.playerId];
    recordResult(f.save, me.id, 'ko', 10);
    const ctx = buildContext(f.save, me, new Rng(1));
    expect(ctx.lastResultMethod).toBe('ko');
    for (let i = 0; i < 20; i++) {
      const created = generateSocialItems(f.save, me, new Rng(i));
      expect(created.some((c) => c.signature === 'judging-debate')).toBe(false);
      for (const c of created) delete f.save.socialFeed![c.id];
    }
  });

  it('closes a pre fight item once the fight is over, without the cost of ignoring it', () => {
    const f = bookedIn(7142, 'lightweight', { daysOut: 5 });
    const save = f.save;
    const me = save.fighters[f.playerId];
    let item = null;
    for (let i = 0; i < 30 && !item; i++) {
      item = generateSocialItems(save, me, new Rng(i)).find((x) => x.boutId === f.boutId) ?? null;
    }
    expect(item).not.toBeNull();
    // Its expiry is capped at the event.
    expect(item!.expiresOn <= save.bouts[f.boutId].date).toBe(true);
    save.bouts[f.boutId].status = 'completed';
    const media = me.fame!.mediaFriendliness;
    pruneSocial(save);
    expect(save.socialFeed![item!.id].resolvedOn).toBe(save.date);
    expect(save.socialFeed![item!.id].immediateReaction).toBe('The fight has happened.');
    expect(me.fame!.mediaFriendliness).toBe(media);
    // Answering it now changes nothing.
    const fav = me.fame!.favorability;
    replyToSocialItem(save, item!.id, item!.replies[0].key, new Rng(3));
    expect(me.fame!.favorability).toBe(fav);
  });

  it('sends regional marketing requests from the regional promotion', () => {
    const f = bookedIn(7143, 'lightweight', { daysOut: 20 });
    const save = f.save;
    const event = save.events[save.bouts[f.boutId].eventId];
    event.promotionId = 'rp-lone-star';
    const me = save.fighters[f.playerId];
    const ctx = buildContext(save, me, new Rng(1));
    expect(ctx.isRegional).toBe(true);
    const camp = buildCampContext(save, me, new Rng(1));
    expect(camp.isRegional).toBe(true);
    expect(marketingSenderFor(event.promotionId)).toBe('Lone Star Fighting Alliance marketing');
    expect(marketingSenderFor(null)).toBe(PROMOTION_MARKETING);
  });
});
