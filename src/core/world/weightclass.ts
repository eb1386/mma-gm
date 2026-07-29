import { DIVISIONS, DIVISION_BY_ID, type DivisionConfig, type DivisionId } from '../config/divisions';
import { clamp, Rng } from '../rng';
import { addDays, ageOn, type FighterId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { healthyCutFor } from './health';
import { hasLiveBooking } from './availability';
import { managerFor } from './finance';
import { addInboxMessage } from './inbox';
import { PROMOTION_MATCHMAKING } from '../config/branding';

/**
 * Moving up or down a division.
 *
 * The projections shown to the player are descriptive rather than numeric, because the
 * game does not otherwise expose exact ratings. Everything here is about what a move costs
 * and what it buys, not about revealing hidden values.
 */

export interface WeightClassPlan {
  fromDivisionId: DivisionId;
  toDivisionId: DivisionId;
  direction: 'up' | 'down';
  status: 'exploring' | 'requested' | 'approved' | 'refused' | 'committed' | 'completed' | 'canceled';
  announcedPublicly: boolean;
  startedOn: IsoDate;
  decidedOn: IsoDate | null;
  managerOpinion: string | null;
  coachOpinion: string | null;
  promotionResponse: string | null;
  note: string;
}

export interface DivisionOption {
  division: DivisionConfig;
  direction: 'up' | 'down';
  /** Descriptive, never a raw rating. */
  weightDifficulty: string;
  speedEffect: string;
  strengthEffect: string;
  cardioEffect: string;
  durabilityEffect: string;
  adaptationPeriod: string;
  rankingConsequence: string;
  titleConsequence: string;
  contractConsequence: string;
  healthRisk: string;
  championName: string | null;
  likelyOpponents: string[];
  benefits: string[];
  costs: string[];
  promotionLikelihood: number;
}

/** Divisions immediately adjacent to this fighter's, same gender only. */
export function adjacentDivisions(fighter: Fighter): { up: DivisionConfig | null; down: DivisionConfig | null } {
  const current = DIVISION_BY_ID[fighter.divisionId];
  const sameGender = DIVISIONS.filter((d) => d.gender === current.gender && d.activeUntil === null).sort((a, b) => a.order - b.order);
  const index = sameGender.findIndex((d) => d.id === current.id);
  return {
    up: index >= 0 && index < sameGender.length - 1 ? sameGender[index + 1] : null,
    down: index > 0 ? sameGender[index - 1] : null,
  };
}

/** Everything the player needs before committing, with no hidden ratings revealed. */
export function evaluateOption(save: SaveGame, fighter: Fighter, target: DivisionConfig): DivisionOption {
  const current = DIVISION_BY_ID[fighter.divisionId];
  const direction: 'up' | 'down' = target.order > current.order ? 'up' : 'down';
  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 28;
  const healthy = healthyCutFor(fighter, age);
  const cutToTarget = Math.max(0, fighter.walkingWeightLb - target.limitLb);
  const ratio = cutToTarget / Math.max(6, healthy);

  const table = save.rankings[target.id];
  const champion = table?.championId ? save.fighters[table.championId] : null;
  const opponents = (table?.entries ?? [])
    .slice(0, 5)
    .map((e) => save.fighters[e.fighterId]?.name)
    .filter((n): n is string => Boolean(n));

  const benefits: string[] = [];
  const costs: string[] = [];
  if (direction === 'up') {
    benefits.push('The weight cut becomes far easier.');
    benefits.push('Better recovery between camps and less strain on fight week.');
    benefits.push('A missed weight becomes very unlikely.');
    benefits.push('A fresh set of matchups and a new ranking path.');
    costs.push('You give up size and raw strength against the division.');
    costs.push('Takedowns and control exchanges get harder.');
    costs.push('Your ranking resets and the road to a title gets longer.');
  } else {
    benefits.push('You become one of the bigger fighters in the division.');
    benefits.push('Strength and control exchanges swing your way.');
    benefits.push('A new ranking path against smaller opposition.');
    costs.push('The cut becomes substantially harder.');
    costs.push('Higher chance of missing weight and of arriving depleted.');
    costs.push('More strain on the body and a more expensive camp.');
    if (fighter.weightMisses > 0) costs.push('You have missed weight before, which the commission will note.');
  }

  const relationship = fighter.relationships.matchmaker;
  const promotionLikelihood = clamp(
    45 + relationship * 0.3 + (fighter.popularity - 40) * 0.4 - (direction === 'down' ? ratio * 25 : 0) - fighter.weightMisses * 8,
    5,
    95
  );

  return {
    division: target,
    direction,
    weightDifficulty:
      direction === 'up'
        ? 'Comfortable. You would be walking around close to the limit.'
        : ratio < 0.8
          ? 'Demanding but realistic with a full camp.'
          : ratio < 1.0
            ? 'Hard. Expect to feel it on the day.'
            : 'Not realistic on your current frame.',
    speedEffect: direction === 'up' ? 'You should feel sharper, carrying less depletion into the cage.' : 'Little change, though a harder cut can dull the first round.',
    strengthEffect: direction === 'up' ? 'You give up strength against naturally bigger opponents.' : 'You would be noticeably the stronger fighter in most matchups.',
    cardioEffect: direction === 'up' ? 'Better. A gentler cut leaves more in the tank.' : 'Worse. A deeper cut costs you late in fights.',
    durabilityEffect: direction === 'up' ? 'You take heavier shots from bigger opponents.' : 'You absorb less, and rehydrate into a size advantage.',
    adaptationPeriod: direction === 'up' ? 'Two or three fights to settle into the size.' : 'One or two camps to learn the cut.',
    rankingConsequence: fighter.isChampion
      ? 'You would have to decide what happens to your title.'
      : fighter.ranking !== null
        ? `You leave your number ${fighter.ranking} ranking behind and start unranked.`
        : 'You start unranked, as you are now.',
    titleConsequence: fighter.isChampion
      ? 'The promotion will not let you sit on two belts indefinitely.'
      : `${champion ? `${champion.name} holds the title there.` : 'The title there is vacant.'}`,
    contractConsequence: 'Your contract follows you. A weight class clause may need renegotiating.',
    healthRisk: direction === 'up' ? 'Lower than where you are now.' : ratio > 0.95 ? 'High. The team will object.' : 'Moderate, with proper support.',
    championName: champion?.name ?? null,
    likelyOpponents: opponents,
    benefits,
    costs,
    promotionLikelihood,
  };
}

export function planStore(save: SaveGame): Record<FighterId, WeightClassPlan> {
  if (!save.weightClassPlans) save.weightClassPlans = {};
  return save.weightClassPlans;
}

export function currentPlan(save: SaveGame, fighterId: FighterId): WeightClassPlan | null {
  return planStore(save)[fighterId] ?? null;
}

/** Opinions from the people around the fighter. They can disagree with each other. */
export function gatherOpinions(save: SaveGame, fighter: Fighter, target: DivisionConfig): { manager: string; coach: string } {
  const option = evaluateOption(save, fighter, target);
  const manager = managerFor(save, fighter.id);
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;

  const managerLine = manager
    ? option.direction === 'up'
      ? manager.aggressiveness > 60
        ? `${manager.name} thinks it is a step back and would rather chase a title where you are.`
        : `${manager.name} supports it. Fewer bad weight cuts means more fights and more money.`
      : option.promotionLikelihood < 40
        ? `${manager.name} warns that the promotion will resist this and it could stall your career.`
        : `${manager.name} sees the size advantage and thinks it is worth the harder cut.`
    : 'You have no manager to advise you.';

  const coachLine = gym
    ? option.direction === 'up'
      ? 'Your head coach is in favour. The camps have been brutal and they can see the cost.'
      : option.weightDifficulty.startsWith('Not realistic')
        ? 'Your head coach is firmly against it. They do not believe you can make the weight safely.'
        : 'Your head coach is cautious but willing, provided nutrition support comes with it.'
    : 'You have no gym staff to consult.';

  return { manager: managerLine, coach: coachLine };
}

/** Starts exploring a move. Nothing is committed yet. */
export function explore(save: SaveGame, fighter: Fighter, target: DivisionConfig): WeightClassPlan {
  const opinions = gatherOpinions(save, fighter, target);
  const plan: WeightClassPlan = {
    fromDivisionId: fighter.divisionId,
    toDivisionId: target.id,
    direction: target.order > DIVISION_BY_ID[fighter.divisionId].order ? 'up' : 'down',
    status: 'exploring',
    announcedPublicly: false,
    startedOn: save.date,
    decidedOn: null,
    managerOpinion: opinions.manager,
    coachOpinion: opinions.coach,
    promotionResponse: null,
    note: 'Nothing is committed. You can cancel this at any time.',
  };
  planStore(save)[fighter.id] = plan;
  return plan;
}

/** Asks the promotion. They can refuse, especially for a move down. */
export function requestApproval(save: SaveGame, fighter: Fighter, rng: Rng): WeightClassPlan | null {
  const plan = currentPlan(save, fighter.id);
  if (!plan || (plan.status !== 'exploring' && plan.status !== 'refused')) return plan;
  const target = DIVISION_BY_ID[plan.toDivisionId];
  const option = evaluateOption(save, fighter, target);
  plan.status = 'requested';
  const approved = rng.chance(option.promotionLikelihood / 100);
  plan.decidedOn = save.date;
  if (approved) {
    plan.status = 'approved';
    plan.promotionResponse = `The promotion is happy for you to move to ${target.name}. They will build the debut around it.`;
  } else {
    plan.status = 'refused';
    plan.promotionResponse =
      plan.direction === 'down'
        ? `The promotion will not sanction the move to ${target.name}. They are not convinced you can make the weight.`
        : `The promotion would rather you stayed at ${DIVISION_BY_ID[plan.fromDivisionId].name} for now.`;
  }
  addInboxMessage(save, {
    sender: 'matchmaker',
    senderName: PROMOTION_MATCHMAKING,
    subject: approved ? `Approved: move to ${target.name}` : `Declined: move to ${target.name}`,
    body: plan.promotionResponse,
    category: 'career',
    requiresAction: false,
    deadline: null,
    choices: [],
    linkedFighterId: fighter.id,
  });
  return plan;
}

export interface MoveOutcome {
  moved: boolean;
  message: string;
  vacatedTitle: boolean;
  newDivision: DivisionId | null;
}

/**
 * Commits the move.
 *
 * Rankings, eligibility and title consequences are all applied here, and the historical
 * ranking record is left intact.
 */
export function commitMove(save: SaveGame, fighter: Fighter, announce: boolean): MoveOutcome {
  const plan = currentPlan(save, fighter.id);
  if (!plan) return { moved: false, message: 'There is no weight class plan to commit.', vacatedTitle: false, newDivision: null };
  if (plan.status !== 'approved') {
    return { moved: false, message: 'The promotion has not approved this move yet.', vacatedTitle: false, newDivision: null };
  }
  if (hasLiveBooking(save, fighter)) {
    return { moved: false, message: 'You cannot change division with a fight already booked.', vacatedTitle: false, newDivision: null };
  }

  const from = DIVISION_BY_ID[plan.fromDivisionId];
  const to = DIVISION_BY_ID[plan.toDivisionId];
  let vacated = false;

  // Leaving the old division. The historical record of the ranking stays in history.
  const oldTable = save.rankings[from.id];
  if (oldTable) {
    oldTable.entries = oldTable.entries.filter((e) => e.fighterId !== fighter.id);
    if (oldTable.championId === fighter.id) {
      // A champion who moves does not keep the old belt indefinitely.
      oldTable.championId = null;
      fighter.isChampion = false;
      vacated = true;
      const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim);
      if (reign) {
        reign.lostOn = save.date;
        reign.endReason = 'vacated';
      }
    }
    if (oldTable.interimChampionId === fighter.id) {
      oldTable.interimChampionId = null;
      fighter.isInterimChampion = false;
    }
  }

  fighter.divisionId = to.id;
  fighter.ranking = null;
  fighter.previousRanking = null;
  fighter.weeksRanked = 0;
  if (!fighter.eligibleDivisions.includes(to.id)) fighter.eligibleDivisions.push(to.id);
  // Walking weight moves toward the new division over the following weeks. The weekly
  // weight management pass does the rest.
  fighter.walkingWeightLb = to.limitLb + Math.min(to.typicalWalkAroundOverLb, fighter.walkingWeightLb - from.limitLb);
  fighter.weightMisses = 0;

  plan.status = 'completed';
  plan.decidedOn = save.date;
  plan.announcedPublicly = announce;

  addInboxMessage(save, {
    sender: 'matchmaker',
    senderName: PROMOTION_MATCHMAKING,
    subject: `You are now a ${to.name}`,
    body: `The move from ${from.name} is official. You start unranked and the matchmaker will look for a debut opponent.${
      vacated ? ' The title you held has been vacated.' : ''
    }${announce ? ' The move has been announced publicly.' : ' The move has not been announced yet.'}`,
    category: 'career',
    requiresAction: false,
    deadline: null,
    choices: [],
    linkedFighterId: fighter.id,
  });

  return {
    moved: true,
    message: `You have moved to ${to.name}.${vacated ? ' Your title has been vacated.' : ''}`,
    vacatedTitle: vacated,
    newDivision: to.id,
  };
}

export function cancelPlan(save: SaveGame, fighterId: FighterId): boolean {
  const plan = currentPlan(save, fighterId);
  if (!plan || plan.status === 'completed') return false;
  plan.status = 'canceled';
  plan.decidedOn = save.date;
  return true;
}

/** Occasionally the team raises the subject themselves, so the system is discoverable. */
export function maybeSuggestMove(save: SaveGame, fighter: Fighter, rng: Rng): string | null {
  if (currentPlan(save, fighter.id)) return null;
  if (hasLiveBooking(save, fighter)) return null;
  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 28;
  const healthy = healthyCutFor(fighter, age);
  const current = DIVISION_BY_ID[fighter.divisionId];
  const cut = Math.max(0, fighter.walkingWeightLb - current.limitLb);
  const struggling = cut / Math.max(6, healthy) > 0.9 || fighter.weightMisses >= 1;
  const { up } = adjacentDivisions(fighter);
  if (!struggling || !up) return null;
  if (!rng.chance(0.12)) return null;

  addInboxMessage(save, {
    sender: 'head-coach',
    senderName: 'Head coach',
    subject: `Should you be fighting at ${up.name}?`,
    body: `The cut has been getting harder. ${
      fighter.weightMisses > 0 ? 'You have already missed weight once. ' : ''
    }The team thinks it is worth at least looking at ${up.name}. Nothing has to be decided today.`,
    category: 'career',
    requiresAction: false,
    deadline: addDays(save.date, 60),
    choices: [],
    linkedFighterId: fighter.id,
  });
  return `Your coach has raised the idea of moving up to ${up.name}.`;
}
