import { DIFFICULTY } from '../config/calibration';
import { mainRosterFighters } from './circuit';
import { MATCHMAKING as M, MATCHUP_PULL } from '../config/matchmaking';
import { contractedWeight, DIVISIONS, DIVISION_BY_ID } from '../config/divisions';
import { clamp, hashString, Rng } from '../rng';
import { addDays, ageOn, daysBetween, dayOfWeek, joinSentence, type BoutId, type EventId, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, type Bout, type FightResult } from '../types/fight';
import { ovrRaw } from '../types/fighter';
import type { Fighter } from '../types/fighter';
import type { FightCardEvent, EventTier } from '../types/world';
import type { SaveGame } from '../types/save';
import { assessTitleOpportunity, assessTitleRematch, fightCloseness, lastTitleLoss } from './title-logic';
import { existingTitleBout, interimTitleJustification, rankChallengers, titleShotEligibility } from './title-eligibility';
import { fulfilInterest, interestReason, matchupPull, type MatchupInterest } from './matchup-interest';
import { contenderStatusFor, currentContender, restoreContenderStatus } from './contender';
import { bookBout, inCampFighterIds, offerBlockReason, releaseBooking, replaceSide } from './availability';
import { meetingsBetween } from './indexes';
import { resolveMessagesForBout } from './inbox';
import { clearFightWeek } from './fightweek';
import { willingToFight } from './identity';
import { purseForBout } from './economy';
import { VENUE_CITIES, type VenueCity } from './venues';
import { NAME_BANKS } from '../data/names';
import { fightNightName, numberedEventName } from '../config/branding';

/**
 * Event generation and matchmaking.
 *
 * Matchmaking never simply pairs adjacent Ovr values. It scores candidate opponents on
 * the same considerations a matchmaker actually weighs: what the fight does for the
 * division, whether it makes a title picture clearer, whether it sells, whether both
 * fighters are available, and whether it has been made too recently.
 */

/**
 * Minimum days between a champion's fights. Both booking paths, the weekly title pass in
 * tick.ts and card seeding here, apply the same figure so a title fight cannot be made by
 * one path at a pace the other would refuse.
 *
 * This figure sets the title fight rate almost on its own. It is the binding constraint,
 * not a floor that rarely bites: measured utilization is about 75 percent of the ceiling it
 * implies, so the observed rate is close to 0.75 * 365 / this value. At 130 days that came
 * out at 2.11 title fights per division per year, well above the one to two band, which is
 * a champion defending every four months. Six months is the cadence a titleholder actually
 * keeps.
 *
 * Measured directly: champion activity comes out at almost exactly 365 divided by this value,
 * because the gate binds on essentially every reign. At 180 that is 2.03 fights a year, just
 * outside the one to two band the design calls for. At 205 it is 1.78, and title fights per
 * division per year stays inside its own band.
 *
 * That 1.78 was measured with every eligible champion free to land on the same card. With the
 * per card limit in `MATCHMAKING.titleBoutsPerCard` a division sometimes waits a week or two for a
 * card with room, and two year worlds come out at about 1.5, still well inside the band.
 */
/** 'the United States', 'the Netherlands', 'Brazil': a country as it reads inside a sentence. */
export function countryWithArticle(country: string): string {
  return /^(United States|United Kingdom|Netherlands|Philippines|Czech Republic|Dominican Republic|United Arab Emirates)$/.test(country) ? `the ${country}` : country;
}

export const CHAMPION_TURNAROUND_DAYS = 205;

/**
 * Minimum days since a fighter's last bout before they can take short notice cover.
 *
 * Shorter than the ordinary turnaround, because stepping in late is exactly when a fighter accepts
 * a quick turnaround, but not absent: the replacement path previously had no gate at all and would
 * book somebody who had fought the week before.
 */
export const REPLACEMENT_MIN_TURNAROUND_DAYS = 28;

export function regionOfFighter(f: Fighter): string | null {
  const bank = NAME_BANKS.find((b) => b.country === f.country);
  return bank?.region ?? null;
}

// ---------------------------------------------------------------------------
// Event scheduling
// ---------------------------------------------------------------------------

/**
 * Annual calendar targets.
 *
 * The promotion runs a rolling twelve months of roughly 46 events: 14 numbered pay per
 * view cards and 32 fight nights, leaving about six weekends clear. The scheduler walks
 * real Saturdays and selects event weekends rather than stepping a fixed number of days,
 * which is what makes the yearly totals come out right instead of drifting.
 */
export const CALENDAR_TARGETS = {
  // Forty eight cards a year. The real roster is now the ranked fighters plus everybody on recent
  // official cards, over six hundred people, and forty six cards left most of them fighting fewer
  // than twice a year. Still inside the forty to fifty two a year acceptance holds.
  eventsPerYear: 48,
  ppvPerYear: 14,
  fightNightsPerYear: 34,
  clearWeekendsPerYear: 4,
  /** Minimum days between numbered cards. */
  minDaysBetweenPpv: 20,
  /** No card is created closer than this, so every event has time to be booked. */
  minLeadTimeDays: 42,
};

/** Card shapes. Totals are the bouts scheduled at announcement, before withdrawals. */
interface CardShape {
  total: number;
  main: number;
  prelim: number;
  early: number;
  weight: number;
}

const PPV_SHAPES: CardShape[] = [
  { total: 12, main: 5, prelim: 4, early: 3, weight: 0.3 },
  { total: 13, main: 5, prelim: 4, early: 4, weight: 0.45 },
  { total: 14, main: 5, prelim: 5, early: 4, weight: 0.25 },
];

const FIGHT_NIGHT_SHAPES: CardShape[] = [
  // Weighted toward thirteen bouts, which is a full modern fight night, so a roster of over six
  // hundred real fighters has enough slots. Every shape is one a real card has had.
  { total: 11, main: 5, prelim: 6, early: 0, weight: 0.08 },
  { total: 12, main: 6, prelim: 6, early: 0, weight: 0.24 },
  { total: 13, main: 6, prelim: 7, early: 0, weight: 0.36 },
  { total: 14, main: 6, prelim: 8, early: 0, weight: 0.32 },
];

export function pickCardShape(tier: EventTier, rng: Rng): CardShape {
  const pool = tier === 'numbered-ppv' ? PPV_SHAPES : FIGHT_NIGHT_SHAPES;
  return rng.weighted(pool, (c) => c.weight);
}

function pickVenue(rng: Rng, tier: EventTier): VenueCity {
  const pool = VENUE_CITIES.filter((v) =>
    tier === 'numbered-ppv' ? v.capacity >= 14000 : tier === 'apex' ? Boolean(v.isHomeMarket) && v.capacity < 6000 : true
  );
  return rng.weighted(pool.length > 0 ? pool : VENUE_CITIES, (v) => v.weight);
}

/**
 * Schedules events forward so the calendar always has a booked horizon.
 *
 * Every Saturday inside the horizon is considered. A fraction are left clear, and the
 * remainder are assigned a tier so that the rolling twelve month totals land on the
 * annual targets. Numbered cards are spaced so two never land in the same fortnight.
 */
export function scheduleEvents(save: SaveGame, rng: Rng, horizonDays = 190): FightCardEvent[] {
  const created: FightCardEvent[] = [];
  // Regional cards share the save but not the calendar. Counting them here let a regional card on
  // a Saturday take that weekend away from the main promotion.
  const existing = Object.values(save.events).filter((e) => !e.promotionId);
  const end = addDays(save.date, horizonDays);

  const lastScheduled = existing
    .filter((e) => e.status === 'announced')
    .map((e) => e.date)
    .sort();
  let cursor = lastScheduled.length > 0 ? lastScheduled[lastScheduled.length - 1] : addDays(save.date, -7);

  // The scaling factor lets the events per month setting move the whole calendar without
  // breaking the ratio between numbered cards and fight nights.
  const scale = clamp(save.settings.eventsPerMonth / (CALENDAR_TARGETS.eventsPerYear / 12), 0.25, 2);
  const eventWeekendRate = clamp(((52 - CALENDAR_TARGETS.clearWeekendsPerYear) / 52) * scale, 0.15, 1);
  const ppvShare = CALENDAR_TARGETS.ppvPerYear / CALENDAR_TARGETS.eventsPerYear;

  // Never create a card so close to today that nobody could be matched onto it.
  const earliest = addDays(save.date, CALENDAR_TARGETS.minLeadTimeDays);
  let date = cursor > earliest ? cursor : earliest;
  while (dayOfWeek(date) !== 6) date = addDays(date, 1);
  date = addDays(date, -7);

  while (date < end) {
    date = addDays(date, 7);
    if (date > end) break;
    if (date < earliest) continue;
    if (existing.some((e) => e.date === date) || created.some((e) => e.date === date)) continue;

    // Some weekends are deliberately left clear. The verdict is derived from the date and
    // the save seed rather than drawn fresh, because the scheduler runs every week and a
    // fresh draw would keep re-rolling a skipped weekend until it was finally taken.
    const weekendRoll = (hashString(`weekend-${date}-${save.seed}`) % 100000) / 100000;
    if (weekendRoll >= eventWeekendRate) continue;
    cursor = date;

    // Numbered card spacing. A rolling window keeps the yearly split on target rather
    // than letting a run of random draws pull it away.
    const recent = [...existing, ...created].filter((e) => Math.abs(daysBetween(e.date, date)) <= 182);
    const recentPpv = recent.filter((e) => e.tier === 'numbered-ppv').length;
    const lastPpvGap = recent
      .filter((e) => e.tier === 'numbered-ppv' && e.date <= date)
      .reduce((best, e) => Math.min(best, daysBetween(e.date, date)), 9999);
    const spacingOk = lastPpvGap >= CALENDAR_TARGETS.minDaysBetweenPpv;
    // How many numbered cards the trailing window should already contain. Being behind
    // forces one as soon as spacing allows; being ahead suppresses the next.
    const expectedPpv = (recent.length + 1) * ppvShare;
    const wantsPpv =
      spacingOk &&
      (recentPpv + 1 <= expectedPpv * 0.98
        ? true
        : recentPpv >= expectedPpv * 1.12
          ? false
          : rng.chance(clamp(ppvShare * 1.5, 0.05, 0.9)));

    const tier: EventTier = wantsPpv
      ? 'numbered-ppv'
      : rng.chance(0.45)
        ? 'apex'
        : rng.chance(0.55)
          ? 'international'
          : 'fight-night';

    const venue = pickVenue(rng, tier);
    const numberedCount = save.counters.ppvNumber ?? 320;
    if (tier === 'numbered-ppv') save.counters.ppvNumber = numberedCount + 1;
    const id: EventId = `evt-${++save.counters.event}`;

    // Generated events belong to the fictional promotion. Numbered cards and fight nights
    // each carry their own running number.
    const fightNightCount = save.counters.fightNightNumber ?? 83;
    if (tier !== 'numbered-ppv') save.counters.fightNightNumber = fightNightCount + 1;
    const name = tier === 'numbered-ppv' ? numberedEventName(numberedCount + 1) : fightNightName(fightNightCount + 1);
    const shape = pickCardShape(tier, rng);

    const ev: FightCardEvent = {
      id,
      name,
      date,
      city: venue.city,
      country: venue.country,
      countryCode: venue.countryCode,
      venue: venue.venueLabel,
      tier,
      boutIds: [],
      status: 'announced',
      attendance: null,
      drawScore: 0,
      fightOfTheNightBoutId: null,
      performanceBonusFighterIds: [],
      bonusAmount: 50000,
      plannedBouts: shape.total,
      plannedMain: shape.main,
      plannedPrelim: shape.prelim,
      plannedEarly: shape.early,
      announcedBoutIds: [],
      weighInBoutIds: [],
      contestedBoutIds: [],
      canceledBoutIds: [],
    };
    save.events[id] = ev;
    created.push(ev);
  }
  return created;
}

/** Counts events in the twelve months ending on the given date. */
export function rollingYearCounts(save: SaveGame, on: IsoDate): { events: number; ppv: number; fightNight: number } {
  let events = 0;
  let ppv = 0;
  for (const e of Object.values(save.events)) {
    if (e.promotionId) continue;
    const gap = daysBetween(e.date, on);
    if (gap < 0 || gap > 365) continue;
    events++;
    if (e.tier === 'numbered-ppv') ppv++;
  }
  return { events, ppv, fightNight: events - ppv };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface AvailabilityContext {
  date: IsoDate;
  /** A championship booking, which outranks a routine offer the fighter is holding. */
  isChampionshipBooking?: boolean;
  /** Bouts already booked, used to avoid double booking. */
  bookedFighterIds: Set<FighterId>;
  /**
   * Fighters named on an open offer, built once per booking pass. Scanning every offer
   * inside the per candidate availability check made matchmaking quadratic in the number
   * of open offers, which is the sort of thing that only shows up years into a save.
   */
  openOfferFighterIds?: Set<FighterId>;
  inCampFighterIds?: Set<FighterId>;
}

/** Builds the open offer set once so availability checks stay constant time. */
export function openOfferFighterIds(save: SaveGame): Set<FighterId> {
  const ids = new Set<FighterId>();
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    ids.add(offer.fighterId);
    ids.add(offer.opponentId);
  }
  return ids;
}

/**
 * How many more championship bouts this card can take, from `MATCHMAKING.titleBoutsPerCard`.
 *
 * A title offer still open with the player for this card counts as well. The title pass takes
 * that bout off the card while the player decides, and without counting the offer a second
 * division could be booked into the slot it is holding.
 */
export function titleBoutRoom(save: SaveGame, event: FightCardEvent): number {
  const cap = M.titleBoutsPerCard[event.tier] ?? 1;
  let used = 0;
  for (const id of event.boutIds) {
    const b = save.bouts[id];
    if (b && b.status === 'scheduled' && isChampionshipBout(b)) used++;
  }
  for (const o of Object.values(save.fightOffers)) {
    if (o.status === 'open' && o.eventId === event.id && (o.isTitleFight || o.isInterimTitleFight)) used++;
  }
  return Math.max(0, cap - used);
}

/**
 * Whether this fighter can be matched onto a card.
 *
 * The structural half of the question, every reason a fighter is already spoken for, lives
 * in `offerBlockReason` so that the matchmaker, the title pass, the replacement finder and
 * the player offer path cannot disagree about it. What stays here is the part that is about
 * matchmaking rather than availability: whether the fighter wants this fight at all.
 */
export function isAvailable(save: SaveGame, f: Fighter, ctx: AvailabilityContext): boolean {
  const blocked = offerBlockReason(save, f, {
    eventDate: ctx.date,
    takenFighterIds: ctx.bookedFighterIds,
    openOfferFighterIds: ctx.openOfferFighterIds,
    inCampFighterIds: ctx.inCampFighterIds,
    isChampionshipBooking: ctx.isChampionshipBooking,
  });
  if (blocked) return false;
  // Fighters do not all compete at the same rate. A fighter inside their own preferred
  // turnaround, or already at their yearly target, is a harder booking. This still applies to
  // a championship: bypassing it made every division book title fights faster and pushed the
  // measured title fight rate up, which crowded the player out rather than helping them.
  if (!willingToFight(save, f, daysBetween(save.date, ctx.date), ctx.date)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Matchmaking scoring
// ---------------------------------------------------------------------------

export type BookingKind =
  | 'title-fight'
  | 'interim-title'
  | 'eliminator'
  | 'ranked-matchup'
  | 'prospect-test'
  | 'veteran-vs-prospect'
  | 'style-clash'
  | 'rematch'
  | 'trilogy'
  | 'local-showcase'
  | 'comeback'
  | 'divisional-filler'
  | 'callout'
  | 'rivalry'
  | 'unification'
  | 'divisional-debut'
  | 'debut'
  | 'short-notice-replacement';

/**
 * The reason surfaced to the player for every generated fight.
 *
 * Stored on the bout and on the offer so the inbox and the offer page can both say why the
 * fight was made rather than presenting a matchup that appeared from nowhere.
 */
export const BOOKING_KIND_LABEL: Record<BookingKind, string> = {
  'title-fight': 'Championship bout',
  'interim-title': 'Interim championship bout',
  eliminator: 'Title eliminator',
  'ranked-matchup': 'Ranked contender matchup',
  'prospect-test': 'Prospect step up',
  'veteran-vs-prospect': 'Veteran against a prospect',
  'style-clash': 'Style clash',
  rematch: 'Rematch',
  trilogy: 'Trilogy decider',
  'local-showcase': 'Local showcase',
  comeback: 'Comeback fight',
  'divisional-filler': 'Divisional matchup',
  callout: 'Successful callout',
  rivalry: 'Rivalry fight',
  unification: 'Unification fight',
  'divisional-debut': 'Divisional debut',
  debut: 'Promotional debut',
  'short-notice-replacement': 'Short notice booking',
};

export interface MatchCandidate {
  opponent: Fighter;
  score: number;
  kind: BookingKind;
  reason: string;
  /** Set when this pairing came from a persistent matchmaking interest. */
  interest?: MatchupInterest;
}

/**
 * Every earlier meeting between two fighters, with the most recent one.
 *
 * This runs once per candidate pairing, so it reads the two fighters' own bout lists rather than
 * scanning the whole of history, which grows for as long as the career does.
 */
function priorMeetings(
  save: SaveGame,
  a: FighterId,
  b: FighterId
): { count: number; lastDate: IsoDate | null; last: FightResult | null; aWins: number; bWins: number } {
  let count = 0;
  let last: FightResult | null = null;
  let aWins = 0;
  let bWins = 0;
  for (const r of meetingsBetween(save, a, b)) {
    count++;
    if (!last || r.date > last.date) last = r;
    if (r.winnerId === a) aWins++;
    if (r.winnerId === b) bWins++;
  }
  return { count, lastDate: last?.date ?? null, last, aWins, bWins };
}

function styleContrast(a: Fighter, b: Fighter): number {
  const dims: (keyof Fighter['tendencies'])[] = ['pressure', 'range', 'takedownEntry', 'submissionHunt', 'pace', 'counter'];
  let d = 0;
  for (const k of dims) d += Math.abs(a.tendencies[k] - b.tendencies[k]);
  return d / dims.length;
}

/**
 * The share of a fighter's recent bouts that came against ranked opposition, 0 to 1.
 *
 * This is the strength of schedule input the matchmaker previously had no notion of, which is why
 * a fighter could beat elite opponents repeatedly and still be offered preliminary work.
 */
export function strengthOfSchedule(save: SaveGame, fighter: Fighter): number {
  const recent = fighter.boutIds.slice(-M.schedule.window);
  if (recent.length === 0) return 0;
  let ranked = 0;
  let counted = 0;
  for (const id of recent) {
    const result = save.history.results[id];
    if (!result) continue;
    counted++;
    const otherId = result.fighterAId === fighter.id ? result.fighterBId : result.fighterAId;
    const other = save.fighters[otherId];
    if (!other) continue;
    if (other.isChampion || (other.ranking !== null && other.ranking <= 15)) ranked++;
  }
  return counted === 0 ? 0 : ranked / counted;
}

/**
 * How much the promotion is currently invested in this fighter.
 *
 * Recent finishes and performance bonuses are what actually earn better placement, so momentum is
 * derived from them rather than stored as a number that could drift out of step with the record.
 */
export function promotionalMomentum(save: SaveGame, fighter: Fighter): number {
  let score = 0;
  for (const id of fighter.boutIds.slice(-6)) {
    const result = save.history.results[id];
    if (!result) continue;
    if (daysBetween(result.date, save.date) > M.momentum.recentWindowDays) continue;
    if (result.winnerId !== fighter.id) continue;
    if (isFinish(result.method)) score += M.momentum.perRecentFinish;
  }
  // Bonuses are recorded on the event rather than the fighter, so they are counted from the events
  // the fighter's recent bouts belong to.
  let bonuses = 0;
  for (const id of fighter.boutIds.slice(-6)) {
    const bout = save.bouts[id];
    if (!bout) continue;
    const event = save.events[bout.eventId];
    if (!event) continue;
    if (daysBetween(bout.date, save.date) > M.momentum.recentWindowDays) continue;
    if (event.performanceBonusFighterIds?.includes(fighter.id)) bonuses++;
    if (event.fightOfTheNightBoutId === bout.id) bonuses++;
  }
  score += bonuses * M.momentum.perRecentBonus;
  return Math.min(M.momentum.cap, score);
}

/**
 * Scores one candidate opponent for a given fighter on a given date.
 * Returns null when the pairing should not be made at all.
 */
export function scoreCandidate(
  save: SaveGame,
  fighter: Fighter,
  opponent: Fighter,
  event: FightCardEvent,
  rng: Rng
): MatchCandidate | null {
  if (fighter.id === opponent.id) return null;
  if (fighter.divisionId !== opponent.divisionId) return null;

  const table = save.rankings[fighter.divisionId];
  const rankA = table.championId === fighter.id ? 0 : fighter.ranking;
  const rankB = table.championId === opponent.id ? 0 : opponent.ranking;
  const isChampA = table.championId === fighter.id;
  const isChampB = table.championId === opponent.id;

  const history = priorMeetings(save, fighter.id, opponent.id);
  // A rematch needs a reason. Three meetings is the practical ceiling.
  if (history.count >= M.rematch.maxMeetings) return null;
  // An eligible matchup interest, a callout that was answered or a feud the promotion has taken up,
  // is the one thing that can stake a claim past the gates below. evaluateInterest has already held
  // it to the same standard of being earned. Raw rivalry pull is not a claim: a heated rivalry
  // alone used to skip every gate here, which is how a debutant was put in with a nine and two
  // veteran.
  const pullAB = matchupPull(save, fighter.id, opponent.id);
  const stakedClaim = pullAB.interest !== null && pullAB.interest.eligibility === 'eligible';
  // A rematch inside a year needs the first fight to have been worth running back. A wide
  // decision or an early finish does not qualify, which is what stops the same pairing being
  // remade over and over.
  if (history.count > 0 && history.lastDate && daysBetween(history.lastDate, event.date) < M.rematch.cooldownDays) {
    const previous = history.last;
    const worthRunningBack = previous ? fightCloseness(previous).value >= M.rematch.closenessRequired : false;
    if (!worthRunningBack && !(stakedClaim && pullAB.pull >= 0.5)) return null;
  }

  // Pairings a matchmaker would not consider at all. Everything below this is a weight, and a
  // weight only picks the best of the legal fights: when a division ran thin, a badly scored
  // mismatch was still the best available and got made. Measured before this gate existed, one
  // scheduled bout in ten was a top five fighter against an unranked opponent, including a
  // number one contender against a fighter at two and two.
  //
  // The claim staked above is exempt from the ranking gates. That is the stated reason a fight
  // nobody would otherwise make gets made.

  // A promotional debut is against another newcomer, whatever pull the pairing has. The experience
  // gate is separate from the ranking gate because a dangerous veteran can sit unranked: a debuting
  // player was handed a five and one finisher first time out, which no matchmaker books and no
  // debutant accepts.
  const fightsOf = (f: Fighter) => f.ufcRecord.wins + f.ufcRecord.losses + f.ufcRecord.draws + f.ufcRecord.noContests;
  if (!isChampA && !isChampB) {
    // A ranked fighter is established whatever their promotional count says: a generated
    // contender can arrive with a seeded ranking and an empty promotional record, and treating
    // them as a newcomer made them unbookable against the whole division.
    const isDebutant = (f: Fighter, rank: number | null) => fightsOf(f) === 0 && rank === null;
    const debutant = isDebutant(fighter, rankA) ? fighter : isDebutant(opponent, rankB) ? opponent : null;
    if (debutant) {
      const other = debutant === fighter ? opponent : fighter;
      const otherRank = other === fighter ? rankA : rankB;
      if (otherRank !== null) return null;
      if (fightsOf(other) > M.gate.debutOpponentMaxFights) return null;
    }
    // Experience is judged on the whole professional record as well as the promotional one, because
    // a generated veteran can arrive with a long record and few promotional fights, and on ability,
    // because a matchmaker knows who is good: a prospect is not fed somebody far better than them.
    // This also holds for a callout or a feud, which is no reason to feed a prospect to a veteran.
    const prospectSide = (f: Fighter, rank: number | null) => rank === null && fightsOf(f) <= M.gate.prospectWindowFights;
    const proFights = (f: Fighter) => f.record.wins + f.record.losses + f.record.draws;
    const outclasses = (veteran: Fighter, prospect: Fighter) =>
      fightsOf(veteran) > M.gate.prospectOpponentMaxFights ||
      proFights(veteran) > proFights(prospect) + 14 ||
      ovrRaw(veteran.ratings) > ovrRaw(prospect.ratings) + M.gate.prospectMaxOvrGap;
    if (prospectSide(fighter, rankA) && outclasses(opponent, fighter)) return null;
    if (prospectSide(opponent, rankB) && outclasses(fighter, opponent)) return null;
  }

  if (!isChampA && !isChampB && !stakedClaim) {
    const rankedSide = rankA !== null && rankB === null ? fighter : rankB !== null && rankA === null ? opponent : null;
    if (rankedSide) {
      const unranked = rankedSide === fighter ? opponent : fighter;
      const rankedAt = rankedSide === fighter ? rankA! : rankB!;
      const promotionalRecord = unranked.ufcRecord;
      const losingRecord = promotionalRecord.losses > promotionalRecord.wins;
      // Beating a fighter on a losing run proves nothing and losing to them costs everything.
      if (M.gate.refuseRankedAgainstLosingRecord && losingRecord) return null;
      // A step up has to be earned. The higher the ranked fighter, the more it takes.
      const needed = rankedAt <= M.gate.contenderRank ? M.gate.prospectStreakForTopFive : M.gate.prospectStreakForRanked;
      if (unranked.winStreak < needed) return null;
    }

    // The fighter holding the number one contender position is waiting on a title shot. Putting
    // them in with anyone outside the title picture risks the shot they earned for nothing.
    const contender = currentContender(save, fighter.divisionId);
    if (contender) {
      const contenderIsA = contender.fighterId === fighter.id;
      const contenderIsB = contender.fighterId === opponent.id;
      if (contenderIsA || contenderIsB) {
        const otherRank = contenderIsA ? rankB : rankA;
        if (otherRank === null || otherRank > M.gate.contenderRank) return null;
      }
    }
  }

  let score = 0;
  let kind: BookingKind = 'divisional-filler';
  let reason = 'a divisional matchup';

  // Championship logic dominates when a champion is involved. Every championship pairing
  // passes the shared eligibility gate, so an ineligible challenger is refused here exactly
  // as it would be on the weekly title pass rather than slipping through on a card.
  if (isChampA || isChampB) {
    const challenger = isChampA ? opponent : fighter;
    const eligibility = titleShotEligibility(save, challenger, fighter.divisionId, { vacant: false });
    if (!eligibility.eligible) return null;
    const challengerRank = isChampA ? rankB : rankA;
    score += M.base.titleFight - (challengerRank ?? 8) * M.base.titleFightRankPenalty;
    kind = 'title-fight';
    reason = eligibility.selectionReason;
  } else if (rankA !== null && rankB !== null) {
    const gap = Math.abs(rankA - rankB);
    // Ranked fighters meet fighters near them, with a bias toward the fighter ranked
    // above so a win actually means something.
    score += M.base.rankedMatchup - gap * M.base.rankedGapPenalty;
    // Only a fight that can actually decide the next challenger is an eliminator. With a number
    // one contender already standing, winning it does not take the spot, so two top five fighters
    // meeting is a ranked matchup and is not given the eliminator weight either.
    if (rankA <= 5 && rankB <= 5 && !currentContender(save, fighter.divisionId)) {
      score += M.base.eliminatorBonus;
      kind = 'eliminator';
      reason = 'a title eliminator between top five contenders';
    } else if (rankA <= 5 && rankB <= 5) {
      kind = 'ranked-matchup';
      reason = `a top five matchup at ${rankA} against ${rankB} with the number one contender already set`;
    } else {
      kind = 'ranked-matchup';
      reason = `a ranked matchup at ${rankA} against ${rankB}`;
    }
    if (gap > M.base.wideGapThreshold) score -= M.base.wideGapPenalty;
  } else if (rankA !== null && rankB === null) {
    // Ranked fighter against an unranked fighter is a step down unless the unranked
    // fighter is a hot prospect.
    const streak = opponent.winStreak;
    score += M.base.prospectTest + streak * M.base.prospectStreakBonus - (rankA <= 8 ? M.base.topTenAgainstUnrankedPenalty : 0);
    kind = 'prospect-test';
    // A fighter with no streak is not "on a 0 fight run", which is what this used to say.
    reason = streak >= 2 ? `a step up for a prospect on a ${streak} fight run` : 'a step up for an unranked fighter';
  } else if (rankA === null && rankB !== null) {
    score += M.base.prospectTest + fighter.winStreak * M.base.prospectStreakBonus - (rankB <= 8 ? M.base.topTenAgainstUnrankedPenalty : 0);
    kind = 'prospect-test';
    reason = 'a chance to break into the rankings';
  } else {
    score += M.base.unrankedPairing - Math.abs(fighter.winStreak - opponent.winStreak) * M.base.unrankedStreakGapPenalty;
    kind = 'divisional-filler';
    reason = 'a matchup between unranked fighters';
  }

  // ---- Career aware inputs. ----
  // Recent form. A losing streak makes a fighter a softer assignment, and a fighter deep in one is
  // protected from a step up rather than being fed to a contender.
  score -= Math.min(3, opponent.lossStreak) * M.form.lossStreakPenalty;
  score += Math.min(M.form.winStreakCap, opponent.winStreak) * M.form.winStreakBonus;
  if (opponent.lossStreak >= M.form.lossStreakProtectionAt && (rankA ?? 99) <= 8) score -= M.form.lossStreakProtectionPenalty;
  if (fighter.lossStreak >= M.form.lossStreakProtectionAt && (rankB ?? 99) <= 8) score -= M.form.lossStreakProtectionPenalty;

  // Championship history. A former champion is a bigger fight than their ranking alone says.
  const pedigree = (f: Fighter): number =>
    (f.titleReigns > 0 ? M.pedigree.formerChampionBonus : 0) +
    Math.min(M.pedigree.perDefenseCap, f.titleDefenses * M.pedigree.perDefenseBonus);
  const pedigreeA = pedigree(fighter);
  const pedigreeB = pedigree(opponent);
  score += (pedigreeA + pedigreeB) * 0.5;
  if (pedigreeA > 12 && rankB === null) score -= M.pedigree.pedigreeMismatchPenalty;
  if (pedigreeB > 12 && rankA === null) score -= M.pedigree.pedigreeMismatchPenalty;

  // Strength of schedule. Two fighters facing comparable opposition make a fair fight; a wide gap
  // means one of them has not earned the assignment yet.
  const scheduleGap = Math.abs(strengthOfSchedule(save, fighter) - strengthOfSchedule(save, opponent));
  score -= scheduleGap * M.schedule.mismatchPenalty;
  if (scheduleGap < 0.2) score += M.schedule.parityBonus;

  // Promotional momentum: recent finishes and bonuses make a fighter a card seller.
  score += (promotionalMomentum(save, fighter) + promotionalMomentum(save, opponent)) * 0.5;

  // Age and career stage produce recognisable matchmaking patterns.
  const ageA = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 29;
  const ageB = ageOn(opponent.birthDate, save.date) ?? opponent.ageAtSnapshot ?? 29;
  if (Math.abs(ageA - ageB) > M.age.veteranTestGap && Math.min(ageA, ageB) < M.age.veteranTestYoungerThan) {
    score += M.age.veteranTestBonus;
    if (kind === 'divisional-filler' || kind === 'ranked-matchup') {
      kind = 'veteran-vs-prospect';
      reason = 'a veteran test for a younger fighter';
    }
  }

  // Rematches and trilogies. A championship rematch stays a championship bout, so the
  // kind is only relabelled when no title is involved.
  const titleInvolved = isChampA || isChampB;
  if (history.count === 1) {
    score += M.rematch.rematchBonus;
    if (!titleInvolved) {
      kind = 'rematch';
      reason = 'a rematch of their previous meeting';
    } else {
      reason = `${reason}, in a rematch`;
    }
  } else if (history.count === 2 && history.aWins === 1 && history.bWins === 1) {
    score += M.rematch.trilogyBonus;
    if (!titleInvolved) {
      kind = 'trilogy';
      reason = 'a trilogy decider after one win each';
    } else {
      reason = `${reason}, completing a trilogy`;
    }
  }

  // Style contrast sells and produces better fights.
  const contrast = styleContrast(fighter, opponent);
  score += contrast * M.appeal.styleContrastWeight;
  if (contrast > M.appeal.styleClashThreshold && kind === 'ranked-matchup') {
    kind = 'style-clash';
    reason = 'a clear style clash';
  }

  // Local drawing power in the event market.
  const regionA = regionOfFighter(fighter);
  const regionB = regionOfFighter(opponent);
  const eventRegion = VENUE_CITIES.find((v) => v.city === event.city)?.region ?? 'north-america';
  if (regionA === eventRegion) score += M.appeal.sameRegionBonus;
  if (regionB === eventRegion) score += M.appeal.sameRegionBonus;
  if (fighter.country === event.country || opponent.country === event.country) {
    score += M.appeal.homeCountryBonus;
    if (kind === 'divisional-filler') {
      kind = 'local-showcase';
      reason = `a home market showcase in ${countryWithArticle(event.country)}`;
    }
  }

  // Popularity sells a card.
  score += (fighter.popularity + opponent.popularity) * M.appeal.popularityWeight;

  // A fighter coming off a long layoff gets an easier assignment.
  const layoffB = opponent.lastFightDate ? daysBetween(opponent.lastFightDate, event.date) : 999;
  if (layoffB > M.activity.longLayoffDays) {
    score += rankA !== null && rankA <= 8 ? -M.activity.longLayoffRankedPenalty : M.activity.longLayoffBonus;
    if (kind === 'divisional-filler') {
      kind = 'comeback';
      reason = 'a return fight after a long layoff';
    }
  }

  // Activity: the matchmaker prefers fighters who have been waiting.
  const waitA = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, event.date) : 200;
  const waitB = opponent.lastFightDate ? daysBetween(opponent.lastFightDate, event.date) : 200;
  score += clamp((waitA + waitB - M.activity.waitBaselineDays) / M.activity.waitDivisor, M.activity.waitFloor, M.activity.waitCeiling);

  // Contract pressure: a fighter on the last bout of a deal gets matched.
  const contractB = opponent.contractId ? save.contracts[opponent.contractId] : null;
  if (contractB && contractB.fightsRemaining === 1) score += M.relations.lastFightOnContractBonus;

  // Relationship: a fighter who keeps turning fights down gets offered less.
  score -= opponent.declinedOffers * M.relations.perDeclinedOfferPenalty;
  score += clamp(
    (opponent.relationships.matchmaker - 50) / M.relations.matchmakerRelationshipDivisor,
    -M.relations.matchmakerRelationshipCap,
    M.relations.matchmakerRelationshipCap
  );

  // Division congestion: when the top of a division is jammed, the matchmaker leans on
  // eliminators rather than more filler.
  const rankedActive = table.entries.filter((e) => {
    const f = save.fighters[e.fighterId];
    return f && !f.nextBoutId;
  }).length;
  if (rankedActive > M.congestion.crowdedRankedCount && kind === 'divisional-filler') score -= M.congestion.fillerPenalty;

  score += rng.range(-M.jitter, M.jitter);

  return { opponent, score, kind, reason };
}

export function findBestOpponent(
  save: SaveGame,
  fighter: Fighter,
  event: FightCardEvent,
  ctx: AvailabilityContext,
  rng: Rng,
  bias = 0,
  /** Opponents the caller has already ruled out, for example a champion who cannot defend. */
  excludeIds?: ReadonlySet<FighterId>
): MatchCandidate | null {
  const pool = mainRosterFighters(save).filter(
    (f) =>
      f.divisionId === fighter.divisionId &&
      f.id !== fighter.id &&
      !(excludeIds?.has(f.id) ?? false) &&
      isAvailable(save, f, ctx)
  );
  const scored: MatchCandidate[] = [];
  // Leverage the fighter has earned. A long unbeaten run or a decorated championship
  // history should not be matched with an unranked opponent, and an accepted callout or a
  // strong rematch claim should pull a specific opponent up the list.
  const leverage = assessTitleOpportunity(save, fighter, fighter.divisionId);
  const rematchTarget = rematchClaimTarget(save, fighter);
  // A top contender waits for a fitting opponent rather than taking whoever is free this week. The
  // gap penalty in scoreCandidate only reorders the candidates, so a thin week still handed a number
  // two on a long streak a fourteen or an unranked prospect. The wait is bounded, so a thin
  // division cannot leave them idle for good.
  const myRank = save.rankings[fighter.divisionId]?.championId === fighter.id ? 0 : fighter.ranking;
  const idle = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, event.date) : 999;
  const topContender = myRank !== null && myRank <= M.gate.topContenderRank;
  const holdOut = topContender && idle < M.gate.topContenderWaitDays;
  // Who the reason line is written for: the player when they are in the pairing, otherwise nobody.
  const playerId = save.player.fighterId;
  for (const opp of pool) {
    const c = scoreCandidate(save, fighter, opp, event, rng);
    if (!c) continue;
    // A live matchup interest is a real candidate, not a nudge. An accepted callout between
    // two available fighters in the same division now outweighs anything the ordinary
    // divisional scoring would have produced, which is what makes the callout mean something.
    const { pull, interest } = matchupPull(save, fighter.id, opp.id);
    const oppRankHere = opp.isChampion ? 0 : opp.ranking;
    const titlePairing = c.kind === 'title-fight' || c.kind === 'interim-title' || c.kind === 'unification';
    const claimed = (interest !== null && interest.eligibility === 'eligible') || opp.id === rematchTarget;
    if (topContender && !titlePairing && !claimed) {
      const beneath = oppRankHere === null || oppRankHere > myRank! + M.gate.topContenderMaxRankGap;
      if (holdOut && beneath) continue;
      if (oppRankHere === null) c.score -= M.gate.topContenderUnrankedPenalty;
    }
    // The same wait from the other side: a lower seed does not draw an idle top contender down.
    if (!titlePairing && !claimed && oppRankHere !== null && oppRankHere <= M.gate.topContenderRank) {
      const oppIdle = opp.lastFightDate ? daysBetween(opp.lastFightDate, event.date) : 999;
      const beneathThem = myRank === null || myRank > oppRankHere + M.gate.topContenderMaxRankGap;
      if (oppIdle < M.gate.topContenderWaitDays && beneathThem) continue;
    }
    if (pull < 0) {
      // Training partners and close friends are pushed out of contention entirely.
      if (pull <= MATCHUP_PULL.refuseAtOrBelow) continue;
      c.score += pull * MATCHUP_PULL.negative;
    } else if (pull > 0) {
      c.score += pull * MATCHUP_PULL.positive;
      // A championship or eliminator pairing keeps its category. Relabelling it as a callout would
      // strip the belt off the bout and lose the contender implications with it.
      const structural =
        c.kind === 'title-fight' || c.kind === 'interim-title' || c.kind === 'eliminator' || c.kind === 'unification';
      if (interest && interest.eligibility === 'eligible' && !structural) {
        c.interest = interest;
        c.kind = interest.source === 'callout' ? 'callout' : interest.source === 'rivalry' ? 'rivalry' : c.kind;
        c.reason = interestReason(save, interest, fighter.id === playerId || opp.id === playerId ? playerId : null);
      } else if (interest && interest.eligibility === 'eligible') {
        c.interest = interest;
      } else if (c.kind === 'divisional-filler' || c.kind === 'ranked-matchup') {
        c.kind = 'rivalry';
        c.reason = 'a rivalry the fans have been asking for';
      }
    }
    // Difficulty, applied where opponent quality is known rather than as an index into the
    // finished list. A positive bias favours the softer assignment and a negative one the harder.
    // At the default difficulty the bias is zero and this term does nothing, so an existing save
    // scores exactly as it did.
    if (bias !== 0) {
      const edge = ovrRaw(opp.ratings) - ovrRaw(fighter.ratings);
      // The gap is softened before the bias scales it, using plain arithmetic rather than a
      // transcendental so the result is identical on every machine that opens the save.
      const softened = edge / (1 + Math.abs(edge) / M.difficultyOvrCap);
      c.score -= softened * bias * M.difficultyPerOvrPoint;
    }
    if (rematchTarget && opp.id === rematchTarget) c.score += 30;
    // A fighter with strong leverage is steered toward meaningful opposition.
    if (leverage.score >= 62) {
      const oppRank = opp.isChampion ? 0 : (opp.ranking ?? 99);
      if (oppRank <= 5) c.score += 26;
      else if (oppRank <= 10) c.score += 10;
      else if (oppRank > 15) c.score -= 30;
    }
    scored.push(c);
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  // A fight both sides have publicly agreed to is made, not drawn for. The pull already puts an
  // accepted callout at the top of the list, but the final pick was a weighted draw over the top
  // four, so the fight the player talked their way into still came down to a roll and could
  // simply not happen for no stated reason.
  const best = scored[0];
  if (best.interest && best.interest.eligibility === 'eligible') {
    rng.next();
    return best;
  }

  // A small amount of randomness among the top options keeps a long save varied. The difficulty
  // bias has already been applied to the scores above, so every setting draws the same way and
  // none of them collapses to a single fixed choice.
  const top = scored.slice(0, Math.min(4, scored.length));
  return rng.weighted(top, (c, i) => Math.max(0.5, c.score) / (1 + i * 0.6));
}

// ---------------------------------------------------------------------------
// Card construction
// ---------------------------------------------------------------------------

/** The shape chosen for this event when it was created. */
function cardSizeFor(event: FightCardEvent): { main: number; prelim: number; early: number } {
  if (event.plannedMain > 0) {
    return { main: event.plannedMain, prelim: event.plannedPrelim, early: event.plannedEarly };
  }
  // Older saves created before card shapes were stored fall back to a standard card.
  return event.tier === 'numbered-ppv' ? { main: 5, prelim: 4, early: 3 } : { main: 6, prelim: 6, early: 0 };
}

export interface BookingResult {
  bouts: Bout[];
  notes: string[];
}

/** Fills an event card with bouts. */
export function bookEvent(save: SaveGame, event: FightCardEvent, rng: Rng): BookingResult {
  const size = cardSizeFor(event);
  const total = size.main + size.prelim + size.early;
  const booked = new Set<FighterId>();
  for (const bid of event.boutIds) {
    const b = save.bouts[bid];
    if (b && b.status === 'scheduled') {
      booked.add(b.fighterAId);
      booked.add(b.fighterBId);
    }
  }
  const ctx: AvailabilityContext = {
    date: event.date,
    bookedFighterIds: booked,
    openOfferFighterIds: openOfferFighterIds(save),
    inCampFighterIds: inCampFighterIds(save),
  };
  const bouts: Bout[] = [];
  const notes: string[] = [];
  const diff = DIFFICULTY[save.settings.difficulty];
  // Bouts already on the card count toward the card size cap.
  const alreadyBooked = event.boutIds.filter((id) => save.bouts[id]?.status === 'scheduled').length;
  const remainingSlots = Math.max(0, total - alreadyBooked);

  // Seeding order matters. Walking one division to exhaustion before starting the next
  // would fill an entire card with a single weight class, so seeds are interleaved:
  // every champion first, then rank tier by rank tier across all divisions, then the
  // unranked pool.
  const seeds: Fighter[] = [];
  const champions: Fighter[] = [];
  // Champions who may be booked on this card at all. A champion can be reached from either
  // side of the pairing, so this has to be a set rather than a seeding filter: a contender
  // seeded from the ranked queue used to pull an ineligible champion into a title fight
  // with no turnaround gate and on any card, which is what pushed title fights per division
  // per year over its band.
  const defendableChampionIds = new Set<FighterId>();
  const allChampionIds = new Set<FighterId>();
  for (const d of DIVISIONS) {
    const table = save.rankings[d.id];
    const champ = table.championId ? save.fighters[table.championId] : null;
    if (!champ) continue;
    allChampionIds.add(champ.id);
    // The interim champion is a titleholder too. Leaving them out of this set meant they were
    // seeded and matched as an ordinary contender, with no turnaround gate and no protection from
    // being booked into filler while holding a belt.
    if (table.interimChampionId) allChampionIds.add(table.interimChampionId);
    if (!isAvailable(save, champ, ctx)) continue;
    const daysSince = champ.lastFightDate ? daysBetween(champ.lastFightDate, event.date) : 400;
    // Champions defend a few times a year, not on every card. A big card is the place.
    const bigCard = event.tier === 'numbered-ppv' || event.tier === 'international';
    if (daysSince > CHAMPION_TURNAROUND_DAYS && bigCard) {
      defendableChampionIds.add(champ.id);
      champions.push(champ);
    }
  }
  seeds.push(...rng.shuffle(champions));

  const byTier: Fighter[][] = [[], [], []];
  for (const d of DIVISIONS) {
    for (const e of save.rankings[d.id].entries) {
      const f = save.fighters[e.fighterId];
      if (!f || !isAvailable(save, f, ctx)) continue;
      byTier[e.rank <= 5 ? 0 : e.rank <= 10 ? 1 : 2].push(f);
    }
  }
  const rankedQueue: Fighter[] = [];
  for (const tier of byTier) rankedQueue.push(...rng.shuffle(tier));
  const unrankedQueue = rng.shuffle(mainRosterFighters(save).filter((f) => f.ranking === null && isAvailable(save, f, ctx)));

  // Ranked and unranked fighters are interleaved rather than exhausted in order. There
  // are far more ranked fighters than card slots, so taking them first would freeze every
  // unranked fighter out of the sport permanently. Real cards put ranked bouts on the
  // main card and unranked bouts on the preliminaries, so the ratio leans unranked.
  const RANKED_PER_BLOCK = 2;
  const UNRANKED_PER_BLOCK = 3;
  while (rankedQueue.length > 0 || unrankedQueue.length > 0) {
    for (let i = 0; i < RANKED_PER_BLOCK && rankedQueue.length > 0; i++) seeds.push(rankedQueue.shift()!);
    for (let i = 0; i < UNRANKED_PER_BLOCK && unrankedQueue.length > 0; i++) seeds.push(unrankedQueue.shift()!);
  }

  // A fighter who has earned the next title shot is not filler. Ordinary card seeding could book
  // them into a routine bout before the title pass reached their division, which spent the claim
  // on a fight they never asked for and made winning an eliminator worth nothing again.
  // The player is not one name in four hundred. A fighter the player controls who has been waiting
  // goes to the front of the queue, so a career is not left idle for months while the same
  // matchmaker books everybody else. The usual gates still decide who they fight.
  const playerId = save.player.fighterId;
  const playerSeed = playerId ? seeds.findIndex((f) => f.id === playerId) : -1;
  if (playerSeed > 0) {
    const me = seeds[playerSeed];
    const idle = me.lastFightDate ? daysBetween(me.lastFightDate, event.date) : 999;
    // A player who volunteered for short notice work is first in line for a late slot on a card
    // close to the date. That is what the volunteer button promises. The player is never assigned
    // as a withdrawal replacement (every fight they take is an offer), so this is where it counts.
    const volunteered = Boolean(me.volunteeredShortNoticeUntil && me.volunteeredShortNoticeUntil >= save.date) && daysBetween(save.date, event.date) <= 30;
    if (idle >= 70 || volunteered) {
      seeds.splice(playerSeed, 1);
      seeds.unshift(me);
    }
  }

  const reservedContenders = new Set<FighterId>();
  for (const d of DIVISIONS) {
    const standing = currentContender(save, d.id);
    if (standing) reservedContenders.add(standing.fighterId);
  }

  // Championship bouts this card can still take. Once it is full no further champion is seeded or
  // offered as an opponent, the same cap the weekly title pass applies.
  let titleRoom = titleBoutRoom(save, event);

  for (const fighter of seeds) {
    if (bouts.length >= remainingSlots) break;
    if (booked.has(fighter.id)) continue;
    if (reservedContenders.has(fighter.id)) continue;
    // A champion who cannot defend on this card is never a candidate at all. Choosing the best
    // opponent and then discarding the pairing threw the seeded fighter's slot away, wasting card
    // capacity and denying that fighter a fight for no stated reason.
    const canDefendHere = (id: FighterId) => defendableChampionIds.has(id) && titleRoom > 0;
    if (allChampionIds.has(fighter.id) && !canDefendHere(fighter.id)) continue;
    const ineligibleChampions = new Set<FighterId>();
    for (const id of allChampionIds) if (!canDefendHere(id)) ineligibleChampions.add(id);
    // A reserved contender is not an opponent for filler either.
    for (const id of reservedContenders) ineligibleChampions.add(id);

    const isPlayerFighter = save.player.fighterId === fighter.id;
    const candidate = findBestOpponent(
      save,
      fighter,
      event,
      ctx,
      rng,
      isPlayerFighter ? diff.matchmakingBias : 0,
      ineligibleChampions
    );
    if (!candidate) continue;

    const table = save.rankings[fighter.divisionId];
    let isTitle =
      candidate.kind === 'title-fight' && (table.championId === fighter.id || table.championId === candidate.opponent.id);
    let isInterim = candidate.kind === 'interim-title';

    // One belt, one bout. Card seeding used to be able to create a second championship fight
    // in a division that already had one scheduled, because only the weekly title pass
    // checked. A pairing that would duplicate a belt is demoted to a ranked matchup rather
    // than being dropped, so the card still fills.
    if ((isTitle || isInterim) && existingTitleBout(save, fighter.divisionId)) {
      isTitle = false;
      isInterim = false;
      candidate.kind = 'ranked-matchup';
      candidate.reason = 'a ranked matchup with the championship already booked elsewhere';
    }
    // An interim belt is never created here without the shared justification.
    if (isInterim && !interimTitleJustification(save, fighter.divisionId).justified) {
      isInterim = false;
      if (currentContender(save, fighter.divisionId)) {
        candidate.kind = 'ranked-matchup';
        candidate.reason = 'a ranked matchup with the number one contender already set';
      } else {
        candidate.kind = 'eliminator';
        candidate.reason = 'a title eliminator';
      }
    }
    // The card already carries all the championship bouts it can. The pairing is kept as a ranked
    // matchup rather than dropped, the same way a duplicate belt is handled above.
    if ((isTitle || isInterim) && titleRoom <= 0) {
      isTitle = false;
      isInterim = false;
      candidate.kind = 'ranked-matchup';
      candidate.reason = 'a ranked matchup with the card already carrying its championship bouts';
    }
    if (isTitle || isInterim) titleRoom--;

    booked.add(fighter.id);
    booked.add(candidate.opponent.id);

    const boutId: BoutId = `bout-${++save.counters.bout}`;
    const isMain = alreadyBooked === 0 && bouts.length === 0;
    const scheduledRounds: 3 | 5 = isTitle || isInterim || isMain ? 5 : 3;

    const contractA = fighter.contractId ? save.contracts[fighter.contractId] : null;
    const contractB = candidate.opponent.contractId ? save.contracts[candidate.opponent.contractId] : null;

    const bout: Bout = {
      id: boutId,
      eventId: event.id,
      date: event.date,
      fighterAId: fighter.id,
      fighterBId: candidate.opponent.id,
      divisionId: fighter.divisionId,
      contractedWeightLb: contractedWeight(fighter.divisionId, isTitle || isInterim),
      scheduledRounds,
      isTitleFight: isTitle,
      isInterimTitleFight: isInterim,
      titleIneligibleFighterIds: [],
      isMainEvent: isMain,
      isCoMain: bouts.length === 1,
      cardSegment: bouts.length < size.main ? 'main' : bouts.length < size.main + size.prelim ? 'prelim' : 'early-prelim',
      boutOrder: total - bouts.length,
      isCatchweight: false,
      status: 'scheduled',
      resultId: null,
      bookedOn: save.date,
      replacementHistory: [],
      cancelReason: null,
      purseA: purseForBout(contractA, fighter, save, { isMainEvent: isMain, isTitleFight: isTitle || isInterim, shortNotice: false }),
      purseB: purseForBout(contractB, candidate.opponent, save, { isMainEvent: isMain, isTitleFight: isTitle || isInterim, shortNotice: false }),
      weighInA: null,
      weighInB: null,
      bookingReason: candidate.reason,
      bookingKind: candidate.kind,
    };

    // One transaction owns the booking and both pointers. It refuses rather than
    // overwriting when either fighter turns out to be taken.
    const booking = bookBout(save, bout);
    if (!booking.created) {
      save.counters.bout--;
      continue;
    }
    // A matchup interest that produced a fight is closed against that fight, so the player
    // can see that the callout they made is the reason this bout exists.
    if (candidate.interest) fulfilInterest(candidate.interest, null, bout.id);
    bouts.push(bout);
    notes.push(`${fighter.name} against ${candidate.opponent.name}: ${candidate.reason}.`);
  }

  orderCard(save, event);

  // Only the bouts created by this pass are returned. Returning the whole card would let
  // a caller act twice on a bout that was already agreed, which previously cancelled an
  // accepted bout and re-offered it, and created a duplicate camp every week.
  return { bouts, notes };
}

/**
 * Orders a card so the best fight closes it, and sets the main event, co-main, segments and
 * round counts to match.
 *
 * Shared by card seeding and the weekly title pass. The title pass used to add its bout as a
 * second main event with a placeholder position and leave the card as it was, so until card
 * seeding happened to run again a card could show two main events.
 */
export function orderCard(save: SaveGame, event: FightCardEvent): void {
  const size = cardSizeFor(event);
  // Reorder so the best fight closes the card. This must consider every scheduled bout
  // on the event, not only the ones booked in this pass, otherwise earlier bouts would be
  // dropped from the card and left orphaned with their fighters still marked as booked.
  const allScheduled = event.boutIds
    .map((id) => save.bouts[id])
    .filter((b): b is Bout => Boolean(b) && b.status === 'scheduled');
  const ranked = allScheduled
    .map((b) => ({
      b,
      weight:
        (b.isTitleFight ? 1000 : b.isInterimTitleFight ? 900 : 0) +
        (save.fighters[b.fighterAId].popularity + save.fighters[b.fighterBId].popularity) +
        (16 - Math.min(16, save.fighters[b.fighterAId].ranking ?? 16)) * 3 +
        (16 - Math.min(16, save.fighters[b.fighterBId].ranking ?? 16)) * 3,
    }))
    .sort((x, y) => y.weight - x.weight)
    .map((x) => x.b);

  ranked.forEach((b, i) => {
    b.isMainEvent = i === 0;
    b.isCoMain = i === 1;
    b.cardSegment = i < size.main ? 'main' : i < size.main + size.prelim ? 'prelim' : 'early-prelim';
    b.boutOrder = ranked.length - i;
    // Any championship bout is five rounds wherever it sits on the card, and so is a main
    // event that is not for a belt. A round count agreed in negotiation is also kept: resetting
    // it here is how a player who was told their five round request was approved fought three.
    if (isChampionshipBout(b) || b.isMainEvent || b.roundsAgreed) b.scheduledRounds = 5;
    else b.scheduledRounds = 3;
  });
  event.boutIds = ranked.map((b) => b.id);
}

/**
 * Finds a short notice replacement when a booked fighter withdraws. Replacements accept
 * a wider quality gap because the alternative is losing the bout entirely.
 */
export function findReplacement(
  save: SaveGame,
  bout: Bout,
  withdrawingId: FighterId,
  rng: Rng
): { fighter: Fighter; reason: string } | null {
  const remainingId = bout.fighterAId === withdrawingId ? bout.fighterBId : bout.fighterAId;
  const remaining = save.fighters[remainingId];
  if (!remaining) return null;

  const noticeDays = daysBetween(save.date, bout.date);
  const booked = new Set<FighterId>();
  for (const b of Object.values(save.bouts)) {
    if (b.status === 'scheduled' && b.id !== bout.id) {
      booked.add(b.fighterAId);
      booked.add(b.fighterBId);
    }
  }

  // Built once for the whole roster. Without them every candidate scanned every camp and every
  // offer in the save, which made a single withdrawal cost the roster times all camps ever run.
  // Nothing in the filter below changes camps or offers, so one snapshot of each is exact.
  const inCamp = inCampFighterIds(save);
  const openOffers = openOfferFighterIds(save);
  const boutDivision = DIVISION_BY_ID[bout.divisionId];

  const pool = mainRosterFighters(save).filter((f) => {
    if (f.id === remainingId || f.id === withdrawingId) return false;
    // The player is never assigned a bout. Every fight they take arrives as an offer they
    // can accept, negotiate or turn down, including short notice work.
    if (f.id === save.player.fighterId) return false;
    // The cheap checks run first, so only a plausible candidate pays for the full availability
    // question. None of them draws from the rng, so the order changes nothing but the cost.
    if (f.divisionId !== bout.divisionId) {
      const own = DIVISION_BY_ID[f.divisionId];
      const adjacent = Boolean(own && boutDivision) && Math.abs(own.order - boutDivision.order) === 1;
      if (!adjacent || noticeDays > 21) return false;
    }
    // A reigning champion is not short notice cover. This path had no turnaround gate at all, so a
    // champion could be booked weeks after defending, which pushed champion activity above band.
    const homeTable = save.rankings[f.divisionId];
    if (homeTable?.championId === f.id || homeTable?.interimChampionId === f.id) return false;
    // Nor is the number one contender, who is waiting on a title shot. Every other booking path
    // reserves them, and a loss here forfeited the shot they had earned. The one exception is the
    // championship of their own division, which is the fight the claim is for.
    const claim = contenderStatusFor(save, f.id);
    if (claim && !(isChampionshipBout(bout) && claim.divisionId === bout.divisionId)) return false;
    if (f.lastFightDate && daysBetween(f.lastFightDate, bout.date) < REPLACEMENT_MIN_TURNAROUND_DAYS) return false;
    // Availability is asked of the one authority rather than hand rolled here. The local version
    // missed commission suspensions, anti-doping suspensions, an exhausted or absent contract and
    // an open offer, so a suspended or out of contract fighter could be dropped into a bout that
    // no other path would have allowed.
    const blocked = offerBlockReason(save, f, {
      eventDate: bout.date,
      takenFighterIds: booked,
      isReplacementSlot: true,
      inCampFighterIds: inCamp,
      openOfferFighterIds: openOffers,
    });
    if (blocked) return false;
    return true;
  });

  if (pool.length === 0) return null;

  const scored = pool.map((f) => {
    let s = 0;
    const rankGap = Math.abs((f.ranking ?? 16) - (remaining.ranking ?? 16));
    s += 40 - rankGap * 2.4;
    // Willingness rises with how much the fighter has to gain.
    s += ((remaining.ranking ?? 16) < (f.ranking ?? 16) ? 18 : 0);
    s += f.relationships.matchmaker * 0.12;
    s += f.acceptedShortNotice * 4;
    s -= f.declinedOffers * 3;
    s += clamp(noticeDays, 0, 30) * 0.4;
    s += f.popularity * 0.05;
    if (f.divisionId !== bout.divisionId) s -= 14;
    s += rng.range(-8, 8);
    return { f, s };
  });
  scored.sort((x, y) => y.s - x.s);
  const chosen = scored[0];
  if (chosen.s < 4) return null;

  return {
    fighter: chosen.f,
    reason:
      noticeDays <= 14
        ? `stepping in on ${noticeDays} days notice`
        : `replacing the withdrawn fighter on ${noticeDays} days notice`,
  };
}

/**
 * How close to the card a challenger's withdrawal has to come before the promotion fills the title
 * bout instead of calling it off. Further out than this the champion is simply rebooked against a
 * proper challenger by the weekly title pass, which is what a promotion does with months in hand.
 */
export const TITLE_REBOOK_NOTICE_DAYS = 42;

/**
 * A late replacement challenger for a championship bout.
 *
 * Chosen through the same eligibility gate as every other title booking, held to the short notice
 * bar. The ordinary replacement finder scored by ranking gap alone, so a champion could be handed
 * an unranked opponent and the bout quietly stopped being for the title. Returns null when nobody
 * eligible can take it, and the caller cancels the bout.
 */
export function findTitleReplacement(save: SaveGame, bout: Bout, withdrawingId: FighterId): { fighter: Fighter; reason: string } | null {
  const remainingId = bout.fighterAId === withdrawingId ? bout.fighterBId : bout.fighterAId;
  const noticeDays = daysBetween(save.date, bout.date);
  const booked = new Set<FighterId>();
  for (const b of Object.values(save.bouts)) {
    if (b.status === 'scheduled' && b.id !== bout.id) {
      booked.add(b.fighterAId);
      booked.add(b.fighterBId);
    }
  }
  const inCamp = inCampFighterIds(save);
  const openOffers = openOfferFighterIds(save);
  const table = save.rankings[bout.divisionId];
  const ranked = rankChallengers(
    save,
    bout.divisionId,
    (f) => {
      if (f.id === remainingId || f.id === withdrawingId) return false;
      // The player is offered fights, never assigned one.
      if (f.id === save.player.fighterId) return false;
      if (f.lastFightDate && daysBetween(f.lastFightDate, bout.date) < REPLACEMENT_MIN_TURNAROUND_DAYS) return false;
      return !offerBlockReason(save, f, {
        eventDate: bout.date,
        takenFighterIds: booked,
        isReplacementSlot: true,
        inCampFighterIds: inCamp,
        openOfferFighterIds: openOffers,
      });
    },
    { shortNotice: true, ignoreBoutId: bout.id, vacant: !table?.championId, interim: bout.isInterimTitleFight }
  );
  const pick = ranked[0];
  if (!pick) return null;
  return {
    fighter: pick.fighter,
    reason: `stepping in for the title on ${noticeDays} days notice`,
  };
}

/** Applies a replacement to a bout, adjusting weight class and purse. */
export function applyReplacement(save: SaveGame, bout: Bout, withdrawingId: FighterId, replacement: Fighter, reason: string): boolean {
  // The existing bout is edited in place. Creating a second booking here was how a
  // withdrawn fighter could end up still pointing at a bout that had moved on without them.
  const swapped = replaceSide(save, bout, withdrawingId, replacement, reason);
  if (!swapped.bout) return false;
  const noticeDays = daysBetween(save.date, bout.date);

  // A belt is not on the line without the fighter who holds it.
  //
  // The demotion used to look only at the replacement, so when the withdrawing fighter was the
  // champion the bout stayed a title fight between two challengers. The winner was crowned and
  // the reigning champion lost the belt without being in the building, leaving two fighters
  // flagged as champion of one division.
  const table = save.rankings[bout.divisionId];
  const championWithdrew = table?.championId === withdrawingId || table?.interimChampionId === withdrawingId;
  // A title also cannot change hands on short notice against a fighter who has not earned it.
  // That holds for an interim belt as much as for the undisputed one.
  const replacementUnearned = replacement.ranking === null || replacement.ranking > 8;
  if (isChampionshipBout(bout) && (championWithdrew || replacementUnearned)) {
    bout.isTitleFight = false;
    bout.isInterimTitleFight = false;
    bout.contractedWeightLb = contractedWeight(bout.divisionId, false);
    // The contender's claim was consumed when the championship bout was made. A bout that is no
    // longer for a belt has to give it back, or the shot they earned is spent on a fight that
    // was not the one they earned.
    restoreContenderStatus(save, bout.divisionId, bout.id);
    // Everything that described the bout as a championship goes with the belt. The kind and the
    // reason used to stay behind, so the offer and event pages went on calling it a championship
    // bout and quoting the old challenger's title claim, and a demoted bout kept five rounds on
    // the prelims.
    const remaining = save.fighters[bout.fighterAId === replacement.id ? bout.fighterBId : bout.fighterAId];
    const bothRanked = remaining?.ranking != null && replacement.ranking !== null;
    bout.bookingKind = bothRanked ? 'ranked-matchup' : 'short-notice-replacement';
    bout.bookingReason = `${replacement.name} is ${reason}, so the championship is no longer on the line.`;
    bout.scheduledRounds = bout.isMainEvent || bout.roundsAgreed ? 5 : 3;
  } else {
    bout.bookingReason = joinSentence(bout.bookingReason, `${replacement.name} is ${reason}.`);
  }
  if (replacement.divisionId !== bout.divisionId) {
    bout.isCatchweight = true;
    const a = DIVISION_BY_ID[bout.divisionId];
    const b = DIVISION_BY_ID[replacement.divisionId];
    bout.contractedWeightLb = Math.round((a.limitLb + b.limitLb) / 2);
  }

  const contract = replacement.contractId ? save.contracts[replacement.contractId] : null;
  const purse = purseForBout(contract, replacement, save, {
    isMainEvent: bout.isMainEvent,
    isTitleFight: isChampionshipBout(bout),
    // The same short notice line every other path uses. A replacement found months out is an
    // ordinary booking and was being paid a short notice premium.
    shortNotice: noticeDays < 24,
  });
  if (bout.fighterAId === replacement.id) bout.purseA = purse;
  else bout.purseB = purse;
  return true;
}

/** Cancels a bout outright when no replacement can be found. */
export function cancelBout(save: SaveGame, bout: Bout, reason: string): void {
  bout.status = 'canceled';
  bout.cancelReason = reason;
  // A championship bout that never happens gives the contender their claim back. They earned the
  // shot; losing it to a cancellation would mean earning it twice.
  if (isChampionshipBout(bout)) restoreContenderStatus(save, bout.divisionId, bout.id);
  const event = save.events[bout.eventId];
  if (event) {
    if (!event.canceledBoutIds) event.canceledBoutIds = [];
    if (!event.canceledBoutIds.includes(bout.id)) event.canceledBoutIds.push(bout.id);
  }
  // Pointers are cleared only when they still refer to this bout, so a fighter who has
  // already been moved onto a different card keeps their new booking.
  releaseBooking(save, bout.fighterAId, bout.id);
  releaseBooking(save, bout.fighterBId, bout.id);
  const ev = save.events[bout.eventId];
  if (ev) ev.boutIds = ev.boutIds.filter((id) => id !== bout.id);
  // Fight week is closed with the bout. Leaving the stages standing meant the page the player
  // was already looking at went on offering the ceremonial weigh in, the faceoff and finally
  // Enter fight for a bout that had been called off, and simulating it wrote a real result.
  clearFightWeek(save, bout.id);
  // Any camp built for this bout is closed with it rather than left running for a fight
  // that is no longer happening.
  for (const camp of Object.values(save.camps)) {
    if (camp.boutId !== bout.id) continue;
    if (camp.status === 'planned' || camp.status === 'running') {
      camp.status = 'abandoned';
      camp.outcomes.push({
        week: camp.weeksCompleted,
        key: 'camp-closed',
        headline: 'Camp closed',
        detail: `The bout was canceled: ${reason}`,
        severity: 'bad',
      });
    }
  }
  resolveMessagesForBout(save, bout.id, `The bout was canceled: ${reason}`);
}

/**
 * The opponent this fighter has a live rematch claim against, if any.
 *
 * Only a genuine claim counts. A former champion who never defended and lost one sidedly
 * does not get pulled to the front of the queue.
 */
export function rematchClaimTarget(save: SaveGame, fighter: Fighter): FighterId | null {
  const loss = lastTitleLoss(save, fighter.id);
  if (!loss) return null;
  if (daysBetween(loss.date, save.date) > 400) return null;
  const assessment = assessTitleRematch(save, fighter, loss);
  if (!assessment.granted) return null;
  return loss.fighterAId === fighter.id ? loss.fighterBId : loss.fighterAId;
}
