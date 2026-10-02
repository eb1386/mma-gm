import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { addDays } from './types/common';
import type { FightResult } from './types/fight';
import type { Contract } from './types/world';
import { createEvent, makeInjury, newCareer, offeredCareer } from './testing/fixtures';
import { createFightOffer, respondToOffer } from './world/offers';
import { computeLeverage, createContractOffer, purseForBout, respondToCounter } from './world/economy';
import { advance, RELEASE_RETURN_DAYS } from './world/tick';

/**
 * Per bout offers and contract talks.
 *
 * Each of these was a way the negotiation said one thing and did another: a free medical decline
 * for a healthy fighter, relationship changes that were reported and never applied, a short notice
 * bonus kept after the date moved, money asks that compounded, a guarantee that never paid, a
 * renewal below the deal it replaced, and a player who was never released.
 */

describe('declining an offer', () => {
  it('escalates a medical decline the medical record does not support', () => {
    const f = offeredCareer(7101);
    const me = f.save.fighters[f.playerId];
    me.injuries = [];
    const rel = me.relationships.matchmaker;
    const declined = me.declinedOffers;
    const outcome = respondToOffer(f.save, f.offerId, { kind: 'decline', reason: 'injury' }, new Rng(1));
    expect(outcome.message).toMatch(/no record of an injury/);
    expect(outcome.tone).toBe('bad');
    expect(me.declinedOffers).toBe(declined + 1);
    expect(me.relationships.matchmaker).toBeLessThan(rel);
  });

  it('keeps a medical decline free with an injury on record', () => {
    const f = offeredCareer(7102);
    const me = f.save.fighters[f.playerId];
    me.injuries = [makeInjury(f.save.date, { blocking: false, returnDays: 20 })];
    const rel = me.relationships.matchmaker;
    const declined = me.declinedOffers;
    const outcome = respondToOffer(f.save, f.offerId, { kind: 'decline', reason: 'injury' }, new Rng(1));
    expect(outcome.relationshipDelta).toBe(0);
    expect(me.declinedOffers).toBe(declined);
    expect(me.relationships.matchmaker).toBe(rel);
  });
});

describe('requests on an offer', () => {
  it('applies the reported relationship change exactly once', () => {
    const f = offeredCareer(7103);
    const me = f.save.fighters[f.playerId];
    me.relationships.matchmaker = 60;
    const rel = me.relationships.matchmaker;
    const offer = f.save.fightOffers[f.offerId];
    const outcome = respondToOffer(f.save, f.offerId, { kind: 'request-money', amount: offer.showPay * 10 }, new Rng(1));
    // A refused money ask costs three, not six.
    expect(outcome.relationshipDelta).toBe(-3);
    expect(me.relationships.matchmaker).toBe(rel - 3);

    const before = me.relationships.matchmaker;
    const second = respondToOffer(f.save, f.offerId, { kind: 'request-five-rounds' }, new Rng(2));
    expect(me.relationships.matchmaker - before).toBe(second.relationshipDelta);
  });

  it('takes a volunteer without a request slot, and only once', () => {
    const f = offeredCareer(7104);
    const me = f.save.fighters[f.playerId];
    me.relationships.matchmaker = 50;
    const offer = f.save.fightOffers[f.offerId];
    const first = respondToOffer(f.save, f.offerId, { kind: 'volunteer-replacement' }, new Rng(1));
    expect(first.relationshipDelta).toBe(4);
    expect(me.relationships.matchmaker).toBe(54);
    expect(me.volunteeredShortNoticeUntil).toBeTruthy();
    expect(offer.requestsUsed).toBe(0);
    const again = respondToOffer(f.save, f.offerId, { kind: 'volunteer-replacement' }, new Rng(1));
    expect(again.relationshipDelta).toBe(0);
    expect(again.message).toMatch(/Already on the short notice list/);
    expect(me.relationships.matchmaker).toBe(54);
  });

  it('grants one money raise, capped against the opening purse', () => {
    const f = offeredCareer(7105);
    const offer = f.save.fightOffers[f.offerId];
    const base = offer.showPay;
    const granted = respondToOffer(f.save, f.offerId, { kind: 'request-money', amount: Math.round(base * 1.02) }, new Rng(1));
    expect(granted.tone).toBe('good');
    expect(granted.message).toMatch(/\$/);
    expect(offer.moneyGranted).toBe(true);
    const used = offer.requestsUsed;
    const again = respondToOffer(f.save, f.offerId, { kind: 'request-money', amount: Math.round(base * 1.2) }, new Rng(1));
    expect(again.message).toMatch(/already raised/);
    expect(offer.requestsUsed).toBe(used);
    expect(offer.showPay).toBeLessThanOrEqual(base * 1.2);
  });

  it('drops the short notice bonus when the date moves out of short notice', () => {
    const f = newCareer(7106, { light: true });
    const { save, playerId } = f;
    const me = save.fighters[playerId];
    const opponent = Object.values(save.fighters).find((x) => x.id !== me.id && x.divisionId === me.divisionId && !x.retired && !x.nextBoutId)!;
    const soon = createEvent(save, addDays(save.date, 18), 'Soon Card');
    createEvent(save, addDays(save.date, 60), 'Later Card');
    const offer = createFightOffer(save, me, opponent, soon, new Rng(3), {
      isMainEvent: false,
      isTitleFight: false,
      isInterimTitleFight: false,
      scheduledRounds: 3,
      reason: 'a short notice replacement',
      isReplacementSlot: true,
    })!;
    expect(offer).toBeTruthy();
    expect(offer.shortNoticeBonus).toBeGreaterThan(0);
    // A seed whose first draw grants the extra time.
    let seed = 1;
    while (!new Rng(seed).chance(0.5)) seed++;
    const outcome = respondToOffer(save, offer.id, { kind: 'request-more-time', weeks: 4 }, new Rng(seed));
    expect(outcome.tone).toBe('good');
    expect(offer.noticeDays).toBeGreaterThanOrEqual(24);
    expect(offer.shortNoticeBonus).toBe(0);
    const contract = save.contracts[me.contractId!];
    expect(offer.showPay).toBe(purseForBout(contract, me, save, { isMainEvent: false, isTitleFight: false, shortNotice: false }).show);
  });
});

describe('contract terms', () => {
  it('pays the guaranteed show money as a floor on show pay', () => {
    const f = newCareer(7107, { light: true });
    const me = f.save.fighters[f.playerId];
    const base = f.save.contracts[me.contractId!];
    const contract: Contract = {
      ...base,
      terms: { ...base.terms, showPay: 50000, winBonus: 50000, guaranteedMinimum: 80000, mainEventBonus: 0, championEscalator: 0, shortNoticeBonus: 0 },
    };
    const purse = purseForBout(contract, me, f.save, { isMainEvent: false, isTitleFight: false, shortNotice: false });
    expect(purse.show).toBe(80000);
    expect(purse.win).toBe(50000);
  });

  it('gives a real concession on show pay when a signing bonus has no budget', () => {
    const f = newCareer(7108, { light: true });
    const me = f.save.fighters[f.playerId];
    const offer = createContractOffer(me, f.save, new Rng(5));
    offer.reservation.maxSigningBonus = 0;
    const opening = offer.terms.showPay;
    const ask = Math.min(Math.round(opening * 1.2), offer.reservation.maxShowPay);
    const r = respondToCounter(offer, { kind: 'counter', terms: { showPay: ask, signingBonus: 5000 } }, f.save, new Rng(6));
    expect(r.outcome).toBe('countered');
    expect(r.message).toMatch(/signing bonus is not on the table/);
    expect(r.message).not.toMatch(/well beyond/);
    expect(offer.terms.showPay).toBeGreaterThan(opening * 1.03);
    expect(offer.terms.signingBonus).toBe(0);
  });

  it('opens a renewal after a winning run at or above the previous deal', () => {
    const f = newCareer(7109, { light: true });
    const { save, playerId } = f;
    const me = save.fighters[playerId];
    const prev = save.contracts[me.contractId!];
    prev.status = 'expired';
    prev.fightsRemaining = 0;
    const event = createEvent(save, save.date);
    for (const n of [1, 2]) {
      const id = `bout-renewal-${n}`;
      save.history.results[id] = { boutId: id, eventId: event.id, date: save.date, winnerId: me.id, loserId: 'nobody' } as unknown as FightResult;
      me.boutIds.push(id);
    }
    const offer = createContractOffer(me, save, new Rng(8));
    expect(offer.terms.showPay).toBeGreaterThanOrEqual(prev.terms.showPay);
    expect(offer.terms.winBonus).toBeGreaterThanOrEqual(prev.terms.winBonus);
    expect(offer.reservation.maxShowPay).toBeGreaterThanOrEqual(offer.terms.showPay);
  });
});

describe('the end of a deal', () => {
  it('releases a player whose deal runs out on a losing run, and comes back only after the wait', () => {
    const f = newCareer(7110, { light: true });
    const { save, playerId } = f;
    const me = save.fighters[playerId];
    const contract = save.contracts[me.contractId!];
    contract.status = 'expired';
    contract.fightsRemaining = 0;
    me.ranking = null;
    me.popularity = 1;
    me.winStreak = 0;
    me.lossStreak = 4;
    me.declinedOffers = 4;
    me.lastFightDate = addDays(save.date, -200);
    expect(computeLeverage(me, save).score).toBeLessThanOrEqual(22);

    advance(save, { mode: 'week', stopOnDecision: false });
    expect(contract.status).toBe('released');
    expect(contract.endDate).toBeTruthy();
    expect(me.activityStatus).toBe('released');
    expect(Object.values(save.contractOffers).filter((o) => o.fighterId === me.id && o.status === 'open')).toHaveLength(0);
    expect(save.inbox.some((m) => m.subject === 'Contract not renewed')).toBe(true);

    advance(save, { mode: 'week', stopOnDecision: false });
    expect(Object.values(save.contractOffers).filter((o) => o.fighterId === me.id)).toHaveLength(0);

    // Once the wait is served the promotion comes back.
    contract.endDate = addDays(save.date, -RELEASE_RETURN_DAYS);
    advance(save, { mode: 'week', stopOnDecision: false });
    expect(Object.values(save.contractOffers).filter((o) => o.fighterId === me.id && o.status === 'open').length).toBeGreaterThan(0);
  });
});
