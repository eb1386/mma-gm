import { describe, expect, it } from 'vitest';
import { loadSnapshot } from './testing/fixtures';
import { buildCreatedFighter, createNewGame, type CreateFighterInput } from './world/newgame';
import { CREATION_PRESETS } from './world/generator';
import { advance, simulatePlayerBout } from './world/tick';
import { respondToOffer } from './world/offers';
import { careerStatus, retireFighter } from './world/career';
import { resolveMessage } from './world/inbox';
import { acceptOpponentMiss, applySecondAttempt, beginWeighIn, resolveOpponentDecision, stepWeighIn } from './world/weighin';
import { Rng } from './rng';
import { ageOn, daysBetween } from './types/common';
import { PROMOTION_NAME } from './config/branding';
import {
  applyRegionalResult,
  callUpReadiness,
  inviteToTryout,
  isAmateurFighter,
  isRegionalChampion,
  offerCallUp,
  regionalChampionId,
  regionalStandings,
  signCallUpOffer,
} from './world/regional';
import type { SaveGame } from './types/save';
import type { Bout, FightResult } from './types/fight';
import { PROVING_GROUND_ID } from './config/regional';
import { buildRecordBooks } from './world/history';

function input(overrides: Partial<CreateFighterInput> = {}): CreateFighterInput {
  const preset = CREATION_PRESETS.find((p) => p.key === (overrides.presetKey ?? 'raw-prospect'))!;
  const even = Math.floor(preset.points / 6);
  return {
    firstName: 'Test',
    lastName: 'Prospect',
    nickname: null,
    country: 'United States',
    hometown: null,
    age: 16,
    heightIn: 70,
    walkingWeightLb: 170,
    divisionId: 'lightweight',
    build: 'balanced',
    reachIn: 72,
    stance: 'orthodox',
    gymId: null,
    presetKey: preset.key,
    allocation: { striking: even, grappling: even, wrestling: even, submissions: even, cardio: even, durability: even },
    startingRecord: preset.startingRecord,
    ...overrides,
  };
}

function regionalCareer(seed: number, age: number, promotion = 'rp-lone-star', presetKey = 'raw-prospect'): SaveGame {
  const snap = loadSnapshot();
  const created = buildCreatedFighter(input({ age, presetKey }), seed, snap.meta.snapshotDate);
  return createNewGame(snap, {
    saveName: 'regional',
    seed,
    mode: 'fighter',
    createdFighter: created,
    regionalPromotionId: promotion,
    settings: { potPaths: 8 },
  }).save;
}

/** Steps through the official weigh in, accepting a miss if it comes to that. */
function weighInFor(save: SaveGame, boutId: string): void {
  beginWeighIn(save, boutId);
  for (let steps = 0; steps < 12 && save.weighIns?.[boutId]?.stage !== 'complete'; steps++) {
    const state = save.weighIns![boutId];
    if (state.stage === 'second-attempt-decision') applySecondAttempt(save, boutId, 'accept-miss');
    else if (state.stage === 'catchweight-negotiation') resolveOpponentDecision(save, boutId, new Rng(steps));
    else if (state.stage === 'opponent-decision') acceptOpponentMiss(save, boutId, true);
    else stepWeighIn(save, boutId);
  }
}

/** Plays like a player who accepts every offer, plans a camp and fights every bout. */
function play(save: SaveGame, until: string, rng: Rng): number {
  const me = save.fighters[save.player.fighterId!];
  let fights = 0;
  for (let step = 0; step < 600 && save.date < until; step++) {
    for (const m of save.inbox) {
      if (m.status === 'resolved' || m.status === 'expired') continue;
      if (m.linkedOfferId && save.fightOffers[m.linkedOfferId]?.status === 'open') {
        respondToOffer(save, m.linkedOfferId, { kind: 'accept' }, rng);
        continue;
      }
      if (m.linkedOfferId && save.contractOffers[m.linkedOfferId]) continue;
      if (m.requiresAction && m.choices[0]) resolveMessage(save, m.id, m.choices[0].key, 'test');
    }
    const status = careerStatus(save);
    // The official weigh in is mandatory and the clock stops for it, so a player has to step on
    // the scale before the fight is offered.
    if (status.boutId && status.fightWeekStage === 'official-weigh-in') {
      weighInFor(save, status.boutId);
      continue;
    }
    if (status.state === 'fight-ready' && status.boutId) {
      simulatePlayerBout(save, status.boutId, ['pressure']);
      fights++;
      continue;
    }
    advance(save, { mode: 'week', stopOnDecision: true });
  }
  void me;
  return fights;
}

describe('creating a fighter', () => {
  it('sanitises the form and keeps the record, the method totals and the age consistent', () => {
    const today = '2026-07-29';
    const f = buildCreatedFighter(input({ age: Number.NaN, heightIn: Number.NaN, reachIn: Number.NaN, walkingWeightLb: Number.NaN }), 5, today);
    expect(Number.isFinite(f.heightIn)).toBe(true);
    expect(Number.isFinite(f.reachIn)).toBe(true);
    expect(Number.isFinite(f.walkingWeightLb)).toBe(true);
    for (const age of [16, 21, 33]) {
      // Each age within a preset that allows it: a raw prospect is held to twenty seven at most.
      const presetKey = age >= 30 ? 'late-veteran' : 'raw-prospect';
      const g = buildCreatedFighter(input({ age, presetKey, startingRecord: { wins: 9, losses: 2 } }), age, today);
      // The fighter is exactly the age the player chose, on the day the career starts.
      expect(ageOn(g.birthDate, today)).toBe(age);
      const m = g.methods;
      expect(m.koWins + m.subWins + m.decWins).toBe(9);
      expect(m.koLosses + m.subLosses + m.decLosses).toBe(2);
      expect(g.winStreak).toBeLessThanOrEqual(9);
    }
  });

  it('gives a raw prospect more headroom than a late career veteran built with the same ratings', () => {
    const today = '2026-07-29';
    const same = { striking: 55, grappling: 55, wrestling: 55, submissions: 55, cardio: 55, durability: 55 };
    let raw = 0;
    let vet = 0;
    for (let seed = 1; seed <= 30; seed++) {
      raw += buildCreatedFighter(input({ presetKey: 'raw-prospect', age: 25, allocation: same }), seed, today).development.hiddenCeiling;
      vet += buildCreatedFighter(input({ presetKey: 'late-veteran', age: 25, allocation: same }), seed, today).development.hiddenCeiling;
    }
    // The presets differ by fourteen points of ceiling bias.
    expect(raw / 30).toBeGreaterThan(vet / 30 + 10);
  });

  it('holds each preset to its own range of ages', () => {
    const today = '2026-07-29';
    // A sixteen year old late career veteran used to start with the veteran's full budget and
    // record and a whole career of Longevity ahead of them.
    const vet = buildCreatedFighter(input({ presetKey: 'late-veteran', age: 16 }), 1, today);
    expect(ageOn(vet.birthDate, today)).toBeGreaterThanOrEqual(30);
    expect(vet.longevity).toBeLessThanOrEqual(85);
    // Starting at sixteen is what the raw prospect is for.
    const raw = buildCreatedFighter(input({ presetKey: 'raw-prospect', age: 16 }), 1, today);
    expect(ageOn(raw.birthDate, today)).toBe(16);
  });

  it('gives a raw prospect the highest ceiling of the presets', () => {
    const today = '2026-07-29';
    const mean = (presetKey: string, age: number) => {
      let total = 0;
      for (let seed = 1; seed <= 20; seed++) total += buildCreatedFighter(input({ presetKey, age }), seed, today).development.hiddenCeiling;
      return total / 20;
    };
    // The ceiling used to be an offset from the deliberately low starting Ovr, which gave the raw
    // prospect, promised the highest ceiling, the lowest of all.
    expect(mean('raw-prospect', 21)).toBeGreaterThan(mean('balanced-prospect', 24));
    expect(mean('balanced-prospect', 24)).toBeGreaterThan(mean('experienced-signing', 29));
    expect(mean('raw-prospect', 21)).toBeGreaterThan(80);
  });

  it('projects Pot for the created fighter at creation rather than leaving it at zero', () => {
    const snap = loadSnapshot();
    const created = buildCreatedFighter(input({ age: 22, presetKey: 'balanced-prospect' }), 3, snap.meta.snapshotDate);
    const { save } = createNewGame(snap, { saveName: 'pot', seed: 3, mode: 'fighter', createdFighter: created, settings: { potPaths: 8 } });
    expect(save.fighters[save.player.fighterId!].pot).toBeGreaterThan(0);
  });
});

describe('the regional circuit', () => {
  it('starts a sixteen year old as an unpaid amateur with a regional roster', () => {
    const save = regionalCareer(11, 16);
    const me = save.fighters[save.player.fighterId!];
    expect(isAmateurFighter(me)).toBe(true);
    expect(me.record.wins + me.record.losses).toBe(0);
    expect(me.amateurRecord?.wins).toBeGreaterThan(0);
    const contract = save.contracts[me.contractId!];
    expect(contract.terms.showPay).toBe(0);
    expect(contract.promotion).toContain('amateur');
    expect(save.regional?.turnsProOn).toBeTruthy();
    const roster = Object.values(save.fighters).filter((f) => f.circuit === 'rp-lone-star');
    expect(roster.length).toBeGreaterThanOrEqual(13);
    // Nobody on the circuit appears anywhere in the main promotion's rankings.
    for (const table of Object.values(save.rankings)) {
      for (const e of table.entries) expect(save.fighters[e.fighterId].circuit).toBeFalsy();
    }
    const readiness = callUpReadiness(save, me);
    expect(readiness.blockers.length).toBeGreaterThan(0);
  });

  it('runs a career of regional fights without ever touching the main promotion', () => {
    const save = regionalCareer(21, 22, 'rp-rust-belt', 'balanced-prospect');
    const rng = new Rng(99);
    const fights = play(save, '2027-10-01', rng);
    const me = save.fighters[save.player.fighterId!];
    expect(fights).toBeGreaterThanOrEqual(4);
    // Regional bouts are professional bouts but never promotional ones.
    expect(me.ufcRecord.wins + me.ufcRecord.losses).toBe(0);
    expect(me.record.wins + me.record.losses + me.record.draws).toBeGreaterThanOrEqual(9 + fights - 1);
    for (const table of Object.values(save.rankings)) {
      expect(table.championId ? save.fighters[table.championId].circuit : null).toBeFalsy();
      for (const e of table.entries) expect(save.fighters[e.fighterId].circuit).toBeFalsy();
    }
    for (const e of save.pfp.entries) expect(save.fighters[e.fighterId].circuit).toBeFalsy();
    for (const bout of Object.values(save.bouts)) {
      const regional = Boolean(save.events[bout.eventId]?.promotionId);
      for (const id of [bout.fighterAId, bout.fighterBId]) {
        // A circuit fighter on a main card, or a main roster fighter on a regional card, is the
        // one thing the separation exists to prevent. A graduate keeps their old regional bouts.
        if (!regional) expect(save.fighters[id].circuit).toBeFalsy();
      }
    }
    // Every main promotion card still exists; regional cards did not take their weekends.
    const mainCards = Object.values(save.events).filter((e) => !e.promotionId).length;
    expect(mainCards).toBeGreaterThan(30);
    const standing = regionalStandings(save, 'rp-rust-belt', me.divisionId);
    expect(standing.entries.length).toBeGreaterThan(5);
  }, 600_000);

  it('signs the call up: the belt is vacated and the fighter joins the main roster', () => {
    const save = regionalCareer(31, 24, 'rp-lone-star', 'balanced-prospect');
    const rng = new Rng(7);
    const me = save.fighters[save.player.fighterId!];
    // Make the player the regional champion, then call them up.
    save.regional!.champions[`rp-lone-star|${me.divisionId}`] = me.id;
    const offer = offerCallUp(save, me, rng, 'Test.');
    expect(offer.callUp).toBe(true);
    signCallUpOffer(save, me, offer, null);
    expect(me.circuit).toBeNull();
    expect(save.contracts[me.contractId!].promotion).toBe(PROMOTION_NAME);
    expect(save.contracts[me.contractId!].status).toBe('active');
    expect(regionalChampionId(save, 'rp-lone-star', me.divisionId)).toBeNull();
    expect(save.regional!.playerPromotionId).toBeNull();
    expect(save.regional!.graduates[0].fighterId).toBe(me.id);
    expect(me.ufcRecord.wins + me.ufcRecord.losses).toBe(0);
    // The debut the call up promises is offered at once, against another newcomer on a card a
    // camp away. It used to be left to the card seeding, and a called up fighter waited a year.
    const debut = Object.values(save.fightOffers).find((o) => o.status === 'open' && o.fighterId === me.id)!;
    expect(debut).toBeTruthy();
    expect(debut.bookingKind).toBe('debut');
    const opponent = save.fighters[debut.opponentId];
    expect(opponent.ranking).toBeNull();
    expect(opponent.ufcRecord.wins + opponent.ufcRecord.losses + opponent.ufcRecord.draws + opponent.ufcRecord.noContests).toBeLessThanOrEqual(3);
    expect(daysBetween(save.date, save.events[debut.eventId].date)).toBeLessThanOrEqual(90);
    // No regional card is scheduled any more, and a few weeks on the main promotion is
    // matching the new signing.
    advance(save, { mode: 'month', stopOnDecision: false });
    expect(Object.values(save.events).filter((e) => e.promotionId && e.status === 'announced' && e.date > save.date && e.boutIds.length === 0)).toHaveLength(0);
  });
});

describe('the regional path', () => {
  it('starts the professional career with no streak carried over from the amateurs', () => {
    const save = regionalCareer(11, 16, 'rp-rust-belt');
    const me = save.fighters[save.player.fighterId!];
    me.winStreak = 0;
    me.lossStreak = 4;
    save.regional!.turnsProOn = save.date;
    advance(save, { mode: 'week', stopOnDecision: false });
    expect(isAmateurFighter(me)).toBe(false);
    expect(me.lossStreak).toBe(0);
    expect(me.winStreak).toBe(0);
    expect(callUpReadiness(save, me).factors.find((f) => f.key === 'form')?.detail).toBe('No streak');
  });

  it('retires an amateur on the amateur record, not 0 and 0 in the promotion', () => {
    const save = regionalCareer(11, 16, 'rp-rust-belt');
    const me = save.fighters[save.player.fighterId!];
    const am = me.amateurRecord!;
    const result = retireFighter(save, me, 'Done.');
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`${am.wins}-${am.losses}${am.draws ? `-${am.draws}` : ''} as an amateur`);
  });

  it('shows an amateur as an amateur in the readiness breakdown, not ranked', () => {
    const save = regionalCareer(11, 16, 'rp-rust-belt');
    const me = save.fighters[save.player.fighterId!];
    const standing = callUpReadiness(save, me).factors.find((f) => f.key === 'standing')!;
    expect(standing.detail).toBe('Amateur');
    expect(standing.points).toBe(0);
  });

  it('judges a created fighter on the circuit before any call up or tryout', () => {
    const save = regionalCareer(1, 25, 'rp-pacific-coast', 'experienced-signing');
    const me = save.fighters[save.player.fighterId!];
    advance(save, { mode: 'week', stopOnDecision: false });
    const callUps = () => Object.values(save.contractOffers).filter((o) => o.callUp);
    const tryouts = () => Object.values(save.fightOffers).filter((o) => o.bookingKind === 'tryout');
    expect(callUps()).toHaveLength(0);
    expect(tryouts()).toHaveLength(0);
    expect(callUpReadiness(save, me).blockers).toContain('At least one bout on the PCCS circuit first.');
    // Once a circuit bout is behind them, the imported record counts again.
    const rng = new Rng(5);
    for (let i = 0; i < 20 && !Object.values(save.history.results).some((r) => r.winnerId === me.id); i++) {
      play(save, addWeek(save.date), rng);
    }
    expect(Object.values(save.history.results).some((r) => r.winnerId === me.id)).toBe(true);
    if (me.circuit) expect(callUpReadiness(save, me).blockers.filter((b) => b.includes('circuit first'))).toHaveLength(0);
  }, 600_000);

  it('credits a tryout winner to the circuit they came from', () => {
    const save = regionalCareer(3, 25, 'rp-lone-star', 'balanced-prospect');
    const me = save.fighters[save.player.fighterId!];
    expect(inviteToTryout(save, new Rng(4), me)).toBe(true);
    const offer = Object.values(save.fightOffers).find((o) => o.bookingKind === 'tryout')!;
    const opp = save.fighters[offer.opponentId];
    expect(opp.originPromotionId).toBeTruthy();
    expect(opp.originPromotionId).not.toBe(PROVING_GROUND_ID);
    const bout = { id: 'bout-tryout-test', eventId: offer.eventId, fighterAId: me.id, fighterBId: opp.id, divisionId: me.divisionId } as Bout;
    const result = { boutId: bout.id, eventId: offer.eventId, date: save.date, winnerId: opp.id, loserId: me.id, method: 'decision-unanimous' } as FightResult;
    applyRegionalResult(save, bout, result, new Rng(6));
    expect(opp.circuit).toBeNull();
    expect(save.regional!.graduates[0]).toMatchObject({ fighterId: opp.id, promotionId: opp.originPromotionId });
  });

  it('gives a regional champion only title fights on the circuit', () => {
    const save = regionalCareer(9, 20, 'rp-rust-belt', 'balanced-prospect');
    const me = save.fighters[save.player.fighterId!];
    const state = save.regional!;
    const key = `rp-rust-belt|${me.divisionId}`;
    const old = state.reigns.find((r) => r.fighterId === state.champions[key] && !r.lostOn);
    if (old) old.lostOn = save.date;
    state.champions[key] = me.id;
    state.reigns.push({ promotionId: 'rp-rust-belt', divisionId: me.divisionId, fighterId: me.id, wonOn: save.date, wonBoutId: null, lostOn: null, defenses: 0 });
    const rng = new Rng(2);
    for (let i = 0; i < 40 && isRegionalChampion(save, me) && me.circuit; i++) play(save, addWeek(save.date), rng);
    // Every circuit offer made while the belt was held, whatever became of it.
    const lostOn = state.reigns.find((r) => r.fighterId === me.id)?.lostOn ?? '9999-12-31';
    const whileChampion = Object.values(save.fightOffers).filter((o) => o.fighterId === me.id && o.bookingKind === 'regional' && o.createdOn < lostOn);
    expect(whileChampion.length).toBeGreaterThan(0);
    for (const o of whileChampion) expect(o.regionalTitle).toBe(true);
  }, 600_000);

  it('gives a strong number one contender a regional title shot', () => {
    const snap = loadSnapshot();
    const preset = CREATION_PRESETS.find((p) => p.key === 'raw-prospect')!;
    const even = Math.floor(preset.points / 6) + 12;
    const allocation = { striking: even, grappling: even, wrestling: even, submissions: even, cardio: even, durability: even };
    const created = buildCreatedFighter(input({ age: 20, allocation }), 11, snap.meta.snapshotDate);
    const save = createNewGame(snap, { saveName: 'title', seed: 11, mode: 'fighter', createdFighter: created, regionalPromotionId: 'rp-rust-belt', settings: { potPaths: 8 } }).save;
    const me = save.fighters[save.player.fighterId!];
    const rng = new Rng(12);
    let titleOffer = false;
    for (let i = 0; i < 160 && !titleOffer && me.circuit && save.date < '2029-10-01'; i++) {
      play(save, addWeek(save.date), rng);
      titleOffer = Object.values(save.fightOffers).some((o) => o.fighterId === me.id && o.regionalTitle);
    }
    expect(titleOffer).toBe(true);
  }, 600_000);
});

describe('money on the regional circuit', () => {
  it('starts an amateur with no career purses and savings to cover the amateur years', () => {
    const save = regionalCareer(41, 16);
    const me = save.fighters[save.player.fighterId!];
    expect(isAmateurFighter(me)).toBe(true);
    expect(me.careerEarnings).toBe(0);
    expect(save.finance!.cash).toBeGreaterThan(0);
    expect(save.player.balance).toBe(save.finance!.cash);
    // Savings are not earnings.
    expect(save.finance!.careerEarnings).toBe(0);
  });

  it('pays an amateur no sponsorship over a year and keeps them near solvent', () => {
    const save = regionalCareer(11, 16, 'rp-rust-belt');
    const meId = save.player.fighterId!;
    const rng = new Rng(11);
    const start = save.date;
    const until = `${Number(start.slice(0, 4)) + 1}${start.slice(4)}`;
    let fights = 0;
    // A week at a time, signing anything offered, which is how the six figure amateur deals showed.
    for (let i = 0; i < 60 && save.date < until; i++) {
      for (const s of Object.values(save.sponsors ?? {})) if (s.status === 'offered') s.status = 'active';
      fights += play(save, addWeek(save.date), rng);
    }
    expect(isAmateurFighter(save.fighters[meId])).toBe(true);
    expect(fights).toBeGreaterThan(0);
    expect(Object.values(save.sponsors ?? {}).filter((s) => s.id.startsWith(`sponsor-${meId}-`))).toHaveLength(0);
    expect(save.finance!.kindTotals?.[meId]?.in.sponsorship ?? 0).toBe(0);
    // Costs are scaled to a teenager living at home, so a year of amateur bouts is not a debt.
    expect(save.finance!.cash).toBeGreaterThan(-1500);
  });
});

describe('the promotion\'s books and milestones', () => {
  it('keeps amateur and regional bouts out of the record books and the promotion milestones', () => {
    const save = regionalCareer(11, 16);
    const fights = play(save, '2027-04-01', new Rng(5));
    const me = save.fighters[save.player.fighterId!];
    expect(fights).toBeGreaterThan(0);
    expect(me.boutIds.length).toBeGreaterThan(0);
    const keys = (save.player.achievements ?? []).map((a) => a.key);
    // Every one of these fights was amateur on a regional card: nothing in the promotion yet.
    expect(keys).not.toContain('first-fight');
    expect(keys).not.toContain('first-win');
    expect(keys).not.toContain('first-finish');
    // No row in the promotion's record books comes from a circuit fighter or a regional card.
    const regionalIds = new Set(
      Object.values(save.history.results)
        .filter((r) => save.events[r.eventId]?.promotionId)
        .flatMap((r) => [r.fighterAId, r.fighterBId])
    );
    expect(regionalIds.size).toBeGreaterThan(0);
    for (const book of buildRecordBooks(save)) {
      for (const row of book.rows) {
        if (!row.fighterId) continue;
        expect(save.fighters[row.fighterId]?.circuit, `${book.key}: ${row.name}`).toBeFalsy();
      }
    }
  }, 600_000);

  it('awards a fighter who started ranked no ranking or title milestones in the first week', () => {
    const snap = loadSnapshot();
    for (const pick of [
      (f: (typeof snap.fighters)[number]) => f.ranking !== null && f.ranking <= 3,
      (f: (typeof snap.fighters)[number]) => snap.rankings.some((r) => r.championId === f.id),
    ]) {
      const target = snap.fighters.find(pick)!;
      const { save } = createNewGame(snap, { saveName: 'ranked', seed: 17, mode: 'fighter', playerFighterId: target.id, settings: { potPaths: 6 } });
      expect(save.player.startRanking).not.toBeNull();
      advance(save, { mode: 'week', stopOnDecision: false });
      const keys = (save.player.achievements ?? []).map((a) => a.key);
      for (const key of ['ranked', 'top-five', 'number-one', 'champion']) expect(keys, target.name).not.toContain(key);
    }
  }, 600_000);
});

function addWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}
