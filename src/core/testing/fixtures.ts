import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../rng';
import { addDays, type BoutId, type IsoDate } from '../types/common';
import type { Injury } from '../types/fighter';
import type { SnapshotFile } from '../data/snapshot';
import type { SaveGame } from '../types/save';
import type { FightCardEvent } from '../types/world';
import { createNewGame } from '../world/newgame';
import { bookBout } from '../world/availability';
import { ensureFightWeekTasks } from '../world/fightweek';
import { createFightOffer } from '../world/offers';
import { checkPlayerInjuries } from '../world/injury-flow';
import { createCamp, CAMP_PRESETS } from '../world/camp';
import { advance, simulatePlayerBout } from '../world/tick';
import { messageNeedsAction } from '../world/inbox';

/**
 * Deterministic setup helpers for tests.
 *
 * Reaching a booked bout, an injury during camp, or fight week by advancing a year of
 * simulation is slow and indirect. These helpers construct the exact state a test needs in
 * a few milliseconds, using the same transactions the game uses, so the state is real
 * rather than hand assembled.
 */

let cachedSnapshot: SnapshotFile | null = null;

/** Loads the snapshot once per process. Parsing it repeatedly dominated the test suite. */
export function loadSnapshot(): SnapshotFile {
  if (cachedSnapshot) return cachedSnapshot;
  const dir = join(process.cwd(), 'public', 'data');
  if (!existsSync(dir)) throw new Error('Build the snapshot first: npx vite-node tools/build-snapshot.ts');
  const file = readdirSync(dir).find((f) => f.startsWith('snapshot-'));
  if (!file) throw new Error('Build the snapshot first: npx vite-node tools/build-snapshot.ts');
  cachedSnapshot = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SnapshotFile;
  return cachedSnapshot;
}

export interface CareerFixture {
  save: SaveGame;
  playerId: string;
  rng: Rng;
}

/**
 * A fresh fighter career.
 *
 * `light` builds a much smaller world: enough of a roster to book fights and keep rankings
 * coherent, but without the full generated depth or the Pot projection pass. Tests that do
 * not measure roster size or Pot use it and run in a fraction of the time.
 */
export function newCareer(seed: number, opts: { light?: boolean; divisionId?: string } = {}): CareerFixture {
  const snapshot = loadSnapshot();
  const target =
    snapshot.fighters.find((f) => (opts.divisionId ? f.divisionId === opts.divisionId : true) && f.ranking !== null && f.ranking > 6) ??
    snapshot.fighters[0];
  const { save } = createNewGame(snapshot, {
    saveName: `fixture-${seed}`,
    seed,
    mode: 'fighter',
    playerFighterId: target.id,
    settings: opts.light ? { potPaths: 6, fillRosterWithGenerated: true } : undefined,
  });
  return { save, playerId: target.id, rng: new Rng(seed) };
}

/** A fighter career with a bout already booked, without advancing the calendar. */
export function bookedCareer(
  seed: number,
  opts: { daysOut?: number; isTitleFight?: boolean } = {}
): CareerFixture & { boutId: BoutId; opponentId: string } {
  const fixture = newCareer(seed, { light: true });
  const { save, playerId } = fixture;
  const me = save.fighters[playerId];
  const opponent = Object.values(save.fighters).find(
    (f) => f.id !== me.id && f.divisionId === me.divisionId && !f.retired && !f.nextBoutId
  )!;
  const daysOut = opts.daysOut ?? 60;
  const date = addDays(save.date, daysOut);
  const event = createEvent(save, date);

  const boutId: BoutId = `bout-fixture-${++save.counters.bout}`;
  const booking = bookBout(save, {
    id: boutId,
    eventId: event.id,
    date,
    fighterAId: me.id,
    fighterBId: opponent.id,
    divisionId: me.divisionId,
    contractedWeightLb: 155,
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
  if (!booking.created) throw new Error(`Fixture could not book the bout: ${booking.reason}`);
  return { ...fixture, boutId, opponentId: opponent.id };
}

/** A career in fight week, with the stage tasks generated. */
export function fightWeekCareer(seed: number, opts: { daysOut?: number; isTitleFight?: boolean } = {}) {
  const fixture = bookedCareer(seed, { daysOut: opts.daysOut ?? 3, isTitleFight: opts.isTitleFight });
  ensureFightWeekTasks(fixture.save, fixture.boutId);
  return fixture;
}

/** A booked career where the player is injured, with the decision already raised. */
export function injuredBookedCareer(
  seed: number,
  opts: { blocking?: boolean; severity?: 1 | 2 | 3 | 4 | 5; returnDays?: number; daysOut?: number } = {}
) {
  const fixture = bookedCareer(seed, { daysOut: opts.daysOut ?? 60 });
  const me = fixture.save.fighters[fixture.playerId];
  me.injuries.push(makeInjury(fixture.save.date, opts));
  checkPlayerInjuries(fixture.save);
  return fixture;
}

export function makeInjury(on: IsoDate, opts: { blocking?: boolean; severity?: 1 | 2 | 3 | 4 | 5; returnDays?: number } = {}): Injury {
  const blocking = opts.blocking ?? true;
  return {
    id: `inj-fixture-${on}-${blocking ? 'b' : 'n'}`,
    type: blocking ? 'Torn knee ligament' : 'Knee sprain',
    area: 'knee',
    severity: opts.severity ?? (blocking ? 4 : 2),
    startedAt: on,
    expectedReturn: addDays(on, opts.returnDays ?? 120),
    actualReturn: null,
    cause: 'training',
    trainingCapacity: blocking ? 0.25 : 0.7,
    effects: {},
    blocksCompetition: blocking,
    recurrenceChance: 0.2,
    treatment: 'rest',
    note: 'Created by a test fixture.',
  };
}

/** Creates a card on a given date so a fixture can book onto it. */
export function createEvent(save: SaveGame, date: IsoDate, name = 'Fixture Card'): FightCardEvent {
  const id = `evt-fixture-${++save.counters.event}`;
  const event: FightCardEvent = {
    id,
    name,
    date,
    city: 'Las Vegas',
    country: 'United States',
    countryCode: 'US',
    venue: 'a large indoor arena',
    tier: 'numbered-ppv' as const,
    status: 'announced' as const,
    boutIds: [] as BoutId[],
    announcedBoutIds: [] as BoutId[],
    weighInBoutIds: [] as BoutId[],
    contestedBoutIds: [] as BoutId[],
    canceledBoutIds: [] as BoutId[],
    plannedBouts: 12,
    plannedMain: 5,
    plannedPrelim: 4,
    plannedEarly: 3,
    fightOfTheNightBoutId: null,
    performanceBonusFighterIds: [] as string[],
    attendance: null,
    drawScore: 0,
    bonusAmount: 50000,
  };
  save.events[id] = event;
  return event;
}

/** A career with an open offer waiting for an answer. */
export function offeredCareer(seed: number, opts: { daysOut?: number } = {}) {
  const fixture = newCareer(seed, { light: true });
  const { save, playerId } = fixture;
  const me = save.fighters[playerId];
  const opponent = Object.values(save.fighters).find(
    (f) => f.id !== me.id && f.divisionId === me.divisionId && !f.retired && !f.nextBoutId
  )!;
  const event = createEvent(save, addDays(save.date, opts.daysOut ?? 70));
  const offer = createFightOffer(save, me, opponent, event as never, fixture.rng, {
    isMainEvent: false,
    isTitleFight: false,
    isInterimTitleFight: false,
    scheduledRounds: 3,
    reason: 'test fixture offer',
    isReplacementSlot: false,
  });
  if (!offer) throw new Error('Fixture could not create the offer.');
  return { ...fixture, offerId: offer.id, opponentId: opponent.id, eventId: event.id };
}


/** Creates one camp for a booked bout, using the same transaction the game uses. */
export function planCamp(save: SaveGame, fighterId: string, boutId: BoutId, presetKey = 'balanced') {
  const fighter = save.fighters[fighterId];
  const bout = save.bouts[boutId];
  const preset = CAMP_PRESETS.find((p) => p.key === presetKey) ?? CAMP_PRESETS[0];
  const camp = createCamp(save, fighter, {
    boutId,
    startDate: save.date,
    endDate: addDays(bout.date, -1),
    focus: preset.focus,
    intensity: preset.intensity,
    gymId: fighter.gymId,
    campType: 'home',
    specialistHired: null,
    gamePlan: preset.plans,
    arriveEarlyDays: 4,
  });
  save.camps[camp.id] = camp;
  return camp;
}

/**
 * Runs the world forward for a number of weeks.
 *
 * `advanceUntil` stops the moment the player has something to answer, which is correct for the
 * game and useless for a world level test: a career fixture blocks within days, so a test that
 * asked for a year of simulation was quietly getting less than a week of it. This answers
 * whatever is blocking and keeps going, so a test that says a year gets a year.
 */
export function runWorld(save: SaveGame, weeks: number): { weeksRun: number; playerFights: number } {
  let playerFights = 0;
  let weeksRun = 0;
  for (let w = 0; w < weeks; w++) {
    for (const m of save.inbox) {
      if (!messageNeedsAction(save, m)) continue;
      m.status = 'resolved';
      m.resolution = 'answered by the world test harness';
      m.decisionResolvedOn = save.date;
    }
    save.pendingDecision = null;
    const report = advance(save, { mode: 'week', stopOnDecision: false });
    if (report.playerBoutPending) {
      simulatePlayerBout(save, report.playerBoutPending, ['pressure']);
      playerFights++;
    }
    weeksRun++;
  }
  return { weeksRun, playerFights };
}
