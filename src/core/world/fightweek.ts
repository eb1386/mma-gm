import { clamp } from '../rng';
import { addDays, daysBetween, type BoutId, type IsoDate } from '../types/common';
import { addHypeMoment, hypeStore } from './hype';
import { isChampionshipBout } from '../types/fight';
import type { SaveGame } from '../types/save';

/**
 * Fight week as a sequence of mandatory and optional stages.
 *
 * Every stage has a date, a task, a page and a resolution. Stages are generated once per
 * bout and never regenerated, which is what stops the inbox filling with duplicate media
 * day reminders every time the weekly pass runs.
 */

export type FightWeekStage =
  | 'travel'
  | 'arrival'
  | 'medical-exam'
  | 'media-day'
  | 'open-workout'
  | 'press-conference'
  | 'official-weigh-in'
  | 'second-weigh-in-attempt'
  | 'ceremonial-weigh-in'
  | 'faceoff'
  | 'final-clearance'
  | 'fight-night'
  | 'post-fight-interview'
  | 'post-fight-press';

export const STAGE_LABEL: Record<FightWeekStage, string> = {
  travel: 'Travel',
  arrival: 'Arrival',
  'medical-exam': 'Medical examination',
  'media-day': 'Media day',
  'open-workout': 'Open workout',
  'press-conference': 'Press conference',
  'official-weigh-in': 'Official weigh in',
  'second-weigh-in-attempt': 'Second weigh in attempt',
  'ceremonial-weigh-in': 'Ceremonial weigh in',
  faceoff: 'Faceoff',
  'final-clearance': 'Final medical clearance',
  'fight-night': 'Fight night',
  'post-fight-interview': 'Post fight interview',
  'post-fight-press': 'Post fight press conference',
};

export function stageLabel(stage: FightWeekStage): string {
  return STAGE_LABEL[stage];
}

export interface FightWeekTask {
  id: string;
  boutId: BoutId;
  stage: FightWeekStage;
  /** Day the stage becomes available. */
  dueOn: IsoDate;
  mandatory: boolean;
  status: 'pending' | 'available' | 'complete' | 'skipped';
  actionLabel: string;
  detail: string;
  /** Free form record of what the player chose, for the recap and for consequences. */
  outcome: string | null;
  resolvedOn: IsoDate | null;
}

/** Days before the event each stage falls on. Negative numbers are after the event. */
const STAGE_OFFSETS: Record<FightWeekStage, number> = {
  travel: 6,
  arrival: 5,
  'medical-exam': 4,
  'media-day': 3,
  'open-workout': 3,
  'press-conference': 2,
  'official-weigh-in': 1,
  'second-weigh-in-attempt': 1,
  'ceremonial-weigh-in': 1,
  faceoff: 1,
  'final-clearance': 0,
  'fight-night': 0,
  'post-fight-interview': 0,
  'post-fight-press': 0,
};

const MANDATORY: FightWeekStage[] = ['official-weigh-in', 'final-clearance', 'fight-night'];

/** Stages that resolve themselves the moment they come due. Travel is not a decision. */
const AUTOMATIC: FightWeekStage[] = ['travel', 'arrival', 'medical-exam'];

/**
 * Which optional stages this bout carries.
 *
 * Media obligations scale with what is at stake, not with a fixed template. A preliminary
 * bout between two unranked fighters does not get a press conference.
 */
export function stagesForBout(save: SaveGame, boutId: BoutId): FightWeekStage[] {
  const bout = save.bouts[boutId];
  if (!bout) return [];
  const a = save.fighters[bout.fighterAId];
  const b = save.fighters[bout.fighterBId];
  const event = save.events[bout.eventId];
  const popularity = Math.max(a?.popularity ?? 0, b?.popularity ?? 0);
  const isBigCard = event?.tier === 'numbered-ppv' || event?.tier === 'international';
  const title = isChampionshipBout(bout);

  // Travel and arrival happen automatically. They are recorded so the timeline reads
  // correctly, but the player is never asked to choose whether to travel to their own
  // fight, which was a strange thing to put in front of somebody.
  const stages: FightWeekStage[] = ['arrival', 'medical-exam'];
  if (bout.isMainEvent || title || popularity > 45) stages.push('media-day');
  if (isBigCard && (bout.cardSegment === 'main' || title)) stages.push('open-workout');
  // Every player fight gets a press interaction. A preliminary bout gets a shorter one,
  // which the session builder handles by asking fewer questions.
  const isPlayerBout = save.player.fighterId === bout.fighterAId || save.player.fighterId === bout.fighterBId;
  if (isPlayerBout || title || bout.isMainEvent || (isBigCard && bout.isCoMain)) stages.push('press-conference');
  stages.push('official-weigh-in');
  if (title || bout.isMainEvent || isBigCard) {
    stages.push('ceremonial-weigh-in');
    stages.push('faceoff');
  }
  stages.push('final-clearance');
  stages.push('fight-night');
  if (isPlayerBout || bout.isMainEvent || title || isBigCard) stages.push('post-fight-interview');
  if (title || bout.isMainEvent) stages.push('post-fight-press');
  return stages;
}

function taskId(boutId: BoutId, stage: FightWeekStage): string {
  return `fw-${boutId}-${stage}`;
}

const ACTION_LABEL: Record<FightWeekStage, string> = {
  travel: 'Plan travel',
  arrival: 'Arrive at the host city',
  'medical-exam': 'Attend the medical examination',
  'media-day': 'Attend media day',
  'open-workout': 'Do the open workout',
  'press-conference': 'Attend press conference',
  'official-weigh-in': 'Go to the official weigh in',
  'second-weigh-in-attempt': 'Attempt the weight again',
  'ceremonial-weigh-in': 'Attend the ceremonial weigh in',
  faceoff: 'Take the faceoff',
  'final-clearance': 'Receive final medical clearance',
  'fight-night': 'Enter fight',
  'post-fight-interview': 'Give the post fight interview',
  'post-fight-press': 'Attend the post fight press conference',
};

/**
 * Creates the fight week tasks for a bout, exactly once.
 *
 * Returns the tasks that were newly created. Calling it again returns an empty array, so
 * the weekly pass can call it freely without duplicating anything.
 */
export function ensureFightWeekTasks(save: SaveGame, boutId: BoutId): FightWeekTask[] {
  const bout = save.bouts[boutId];
  if (!bout || bout.status !== 'scheduled') return [];
  if (!save.fightWeek) save.fightWeek = {};
  const created: FightWeekTask[] = [];
  for (const stage of stagesForBout(save, boutId)) {
    const id = taskId(boutId, stage);
    if (save.fightWeek[id]) continue;
    const task: FightWeekTask = {
      id,
      boutId,
      stage,
      dueOn: addDays(bout.date, -STAGE_OFFSETS[stage]),
      mandatory: MANDATORY.includes(stage),
      status: 'pending',
      actionLabel: ACTION_LABEL[stage],
      detail: detailFor(save, boutId, stage),
      outcome: null,
      resolvedOn: null,
    };
    // Automatic stages record themselves as done and simply report what happened.
    if (AUTOMATIC.includes(stage)) {
      task.status = 'complete';
      task.resolvedOn = task.dueOn;
      task.outcome = automaticOutcome(save, boutId, stage);
    }
    save.fightWeek[id] = task;
    created.push(task);
  }
  return created;
}

function detailFor(save: SaveGame, boutId: BoutId, stage: FightWeekStage): string {
  const bout = save.bouts[boutId];
  const event = bout ? save.events[bout.eventId] : null;
  const city = event ? `${event.city}, ${event.country}` : 'the host city';
  switch (stage) {
    case 'travel':
      return `Decide when to fly to ${city}.`;
    case 'arrival':
      return `Arrive in ${city} and settle in.`;
    case 'medical-exam':
      return 'Pre fight medicals with the commission.';
    case 'media-day':
      return 'Interviews with the assembled media.';
    case 'open-workout':
      return 'A public workout in front of fans and cameras.';
    case 'press-conference':
      return 'Face the press alongside the opponent.';
    case 'official-weigh-in':
      return `Make ${bout?.contractedWeightLb ?? 0} lb on the official scale.`;
    case 'second-weigh-in-attempt':
      return 'One more hour to make the weight.';
    case 'ceremonial-weigh-in':
      return 'The ceremonial weigh in in front of the crowd.';
    case 'faceoff':
      return 'The final faceoff before fight night.';
    case 'final-clearance':
      return 'The commission doctor signs off on both fighters.';
    case 'fight-night':
      return `${event?.name ?? 'The event'} in ${city}.`;
    case 'post-fight-interview':
      return 'The in cage interview.';
    case 'post-fight-press':
      return 'The post fight press conference.';
  }
}

/** Every task for a bout, in order. */
export function tasksForBout(save: SaveGame, boutId: BoutId): FightWeekTask[] {
  if (!save.fightWeek) return [];
  const order = stagesForBout(save, boutId);
  return Object.values(save.fightWeek)
    .filter((t) => t.boutId === boutId)
    .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
}

/**
 * Tasks that are due and not yet resolved, soonest first.
 *
 * A task is only offered once its date arrives, so the player is never asked to attend a
 * press conference four days early.
 */
export function pendingStages(save: SaveGame, boutId: BoutId): FightWeekTask[] {
  return tasksForBout(save, boutId).filter((t) => t.status !== 'complete' && t.status !== 'skipped' && t.dueOn <= save.date);
}

/** The next unresolved mandatory stage that would block the calendar, if any. */
export function blockingStage(save: SaveGame, boutId: BoutId): FightWeekTask | null {
  return pendingStages(save, boutId).find((t) => t.mandatory) ?? null;
}

/** Marks a stage done, exactly once, recording what happened. */
export function completeStage(save: SaveGame, taskIdValue: string, outcome: string): FightWeekTask | null {
  const task = save.fightWeek?.[taskIdValue];
  if (!task) return null;
  if (task.status === 'complete') return task;
  task.status = 'complete';
  task.outcome = outcome;
  task.resolvedOn = save.date;
  return task;
}

/** Marks a stage skipped, for optional stages the player declines. */
export function skipStage(save: SaveGame, taskIdValue: string, reason: string): FightWeekTask | null {
  const task = save.fightWeek?.[taskIdValue];
  if (!task) return null;
  if (task.status === 'complete' || task.status === 'skipped') return task;
  if (task.mandatory) return task;
  task.status = 'skipped';
  task.outcome = reason;
  task.resolvedOn = save.date;

  // The button says skipping costs a little attention and goodwill. It used to cost neither, so
  // every optional obligation was free to ignore and the line under it was not true.
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (me) {
    me.relationships.matchmaker = clamp(me.relationships.matchmaker - SKIP_STAGE_GOODWILL, 0, 100);
    if (me.fame) {
      me.fame.mediaFriendliness = clamp(me.fame.mediaFriendliness - SKIP_STAGE_MEDIA, 0, 100);
      me.fame.promotionalTrust = clamp(me.fame.promotionalTrust - SKIP_STAGE_GOODWILL, 0, 100);
    }
    // Recorded as a moment rather than subtracted from the total, because the weekly recompute
    // rebuilds the total from the moments and would have erased a direct subtraction.
    if (hypeStore(save)[task.boutId]) {
      addHypeMoment(save, task.boutId, `${me.name} skipped the ${task.stage.replace(/-/g, ' ')}`, -SKIP_STAGE_HYPE);
    }
  }
  return task;
}

/** What skipping one optional fight week obligation costs. Small, and not nothing. */
export const SKIP_STAGE_GOODWILL = 3;
export const SKIP_STAGE_MEDIA = 4;
export const SKIP_STAGE_HYPE = 2;

/** Opens the second weigh in attempt. Only reachable after a missed official weigh in. */
export function openSecondAttempt(save: SaveGame, boutId: BoutId): FightWeekTask | null {
  const bout = save.bouts[boutId];
  if (!bout) return null;
  if (!save.fightWeek) save.fightWeek = {};
  const id = taskId(boutId, 'second-weigh-in-attempt');
  if (save.fightWeek[id]) return save.fightWeek[id];
  const task: FightWeekTask = {
    id,
    boutId,
    stage: 'second-weigh-in-attempt',
    dueOn: save.date,
    mandatory: true,
    status: 'available',
    actionLabel: ACTION_LABEL['second-weigh-in-attempt'],
    detail: 'One more hour on the clock to make the contracted weight.',
    outcome: null,
    resolvedOn: null,
  };
  save.fightWeek[id] = task;
  return task;
}

/** Removes every task for a bout that is no longer happening. */
export function clearFightWeek(save: SaveGame, boutId: BoutId): number {
  if (!save.fightWeek) return 0;
  let removed = 0;
  for (const id of Object.keys(save.fightWeek)) {
    if (save.fightWeek[id].boutId === boutId) {
      delete save.fightWeek[id];
      removed++;
    }
  }
  return removed;
}

/** Drops fight week records for bouts that finished long ago, keeping saves small. */
export function pruneFightWeek(save: SaveGame, keepDays = 400): number {
  if (!save.fightWeek) return 0;
  let removed = 0;
  for (const id of Object.keys(save.fightWeek)) {
    const task = save.fightWeek[id];
    const bout = save.bouts[task.boutId];
    if (!bout) {
      delete save.fightWeek[id];
      removed++;
      continue;
    }
    if (bout.status !== 'scheduled' && daysBetween(bout.date, save.date) > keepDays) {
      delete save.fightWeek[id];
      removed++;
    }
  }
  return removed;
}


/** What an automatic stage reports. These are statuses, not decisions. */
function automaticOutcome(save: SaveGame, boutId: BoutId, stage: FightWeekStage): string {
  const bout = save.bouts[boutId];
  const event = bout ? save.events[bout.eventId] : null;
  const city = event ? `${event.city}, ${event.country}` : 'the host city';
  switch (stage) {
    case 'travel':
      return `Travel to ${city} was arranged by the promotion.`;
    case 'arrival':
      return `You arrived in ${city} for fight week.`;
    case 'medical-exam':
      return 'Pre fight medicals were completed with the commission.';
    default:
      return 'Done.';
  }
}
