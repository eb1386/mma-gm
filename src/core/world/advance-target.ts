import { addDays, daysBetween, type BoutId, type FighterId, type IsoDate } from '../types/common';
import type { SaveGame } from '../types/save';
import { advance, type AdvanceReport } from './tick';
import { actionRoute, careerStatus } from './career';
import { hasLiveBooking } from './availability';
import { FIGHT_WEEK_DAYS } from './availability';
import { blockingStage, pendingStages, tasksForBout } from './fightweek';
import { canCompete } from './health';

/**
 * Target advancement.
 *
 * The interface asks for a destination, not a number of days. Before this existed a page
 * had to press the weekly button repeatedly and hope, which is why camp felt like it did
 * nothing: one click moved seven days and the player was still five weeks from fight week.
 *
 * `advanceUntil` loops inside the core, stopping the moment a real decision appears or the
 * destination is reached, and reports exactly what happened on the way.
 */

export type AdvanceTarget =
  | { kind: 'next-player-action' }
  | { kind: 'fight-week'; boutId: BoutId }
  | { kind: 'fight-day'; boutId: BoutId }
  | { kind: 'media-day'; boutId: BoutId }
  | { kind: 'press-conference'; boutId: BoutId }
  | { kind: 'official-weigh-in'; boutId: BoutId }
  | { kind: 'recovery-clearance'; fighterId: FighterId }
  | { kind: 'next-offer'; fighterId: FighterId }
  | { kind: 'next-event' }
  | { kind: 'contract-expiry'; fighterId: FighterId }
  | { kind: 'duration'; days: number }
  | { kind: 'date'; date: IsoDate };

export function targetLabel(target: AdvanceTarget): string {
  switch (target.kind) {
    case 'next-player-action':
      return 'Advance Until Something Needs You';
    case 'fight-week':
      return 'Advance to Fight Week';
    case 'fight-day':
      return 'Advance to Fight Night';
    case 'media-day':
      return 'Advance to Media Day';
    case 'press-conference':
      return 'Advance to Press Conference';
    case 'official-weigh-in':
      return 'Advance to Official Weigh-In';
    case 'recovery-clearance':
      return 'Advance Until Recovered';
    case 'next-offer':
      return 'Advance Until Next Offer';
    case 'next-event':
      return 'Advance to Next Event';
    case 'contract-expiry':
      return 'Advance to Contract Expiration';
    case 'duration':
      return target.days === 1 ? 'Advance a Day' : target.days === 7 ? 'Advance a Week' : 'Advance a Month';
    case 'date':
      return `Advance to ${target.date}`;
  }
}

/** What the world is doing right now, for the progress panel. */
export type AdvancePhase =
  | 'starting'
  | 'running-camp'
  | 'simulating-events'
  | 'updating-rankings'
  | 'checking-health'
  | 'reaching-target'
  | 'complete';

export interface AdvanceUntilResult {
  fromDate: IsoDate;
  toDate: IsoDate;
  daysAdvanced: number;
  target: AdvanceTarget;
  reachedTarget: boolean;
  stateBefore: string;
  stateAfter: string;
  eventsResolved: string[];
  fightsResolved: number;
  campWeeksCompleted: number;
  campEvents: string[];
  injuries: string[];
  decisionsCreated: string[];
  inboxCreated: number;
  fightWeekTasksCreated: number;
  offersCreated: number;
  rankingsChanged: boolean;
  moneyEarned: number;
  moneySpent: number;
  headlines: string[];
  /** Why it stopped short, in player facing language. Null when the target was reached. */
  stoppedBecause: string | null;
  mandatoryAction: string | null;
  navigateTo: string | null;
  summary: string;
}

interface Snapshot {
  date: IsoDate;
  state: string;
  inbox: number;
  offers: number;
  fightWeekTasks: number;
  campWeeks: number;
  injuries: number;
  cash: number;
  results: number;
  rankingSignature: string;
}

function snapshot(save: SaveGame): Snapshot {
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const bout = me ? hasLiveBooking(save, me) : null;
  const camp = Object.values(save.camps).find((c) => c.fighterId === me?.id && (c.status === 'planned' || c.status === 'running'));
  return {
    date: save.date,
    state: careerStatus(save).state,
    inbox: save.inbox.length,
    offers: Object.keys(save.fightOffers).length,
    fightWeekTasks: bout ? tasksForBout(save, bout.id).length : 0,
    campWeeks: camp?.weeksCompleted ?? 0,
    injuries: me?.injuries.length ?? 0,
    cash: save.finance?.cash ?? save.player.balance,
    results: Object.keys(save.history.results).length,
    rankingSignature: me ? `${me.ranking ?? 'u'}-${save.rankings[me.divisionId]?.championId ?? 'none'}` : '',
  };
}

/** True when the world has arrived at the requested destination. */
export function targetReached(save: SaveGame, target: AdvanceTarget, startDate: IsoDate): boolean {
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  switch (target.kind) {
    case 'next-player-action':
      return careerStatus(save).advanceBlocked;
    case 'fight-week': {
      const bout = save.bouts[target.boutId];
      if (!bout || bout.status !== 'scheduled') return true;
      return daysBetween(save.date, bout.date) <= FIGHT_WEEK_DAYS;
    }
    case 'fight-day': {
      const bout = save.bouts[target.boutId];
      if (!bout || bout.status !== 'scheduled') return true;
      return save.date >= bout.date;
    }
    case 'media-day':
    case 'press-conference':
    case 'official-weigh-in': {
      const bout = save.bouts[target.boutId];
      if (!bout || bout.status !== 'scheduled') return true;
      const stage = target.kind === 'media-day' ? 'media-day' : target.kind === 'press-conference' ? 'press-conference' : 'official-weigh-in';
      const task = tasksForBout(save, target.boutId).find((t) => t.stage === stage);
      if (!task) return daysBetween(save.date, bout.date) <= FIGHT_WEEK_DAYS;
      return task.dueOn <= save.date || task.status === 'complete' || task.status === 'skipped';
    }
    case 'recovery-clearance': {
      const f = save.fighters[target.fighterId];
      if (!f) return true;
      return canCompete(f, save.date).ok;
    }
    case 'next-offer': {
      if (!me) return true;
      return Object.values(save.fightOffers).some((o) => o.status === 'open' && o.fighterId === me.id);
    }
    case 'next-event':
      return Object.values(save.events).some((e) => e.status === 'completed' && e.date > startDate && e.date <= save.date);
    case 'contract-expiry': {
      const f = save.fighters[target.fighterId];
      const contract = f?.contractId ? save.contracts[f.contractId] : null;
      if (!contract) return true;
      return contract.status !== 'active' || contract.fightsRemaining <= 0;
    }
    case 'duration':
      return daysBetween(startDate, save.date) >= target.days;
    case 'date':
      return save.date >= target.date;
  }
}

/** A hard ceiling so a target that can never be reached still terminates. */
function maxDaysFor(target: AdvanceTarget): number {
  switch (target.kind) {
    case 'duration':
      return target.days;
    case 'next-player-action':
      return 400;
    case 'recovery-clearance':
    case 'contract-expiry':
      return 900;
    case 'next-offer':
      return 400;
    default:
      return 400;
  }
}

export interface AdvanceUntilOptions {
  /** Called as the world moves so the interface can show progress. */
  onProgress?: (phase: AdvancePhase, detail: string, fraction: number) => void;
  /** Stop the loop early. Used by the cancel button. */
  shouldCancel?: () => boolean;
}

/**
 * Advances until the target is reached, a mandatory decision appears, or the ceiling hits.
 *
 * The step is one day so a stage that becomes due mid week is not walked past. Days are
 * cheap: an empty day is well under a millisecond, and the expensive weekly pass only runs
 * on the day it is scheduled for.
 */
export function advanceUntil(save: SaveGame, target: AdvanceTarget, opts: AdvanceUntilOptions = {}): AdvanceUntilResult {
  const before = snapshot(save);
  const startDate = save.date;
  const ceiling = maxDaysFor(target);
  const reports: AdvanceReport[] = [];
  const campEvents: string[] = [];
  const injuries: string[] = [];
  let canceled = false;

  opts.onProgress?.('starting', `Starting from ${startDate}`, 0);

  // A target that is already satisfied does nothing and says so.
  if (target.kind !== 'duration' && targetReached(save, target, startDate)) {
    return buildResult(save, target, before, reports, campEvents, injuries, startDate, true, alreadyThereReason(save, target));
  }

  let guard = 0;
  while (guard++ < ceiling) {
    if (opts.shouldCancel?.()) {
      canceled = true;
      break;
    }
    const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
    const campBefore = me
      ? Object.values(save.camps).find((c) => c.fighterId === me.id && (c.status === 'planned' || c.status === 'running'))?.weeksCompleted ?? 0
      : 0;
    const injuriesBefore = me?.injuries.length ?? 0;

    const report = advance(save, { mode: 'day', stopOnDecision: false });
    reports.push(report);

    const campAfter = me
      ? Object.values(save.camps).find((c) => c.fighterId === me.id && (c.status === 'planned' || c.status === 'running'))?.weeksCompleted ?? 0
      : 0;
    if (campAfter > campBefore) {
      campEvents.push(`Camp week ${campAfter} complete.`);
      opts.onProgress?.('running-camp', `Camp week ${campAfter}`, Math.min(0.95, guard / ceiling));
    }
    if (me && me.injuries.length > injuriesBefore) {
      const fresh = me.injuries[me.injuries.length - 1];
      injuries.push(fresh.type);
    }
    if (report.eventsResolved.length > 0) {
      opts.onProgress?.('simulating-events', report.eventsResolved[0], Math.min(0.95, guard / ceiling));
    } else if (guard % 7 === 0) {
      opts.onProgress?.('reaching-target', `${save.date}`, Math.min(0.95, guard / ceiling));
    }

    // A mandatory decision always wins over the requested destination.
    const status = careerStatus(save);
    if (status.advanceBlocked) break;
    if (targetReached(save, target, startDate)) break;
    // A bout that stops existing invalidates a bout scoped target.
    if ('boutId' in target && save.bouts[target.boutId]?.status !== 'scheduled') break;
  }

  opts.onProgress?.('complete', 'Done', 1);
  const reached = targetReached(save, target, startDate);
  return buildResult(save, target, before, reports, campEvents, injuries, startDate, reached, canceled ? 'Stopped at your request.' : null);
}

function alreadyThereReason(save: SaveGame, target: AdvanceTarget): string {
  switch (target.kind) {
    case 'fight-week':
      return 'Fight week has already started.';
    case 'fight-day':
      return 'It is already fight day.';
    case 'recovery-clearance':
      return 'You are already cleared to compete.';
    case 'next-offer':
      return 'There is already an offer waiting for you.';
    case 'next-player-action':
      return careerStatus(save).reason;
    default:
      return 'You are already there.';
  }
}

function buildResult(
  save: SaveGame,
  target: AdvanceTarget,
  before: Snapshot,
  reports: AdvanceReport[],
  campEvents: string[],
  injuries: string[],
  startDate: IsoDate,
  reached: boolean,
  stoppedBecause: string | null
): AdvanceUntilResult {
  const after = snapshot(save);
  const status = careerStatus(save);
  const days = daysBetween(startDate, save.date);
  const headlines = reports.flatMap((r) => r.headlines);
  const events = reports.flatMap((r) => r.eventsResolved);
  const decisions = save.inbox
    .filter((m) => m.requiresAction && m.date >= startDate && m.status !== 'resolved' && m.status !== 'expired')
    .map((m) => m.subject);

  const blocked = status.advanceBlocked ? status.reason : null;
  const summary = buildSummary(target, reached, days, after, before, status.action?.label ?? null, blocked ?? stoppedBecause);

  return {
    fromDate: startDate,
    toDate: save.date,
    daysAdvanced: days,
    target,
    reachedTarget: reached,
    stateBefore: before.state,
    stateAfter: after.state,
    eventsResolved: events,
    fightsResolved: after.results - before.results,
    campWeeksCompleted: Math.max(0, after.campWeeks - before.campWeeks),
    campEvents,
    injuries,
    decisionsCreated: decisions,
    inboxCreated: Math.max(0, after.inbox - before.inbox),
    fightWeekTasksCreated: Math.max(0, after.fightWeekTasks - before.fightWeekTasks),
    offersCreated: Math.max(0, after.offers - before.offers),
    rankingsChanged: after.rankingSignature !== before.rankingSignature,
    moneyEarned: Math.max(0, after.cash - before.cash),
    moneySpent: Math.max(0, before.cash - after.cash),
    headlines,
    // A move of zero days always carries a reason, even when the target was already
    // satisfied. Without this the interface has nothing to show and the click looks lost.
    stoppedBecause: days === 0 ? (stoppedBecause ?? blocked ?? alreadyThereReason(save, target)) : reached ? null : (blocked ?? stoppedBecause ?? 'You could not get any further.'),
    mandatoryAction: status.action?.blocking ? status.action.label : null,
    navigateTo: status.action?.blocking ? actionRoute(status.action) : reached ? destinationFor(save, target) : null,
    summary,
  };
}

function buildSummary(
  target: AdvanceTarget,
  reached: boolean,
  days: number,
  after: Snapshot,
  before: Snapshot,
  nextAction: string | null,
  blocked: string | null
): string {
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'} passed.`);
  const campWeeks = after.campWeeks - before.campWeeks;
  if (campWeeks > 0) parts.push(`${campWeeks} camp week${campWeeks === 1 ? '' : 's'} completed.`);
  const fights = after.results - before.results;
  if (fights > 0) parts.push(`${fights} fight${fights === 1 ? '' : 's'} on the cards resolved.`);
  if (reached) {
    switch (target.kind) {
      case 'fight-week':
        parts.push('Fight Week Begins.');
        break;
      case 'fight-day':
        parts.push('It is fight night.');
        break;
      case 'recovery-clearance':
        parts.push('Recovery Complete.');
        break;
      case 'next-offer':
        parts.push('A new offer is on the table.');
        break;
      case 'official-weigh-in':
        parts.push('Official Weigh-In Ready.');
        break;
      default:
        break;
    }
  } else if (blocked) {
    parts.push(blocked);
  }
  if (nextAction) parts.push(`Next: ${nextAction}.`);
  return parts.join(' ') || 'Nothing moved.';
}

function destinationFor(save: SaveGame, target: AdvanceTarget): string | null {
  switch (target.kind) {
    case 'fight-week':
    case 'media-day':
    case 'press-conference':
    case 'official-weigh-in':
      return `/fightweek/${target.boutId}`;
    case 'fight-day':
      return `/fight/${target.boutId}`;
    case 'next-offer': {
      const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
      const offer = me ? Object.values(save.fightOffers).find((o) => o.status === 'open' && o.fighterId === me.id) : null;
      return offer ? `/offer/${offer.id}` : null;
    }
    case 'next-event':
      return '/calendar';
    default:
      return null;
  }
}

/** The most useful target for the current situation, used by the contextual button. */
export function suggestTarget(save: SaveGame): AdvanceTarget {
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me) return { kind: 'next-event' };
  const bout = hasLiveBooking(save, me);
  if (bout) {
    const days = daysBetween(save.date, bout.date);
    if (days <= 0) return { kind: 'fight-day', boutId: bout.id };
    const blocking = blockingStage(save, bout.id);
    if (blocking) return { kind: 'fight-day', boutId: bout.id };
    if (days <= FIGHT_WEEK_DAYS) {
      const pending = pendingStages(save, bout.id);
      if (pending.length > 0) return { kind: 'fight-day', boutId: bout.id };
      return { kind: 'fight-day', boutId: bout.id };
    }
    return { kind: 'fight-week', boutId: bout.id };
  }
  if (!canCompete(me, save.date).ok) return { kind: 'recovery-clearance', fighterId: me.id };
  const hasOffer = Object.values(save.fightOffers).some((o) => o.status === 'open' && o.fighterId === me.id);
  if (hasOffer) return { kind: 'next-player-action' };
  return { kind: 'next-offer', fighterId: me.id };
}

/** Days from now to the given date, for progress reporting. */
export function daysUntil(save: SaveGame, date: IsoDate): number {
  return Math.max(0, daysBetween(save.date, date));
}

export { addDays };
