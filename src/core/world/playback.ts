import { formatClock } from '../types/common';
import { isFinish, METHOD_LABEL, type FightEvent, type FightResult, type RoundStatLine } from '../types/fight';

/**
 * Fight playback.
 *
 * All three presentation modes replay one stored deterministic result. None of them runs a
 * second simulation, so live, round by round and instant always agree.
 *
 * The state machine exists because the old presentation could show a completed round panel
 * for a round that ended in a knockout, offer a continue button after the fight was over,
 * and describe a round as ending normally when the referee had stopped it.
 */

export type PlaybackState =
  | 'preparing'
  | 'ready'
  | 'round-intro'
  | 'round-active'
  | 'round-paused'
  | 'round-complete'
  | 'between-rounds'
  | 'doctor-review'
  | 'referee-review'
  | 'fight-finished'
  | 'scoring'
  | 'announcing'
  | 'post-fight'
  | 'error';

export const PLAYBACK_LABEL: Record<PlaybackState, string> = {
  preparing: 'Preparing the fight',
  ready: 'Ready to begin',
  'round-intro': 'Round about to start',
  'round-active': 'Round in progress',
  'round-paused': 'Paused',
  'round-complete': 'Round complete',
  'between-rounds': 'Between rounds',
  'doctor-review': 'Doctor is looking at it',
  'referee-review': 'Referee has intervened',
  'fight-finished': 'The fight is over',
  scoring: 'Scorecards being collected',
  announcing: 'Official result',
  'post-fight': 'Post fight',
  error: 'Something went wrong',
};

/** The index of the event that officially ends the fight, or null for a decision. */
export function finishingEventIndex(result: FightResult): number | null {
  if (!isFinish(result.method)) return null;
  const events = result.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.importance === 'decisive') return i;
    if (e.result === 'tapped' || e.result === 'technical-submission') return i;
  }
  return events.length > 0 ? events.length - 1 : null;
}

/** How many events belong to a given round. */
export function eventsInRound(result: FightResult, round: number): FightEvent[] {
  return (result.events ?? []).filter((e) => e.round === round);
}

/** The last event index belonging to a round, inclusive. */
export function lastIndexOfRound(result: FightResult, round: number): number {
  const events = result.events ?? [];
  let last = -1;
  for (let i = 0; i < events.length; i++) if (events[i].round === round) last = i;
  return last;
}

/**
 * The index playback should stop at.
 *
 * For a finish this is the finishing event: nothing after it is shown, because nothing
 * after it happened in the fight.
 */
export function playbackEndIndex(result: FightResult): number {
  const finish = finishingEventIndex(result);
  if (finish !== null) return finish;
  return Math.max(0, (result.events ?? []).length - 1);
}

/** True when this round is the one the fight ended in. */
export function roundEndedFight(result: FightResult, round: number): boolean {
  return result.endRound === round;
}

/** True when the fight ended inside this round by something other than the horn. */
export function roundEndedByFinish(result: FightResult, round: number): boolean {
  return roundEndedFight(result, round) && isFinish(result.method);
}

export interface RoundSummary {
  round: number;
  /** True when the round ran to the scheduled horn. */
  completedNormally: boolean;
  headline: string;
  lines: string[];
  /** Only present for a finish. */
  finish: {
    winner: string;
    loser: string;
    method: string;
    time: string;
    action: string;
    position: string;
    officialNote: string | null;
    wasComeback: boolean;
    hadBeenHurt: boolean;
  } | null;
}

function statFor(result: FightResult, round: number, side: 'a' | 'b'): RoundStatLine | null {
  const r = result.rounds.find((x) => x.round === round);
  if (!r) return null;
  return side === 'a' ? r.statsA ?? null : r.statsB ?? null;
}

function describeAction(e: FightEvent | undefined): string {
  if (!e) return 'the finishing sequence';
  const a = e.action;
  switch (a.kind) {
    case 'strike':
      return a.name.replace(/-/g, ' ');
    case 'submission':
      return a.name.replace(/-/g, ' ');
    case 'wrestle':
      return a.name.replace(/-/g, ' ');
    case 'grapple':
      return a.name.replace(/-/g, ' ');
    default:
      return 'the finishing sequence';
  }
}

function positionLabel(p: string): string {
  return p.replace(/-/g, ' ');
}

/**
 * Builds the summary for one round.
 *
 * A round that ended the fight gets a finish specific summary and never the normal one.
 * The normal summary is built from what actually happened rather than from filler.
 */
export function summarizeRound(result: FightResult, round: number, nameA: string, nameB: string): RoundSummary {
  const endedHere = roundEndedFight(result, round);
  const finished = endedHere && isFinish(result.method);
  const events = eventsInRound(result, round);
  const statsA = statFor(result, round, 'a');
  const statsB = statFor(result, round, 'b');

  if (finished) {
    const idx = finishingEventIndex(result);
    const finishing = idx !== null ? (result.events ?? [])[idx] : undefined;
    const winnerName = result.winnerId === result.fighterAId ? nameA : nameB;
    const loserName = result.winnerId === result.fighterAId ? nameB : nameA;
    // Being hurt earlier in the round, then winning it, is a comeback.
    const hurtEarlier = events.some(
      (e) => e.defenderId === result.winnerId && (e.tags.includes('stun') || e.tags.includes('knockdown'))
    );
    const officialNote =
      result.method === 'doctor-stoppage'
        ? 'The doctor stopped it between the action.'
        : result.method === 'corner-stoppage'
          ? 'The corner threw in the towel.'
          : result.method === 'disqualification'
            ? 'The referee ruled a disqualification.'
            : result.method === 'tko-strikes' || result.method === 'tko-ground-strikes'
              ? 'The referee stepped in.'
              : null;

    return {
      round,
      completedNormally: false,
      headline: `${winnerName} wins by ${METHOD_LABEL[result.method].toLowerCase()} at ${formatClock(result.endTimeSeconds)} of round ${round}`,
      lines: [
        `${winnerName} finished ${loserName} with ${describeAction(finishing)} from ${positionLabel(finishing?.stateBefore ?? 'the exchange')}.`,
        officialNote ?? `The official time is ${formatClock(result.endTimeSeconds)} of round ${round}.`,
        hurtEarlier ? `${winnerName} had been hurt earlier in the round.` : '',
      ].filter(Boolean),
      finish: {
        winner: winnerName,
        loser: loserName,
        method: METHOD_LABEL[result.method],
        time: formatClock(result.endTimeSeconds),
        action: describeAction(finishing),
        position: positionLabel(finishing?.stateBefore ?? 'unknown'),
        officialNote,
        wasComeback: hurtEarlier,
        hadBeenHurt: hurtEarlier,
      },
    };
  }

  // A fight that goes the distance ends in its final round, but that round still reached
  // the horn and gets a normal summary. Only a bout cut short without a finish, such as a
  // technical decision or a no contest, gets the early ending treatment.
  const endedEarly = endedHere && !isFinish(result.method) && result.endRound < result.scheduledRounds;
  if (endedEarly) {
    return {
      round,
      completedNormally: false,
      headline: `The fight ends in round ${round}: ${METHOD_LABEL[result.method]}`,
      lines: [
        result.method === 'no-contest'
          ? 'The result was invalidated and the bout is a no contest.'
          : 'The bout went to the scorecards early.',
      ],
      finish: null,
    };
  }

  // A normal completed round. Everything here comes from the recorded statistics and the
  // event stream, so a round is never described as close when it was not.
  const lines: string[] = [];
  if (statsA && statsB) {
    const sigA = statsA.sigStrikesLanded;
    const sigB = statsB.sigStrikesLanded;
    const leader = sigA === sigB ? null : sigA > sigB ? nameA : nameB;
    lines.push(`Significant strikes: ${nameA} ${sigA}, ${nameB} ${sigB}.`);
    if (statsA.knockdowns + statsB.knockdowns > 0) {
      lines.push(
        `Knockdowns: ${nameA} ${statsA.knockdowns}, ${nameB} ${statsB.knockdowns}.`
      );
    }
    if (statsA.takedownsLanded + statsB.takedownsLanded > 0) {
      lines.push(`Takedowns: ${nameA} ${statsA.takedownsLanded} of ${statsA.takedownsAttempted}, ${nameB} ${statsB.takedownsLanded} of ${statsB.takedownsAttempted}.`);
    }
    if (statsA.submissionAttempts + statsB.submissionAttempts > 0) {
      lines.push(`Submission attempts: ${nameA} ${statsA.submissionAttempts}, ${nameB} ${statsB.submissionAttempts}.`);
    }
    const controlA = Math.round(statsA.controlSeconds);
    const controlB = Math.round(statsB.controlSeconds);
    if (controlA + controlB > 20) lines.push(`Control time: ${nameA} ${formatClock(controlA)}, ${nameB} ${formatClock(controlB)}.`);
    if (statsA.fouls + statsB.fouls > 0) lines.push(`Fouls: ${nameA} ${statsA.fouls}, ${nameB} ${statsB.fouls}.`);

    const biggest = events
      .filter((e) => e.importance === 'major' || e.importance === 'decisive')
      .sort((x, y) => y.scoreImpact - x.scoreImpact)[0];
    if (biggest) {
      const actor = biggest.actorId === result.fighterAId ? nameA : nameB;
      lines.push(`Best moment: ${actor} with ${describeAction(biggest)} from ${positionLabel(biggest.stateBefore)}.`);
    }
    const closing = events[events.length - 1];
    if (closing) {
      const actor = closing.actorId === result.fighterAId ? nameA : nameB;
      lines.push(`The round closed with ${actor} in ${positionLabel(closing.stateAfter)}.`);
    }

    const headline = leader
      ? `Round ${round} to ${leader} on volume`
      : `Round ${round} finishes level on significant strikes`;
    return { round, completedNormally: true, headline, lines, finish: null };
  }

  // Background fights keep only totals. Say that rather than inventing round detail.
  return {
    round,
    completedNormally: true,
    headline: `Round ${round} complete`,
    lines: ['Round by round detail was not retained for this bout.'],
    finish: null,
  };
}

/** Playback speeds. Deliberately unhurried: the fastest live speed is still readable. */
export const PLAYBACK_SPEEDS: { key: string; label: string; ms: number }[] = [
  { key: 'pause', label: 'Pause', ms: 0 },
  { key: 'very-slow', label: 'Very slow', ms: 2600 },
  { key: 'slow', label: 'Slow', ms: 1700 },
  { key: 'normal', label: 'Normal', ms: 1100 },
  { key: 'brisk', label: 'Brisk', ms: 700 },
];

export const DEFAULT_SPEED = 'normal';

/** Milliseconds to hold on an event, scaled by how important it is. */
export function holdFor(event: FightEvent | undefined, baseMs: number): number {
  if (!event) return baseMs;
  switch (event.importance) {
    case 'decisive':
      return Math.round(baseMs * 3.2);
    case 'major':
      return Math.round(baseMs * 2.1);
    case 'notable':
      return Math.round(baseMs * 1.4);
    case 'minor':
      return baseMs;
    default:
      return Math.round(baseMs * 0.75);
  }
}

/** Which state playback should be in given how far through the stored result it is. */
export function stateForIndex(result: FightResult | null, index: number, running: boolean): PlaybackState {
  if (!result) return 'preparing';
  const end = playbackEndIndex(result);
  if (index >= end) {
    return isFinish(result.method) ? 'fight-finished' : 'scoring';
  }
  return running ? 'round-active' : 'round-paused';
}

/** The round the given event index sits in. */
export function roundAtIndex(result: FightResult, index: number): number {
  const events = result.events ?? [];
  if (events.length === 0) return 1;
  const clamped = Math.max(0, Math.min(index, events.length - 1));
  return events[clamped].round;
}


// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * What the screen is allowed to show right now.
 *
 * One selector, so no component has to decide for itself whether the result exists yet.
 * Scattered `result !== null` checks were how the winner, the method and the scorecards
 * could all appear before a single event had been revealed.
 */
export interface FightVisibility {
  /** True once the fight has been simulated at all. */
  hasResult: boolean;
  /** True once playback has reached the end. Everything unlocks here. */
  concluded: boolean;
  showWinner: boolean;
  showMethod: boolean;
  showScorecards: boolean;
  showFinalStats: boolean;
  showMoney: boolean;
  showRankings: boolean;
  showBonuses: boolean;
  showInjuries: boolean;
  showPostFightTasks: boolean;
  /** The highest round whose summary may be shown. Zero means none. */
  maxSummarizedRound: number;
  /** Rounds whose statistics may be shown. */
  visibleRounds: number[];
  /** True during the scorecard reveal, before the winner is named. */
  collectingScorecards: boolean;
  state: PlaybackState;
}

export interface VisibilityInput {
  result: FightResult | null;
  /** How many events have been revealed. */
  revealed: number;
  /** Instant mode reveals everything at once, but still after a visible processing step. */
  mode: 'instant' | 'live' | 'rounds';
  /** True while the result reveal is being animated in instant mode. */
  revealing?: boolean;
}

export function fightVisibility(input: VisibilityInput): FightVisibility {
  const { result, revealed, mode } = input;
  if (!result) {
    return {
      hasResult: false,
      concluded: false,
      showWinner: false,
      showMethod: false,
      showScorecards: false,
      showFinalStats: false,
      showMoney: false,
      showRankings: false,
      showBonuses: false,
      showInjuries: false,
      showPostFightTasks: false,
      maxSummarizedRound: 0,
      visibleRounds: [],
      collectingScorecards: false,
      state: 'preparing',
    };
  }

  const end = playbackEndIndex(result);
  const total = (result.events ?? []).length;
  // With no stored events there is nothing to reveal, so the result is immediately visible.
  const concluded = total === 0 ? true : mode === 'instant' ? !input.revealing : revealed > end;
  const currentRound = total === 0 ? result.endRound : roundAtIndex(result, Math.max(0, revealed - 1));

  // A round summary appears only after that round has reached its horn. The round being
  // played is never summarized, and no later round is ever visible.
  let maxSummarized = 0;
  if (concluded) {
    maxSummarized = result.endRound;
  } else {
    const lastOfCurrent = lastIndexOfRound(result, currentRound);
    maxSummarized = revealed > lastOfCurrent && lastOfCurrent >= 0 ? currentRound : currentRound - 1;
  }
  maxSummarized = Math.max(0, Math.min(maxSummarized, result.endRound));

  const decision = !isFinish(result.method);
  const collecting = concluded && decision;

  return {
    hasResult: true,
    concluded,
    showWinner: concluded,
    showMethod: concluded,
    showScorecards: concluded,
    showFinalStats: concluded,
    showMoney: concluded,
    showRankings: concluded,
    showBonuses: concluded,
    showInjuries: concluded,
    showPostFightTasks: concluded,
    maxSummarizedRound: maxSummarized,
    visibleRounds: Array.from({ length: maxSummarized }, (_, i) => i + 1),
    collectingScorecards: collecting,
    state: concluded
      ? isFinish(result.method)
        ? 'fight-finished'
        : 'scoring'
      : mode === 'live'
        ? 'round-active'
        : 'round-paused',
  };
}
