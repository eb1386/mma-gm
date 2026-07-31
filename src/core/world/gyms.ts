import { clamp, Rng } from '../rng';
import { invalidatePot } from './pot';
import { NAME_BANKS } from '../data/names';
import type { FighterId, GymId, IsoDate } from '../types/common';
import { RATING_KEYS, type Fighter } from '../types/fighter';
import type { Gym, GymStaff } from '../types/world';
import type { SaveGame } from '../types/save';

/**
 * Gyms, staff and fighter happiness.
 *
 * A gym affects development, camp preparation, injury risk, strategy access and scouting.
 * It never adds a permanent bonus to Ovr. Fighters retain autonomy: they can refuse
 * advice, object to how they are being treated, and leave.
 */

export const STAFF_ROLE_LABEL: Record<GymStaff['role'], string> = {
  'head-coach': 'Head coach',
  'striking-coach': 'Striking coach',
  'grappling-coach': 'Grappling coach',
  'wrestling-coach': 'Wrestling coach',
  'submission-coach': 'Submission coach',
  'strength-conditioning': 'Strength and conditioning',
  recovery: 'Recovery specialist',
  nutrition: 'Nutrition specialist',
  cutman: 'Cutman',
  psychologist: 'Sports psychologist',
  scout: 'Scout',
  manager: 'Manager',
};

export const STAFF_DEVELOPS: Record<GymStaff['role'], GymStaff['develops']> = {
  'head-coach': null,
  'striking-coach': 'striking',
  'grappling-coach': 'grappling',
  'wrestling-coach': 'wrestling',
  'submission-coach': 'submissions',
  'strength-conditioning': 'cardio',
  recovery: 'durability',
  nutrition: null,
  cutman: null,
  psychologist: null,
  scout: null,
  manager: null,
};

export function createGym(
  save: SaveGame,
  rng: Rng,
  opts: { name: string; country: string; countryCode: string; city: string; reputation?: number; isPlayerControlled?: boolean }
): Gym {
  const reputation = opts.reputation ?? clamp(Math.round(rng.normal(35, 12)), 5, 90);
  const id: GymId = `gym-${++save.counters.gym}`;
  const partners = {} as Gym['trainingPartners'];
  for (const k of RATING_KEYS) partners[k] = clamp(Math.round(rng.normal(reputation, 10)), 8, 98);

  const gym: Gym = {
    id,
    name: opts.name,
    country: opts.country,
    countryCode: opts.countryCode,
    city: opts.city,
    reputation,
    facilities: clamp(Math.round(rng.normal(reputation, 10)), 8, 98),
    capacity: rng.int(12, 40),
    staffIds: [],
    fighterIds: [],
    trainingPartners: partners,
    balance: opts.isPlayerControlled ? 75000 : Math.round(rng.range(20000, 300000)),
    monthlyCosts: Math.round(rng.range(9000, 60000)),
    revenueSharePct: Math.round(rng.range(4, 12)),
    culture: clamp(Math.round(rng.normal(64, 13)), 10, 98),
    safety: clamp(Math.round(rng.normal(62, 14)), 10, 98),
    hardSparringTendency: clamp(Math.round(rng.normal(50, 18)), 5, 95),
    specializations: rng.shuffle([...RATING_KEYS]).slice(0, rng.int(1, 2)),
    championsProduced: 0,
    rankedProduced: 0,
    founded: save.date,
    isPlayerControlled: opts.isPlayerControlled ?? false,
    isReal: false,
    note: 'Fictional gym created inside this save.',
    recentResults: { wins: 0, losses: 0 },
  };
  save.gyms[id] = gym;
  return gym;
}

export function hireStaff(save: SaveGame, gym: Gym, role: GymStaff['role'], rng: Rng, qualityTarget?: number): GymStaff {
  const bank = NAME_BANKS.find((b) => b.code === gym.countryCode) ?? NAME_BANKS[0];
  const quality = clamp(Math.round(qualityTarget ?? rng.normal(gym.reputation, 12)), 10, 97);
  const staff: GymStaff = {
    id: `staff-${++save.counters.staff}`,
    name: `${rng.pick(bank.first)} ${rng.pick(bank.last)}`,
    role,
    quality,
    develops: STAFF_DEVELOPS[role],
    salary: Math.round(5000 + quality * quality * 22),
    loyalty: clamp(Math.round(rng.normal(62, 14)), 10, 98),
    hiredOn: save.date,
    reputation: quality,
  };
  save.staff[staff.id] = staff;
  gym.staffIds.push(staff.id);
  return staff;
}

export function fireStaff(save: SaveGame, gym: Gym, staffId: string): void {
  gym.staffIds = gym.staffIds.filter((id) => id !== staffId);
  delete save.staff[staffId];
  // Firing a coach the team liked costs goodwill.
  for (const fid of gym.fighterIds) {
    const f = save.fighters[fid];
    if (f) f.happiness = clamp(f.happiness - 3, 0, 100);
  }
}

/** Candidate pool refreshed when the player opens the hiring screen. */
export function generateStaffCandidates(save: SaveGame, gym: Gym, role: GymStaff['role'], rng: Rng, count = 4): GymStaff[] {
  const out: GymStaff[] = [];
  for (let i = 0; i < count; i++) {
    const bank = rng.weighted(NAME_BANKS, (b) => b.weight);
    const quality = clamp(Math.round(rng.normal(gym.reputation * 0.8 + 22, 15)), 15, 96);
    out.push({
      id: `cand-${gym.id}-${role}-${i}-${save.date}`,
      name: `${rng.pick(bank.first)} ${rng.pick(bank.last)}`,
      role,
      quality,
      develops: STAFF_DEVELOPS[role],
      salary: Math.round(5000 + quality * quality * 22),
      loyalty: clamp(Math.round(rng.normal(58, 16)), 10, 98),
      hiredOn: save.date,
      reputation: quality,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fighter happiness
// ---------------------------------------------------------------------------

export interface HappinessFactor {
  label: string;
  delta: number;
}

/**
 * Recomputes a fighter's happiness drivers. Everything here is something the player can
 * actually influence, so an unhappy fighter always has a readable cause.
 */
export function happinessFactors(save: SaveGame, fighter: Fighter): HappinessFactor[] {
  const factors: HappinessFactor[] = [];
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;

  if (!gym) {
    factors.push({ label: 'No gym affiliation', delta: -12 });
    return factors;
  }

  factors.push({ label: 'Coach relationship', delta: (fighter.relationships.coach - 55) * 0.18 });
  factors.push({ label: 'Gym facilities', delta: (gym.facilities - 50) * 0.09 });
  factors.push({ label: 'Training partner quality', delta: (gym.trainingPartners.striking + gym.trainingPartners.wrestling) / 2 / 10 - 5.5 });
  factors.push({ label: 'Gym culture', delta: (gym.culture - 55) * 0.14 });
  factors.push({ label: 'Safety standards', delta: (gym.safety - 50) * 0.1 });
  if (gym.hardSparringTendency > 70) factors.push({ label: 'Excessive hard sparring', delta: -(gym.hardSparringTendency - 70) * 0.22 });
  factors.push({ label: 'Revenue share', delta: (8 - gym.revenueSharePct) * 1.1 });

  if (fighter.winStreak >= 2) factors.push({ label: 'Winning', delta: fighter.winStreak * 1.6 });
  if (fighter.lossStreak >= 1) factors.push({ label: 'Losing', delta: -fighter.lossStreak * 4.2 });

  const activeInjuries = fighter.injuries.filter((i) => i.actualReturn === null);
  if (activeInjuries.length > 0) factors.push({ label: 'Currently injured', delta: -activeInjuries.length * 3.5 });

  // Attention: too many fighters per coach dilutes the room.
  const coachCount = gym.staffIds.length;
  const load = gym.fighterIds.length / Math.max(1, coachCount);
  if (load > 4) factors.push({ label: 'Not enough individual attention', delta: -(load - 4) * 3.2 });

  // Favoritism: a gym where one fighter takes all the resources breeds resentment.
  const ranked = gym.fighterIds.map((id) => save.fighters[id]).filter((f) => f && f.ranking !== null).length;
  if (ranked >= 3 && fighter.ranking === null) factors.push({ label: 'Overlooked behind ranked teammates', delta: -4 });

  if (gym.championsProduced > 0) factors.push({ label: 'Team success', delta: clamp(gym.championsProduced * 2.2, 0, 8) });
  if (gym.balance < 0) factors.push({ label: 'Gym financial instability', delta: -6 });

  return factors;
}

export function updateHappiness(save: SaveGame, fighter: Fighter): void {
  const factors = happinessFactors(save, fighter);
  const target = clamp(60 + factors.reduce((s, f) => s + f.delta, 0), 0, 100);
  // Happiness moves toward the target rather than snapping to it.
  fighter.happiness = clamp(fighter.happiness + (target - fighter.happiness) * 0.22, 0, 100);
}

export type FighterAutonomyAction =
  | { kind: 'none' }
  | { kind: 'request-attention'; message: string }
  | { kind: 'object-to-sparring'; message: string }
  | { kind: 'object-to-favoritism'; message: string }
  | { kind: 'request-corner-change'; message: string }
  | { kind: 'consider-leaving'; message: string }
  | { kind: 'leave'; message: string; newGymId: GymId | null }
  | { kind: 'refuse-plan'; message: string }
  | { kind: 'change-division'; message: string };

/**
 * Fighters act on their own. This is the core of Coach Mode: the player advises, the
 * fighter decides.
 */
export function rollFighterAutonomy(save: SaveGame, fighter: Fighter, rng: Rng): FighterAutonomyAction {
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  if (!gym) return { kind: 'none' };

  const unhappy = fighter.happiness < 45;
  const veryUnhappy = fighter.happiness < 28;

  if (veryUnhappy && rng.chance(0.16)) {
    // Find a plausible destination gym with better standing.
    const options = Object.values(save.gyms).filter((g) => g.id !== gym.id && g.reputation > gym.reputation && g.fighterIds.length < g.capacity);
    const target = options.length > 0 ? rng.weighted(options, (g) => g.reputation) : null;
    return {
      kind: 'leave',
      message: target
        ? `${fighter.name} is leaving the gym for ${target.name}. The stated reason is a lack of individual attention and a training environment that has stopped working.`
        : `${fighter.name} is leaving the gym without a destination lined up.`,
      newGymId: target?.id ?? null,
    };
  }

  if (unhappy && rng.chance(0.2)) {
    return {
      kind: 'consider-leaving',
      message: `${fighter.name} has been asking around about other gyms. Something needs to change.`,
    };
  }

  if (gym.hardSparringTendency > 72 && rng.chance(0.12)) {
    return {
      kind: 'object-to-sparring',
      message: `${fighter.name} says the sparring in the room is too hard and they are showing up to camp already beaten up.`,
    };
  }

  const ranked = gym.fighterIds.map((id) => save.fighters[id]).filter((f) => f && f.ranking !== null);
  if (ranked.length >= 2 && fighter.ranking === null && rng.chance(0.08)) {
    return {
      kind: 'object-to-favoritism',
      message: `${fighter.name} feels the gym's attention goes to the ranked fighters and wants that addressed.`,
    };
  }

  const load = gym.fighterIds.length / Math.max(1, gym.staffIds.length);
  if (load > 4.5 && rng.chance(0.1)) {
    return {
      kind: 'request-attention',
      message: `${fighter.name} wants more one on one time and thinks the room is stretched too thin.`,
    };
  }

  if (fighter.relationships.coach < 35 && rng.chance(0.1)) {
    return {
      kind: 'request-corner-change',
      message: `${fighter.name} wants a different corner team for the next fight.`,
    };
  }

  // A fighter struggling with the cut may decide to move divisions regardless of advice.
  if (fighter.wear.weightCut > 62 && rng.chance(0.06)) {
    return {
      kind: 'change-division',
      message: `${fighter.name} says the cut is no longer worth it and intends to move up.`,
    };
  }

  return { kind: 'none' };
}

/** Does the fighter accept the coach's recommended camp plan. */
export function acceptsCampRecommendation(fighter: Fighter, rng: Rng): boolean {
  const trust = fighter.relationships.player * 0.6 + fighter.relationships.coach * 0.4;
  const base = clamp(0.25 + trust / 140, 0.2, 0.95);
  return rng.chance(base);
}

/** Does the fighter accept a fight the coach advised against, or refuse one advised. */
export function fighterOverridesAdvice(fighter: Fighter, coachAdvisedAccept: boolean, rng: Rng): boolean {
  const trust = fighter.relationships.player;
  const stubbornness = clamp(0.5 - trust / 200 + (1 - fighter.tendencies.riskTolerance) * 0.1, 0.04, 0.5);
  void coachAdvisedAccept;
  return rng.chance(stubbornness);
}

export function moveFighterToGym(save: SaveGame, fighterId: FighterId, newGymId: GymId | null): void {
  const fighter = save.fighters[fighterId];
  if (!fighter) return;
  if (fighter.gymId !== newGymId) invalidatePot(save, fighterId, 'gym-change');
  if (fighter.gymId) {
    const old = save.gyms[fighter.gymId];
    if (old) old.fighterIds = old.fighterIds.filter((id) => id !== fighterId);
  }
  fighter.gymId = newGymId;
  if (newGymId) {
    const g = save.gyms[newGymId];
    if (g && !g.fighterIds.includes(fighterId)) g.fighterIds.push(fighterId);
    fighter.relationships.coach = 50;
  }
}

/** Monthly gym finances. */
export function runGymMonth(save: SaveGame, gym: Gym): { income: number; costs: number; net: number; lines: string[] } {
  const lines: string[] = [];
  // One settlement per calendar month. The player facing button had no guard, so pressing it
  // repeatedly credited the gym its monthly income again and again and then double counted against
  // the automatic settlement when the calendar reached the same month.
  const month = save.date.slice(0, 7);
  if (gym.lastSettledMonth === month) {
    return { income: 0, costs: 0, net: 0, lines: ['This month has already been settled.'] };
  }
  gym.lastSettledMonth = month;
  const salaries = gym.staffIds.reduce((s, id) => s + (save.staff[id]?.salary ?? 0) / 12, 0);
  const overhead = gym.monthlyCosts;
  const membership = gym.fighterIds.length * 900 + gym.reputation * 220;
  let purseShare = 0;
  for (const fid of gym.fighterIds) {
    const f = save.fighters[fid];
    if (!f || !f.lastPurse) continue;
    if (f.lastFightDate && f.lastFightDate > addMonthsBack(save.date)) {
      purseShare += f.lastPurse * (gym.revenueSharePct / 100);
    }
  }
  const income = Math.round(membership + purseShare);
  const costs = Math.round(salaries + overhead);
  gym.balance += income - costs;
  lines.push(`Membership and programs ${Math.round(membership)}`);
  if (purseShare > 0) lines.push(`Fighter purse share ${Math.round(purseShare)}`);
  lines.push(`Staff salaries ${Math.round(salaries)}`);
  lines.push(`Facility overhead ${overhead}`);
  return { income, costs, net: income - costs, lines };
}

function addMonthsBack(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 2, d));
  return dt.toISOString().slice(0, 10);
}

/** Facility and reputation upgrades available to a player controlled gym. */
export const GYM_UPGRADES = [
  { key: 'mats', label: 'Resurface the mats', cost: 18000, apply: (g: Gym) => (g.facilities = clamp(g.facilities + 5, 0, 99)) },
  { key: 'strength', label: 'Build out the strength room', cost: 45000, apply: (g: Gym) => (g.facilities = clamp(g.facilities + 9, 0, 99)) },
  { key: 'recovery', label: 'Add a recovery suite', cost: 62000, apply: (g: Gym) => (g.safety = clamp(g.safety + 10, 0, 99)) },
  { key: 'cage', label: 'Install a full size cage', cost: 38000, apply: (g: Gym) => (g.facilities = clamp(g.facilities + 7, 0, 99)) },
  { key: 'expand', label: 'Expand the floor space', cost: 90000, apply: (g: Gym) => (g.capacity += 8) },
  {
    key: 'sparring-policy',
    label: 'Introduce a controlled sparring policy',
    cost: 12000,
    apply: (g: Gym) => {
      g.hardSparringTendency = clamp(g.hardSparringTendency - 15, 0, 100);
      g.safety = clamp(g.safety + 6, 0, 99);
    },
  },
  {
    key: 'culture',
    label: 'Invest in team culture',
    cost: 22000,
    apply: (g: Gym) => (g.culture = clamp(g.culture + 8, 0, 99)),
  },
];

/** Recruiting pitch success, used by Coach Mode. */
export function recruitmentChance(save: SaveGame, gym: Gym, target: Fighter): number {
  const current = target.gymId ? save.gyms[target.gymId] : null;
  let p = 0.12;
  p += clamp((gym.reputation - (current?.reputation ?? 30)) / 90, -0.3, 0.4);
  p += clamp((gym.facilities - (current?.facilities ?? 30)) / 160, -0.15, 0.2);
  p += clamp((100 - target.happiness) / 220, 0, 0.35);
  p -= clamp((gym.revenueSharePct - (current?.revenueSharePct ?? 8)) / 25, -0.15, 0.3);
  if (gym.fighterIds.length >= gym.capacity) p = 0;
  if (target.ranking !== null && target.ranking <= 8 && gym.reputation < 60) p *= 0.35;
  return clamp(p, 0, 0.85);
}
