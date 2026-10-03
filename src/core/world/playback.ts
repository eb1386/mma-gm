import { formatClock } from '../types/common';
import { isFinish, METHOD_LABEL, METHOD_PHRASE, type FightEvent, type FightResult, type RoundStatLine } from '../types/fight';

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
      headline: `${winnerName} wins by ${METHOD_PHRASE[result.method]} at ${formatClock(result.endTimeSeconds)} of round ${round}`,
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

    // The headline names the fighter the ringside read gives the round to, and why. Naming the
    // busier striker called a round "to X on volume" when the other man had held him down for four
    // minutes of it and won it clearly.
    const r = result.rounds.find((x) => x.round === round);
    const margin = r ? r.trueScoreA : sigA - sigB;
    let headline: string;
    if (Math.abs(margin) < 2.4) {
      headline = sigA === sigB ? `Round ${round} finishes level on significant strikes` : `Round ${round} is too close to call`;
    } else {
      const aWon = margin > 0;
      const w = aWon ? statsA : statsB;
      const l = aWon ? statsB : statsA;
      const why =
        w.knockdowns > l.knockdowns
          ? 'on the knockdown'
          : w.controlSeconds > l.controlSeconds + 60 && w.controlSeconds > 90
            ? 'on control'
            : w.sigStrikesLanded > l.sigStrikesLanded
              ? 'on volume'
              : w.takedownsLanded > l.takedownsLanded
                ? 'on the takedowns'
                : 'on the heavier shots';
      headline = `Round ${round} to ${aWon ? nameA : nameB} ${why}`;
    }
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

/**
 * Playback speeds. Deliberately unhurried: the fastest live speed is still readable.
 *
 * Pausing is its own control rather than a speed, so resuming returns to the speed the player
 * chose. The keys match the settings values, so the saved Live text speed is the starting speed;
 * the fastest key used to be 'brisk', which the 'fast' setting never matched.
 */
export const PLAYBACK_SPEEDS: { key: string; label: string; ms: number }[] = [
  { key: 'very-slow', label: 'Very slow', ms: 2600 },
  { key: 'slow', label: 'Slow', ms: 1700 },
  { key: 'normal', label: 'Normal', ms: 1100 },
  { key: 'fast', label: 'Fast', ms: 650 },
];

export const DEFAULT_SPEED = 'normal';

/** The playback speed for a saved setting, falling back to the default for anything unknown. */
export function speedForSetting(setting: string | undefined): string {
  return PLAYBACK_SPEEDS.some((s) => s.key === setting) ? (setting as string) : DEFAULT_SPEED;
}

/**
 * How long the break between rounds lasts in live playback.
 *
 * Long enough to read the round card, short enough that a player who only wants the fight is
 * not left waiting. The card has a button to start the next round at once.
 */
export function intermissionFor(baseMs: number): number {
  return Math.max(4500, Math.round(baseMs * 5));
}

/** How long the finish or the final horn is held before the official result is read. */
export function announcementHoldFor(baseMs: number, decision: boolean): number {
  return decision ? Math.max(1800, baseMs * 1.8) : Math.max(1600, baseMs * 1.6);
}

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
  // A decision is read out the moment playback reaches the end; the cards are on screen beside it.
  // Returning 'scoring' here left the tag saying the scorecards were still being collected next to
  // the announced result.
  if (index >= end) {
    return isFinish(result.method) ? 'fight-finished' : 'announcing';
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
  state: PlaybackState;
}

export interface VisibilityInput {
  result: FightResult | null;
  /** How many events have been revealed. */
  revealed: number;
  /** Instant mode reveals everything at once, but still after a visible processing step. */
  mode: 'instant' | 'live' | 'rounds';
  /** True while the result is being revealed: the processing step in instant mode, the announcement otherwise. */
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
      state: 'preparing',
    };
  }

  const end = playbackEndIndex(result);
  const total = (result.events ?? []).length;
  // With no stored events there is nothing to reveal, so the result is immediately visible. Live
  // and round by round playback also hold the result while it is being announced: the finish or
  // the final horn lands first, then the result is read out.
  const concluded = total === 0 ? true : mode === 'instant' ? !input.revealing : revealed > end && !input.revealing;
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
    state: concluded
      ? isFinish(result.method)
        ? 'fight-finished'
        : 'announcing'
      : mode === 'live'
        ? 'round-active'
        : 'round-paused',
  };
}

// ---------------------------------------------------------------------------
// Live broadcast state
// ---------------------------------------------------------------------------

/**
 * The moments a broadcast would stop and point at.
 *
 * Read from the event's own tags and action, so a moment is only ever called when the simulation
 * recorded it. Nothing here invents drama the fight did not have.
 */
export type MomentKind =
  | 'finish'
  | 'knockdown'
  | 'rocked'
  | 'submission-danger'
  | 'submission-attempt'
  | 'survived'
  | 'takedown'
  | 'reversal'
  | 'back-take'
  | 'cut'
  | 'deduction'
  | 'doctor';

/** The moments big enough for the banner and for the skip to the next big moment. */
export const BIG_MOMENTS: ReadonlySet<MomentKind> = new Set<MomentKind>(['finish', 'knockdown', 'rocked', 'submission-danger', 'deduction', 'doctor']);

export const MOMENT_LABEL: Record<MomentKind, string> = {
  finish: 'Finish',
  knockdown: 'Knockdown',
  rocked: 'Rocked',
  'submission-danger': 'Locked in',
  'submission-attempt': 'Submission',
  survived: 'Survived',
  takedown: 'Takedown',
  reversal: 'Reversal',
  'back-take': 'Back taken',
  cut: 'Cut',
  deduction: 'Point taken',
  doctor: 'Doctor',
};

export function momentOf(e: FightEvent | undefined): MomentKind | null {
  if (!e) return null;
  if (e.tags.includes('finish')) return 'finish';
  if (e.tags.includes('knockdown') || e.tags.includes('leg-drop')) return 'knockdown';
  if (e.tags.includes('submission-secured')) return 'submission-danger';
  if (e.tags.includes('stun')) return 'rocked';
  const a = e.action;
  if (a.kind === 'referee') {
    if (a.name === 'point-deduction') return 'deduction';
    if (a.name === 'doctor-check') return 'doctor';
    return null;
  }
  if (a.kind === 'submission') {
    if (a.stage === 'entry' && e.result === 'completed') return 'submission-attempt';
    if (a.stage === 'adjustment') return 'survived';
    return null;
  }
  if (e.tags.includes('takedown')) return 'takedown';
  if (a.kind === 'grapple' && a.name === 'take-back' && e.result === 'completed') return 'back-take';
  if (e.tags.includes('sweep') || (a.kind === 'grapple' && a.name === 'reversal' && e.result === 'reversed')) return 'reversal';
  if (e.tags.includes('cut')) return 'cut';
  return null;
}

export function isBigMoment(e: FightEvent | undefined): boolean {
  const m = momentOf(e);
  return m !== null && BIG_MOMENTS.has(m);
}

export interface LiveSide {
  /** Accumulated damage as a 0 to 100 meter. */
  damage: number;
  damageLabel: string;
  knockdowns: number;
  rocked: number;
  takedowns: number;
  submissionAttempts: number;
  /** Cardio as recorded at the last horn, or null before the first one. */
  cardio: number | null;
  /** Knocked down or rocked in the last few seconds of this round. */
  inTrouble: boolean;
}

export interface LiveState {
  round: number;
  clockSecondsRemaining: number;
  a: LiveSide;
  b: LiveSide;
  /** Who has the fight's recent run of play, from -1 (fully B) to 1 (fully A). */
  momentum: number;
  /** A's share of what has scored in the round so far, 0 to 1. Half when nothing has. */
  roundShareA: number;
  /** The index of the most recent big moment revealed, or null. */
  lastBigMomentIndex: number | null;
}

/** Damage pools weighted the way a viewer reads them: the head first, the legs least. */
function damageScore(d: { head: number; body: number; legLeft: number; legRight: number }): number {
  return d.head + d.body * 0.6 + (d.legLeft + d.legRight) * 0.3;
}

/** Seconds after a knockdown or a stun in which a fighter is still shown as in trouble. */
const TROUBLE_WINDOW = 25;

function damageLabel(meter: number): string {
  if (meter < 12) return 'Fresh';
  if (meter < 35) return 'Marked up';
  if (meter < 65) return 'Taking damage';
  return 'Badly hurt';
}

/**
 * Everything the scoreboard shows, from the events revealed so far and nothing later.
 *
 * Damage starts from the pools recorded at the last horn, which already include the recovery
 * between rounds, and adds what has landed since. Cardio is only ever the horn reading: the
 * engine's in round drain is not in the event stream, and a guessed number that jumped at the
 * horn would be worse than an honest one that updates once a round.
 */
export function liveState(result: FightResult, revealed: number): LiveState {
  const events = result.events ?? [];
  const shown = Math.max(0, Math.min(revealed, events.length));
  const last = shown > 0 ? events[shown - 1] : undefined;
  const round = last ? last.round : 1;
  const clock = last ? last.clockSecondsRemaining : 300;
  const aId = result.fighterAId;

  // The last horn heard is the end of the previous round, or this one once its last event is out.
  const roundOver = last !== undefined && lastIndexOfRound(result, round) === shown - 1 && !roundEndedByFinish(result, round);
  const hornRound = roundOver ? round : round - 1;
  const horn = hornRound >= 1 ? result.rounds.find((r) => r.round === hornRound) : undefined;
  const baselineRound = horn?.damageEndA && horn?.damageEndB ? hornRound : 0;

  const side = (): LiveSide => ({ damage: 0, damageLabel: 'Fresh', knockdowns: 0, rocked: 0, takedowns: 0, submissionAttempts: 0, cardio: null, inTrouble: false });
  const a = side();
  const b = side();
  let dmgA = horn && baselineRound ? damageScore(horn.damageEndA!) : 0;
  let dmgB = horn && baselineRound ? damageScore(horn.damageEndB!) : 0;
  let momentum = 0;
  let scoreA = 0;
  let scoreB = 0;
  let lastBig: number | null = null;
  let troubleA = -1;
  let troubleB = -1;
  let prevRound = 1;

  for (let i = 0; i < shown; i++) {
    const e = events[i];
    const actorA = e.actorId === aId;
    const actor = actorA ? a : b;
    if (e.round !== prevRound) {
      // A minute in the corner takes most of the heat out of a run of play.
      momentum *= 0.35;
      prevRound = e.round;
    }
    if (e.round > baselineRound) {
      const hit = damageScore(e.damage);
      if (actorA) dmgB += hit;
      else dmgA += hit;
    }
    if (e.round === round) {
      if (actorA) scoreA += Math.max(0, e.scoreImpact);
      else scoreB += Math.max(0, e.scoreImpact);
    }
    const moment = momentOf(e);
    let weight = Math.max(0, e.scoreImpact);
    if (moment === 'knockdown') {
      actor.knockdowns++;
      weight += 5;
    } else if (moment === 'rocked') {
      actor.rocked++;
      weight += 2.5;
    } else if (moment === 'takedown') {
      actor.takedowns++;
    } else if (moment === 'submission-danger') {
      weight += 2;
    }
    if (moment === 'submission-attempt') actor.submissionAttempts++;
    if (moment === 'knockdown' || moment === 'rocked') {
      if (actorA) troubleB = i;
      else troubleA = i;
    }
    if (moment && BIG_MOMENTS.has(moment)) lastBig = i;
    momentum = momentum * 0.86 + (actorA ? weight : -weight);
  }

  const inTrouble = (idx: number) => {
    if (idx < 0 || !last) return false;
    const e = events[idx];
    return e.round === round && e.clockSecondsRemaining - clock <= TROUBLE_WINDOW && !roundOver;
  };
  a.inTrouble = inTrouble(troubleA);
  b.inTrouble = inTrouble(troubleB);
  a.damage = Math.min(100, (dmgA / 140) * 100);
  b.damage = Math.min(100, (dmgB / 140) * 100);
  a.damageLabel = damageLabel(a.damage);
  b.damageLabel = damageLabel(b.damage);
  a.cardio = horn?.staminaEndA ?? null;
  b.cardio = horn?.staminaEndB ?? null;

  return {
    round,
    clockSecondsRemaining: clock,
    a,
    b,
    momentum: Math.tanh(momentum / 6),
    roundShareA: (scoreA + 1) / (scoreA + scoreB + 2),
    lastBigMomentIndex: lastBig,
  };
}

/**
 * Where the skip to the next big moment lands: just after the next big moment, or at the horn of
 * the round being played if none comes first.
 *
 * Stopping at the horn means the control never says whether anything big is still to come, and
 * so never hints at how the fight ends.
 */
export function nextBigMomentStop(result: FightResult, revealed: number): number {
  const events = result.events ?? [];
  const end = playbackEndIndex(result) + 1;
  if (revealed >= end) return end;
  const round = events[revealed].round;
  const horn = Math.min(end, lastIndexOfRound(result, round) + 1);
  for (let i = revealed; i < horn; i++) if (isBigMoment(events[i])) return i + 1;
  return horn;
}

/** Where skipping to the end of the round in play lands. */
export function roundEndStop(result: FightResult, revealed: number): number {
  const events = result.events ?? [];
  const end = playbackEndIndex(result) + 1;
  if (revealed >= end) return end;
  return Math.min(end, lastIndexOfRound(result, events[revealed].round) + 1);
}

/** True when the revealed events end exactly on a horn and another round is still to come. */
export function atRoundBreak(result: FightResult, revealed: number): boolean {
  const events = result.events ?? [];
  if (revealed <= 0 || revealed > playbackEndIndex(result)) return false;
  return events[revealed].round > events[revealed - 1].round;
}

export interface RoundRead {
  leader: 'a' | 'b' | null;
  /** Plain words, never the number unless a setting reveals it. */
  text: string;
  clear: boolean;
}

/**
 * The unofficial read of a finished round: who a ringside viewer would have given it to.
 *
 * The same thresholds the round summaries tab has always used, so the two never disagree.
 */
export function roundRead(result: FightResult, round: number, nameA: string, nameB: string): RoundRead | null {
  const r = result.rounds.find((x) => x.round === round);
  if (!r) return null;
  const m = r.trueScoreA;
  if (Math.abs(m) < 2.4) return { leader: null, text: 'too close to call', clear: false };
  const clear = Math.abs(m) > 17;
  const leader = m > 0 ? 'a' : 'b';
  return { leader, text: `${leader === 'a' ? nameA : nameB} by ${clear ? 'a clear margin' : 'a narrow margin'}`, clear };
}
