import { addDays, daysBetween, type BoutId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { activeCampFor, hasLiveBooking, openOffersFor } from './availability';
import { activeInjuries, canCompete } from './health';
import { actionableMessages } from './inbox';
import { FIGHT_WEEK_DAYS } from './availability';
import { pendingStages, stageLabel, type FightWeekStage } from './fightweek';
import type { AdvanceTarget } from './advance-target';

/**
 * The player career state machine.
 *
 * One function decides what state a career is in and what the next mandatory action is.
 * The interface reads it, the advance controller reads it, and the inbox badge reads it,
 * so the header, the page and the calendar can never disagree about whose turn it is.
 *
 * The state is derived from world facts rather than stored as the primary record, because
 * a stored state can drift out of step with the bouts and injuries it describes. It is
 * then written into the save so it can be inspected, migrated and shown in a save list.
 */

export type CareerState =
  | 'available'
  | 'offer-pending'
  | 'negotiating'
  | 'booked'
  | 'camp-planning'
  | 'camp-active'
  | 'injured-while-booked'
  | 'awaiting-medical-decision'
  | 'awaiting-promotion-response'
  | 'fight-week'
  | 'fight-ready'
  | 'fight-in-progress'
  | 'awaiting-result'
  | 'post-fight'
  | 'medical-suspension'
  | 'recovery'
  | 'contract-decision'
  | 'free-agent'
  | 'retired'
  | 'not-a-fighter';

export const CAREER_STATE_LABEL: Record<CareerState, string> = {
  available: 'Available',
  'offer-pending': 'Offer on the table',
  negotiating: 'Negotiating',
  booked: 'Booked',
  'camp-planning': 'Camp not planned',
  'camp-active': 'In camp',
  'injured-while-booked': 'Injured with a fight booked',
  'awaiting-medical-decision': 'Awaiting a medical decision',
  'awaiting-promotion-response': 'Awaiting the promotion',
  'fight-week': 'Fight week',
  'fight-ready': 'Ready to fight',
  'fight-in-progress': 'Fight in progress',
  'awaiting-result': 'Awaiting the official result',
  'post-fight': 'Post fight obligations',
  'medical-suspension': 'Medically suspended',
  recovery: 'Recovering',
  'contract-decision': 'Contract decision',
  'free-agent': 'Free agent',
  retired: 'Retired',
  'not-a-fighter': 'Not managing a fighter',
};

/** Which states forbid the calendar from moving at all until the player acts. */
const BLOCKING_STATES = new Set<CareerState>([
  'offer-pending',
  'injured-while-booked',
  'awaiting-medical-decision',
  'fight-ready',
  'fight-in-progress',
  'awaiting-result',
  'contract-decision',
]);

/**
 * What the primary button actually does.
 *
 * This is a discriminated union on purpose. The previous version carried only a label and
 * a route, so the header had to guess whether pressing it should navigate or advance time,
 * and it guessed from the route string. That is why Camp could say "Advance camp", point at
 * `/camp`, and do nothing at all when the player was already on `/camp`.
 */
export type CareerAction =
  | { kind: 'navigate'; label: string; route: string; detail: string; blocking: boolean; key: string }
  | { kind: 'advance-target'; label: string; target: AdvanceTarget; detail: string; blocking: boolean; key: string; route?: string }
  | { kind: 'advance-duration'; label: string; days: number; detail: string; blocking: boolean; key: string };

/** Where the action should land the player, when it has a destination. */
export function actionRoute(action: CareerAction | null): string | null {
  if (!action) return null;
  if (action.kind === 'navigate') return action.route;
  if (action.kind === 'advance-target') return action.route ?? null;
  return null;
}

export interface CareerStatus {
  state: CareerState;
  reason: string;
  action: CareerAction | null;
  boutId: BoutId | null;
  opponentName: string | null;
  eventName: string | null;
  eventDate: IsoDate | null;
  daysToFight: number | null;
  campId: string | null;
  campWeeksCompleted: number | null;
  campWeeksPlanned: number | null;
  injurySummary: string | null;
  expectedReturn: IsoDate | null;
  fightWeekStage: FightWeekStage | null;
  openDecisions: number;
  /** True when time cannot advance at all. */
  advanceBlocked: boolean;
  blockedReason: string | null;
}

const IDLE: CareerStatus = {
  state: 'not-a-fighter',
  reason: 'No fighter is being managed in this save.',
  action: null,
  boutId: null,
  opponentName: null,
  eventName: null,
  eventDate: null,
  daysToFight: null,
  campId: null,
  campWeeksCompleted: null,
  campWeeksPlanned: null,
  injurySummary: null,
  expectedReturn: null,
  fightWeekStage: null,
  openDecisions: 0,
  advanceBlocked: false,
  blockedReason: null,
};

/**
 * The authoritative read of where the player's career stands right now.
 *
 * Order of precedence matters: a fight in progress outranks an injury, an injury with a
 * booked fight outranks an unplanned camp, and so on down to plain availability.
 */
export function careerStatus(save: SaveGame): CareerStatus {
  const fighterId = save.player.fighterId;
  if (!fighterId) return IDLE;
  const me = save.fighters[fighterId];
  if (!me) return IDLE;

  // Only mandatory decisions block the calendar. Optional opportunities and passive
  // updates appear in the inbox but never stop a career from moving.
  const allActionable = actionableMessages(save);
  const decisions = allActionable.filter((m) => m.mandatory !== false);
  const bout = hasLiveBooking(save, me);
  const event = bout ? save.events[bout.eventId] : null;
  const opponent = bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;
  const daysToFight = bout ? daysBetween(save.date, bout.date) : null;
  const camp = activeCampFor(save, me.id);
  const campRecord = camp ? save.camps[camp.id] : null;
  const blocking = activeInjuries(me, save.date).filter((i) => i.blocksCompetition);
  const anyInjury = activeInjuries(me, save.date);

  const base = {
    boutId: bout?.id ?? null,
    opponentName: opponent?.name ?? null,
    eventName: event?.name ?? null,
    eventDate: bout?.date ?? null,
    daysToFight,
    campId: camp?.id ?? null,
    campWeeksCompleted: campRecord?.weeksCompleted ?? null,
    campWeeksPlanned: campRecord?.weeks ?? null,
    injurySummary: anyInjury.length > 0 ? anyInjury.map((i) => i.type).join(', ') : null,
    expectedReturn: anyInjury.length > 0 ? anyInjury.map((i) => i.expectedReturn).sort().pop()! : null,
    fightWeekStage: null as FightWeekStage | null,
    openDecisions: allActionable.length,
  };

  const finish = (
    state: CareerState,
    reason: string,
    action: CareerAction | null,
    extra: Partial<CareerStatus> = {}
  ): CareerStatus => {
    const blocked = BLOCKING_STATES.has(state) || (action?.blocking ?? false);
    return {
      ...base,
      ...extra,
      state,
      reason,
      action,
      advanceBlocked: blocked,
      blockedReason: blocked ? reason : null,
    };
  };

  if (me.retired) {
    return finish('retired', `${me.name} has retired from competition.`, null);
  }

  // A fight that has already happened but has no stored result should never happen; if it
  // does, surface it rather than letting the calendar walk past it.
  if (bout && daysToFight !== null && daysToFight <= 0) {
    return finish('fight-ready', `Fight day. ${me.name} faces ${opponent?.name ?? 'the opponent'} at ${event?.name ?? 'the event'}.`, {
      kind: 'navigate',
      label: 'Enter Fight',
      route: `/fight/${bout.id}`,
      detail: `${event?.name ?? 'The event'} is today.`,
      blocking: true,
      key: `fight-${bout.id}`,
    });
  }

  // An open decision that is specifically about an injury outranks everything except fight
  // day, because the booked fight cannot be planned around until it is answered.
  const injuryDecision = decisions.find((m) => m.category === 'injury' || m.category === 'medical');
  if (injuryDecision) {
    return finish(
      bout ? 'injured-while-booked' : 'awaiting-medical-decision',
      bout
        ? `${me.name} is hurt with ${opponent?.name ?? 'a fight'} booked for ${bout.date}. The promotion needs an answer.`
        : `${me.name} has a medical decision to make.`,
      {
        kind: 'navigate',
        label: 'Review Injury',
        route: `/inbox/${injuryDecision.id}`,
        detail: injuryDecision.subject,
        blocking: true,
        key: `injury-${injuryDecision.id}`,
      }
    );
  }

  const contractDecision = decisions.find((m) => m.category === 'contract');
  if (contractDecision) {
    return finish('contract-decision', 'A contract decision is waiting.', {
      kind: 'navigate',
      label: 'Answer Contract Offer',
      route: `/inbox/${contractDecision.id}`,
      detail: contractDecision.subject,
      blocking: true,
      key: `contract-${contractDecision.id}`,
    });
  }

  const offerDecision = decisions.find((m) => m.category === 'offer');
  if (offerDecision && !bout) {
    return finish('offer-pending', 'A fight offer is waiting for an answer.', {
      kind: 'navigate',
      label: 'Review Fight Offer',
      route: `/inbox/${offerDecision.id}`,
      detail: offerDecision.subject,
      blocking: true,
      key: `offer-${offerDecision.id}`,
    });
  }

  if (decisions.length > 0) {
    const first = decisions[0];
    return finish('available', `${decisions.length} item${decisions.length === 1 ? '' : 's'} need an answer.`, {
      kind: 'navigate',
      label: decisions.length === 1 ? 'Answer 1 Item' : `Answer ${decisions.length} Items`,
      route: `/inbox/${first.id}`,
      detail: first.subject,
      blocking: true,
      key: `inbox-${first.id}`,
    });
  }

  if (bout) {
    // Fight week owns the flow once it starts.
    if (daysToFight !== null && daysToFight <= FIGHT_WEEK_DAYS) {
      const stages = pendingStages(save, bout.id);
      // A mandatory stage that is due takes precedence over whatever happens to be first in the
      // list. Reading the blocking flag off stages[0] meant that when an optional stage such as
      // an open workout sat at the front, the calendar walked straight past a due weigh in.
      const mandatoryDue = stages.find((t) => t.mandatory && t.dueOn <= save.date) ?? null;
      const next = mandatoryDue ?? stages[0] ?? null;
      if (next) {
        return finish(
          'fight-week',
          `${stageLabel(next.stage)} is the next step before facing ${opponent?.name ?? 'the opponent'}.`,
          {
            kind: 'navigate',
            label: next.actionLabel,
            route: `/fightweek/${bout.id}`,
            detail: next.detail,
            blocking: Boolean(mandatoryDue),
            key: `stage-${bout.id}-${next.stage}`,
          },
          { fightWeekStage: next.stage }
        );
      }
      return finish('fight-week', `Fight week. ${daysToFight} day${daysToFight === 1 ? '' : 's'} until the bout.`, {
        kind: 'advance-target',
        label: 'Advance to Fight Night',
        target: { kind: 'fight-day', boutId: bout.id },
        route: `/fight/${bout.id}`,
        detail: `${event?.name ?? 'The event'} on ${bout.date}.`,
        blocking: false,
        key: `fightweek-${bout.id}`,
      });
    }

    if (blocking.length > 0) {
      return finish('injured-while-booked', `${me.name} cannot compete: ${blocking[0].type}. The booked fight is unresolved.`, {
        kind: 'navigate',
        label: 'Review Injury',
        route: '/camp',
        detail: `${blocking[0].type}, expected back ${blocking[0].expectedReturn}.`,
        blocking: true,
        key: `injury-block-${blocking[0].id}`,
      });
    }

    if (!camp) {
      return finish('camp-planning', `No camp is planned for ${opponent?.name ?? 'the fight'} on ${bout.date}.`, {
        kind: 'navigate',
        label: 'Plan Fight Camp',
        route: '/camp',
        detail: `${daysToFight} days until the bout.`,
        blocking: false,
        key: `camp-plan-${bout.id}`,
      });
    }

    // The camp action advances time to fight week. It used to be a navigate action
    // pointing at /camp, which did nothing at all once the player was already on /camp.
    return finish('camp-active', `In camp for ${opponent?.name ?? 'the fight'} on ${bout.date}.`, {
      kind: 'advance-target',
      label: 'Advance to Fight Week',
      target: { kind: 'fight-week', boutId: bout.id },
      route: `/fightweek/${bout.id}`,
      detail: `${campRecord?.weeksCompleted ?? 0} of ${campRecord?.weeks ?? 0} camp weeks done, ${daysToFight} days until the bout.`,
      blocking: false,
      key: `camp-${camp.id}`,
    });
  }

  if (me.medicalSuspension && me.medicalSuspension.until > save.date) {
    return finish('medical-suspension', `Medically suspended until ${me.medicalSuspension.until}: ${me.medicalSuspension.reason}.`, {
      kind: 'advance-target',
      label: 'Advance Until Recovered',
      target: { kind: 'recovery-clearance', fighterId: me.id },
      detail: `${daysBetween(save.date, me.medicalSuspension.until)} days remaining.`,
      blocking: false,
      key: 'medical-suspension',
    });
  }

  if (blocking.length > 0) {
    const back = blocking.map((i) => i.expectedReturn).sort().pop()!;
    return finish('recovery', `Recovering from ${blocking[0].type}. Expected back ${back}.`, {
      kind: 'advance-target',
      label: 'Advance Until Recovered',
      target: { kind: 'recovery-clearance', fighterId: me.id },
      detail: `${daysBetween(save.date, back)} days until expected clearance.`,
      blocking: false,
      key: `recovery-${blocking[0].id}`,
    });
  }

  const contract = me.contractId ? save.contracts[me.contractId] : null;
  if (!contract || contract.status !== 'active' || contract.fightsRemaining <= 0) {
    // Being out of contract is not a passive state. Every offer path refuses a fighter with
    // no active deal, so a player who does not notice this simply stops receiving fights with
    // no other symptom. The consequence is stated rather than implied.
    const pendingOffer = Object.values(save.contractOffers).some((o) => o.fighterId === me.id && o.status === 'open');
    return finish(
      'free-agent',
      pendingOffer
        ? `${me.name} is out of contract. No fights can be offered until a new deal is signed.`
        : `${me.name} is out of contract. No fights can be offered until the promotion sends a new deal.`,
      {
        kind: 'navigate',
        label: pendingOffer ? 'Sign a New Contract' : 'Review Contract Options',
        route: '/contract',
        detail: pendingOffer
          ? 'An offer is waiting. Until it is signed you cannot be matched, and a title shot cannot be offered.'
          : 'No active promotional contract, so the matchmaker cannot approach you. A new offer arrives within a month.',
        blocking: false,
        key: 'free-agent',
      }
    );
  }

  const open = openOffersFor(save, me.id);
  if (open.length > 0) {
    return finish('offer-pending', 'An offer is on the table.', {
      kind: 'navigate',
      label: 'Review Fight Offer',
      route: `/offer/${open[0]}`,
      detail: 'A matchup is waiting for an answer.',
      blocking: true,
      key: `offer-${open[0]}`,
    });
  }

  return finish('available', `${me.name} is healthy, under contract and waiting for a matchup.`, {
    kind: 'advance-target',
    label: 'Advance Until Next Offer',
    target: { kind: 'next-offer', fighterId: me.id },
    detail: 'Keep training until the matchmaker calls.',
    blocking: false,
    key: 'advance-next-offer',
  });
}

/** Writes the derived state into the save so it persists and can be shown in a save list. */
export function syncCareerState(save: SaveGame): CareerStatus {
  const status = careerStatus(save);
  save.careerState = {
    state: status.state,
    reason: status.reason,
    since: save.careerState?.state === status.state ? save.careerState.since : save.date,
    actionKey: status.action?.key ?? null,
  };
  return status;
}

/** Valid transitions. Used by tests to prove the machine never jumps somewhere absurd. */
export const CAREER_TRANSITIONS: Record<CareerState, CareerState[]> = {
  available: ['offer-pending', 'negotiating', 'recovery', 'medical-suspension', 'contract-decision', 'free-agent', 'retired', 'available', 'booked'],
  'offer-pending': ['negotiating', 'booked', 'available', 'camp-planning', 'offer-pending', 'retired'],
  negotiating: ['offer-pending', 'booked', 'available', 'negotiating'],
  booked: ['camp-planning', 'camp-active', 'injured-while-booked', 'fight-week', 'available', 'booked', 'awaiting-promotion-response'],
  'camp-planning': ['camp-active', 'injured-while-booked', 'fight-week', 'available', 'camp-planning', 'booked'],
  'camp-active': ['camp-active', 'injured-while-booked', 'fight-week', 'available', 'camp-planning', 'booked'],
  'injured-while-booked': ['awaiting-medical-decision', 'awaiting-promotion-response', 'camp-active', 'camp-planning', 'recovery', 'available', 'injured-while-booked', 'fight-week', 'booked'],
  'awaiting-medical-decision': ['injured-while-booked', 'recovery', 'camp-active', 'camp-planning', 'available', 'awaiting-medical-decision', 'booked', 'awaiting-promotion-response'],
  'awaiting-promotion-response': ['booked', 'camp-planning', 'camp-active', 'recovery', 'available', 'awaiting-promotion-response', 'injured-while-booked'],
  'fight-week': ['fight-week', 'fight-ready', 'injured-while-booked', 'available', 'camp-active'],
  'fight-ready': ['fight-in-progress', 'awaiting-result', 'post-fight', 'fight-ready', 'available', 'fight-week'],
  'fight-in-progress': ['awaiting-result', 'post-fight', 'fight-in-progress'],
  'awaiting-result': ['post-fight', 'awaiting-result'],
  'post-fight': ['medical-suspension', 'recovery', 'available', 'contract-decision', 'retired', 'post-fight'],
  'medical-suspension': ['recovery', 'available', 'medical-suspension', 'retired', 'contract-decision'],
  recovery: ['available', 'recovery', 'medical-suspension', 'retired', 'contract-decision', 'offer-pending'],
  'contract-decision': ['available', 'free-agent', 'retired', 'contract-decision', 'recovery'],
  'free-agent': ['available', 'retired', 'free-agent', 'contract-decision'],
  retired: ['retired'],
  'not-a-fighter': ['not-a-fighter'],
};

export function isValidTransition(from: CareerState, to: CareerState): boolean {
  return CAREER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A short plain sentence explaining why the calendar will not move. */
export function advanceBlockExplanation(save: SaveGame): string | null {
  const status = careerStatus(save);
  if (!status.advanceBlocked) return null;
  return status.action ? `${status.reason} Next: ${status.action.label}.` : status.reason;
}

/** Days until the fighter is expected to be able to compete again, or null. */
export function daysUntilClear(save: SaveGame, fighter: Fighter): number | null {
  if (canCompete(fighter, save.date).ok) return null;
  const dates: IsoDate[] = [];
  if (fighter.medicalSuspension) dates.push(fighter.medicalSuspension.until);
  for (const i of activeInjuries(fighter, save.date)) if (i.blocksCompetition) dates.push(i.expectedReturn);
  if (dates.length === 0) return null;
  const latest = dates.sort().pop()!;
  return Math.max(0, daysBetween(save.date, latest));
}

/** The date a fighter could realistically take a booking again. */
export function earliestBookableDate(save: SaveGame, fighter: Fighter): IsoDate {
  const clear = daysUntilClear(save, fighter);
  return addDays(save.date, (clear ?? 0) + 21);
}
