import { contractedWeight, DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { DIFFICULTY } from '../config/calibration';
import {
  MIN_REGIONAL_START_AGE,
  PRO_AGE,
  PROVING_GROUND_ID,
  REGIONAL_LEVELS,
  REGIONAL_PROMOTION_BY_ID,
  type RegionalPromotionConfig,
} from '../config/regional';
import { PROMOTION_ABBREVIATION, PROMOTION_CONTRACTS, PROMOTION_NAME } from '../config/branding';
import { bankForCountry } from '../data/names';
import { clamp, Rng } from '../rng';
import { addDays, ageOn, dayOfWeek, daysBetween, formatDate, formatMoney, type BoutId, type FighterId, type IsoDate } from '../types/common';
import { isFinish, type Bout, type FightResult } from '../types/fight';
import { ovrDisplayed, type CareerMethodTotals, type Fighter, type FightRecord, historyRatings } from '../types/fighter';
import type { SaveGame } from '../types/save';
import type { Contract, ContractOffer, FightCardEvent } from '../types/world';
import { bookBout, hasLiveBooking, offerBlockReason, releaseBooking } from './availability';
import { canCompete } from './health';
import { generateFighter, pickNameBank } from './generator';
import { generateFame, generateSocial } from './identity';
import { updatePot } from './pot';
import { potConfidenceFor } from './development';
import { createFightOffer } from './offers';
import { createContractOffer, generateContract, signContractOffer } from './economy';
import { addInboxMessage, resolveMessagesForOffer } from './inbox';
import { pushNews } from './history';
import { moveFighterToGym } from './gyms';
import { offerPlayerDebut } from './debut';
import type { NegotiationRound } from '../types/world';

/**
 * The regional circuit and the call up.
 *
 * A created fighter can start below the main promotion, on a fictional regional promotion, as
 * young as sixteen. Bouts before eighteen are amateur. From there the career is the one players
 * asked for: fight on small cards, climb a regional ranking, win a regional belt, and get called up
 * when the main promotion decides the record, the regional standing and the ability are there.
 *
 * Only the player's own promotion is simulated, and only in the division the player fights at, so
 * the cost is a dozen extra fighters rather than a second world. Every regional fight still runs
 * through the same engine, camp, fight week and fight page as a main promotion fight.
 */

export interface RegionalReign {
  promotionId: string;
  divisionId: DivisionId;
  fighterId: FighterId;
  wonOn: IsoDate;
  wonBoutId: BoutId | null;
  lostOn: IsoDate | null;
  defenses: number;
}

export interface CallUpState {
  /** The last readiness score, 0 to 100. */
  readiness: number;
  /** One reading per month, for the chart on the regional page. */
  history: { date: IsoDate; readiness: number }[];
  /** When the main promotion last put a contract in front of the player. */
  offeredOn: IsoDate | null;
  tryoutInvitedOn: IsoDate | null;
  tryoutsLost: number;
  calledUpOn: IsoDate | null;
}

export interface RegionalState {
  /** The promotion the player fights for. Null once called up. */
  playerPromotionId: string | null;
  /** Promotions whose cards are running, and the divisions each one runs. */
  circuits: Record<string, { divisions: DivisionId[]; eventNumber: number }>;
  /** Regional champions, keyed `promotionId|divisionId`. */
  champions: Record<string, FighterId | null>;
  reigns: RegionalReign[];
  /** Standing points per fighter on the circuit. */
  points: Record<FighterId, number>;
  callUp: CallUpState;
  /** Fighters who left the circuit for the main promotion, newest first. */
  graduates: { fighterId: FighterId; promotionId: string; date: IsoDate; wasChampion: boolean }[];
  /** The day the player turns professional, for a career that started as an amateur. */
  turnsProOn: IsoDate | null;
  /** The last calendar month the monthly regional pass ran. */
  lastMonthly: string | null;
}

export const CALL_UP_THRESHOLD = 68;
export const TRYOUT_THRESHOLD = 50;
const TRYOUT_COOLDOWN_DAYS = 300;
const CALL_UP_REOFFER_DAYS = 120;
const AMATEUR = ':am';
const CHAMPION_IDLE_DAYS = 84;
const REGIONAL_TURNAROUND_DAYS = 42;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function promotionConfig(id: string | null | undefined): RegionalPromotionConfig | null {
  if (!id) return null;
  if (id === PROVING_GROUND_ID) return provingGround();
  return REGIONAL_PROMOTION_BY_ID[id.replace(AMATEUR, '')] ?? null;
}

/** The main promotion's tryout series, described in the same shape as a regional promotion. */
export function provingGround(): RegionalPromotionConfig {
  return {
    id: PROVING_GROUND_ID,
    name: `${PROMOTION_ABBREVIATION} Proving Ground`,
    abbreviation: `${PROMOTION_ABBREVIATION} PG`,
    level: 3,
    country: 'United States',
    countryCode: 'US',
    region: 'north-america',
    cities: ['Las Vegas'],
    venueLabel: 'Training Facility',
    blurb: 'A tryout in front of the matchmakers. Win well and a contract follows.',
  };
}

export function promotionOfFighter(f: Fighter | null | undefined): RegionalPromotionConfig | null {
  return promotionConfig(f?.circuit ?? null);
}

export function isAmateurFighter(f: Fighter | null | undefined): boolean {
  return Boolean(f?.circuit?.endsWith(AMATEUR));
}

function championKey(promotionId: string, divisionId: DivisionId): string {
  return `${promotionId}|${divisionId}`;
}

export function regionalChampionId(save: SaveGame, promotionId: string, divisionId: DivisionId): FighterId | null {
  return save.regional?.champions[championKey(promotionId, divisionId)] ?? null;
}

export function isRegionalChampion(save: SaveGame, f: Fighter): boolean {
  if (!f.circuit) return false;
  return regionalChampionId(save, f.circuit, f.divisionId) === f.id;
}

/** Fighters on one promotion's professional roster in one division. */
export function circuitRoster(save: SaveGame, promotionId: string, divisionId: DivisionId): Fighter[] {
  return Object.values(save.fighters).filter(
    (f) => f.circuit === promotionId && f.divisionId === divisionId && !f.retired && f.activityStatus === 'active'
  );
}

export interface RegionalStanding {
  championId: FighterId | null;
  entries: { fighterId: FighterId; rank: number; points: number }[];
}

/** The regional ranking: the champion apart, then everyone else by standing points. */
export function regionalStandings(save: SaveGame, promotionId: string, divisionId: DivisionId): RegionalStanding {
  const championId = regionalChampionId(save, promotionId, divisionId);
  const points = save.regional?.points ?? {};
  const entries = circuitRoster(save, promotionId, divisionId)
    .filter((f) => f.id !== championId)
    .sort((a, b) => (points[b.id] ?? 0) - (points[a.id] ?? 0) || b.record.wins - a.record.wins || a.id.localeCompare(b.id))
    .slice(0, 10)
    .map((f, i) => ({ fighterId: f.id, rank: i + 1, points: Math.round(points[f.id] ?? 0) }));
  return { championId, entries };
}

export function regionalRank(save: SaveGame, f: Fighter): number | null {
  if (!f.circuit) return null;
  return regionalStandings(save, f.circuit, f.divisionId).entries.find((e) => e.fighterId === f.id)?.rank ?? null;
}

function emptyRecord(): FightRecord {
  return { wins: 0, losses: 0, draws: 0, noContests: 0 };
}

function methodsFor(rng: Rng, wins: number, losses: number): CareerMethodTotals {
  const ko = Math.round(wins * clamp(rng.normal(0.38, 0.15), 0.05, 0.75));
  const sub = Math.min(wins - ko, Math.round(wins * clamp(rng.normal(0.26, 0.12), 0.02, 0.6)));
  const koL = Math.round(losses * 0.35);
  const subL = Math.min(losses - koL, Math.round(losses * 0.25));
  return { koWins: ko, subWins: sub, decWins: wins - ko - sub, koLosses: koL, subLosses: subL, decLosses: losses - koL - subL };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** A regional fighter, with a record and a following that fit the level they fight at. */
export function generateRegionalFighter(
  save: SaveGame,
  rng: Rng,
  promotion: RegionalPromotionConfig,
  divisionId: DivisionId,
  opts: { amateur?: boolean; ovr?: number; age?: number } = {}
): Fighter {
  const level = REGIONAL_LEVELS[promotion.level];
  const bank = rng.chance(0.65) ? bankForCountry(promotion.country) ?? pickNameBank(rng) : pickNameBank(rng);
  const age = opts.age ?? (opts.amateur ? rng.int(MIN_REGIONAL_START_AGE, 21) : rng.int(19, 32));
  const targetOvr = opts.ovr ?? rng.normalClamped(level.rosterOvr, level.rosterOvrSd, level.rosterOvr - 12, level.rosterOvr + 11);
  const f = generateFighter(rng, {
    divisionId,
    targetOvr,
    spread: rng.range(4, 11),
    age,
    today: save.date,
    idPrefix: 'reg',
    idNumber: ++save.counters.fighter,
    countryBank: bank,
  });

  if (opts.amateur) {
    const amWins = rng.int(0, 7);
    f.amateurRecord = { wins: amWins, losses: rng.int(0, 3), draws: 0, noContests: 0 };
    f.record = emptyRecord();
    f.methods = methodsFor(rng, 0, 0);
    f.winStreak = Math.min(amWins, rng.int(0, 3));
    f.circuit = `${promotion.id}${AMATEUR}`;
  } else {
    const proFights = Math.round(clamp(rng.normal((age - 19) * 1.5 + 2, 2.5), 0, 24));
    const winRate = clamp(0.55 + (targetOvr - level.rosterOvr) / 28, 0.25, 0.94);
    const wins = Math.round(proFights * winRate);
    const losses = proFights - wins;
    f.record = { wins, losses, draws: 0, noContests: 0 };
    f.methods = methodsFor(rng, wins, losses);
    f.winStreak = Math.min(wins, rng.int(0, 4));
    f.amateurRecord = { wins: rng.int(2, 9), losses: rng.int(0, 3), draws: 0, noContests: 0 };
    f.circuit = promotion.id;
  }
  f.lossStreak = 0;
  f.ufcRecord = emptyRecord();
  f.contractId = null;
  f.gymId = null;
  f.popularity = clamp(Math.round(f.popularity * 0.3 + promotion.level * 2), 1, 30);
  f.regionalPopularity = { [promotion.region]: clamp(Math.round(f.popularity * 1.6), 1, 60) };
  f.careerEarnings = Math.round(f.record.wins * level.baseShowPay * 1.6 + f.record.losses * level.baseShowPay);
  f.lastFightDate = addDays(save.date, -rng.int(20, 150));
  f.fame = generateFame(rng, f);
  f.social = generateSocial(rng, f);
  updatePot(save, f);
  f.potConfidence = potConfidenceFor(f, save.date);
  f.ratingHistory = [
    { date: save.date, ratings: historyRatings(f.ratings), ovr: ovrDisplayed(historyRatings(f.ratings)), pot: f.pot, longevity: f.longevity, reason: 'joined the regional circuit' },
  ];
  save.fighters[f.id] = f;
  if (save.regional && !opts.amateur) {
    save.regional.points[f.id] = clamp(f.record.wins * 3 - f.record.losses * 2 + f.winStreak * 2 + (targetOvr - level.rosterOvr) * 1.2 + rng.range(0, 6), 0, 60);
  }
  return f;
}

/** Keeps the roster of a promotion's division at its size, topping it up after departures. */
export function ensureRegionalRoster(save: SaveGame, rng: Rng, promotionId: string, divisionId: DivisionId): number {
  const promotion = promotionConfig(promotionId);
  if (!promotion || promotionId === PROVING_GROUND_ID) return 0;
  const size = REGIONAL_LEVELS[promotion.level].rosterSize;
  let made = 0;
  while (circuitRoster(save, promotionId, divisionId).length < size && made < size) {
    generateRegionalFighter(save, rng, promotion, divisionId);
    made++;
  }
  return made;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** A regional deal. An amateur registration pays nothing, which is how amateur MMA works. */
export function regionalContract(save: SaveGame, fighter: Fighter, promotion: RegionalPromotionConfig, amateur: boolean): Contract {
  const level = REGIONAL_LEVELS[promotion.level];
  const champion = isRegionalChampion(save, fighter);
  const payScale = save.player.fighterId === fighter.id ? DIFFICULTY[save.settings.difficulty].payScale : 1;
  const raw = level.baseShowPay * (1 + clamp(fighter.record.wins, 0, 15) * 0.06) * (champion ? 1.6 : 1) * payScale;
  const show = amateur ? 0 : Math.max(500, Math.round(raw / 50) * 50);
  const fights = amateur ? 99 : 4;
  save.counters.regionalContract = (save.counters.regionalContract ?? 0) + 1;
  return {
    id: `contract-${fighter.id}-${save.date}-r${save.counters.regionalContract}`,
    fighterId: fighter.id,
    promotion: amateur ? `${promotion.name} amateur division` : promotion.name,
    startDate: save.date,
    endCondition: 'fights-exhausted',
    endDate: null,
    terms: {
      fights,
      showPay: show,
      winBonus: show,
      signingBonus: 0,
      ppvPoints: 0,
      championEscalator: Math.round(show * 0.5),
      mainEventBonus: Math.round(show * 0.25),
      shortNoticeBonus: Math.round(show * 0.25),
      guaranteedMinimum: 0,
      performanceBonusEligible: false,
      exclusive: false,
    },
    fightsRemaining: fights,
    status: 'active',
    isSimulated: true,
    minimumTurnaroundDays: 35,
    injuryExtension: false,
    championClause: champion,
    weightClassClause: null,
    negotiationHistory: [],
    signedOn: save.date,
    note: amateur
      ? 'Amateur registration. Amateurs are not paid and the bouts count toward the amateur record only. Simulated.'
      : `Simulated ${REGIONAL_LEVELS[promotion.level].label.toLowerCase()} deal. Non exclusive: a call up from the main promotion ends it.`,
  };
}

function signRegionalDeal(save: SaveGame, fighter: Fighter, promotion: RegionalPromotionConfig, amateur: boolean): Contract {
  const current = fighter.contractId ? save.contracts[fighter.contractId] : null;
  if (current && current.status === 'active') current.status = 'expired';
  const contract = regionalContract(save, fighter, promotion, amateur);
  save.contracts[contract.id] = contract;
  fighter.contractId = contract.id;
  if (fighter.activityStatus === 'released') fighter.activityStatus = 'active';
  return contract;
}

// ---------------------------------------------------------------------------
// Starting a career on the circuit
// ---------------------------------------------------------------------------

function emptyState(): RegionalState {
  return {
    playerPromotionId: null,
    circuits: {},
    champions: {},
    reigns: [],
    points: {},
    callUp: { readiness: 0, history: [], offeredOn: null, tryoutInvitedOn: null, tryoutsLost: 0, calledUpOn: null },
    graduates: [],
    turnsProOn: null,
    lastMonthly: null,
  };
}

export function regionalStateOf(save: SaveGame): RegionalState {
  if (!save.regional) save.regional = emptyState();
  return save.regional;
}

/**
 * Puts the player on a regional promotion instead of the main roster. A fighter under eighteen
 * starts as an amateur: the starting record becomes the amateur record and the professional record
 * starts at zero.
 */
export function startRegionalCareer(save: SaveGame, fighter: Fighter, promotionId: string, rng: Rng): void {
  const promotion = promotionConfig(promotionId);
  if (!promotion || promotionId === PROVING_GROUND_ID) throw new Error(`Unknown regional promotion ${promotionId}.`);
  const state = regionalStateOf(save);
  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 20;
  const amateur = age < PRO_AGE;

  state.playerPromotionId = promotion.id;
  state.circuits[promotion.id] = { divisions: [fighter.divisionId], eventNumber: rng.int(18, 140) };
  fighter.ufcRecord = emptyRecord();
  fighter.octagonDebut = null;
  if (amateur) {
    fighter.amateurRecord = { ...fighter.record };
    fighter.record = emptyRecord();
    fighter.methods = methodsFor(rng, 0, 0);
    fighter.winStreak = 0;
    fighter.lossStreak = 0;
    fighter.circuit = `${promotion.id}${AMATEUR}`;
    if (fighter.birthDate) {
      const [y, m, d] = fighter.birthDate.split('-');
      state.turnsProOn = `${Number(y) + PRO_AGE}-${m}-${d === '29' && m === '02' ? '28' : d}`;
    }
  } else {
    fighter.amateurRecord = fighter.amateurRecord ?? { wins: rng.int(3, 8), losses: rng.int(0, 2), draws: 0, noContests: 0 };
    fighter.circuit = promotion.id;
  }
  fighter.popularity = clamp(Math.round(fighter.popularity * 0.4), 1, 20);
  // Career purses follow the record onto the circuit. A created fighter's are seeded at main
  // promotion rates, so an amateur who has never been paid showed tens of thousands in career
  // earnings. An amateur has earned nothing; a professional is paid at this level's rates, as the
  // circuit's own fighters are.
  const level = REGIONAL_LEVELS[promotion.level];
  fighter.careerEarnings = amateur ? 0 : Math.round(fighter.record.wins * level.baseShowPay * 1.6 + fighter.record.losses * level.baseShowPay);
  signRegionalDeal(save, fighter, promotion, amateur);
  ensureRegionalRoster(save, rng, promotion.id, fighter.divisionId);
  state.points[fighter.id] = clamp(fighter.record.wins * 3 - fighter.record.losses * 2, 0, 30);
  // A vacant belt at the start gives the circuit its first title fight from the roster.
  const roster = circuitRoster(save, promotion.id, fighter.divisionId).filter((f) => f.id !== fighter.id);
  const best = [...roster].sort((a, b) => (state.points[b.id] ?? 0) - (state.points[a.id] ?? 0))[0];
  if (best) {
    state.champions[championKey(promotion.id, fighter.divisionId)] = best.id;
    state.reigns.push({ promotionId: promotion.id, divisionId: fighter.divisionId, fighterId: best.id, wonOn: addDays(save.date, -rng.int(40, 300)), wonBoutId: null, lostOn: null, defenses: rng.int(0, 2) });
  }
  scheduleRegionalCards(save, rng);

  addInboxMessage(save, {
    sender: 'manager',
    senderName: promotion.name,
    subject: amateur ? `Welcome to the ${promotion.abbreviation} amateur division` : `Signed with ${promotion.name}`,
    body: amateur
      ? `${fighter.name} is registered as an amateur with ${promotion.name}. Amateur bouts pay nothing and build the amateur record. The professional career starts at eighteen, on ${formatDate(state.turnsProOn ?? save.date)}. ${PROMOTION_NAME} scouts do not sign amateurs, but they do watch them.`
      : `${fighter.name} has signed a ${REGIONAL_LEVELS[promotion.level].label.toLowerCase()} deal with ${promotion.name}. Win here, climb the ${promotion.abbreviation} rankings, take the belt, and ${PROMOTION_NAME} will call. The Regional page shows how close the call up is.`,
    category: 'career',
    requiresAction: false,
    choices: [{ key: 'ack', label: 'Acknowledge' }],
    linkedFighterId: fighter.id,
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function saturdayOnOrAfter(date: IsoDate): IsoDate {
  let d = date;
  while (dayOfWeek(d) !== 6) d = addDays(d, 1);
  return d;
}

function createRegionalEvent(save: SaveGame, rng: Rng, promotion: RegionalPromotionConfig, date: IsoDate, name: string): FightCardEvent {
  const city = rng.pick(promotion.cities);
  const id = `evt-${++save.counters.event}`;
  const event: FightCardEvent = {
    id,
    name,
    date,
    city,
    country: promotion.country,
    countryCode: promotion.countryCode,
    venue: `${city} ${promotion.venueLabel}`,
    tier: 'regional',
    boutIds: [],
    status: 'announced',
    attendance: null,
    drawScore: 0,
    fightOfTheNightBoutId: null,
    performanceBonusFighterIds: [],
    bonusAmount: 0,
    plannedBouts: 5,
    plannedMain: 5,
    plannedPrelim: 0,
    plannedEarly: 0,
    announcedBoutIds: [],
    weighInBoutIds: [],
    contestedBoutIds: [],
    canceledBoutIds: [],
    promotionId: promotion.id,
  };
  save.events[id] = event;
  return event;
}

/** Keeps the next two cards of every running promotion on the calendar. */
export function scheduleRegionalCards(save: SaveGame, rng: Rng): FightCardEvent[] {
  const state = save.regional;
  if (!state) return [];
  const created: FightCardEvent[] = [];
  for (const [promotionId, circuit] of Object.entries(state.circuits)) {
    const promotion = promotionConfig(promotionId);
    if (!promotion) continue;
    const level = REGIONAL_LEVELS[promotion.level];
    const cards = Object.values(save.events).filter((e) => e.promotionId === promotionId && e.status !== 'canceled');
    let upcoming = cards.filter((e) => e.status === 'announced' && e.date >= save.date).length;
    let last = cards.map((e) => e.date).sort().pop() ?? null;
    while (upcoming < 2) {
      let date = last ? addDays(last, rng.int(level.intervalDays[0], level.intervalDays[1])) : addDays(save.date, rng.int(24, 38));
      if (date < addDays(save.date, 21)) date = addDays(save.date, 21);
      date = saturdayOnOrAfter(date);
      circuit.eventNumber++;
      created.push(createRegionalEvent(save, rng, promotion, date, `${promotion.abbreviation} ${circuit.eventNumber}`));
      last = date;
      upcoming++;
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------

function regionalPurse(promotion: RegionalPromotionConfig, f: Fighter, title: boolean): { show: number; win: number } {
  const level = REGIONAL_LEVELS[promotion.level];
  const show = Math.round((level.baseShowPay * (1 + clamp(f.record.wins, 0, 15) * 0.05) * (title ? 1.5 : 1)) / 50) * 50;
  return { show, win: show };
}

function hasOpenOffer(save: SaveGame, fighterId: FighterId): boolean {
  for (const o of Object.values(save.fightOffers)) {
    if (o.status === 'open' && (o.fighterId === fighterId || o.opponentId === fighterId)) return true;
  }
  return false;
}

/** Whether a regional NPC can take a bout on this card. */
function npcFree(save: SaveGame, f: Fighter, eventDate: IsoDate): boolean {
  if (f.retired || f.activityStatus !== 'active') return false;
  if (f.id === save.player.fighterId) return false;
  if (hasLiveBooking(save, f)) return false;
  if (hasOpenOffer(save, f.id)) return false;
  if (!canCompete(f, eventDate).ok || !canCompete(f, save.date).ok) return false;
  if (f.lastFightDate && daysBetween(f.lastFightDate, eventDate) < REGIONAL_TURNAROUND_DAYS) return false;
  return true;
}

function metRecently(save: SaveGame, a: FighterId, b: FighterId, days: number): boolean {
  const fa = save.fighters[a];
  if (!fa) return false;
  for (const id of fa.boutIds.slice(-6)) {
    const r = save.history.results[id];
    if (!r) continue;
    if ((r.fighterAId === b || r.fighterBId === b) && daysBetween(r.date, save.date) < days) return true;
  }
  return false;
}

function makeRegionalBout(
  save: SaveGame,
  event: FightCardEvent,
  promotion: RegionalPromotionConfig,
  a: Fighter,
  b: Fighter,
  opts: { title: boolean; reason: string }
): Bout | null {
  const bout: Bout = {
    id: `bout-${++save.counters.bout}`,
    eventId: event.id,
    date: event.date,
    fighterAId: a.id,
    fighterBId: b.id,
    divisionId: a.divisionId,
    contractedWeightLb: contractedWeight(a.divisionId, false),
    scheduledRounds: opts.title ? 5 : 3,
    isTitleFight: false,
    isInterimTitleFight: false,
    titleIneligibleFighterIds: [],
    isMainEvent: opts.title,
    isCoMain: false,
    cardSegment: 'main',
    boutOrder: opts.title ? 12 : 4,
    isCatchweight: false,
    status: 'scheduled',
    resultId: null,
    bookedOn: save.date,
    replacementHistory: [],
    cancelReason: null,
    purseA: regionalPurse(promotion, a, opts.title),
    purseB: regionalPurse(promotion, b, opts.title),
    weighInA: null,
    weighInB: null,
    bookingReason: opts.reason,
    bookingKind: 'regional',
    regionalTitle: opts.title,
  };
  const booked = bookBout(save, bout);
  return booked.created ? bout : null;
}

function existingTitleBout(save: SaveGame, promotionId: string, divisionId: DivisionId): Bout | null {
  for (const b of Object.values(save.bouts)) {
    if (b.status !== 'scheduled' || !b.regionalTitle || b.divisionId !== divisionId) continue;
    if (save.events[b.eventId]?.promotionId === promotionId) return b;
  }
  for (const o of Object.values(save.fightOffers)) {
    if (o.status === 'open' && o.regionalTitle && o.divisionId === divisionId && save.events[o.eventId]?.promotionId === promotionId) return {} as Bout;
  }
  return null;
}

/** The player can take an ordinary offer for this card. */
function playerCanBeOffered(save: SaveGame, me: Fighter, event: FightCardEvent): boolean {
  return offerBlockReason(save, me, { eventDate: event.date }) === null;
}

/**
 * The player has earned the next title shot: a professional at the top of the standings, below
 * the champion, on a run. The same gate the belt block applies to any challenger.
 */
function playerIsNumberOneContender(standings: RegionalStanding, me: Fighter): boolean {
  return !isAmateurFighter(me) && standings.entries[0]?.fighterId === me.id && me.winStreak >= 2;
}

/**
 * The player is already committed to an earlier card (booked on it, or holding its offer) and
 * can compete on this one. A card enters the booking window while the player is still busy with
 * the one before, so this is the state the number one contender is almost always in when the belt
 * is booked. While it holds, the belt waits; it lasts only until that earlier card is fought.
 */
function playerCommittedToEarlierCard(save: SaveGame, me: Fighter, event: FightCardEvent): boolean {
  if (!canCompete(me, event.date).ok) return false;
  const live = hasLiveBooking(save, me);
  if (live) return live.date < event.date;
  for (const o of Object.values(save.fightOffers)) {
    if (o.status !== 'open' || o.fighterId !== me.id) continue;
    const at = save.events[o.eventId]?.date;
    if (at && at < event.date) return true;
  }
  return false;
}

/**
 * Who the player meets for the belt on this card, if anyone. The champion defends against the
 * best free contender; the number one contender meets the champion, or the next free contender
 * for a vacant belt. Null means no title fight for the player here.
 */
function playerTitleOpponent(save: SaveGame, promotionId: string, divisionId: DivisionId, me: Fighter, event: FightCardEvent): Fighter | null {
  if (isAmateurFighter(me) || existingTitleBout(save, promotionId, divisionId)) return null;
  const standings = regionalStandings(save, promotionId, divisionId);
  const holder = standings.championId;
  const contenders = standings.entries
    .map((e) => save.fighters[e.fighterId])
    .filter((f): f is Fighter => Boolean(f) && f.id !== me.id && npcFree(save, f, event.date));
  if (holder === me.id) return contenders[0] ?? null;
  if (!playerIsNumberOneContender(standings, me)) return null;
  if (holder) {
    const champ = save.fighters[holder];
    return champ && npcFree(save, champ, event.date) ? champ : null;
  }
  return contenders[0] ?? null;
}

function offerPlayerBout(
  save: SaveGame,
  rng: Rng,
  event: FightCardEvent,
  promotion: RegionalPromotionConfig,
  me: Fighter,
  opponent: Fighter,
  opts: { title: boolean; amateur: boolean; reason: string }
): boolean {
  const offer = createFightOffer(save, me, opponent, event, rng, {
    isMainEvent: opts.title,
    isTitleFight: false,
    isInterimTitleFight: false,
    scheduledRounds: opts.title ? 5 : 3,
    reason: opts.reason,
    isReplacementSlot: false,
    bookingKind: 'regional',
    senderName: `${promotion.abbreviation} matchmaking`,
    isAmateur: opts.amateur,
    regionalTitle: opts.title,
  });
  return Boolean(offer);
}

/** Books a regional card: the belt first, then the player's offer, then the rest of the roster. */
function bookRegionalCard(save: SaveGame, rng: Rng, event: FightCardEvent): void {
  const state = save.regional!;
  const promotion = promotionConfig(event.promotionId);
  if (!promotion || event.promotionId === PROVING_GROUND_ID) return;
  const circuit = state.circuits[promotion.id];
  if (!circuit) return;
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;

  for (const divisionId of circuit.divisions) {
    const key = championKey(promotion.id, divisionId);
    const standings = regionalStandings(save, promotion.id, divisionId);
    const playerHere = me && !me.retired && me.circuit?.replace(AMATEUR, '') === promotion.id && me.divisionId === divisionId ? me : null;
    const playerAmateur = isAmateurFighter(playerHere);
    const playerFree = playerHere ? playerCanBeOffered(save, playerHere, event) : false;

    // The belt.
    let championId = state.champions[key] ?? null;
    const champion = championId ? save.fighters[championId] : null;
    if (champion && (champion.retired || champion.circuit !== promotion.id || champion.divisionId !== divisionId)) {
      vacateRegionalTitle(save, promotion.id, divisionId, 'vacated');
      championId = null;
    }
    if (!existingTitleBout(save, promotion.id, divisionId)) {
      const contenders = standings.entries.map((e) => save.fighters[e.fighterId]).filter((f): f is Fighter => Boolean(f));
      const champ = championId ? save.fighters[championId] : null;
      const champReady = champ && (champ.id === playerHere?.id ? playerFree : npcFree(save, champ, event.date)) && (!champ.lastFightDate || daysBetween(champ.lastFightDate, event.date) >= CHAMPION_IDLE_DAYS);
      const challengers = contenders.filter((f) => (f.id === playerHere?.id ? playerFree && f.winStreak >= 2 : npcFree(save, f, event.date)));
      // The number one contender who is busy with the card before keeps the shot: the belt is not
      // handed to the next contender behind them. Without this the player could never fight for
      // it, because every belt was booked while they were still committed to their previous bout.
      const holdForPlayer = Boolean(
        playerHere && champ?.id !== playerHere.id && playerIsNumberOneContender(standings, playerHere) && playerCommittedToEarlierCard(save, playerHere, event)
      );
      if (champ && champReady && challengers[0]) {
        const challenger = challengers[0];
        if (playerHere && !playerAmateur && (challenger.id === playerHere.id || champ.id === playerHere.id)) {
          const opp = champ.id === playerHere.id ? challenger : champ;
          offerPlayerBout(save, rng, event, promotion, playerHere, opp, {
            title: true,
            amateur: false,
            reason: champ.id === playerHere.id ? `A defence of the ${promotion.abbreviation} title against the number one contender` : `A shot at the ${promotion.abbreviation} title, earned as the number one contender`,
          });
        } else if (challenger.id !== playerHere?.id && champ.id !== playerHere?.id && !holdForPlayer) {
          makeRegionalBout(save, event, promotion, champ, challenger, { title: true, reason: `${promotion.abbreviation} title: the champion against the number one contender` });
        }
      } else if (!champ && challengers.length >= 2) {
        const [x, y] = challengers;
        if (playerHere && !playerAmateur && (x.id === playerHere.id || y.id === playerHere.id)) {
          offerPlayerBout(save, rng, event, promotion, playerHere, x.id === playerHere.id ? y : x, { title: true, amateur: false, reason: `For the vacant ${promotion.abbreviation} title` });
        } else if (!holdForPlayer) {
          makeRegionalBout(save, event, promotion, x, y, { title: true, reason: `For the vacant ${promotion.abbreviation} title` });
        }
      }
    }

    // The player's own bout.
    if (playerHere && playerCanBeOffered(save, playerHere, event) && !hasOpenOffer(save, playerHere.id)) {
      if (playerAmateur) {
        const opp = generateRegionalFighter(save, rng, promotion, divisionId, {
          amateur: true,
          ovr: clamp(ovrDisplayed(playerHere.ratings) + rng.normal(0, 4), 25, 70),
          age: rng.int(MIN_REGIONAL_START_AGE, 20),
        });
        offerPlayerBout(save, rng, event, promotion, playerHere, opp, { title: false, amateur: true, reason: `An amateur bout on the ${promotion.abbreviation} undercard` });
      } else {
        // A title fight first, when the player is the champion or has earned the shot. The belt
        // block above only books one when the player is free on the day it runs, which the player
        // rarely is; this is the moment they are free.
        const titleOpponent = playerTitleOpponent(save, promotion.id, divisionId, playerHere, event);
        const holdsBelt = state.champions[key] === playerHere.id;
        if (titleOpponent) {
          const rank = regionalStandings(save, promotion.id, divisionId).entries.find((e) => e.fighterId === titleOpponent.id)?.rank ?? null;
          offerPlayerBout(save, rng, event, promotion, playerHere, titleOpponent, {
            title: true,
            amateur: false,
            reason: holdsBelt
              ? `A defence of the ${promotion.abbreviation} title against the number ${rank ?? 1} contender`
              : state.champions[key]
                ? `A shot at the ${promotion.abbreviation} title, earned as the number one contender`
                : `For the vacant ${promotion.abbreviation} title`,
          });
        }
      }
      // A champion does not take ordinary bouts, as NPC champions never do: the belt is defended
      // or it waits. A champion who lost a non title fight used to keep the belt and hand the
      // winner a top contender's points.
      if (!playerAmateur && !hasOpenOffer(save, playerHere.id) && state.champions[key] !== playerHere.id) {
        const myPoints = state.points[playerHere.id] ?? 0;
        const target = myPoints + (playerHere.winStreak >= 2 ? 10 : playerHere.lossStreak >= 1 ? -6 : 3);
        const candidates = circuitRoster(save, promotion.id, divisionId).filter(
          (f) => f.id !== playerHere.id && f.id !== state.champions[key] && npcFree(save, f, event.date) && !metRecently(save, playerHere.id, f.id, 365)
        );
        const pick = candidates
          // Standing and ability both: a regional matchmaker builds a prospect against people at
          // their level, not only against whoever sits next to them in the table.
          .map((f) => ({ f, score: Math.abs((state.points[f.id] ?? 0) - target) + Math.abs(ovrDisplayed(f.ratings) - ovrDisplayed(playerHere.ratings) - (playerHere.winStreak >= 2 ? 2 : 0)) * 1.5 + rng.range(0, 6) }))
          .sort((a, b) => a.score - b.score)[0]?.f;
        if (pick) {
          const rank = standings.entries.find((e) => e.fighterId === pick.id)?.rank ?? null;
          offerPlayerBout(save, rng, event, promotion, playerHere, pick, {
            title: false,
            amateur: false,
            reason: rank ? `${promotion.abbreviation} matchmaking against the number ${rank} ranked fighter` : `${promotion.abbreviation} matchmaking against a fighter building a record`,
          });
        }
      }
    }

    // Everyone else.
    const target = promotion.level === 3 ? 4 : 3;
    const booked = event.boutIds.filter((id) => {
      const b = save.bouts[id];
      return b && b.status === 'scheduled' && b.divisionId === divisionId && !b.regionalTitle && b.fighterAId !== me?.id && b.fighterBId !== me?.id;
    }).length;
    let needed = target - booked;
    if (needed <= 0) continue;
    const pool = circuitRoster(save, promotion.id, divisionId)
      .filter((f) => f.id !== state.champions[key] && npcFree(save, f, event.date))
      .sort((a, b) => (state.points[b.id] ?? 0) - (state.points[a.id] ?? 0));
    const used = new Set<FighterId>();
    for (let i = 0; i < pool.length && needed > 0; i++) {
      const a = pool[i];
      if (used.has(a.id)) continue;
      for (let j = i + 1; j < Math.min(pool.length, i + 4); j++) {
        const b = pool[j];
        if (used.has(b.id) || metRecently(save, a.id, b.id, 300)) continue;
        if (makeRegionalBout(save, event, promotion, a, b, { title: false, reason: `${promotion.abbreviation} matchmaking between fighters close in the standings` })) {
          used.add(a.id);
          used.add(b.id);
          needed--;
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function vacateRegionalTitle(save: SaveGame, promotionId: string, divisionId: DivisionId, why: 'vacated' | 'stripped' | 'called up'): void {
  const state = save.regional;
  if (!state) return;
  const key = championKey(promotionId, divisionId);
  const holder = state.champions[key];
  if (!holder) return;
  state.champions[key] = null;
  const reign = state.reigns.find((r) => r.promotionId === promotionId && r.divisionId === divisionId && r.fighterId === holder && r.lostOn === null);
  if (reign) reign.lostOn = save.date;
  const f = save.fighters[holder];
  const promotion = promotionConfig(promotionId);
  if (f && promotion && (f.id === save.player.fighterId || state.playerPromotionId === promotionId)) {
    pushNews(save, {
      date: save.date,
      headline: `The ${promotion.abbreviation} ${DIVISION_BY_ID[divisionId].name.toLowerCase()} title is vacant`,
      body: why === 'called up' ? `${f.name} has been called up by ${PROMOTION_NAME} and leaves the belt behind.` : `${f.name} no longer holds the ${promotion.abbreviation} title.`,
      tags: ['regional'],
      fighterIds: [f.id],
      importance: 2,
    });
  }
}

/**
 * The regional consequences of a regional result. Called by `applyResult` in place of the main
 * promotion's rankings, titles and contenders, none of which a regional bout touches.
 */
export function applyRegionalResult(save: SaveGame, bout: Bout, result: FightResult, rng: Rng): string[] {
  const state = save.regional;
  const event = save.events[bout.eventId];
  const notes: string[] = [];
  if (!state || !event?.promotionId) return notes;
  const promotion = promotionConfig(event.promotionId);
  if (!promotion) return notes;
  const playerId = save.player.fighterId;
  const winner = result.winnerId ? save.fighters[result.winnerId] : null;
  const loser = result.loserId ? save.fighters[result.loserId] : null;
  const involvesPlayer = bout.fighterAId === playerId || bout.fighterBId === playerId;

  if (event.promotionId === PROVING_GROUND_ID) {
    return applyTryoutResult(save, bout, result, rng);
  }
  if (bout.isAmateur) return notes;

  const rankOf = (id: FighterId) => regionalStandings(save, promotion.id, bout.divisionId).entries.find((e) => e.fighterId === id)?.rank ?? null;
  if (winner && loser) {
    const loserRank = rankOf(loser.id);
    const loserWasChamp = state.champions[championKey(promotion.id, bout.divisionId)] === loser.id;
    const gain = 10 + (isFinish(result.method) ? 4 : 0) + (loserWasChamp ? 10 : loserRank ? (11 - loserRank) * 0.8 : 0);
    state.points[winner.id] = (state.points[winner.id] ?? 0) + gain;
    state.points[loser.id] = Math.max(0, (state.points[loser.id] ?? 0) - (result.method === 'decision-split' ? 3 : 6));
  } else {
    for (const id of [bout.fighterAId, bout.fighterBId]) state.points[id] = (state.points[id] ?? 0) + 2;
  }

  if (bout.regionalTitle) {
    const key = championKey(promotion.id, bout.divisionId);
    const holder = state.champions[key] ?? null;
    const winnerMadeWeight = winner ? (bout.fighterAId === winner.id ? bout.weighInA?.madeWeight : bout.weighInB?.madeWeight) !== false : false;
    if (winner && winner.id === holder) {
      const reign = state.reigns.find((r) => r.fighterId === holder && r.promotionId === promotion.id && r.divisionId === bout.divisionId && r.lostOn === null);
      if (reign) reign.defenses++;
      notes.push(`${winner.name} defends the ${promotion.abbreviation} title.`);
    } else if (winner && winnerMadeWeight) {
      if (holder) {
        const reign = state.reigns.find((r) => r.fighterId === holder && r.promotionId === promotion.id && r.divisionId === bout.divisionId && r.lostOn === null);
        if (reign) reign.lostOn = result.date;
      }
      state.champions[key] = winner.id;
      state.reigns.push({ promotionId: promotion.id, divisionId: bout.divisionId, fighterId: winner.id, wonOn: result.date, wonBoutId: bout.id, lostOn: null, defenses: 0 });
      winner.awards.push(`${promotion.abbreviation} ${DIVISION_BY_ID[bout.divisionId].name} Champion`);
      notes.push(`${winner.name} is the new ${promotion.abbreviation} ${DIVISION_BY_ID[bout.divisionId].name.toLowerCase()} champion.`);
    } else if (holder && winner && !winnerMadeWeight && loser?.id === holder) {
      vacateRegionalTitle(save, promotion.id, bout.divisionId, 'vacated');
    }
    for (const note of notes) {
      pushNews(save, { date: result.date, headline: note, body: result.narrativeSummary, tags: ['regional', 'title'], fighterIds: [bout.fighterAId, bout.fighterBId], importance: involvesPlayer ? 4 : 2 });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The call up
// ---------------------------------------------------------------------------

export interface ReadinessFactor {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface CallUpReadiness {
  score: number;
  factors: ReadinessFactor[];
  /** Hard requirements not yet met. A fighter with any of these is not signed whatever the score. */
  blockers: string[];
  verdict: string;
}

/**
 * How close a regional fighter is to a main promotion contract.
 *
 * The factors are the ones the request named: how the fighter performs at their promotion, where
 * they sit in its rankings, and how good they actually are. Record and form, finishes, the belt
 * and the regional rank, the level of the promotion, Ovr against the main roster, age and Pot,
 * and a following. Every factor is shown to the player with its contribution.
 */
export function callUpReadiness(save: SaveGame, f: Fighter): CallUpReadiness {
  const promotion = promotionOfFighter(f);
  const level = promotion ? REGIONAL_LEVELS[promotion.level] : REGIONAL_LEVELS[1];
  const factors: ReadinessFactor[] = [];
  const add = (key: string, label: string, points: number, detail: string) => factors.push({ key, label, points: Math.round(points * 10) / 10, detail });
  const w = f.record.wins;
  const l = f.record.losses;
  add('record', 'Professional record', clamp(w * 3.2 - l * 4.5, -15, 26), `${w}-${l}${f.record.draws ? `-${f.record.draws}` : ''} as a professional`);
  add('form', 'Current form', clamp(f.winStreak * 3.5, 0, 14) - clamp(f.lossStreak * 6, 0, 18), f.winStreak > 0 ? `${f.winStreak} straight wins` : f.lossStreak > 0 ? `${f.lossStreak} straight losses` : 'No streak');
  const finishes = f.methods.koWins + f.methods.subWins;
  const finishRate = w > 0 ? finishes / w : 0;
  add('finishes', 'Finishing', w >= 3 ? clamp((finishRate - 0.4) * 25, -4, 10) : 0, w >= 3 ? `${Math.round(finishRate * 100)} percent of wins inside the distance` : 'Too few wins to judge');
  // An amateur is not in the professional rankings. Their circuit is the pool of one off amateur
  // opponents, and ranking them in it showed 'Ranked number 1' beside 'Regional standing: Amateur'.
  const amateur = isAmateurFighter(f);
  const champion = !amateur && isRegionalChampion(save, f);
  const rank = amateur ? null : regionalRank(save, f);
  const standing = champion ? 20 : rank !== null && rank <= 3 ? 10 : rank !== null && rank <= 6 ? 5 : 0;
  add('standing', 'Regional standing', standing * level.scoutWeight, amateur ? 'Amateur' : champion ? `${promotion?.abbreviation ?? 'Regional'} champion` : rank ? `Ranked number ${rank}` : 'Unranked');
  add('level', 'Level of competition', promotion ? (promotion.level - 1) * 4 : 0, promotion ? level.label : 'Unknown');
  const ovr = ovrDisplayed(f.ratings);
  add('ability', 'Ability against the main roster', clamp((ovr - 56) * 1.6, -14, 22), `Ovr ${ovr} (main roster floor is roughly 56 to 62)`);
  const age = ageOn(f.birthDate, save.date) ?? f.ageAtSnapshot ?? 26;
  const upside = age <= 24 && f.pot >= ovr + 8 ? 6 : age <= 26 && f.pot >= ovr + 5 ? 3 : 0;
  const agePenalty = age >= 35 ? -15 : age >= 32 ? -8 : 0;
  add('age', 'Age and Pot', upside + agePenalty, `Age ${age}, Pot ${f.pot}`);
  add('draw', 'Following', clamp(f.popularity * 0.25, 0, 6), `Popularity ${Math.round(f.popularity)}`);

  const blockers: string[] = [];
  if (age < PRO_AGE || isAmateurFighter(f)) blockers.push(`Turn professional first, at ${PRO_AGE}.`);
  const proFights = w + l + f.record.draws;
  const minFights = promotion?.level === 3 ? 3 : 4;
  if (proFights < minFights) blockers.push(`At least ${minFights} professional fights. ${proFights} so far.`);
  // The player is judged on the circuit, not on the record they arrived with. A created fighter
  // with an imported 15-3 record was offered a contract, or a tryout, on the first day of a career
  // that had promised a climb through the regional rankings first. NPCs are not held to it: their
  // records were made on the circuit before the save began.
  if (promotion && f.id === save.player.fighterId && !amateur && !hasCircuitBout(save, f, promotion.id)) {
    blockers.push(`At least one bout on the ${promotion.abbreviation} circuit first.`);
  }

  const score = clamp(Math.round(factors.reduce((s, x) => s + x.points, 0)), 0, 100);
  const verdict =
    blockers.length > 0
      ? blockers[0]
      : score >= CALL_UP_THRESHOLD
        ? `Ready. ${PROMOTION_ABBREVIATION} is interested.`
        : score >= TRYOUT_THRESHOLD
          ? `Close. A Proving Ground tryout is the likely next step.`
          : `Not yet. Keep winning, and the belt would change the conversation.`;
  return { score, factors, blockers, verdict };
}

/** Whether the fighter has a completed professional bout on this promotion's cards. */
function hasCircuitBout(save: SaveGame, f: Fighter, promotionId: string): boolean {
  for (const id of f.boutIds) {
    const bout = save.bouts[id];
    if (!bout || bout.isAmateur || !save.history.results[id]) continue;
    if (save.events[bout.eventId]?.promotionId === promotionId) return true;
  }
  return false;
}

/** Puts a main promotion contract in front of the player. */
export function offerCallUp(save: SaveGame, f: Fighter, rng: Rng, why: string): ContractOffer {
  const state = regionalStateOf(save);
  const offer = createContractOffer(f, save, rng);
  offer.id = `coffer-callup-${f.id}-${save.date}`;
  offer.callUp = true;
  offer.leverageSummary = `A first ${PROMOTION_ABBREVIATION} contract. ${why}`;
  save.contractOffers[offer.id] = offer;
  state.callUp.offeredOn = save.date;
  addInboxMessage(save, {
    sender: 'contract-rep',
    senderName: PROMOTION_CONTRACTS,
    subject: `The call up: ${PROMOTION_NAME} wants to sign ${f.name}`,
    body: `${why} ${PROMOTION_NAME} is offering a ${offer.terms.fights} fight contract at ${formatMoney(offer.terms.showPay)} to show and ${formatMoney(offer.terms.winBonus)} to win. Signing ends the regional deal and moves the career to the main roster, where the debut is against another newcomer. The offer is open until ${formatDate(offer.deadline)}.`,
    category: 'contract',
    requiresAction: true,
    deadline: offer.deadline,
    choices: [{ key: 'open-negotiation', label: 'Open negotiation' }],
    linkedFighterId: f.id,
    linkedOfferId: offer.id,
  });
  pushNews(save, {
    date: save.date,
    headline: `${PROMOTION_ABBREVIATION} makes an offer to ${f.name}`,
    body: why,
    tags: ['regional', 'roster'],
    fighterIds: [f.id],
    importance: 3,
  });
  return offer;
}

/** Signs a call up offer and moves the player to the main roster. */
export function signCallUpOffer(save: SaveGame, f: Fighter, offer: ContractOffer, round: NegotiationRound | null): Contract {
  const contract = signContractOffer(save, f, offer, round);
  graduateToMainRoster(save, f, 'signed');
  return contract;
}

/**
 * Moves a fighter from the circuit to the main promotion's world.
 *
 * The regional belt is vacated, any regional booking or offer is closed, and the fighter arrives on
 * the main roster unranked with no promotional record, which is what makes the existing debut rule
 * match them with another newcomer.
 */
export function graduateToMainRoster(save: SaveGame, f: Fighter, how: 'signed' | 'npc', rng?: Rng): void {
  const state = regionalStateOf(save);
  const promotionId = f.circuit?.replace(AMATEUR, '') ?? null;
  if (!promotionId) return;
  const promotion = promotionConfig(promotionId);
  const wasChampion = isRegionalChampion(save, f);
  if (wasChampion) vacateRegionalTitle(save, promotionId, f.divisionId, 'called up');

  const live = hasLiveBooking(save, f);
  if (live && save.events[live.eventId]?.promotionId) {
    const opponentId = live.fighterAId === f.id ? live.fighterBId : live.fighterAId;
    live.status = 'canceled';
    live.cancelReason = `${f.name} was called up by ${PROMOTION_NAME}.`;
    releaseBooking(save, f.id, live.id);
    releaseBooking(save, opponentId, live.id);
    const ev = save.events[live.eventId];
    if (ev && !ev.canceledBoutIds.includes(live.id)) ev.canceledBoutIds.push(live.id);
    for (const c of Object.values(save.camps)) {
      if (c.boutId === live.id && (c.status === 'planned' || c.status === 'running')) c.status = 'abandoned';
    }
  }
  for (const o of Object.values(save.fightOffers)) {
    if (o.status !== 'open' || (o.fighterId !== f.id && o.opponentId !== f.id)) continue;
    if (!save.events[o.eventId]?.promotionId) continue;
    o.status = 'withdrawn';
    resolveMessagesForOffer(save, o.id, `${f.name} has been called up.`);
  }

  f.circuit = null;
  f.ufcRecord = emptyRecord();
  f.ranking = null;
  delete state.points[f.id];
  state.graduates.unshift({ fighterId: f.id, promotionId, date: save.date, wasChampion });
  if (state.graduates.length > 60) state.graduates.length = 60;

  if (how === 'npc') {
    const r = rng ?? new Rng(save.seed ^ save.counters.fighter);
    const contract = generateContract(f, save, r, { isPlayerFighter: false });
    save.contracts[contract.id] = contract;
    f.contractId = contract.id;
    const gyms = Object.values(save.gyms).filter((g) => g.fighterIds.length < g.capacity);
    if (gyms.length > 0) moveFighterToGym(save, f.id, r.weighted(gyms, (g) => g.reputation + 10).id);
    pushNews(save, {
      date: save.date,
      headline: `${f.name} signs with ${PROMOTION_NAME}`,
      body: `${f.name}, ${f.record.wins}-${f.record.losses}${wasChampion && promotion ? ` and the ${promotion.abbreviation} champion` : ''}, has been called up from ${promotion?.name ?? 'the regional circuit'}.`,
      tags: ['roster', 'regional', f.divisionId],
      fighterIds: [f.id],
      importance: 2,
    });
    return;
  }

  // The player. The circuit stops running once nobody is fighting on it.
  state.playerPromotionId = null;
  state.callUp.calledUpOn = save.date;
  state.circuits = {};
  for (const e of Object.values(save.events)) {
    if (e.promotionId && e.status === 'announced' && e.date > save.date && !e.boutIds.some((id) => save.bouts[id]?.status === 'scheduled')) {
      e.status = 'canceled';
    }
  }
  if (!save.player.achievements.some((a) => a.key === 'called-up')) {
    save.player.achievements.push({ key: 'called-up', label: `Called up to ${PROMOTION_NAME}`, date: save.date });
  }
  pushNews(save, {
    date: save.date,
    headline: `${f.name} is called up to ${PROMOTION_NAME}`,
    body: `${f.name} leaves ${promotion?.name ?? 'the regional circuit'} at ${f.record.wins}-${f.record.losses}${wasChampion ? ' as champion' : ''} and joins the ${DIVISION_BY_ID[f.divisionId].name} roster.`,
    tags: ['roster', 'regional', 'career'],
    fighterIds: [f.id],
    importance: 4,
  });
  // The debut is made now rather than left to the card seeding. The seeding holds a debut to an
  // unranked newcomer near the player's level, which is right, but the division rarely had one free,
  // and a called up fighter waited sixteen months for the debut this message promises.
  const debut = offerPlayerDebut(save, f);
  const debutOpponent = debut ? save.fighters[debut.opponentId] : null;
  const debutEvent = debut ? save.events[debut.eventId] : null;
  addInboxMessage(save, {
    sender: 'manager',
    senderName: 'Your manager',
    subject: `Welcome to ${PROMOTION_NAME}`,
    body:
      debutOpponent && debutEvent
        ? `The contract is signed. ${f.name} is on the ${DIVISION_BY_ID[f.divisionId].name} roster, unranked, and the matchmakers have already offered a debut against another newcomer, ${debutOpponent.name}, at ${debutEvent.name}.`
        : `The contract is signed. ${f.name} is on the ${DIVISION_BY_ID[f.divisionId].name} roster, unranked, and the matchmakers will look for a debut against another newcomer.`,
    category: 'career',
    requiresAction: false,
    choices: [{ key: 'ack', label: 'Acknowledge' }],
    linkedFighterId: f.id,
  });
}

function tryoutOpponent(save: SaveGame, rng: Rng, me: Fighter): Fighter {
  const pool = Object.values(REGIONAL_PROMOTION_BY_ID).filter((p) => p.id !== me.circuit);
  const from = rng.pick(pool);
  // Centred on the player: a tryout is a fair test of whether they belong, not a fight against
  // someone a little better on average with a padded record.
  const opp = generateRegionalFighter(save, rng, from, me.divisionId, { ovr: clamp(ovrDisplayed(me.ratings) + rng.normal(0, 2.5), 45, 75), age: rng.int(21, 29) });
  opp.circuit = PROVING_GROUND_ID;
  opp.originPromotionId = from.id;
  opp.record.losses = Math.min(opp.record.losses, 2);
  opp.record.wins = Math.max(opp.record.wins, 5);
  opp.methods = methodsFor(rng, opp.record.wins, opp.record.losses);
  opp.winStreak = Math.min(opp.record.wins, rng.int(2, 5));
  delete save.regional!.points[opp.id];
  return opp;
}

/** Invites the player to a Proving Ground tryout against a fighter from another circuit. */
export function inviteToTryout(save: SaveGame, rng: Rng, me: Fighter): boolean {
  const state = regionalStateOf(save);
  const pg = provingGround();
  const date = saturdayOnOrAfter(addDays(save.date, rng.int(30, 44)));
  const count = (save.counters.provingGround = (save.counters.provingGround ?? 0) + 1);
  const event = createRegionalEvent(save, rng, pg, date, `${pg.name}, Week ${count}`);
  const opp = tryoutOpponent(save, rng, me);
  const offer = createFightOffer(save, me, opp, event, rng, {
    // A tryout is a three round audition, not a headliner. As a main event it was titled as one,
    // got five rounds for the asking and drew the headliner questions at the press conference.
    // A Proving Ground card is never ordered by the main card pass, so nothing needs the slot.
    isMainEvent: false,
    isTitleFight: false,
    isInterimTitleFight: false,
    scheduledRounds: 3,
    reason: `A tryout in front of the ${PROMOTION_ABBREVIATION} matchmakers. A finish all but guarantees a contract, a clear decision win usually earns one, and a loss sends you back to the circuit`,
    isReplacementSlot: false,
    bookingKind: 'tryout',
    senderName: `${PROMOTION_ABBREVIATION} talent relations`,
  });
  if (!offer) {
    event.status = 'canceled';
    return false;
  }
  state.callUp.tryoutInvitedOn = save.date;
  return true;
}

function applyTryoutResult(save: SaveGame, bout: Bout, result: FightResult, rng: Rng): string[] {
  const state = regionalStateOf(save);
  const playerId = save.player.fighterId;
  const notes: string[] = [];
  for (const id of [bout.fighterAId, bout.fighterBId]) {
    const f = save.fighters[id];
    if (!f) continue;
    const won = result.winnerId === id;
    if (id === playerId) {
      const finish = isFinish(result.method);
      const clear = result.method === 'decision-unanimous';
      const signed = won && (finish || (clear && rng.chance(0.75)) || rng.chance(0.3));
      if (signed) {
        offerCallUp(save, f, rng, finish ? 'The finish at the Proving Ground was exactly what the matchmakers wanted to see.' : 'The win at the Proving Ground was enough.');
        notes.push(`${f.name} earns a contract at the Proving Ground.`);
      } else {
        if (!won) state.callUp.tryoutsLost++;
        addInboxMessage(save, {
          sender: 'manager',
          senderName: `${PROMOTION_ABBREVIATION} talent relations`,
          subject: won ? 'Not this time, despite the win' : 'The tryout did not go our way',
          body: won
            ? `${f.name} won, but not convincingly enough for a contract. Back to the circuit; another strong run will bring them back.`
            : `${f.name} lost at the Proving Ground. Back to the circuit. The door is not closed, but the next look will take longer.`,
          category: 'career',
          requiresAction: false,
          choices: [{ key: 'ack', label: 'Acknowledge' }],
          linkedFighterId: f.id,
        });
      }
    } else if (won && f.circuit === PROVING_GROUND_ID) {
      // Credited to the circuit they came from. Every winner used to be filed under Crown Arena;
      // a tryout opponent from an older save has no origin and keeps that.
      f.circuit = f.originPromotionId ?? (REGIONAL_PROMOTION_BY_ID['rp-crown-arena'] ? 'rp-crown-arena' : f.circuit);
      graduateToMainRoster(save, f, 'npc', rng);
    } else if (f.circuit === PROVING_GROUND_ID) {
      // The losing tryout fighter goes home and leaves the story.
      f.activityStatus = 'retired';
      f.retired = true;
      f.retirementDate = save.date;
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The weekly pass
// ---------------------------------------------------------------------------

/**
 * Everything the circuit does in a week: turning professional, renewing the regional deal,
 * the calendar and the cards, standings decay, the call up review, and roster turnover.
 * Runs only for a save that has a regional block, so no other save's random sequence moves.
 */
export function runRegionalWeek(save: SaveGame, rng: Rng, headlines: string[]): void {
  const state = save.regional;
  if (!state) return;
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const myPromotion = me?.circuit ? promotionConfig(me.circuit) : null;
  // The circuit runs for the player. A career that retired on it, or left it some other way, leaves
  // nobody to run it for, and it used to keep scheduling cards for ever.
  if ((!me || me.retired || !me.circuit) && Object.keys(state.circuits).length > 0) {
    state.circuits = {};
    state.playerPromotionId = me?.circuit ? state.playerPromotionId : null;
  }

  if (me && myPromotion && !me.retired) {
    // Turning professional.
    if (isAmateurFighter(me) && state.turnsProOn && save.date >= state.turnsProOn && !hasLiveBooking(save, me)) {
      me.circuit = myPromotion.id;
      state.turnsProOn = null;
      // Streaks start again with the professional record. An amateur run used to carry over, so a
      // 0-0 professional read as four straight losses, or arrived already on the title streak.
      me.winStreak = 0;
      me.lossStreak = 0;
      signRegionalDeal(save, me, myPromotion, false);
      state.points[me.id] = clamp((me.amateurRecord?.wins ?? 0) * 1.5, 0, 15);
      const am = me.amateurRecord ?? emptyRecord();
      headlines.push(`${me.name} turns professional.`);
      addInboxMessage(save, {
        sender: 'manager',
        senderName: myPromotion.name,
        subject: 'Turning professional',
        body: `${me.name} is eighteen and turns professional with ${myPromotion.name}, leaving the amateurs at ${am.wins}-${am.losses}. From here every bout is paid, counts on the professional record, and is watched by ${PROMOTION_NAME}.`,
        category: 'career',
        requiresAction: false,
        choices: [{ key: 'ack', label: 'Acknowledge' }],
        linkedFighterId: me.id,
      });
    }
    // The regional deal renews itself while the player is still on the circuit.
    const contract = me.contractId ? save.contracts[me.contractId] : null;
    if (!contract || contract.status !== 'active' || contract.fightsRemaining <= 0) {
      signRegionalDeal(save, me, myPromotion, isAmateurFighter(me));
      addInboxMessage(save, {
        sender: 'contract-rep',
        senderName: myPromotion.name,
        subject: `New ${myPromotion.abbreviation} deal`,
        body: `${myPromotion.name} has renewed the deal on the strength of the record. The main promotion can still sign ${me.name} at any time.`,
        category: 'career',
        requiresAction: false,
        choices: [{ key: 'ack', label: 'Acknowledge' }],
        linkedFighterId: me.id,
      });
    }
    // The circuit follows the player to a new division.
    const circuit = state.circuits[myPromotion.id];
    if (circuit && !circuit.divisions.includes(me.divisionId)) {
      // A champion who changes division leaves the belt behind, as in the main promotion.
      for (const d of circuit.divisions) {
        if (state.champions[championKey(myPromotion.id, d)] === me.id) vacateRegionalTitle(save, myPromotion.id, d, 'vacated');
      }
      circuit.divisions = [me.divisionId];
    }
    if (circuit) ensureRegionalRoster(save, rng, myPromotion.id, me.divisionId);
  }

  // The call up review runs before the cards are booked, so a free window can go to a tryout
  // rather than always being filled by the next regional bout.
  if (me && myPromotion && !me.retired) {
    const readiness = callUpReadiness(save, me);
    state.callUp.readiness = readiness.score;
    const month = save.date.slice(0, 7);
    const lastEntry = state.callUp.history[state.callUp.history.length - 1];
    if (!lastEntry || lastEntry.date.slice(0, 7) !== month) {
      state.callUp.history.push({ date: save.date, readiness: readiness.score });
      if (state.callUp.history.length > 120) state.callUp.history.shift();
    }
    const busy = Boolean(hasLiveBooking(save, me)) || hasOpenOffer(save, me.id);
    const openCallUp = Object.values(save.contractOffers).some((o) => o.fighterId === me.id && o.callUp && o.status === 'open');
    if (readiness.blockers.length === 0 && !busy && !openCallUp) {
      const sinceOffer = state.callUp.offeredOn ? daysBetween(state.callUp.offeredOn, save.date) : 9999;
      const sinceTryout = state.callUp.tryoutInvitedOn ? daysBetween(state.callUp.tryoutInvitedOn, save.date) : 9999;
      if (readiness.score >= CALL_UP_THRESHOLD && sinceOffer >= CALL_UP_REOFFER_DAYS) {
        offerCallUp(save, me, rng, `The record, the ${myPromotion.abbreviation} standing and the ability all say ${me.name} is ready.`);
        headlines.push(`${PROMOTION_ABBREVIATION} has made a contract offer.`);
      } else if (readiness.score >= TRYOUT_THRESHOLD && sinceTryout >= TRYOUT_COOLDOWN_DAYS && state.callUp.tryoutsLost < 3) {
        if (inviteToTryout(save, rng, me)) headlines.push('An invitation to the Proving Ground has arrived.');
      }
    }
  }

  scheduleRegionalCards(save, rng);
  // Cards are booked in date order. When two are in the window on the same day, an ordinary offer
  // on the later card must not go out first and leave the player holding an offer that keeps them
  // off the earlier card's title fight.
  const regionalCards = Object.values(save.events)
    .filter((e) => e.promotionId && e.status === 'announced')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const event of regionalCards) {
    const daysOut = daysBetween(save.date, event.date);
    if (daysOut < 14 || daysOut > 49) continue;
    bookRegionalCard(save, rng, event);
  }

  for (const id of Object.keys(state.points)) state.points[id] *= 0.994;

  // Monthly: roster turnover and the champion's inactivity.
  const month = save.date.slice(0, 7);
  if (state.lastMonthly !== month) {
    state.lastMonthly = month;
    // One off amateur opponents and tryout opponents exist for a single bout. Once it is behind
    // them, or the offer was never taken, they leave the world rather than being processed weekly.
    for (const f of Object.values(save.fighters)) {
      if (f.retired || f.id === save.player.fighterId || !f.circuit) continue;
      if (!f.circuit.endsWith(AMATEUR) && f.circuit !== PROVING_GROUND_ID && f.activityStatus === 'active') continue;
      if (hasLiveBooking(save, f) || hasOpenOffer(save, f.id)) continue;
      f.retired = true;
      f.retirementDate = save.date;
      f.activityStatus = 'retired';
    }
    for (const [promotionId, circuit] of Object.entries(state.circuits)) {
      const promotion = promotionConfig(promotionId);
      if (!promotion) continue;
      for (const divisionId of circuit.divisions) {
        const key = championKey(promotionId, divisionId);
        const champ = state.champions[key] ? save.fighters[state.champions[key]!] : null;
        if (champ && champ.lastFightDate && daysBetween(champ.lastFightDate, save.date) > 300 && !hasLiveBooking(save, champ)) {
          vacateRegionalTitle(save, promotionId, divisionId, 'stripped');
        }
        for (const f of circuitRoster(save, promotionId, divisionId)) {
          if (f.id === save.player.fighterId || hasLiveBooking(save, f) || hasOpenOffer(save, f.id)) continue;
          const age = ageOn(f.birthDate, save.date) ?? 28;
          // The best of the rest get called up too, which is how a regional rival turns up later.
          if (callUpReadiness(save, f).score >= CALL_UP_THRESHOLD + 4 && rng.chance(0.2)) {
            graduateToMainRoster(save, f, 'npc', rng);
            continue;
          }
          const quits = (age >= 33 && f.lossStreak >= 2 && rng.chance(0.25)) || f.longevity < 25 || age >= 38;
          if (quits) {
            if (state.champions[key] === f.id) vacateRegionalTitle(save, promotionId, divisionId, 'vacated');
            f.retired = true;
            f.retirementDate = save.date;
            f.activityStatus = 'retired';
          }
        }
        ensureRegionalRoster(save, rng, promotionId, divisionId);
      }
    }
  }
}
