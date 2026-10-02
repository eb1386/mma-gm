import { addDays, daysBetween, formatDate, type BoutId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { activeCampFor, hasLiveBooking, openOffersFor } from './availability';
import { activeInjuries, canCompete } from './health';
import { actionableMessages } from './inbox';
import { FIGHT_WEEK_DAYS } from './availability';
import { pendingStages, stageLabel, tasksForBout, type FightWeekStage } from './fightweek';
import type { AdvanceTarget } from './advance-target';
import { DIVISION_BY_ID } from '../config/divisions';
import { isFinish } from '../types/fight';
import { isMainResult } from './circuit';
import { forfeitContenderStatus } from './contender';
import { pushNews, retirementNews } from './history';
import { isAmateurFighter, promotionOfFighter } from './regional';
import { PROMOTION_ABBREVIATION } from '../config/branding';

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
  | 'compliance-decision'
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
  'compliance-decision': 'Anti-doping decision',
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

/**
 * Which states forbid the calendar from moving at all until the player acts.
 *
 * Injured with a fight booked is not one of them. It blocks while the injury decision is open,
 * through that action, and must not block once the decision is answered: the injury can only
 * heal while time passes, so a state that held the clock until it healed could never end.
 */
const BLOCKING_STATES = new Set<CareerState>([
  'offer-pending',
  'awaiting-medical-decision',
  'compliance-decision',
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
    // Unless the official weigh in never happened. Only that stage is checked here: on fight day
    // final clearance and the fight itself are always due, and they are completed through the
    // fight page, so routing on any pending mandatory stage would hide Enter Fight for good.
    const weighIn = tasksForBout(save, bout.id).find((t) => t.stage === 'official-weigh-in' && t.status !== 'complete' && t.status !== 'skipped');
    if (weighIn) {
      return finish(
        'fight-week',
        `${stageLabel(weighIn.stage)} has not happened. It comes before facing ${opponent?.name ?? 'the opponent'}.`,
        {
          kind: 'navigate',
          label: weighIn.actionLabel,
          route: `/fightweek/${bout.id}`,
          detail: weighIn.detail,
          blocking: true,
          key: `stage-${bout.id}-${weighIn.stage}`,
        },
        { fightWeekStage: weighIn.stage }
      );
    }
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
  // day, because the booked fight cannot be planned around until it is answered. Only a real
  // injury decision counts. Matching the whole medical category told a healthy fighter he was
  // hurt whenever a supplement question or an anti-doping sanction arrived.
  const injuryDecision = decisions.find((m) => m.category === 'injury' || Boolean(m.linkedInjuryId));
  if (injuryDecision) {
    return finish(
      bout ? 'injured-while-booked' : 'awaiting-medical-decision',
      bout
        ? `${me.name} is hurt with ${opponent?.name ?? 'a fight'} booked for ${formatDate(bout.date)}. The promotion needs an answer.`
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

  // An anti-doping sanction is answered to the commission. It blocks like an injury decision,
  // but it is not one, and the wording says what it actually is.
  const sanction = decisions.find((m) => m.category === 'medical' && m.choices.some((c) => c.key.startsWith('doping-')));
  if (sanction) {
    return finish('compliance-decision', 'The commission needs an answer on a sanction.', {
      kind: 'navigate',
      label: 'Answer the Commission',
      route: `/inbox/${sanction.id}`,
      detail: sanction.subject,
      blocking: true,
      key: `sanction-${sanction.id}`,
    });
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
        detail: `${event?.name ?? 'The event'} on ${formatDate(bout.date)}.`,
        blocking: false,
        key: `fightweek-${bout.id}`,
      });
    }

    // Hurt, booked, and nothing open to answer. Every open injury decision was handled above,
    // so what is left is an injury the player has already treated, a medically contingent
    // booking, or one expected to clear before the date. None of those is a question, and the
    // only thing that resolves them is time: this used to hold the clock and point at the camp
    // page, which has no injury control, so the injury could never heal and the career froze.
    // A booking the injury can no longer make is raised as a new decision by the weekly check.
    if (blocking.length > 0) {
      const back = blocking.map((i) => i.expectedReturn).sort().pop()!;
      const clearsInTime = back < bout.date;
      return finish(
        'injured-while-booked',
        clearsInTime
          ? `${me.name} is recovering from ${blocking[0].type}, expected back ${formatDate(back)}, before the fight on ${formatDate(bout.date)}.`
          : `${me.name} is not expected back from ${blocking[0].type} until ${formatDate(back)}, after the fight on ${formatDate(bout.date)}.`,
        {
          kind: 'advance-target',
          label: 'Advance Until Recovered',
          // Recovery stops at fight week at the latest. advanceUntil caps the target there.
          target: { kind: 'recovery-clearance', fighterId: me.id },
          detail: `${blocking[0].type}, expected back ${formatDate(back)}. ${daysToFight} days until the bout.`,
          blocking: false,
          key: `injury-recovery-${blocking[0].id}`,
        }
      );
    }

    if (!camp) {
      return finish('camp-planning', `No camp is planned for ${opponent?.name ?? 'the fight'} on ${formatDate(bout.date)}.`, {
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
    // A camp now waits until it is due, so one set on long notice has not started yet.
    const campWaits = campRecord !== null && campRecord.status === 'planned' && campRecord.startDate > save.date;
    const campLine = campWaits
      ? `Camp for ${opponent?.name ?? 'the fight'} on ${formatDate(bout.date)} starts ${formatDate(campRecord.startDate)}.`
      : `In camp for ${opponent?.name ?? 'the fight'} on ${formatDate(bout.date)}.`;
    return finish('camp-active', campLine, {
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
    return finish('medical-suspension', `Medically suspended until ${formatDate(me.medicalSuspension.until)}: ${me.medicalSuspension.reason}.`, {
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
    return finish('recovery', `Recovering from ${blocking[0].type}. Expected back ${formatDate(back)}.`, {
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
    // Released is a different situation from a deal running out, and saying so matters: the
    // promotion takes most of a year to come back, and the screen used to promise a month.
    const wasReleased = contract?.status === 'released' || me.activityStatus === 'released';
    return finish(
      'free-agent',
      pendingOffer
        ? `${me.name} is out of contract. No fights can be offered until a new deal is signed.`
        : wasReleased
          ? `${me.name} was released by the promotion. Nothing can be offered until they are willing to make another deal, which takes time.`
          : `${me.name} is out of contract. No fights can be offered until the promotion sends a new deal.`,
      {
        kind: 'navigate',
        label: pendingOffer ? 'Sign a New Contract' : 'Review Contract Options',
        route: '/contract',
        detail: pendingOffer
          ? 'An offer is waiting. Until it is signed you cannot be matched, and a title shot cannot be offered.'
          : wasReleased
            ? 'No promotional contract, and being released means the promotion is in no hurry. Keep advancing and they will come back when the division needs you.'
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

/**
 * Records a career milestone once.
 *
 * The list existed on every save, was initialised empty at world creation, and was written by
 * nothing and read by nothing. A career with no single victory condition needs a record of what
 * it has actually achieved, which is what this is for.
 */
export function awardAchievement(save: SaveGame, key: string, label: string): boolean {
  if (!save.player.achievements) save.player.achievements = [];
  if (save.player.achievements.some((a) => a.key === key)) return false;
  save.player.achievements.push({ key, label, date: save.date });
  return true;
}

/**
 * Milestones from this save, checked each week.
 *
 * Measured against what has happened inside this career, not against the totals a fighter
 * arrives with. Reading the lifetime counters awarded a first finish and a place in the rankings
 * on the opening day, from a record made before the save began, and then awarded the first win
 * three months later when a real one happened. The order alone gave it away.
 */
export function recordAchievements(save: SaveGame): string[] {
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me) return [];
  const won: string[] = [];
  const claim = (key: string, label: string, earned: boolean) => {
    if (earned && awardAchievement(save, key, label)) won.push(label);
  };

  // Only bouts this save simulated. Anything else belongs to a career the player did not manage.
  const mine = me.boutIds.map((id) => save.history.results[id]).filter(Boolean);
  // The "in the promotion" milestones count the promotion's fights only. A regional or amateur
  // bout used to claim the first fight and first win, and since each is awarded once, the real
  // debut later earned nothing.
  const promoResults = mine.filter((r) => isMainResult(save, r));
  const promoWins = promoResults.filter((r) => r.winnerId === me.id);
  // A finish counts on any professional card, regional included, but not as an amateur.
  const finishes = mine.filter((r) => r.winnerId === me.id && isFinish(r.method) && !save.bouts[r.boutId]?.isAmateur);
  // An imported reign is the title the fighter already held when the save began, not one won here.
  const reigns = save.history.reigns.filter(
    (r) => r.fighterId === me.id && !r.isInterim && r.wonBoutId !== null && !r.id.startsWith('reign-import-')
  );
  const defenses = save.history.reigns
    .filter((r) => r.fighterId === me.id && !r.isInterim)
    .reduce((t, r) => t + r.defenses, 0);
  const divisionsHeld = new Set(reigns.map((r) => r.divisionId));
  const division = DIVISION_BY_ID[me.divisionId];
  // The ranking milestones are measured from where the career started. Undefined is a save from
  // before the start was recorded, which keeps the old rule rather than guessing.
  const start = save.player.startRanking;
  const startedUnranked = start === undefined || start === null;

  // A save played before the split may hold a first fight or first win claimed by a regional or
  // amateur bout. Results are never pruned, so with no promotional result yet the claim cannot be
  // real; it is withdrawn here so the actual debut can earn it.
  if (promoResults.length === 0 && save.player.achievements?.some((a) => a.key === 'first-fight' || a.key === 'first-win')) {
    save.player.achievements = save.player.achievements.filter((a) => a.key !== 'first-fight' && a.key !== 'first-win');
  }

  claim('first-fight', 'First fight in the promotion', promoResults.length >= 1);
  claim('first-win', 'First win in the promotion', promoWins.length >= 1);
  claim('first-finish', 'First finish', finishes.length >= 1);
  claim('ranked', 'Broke into the rankings', me.ranking !== null && startedUnranked);
  claim('top-five', 'Reached the top five', me.ranking !== null && me.ranking <= 5 && (startedUnranked || start! > 5));
  claim('number-one', 'Reached number one contender', me.ranking === 1 && start !== 1);
  claim('champion', `Won the ${division?.name ?? 'divisional'} championship`, reigns.length >= 1);
  claim('defended', 'Defended the championship', defenses >= 1);
  claim('dynasty', 'Defended the championship five times', defenses >= 5);
  claim('two-division', 'Held a title in two divisions', divisionsHeld.size >= 2);
  claim('ten-wins', 'Ten wins in the promotion', promoWins.length >= 10);
  claim('twenty-fights', 'Twenty fights in the promotion', promoResults.length >= 20);
  claim('millionaire', 'Career earnings past one million', (save.finance?.careerEarnings ?? 0) >= 1_000_000);
  claim('hall-of-fame', 'Inducted into the Hall of Fame', me.hallOfFameYear !== null);
  return won;
}

/**
 * Ends a career, with every consequence applied in one place.
 *
 * NPCs have retired through this logic since the beginning; the player had no way to retire at
 * all, which players asked for directly. One function serves both, so a champion who walks away
 * vacates the belt identically whoever they are.
 */
export function retireFighter(save: SaveGame, fighter: Fighter, reason: string): { ok: boolean; message: string } {
  if (fighter.retired) return { ok: false, message: `${fighter.name} is already retired.` };
  const live = fighter.nextBoutId ? save.bouts[fighter.nextBoutId] : null;
  if (live && live.status === 'scheduled') {
    return { ok: false, message: 'There is a booked fight. Withdraw from it or see it through before retiring.' };
  }

  fighter.retired = true;
  fighter.retirementDate = save.date;
  fighter.activityStatus = 'retired';

  const table = save.rankings[fighter.divisionId];
  if (table?.interimChampionId === fighter.id) {
    table.interimChampionId = null;
    fighter.isInterimChampion = false;
    const interimReign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && r.isInterim);
    if (interimReign) {
      interimReign.lostOn = save.date;
      interimReign.endReason = 'retired';
    }
  }
  forfeitContenderStatus(save, fighter.divisionId, `${fighter.name} has retired.`, fighter.id);
  if (table?.championId === fighter.id) {
    table.championId = null;
    fighter.isChampion = false;
    const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim);
    if (reign) {
      reign.lostOn = save.date;
      reign.endReason = 'retired';
    }
    pushNews(save, {
      date: save.date,
      headline: `${DIVISION_BY_ID[fighter.divisionId]?.name ?? 'The'} title is vacant`,
      body: `${fighter.name} has retired as champion. The title is vacated.`,
      tags: ['title', fighter.divisionId],
      fighterIds: [fighter.id],
      importance: 5,
    });
  }
  // A retired fighter leaves the rankings the day they retire. The weekly recompute used to be the
  // only thing that removed them, and it runs before the retirement pass, so a fighter who retired
  // stayed ranked for up to a week, and a table read in that window listed somebody who had quit.
  if (table) {
    const before = table.entries.length;
    table.entries = table.entries.filter((e) => e.fighterId !== fighter.id);
    if (table.entries.length !== before) table.entries.forEach((e, i) => (e.rank = i + 1));
  }
  const pfpBefore = save.pfp.entries.length;
  save.pfp.entries = save.pfp.entries.filter((e) => e.fighterId !== fighter.id);
  if (save.pfp.entries.length !== pfpBefore) save.pfp.entries.forEach((e, i) => (e.rank = i + 1));
  fighter.ranking = null;
  fighter.pfpRanking = null;

  // Whatever was on the table is off it.
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.fighterId !== fighter.id && offer.opponentId !== fighter.id) continue;
    if (offer.status === 'open') offer.status = 'withdrawn';
  }
  retirementNews(save, fighter, reason, save.date);
  return { ok: true, message: `${fighter.name} has retired. The record stands at ${retirementRecordLine(fighter)}.` };
}

/**
 * The record a retirement is remembered by. It used to be the promotional record whoever retired,
 * so an amateur or a regional professional read '0 and 0 in the promotion' after a real career.
 */
function retirementRecordLine(f: Fighter): string {
  const fmt = (r: { wins: number; losses: number; draws: number }) => `${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}`;
  if (isAmateurFighter(f)) return `${fmt(f.amateurRecord ?? { wins: 0, losses: 0, draws: 0 })} as an amateur`;
  if (f.circuit) {
    const promotion = promotionOfFighter(f);
    return `${fmt(f.record)} as a professional${promotion ? `, fighting for ${promotion.name}` : ''}`;
  }
  return `${fmt(f.ufcRecord)} in ${PROMOTION_ABBREVIATION}`;
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
  available: ['offer-pending', 'negotiating', 'recovery', 'medical-suspension', 'contract-decision', 'free-agent', 'retired', 'available', 'booked', 'awaiting-medical-decision', 'compliance-decision'],
  'offer-pending': ['negotiating', 'booked', 'available', 'camp-planning', 'offer-pending', 'retired'],
  negotiating: ['offer-pending', 'booked', 'available', 'negotiating'],
  booked: ['camp-planning', 'camp-active', 'injured-while-booked', 'fight-week', 'available', 'booked', 'awaiting-promotion-response', 'compliance-decision'],
  'camp-planning': ['camp-active', 'injured-while-booked', 'fight-week', 'available', 'camp-planning', 'booked', 'compliance-decision'],
  'camp-active': ['camp-active', 'injured-while-booked', 'fight-week', 'available', 'camp-planning', 'booked', 'compliance-decision'],
  'injured-while-booked': ['awaiting-medical-decision', 'awaiting-promotion-response', 'camp-active', 'camp-planning', 'recovery', 'available', 'injured-while-booked', 'fight-week', 'booked'],
  'awaiting-medical-decision': ['injured-while-booked', 'recovery', 'camp-active', 'camp-planning', 'available', 'awaiting-medical-decision', 'booked', 'awaiting-promotion-response'],
  'compliance-decision': ['compliance-decision', 'available', 'free-agent', 'contract-decision', 'recovery', 'medical-suspension', 'retired'],
  'awaiting-promotion-response': ['booked', 'camp-planning', 'camp-active', 'recovery', 'available', 'awaiting-promotion-response', 'injured-while-booked'],
  'fight-week': ['fight-week', 'fight-ready', 'injured-while-booked', 'available', 'camp-active', 'compliance-decision'],
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
