import { DIFFICULTY } from '../config/calibration';
import { trainingCostScale } from './circuit';
import { clamp, Rng } from '../rng';
import { addDays, daysBetween, type IsoDate } from '../types/common';
import { RATING_KEYS, type Fighter, type RatingKey } from '../types/fighter';
import type { CampFocus, CampOutcome, GamePlanKey, Gym, TrainingCamp } from '../types/world';
import type { SaveGame } from '../types/save';
import { applyDeltas, developWeek, evenFocus, notePeakOvr, type DevelopmentInput } from './development';
import { applyWear, rollTrainingInjury, trainingCapacityOf } from './health';
import { planCoherence } from '../sim/plan';
import { record } from './finance';
import { noteCampStored } from './indexes';

/**
 * Training camps.
 *
 * A camp is where the player's preparation decisions turn into fight night state. Longer
 * is not automatically better, higher intensity is not automatically better, and a
 * famous gym does not hand over its full benefit on the first visit.
 */

export const CAMP_PRESETS: { key: string; label: string; description: string; focus: CampFocus; intensity: number; plans: GamePlanKey[] }[] = [
  {
    key: 'balanced',
    label: 'Balanced camp',
    description: 'Even work across all six areas. Nothing sharpens dramatically, nothing rusts.',
    focus: { striking: 0.2, grappling: 0.16, wrestling: 0.18, submissions: 0.14, cardio: 0.2, durability: 0.12 },
    intensity: 0.68,
    plans: [],
  },
  {
    key: 'striking-heavy',
    label: 'Striking heavy',
    description: 'Most of the week on the feet. Grappling preparation suffers.',
    focus: { striking: 0.46, grappling: 0.08, wrestling: 0.12, submissions: 0.06, cardio: 0.2, durability: 0.08 },
    intensity: 0.74,
    plans: ['pressure'],
  },
  {
    key: 'anti-wrestling',
    label: 'Anti-wrestling',
    description: 'Takedown defense, getting up, and staying at range.',
    focus: { striking: 0.18, grappling: 0.2, wrestling: 0.34, submissions: 0.08, cardio: 0.14, durability: 0.06 },
    intensity: 0.75,
    plans: ['outside-range'],
  },
  {
    key: 'wrestling-pressure',
    label: 'Wrestling pressure',
    description: 'Entries, chain wrestling and fence work. Expensive on the body.',
    focus: { striking: 0.14, grappling: 0.18, wrestling: 0.38, submissions: 0.08, cardio: 0.18, durability: 0.04 },
    intensity: 0.82,
    plans: ['takedown-pressure', 'fence-wrestling'],
  },
  {
    key: 'grappling-control',
    label: 'Grappling control',
    description: 'Positional dominance and top pressure.',
    focus: { striking: 0.12, grappling: 0.4, wrestling: 0.2, submissions: 0.14, cardio: 0.1, durability: 0.04 },
    intensity: 0.72,
    plans: ['top-control'],
  },
  {
    key: 'submission-hunt',
    label: 'Submission hunt',
    description: 'Entries, chains and finishing detail. Position is traded for the finish.',
    focus: { striking: 0.1, grappling: 0.26, wrestling: 0.12, submissions: 0.38, cardio: 0.1, durability: 0.04 },
    intensity: 0.72,
    plans: ['submission-hunting'],
  },
  {
    key: 'cardio-pace',
    label: 'Cardio pace',
    description: 'Build the engine for a hard five rounds. Skill work takes a back seat.',
    focus: { striking: 0.14, grappling: 0.1, wrestling: 0.12, submissions: 0.06, cardio: 0.48, durability: 0.1 },
    intensity: 0.85,
    plans: ['high-pace'],
  },
  {
    key: 'defensive-survival',
    label: 'Defensive survival',
    description: 'Neck conditioning, shell work, recovery and avoiding damage. It reduces avoidable punishment, it does not make anyone bulletproof.',
    focus: { striking: 0.14, grappling: 0.12, wrestling: 0.14, submissions: 0.06, cardio: 0.16, durability: 0.38 },
    intensity: 0.6,
    plans: ['counter'],
  },
  {
    key: 'short-notice',
    label: 'Short notice survival',
    description: 'Make weight, stay loose, do not get hurt in the gym.',
    focus: { striking: 0.2, grappling: 0.14, wrestling: 0.14, submissions: 0.08, cardio: 0.3, durability: 0.14 },
    intensity: 0.45,
    plans: ['conservative-pace'],
  },
  {
    key: 'weight-management',
    label: 'Weight management',
    description: 'Prioritise a clean cut over sharpening skills.',
    focus: { striking: 0.16, grappling: 0.12, wrestling: 0.12, submissions: 0.08, cardio: 0.4, durability: 0.12 },
    intensity: 0.55,
    plans: [],
  },
  {
    key: 'injury-recovery',
    label: 'Injury recovery',
    description: 'Minimal load. Protects a healing injury at the cost of sharpness.',
    focus: { striking: 0.16, grappling: 0.14, wrestling: 0.1, submissions: 0.1, cardio: 0.24, durability: 0.26 },
    intensity: 0.3,
    plans: ['protect-injury'],
  },
];

export function normalizeFocus(focus: Partial<CampFocus>): CampFocus {
  const out = {} as CampFocus;
  let total = 0;
  for (const k of RATING_KEYS) {
    out[k] = Math.max(0, focus[k] ?? 0);
    total += out[k];
  }
  if (total <= 0) return evenFocus() as CampFocus;
  for (const k of RATING_KEYS) out[k] = out[k] / total;
  return out;
}

/**
 * Sets one area's share of the camp; the other five move equally to keep the whole at one.
 *
 * Exactly the rule the player asked for, in their words: six bars, move one, the others all go
 * down equally. Raising an area takes the difference from the other five in equal parts, with
 * anything an empty area cannot give taken equally from whoever still has time to give; lowering
 * an area hands the freed time back to the other five in equal parts. The six always total one.
 */
export function setFocusShare(focus: CampFocus, key: RatingKey, share: number): CampFocus {
  const target = clamp(share, 0, 1);
  const others = RATING_KEYS.filter((k) => k !== key);
  const out = { ...focus, [key]: target } as CampFocus;
  for (const k of others) out[k] = Math.max(0, out[k]);
  const delta = target - Math.max(0, focus[key]);
  if (delta > 0) {
    // An area at zero has nothing to give, so its part falls equally on whoever still does.
    let remaining = delta;
    for (let pass = 0; pass < RATING_KEYS.length && remaining > 1e-9; pass++) {
      const donors = others.filter((k) => out[k] > 1e-9);
      if (donors.length === 0) break;
      const per = remaining / donors.length;
      for (const k of donors) {
        const taken = Math.min(out[k], per);
        out[k] -= taken;
        remaining -= taken;
      }
    }
  } else if (delta < 0) {
    const per = -delta / others.length;
    for (const k of others) out[k] += per;
  }
  return out;
}

export interface CampSetup {
  boutId: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  focus: CampFocus;
  intensity: number;
  gymId: string | null;
  /**
   * The second room of a split camp. Optional so every caller that predates split camps having a
   * real second gym keeps compiling, and absent for every other camp type.
   */
  secondGymId?: string | null;
  campType: TrainingCamp['campType'];
  specialistHired: string | null;
  gamePlan: GamePlanKey[];
  arriveEarlyDays: number;
}

/** The camp ends a week before the bout, when fight week takes over. */
export function campEndFor(boutDate: IsoDate): IsoDate {
  return addDays(boutDate, -7);
}

/**
 * The start date of a camp of the chosen length, counted back from the end of camp.
 *
 * Computed from the length rather than the other way round, because the camp's week count is the
 * floor of the days between its dates: deriving the length from a start date picked first could
 * quietly lose a week.
 */
export function campStartFor(boutDate: IsoDate, weeks: number): IsoDate {
  return addDays(campEndFor(boutDate), -Math.max(0, Math.floor(weeks)) * 7);
}

/** Whole weeks of camp between two dates, the one definition the quote, the camp and the page share. */
export function campWeeksBetween(start: IsoDate, end: IsoDate): number {
  return Math.max(0, Math.floor(daysBetween(start, end) / 7));
}

/**
 * The longest camp that still fits before a bout, from today.
 *
 * The camp page used its own formula for this and the cost quote another. They agreed, but only
 * by coincidence of arithmetic, and the page is what offers the lengths the quote then prices.
 */
export function campWeeksAvailable(today: IsoDate, boutDate: IsoDate): number {
  return campWeeksBetween(today, campEndFor(boutDate));
}

/** The camp length most camps should run: long enough to peak, short enough not to wear down. */
export const IDEAL_CAMP_WEEKS = 8;

/** Nightly cost of putting a fighter and team up near the venue before fight week, main roster rate. */
export const ARRIVE_EARLY_DAILY_COST = 450;

/** A specialist coach for one camp, main roster rate. */
export const SPECIALIST_COST = 12000;

/**
 * What a specialist costs this fighter.
 *
 * It was a flat twelve thousand on every circuit, about two regional purses, while the weekly camp
 * cost beside it was already scaled to the circuit. A regional fighter either never ticked the box
 * or went into debt for a small coaching lift. The floor keeps a specialist from being near free
 * for an amateur, whose cost scale is tiny.
 */
export function specialistCostFor(who: Fighter | null | undefined): number {
  return Math.round(SPECIALIST_COST * Math.max(0.15, trainingCostScale(who ?? null)));
}

/** What arriving the given number of days early costs this fighter. */
export function arriveEarlyCostFor(who: Fighter | null | undefined, days: number): number {
  return Math.round(Math.min(Math.max(0, days), ARRIVE_EARLY_CAP_DAYS) * ARRIVE_EARLY_DAILY_COST * trainingCostScale(who ?? null));
}

/**
 * What a camp would cost, without creating one.
 *
 * The interface previously priced a camp by calling `createCamp` during render, which incremented
 * the persisted camp counter on every keystroke and every re-render. This is the same arithmetic
 * with no side effect, so the quoted price and the charged price cannot drift apart.
 *
 * `upfront` is the part paid once when the camp is booked: the specialist and the early arrival.
 * The rest is paid week by week as the camp runs.
 */
export function estimateCampCost(save: SaveGame, setup: CampSetup, fighter?: Fighter): { weeks: number; cost: number; upfront: number } {
  const weeks = campWeeksBetween(setup.startDate, setup.endDate);
  const gym = setup.gymId ? save.gyms[setup.gymId] : null;
  const second = setup.campType === 'split' && setup.secondGymId ? save.gyms[setup.secondGymId] : null;
  const who = fighter ?? (save.player.fighterId ? save.fighters[save.player.fighterId] : null);
  // About a fifth of a gym's monthly running cost per week of camp. It was six percent of the monthly
  // figure per week, which priced an ordinary fourteen week camp at a mid sized gym above the purse
  // it was preparing for, so every career that trained properly went into debt and stayed there.
  // A split camp pays for time in both rooms, so it is priced from the two gyms' average.
  const monthly = gym ? (second ? (gym.monthlyCosts + second.monthlyCosts) / 2 : gym.monthlyCosts) : null;
  const baseCost = (monthly !== null ? monthly * 0.02 : 700) * trainingCostScale(who);
  const typeMultiplier =
    setup.campType === 'visiting' ? 2.2 : setup.campType === 'split' ? 2.6 : setup.campType === 'near-event' ? 1.8 : setup.campType === 'solo' ? 0.3 : 1;
  const specialistCost = setup.specialistHired ? specialistCostFor(who) : 0;
  // Arriving early is a hotel bill. It was free, so the longest option was a better camp at no
  // price and the control was not a real choice.
  const arriveEarlyCost = arriveEarlyCostFor(who, setup.arriveEarlyDays);
  const upfront = specialistCost + arriveEarlyCost;
  return { weeks, cost: Math.round(weeks * baseCost * typeMultiplier) + upfront, upfront };
}

/**
 * The neutral camp form score. Camp life nudges a fighter above or below it.
 *
 * Kept on the 0 to 100 scale the camp life system already used, so its existing adjustments are
 * correct as written and only needed somewhere to land.
 */
/**
 * What arriving at the venue early is worth, per day, up to a cap.
 *
 * Graded rather than a single threshold. At seven days this comes out at the 0.04 the old
 * threshold gave, so a camp that already qualified is unchanged and the shorter options stop
 * being decorative.
 */
export const ARRIVE_EARLY_PER_DAY = 0.0057;
export const ARRIVE_EARLY_CAP_DAYS = 12;

/**
 * What a camp held near the event is worth.
 *
 * The option costs 1.8 times a home camp and described a benefit that no code delivered, so it
 * was strictly worse than staying home.
 */
export const NEAR_EVENT_SHARPNESS = 0.05;

export const CAMP_FORM_BASELINE = 50;

/**
 * How much camp form moves fight night sharpness.
 *
 * A perfect camp is worth about a fifth more sharpness than a neutral one and a wretched camp
 * about a fifth less. Large enough that the decisions matter, small enough that camp life cannot
 * overwhelm the length, intensity and coaching that dominate preparation.
 */
export const CAMP_FORM_WEIGHT = 0.2;

/**
 * The base a fighter built in the room between camps, 0 to 1.
 *
 * Weeks of ordinary gym time since the previous camp ended, scaled by the quality of the room
 * they spent it in. Players asked for the time between fights to matter: it now feeds the next
 * camp, which trains slightly better and opens slightly sharper from a built base. Bounded small
 * on purpose, because a camp is still where fights are won.
 */
export function baseBuildingFor(save: SaveGame, fighter: Fighter, startDate: IsoDate): number {
  const previous = latestClosedCampOf(save, fighter.id);
  const since = previous ? previous.endDate : null;
  const weeksBetween = since ? Math.max(0, Math.floor(daysBetween(since, startDate) / 7)) : BASE_BUILDING_FULL_WEEKS / 2;
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  if (!gym) return 0;
  const partnerAvg = RATING_KEYS.reduce((t, k) => t + gym.trainingPartners[k], 0) / RATING_KEYS.length;
  const roomQuality = clamp((partnerAvg + gym.facilities) / 2 / 100, 0, 1);
  return clamp(weeksBetween / BASE_BUILDING_FULL_WEEKS, 0, 1) * roomQuality;
}

/**
 * The fighter's most recently ended camp that is finished or abandoned, or null.
 *
 * The first stored wins a tie on end date, which is the answer the stable sort this replaced gave.
 * Pruning keeps this camp for every fighter, so base building reads the same before and after.
 */
export function latestClosedCampOf(save: SaveGame, fighterId: string): TrainingCamp | null {
  let latest: TrainingCamp | null = null;
  for (const c of Object.values(save.camps)) {
    if (c.fighterId !== fighterId || (c.status !== 'complete' && c.status !== 'abandoned')) continue;
    if (!latest || c.endDate > latest.endDate) latest = c;
  }
  return latest;
}

/** Days a closed camp is kept in full after it ends before it may be pruned. */
export const CLOSED_CAMP_KEEP_DAYS = 60;
/** Closed camps kept for each fighter the player looks after, which is what the camp history table lists. */
export const PLAYER_CAMP_HISTORY = 25;

/**
 * Deletes closed camps nothing will read again. Returns how many were removed.
 *
 * Every bout creates a camp and nothing ever removed one, so a save gained more than a thousand
 * camps a year and every scan over them slowed the weekly pass a little more each season. A
 * closed camp is still read in a few places, and each is why a rule below keeps it:
 * - fight night and fight week read the camp built for a bout still on the books, for its
 *   sharpness, so a camp whose bout is scheduled stays;
 * - base building reads the last camp each fighter finished, so the newest closed camp per
 *   fighter stays;
 * - the camp page lists the latest finished camps of the fighters the player looks after, so
 *   those stay up to that table's length;
 * - anything that ended within the last couple of months stays, so a camp closed this week is
 *   never removed from under a pass that is still looking at it.
 * A planned or running camp is never touched.
 */
export function pruneCamps(save: SaveGame): number {
  const cutoff = addDays(save.date, -CLOSED_CAMP_KEEP_DAYS);
  const looked: Set<string> = new Set();
  if (save.player.fighterId) looked.add(save.player.fighterId);
  const gym = save.player.gymId ? save.gyms?.[save.player.gymId] : null;
  for (const id of gym?.fighterIds ?? []) looked.add(id);

  const newestClosed = new Map<string, TrainingCamp>();
  const lookedHistory = new Map<string, TrainingCamp[]>();
  for (const c of Object.values(save.camps)) {
    if (c.status !== 'complete' && c.status !== 'abandoned') continue;
    const newest = newestClosed.get(c.fighterId);
    if (!newest || c.endDate > newest.endDate) newestClosed.set(c.fighterId, c);
    if (looked.has(c.fighterId) && c.status === 'complete') {
      const list = lookedHistory.get(c.fighterId);
      if (list) list.push(c);
      else lookedHistory.set(c.fighterId, [c]);
    }
  }
  const keep = new Set<string>();
  for (const c of newestClosed.values()) keep.add(c.id);
  for (const list of lookedHistory.values()) {
    // The same order the camp history table sorts by.
    list.sort((a, b) => (a.startDate > b.startDate ? -1 : 1));
    for (const c of list.slice(0, PLAYER_CAMP_HISTORY)) keep.add(c.id);
  }

  let removed = 0;
  for (const [id, c] of Object.entries(save.camps)) {
    if (c.status !== 'complete' && c.status !== 'abandoned') continue;
    if (keep.has(id)) continue;
    if (c.endDate >= cutoff) continue;
    const bout = c.boutId ? save.bouts?.[c.boutId] : null;
    if (bout && (bout.status === 'scheduled' || bout.status === 'postponed')) continue;
    delete save.camps[id];
    removed++;
  }
  return removed;
}

/** Weeks of ordinary gym time it takes to arrive at a fully built base. */
export const BASE_BUILDING_FULL_WEEKS = 10;
/** How much a fully built base improves the effective training quality of the camp. */
export const BASE_BUILDING_TRAINING_LIFT = 0.18;
/** Sharpness a fully built base is worth on fight night. */
export const BASE_BUILDING_SHARPNESS = 0.03;

export function createCamp(save: SaveGame, fighter: Fighter, setup: CampSetup): TrainingCamp {
  const { weeks, cost, upfront } = estimateCampCost(save, setup, fighter);
  // A new camp starts from neutral form, so last camp's run of bad weeks does not follow a fighter
  // into a preparation that has not happened yet.
  fighter.campSharpness = CAMP_FORM_BASELINE;

  const id = `camp-${++save.counters.camp}`;
  // The specialist and the early arrival are booked, so they are paid when the camp is set. They
  // used to be folded into the weekly charge, which a camp with no whole weeks never made, so a
  // short notice camp got its specialist for nothing, and a camp cut short underpaid for one.
  if (save.player.fighterId === fighter.id && upfront > 0) {
    record(save, fighter.id, 'out', 'camp-costs', upfront, 'Camp bookings: specialist and travel', setup.boutId ?? undefined);
  }

  return {
    id,
    fighterId: fighter.id,
    boutId: setup.boutId,
    startDate: setup.startDate,
    endDate: setup.endDate,
    weeks,
    intensity: clamp(setup.intensity, 0, 1),
    focus: normalizeFocus(setup.focus),
    gymId: setup.gymId,
    ...(setup.campType === 'split' && setup.secondGymId ? { secondGymId: setup.secondGymId } : {}),
    campType: setup.campType,
    specialistHired: setup.specialistHired,
    gamePlan: setup.gamePlan,
    arriveEarlyDays: setup.arriveEarlyDays,
    status: 'planned',
    weeksCompleted: 0,
    outcomes: [],
    resultingSharpness: null,
    resultingTacticalFamiliarity: null,
    resultingGains: null,
    overtrained: false,
    cost,
    upfrontCost: upfront,
    baseBuilding: baseBuildingFor(save, fighter, setup.startDate),
  };
}

function gymQualityFor(save: SaveGame, camp: TrainingCamp): { coaching: number; partners: Record<RatingKey, number>; safety: number; hardSparring: number; gym: Gym | null } {
  const gym = camp.gymId ? save.gyms[camp.gymId] : null;
  if (!gym) {
    // Training alone. Real penalties, no coaching, no live partners of any quality.
    const partners = {} as Record<RatingKey, number>;
    for (const k of RATING_KEYS) partners[k] = 22;
    return { coaching: 18, partners, safety: 70, hardSparring: 20, gym: null };
  }
  const coachQualityOf = (g: Gym): number => {
    const staff = g.staffIds.map((id) => save.staff[id]).filter(Boolean);
    return staff.length > 0 ? staff.reduce((s, c) => s + c.quality, 0) / staff.length : 40;
  };
  const partnersOf = (g: Gym): Record<RatingKey, number> => {
    const out = { ...g.trainingPartners };
    for (const spec of g.specializations) out[spec] = clamp(out[spec] + 8, 0, 99);
    return out;
  };
  let coachQuality = coachQualityOf(gym);
  const partners = partnersOf(gym);
  // A split camp takes each area's work from whichever room does it better, and the better of the
  // two coaching staffs. It used to train in the home room alone at a familiarity cut, for 2.6
  // times the price, so it was strictly worse than staying home. The cut below is still the cost
  // of moving between rooms; the second room is what pays for it when it covers a weakness.
  const second = camp.campType === 'split' && camp.secondGymId ? save.gyms[camp.secondGymId] : null;
  if (second && second.id !== gym.id) {
    const other = partnersOf(second);
    for (const k of RATING_KEYS) partners[k] = Math.max(partners[k], other[k]);
    coachQuality = Math.max(coachQuality, coachQualityOf(second));
  }

  // A visiting fighter does not get the full benefit of an unfamiliar room on the first
  // camp there. Familiarity is modelled by how long the fighter has been a member.
  const isMember = gym.fighterIds.includes(camp.fighterId);
  // A camp held near the event is the fighter's own team in a rented room, not an unfamiliar one,
  // so it takes only a small disruption penalty. Treating it like any other away camp meant a 15
  // percent cut to partners and coaching, which was more than the early arrival could ever be
  // worth, so the option cost 1.8 times a home camp and was strictly worse than staying home.
  const familiarity =
    camp.campType === 'home' && isMember
      ? 1
      : camp.campType === 'near-event'
        ? 0.95
        : camp.campType === 'visiting'
          ? 0.72
          : camp.campType === 'split'
            ? 0.8
            : 0.85;
  for (const k of RATING_KEYS) partners[k] = partners[k] * familiarity;

  return {
    coaching: coachQuality * familiarity,
    partners,
    safety: gym.safety,
    hardSparring: gym.hardSparringTendency,
    gym,
  };
}

export interface CampWeekResult {
  outcomes: CampOutcome[];
  ratingDeltas: Partial<Record<RatingKey, number>>;
  injured: boolean;
}

/**
 * Runs one week of camp. Returns outcomes as summaries rather than exposing every hidden
 * modifier, which is the intended level of information for the player.
 */
export function runCampWeek(save: SaveGame, camp: TrainingCamp, rng: Rng): CampWeekResult {
  const fighter = save.fighters[camp.fighterId];
  const outcomes: CampOutcome[] = [];
  if (!fighter) return { outcomes, ratingDeltas: {}, injured: false };

  // A camp cannot run past its planned length. Without this the weekly pass kept incrementing a
  // camp that was already complete, and the load time repair then silently clamped the overrun,
  // which made loading a save change it and broke the round trip guarantee. A camp with no whole
  // weeks still gets the one prep week a short notice fighter has always had, and no more: the old
  // guard skipped zero week camps entirely, so one could run every week until fight night.
  if (camp.weeksCompleted >= Math.max(1, camp.weeks)) {
    return { outcomes, ratingDeltas: {}, injured: false };
  }

  const week = camp.weeksCompleted + 1;
  const quality = gymQualityFor(save, camp);
  const diff = DIFFICULTY[save.settings.difficulty];
  const isPlayer = save.player.fighterId === fighter.id || (save.player.gymId !== null && fighter.gymId === save.player.gymId);
  const capacity = trainingCapacityOf(fighter, save.date);

  // Overtraining. A long camp at high intensity peaks early and then erodes.
  const load = camp.intensity * week;
  const overtrainingThreshold = 7.5 + (fighter.ratings.cardio / 100) * 3.5 + (fighter.longevity / 100) * 2.5;
  const overtraining = load > overtrainingThreshold;
  if (overtraining && !camp.overtrained) {
    camp.overtrained = true;
    outcomes.push({
      week,
      key: 'overtrained',
      headline: 'Camp has gone past its peak',
      detail: 'The work is no longer producing improvement. Sharpness has started to slip and recovery is slower than it should be.',
      severity: 'bad',
    });
  }

  // A built base makes the same week of camp worth slightly more.
  const baseLift = 1 + (camp.baseBuilding ?? 0) * BASE_BUILDING_TRAINING_LIFT;
  const effectiveIntensity = clamp(camp.intensity * capacity * (overtraining ? 0.6 : 1) * baseLift, 0, 1);
  // Development takes the work without the injury restriction, because developWeek applies the
  // capacity itself. Passing the restricted figure as well squared it, so a hand fracture at 45
  // percent capacity trained at 20 percent. The restricted figure still drives the injury roll.
  const trainingIntensity = clamp(camp.intensity * (overtraining ? 0.6 : 1) * baseLift, 0, 1);

  const input: DevelopmentInput = {
    trainingQuality: trainingIntensity,
    focus: camp.focus,
    coaching: quality.coaching + (camp.specialistHired ? 12 : 0),
    partners: quality.partners,
    activity: 1,
    longevity: fighter.longevity,
    difficultyScale: isPlayer ? diff.developmentScale : 1,
    trainingCapacity: capacity,
  };

  const deltas = developWeek(fighter, save.date, input, rng);

  // Camp wear. Hard weeks cost Longevity even when nothing goes wrong.
  applyWear(
    fighter,
    {
      neurological: (quality.hardSparring / 100) * camp.intensity * 0.13,
      joint: camp.intensity * 0.1,
      body: camp.intensity * 0.08,
      recovery: camp.intensity * 0.14 * (overtraining ? 1.8 : 1),
    },
    fighter.development.resilience
  );

  // Injury risk.
  let injured = false;
  {
    // The roll always happens, because it draws from the shared world rng. Gating it made the
    // injuries setting shift every later draw and change fight results across the world.
    const injury = rollTrainingInjury(
      fighter,
      {
        intensity: effectiveIntensity * (overtraining ? 1.5 : 1),
        hardSparring: quality.hardSparring,
        safety: quality.safety,
        cause: quality.hardSparring > 55 ? 'sparring' : 'training',
        difficultyScale: isPlayer ? diff.injuryScale : 1,
      },
      save.date,
      rng
    );
    if (injury && save.settings.injuriesEnabled) {
      fighter.injuries.push(injury);
      injured = true;
      outcomes.push({
        week,
        key: 'injury',
        headline: `${injury.type} in camp`,
        detail: injury.blocksCompetition
          ? `${injury.note} This rules out competing until it heals.`
          : `${injury.note} Training around it is possible but the camp will suffer.`,
        severity: 'bad',
      });
    }
  }

  // Positive and neutral camp events.
  const eventRoll = rng.next();
  if (!injured) {
    // A breakthrough needs good partners in the area it lands in. The gate used to read the
    // striking partners whatever the camp worked on, so a grappling room could never produce one
    // for its grapplers. The area is drawn only inside the roll, so ordinary weeks draw nothing
    // extra from the shared rng, and a failed gate falls through to the partner insight exactly
    // as a failed striking check did.
    const breakKey = eventRoll < 0.06 ? rng.weighted([...RATING_KEYS], (k) => camp.focus[k]) : null;
    if (breakKey && quality.partners[breakKey] > 60) {
      outcomes.push({
        week,
        key: 'breakthrough',
        headline: 'Something clicked this week',
        detail: 'A technical adjustment in the room has stuck. It should show up on fight night.',
        severity: 'good',
      });
      deltas[breakKey] = (deltas[breakKey] ?? 0) + rng.range(0.25, 0.7);
    } else if (eventRoll < 0.11) {
      outcomes.push({
        week,
        key: 'partner-insight',
        headline: 'Useful look from a training partner',
        detail: 'A partner has been mimicking the opponent well. Preparation is further along than expected.',
        severity: 'good',
      });
    } else if (eventRoll < 0.15 && quality.hardSparring > 62) {
      outcomes.push({
        week,
        key: 'hard-week',
        headline: 'A rough week of sparring',
        detail: 'The room got the better of the work. Nothing is torn, but the tank took a hit.',
        severity: 'bad',
      });
      applyWear(fighter, { neurological: 0.32, facial: 0.2 }, fighter.development.resilience);
    } else if (eventRoll < 0.19 && quality.gym && quality.gym.culture < 45) {
      outcomes.push({
        week,
        key: 'gym-friction',
        headline: 'Friction in the gym',
        detail: 'The atmosphere in the room is not helping. Focus has been inconsistent.',
        severity: 'bad',
      });
      fighter.happiness = clamp(fighter.happiness - rng.range(2, 6), 0, 100);
    } else if (eventRoll < 0.23) {
      outcomes.push({
        week,
        key: 'good-week',
        headline: 'A clean week of work',
        detail: 'Everything went to plan. No setbacks, good rounds, weight on schedule.',
        severity: 'good',
      });
      fighter.morale = clamp(fighter.morale + rng.range(1, 3), 0, 100);
    }
  }

  camp.weeksCompleted = week;
  camp.outcomes.push(...outcomes);
  camp.status = 'running';

  // The camp is paid for. `camp-costs` was a declared ledger category that nothing ever wrote, so
  // a player could run the most expensive camp available at no charge. Charging weekly rather than
  // up front means a camp cut short is only paid for as far as it got. The bookings were paid when
  // the camp was set (createCamp), so only the weekly part is spread here, and each week pays its
  // running share so the weeks add up to the quote exactly rather than to a rounded multiple.
  const weeklyPart = Math.max(0, camp.cost - (camp.upfrontCost ?? 0));
  if (save.player.fighterId === fighter.id && camp.weeks > 0 && week <= camp.weeks && weeklyPart > 0) {
    const due = Math.round((weeklyPart * week) / camp.weeks) - Math.round((weeklyPart * (week - 1)) / camp.weeks);
    if (due > 0) record(save, fighter.id, 'out', 'camp-costs', due, `Camp week ${week}`, camp.boutId ?? undefined);
  }
  fighter.ratings = applyDeltas(fighter.ratings, deltas);
  notePeakOvr(fighter, save.date);

  return { outcomes, ratingDeltas: deltas, injured };
}

/**
 * Closes out a camp and produces the fight night state: sharpness and tactical
 * familiarity. Both are bounded and both can be hurt by a bad camp.
 */
export function finalizeCamp(save: SaveGame, camp: TrainingCamp, rng: Rng): { sharpness: number; tacticalFamiliarity: number } {
  const fighter = save.fighters[camp.fighterId];
  const quality = gymQualityFor(save, camp);

  // Sharpness rises with completed weeks and falls off past the useful length.
  const weeks = camp.weeksCompleted;
  const idealWeeks = IDEAL_CAMP_WEEKS;
  // Even a short camp is worth more than none: the floor is what a few weeks of organised work
  // buys over turning up from ordinary gym time. Running from zero left anything under six weeks
  // less sharp than skipping camp entirely, and at a price. Past the ideal length the camp loses a
  // little and then levels off; the overtraining check is the real penalty for a long, hard camp,
  // and this term charged it a second time, six points a week, for a camp the page booked by default.
  const lengthTerm = weeks <= idealWeeks ? 0.4 + (0.6 * weeks) / idealWeeks : Math.max(0.9, 1 - (weeks - idealWeeks) * 0.02);
  const intensityTerm = 0.55 + camp.intensity * 0.6;
  const coachingTerm = 0.55 + (quality.coaching / 100) * 0.6;
  const badWeeks = camp.outcomes.filter((o) => o.severity === 'bad').length;
  const goodWeeks = camp.outcomes.filter((o) => o.severity === 'good').length;

  let sharpness =
    clamp(lengthTerm, 0, 1.1) * intensityTerm * coachingTerm * (camp.overtrained ? 0.72 : 1) +
    goodWeeks * 0.05 -
    badWeeks * 0.08;
  if (camp.campType === 'solo') sharpness *= 0.55;
  // Arriving early is worth something in proportion to how early. A single threshold at seven
  // days meant the four day option was byte identical to arriving on the standard schedule, so
  // one of the three choices in that control did nothing whatsoever.
  sharpness += Math.min(camp.arriveEarlyDays, ARRIVE_EARLY_CAP_DAYS) * ARRIVE_EARLY_PER_DAY;
  // The base built between camps opens the camp sharper. Small, and stacked with everything else.
  sharpness += (camp.baseBuilding ?? 0) * BASE_BUILDING_SHARPNESS;
  // Camping near the event does the same job across the whole camp rather than in the last week,
  // which is what the option says it buys and what its higher cost was already charging for.
  if (camp.campType === 'near-event') sharpness += NEAR_EVENT_SHARPNESS;

  // Camp life, the week to week decisions the player actually makes, is applied here. It was
  // recorded on `fighter.campSharpness` as a 0 to 100 form score and read by nothing at all, while
  // this function then overwrote the same field with a 0 to 1 value. The two writers disagreed
  // about the scale and neither reached the cage, so every camp life choice was inert.
  const form = fighter ? clamp(fighter.campSharpness, 0, 100) : CAMP_FORM_BASELINE;
  const formDelta = (form - CAMP_FORM_BASELINE) / CAMP_FORM_BASELINE;
  // A good camp closes part of the gap to a perfect one; a bad camp scales down. Multiplying by
  // 1 + delta looked symmetrical but was not: a strong camp is already near the ceiling, so the
  // positive half was clipped away by the final clamp and only the penalty ever reached the cage.
  if (formDelta >= 0) sharpness += (1 - sharpness) * formDelta * CAMP_FORM_WEIGHT;
  else sharpness *= 1 + formDelta * CAMP_FORM_WEIGHT;

  sharpness = clamp(sharpness + rng.normal(0, 0.05), 0, 1);

  // Tactical familiarity depends on the coherence of the plan and the quality of the room.
  const coherence = planCoherence(camp.gamePlan);
  let familiarity = clamp(
    (0.25 + Math.min(weeks, 10) * 0.075) * coherence * (0.6 + (quality.coaching / 100) * 0.65) + (camp.specialistHired ? 0.12 : 0),
    0,
    1
  );
  if (camp.campType === 'solo') familiarity *= 0.4;
  familiarity = clamp(familiarity + rng.normal(0, 0.05), 0, 1);

  camp.status = 'complete';
  camp.resultingSharpness = sharpness;
  camp.resultingTacticalFamiliarity = familiarity;

  if (fighter) {
    // Form resets for the next camp rather than carrying a finished camp's history forward.
    fighter.campSharpness = CAMP_FORM_BASELINE;
    fighter.conditioning = clamp(Math.round(45 + sharpness * 55), 10, 100);
  }

  return { sharpness, tacticalFamiliarity: familiarity };
}

/** A default camp for an AI controlled fighter. */
export function autoCampFor(save: SaveGame, fighter: Fighter, boutId: string, boutDate: IsoDate, rng: Rng): TrainingCamp {
  const weeksAvailable = clamp(Math.floor(daysBetween(save.date, boutDate) / 7), 0, 14);
  const preset = rng.weighted(CAMP_PRESETS, (p) => {
    if (weeksAvailable <= 3) return p.key === 'short-notice' ? 6 : 1;
    if (fighter.tendencies.takedownEntry > 0.6) return p.key === 'wrestling-pressure' || p.key === 'grappling-control' ? 4 : 1.4;
    if (fighter.tendencies.submissionHunt > 0.6) return p.key === 'submission-hunt' ? 4 : 1.4;
    if (fighter.ratings.striking > fighter.ratings.wrestling + 6) return p.key === 'striking-heavy' ? 4 : 1.4;
    return p.key === 'balanced' ? 3 : 1.4;
  });

  // A computer fighter starts camp the ideal length out, or today on shorter notice. Starting every
  // camp on the day of the booking ran fourteen week camps into the length and overtraining
  // penalties. The camp waits as planned until its start date, like the player's.
  const end = campEndFor(boutDate);
  const idealStart = campStartFor(boutDate, IDEAL_CAMP_WEEKS);
  const start = idealStart > save.date ? idealStart : save.date;
  const camp = createCamp(save, fighter, {
    boutId,
    startDate: start,
    endDate: end,
    focus: preset.focus,
    intensity: clamp(preset.intensity + rng.normal(0, 0.08), 0.25, 0.95),
    gymId: fighter.gymId,
    campType: fighter.gymId ? 'home' : 'solo',
    specialistHired: null,
    gamePlan: preset.plans,
    arriveEarlyDays: 0,
  });
  save.camps[camp.id] = camp;
  noteCampStored(save, camp);
  return camp;
}

export function campLengthLabel(weeks: number): string {
  if (weeks <= 0) return 'No camp';
  if (weeks === 1) return 'One week';
  if (weeks >= 12) return 'Twelve or more weeks';
  const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  return `${words[weeks]} weeks`;
}
