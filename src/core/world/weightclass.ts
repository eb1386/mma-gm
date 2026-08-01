import { DIVISIONS, DIVISION_BY_ID, type DivisionConfig, type DivisionId } from '../config/divisions';
import { clamp, Rng } from '../rng';
import { addDays, ageOn, type FighterId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete, healthyCutFor } from './health';
import { hasLiveBooking } from './availability';
import { managerFor } from './finance';
import { addInboxMessage } from './inbox';
import { resolveMessagesForOffer } from './inbox';
import { PROMOTION_MATCHMAKING } from '../config/branding';
import { assessTitleOpportunity } from './title-logic';
import { existingTitleBout, interimTitleJustification, rankChallengers, type InterimReason } from './title-eligibility';
import { evaluateInterest, matchupInterestsFor, recordMatchupInterest } from './matchup-interest';
import { forfeitContenderStatus, grantContenderStatus } from './contender';
import { rankingLedger } from './rankings';

/**
 * Moving up or down a division.
 *
 * The projections shown to the player are descriptive rather than numeric, because the
 * game does not otherwise expose exact ratings. Everything here is about what a move costs
 * and what it buys, not about revealing hidden values.
 */

/**
 * What kind of move this is.
 *
 * A permanent move changes the fighter's division outright. A one fight move is a visit that
 * reverts afterwards. A double championship attempt keeps the original belt while the new one
 * is contested, which the promotion only tolerates for a limited time.
 */
export type MoveKind = 'permanent' | 'one-fight' | 'double-champion' | 'return';

export const MOVE_KIND_LABEL: Record<MoveKind, string> = {
  permanent: 'Permanent move',
  'one-fight': 'One fight at the new weight',
  'double-champion': 'Attempt to hold both championships',
  return: 'Return to a former division',
};

/** What happens to a championship the fighter currently holds. */
export type TitleDecision = 'vacate-now' | 'keep-temporarily' | 'defend-both' | 'not-applicable';

export const TITLE_DECISION_LABEL: Record<TitleDecision, string> = {
  'vacate-now': 'Vacate the championship immediately',
  'keep-temporarily': 'Keep the championship while the move plays out',
  'defend-both': 'Try to hold both championships',
  'not-applicable': 'No championship to decide',
};

export interface WeightClassPlan {
  fromDivisionId: DivisionId;
  toDivisionId: DivisionId;
  direction: 'up' | 'down';
  kind: MoveKind;
  titleDecision: TitleDecision;
  status: 'exploring' | 'requested' | 'approved' | 'refused' | 'committed' | 'completed' | 'canceled';
  announcedPublicly: boolean;
  startedOn: IsoDate;
  decidedOn: IsoDate | null;
  managerOpinion: string | null;
  coachOpinion: string | null;
  promotionResponse: string | null;
  /** The championship path the promotion offered when a champion moves. */
  championPath: ChampionMovePath | null;
  championPathExplanation: string | null;
  note: string;
}

/**
 * One spell in a division.
 *
 * A fighter who moves up and later returns has two spells at the original weight, and the
 * record of the first is not overwritten by the second.
 */
export interface DivisionSpell {
  divisionId: DivisionId;
  startedOn: IsoDate;
  endedOn: IsoDate | null;
  fights: number;
  wins: number;
  bestRanking: number | null;
  heldTitle: boolean;
  titleDefenses: number;
  endReason: 'moved-up' | 'moved-down' | 'returned' | null;
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

// ---------------------------------------------------------------------------
// Champions moving divisions
// ---------------------------------------------------------------------------

/**
 * The six ways a champion's move can be resolved.
 *
 * The promotion picks one rather than defaulting to whichever the scheduler finds easiest,
 * and the choice is explained to the player.
 */
export type ChampionMovePath =
  | 'champion-versus-champion'
  | 'interim-title'
  | 'title-eliminator'
  | 'debut-fight-first'
  | 'vacate-and-enter'
  | 'double-champion';

export const CHAMPION_PATH_LABEL: Record<ChampionMovePath, string> = {
  'champion-versus-champion': 'Champion against champion for the championship',
  'interim-title': 'Interim championship bout',
  'title-eliminator': 'Number one contender bout',
  'debut-fight-first': 'One divisional debut fight first',
  'vacate-and-enter': 'Vacate and enter the division',
  'double-champion': 'Attempt to hold both championships',
};

export interface ChampionMoveAssessment {
  path: ChampionMovePath;
  explanation: string;
  /** The opponent the promotion has in mind, when one is identifiable. */
  opponentId: FighterId | null;
  opponentName: string | null;
  /** True when the destination championship would be on the line. */
  championshipOnTheLine: boolean;
  interimReason: InterimReason | null;
  cautions: string[];
}

/**
 * Decides which championship path a moving champion gets.
 *
 * The order matters. A direct championship unification against the destination champion is
 * the best outcome for everyone and is checked first; an interim belt is only reached when
 * the destination champion is genuinely unavailable, never because scheduling failed.
 */
export function assessChampionMove(save: SaveGame, fighter: Fighter, targetDivisionId: DivisionId): ChampionMoveAssessment {
  const cautions: string[] = [];
  const target = DIVISION_BY_ID[targetDivisionId];
  const table = save.rankings[targetDivisionId];
  const destChampion = table?.championId ? save.fighters[table.championId] : null;
  const isChampion = fighter.isChampion || save.rankings[fighter.divisionId]?.championId === fighter.id;
  const leverage = assessTitleOpportunity(save, fighter, targetDivisionId, {
    direction: DIVISION_BY_ID[fighter.divisionId].order < target.order ? 'up' : 'down',
  });

  // A vacant destination title. The moving champion goes straight into the title bout.
  if (!destChampion) {
    const contenders = rankChallengers(save, targetDivisionId, (f) => f.id !== fighter.id, { vacant: true });
    const top = contenders[0];
    return {
      path: 'champion-versus-champion',
      explanation: `The ${target.name} championship is vacant. As a reigning champion moving up, you go straight into the bout for the vacant title${top ? ` against ${top.fighter.name}` : ''}.`,
      opponentId: top?.fighter.id ?? null,
      opponentName: top?.fighter.name ?? null,
      championshipOnTheLine: true,
      interimReason: null,
      cautions,
    };
  }

  const destAvailable = canCompete(destChampion, save.date).ok && !destChampion.nextBoutId && !destChampion.retired;
  const bothPopular = fighter.popularity + destChampion.popularity >= 90;
  const titleObligation = existingTitleBout(save, targetDivisionId);

  if (isChampion && destAvailable && !titleObligation && bothPopular) {
    return {
      path: 'champion-versus-champion',
      explanation: `${destChampion.name} is active and available, and champion against champion is the fight the division wants. The ${target.name} championship is on the line.`,
      opponentId: destChampion.id,
      opponentName: destChampion.name,
      championshipOnTheLine: true,
      interimReason: null,
      cautions,
    };
  }

  // The destination champion is unavailable. An interim belt is only justified for a stated
  // reason, and the reason comes from the shared gate rather than from this function.
  const interim = interimTitleJustification(save, targetDivisionId);
  if (isChampion && interim.justified) {
    const contenders = rankChallengers(save, targetDivisionId, (f) => f.id !== fighter.id, { interim: true });
    const top = contenders[0];
    return {
      path: 'interim-title',
      explanation: `${interim.explanation} You would face ${top?.fighter.name ?? 'the leading available contender'} for the interim championship, and a unification bout with ${destChampion.name} becomes the priority once they return.`,
      opponentId: top?.fighter.id ?? null,
      opponentName: top?.fighter.name ?? null,
      championshipOnTheLine: true,
      interimReason: interim.reason,
      cautions,
    };
  }

  if (!destAvailable && !interim.justified) {
    cautions.push(`${destChampion.name} is not available right now, but not for long enough to justify an interim championship.`);
  }
  if (titleObligation) {
    cautions.push(`The ${target.name} championship is already booked, so it cannot be contested again until that fight happens.`);
  }

  // Strong enough for a contender bout, but the belt is not available to contest.
  if (leverage.score >= 62) {
    const contenders = rankChallengers(save, targetDivisionId, (f) => f.id !== fighter.id && f.id !== destChampion.id);
    const top = contenders[0];
    return {
      path: 'title-eliminator',
      explanation: `A direct championship bout is not available, so the promotion offers a number one contender bout${top ? ` against ${top.fighter.name}` : ''}. Win it and you are next.`,
      opponentId: top?.fighter.id ?? null,
      opponentName: top?.fighter.name ?? null,
      championshipOnTheLine: false,
      interimReason: null,
      cautions,
    };
  }

  return {
    path: 'debut-fight-first',
    explanation: `The promotion wants to see you at ${target.name} once before putting a championship on the line. One divisional debut fight, then the title picture opens up.`,
    opponentId: null,
    opponentName: null,
    championshipOnTheLine: false,
    interimReason: null,
    cautions,
  };
}

// ---------------------------------------------------------------------------
// Division history
// ---------------------------------------------------------------------------

export function divisionHistoryStore(save: SaveGame): Record<FighterId, DivisionSpell[]> {
  if (!save.divisionHistory) save.divisionHistory = {};
  return save.divisionHistory;
}

export function divisionHistoryFor(save: SaveGame, fighterId: FighterId): DivisionSpell[] {
  return divisionHistoryStore(save)[fighterId] ?? [];
}

/** Ensures the fighter has an open spell in their current division. */
export function ensureDivisionSpell(save: SaveGame, fighter: Fighter): DivisionSpell {
  const store = divisionHistoryStore(save);
  const spells = store[fighter.id] ?? [];
  const open = spells.find((s) => s.endedOn === null);
  if (open && open.divisionId === fighter.divisionId) return open;
  if (open) open.endedOn = save.date;
  const spell: DivisionSpell = {
    divisionId: fighter.divisionId,
    startedOn: fighter.lastFightDate ?? save.date,
    endedOn: null,
    fights: 0,
    wins: 0,
    bestRanking: fighter.ranking,
    heldTitle: fighter.isChampion,
    titleDefenses: 0,
    endReason: null,
  };
  spells.push(spell);
  store[fighter.id] = spells;
  return spell;
}

/**
 * Returns a fighter who moved for a single bout to the division they came from.
 *
 * The move kind exists, is offered, and is labelled "One fight at the new weight". Nothing ever
 * moved anybody back, so it was a permanent division change with a different label on it, which
 * is the one thing the player was choosing between.
 */
export function settleOneFightMoves(save: SaveGame): string[] {
  const notes: string[] = [];
  for (const [fighterId, plan] of Object.entries(planStore(save))) {
    // `commitMove` records a committed move as completed, so that is the state to look for. The
    // guard used to test for a status no code ever writes, which made this whole function
    // unreachable and left the one fight move exactly as permanent as it had been.
    if (plan.kind !== 'one-fight' || plan.status !== 'completed') continue;
    const fighter = save.fighters[fighterId];
    if (!fighter || fighter.retired) continue;
    if (fighter.divisionId !== plan.toDivisionId) continue;
    // Wait until the one fight has actually happened, and until nothing else is booked.
    const spell = divisionHistoryStore(save)[fighterId]?.find((sp) => sp.endedOn === null);
    if (!spell || spell.divisionId !== plan.toDivisionId || spell.fights < 1) continue;
    const booked = fighter.nextBoutId ? save.bouts[fighter.nextBoutId] : null;
    if (booked && booked.status === 'scheduled') continue;
    // A fighter who won a belt up there is not going anywhere. The move stopped being a visit.
    if (fighter.isChampion || fighter.isInterimChampion) {
      plan.kind = 'permanent';
      plan.status = 'completed';
      notes.push(`${fighter.name} stays at ${DIVISION_BY_ID[plan.toDivisionId].name} with the title.`);
      continue;
    }

    const home = DIVISION_BY_ID[plan.fromDivisionId];
    fighter.divisionId = home.id;
    fighter.ranking = null;
    fighter.previousRanking = null;
    fighter.weeksRanked = 0;
    fighter.weightMisses = 0;
    fighter.walkingWeightLb = home.limitLb + Math.min(home.typicalWalkAroundOverLb, Math.max(2, fighter.walkingWeightLb - DIVISION_BY_ID[plan.toDivisionId].limitLb));
    if (!fighter.eligibleDivisions.includes(home.id)) fighter.eligibleDivisions.push(home.id);
    ensureDivisionSpell(save, fighter);
    // The plan has become a return, which is also what stops this from running again.
    plan.kind = 'return';
    plan.fromDivisionId = DIVISION_BY_ID[plan.toDivisionId].id;
    plan.toDivisionId = home.id;
    plan.status = 'completed';
    notes.push(`${fighter.name} returns to ${home.name} after the one off at ${DIVISION_BY_ID[plan.fromDivisionId].name}.`);
  }
  return notes;
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
export function explore(
  save: SaveGame,
  fighter: Fighter,
  target: DivisionConfig,
  kind: MoveKind = 'permanent',
  titleDecision: TitleDecision = 'vacate-now'
): WeightClassPlan {
  const opinions = gatherOpinions(save, fighter, target);
  const isChampion = save.rankings[fighter.divisionId]?.championId === fighter.id;
  const assessment = isChampion ? assessChampionMove(save, fighter, target.id) : null;
  const plan: WeightClassPlan = {
    fromDivisionId: fighter.divisionId,
    toDivisionId: target.id,
    direction: target.order > DIVISION_BY_ID[fighter.divisionId].order ? 'up' : 'down',
    kind,
    titleDecision: isChampion ? titleDecision : 'not-applicable',
    championPath: assessment?.path ?? null,
    championPathExplanation: assessment?.explanation ?? null,
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
  /** Old division offers that were withdrawn because they no longer apply. */
  withdrawnOffers: number;
  /** The championship path when a champion moved. */
  championPath: ChampionMovePath | null;
  championPathExplanation: string | null;
}

/**
 * Commits the move.
 *
 * Rankings, eligibility and title consequences are all applied here, and the historical
 * ranking record is left intact.
 */
export function commitMove(save: SaveGame, fighter: Fighter, announce: boolean): MoveOutcome {
  const refuse = (message: string): MoveOutcome => ({
    moved: false,
    message,
    vacatedTitle: false,
    newDivision: null,
    withdrawnOffers: 0,
    championPath: null,
    championPathExplanation: null,
  });
  const plan = currentPlan(save, fighter.id);
  if (!plan) return refuse('There is no weight class plan to commit.');
  if (plan.status !== 'approved') return refuse('The promotion has not approved this move yet.');
  if (hasLiveBooking(save, fighter)) return refuse('You cannot change division with a fight already booked.');

  const from = DIVISION_BY_ID[plan.fromDivisionId];
  const to = DIVISION_BY_ID[plan.toDivisionId];
  const wasChampion = save.rankings[from.id]?.championId === fighter.id;
  const titleDecision: TitleDecision = wasChampion ? plan.titleDecision : 'not-applicable';

  // The championship path is decided before the move so the explanation reflects the world
  // the player was shown, not the world after they have already left the division.
  const championAssessment = wasChampion ? assessChampionMove(save, fighter, to.id) : null;

  let vacated = false;

  // Close the outgoing spell before the division changes, so the record of what was achieved
  // at the old weight survives the move intact.
  const spell = ensureDivisionSpell(save, fighter);
  spell.endedOn = save.date;
  spell.endReason = plan.kind === 'return' ? 'returned' : to.order > from.order ? 'moved-up' : 'moved-down';
  spell.heldTitle = spell.heldTitle || wasChampion;
  spell.bestRanking =
    spell.bestRanking === null ? fighter.ranking : fighter.ranking === null ? spell.bestRanking : Math.min(spell.bestRanking, fighter.ranking);

  // Leaving the old division. The historical record of the ranking stays in history.
  const oldTable = save.rankings[from.id];
  if (oldTable) {
    oldTable.entries = oldTable.entries.filter((e) => e.fighterId !== fighter.id);
    if (oldTable.championId === fighter.id) {
      if (titleDecision === 'keep-temporarily' || titleDecision === 'defend-both') {
        // The belt stays with them for now. The weekly pass strips it if they never come
        // back to defend, which is what stops a champion from vanishing while still champion.
        fighter.heldTitleDivisionId = from.id;
        fighter.titleHoldDeadline = addDays(save.date, titleDecision === 'defend-both' ? 400 : 270);
      } else {
        oldTable.championId = null;
        fighter.isChampion = false;
        vacated = true;
        const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim);
        if (reign) {
          reign.lostOn = save.date;
          reign.endReason = 'vacated';
        }
      }
    }
    if (oldTable.interimChampionId === fighter.id) {
      oldTable.interimChampionId = null;
      fighter.isInterimChampion = false;
    }
  }

  // A contender position belongs to the division it was earned in.
  forfeitContenderStatus(save, from.id, `${fighter.name} moved to ${to.name}.`, fighter.id);

  // The points earned at the old weight stay with the old division and do not follow the fighter.
  // Leaving a stale total in the new division's ledger would have let a returning fighter re-enter
  // the rankings on results from a different phase of their career.
  const arrivingLedger = rankingLedger(save, to.id);
  delete arrivingLedger[fighter.id];

  fighter.divisionId = to.id;
  fighter.ranking = null;
  fighter.previousRanking = null;
  fighter.weeksRanked = 0;
  // The active division is the only one that generates ordinary offers. The old division
  // stays on the record as somewhere the fighter has competed, which is what makes a return
  // possible later, but it no longer produces matchups.
  if (!fighter.eligibleDivisions.includes(to.id)) fighter.eligibleDivisions.push(to.id);
  if (plan.kind === 'permanent' || plan.kind === 'return') {
    fighter.eligibleDivisions = fighter.eligibleDivisions.filter((d) => d === to.id || d === fighter.heldTitleDivisionId);
    if (!fighter.eligibleDivisions.includes(to.id)) fighter.eligibleDivisions.push(to.id);
  }
  // Walking weight moves toward the new division over the following weeks. The weekly
  // weight management pass does the rest.
  fighter.walkingWeightLb = to.limitLb + Math.min(to.typicalWalkAroundOverLb, fighter.walkingWeightLb - from.limitLb);
  fighter.weightMisses = 0;

  // Open the new spell.
  const nextSpell = ensureDivisionSpell(save, fighter);
  nextSpell.startedOn = save.date;

  // Every open offer that belonged to the old division is withdrawn. Leaving these live is
  // what made a move feel cosmetic: the player changed weight and kept being offered fights
  // at the weight they had just left.
  const withdrawnOffers = withdrawOffersOutsideDivision(save, fighter, to.id);

  // Any live matchup interest against somebody in the old division is put on hold with a
  // stated reason rather than silently deleted.
  for (const interest of matchupInterestsFor(save, fighter.id)) {
    if (interest.eligibility === 'fulfilled' || interest.eligibility === 'rejected') continue;
    evaluateInterest(save, interest);
  }

  plan.status = 'completed';
  plan.decidedOn = save.date;
  plan.announcedPublicly = announce;
  plan.championPath = championAssessment?.path ?? null;
  plan.championPathExplanation = championAssessment?.explanation ?? null;

  // The debut is seeded as a real matchmaking candidate. Without it a moved fighter would sit
  // in the unranked pool waiting to be noticed, which is exactly what made a division change
  // look like nothing had happened.
  if (championAssessment && championAssessment.championshipOnTheLine) {
    // The promised championship bout is granted as a real, earned contender position in the new
    // division. The weekly title pass then books it through the single eligibility gate, so the
    // explanation the player was shown and the fight they actually get are the same thing.
    const grant = grantContenderStatus(save, fighter, to.id, 'division-move', null);
    if (!grant.granted) {
      // The gate refused, so the player is told rather than being left with a promise that
      // quietly evaporated.
      addInboxMessage(save, {
        sender: 'matchmaker',
        senderName: PROMOTION_MATCHMAKING,
        subject: `Your ${to.name} debut`,
        body: `${grant.message} The matchmaker will build a divisional debut instead.`,
        category: 'career',
        requiresAction: false,
        deadline: null,
        choices: [],
        linkedFighterId: fighter.id,
      });
    }
  }

  const wantsEliminator = championAssessment?.path === 'title-eliminator';
  const debutOpponentId = championAssessment?.opponentId ?? pickDebutOpponent(save, fighter, to.id);
  if (debutOpponentId && !(championAssessment?.championshipOnTheLine ?? false)) {
    recordMatchupInterest(save, {
      source: wantsEliminator ? 'title-claim' : 'division-debut',
      caller: fighter,
      target: save.fighters[debutOpponentId],
      requestedConditions: `A ${to.name} debut.`,
      opponentResponse: null,
      fanResponse: null,
      promotionResponse: championAssessment?.explanation ?? `The matchmaker is building your ${to.name} debut.`,
      interestScore: championAssessment ? 85 : 70,
      lifespanDays: 220,
    });
  }

  const titleLine = !wasChampion
    ? ''
    : titleDecision === 'vacate-now'
      ? ` You have vacated the ${from.name} championship.`
      : titleDecision === 'defend-both'
        ? ` You keep the ${from.name} championship while you attempt to hold both. The promotion will not allow that indefinitely.`
        : ` You keep the ${from.name} championship for now, but the promotion expects a defense or a decision.`;

  addInboxMessage(save, {
    sender: 'matchmaker',
    senderName: PROMOTION_MATCHMAKING,
    subject: `You are now a ${to.name}`,
    body: `The move from ${from.name} is official. You start unranked at ${to.name} and every future offer will be at ${to.limitLb} lb.${titleLine}${
      championAssessment ? ` ${championAssessment.explanation}` : ''
    }${withdrawnOffers > 0 ? ` ${withdrawnOffers} open ${from.name} offer${withdrawnOffers === 1 ? ' has' : 's have'} been withdrawn because the weight no longer applies.` : ''}${
      announce ? ' The move has been announced publicly.' : ' The move has not been announced yet.'
    }`,
    category: 'career',
    requiresAction: false,
    deadline: null,
    choices: [],
    linkedFighterId: fighter.id,
  });

  return {
    moved: true,
    message: `You have moved to ${to.name}.${titleLine}`,
    vacatedTitle: vacated,
    newDivision: to.id,
    withdrawnOffers,
    championPath: championAssessment?.path ?? null,
    championPathExplanation: championAssessment?.explanation ?? null,
  };
}

/**
 * Chooses a sensible debut opponent for a fighter arriving in a division.
 *
 * The standing the fighter brings with them decides how hard the first fight is. A decorated
 * former champion is not fed a preliminary opponent, and an unproven fighter is not handed a
 * top five contender on arrival.
 */
export function pickDebutOpponent(save: SaveGame, fighter: Fighter, divisionId: DivisionId): FighterId | null {
  const leverage = assessTitleOpportunity(save, fighter, divisionId, {
    direction: DIVISION_BY_ID[divisionId].order > DIVISION_BY_ID[fighter.divisionId].order ? 'up' : 'down',
  });
  // The band of rankings the promotion considers a fair debut.
  const band: [number, number] = leverage.score >= 62 ? [1, 6] : leverage.score >= 42 ? [4, 10] : leverage.score >= 22 ? [8, 15] : [11, 99];

  const table = save.rankings[divisionId];
  const candidates = Object.values(save.fighters).filter((f) => {
    if (f.id === fighter.id) return false;
    if (f.divisionId !== divisionId) return false;
    if (f.retired || f.activityStatus !== 'active') return false;
    if (f.nextBoutId) return false;
    if (!canCompete(f, save.date).ok) return false;
    if (table?.championId === f.id) return false;
    const rank = f.ranking ?? 99;
    return rank >= band[0] && rank <= band[1];
  });
  if (candidates.length === 0) return null;
  // The closest to the middle of the band, so the debut is neither a gift nor an ambush.
  const midpoint = (band[0] + Math.min(band[1], 20)) / 2;
  candidates.sort((a, b) => Math.abs((a.ranking ?? 99) - midpoint) - Math.abs((b.ranking ?? 99) - midpoint));
  return candidates[0].id;
}

/**
 * Withdraws every open offer for this fighter that is not at their current division.
 *
 * Returns how many were withdrawn so the move can report it rather than changing the inbox
 * silently.
 */
export function withdrawOffersOutsideDivision(save: SaveGame, fighter: Fighter, divisionId: DivisionId): number {
  let withdrawn = 0;
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    if (offer.fighterId !== fighter.id) continue;
    if (offer.divisionId === divisionId) continue;
    offer.status = 'withdrawn';
    resolveMessagesForOffer(save, offer.id, `Withdrawn: you have moved to ${DIVISION_BY_ID[divisionId].name}.`);
    withdrawn++;
  }
  return withdrawn;
}

/**
 * Strips a championship held by a fighter who left the division and never came back.
 *
 * Without this a champion who moves up can hold the old belt forever while never appearing in
 * that division again, which is the state the player would see as a division with a champion
 * who does not exist.
 */
export function enforceAbsentChampions(save: SaveGame): string[] {
  const notes: string[] = [];
  for (const fighter of Object.values(save.fighters)) {
    if (!fighter.heldTitleDivisionId || !fighter.titleHoldDeadline) continue;
    const held = fighter.heldTitleDivisionId as DivisionId;
    if (fighter.divisionId === held) {
      // They came back. The arrangement is over and the belt is simply theirs again.
      fighter.heldTitleDivisionId = null;
      fighter.titleHoldDeadline = null;
      continue;
    }
    if (save.date < fighter.titleHoldDeadline) continue;
    const table = save.rankings[held];
    if (table?.championId === fighter.id) {
      table.championId = null;
      fighter.isChampion = save.rankings[fighter.divisionId]?.championId === fighter.id;
      const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim && r.divisionId === held);
      if (reign) {
        reign.lostOn = save.date;
        reign.endReason = 'stripped';
      }
      notes.push(`${fighter.name} has been stripped of the ${DIVISION_BY_ID[held].name} championship after moving to ${DIVISION_BY_ID[fighter.divisionId].name} without defending it.`);
    }
    fighter.heldTitleDivisionId = null;
    fighter.titleHoldDeadline = null;
  }
  return notes;
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
