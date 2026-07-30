import { DIFFICULTY } from '../config/calibration';
import { contractedWeight, DIVISIONS, DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { clamp, hashString, Rng } from '../rng';
import { addDays, ageOn, daysBetween, dayOfWeek, type BoutId, type EventId, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, type Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { FightCardEvent, EventTier } from '../types/world';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';
import { assessTitleOpportunity, assessTitleRematch, fightCloseness, lastTitleLoss } from './title-logic';
import { existingTitleBout, interimTitleJustification, titleShotEligibility } from './title-eligibility';
import { fulfilInterest, interestReason, matchupPull, type MatchupInterest } from './matchup-interest';
import { bookBout, inCampFighterIds, offerBlockReason, releaseBooking, replaceSide } from './availability';
import { resolveMessagesForBout } from './inbox';
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
 */
export const CHAMPION_TURNAROUND_DAYS = 180;

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
  eventsPerYear: 46,
  ppvPerYear: 14,
  fightNightsPerYear: 32,
  clearWeekendsPerYear: 6,
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
  { total: 11, main: 5, prelim: 4, early: 2, weight: 0.2 },
  { total: 12, main: 5, prelim: 4, early: 3, weight: 0.5 },
  { total: 13, main: 5, prelim: 4, early: 4, weight: 0.24 },
  { total: 14, main: 5, prelim: 5, early: 4, weight: 0.06 },
];

const FIGHT_NIGHT_SHAPES: CardShape[] = [
  { total: 10, main: 5, prelim: 5, early: 0, weight: 0.08 },
  { total: 11, main: 5, prelim: 6, early: 0, weight: 0.14 },
  { total: 12, main: 6, prelim: 6, early: 0, weight: 0.34 },
  { total: 12, main: 5, prelim: 7, early: 0, weight: 0.16 },
  { total: 13, main: 6, prelim: 7, early: 0, weight: 0.23 },
  { total: 14, main: 6, prelim: 8, early: 0, weight: 0.05 },
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
  const existing = Object.values(save.events);
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
  });
  if (blocked) return false;
  // Fighters do not all compete at the same rate. A fighter inside their own preferred
  // turnaround, or already at their yearly target, is a harder booking.
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

function priorMeetings(save: SaveGame, a: FighterId, b: FighterId): { count: number; lastDate: IsoDate | null; aWins: number; bWins: number } {
  let count = 0;
  let lastDate: IsoDate | null = null;
  let aWins = 0;
  let bWins = 0;
  for (const r of Object.values(save.history.results)) {
    const pair = (r.fighterAId === a && r.fighterBId === b) || (r.fighterAId === b && r.fighterBId === a);
    if (!pair) continue;
    count++;
    if (!lastDate || r.date > lastDate) lastDate = r.date;
    if (r.winnerId === a) aWins++;
    if (r.winnerId === b) bWins++;
  }
  return { count, lastDate, aWins, bWins };
}

function styleContrast(a: Fighter, b: Fighter): number {
  const dims: (keyof Fighter['tendencies'])[] = ['pressure', 'range', 'takedownEntry', 'submissionHunt', 'pace', 'counter'];
  let d = 0;
  for (const k of dims) d += Math.abs(a.tendencies[k] - b.tendencies[k]);
  return d / dims.length;
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
  if (history.count >= 3) return null;
  // A rematch inside a year needs the first fight to have been worth running back. A wide
  // decision or an early finish does not qualify, which is what stops the same pairing being
  // remade over and over.
  if (history.count > 0 && history.lastDate && daysBetween(history.lastDate, event.date) < 400) {
    const previous = Object.values(save.history.results).find(
      (r) =>
        r.date === history.lastDate &&
        ((r.fighterAId === fighter.id && r.fighterBId === opponent.id) || (r.fighterAId === opponent.id && r.fighterBId === fighter.id))
    );
    const worthRunningBack = previous ? fightCloseness(previous).value >= 0.7 : false;
    const pulled = matchupPull(save, fighter.id, opponent.id).pull;
    if (!worthRunningBack && pulled < 0.5) return null;
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
    score += 100 - (challengerRank ?? 8) * 7;
    kind = 'title-fight';
    reason = eligibility.selectionReason;
  } else if (rankA !== null && rankB !== null) {
    const gap = Math.abs(rankA - rankB);
    // Ranked fighters meet fighters near them, with a bias toward the fighter ranked
    // above so a win actually means something.
    score += 62 - gap * 5.5;
    if (rankA <= 5 && rankB <= 5) {
      score += 22;
      kind = 'eliminator';
      reason = 'a title eliminator between top five contenders';
    } else {
      kind = 'ranked-matchup';
      reason = `a ranked matchup at ${rankA} against ${rankB}`;
    }
    if (gap > 8) score -= 25;
  } else if (rankA !== null && rankB === null) {
    // Ranked fighter against an unranked fighter is a step down unless the unranked
    // fighter is a hot prospect.
    const streak = opponent.winStreak;
    score += 26 + streak * 5 - (rankA <= 8 ? 18 : 0);
    kind = 'prospect-test';
    reason = `a step up for a prospect on a ${streak} fight run`;
  } else if (rankA === null && rankB !== null) {
    score += 26 + fighter.winStreak * 5 - (rankB <= 8 ? 18 : 0);
    kind = 'prospect-test';
    reason = 'a chance to break into the rankings';
  } else {
    score += 30 - Math.abs(fighter.winStreak - opponent.winStreak) * 2;
    kind = 'divisional-filler';
    reason = 'a matchup between unranked fighters';
  }

  // Age and career stage produce recognisable matchmaking patterns.
  const ageA = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 29;
  const ageB = ageOn(opponent.birthDate, save.date) ?? opponent.ageAtSnapshot ?? 29;
  if (Math.abs(ageA - ageB) > 7 && Math.min(ageA, ageB) < 27) {
    score += 8;
    if (kind === 'divisional-filler' || kind === 'ranked-matchup') {
      kind = 'veteran-vs-prospect';
      reason = 'a veteran test for a younger fighter';
    }
  }

  // Rematches and trilogies. A championship rematch stays a championship bout, so the
  // kind is only relabelled when no title is involved.
  const titleInvolved = isChampA || isChampB;
  if (history.count === 1) {
    score += 14;
    if (!titleInvolved) {
      kind = 'rematch';
      reason = 'a rematch of their previous meeting';
    } else {
      reason = `${reason}, in a rematch`;
    }
  } else if (history.count === 2 && history.aWins === 1 && history.bWins === 1) {
    score += 26;
    if (!titleInvolved) {
      kind = 'trilogy';
      reason = 'a trilogy decider after one win each';
    } else {
      reason = `${reason}, completing a trilogy`;
    }
  }

  // Style contrast sells and produces better fights.
  const contrast = styleContrast(fighter, opponent);
  score += contrast * 22;
  if (contrast > 0.42 && kind === 'ranked-matchup') {
    kind = 'style-clash';
    reason = 'a clear style clash';
  }

  // Local drawing power in the event market.
  const regionA = regionOfFighter(fighter);
  const regionB = regionOfFighter(opponent);
  const eventRegion = VENUE_CITIES.find((v) => v.city === event.city)?.region ?? 'north-america';
  if (regionA === eventRegion) score += 9;
  if (regionB === eventRegion) score += 9;
  if (fighter.country === event.country || opponent.country === event.country) {
    score += 8;
    if (kind === 'divisional-filler') {
      kind = 'local-showcase';
      reason = `a home market showcase in ${event.country}`;
    }
  }

  // Popularity sells a card.
  score += (fighter.popularity + opponent.popularity) * 0.09;

  // A fighter coming off a long layoff gets an easier assignment.
  const layoffB = opponent.lastFightDate ? daysBetween(opponent.lastFightDate, event.date) : 999;
  if (layoffB > 400) {
    score += rankA !== null && rankA <= 8 ? -14 : 8;
    if (kind === 'divisional-filler') {
      kind = 'comeback';
      reason = 'a return fight after a long layoff';
    }
  }

  // Activity: the matchmaker prefers fighters who have been waiting.
  const waitA = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, event.date) : 200;
  const waitB = opponent.lastFightDate ? daysBetween(opponent.lastFightDate, event.date) : 200;
  score += clamp((waitA + waitB - 220) / 40, -6, 12);

  // Contract pressure: a fighter on the last bout of a deal gets matched.
  const contractB = opponent.contractId ? save.contracts[opponent.contractId] : null;
  if (contractB && contractB.fightsRemaining === 1) score += 6;

  // Relationship: a fighter who keeps turning fights down gets offered less.
  score -= opponent.declinedOffers * 4;
  score += clamp((opponent.relationships.matchmaker - 50) / 6, -8, 8);

  // Division congestion: when the top of a division is jammed, the matchmaker leans on
  // eliminators rather than more filler.
  const rankedActive = table.entries.filter((e) => {
    const f = save.fighters[e.fighterId];
    return f && !f.nextBoutId;
  }).length;
  if (rankedActive > 10 && kind === 'divisional-filler') score -= 10;

  score += rng.range(-7, 7);

  return { opponent, score, kind, reason };
}

export function findBestOpponent(
  save: SaveGame,
  fighter: Fighter,
  event: FightCardEvent,
  ctx: AvailabilityContext,
  rng: Rng,
  bias = 0
): MatchCandidate | null {
  const pool = Object.values(save.fighters).filter(
    (f) => f.divisionId === fighter.divisionId && f.id !== fighter.id && isAvailable(save, f, ctx)
  );
  const scored: MatchCandidate[] = [];
  // Leverage the fighter has earned. A long unbeaten run or a decorated championship
  // history should not be matched with an unranked opponent, and an accepted callout or a
  // strong rematch claim should pull a specific opponent up the list.
  const leverage = assessTitleOpportunity(save, fighter, fighter.divisionId);
  const rematchTarget = rematchClaimTarget(save, fighter);
  for (const opp of pool) {
    const c = scoreCandidate(save, fighter, opp, event, rng);
    if (!c) continue;
    // A live matchup interest is a real candidate, not a nudge. An accepted callout between
    // two available fighters in the same division now outweighs anything the ordinary
    // divisional scoring would have produced, which is what makes the callout mean something.
    const { pull, interest } = matchupPull(save, fighter.id, opp.id);
    if (pull < 0) {
      // Training partners and close friends are pushed out of contention entirely.
      if (pull <= -0.9) continue;
      c.score += pull * 60;
    } else if (pull > 0) {
      c.score += pull * 85;
      if (interest && interest.eligibility === 'eligible') {
        c.interest = interest;
        c.kind = interest.source === 'callout' ? 'callout' : interest.source === 'rivalry' ? 'rivalry' : c.kind;
        c.reason = interestReason(save, interest);
      } else if (c.kind === 'divisional-filler' || c.kind === 'ranked-matchup') {
        c.kind = 'rivalry';
        c.reason = 'a rivalry the fans have been asking for';
      }
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

  // The bias shifts the matchmaker toward tougher or softer assignments, which is how the
  // difficulty setting expresses itself without touching the fight engine.
  if (bias !== 0) {
    const shift = clamp(Math.round(-bias), -3, 3);
    const idx = clamp(shift, 0, Math.max(0, scored.length - 1));
    return scored[idx];
  }
  // A small amount of randomness among the top options keeps a long save varied.
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
  const unrankedQueue = rng.shuffle(Object.values(save.fighters).filter((f) => f.ranking === null && isAvailable(save, f, ctx)));

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

  for (const fighter of seeds) {
    if (bouts.length >= remainingSlots) break;
    if (booked.has(fighter.id)) continue;
    const isPlayerFighter = save.player.fighterId === fighter.id;
    const candidate = findBestOpponent(save, fighter, event, ctx, rng, isPlayerFighter ? diff.matchmakingBias : 0);
    if (!candidate) continue;

    // Neither side may be a champion who is not clear to defend on this card.
    if (allChampionIds.has(candidate.opponent.id) && !defendableChampionIds.has(candidate.opponent.id)) continue;
    if (allChampionIds.has(fighter.id) && !defendableChampionIds.has(fighter.id)) continue;

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
      candidate.kind = 'eliminator';
      candidate.reason = 'a title eliminator';
    }

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
    // event that is not for a belt.
    if (isChampionshipBout(b) || b.isMainEvent) b.scheduledRounds = 5;
    else b.scheduledRounds = 3;
  });
  event.boutIds = ranked.map((b) => b.id);

  // Only the bouts created by this pass are returned. Returning the whole card would let
  // a caller act twice on a bout that was already agreed, which previously cancelled an
  // accepted bout and re-offered it, and created a duplicate camp every week.
  return { bouts, notes };
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

  const pool = Object.values(save.fighters).filter((f) => {
    if (f.id === remainingId || f.id === withdrawingId) return false;
    // The player is never assigned a bout. Every fight they take arrives as an offer they
    // can accept, negotiate or turn down, including short notice work.
    if (f.id === save.player.fighterId) return false;
    if (f.retired || f.activityStatus !== 'active') return false;
    if (booked.has(f.id)) return false;
    if (!canCompete(f, save.date).ok) return false;
    if (f.divisionId !== bout.divisionId) {
      const adjacent = Math.abs(DIVISION_BY_ID[f.divisionId].order - DIVISION_BY_ID[bout.divisionId].order) === 1;
      if (!adjacent || noticeDays > 21) return false;
    }
    if (f.lastFightDate && daysBetween(f.lastFightDate, bout.date) < 28) return false;
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

/** Applies a replacement to a bout, adjusting weight class and purse. */
export function applyReplacement(save: SaveGame, bout: Bout, withdrawingId: FighterId, replacement: Fighter, reason: string): boolean {
  // The existing bout is edited in place. Creating a second booking here was how a
  // withdrawn fighter could end up still pointing at a bout that had moved on without them.
  const swapped = replaceSide(save, bout, withdrawingId, replacement, reason);
  if (!swapped.bout) return false;
  bout.bookingReason = `${bout.bookingReason}. ${replacement.name} is ${reason}.`;

  // A title cannot change hands on short notice against a fighter who has not earned it.
  // That holds for an interim belt as much as for the undisputed one.
  if (isChampionshipBout(bout) && (replacement.ranking === null || replacement.ranking > 8)) {
    bout.isTitleFight = false;
    bout.isInterimTitleFight = false;
    bout.contractedWeightLb = contractedWeight(bout.divisionId, false);
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
    shortNotice: true,
  });
  if (bout.fighterAId === replacement.id) bout.purseA = purse;
  else bout.purseB = purse;
  return true;
}

/** Cancels a bout outright when no replacement can be found. */
export function cancelBout(save: SaveGame, bout: Bout, reason: string): void {
  bout.status = 'canceled';
  bout.cancelReason = reason;
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

/** Chooses which division should crown an interim champion, if any. */
export function shouldCreateInterimTitle(save: SaveGame, divisionId: DivisionId): boolean {
  const table = save.rankings[divisionId];
  if (!table.championId || table.interimChampionId) return false;
  const champ = save.fighters[table.championId];
  if (!champ) return false;
  const inactive = champ.lastFightDate ? daysBetween(champ.lastFightDate, save.date) : 999;
  const blocked = !canCompete(champ, save.date).ok;
  return inactive > 300 || (blocked && inactive > 200);
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
