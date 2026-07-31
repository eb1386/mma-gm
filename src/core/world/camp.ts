import { DIFFICULTY } from '../config/calibration';
import { clamp, Rng } from '../rng';
import { addDays, daysBetween, type IsoDate } from '../types/common';
import { RATING_KEYS, type Fighter, type RatingKey } from '../types/fighter';
import type { CampFocus, CampOutcome, GamePlanKey, Gym, TrainingCamp } from '../types/world';
import type { SaveGame } from '../types/save';
import { applyDeltas, developWeek, evenFocus, type DevelopmentInput } from './development';
import { applyWear, rollTrainingInjury, trainingCapacityOf } from './health';
import { planCoherence } from '../sim/plan';
import { record } from './finance';

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

export interface CampSetup {
  boutId: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  focus: CampFocus;
  intensity: number;
  gymId: string | null;
  campType: TrainingCamp['campType'];
  specialistHired: string | null;
  gamePlan: GamePlanKey[];
  arriveEarlyDays: number;
}

/**
 * What a camp would cost, without creating one.
 *
 * The interface previously priced a camp by calling `createCamp` during render, which incremented
 * the persisted camp counter on every keystroke and every re-render. This is the same arithmetic
 * with no side effect, so the quoted price and the charged price cannot drift apart.
 */
export function estimateCampCost(save: SaveGame, setup: CampSetup): { weeks: number; cost: number } {
  const weeks = Math.max(0, Math.floor(daysBetween(setup.startDate, setup.endDate) / 7));
  const gym = setup.gymId ? save.gyms[setup.gymId] : null;
  const baseCost = gym ? gym.monthlyCosts * 0.06 : 2000;
  const typeMultiplier =
    setup.campType === 'visiting' ? 2.2 : setup.campType === 'split' ? 2.6 : setup.campType === 'near-event' ? 1.8 : setup.campType === 'solo' ? 0.3 : 1;
  const specialistCost = setup.specialistHired ? 12000 : 0;
  return { weeks, cost: Math.round(weeks * baseCost * typeMultiplier + specialistCost) };
}

/**
 * The neutral camp form score. Camp life nudges a fighter above or below it.
 *
 * Kept on the 0 to 100 scale the camp life system already used, so its existing adjustments are
 * correct as written and only needed somewhere to land.
 */
export const CAMP_FORM_BASELINE = 50;

/**
 * How much camp form moves fight night sharpness.
 *
 * A perfect camp is worth about a fifth more sharpness than a neutral one and a wretched camp
 * about a fifth less. Large enough that the decisions matter, small enough that camp life cannot
 * overwhelm the length, intensity and coaching that dominate preparation.
 */
export const CAMP_FORM_WEIGHT = 0.2;

export function createCamp(save: SaveGame, fighter: Fighter, setup: CampSetup): TrainingCamp {
  const { weeks, cost } = estimateCampCost(save, setup);
  // A new camp starts from neutral form, so last camp's run of bad weeks does not follow a fighter
  // into a preparation that has not happened yet.
  fighter.campSharpness = CAMP_FORM_BASELINE;

  return {
    id: `camp-${++save.counters.camp}`,
    fighterId: fighter.id,
    boutId: setup.boutId,
    startDate: setup.startDate,
    endDate: setup.endDate,
    weeks,
    intensity: clamp(setup.intensity, 0, 1),
    focus: normalizeFocus(setup.focus),
    gymId: setup.gymId,
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
  const headCoach = gym.staffIds.map((id) => save.staff[id]).filter(Boolean);
  const coachQuality = headCoach.length > 0 ? headCoach.reduce((s, c) => s + c.quality, 0) / headCoach.length : 40;
  const partners = { ...gym.trainingPartners };
  for (const spec of gym.specializations) partners[spec] = clamp(partners[spec] + 8, 0, 99);

  // A visiting fighter does not get the full benefit of an unfamiliar room on the first
  // camp there. Familiarity is modelled by how long the fighter has been a member.
  const isMember = gym.fighterIds.includes(camp.fighterId);
  const familiarity = camp.campType === 'home' && isMember ? 1 : camp.campType === 'visiting' ? 0.72 : camp.campType === 'split' ? 0.8 : 0.85;
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
  // which made loading a save change it and broke the round trip guarantee.
  if (camp.weeks > 0 && camp.weeksCompleted >= camp.weeks) {
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

  const effectiveIntensity = camp.intensity * capacity * (overtraining ? 0.6 : 1);

  const input: DevelopmentInput = {
    trainingQuality: effectiveIntensity,
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
  if (save.settings.injuriesEnabled) {
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
    if (injury) {
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
    if (eventRoll < 0.06 && quality.partners.striking > 60) {
      outcomes.push({
        week,
        key: 'breakthrough',
        headline: 'Something clicked this week',
        detail: 'A technical adjustment in the room has stuck. It should show up on fight night.',
        severity: 'good',
      });
      const key = rng.weighted([...RATING_KEYS], (k) => camp.focus[k]);
      deltas[key] = (deltas[key] ?? 0) + rng.range(0.25, 0.7);
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
  // up front means a camp cut short is only paid for as far as it got.
  if (save.player.fighterId === fighter.id && camp.weeks > 0 && camp.cost > 0) {
    const weekly = Math.round(camp.cost / camp.weeks);
    if (weekly > 0) record(save, fighter.id, 'out', 'camp-costs', weekly, `Camp week ${week}`, camp.boutId ?? undefined);
  }
  fighter.ratings = applyDeltas(fighter.ratings, deltas);

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
  const idealWeeks = 8;
  const lengthTerm = weeks <= idealWeeks ? weeks / idealWeeks : 1 - (weeks - idealWeeks) * 0.06;
  const intensityTerm = 0.55 + camp.intensity * 0.6;
  const coachingTerm = 0.55 + (quality.coaching / 100) * 0.6;
  const badWeeks = camp.outcomes.filter((o) => o.severity === 'bad').length;
  const goodWeeks = camp.outcomes.filter((o) => o.severity === 'good').length;

  let sharpness =
    clamp(lengthTerm, 0, 1.1) * intensityTerm * coachingTerm * (camp.overtrained ? 0.72 : 1) +
    goodWeeks * 0.05 -
    badWeeks * 0.08;
  if (camp.campType === 'solo') sharpness *= 0.55;
  if (camp.arriveEarlyDays >= 7) sharpness += 0.04;

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

  const start = save.date;
  const end = addDays(boutDate, -7);
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
  return camp;
}

export function campLengthLabel(weeks: number): string {
  if (weeks <= 0) return 'No camp';
  if (weeks === 1) return 'One week';
  if (weeks >= 12) return 'Twelve or more weeks';
  const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  return `${words[weeks]} weeks`;
}
