import { clamp, hashString, Rng } from '../rng';
import { record } from './finance';
import { invalidatePot } from './pot';
import { hasLiveBooking } from './availability';
import { NAME_BANKS } from '../data/names';
import { daysBetween, formatDate, formatMoney, type FighterId, type GymId, type IsoDate } from '../types/common';
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

/**
 * A gym's location for display. A real gym's city is known only when its own name gives one, and its
 * country is then a game value taken from a member, so a gym with no known city shows no location
 * rather than "Unknown, Unknown" or a guessed country.
 */
export function gymLocation(g: Pick<Gym, 'city' | 'country'>): string {
  if (!g.city || g.city === 'Unknown') return '';
  return g.country && g.country !== 'Unknown' ? `${g.city}, ${g.country}` : g.city;
}

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
  if (opts.isPlayerControlled) {
    // A room opened this morning has bare walls, and pays for what it is rather than a random
    // figure. The random overhead (up to $60k a month) sank a new coach gym by its second month,
    // when membership at its starting reputation brings in about $4k. The draws above still happen,
    // so the world rng runs the same either way.
    gym.facilities = Math.min(gym.facilities, NEW_PLAYER_GYM_FACILITIES_CAP);
    gym.monthlyCosts = playerGymMonthlyCosts(gym);
  }
  save.gyms[id] = gym;
  return gym;
}

/** The best facilities a gym the player founds can open with. */
export const NEW_PLAYER_GYM_FACILITIES_CAP = 30;

/**
 * Monthly overhead for a gym the player founded, from its size: rent and upkeep for the floor
 * space and the equipment. Roughly $8k to $12k for a fresh room, so membership and a few fighters
 * can carry it, and a bigger, better equipped room costs more to run.
 */
export function playerGymMonthlyCosts(gym: Pick<Gym, 'capacity' | 'facilities'>): number {
  return Math.round(4000 + gym.capacity * 150 + gym.facilities * 40);
}

/**
 * Rebuilds the count of fighters each gym has got ranked, from who has ever held a ranking.
 *
 * One rule, used by the migration for existing saves and by new game creation for the imported
 * roster. Without the new game call, a fresh save started from a snapshot showed zero for gyms
 * with a dozen ranked fighters on the books, because every snapshot fighter already carries a
 * highest ranking and so never looks like a first time entry to the live counter.
 *
 * The credit goes to the gym the fighter is at now, which is the only affiliation a rebuild can
 * know. The live counter credits the gym they were at when they first ranked, which is the more
 * accurate rule and the one that applies from the start of the save onward.
 */
export function seedRankedProduced(save: SaveGame): void {
  for (const gym of Object.values(save.gyms ?? {})) gym.rankedProduced = 0;
  for (const f of Object.values(save.fighters ?? {})) {
    if (f.highestRanking === null || f.highestRanking === undefined) continue;
    if (!f.gymId) continue;
    const gym = save.gyms?.[f.gymId];
    if (gym) gym.rankedProduced++;
  }
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

/**
 * The rng a candidate search draws from.
 *
 * Seeded with the staff counter as well as the day, because every hire moves the counter. Seeded
 * on the day alone, a second search after a hire returned the same four people, including the one
 * just hired, who could then be hired again as a duplicate under the same name.
 */
export function staffCandidateRng(save: SaveGame, role: GymStaff['role']): Rng {
  return new Rng(`${save.seed}-${role}-${save.date}-${save.counters.staff ?? 0}`);
}

/** Candidate pool refreshed when the player opens the hiring screen. */
export function generateStaffCandidates(save: SaveGame, gym: Gym, role: GymStaff['role'], rng: Rng, count = 4): GymStaff[] {
  const out: GymStaff[] = [];
  // Nobody already on the staff is offered again as a stranger looking for work.
  const taken = new Set(gym.staffIds.map((id) => save.staff[id]?.name).filter(Boolean));
  const pool = save.counters.staff ?? 0;
  for (let i = 0; i < count; i++) {
    const bank = rng.weighted(NAME_BANKS, (b) => b.weight);
    const quality = clamp(Math.round(rng.normal(gym.reputation * 0.8 + 22, 15)), 15, 96);
    let name = `${rng.pick(bank.first)} ${rng.pick(bank.last)}`;
    for (let tries = 0; tries < 5 && (taken.has(name) || out.some((c) => c.name === name)); tries++) {
      name = `${rng.pick(bank.first)} ${rng.pick(bank.last)}`;
    }
    out.push({
      id: `cand-${gym.id}-${role}-${pool}-${i}-${save.date}`,
      name,
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
  // Belts are rare. A gym that keeps moving people into the top fifteen is a good place to be
  // even in a period with no champion on the wall.
  if (gym.rankedProduced > 0) factors.push({ label: 'A gym that gets people ranked', delta: clamp(gym.rankedProduced * 0.5, 0, 4) });
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

  // A fighter struggling with the cut may decide to move divisions regardless of advice. The roll
  // comes first so the world rng draws the same either way. Somebody whose move is not the room's
  // to back does not raise it: a booked fighter, a champion (the belt decides that, on its own
  // path), a regional fighter who stays at the circuit's weight, and the player's own fighter.
  if (fighter.wear.weightCut > 62 && rng.chance(0.06) && mayRaiseDivisionChange(save, fighter)) {
    return {
      kind: 'change-division',
      message: `${fighter.name} says the cut is no longer worth it and intends to move up.`,
    };
  }

  return { kind: 'none' };
}

/** Whether a gym fighter can bring a division change to the coach at all. */
export function mayRaiseDivisionChange(save: SaveGame, fighter: Fighter): boolean {
  if (fighter.id === save.player.fighterId) return false;
  if (fighter.circuit) return false;
  if (hasLiveBooking(save, fighter)) return false;
  const table = save.rankings[fighter.divisionId];
  if (fighter.isChampion || fighter.isInterimChampion) return false;
  if (table?.championId === fighter.id || table?.interimChampionId === fighter.id) return false;
  return true;
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
  if (fighter.gymId && fighter.gymId !== newGymId) {
    const old = save.gyms[fighter.gymId];
    if (old) {
      old.fighterIds = old.fighterIds.filter((id) => id !== fighterId);
      // People who no longer share a room are no longer training partners. The bond only ever
      // rose, so somebody who left years ago still read as a training partner. Only existing
      // relationships are touched: leaving creates nobody new and writes no history.
      setTeammateBonds(save, fighterId, old.fighterIds, (bond) => Math.min(bond, FORMER_TEAMMATE_BOND));
    }
  }
  fighter.gymId = newGymId;
  if (newGymId) {
    const g = save.gyms[newGymId];
    if (g && !g.fighterIds.includes(fighterId)) g.fighterIds.push(fighterId);
    // Somebody they already know in the new room is a training partner again.
    if (g) setTeammateBonds(save, fighterId, g.fighterIds, (bond) => Math.max(bond, CURRENT_TEAMMATE_BOND));
    fighter.relationships.coach = 50;
  }
}

/** The bond at which two people who used to share a room settle once they no longer do. */
const FORMER_TEAMMATE_BOND = 40;
/** The bond two fighters in the same room start from, matching a new teammate relationship. */
const CURRENT_TEAMMATE_BOND = 60;

function setTeammateBonds(save: SaveGame, fighterId: FighterId, others: FighterId[], next: (bond: number) => number): void {
  const store = save.relationships;
  if (!store) return;
  for (const otherId of others) {
    if (otherId === fighterId) continue;
    const r = store[[fighterId, otherId].sort().join('|')];
    if (r) r.teammateBond = next(r.teammateBond);
  }
}

/**
 * The player changes gyms, with the reason stated and the consequences applied.
 *
 * Players asked for this directly, and asked for it to matter: leaving a room that has done
 * nothing wrong burns the bridge, while leaving with a real reason is understood. The reason is
 * derived from the situation rather than picked from a menu, because the situation is what the
 * old room actually reacts to.
 */
export function switchGym(
  save: SaveGame,
  fighter: Fighter,
  targetGymId: GymId
): { ok: boolean; message: string; justified: boolean } {
  const target = save.gyms[targetGymId];
  if (!target) return { ok: false, message: 'That gym no longer exists.', justified: false };
  if (fighter.gymId === targetGymId) {
    return { ok: false, message: `${fighter.name} already trains at ${target.name}.`, justified: false };
  }
  for (const camp of Object.values(save.camps)) {
    if (camp.fighterId === fighter.id && (camp.status === 'planned' || camp.status === 'running')) {
      return { ok: false, message: 'A camp is underway. Changing rooms mid preparation is how fights are lost.', justified: false };
    }
  }

  const old = fighter.gymId ? save.gyms[fighter.gymId] : null;
  // A move is understood when the fighter is going somewhere clearly better, or leaving somewhere
  // that has stopped working for them. Anything else is walking out on a room that did its job.
  const justified =
    !old ||
    target.reputation > old.reputation + GYM_MOVE_REPUTATION_MARGIN ||
    fighter.happiness < GYM_MOVE_UNHAPPY_BELOW ||
    fighter.relationships.coach < GYM_MOVE_COLD_COACH_BELOW;

  if (old && !justified) {
    // The old room takes it personally, and the word gets around.
    for (const id of old.fighterIds) {
      if (id === fighter.id) continue;
      const teammate = save.fighters[id];
      if (teammate) teammate.relationships.team = clamp(teammate.relationships.team - 4, 0, 100);
    }
    fighter.happiness = clamp(fighter.happiness - 6, 0, 100);
    fighter.relationships.team = clamp(fighter.relationships.team - 18, 0, 100);
  } else {
    fighter.happiness = clamp(fighter.happiness + 8, 0, 100);
  }

  moveFighterToGym(save, fighter.id, targetGymId);
  return {
    ok: true,
    justified,
    message: justified
      ? `${fighter.name} has moved to ${target.name}. ${old ? `${old.name} understood the decision.` : 'A room at last.'}`
      : `${fighter.name} has moved to ${target.name}. ${old!.name} did not take it well, and the sport remembers who walks out.`,
  };
}

/** How much better a destination has to be for leaving a healthy room to read as justified. */
export const GYM_MOVE_REPUTATION_MARGIN = 8;
export const GYM_MOVE_UNHAPPY_BELOW = 45;
export const GYM_MOVE_COLD_COACH_BELOW = 40;

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
  // Credited once, for fights since the last settlement. A rolling one month window overlapped
  // two consecutive settlements, so a fight near a month boundary paid the gym twice.
  const since = gym.lastSettledOn ?? addMonthsBack(save.date);
  for (const fid of gym.fighterIds) {
    const f = save.fighters[fid];
    if (!f || !f.lastPurse) continue;
    if (f.lastFightDate && f.lastFightDate > since) {
      purseShare += f.lastPurse * (gym.revenueSharePct / 100);
    }
  }
  gym.lastSettledOn = save.date;
  const income = Math.round(membership + purseShare);
  const costs = Math.round(salaries + overhead);
  gym.balance += income - costs;
  lines.push(`Membership and programs ${formatMoney(membership)}`);
  if (purseShare > 0) lines.push(`Fighter purse share ${formatMoney(purseShare)}`);
  lines.push(`Staff salaries ${formatMoney(salaries)}`);
  lines.push(`Facility overhead ${formatMoney(overhead)}`);
  return { income, costs, net: income - costs, lines };
}

/** The answers to the decision raised when the player's gym ends a month in debt. */
export const GYM_DEBT_CHOICES = { cover: 'gym-cover-shortfall', carry: 'gym-carry-debt' } as const;
/** Below this many months of costs in the bank, the monthly statement asks to be read. */
export const GYM_RUNWAY_WARNING_MONTHS = 2;
/** Standing lost each month the gym closes its books in debt: suppliers and members talk. */
export const GYM_DEBT_REPUTATION_LOSS = 1;
/** The further standing lost when the owner chooses to let the debt ride. */
const GYM_CARRY_DEBT_REPUTATION_LOSS = 2;

/** The coach's own money: the same figure the money pages show. */
function ownMoney(save: SaveGame): number {
  return save.finance?.cash ?? save.player.balance;
}

/**
 * Pays the gym's debt out of the coach's own money, as far as it goes. What cannot be covered
 * stays on the gym's books.
 */
export function coverGymShortfall(save: SaveGame, gym: Gym): string {
  const owed = Math.max(0, -Math.round(gym.balance));
  if (owed === 0) return `${gym.name} is no longer in debt, so there is nothing to cover.`;
  const paid = Math.min(owed, Math.max(0, Math.floor(ownMoney(save))));
  if (paid <= 0) return `${carryGymDebt(gym)} There was nothing in your own account to cover it with.`;
  gym.balance += paid;
  // Through the ledger like every other movement of the player's money, so the cash, the debt and
  // the career totals all agree with what the Money page lists.
  record(save, save.player.coachStaffId ?? 'coach', 'out', 'gym-investment', paid, `Covered ${gym.name}'s shortfall`);
  return paid >= owed
    ? `You put ${formatMoney(paid)} of your own money in, and ${gym.name} is back above zero.`
    : `You put in all you had, ${formatMoney(paid)}. ${gym.name} still owes ${formatMoney(owed - paid)}.`;
}

/** Lets the gym carry its debt. Upgrades and hiring stay frozen, since both are paid from the balance. */
export function carryGymDebt(gym: Gym): string {
  gym.reputation = clamp(gym.reputation - GYM_CARRY_DEBT_REPUTATION_LOSS, 0, 100);
  return `${gym.name} carries the debt. Upgrades and hiring are frozen until the balance is back above zero, and the unpaid bills have cost the gym some standing.`;
}

function addMonthsBack(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 2, d));
  return dt.toISOString().slice(0, 10);
}

/** The most fighters a gym can be built out to hold. */
export const GYM_CAPACITY_CAP = 60;

export interface GymUpgrade {
  key: string;
  label: string;
  cost: number;
  apply: (g: Gym) => void;
  /**
   * Whether buying it again would change nothing. The stats clamp at 99, so with no check the
   * button kept taking the money for an upgrade that did nothing, and the floor space grew forever.
   */
  isMaxed: (g: Gym) => boolean;
}

/** Facility and reputation upgrades available to a player controlled gym. */
export const GYM_UPGRADES: GymUpgrade[] = [
  { key: 'mats', label: 'Resurface the mats', cost: 18000, apply: (g) => (g.facilities = clamp(g.facilities + 5, 0, 99)), isMaxed: (g) => g.facilities >= 99 },
  { key: 'strength', label: 'Build out the strength room', cost: 45000, apply: (g) => (g.facilities = clamp(g.facilities + 9, 0, 99)), isMaxed: (g) => g.facilities >= 99 },
  { key: 'recovery', label: 'Add a recovery suite', cost: 62000, apply: (g) => (g.safety = clamp(g.safety + 10, 0, 99)), isMaxed: (g) => g.safety >= 99 },
  { key: 'cage', label: 'Install a full size cage', cost: 38000, apply: (g) => (g.facilities = clamp(g.facilities + 7, 0, 99)), isMaxed: (g) => g.facilities >= 99 },
  {
    key: 'expand',
    label: 'Expand the floor space',
    cost: 90000,
    apply: (g) => (g.capacity = Math.min(g.capacity + 8, GYM_CAPACITY_CAP)),
    isMaxed: (g) => g.capacity >= GYM_CAPACITY_CAP,
  },
  {
    key: 'sparring-policy',
    label: 'Introduce a controlled sparring policy',
    cost: 12000,
    apply: (g) => {
      g.hardSparringTendency = clamp(g.hardSparringTendency - 15, 0, 100);
      g.safety = clamp(g.safety + 6, 0, 99);
    },
    isMaxed: (g) => g.safety >= 99 && g.hardSparringTendency <= 0,
  },
  {
    key: 'culture',
    label: 'Invest in team culture',
    cost: 22000,
    apply: (g) => (g.culture = clamp(g.culture + 8, 0, 99)),
    isMaxed: (g) => g.culture >= 99,
  },
];

/**
 * Buys an upgrade for the gym. The checks run here, at the moment of purchase, rather than only on
 * the button, so a stale page can never take money for an upgrade that would do nothing.
 */
export function buyGymUpgrade(save: SaveGame, gymId: GymId, key: string): { ok: boolean; message: string } {
  const gym = save.gyms[gymId];
  const upgrade = GYM_UPGRADES.find((u) => u.key === key);
  if (!gym || !upgrade) return { ok: false, message: 'That upgrade is not available.' };
  if (upgrade.isMaxed(gym)) return { ok: false, message: `${upgrade.label}: there is nothing more to gain.` };
  if (gym.balance < upgrade.cost) return { ok: false, message: `The gym cannot afford ${formatMoney(upgrade.cost)} right now.` };
  gym.balance -= upgrade.cost;
  upgrade.apply(gym);
  return { ok: true, message: `${upgrade.label} complete.` };
}

/** How long a fighter who turned down a pitch will not hear another one. */
export const PITCH_COOLDOWN_DAYS = 60;
/** How long a refusal is remembered, making a later pitch less likely to land. */
export const PITCH_MEMORY_DAYS = 365;
/** What a remembered refusal leaves of the chance once the cooldown is over. */
const REPEAT_PITCH_FACTOR = 0.6;

/** The date this fighter last turned the gym down, while it still counts. */
export function pitchRefusedOn(save: SaveGame, gym: Gym, target: Fighter): IsoDate | null {
  const on = gym.pitchRefusals?.[target.id];
  if (!on) return null;
  return daysBetween(on, save.date) < PITCH_MEMORY_DAYS ? on : null;
}

/** Whether the fighter is still in the cooldown after turning the gym down. */
export function pitchCoolingDown(save: SaveGame, gym: Gym, target: Fighter): boolean {
  const on = pitchRefusedOn(save, gym, target);
  return on !== null && daysBetween(on, save.date) < PITCH_COOLDOWN_DAYS;
}

/** Recruiting pitch success, used by Coach Mode. */
export function recruitmentChance(save: SaveGame, gym: Gym, target: Fighter): number {
  // A fighter who has just said no is not asked again for a while, and a fighter who has said no
  // before is harder to win over. Without this a pitch could be repeated until it landed.
  if (pitchCoolingDown(save, gym, target)) return 0;
  const current = target.gymId ? save.gyms[target.gymId] : null;
  let p = 0.12;
  p += clamp((gym.reputation - (current?.reputation ?? 30)) / 90, -0.3, 0.4);
  p += clamp((gym.facilities - (current?.facilities ?? 30)) / 160, -0.15, 0.2);
  p += clamp((100 - target.happiness) / 220, 0, 0.35);
  p -= clamp((gym.revenueSharePct - (current?.revenueSharePct ?? 8)) / 25, -0.15, 0.3);
  if (gym.fighterIds.length >= gym.capacity) p = 0;
  if (target.ranking !== null && target.ranking <= 8 && gym.reputation < 60) p *= 0.35;
  if (pitchRefusedOn(save, gym, target)) p *= REPEAT_PITCH_FACTOR;
  return clamp(p, 0, 0.85);
}

/**
 * Pitches the gym to a fighter. One answer per fighter per day, from a roll seeded on the gym, the
 * fighter and the date rather than the shared world rng, so tapping again cannot reroll it and a
 * pitch made from the page does not shift the world's draws.
 */
export function pitchFighter(save: SaveGame, gymId: GymId, fighterId: FighterId): { joined: boolean; message: string } {
  const gym = save.gyms[gymId];
  const target = save.fighters[fighterId];
  if (!gym || !target) return { joined: false, message: 'That fighter is no longer available.' };
  if (target.gymId === gym.id) return { joined: false, message: `${target.name} already trains at ${gym.name}.` };
  if (gym.fighterIds.length >= gym.capacity) return { joined: false, message: `${gym.name} has no room for another fighter.` };
  const refused = pitchRefusedOn(save, gym, target);
  if (refused && pitchCoolingDown(save, gym, target)) {
    return { joined: false, message: `${target.name} turned you down on ${formatDate(refused)} and is not ready to hear it again.` };
  }
  const chance = recruitmentChance(save, gym, target);
  const rng = new Rng(hashString(`pitch-${save.seed}-${gym.id}-${target.id}-${save.date}`));
  if (chance > 0 && rng.chance(chance)) {
    moveFighterToGym(save, target.id, gym.id);
    target.relationships.player = 55;
    if (gym.pitchRefusals) delete gym.pitchRefusals[target.id];
    return { joined: true, message: `${target.name} has joined ${gym.name}.` };
  }
  if (!gym.pitchRefusals) gym.pitchRefusals = {};
  gym.pitchRefusals[target.id] = save.date;
  // Being chased by a gym they have no interest in costs a little goodwill.
  target.relationships.player = clamp(target.relationships.player - 3, 0, 100);
  return { joined: false, message: `${target.name} turned the pitch down.` };
}
