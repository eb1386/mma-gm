import { Rng } from '../rng';
import { formatClock } from '../types/common';
import type { FightEvent, FightResult, RoundResult, RoundStatLine } from '../types/fight';
import { SUBMISSION_LABEL } from '../sim/resolve';
import {
  BLOCK_VERB,
  CLEAN_ADVERB,
  CONTROL_PHRASE,
  CORNER_ADVICE,
  FEELING_OUT,
  FIGHT_START,
  FOUL_NAME,
  HURT_PHRASE,
  KNOCKDOWN_PHRASE,
  LAND_VERB,
  MISS_VERB,
  MOMENTUM_PHRASE,
  PARTIAL_VERB,
  POSITION_NAME,
  RANGE_CHANGE_PHRASE,
  REFEREE_PHRASE,
  SLIP_VERB,
  STRIKE_NOUN,
  SUBMISSION_ENTRY_VERB,
  SUBMISSION_ESCAPE_PHRASE,
  SUBMISSION_TAP_PHRASE,
  SUBMISSION_TECHNICAL_PHRASE,
  TAKEDOWN_VERB,
} from './lexicon';

export interface NarrativeFighter {
  id: string;
  name: string;
  lastName: string;
  nickname: string | null;
}

/**
 * Tracks what has already been said so the same construction does not appear twice in
 * quick succession. This is the difference between a template engine and something that
 * reads like commentary.
 */
class AntiRepeat {
  private recent = new Map<string, string[]>();
  private window: number;

  constructor(window = 6) {
    this.window = window;
  }

  pick(rng: Rng, bucket: string, options: readonly string[]): string {
    if (options.length === 0) return '';
    const used = this.recent.get(bucket) ?? [];
    const fresh = options.filter((o) => !used.includes(o));
    const pool = fresh.length > 0 ? fresh : options;
    const choice = rng.pick(pool);
    used.push(choice);
    while (used.length > Math.min(this.window, options.length - 1)) used.shift();
    this.recent.set(bucket, used);
    return choice;
  }

  /** Returns true when this exact structure was used too recently to reuse. */
  structureBlocked(key: string): boolean {
    const used = this.recent.get('__structure') ?? [];
    return used.includes(key);
  }

  markStructure(key: string): void {
    const used = this.recent.get('__structure') ?? [];
    used.push(key);
    while (used.length > 4) used.shift();
    this.recent.set('__structure', used);
  }

  reset(): void {
    this.recent.clear();
  }
}

export class FightNarrator {
  private rng: Rng;
  private anti = new AntiRepeat();
  private a: NarrativeFighter;
  private b: NarrativeFighter;
  /** Counts how often each fighter has been named recently, to vary the reference form. */
  private nameUse = new Map<string, number>();
  private lastMomentumHolder: string | null = null;
  /** Exact sentences emitted recently, so the same line never appears twice in a row. */
  private recentSentences: string[] = [];

  constructor(a: NarrativeFighter, b: NarrativeFighter, seed: number) {
    this.a = a;
    this.b = b;
    this.rng = new Rng(seed ^ 0x5eed10);
  }

  private who(id: string): NarrativeFighter {
    return id === this.a.id ? this.a : this.b;
  }

  /** Varies between surname, full name and nickname so the prose does not drone. */
  private ref(id: string, forceLast = false): string {
    const f = this.who(id);
    const count = (this.nameUse.get(id) ?? 0) + 1;
    this.nameUse.set(id, count);
    if (forceLast) return f.lastName;
    if (count % 9 === 1) return f.name;
    if (f.nickname && count % 13 === 0) return `"${f.nickname}" ${f.lastName}`;
    return f.lastName;
  }

  fightStart(): string {
    return this.anti.pick(this.rng, 'start', FIGHT_START);
  }

  feelingOut(): string {
    return this.anti.pick(this.rng, 'feel', FEELING_OUT);
  }

  /**
   * Renders one semantic event. The renderer reads the event only. It never inspects or
   * modifies simulation state, so commentary can never change what happened.
   */
  render(e: FightEvent): string | null {
    const text = this.renderRaw(e);
    if (text === null) return null;
    // A sentence that has just been said is dropped unless the moment is important
    // enough that leaving it out would break the account of the fight.
    if (this.recentSentences.includes(text)) {
      if (e.importance === 'trivial' || e.importance === 'minor') return null;
      const varied = `${text.slice(0, -1)} again.`;
      if (this.recentSentences.includes(varied)) return null;
      this.remember(varied);
      return varied;
    }
    this.remember(text);
    return text;
  }

  private remember(text: string): void {
    this.recentSentences.push(text);
    if (this.recentSentences.length > 8) this.recentSentences.shift();
  }

  private renderRaw(e: FightEvent): string | null {
    const actor = this.ref(e.actorId);
    const target = this.ref(e.defenderId, true);

    switch (e.action.kind) {
      case 'strike':
        return this.renderStrike(e, actor, target);
      case 'wrestle':
        return this.renderWrestle(e, actor, target);
      case 'grapple':
        return this.renderGrapple(e, actor, target);
      case 'submission':
        return this.renderSubmission(e, actor, target);
      case 'movement':
        return this.renderMovement(e, actor);
      case 'defense':
        return e.action.name === 'shell' && e.importance !== 'trivial' ? `${actor} tightens up behind the guard.` : null;
      case 'referee':
        return this.renderReferee(e, actor, target);
    }
  }

  private renderStrike(e: FightEvent, actor: string, target: string): string | null {
    if (e.action.kind !== 'strike') return null;
    const noun = this.anti.pick(this.rng, `noun-${e.action.name}`, STRIKE_NOUN[e.action.name]);
    const area = e.target === 'leg' ? 'the lead leg' : e.target === 'body' ? 'the body' : 'the head';

    if (e.result === 'clean-land') {
      const verb = this.anti.pick(this.rng, 'land-verb', LAND_VERB);
      // A noun such as "kick to the ribs" already names its target, so appending the
      // target clause again would read as a duplication.
      const nounNamesTarget = /\bto the\b|\bbody\b|\bleg\b|\bcalf\b|\bhead\b|\bhigh\b|upstairs/.test(noun);
      const structures = [
        `${actor} ${verb} a ${noun}.`,
        nounNamesTarget ? `${actor} ${verb} the ${noun}.` : `${actor} ${verb} the ${noun} to ${area}.`,
        `A ${noun} from ${actor} lands ${this.anti.pick(this.rng, 'clean', CLEAN_ADVERB)}.`,
        `${target} eats a ${noun}.`,
      ];
      let text = this.rng.pick(structures);
      if (e.tags.includes('knockdown')) {
        text = `${actor} ${verb} a ${noun} and ${target} ${this.anti.pick(this.rng, 'kd', KNOCKDOWN_PHRASE)}.`;
      } else if (e.tags.includes('stun')) {
        text = `${actor} ${verb} a ${noun} and ${target} ${this.anti.pick(this.rng, 'hurt', HURT_PHRASE)}.`;
      } else if (e.tags.includes('cut')) {
        text = `A ${noun} from ${actor} opens ${target} up.`;
      }
      return text;
    }
    if (e.result === 'partial-land') {
      return `${actor} ${this.anti.pick(this.rng, 'partial', PARTIAL_VERB)} a ${noun}.`;
    }
    if (e.result === 'blocked') {
      return e.importance === 'trivial' && this.rng.chance(0.55) ? null : `The ${noun} from ${actor} ${this.anti.pick(this.rng, 'block', BLOCK_VERB)}.`;
    }
    if (e.result === 'slipped') {
      return this.rng.chance(0.5) ? null : `${actor} throws the ${noun} and it ${this.anti.pick(this.rng, 'slip', SLIP_VERB)}.`;
    }
    return this.rng.chance(0.62) ? null : `${actor} ${this.anti.pick(this.rng, 'miss', MISS_VERB)} a ${noun}.`;
  }

  private renderWrestle(e: FightEvent, actor: string, target: string): string | null {
    if (e.action.kind !== 'wrestle') return null;
    const name = e.action.name;
    if (name === 'stand-up' || name === 'wall-walk') {
      if (e.result === 'completed') {
        return name === 'wall-walk' ? `${actor} wall walks back up to the feet.` : `${actor} works back to standing.`;
      }
      return this.rng.chance(0.5) ? null : `${actor} tries to get up and is dragged back down.`;
    }
    if (e.tags.includes('clinch-entry')) {
      return e.result === 'completed'
        ? `${actor} closes in and ties ${target} up${e.stateAfter === 'fence-clinch' ? ' against the fence' : ''}.`
        : this.rng.chance(0.5)
          ? null
          : `${actor} tries to tie up and ${target} circles away.`;
    }
    const td = this.anti.pick(this.rng, `td-${name}`, TAKEDOWN_VERB[name] ?? ['a takedown']);
    if (e.result === 'completed') {
      const structures = [
        `${actor} hits ${td} and puts ${target} on the mat.`,
        `${td.charAt(0).toUpperCase()}${td.slice(1)} from ${actor}, and the fight is on the ground.`,
        `${actor} finishes ${td} into ${POSITION_NAME[e.stateAfter]}.`,
      ];
      return this.rng.pick(structures);
    }
    if (e.result === 'partial') {
      return `${actor} gets in on ${td} and ${target} defends it to the fence.`;
    }
    if (e.tags.includes('counter-position')) {
      return `${actor} shoots ${td} and ${target} turns it around.`;
    }
    return `${actor} shoots ${td} and ${target} stuffs it.`;
  }

  private renderGrapple(e: FightEvent, actor: string, target: string): string | null {
    if (e.action.kind !== 'grapple') return null;
    const posAfter = POSITION_NAME[e.stateAfter];
    switch (e.action.name) {
      case 'advance-position':
        return e.result === 'completed'
          ? `${actor} passes into ${posAfter}.`
          : this.rng.chance(0.6)
            ? null
            : `${actor} works for the pass and ${target} holds the frames.`;
      case 'hold-position':
        return this.rng.chance(0.55) ? null : `${actor} ${this.anti.pick(this.rng, 'control', CONTROL_PHRASE)} from ${posAfter}.`;
      case 'rest-in-position':
        return this.rng.chance(0.7) ? null : `${actor} stalls out the position and catches a breath.`;
      case 'sweep':
        return e.result === 'reversed' ? `${actor} sweeps and comes up on top.` : this.rng.chance(0.6) ? null : `${actor} looks for the sweep and cannot get the angle.`;
      case 'reversal':
        return e.result === 'reversed' ? `${actor} reverses the position.` : null;
      case 'guard-recovery':
        return e.result === 'escaped'
          ? e.stateAfter === 'scramble'
            ? `${actor} fights the hips free and it turns into a scramble.`
            : `${actor} recovers to ${posAfter}.`
          : this.rng.chance(0.6) ? null : `${actor} tries to reset the guard and cannot.`;
      case 'escape-back':
        return e.result === 'escaped' ? `${actor} peels the hooks off and escapes to ${posAfter}.` : `${actor} fights the hands with the back taken.`;
      case 'take-back':
        return e.result === 'completed' ? `${actor} takes the back.` : null;
      case 'scramble-reset':
        return e.result === 'completed' ? `${actor} wins the scramble and lands on top.` : `The scramble goes ${target}'s way.`;
      case 'posture-up':
        return this.rng.chance(0.7) ? null : `${actor} postures up inside the guard.`;
      case 'turtle-transition':
        return `${actor} turns to the turtle.`;
      default:
        return null;
    }
  }

  private renderSubmission(e: FightEvent, actor: string, target: string): string | null {
    if (e.action.kind !== 'submission') return null;
    const label = SUBMISSION_LABEL[e.action.name];
    switch (e.action.stage) {
      case 'entry':
        return e.result === 'completed'
          ? `${actor} ${this.anti.pick(this.rng, 'sub-entry', SUBMISSION_ENTRY_VERB)} a ${label}.`
          : this.rng.chance(0.5)
            ? null
            : `${actor} reaches for a ${label} and cannot get it locked.`;
      case 'secured':
        return `${actor} has the ${label} locked up and ${target} is in trouble.`;
      case 'defense':
        return `${target} ${this.anti.pick(this.rng, 'sub-escape', SUBMISSION_ESCAPE_PHRASE)}.`;
      case 'adjustment':
        return `${target} rides out the ${label} and survives.`;
      case 'resolution':
        return e.result === 'technical-submission'
          ? `${target} ${this.anti.pick(this.rng, 'tech-sub', SUBMISSION_TECHNICAL_PHRASE)}. The ${label} is the finish.`
          : `${target} ${this.anti.pick(this.rng, 'tap', SUBMISSION_TAP_PHRASE)} to the ${label}.`;
    }
  }

  private renderMovement(e: FightEvent, actor: string): string | null {
    if (e.action.kind !== 'movement') return null;
    if (e.result === 'no-effect' && this.rng.chance(0.8)) return null;
    switch (e.action.name) {
      case 'press-forward':
        return this.rng.chance(0.55) ? null : `${actor} ${this.anti.pick(this.rng, 'closing', RANGE_CHANGE_PHRASE.closing)}.`;
      case 'retreat':
        return e.tags.includes('clinch-break')
          ? `${actor} breaks the clinch and gets back to range.`
          : this.rng.chance(0.68)
            ? null
            : `${actor} ${this.anti.pick(this.rng, 'opening', RANGE_CHANGE_PHRASE.opening)}.`;
      case 'circle':
        return this.rng.chance(0.75) ? null : `${actor} ${this.anti.pick(this.rng, 'circling', RANGE_CHANGE_PHRASE.circling)}.`;
      case 'feint':
        return this.rng.chance(0.7) ? null : `${actor} ${this.anti.pick(this.rng, 'feint', RANGE_CHANGE_PHRASE.feint)}.`;
      case 'reset':
        return e.tags.includes('let-up')
          ? `${actor} waves them back up rather than follow to the ground.`
          : e.tags.includes('clinch-break')
            ? `${actor} separates.`
            : null;
      case 'recover':
        return `${actor} buys a moment to clear the head.`;
    }
  }

  private renderReferee(e: FightEvent, actor: string, target: string): string | null {
    if (e.action.kind !== 'referee') return null;
    switch (e.action.name) {
      case 'stand-up':
        return this.anti.pick(this.rng, 'standup', REFEREE_PHRASE.standUp);
      case 'warning': {
        const foul = e.tags.find((t) => FOUL_NAME[t]);
        return foul ? `${actor} lands ${FOUL_NAME[foul]} and the referee warns them.` : this.anti.pick(this.rng, 'warn', REFEREE_PHRASE.warning);
      }
      case 'point-deduction': {
        const foul = e.tags.find((t) => FOUL_NAME[t]);
        return `${foul ? `${actor} lands ${FOUL_NAME[foul]}. ` : ''}${this.anti.pick(this.rng, 'deduct', REFEREE_PHRASE.deduction)} ${target} gets time to recover.`;
      }
      case 'doctor-check':
        return this.anti.pick(this.rng, 'doc', REFEREE_PHRASE.doctorCheck);
      case 'timeout':
      case 'break':
        return null;
    }
  }

  momentumShift(newHolderId: string): string | null {
    if (this.lastMomentumHolder === newHolderId) return null;
    this.lastMomentumHolder = newHolderId;
    return this.anti.pick(this.rng, 'momentum', MOMENTUM_PHRASE);
  }

  cornerAdvice(kind: keyof typeof CORNER_ADVICE): string {
    return this.anti.pick(this.rng, `corner-${kind}`, CORNER_ADVICE[kind]);
  }

  /**
   * Round summary built strictly from the round's own statistics. It names who had the
   * better round, the single most important moment, the tactical pattern, and the trend.
   * It never emits a generic line such as both fighters having success.
   */
  roundSummary(round: RoundResult, events: FightEvent[]): string {
    const aStats = round.statsA;
    const bStats = round.statsB;
    if (!aStats || !bStats) return round.summary;
    const leadA = round.trueScoreA >= 0;
    const leaderName = leadA ? this.a.lastName : this.b.lastName;
    const trailerName = leadA ? this.b.lastName : this.a.lastName;
    const leader = leadA ? aStats : bStats;
    const trailer = leadA ? bStats : aStats;
    const margin = Math.abs(round.trueScoreA);

    const parts: string[] = [];

    // Opening clause describes the dominant mode of the round for the round winner.
    const groundHeavy = leader.controlSeconds > 110;
    const strikeHeavy = leader.sigStrikesLanded >= 12 && leader.controlSeconds < 90;
    const grindy = leader.sigStrikesLanded < 10 && leader.controlSeconds > 60;

    if (groundHeavy) {
      parts.push(
        `${leaderName} spent ${formatClock(Math.round(leader.controlSeconds))} in control on the ground and landed ${leader.groundLanded} strikes from position.`
      );
    } else if (strikeHeavy) {
      const target =
        leader.legLanded > leader.bodyLanded && leader.legLanded > leader.headLanded / 2
          ? 'working the legs'
          : leader.bodyLanded >= leader.headLanded * 0.6
            ? 'investing in the body'
            : 'headhunting';
      parts.push(`${leaderName} controlled the striking, ${target}, and out landed ${trailerName} ${leader.sigStrikesLanded} to ${trailer.sigStrikesLanded}.`);
    } else if (grindy) {
      parts.push(`${leaderName} won a low output round on position, holding ${formatClock(Math.round(leader.controlSeconds))} of control.`);
    } else {
      parts.push(`${leaderName} edged a close round ${leader.sigStrikesLanded} to ${trailer.sigStrikesLanded} in significant strikes.`);
    }

    // Most important single moment, taken from the event stream rather than invented.
    const key = events.find((e) => e.seq === round.keyMomentSeq);
    if (key && key.importance !== 'trivial' && key.importance !== 'minor') {
      const who = this.who(key.actorId).lastName;
      const against = this.who(key.defenderId).lastName;
      if (key.tags.includes('knockdown')) parts.push(`The moment of the round was the knockdown ${who} scored on ${against}.`);
      else if (key.tags.includes('submission-secured')) parts.push(`${who} came close with a submission that ${against} had to fight out of.`);
      else if (key.tags.includes('takedown')) parts.push(`${who} changed the round with a takedown.`);
      else if (key.tags.includes('sweep')) parts.push(`${who} flipped the position with a sweep.`);
      else if (key.tags.includes('stun')) parts.push(`${who} had ${against} hurt for a moment.`);
    }

    // Counter narrative for the losing fighter, only when there is something real to say.
    if (trailer.takedownsLanded > leader.takedownsLanded) {
      parts.push(`${trailerName} was the fighter getting takedowns, with ${trailer.takedownsLanded}.`);
    } else if (trailer.submissionAttempts > 0 && leader.submissionAttempts === 0) {
      parts.push(`${trailerName} had the only real submission threat of the round.`);
    } else if (trailer.knockdowns > 0) {
      parts.push(`${trailerName} still had the best single shot of the round.`);
    }

    // Cardio trend, only when it is actually meaningful.
    const staminaLeader = leadA ? round.staminaEndA : round.staminaEndB;
    const staminaTrailer = leadA ? round.staminaEndB : round.staminaEndA;
    if (staminaLeader !== undefined && staminaTrailer !== undefined) {
      if (staminaTrailer < 38 && staminaTrailer < staminaLeader - 12) {
        parts.push(`${trailerName} is clearly breathing hard heading to the corner.`);
      } else if (staminaLeader < 38 && staminaLeader < staminaTrailer - 12) {
        parts.push(`${leaderName} spent a lot of energy winning it.`);
      }
    }

    const verdict =
      margin < 3 ? 'It was close enough that it could go either way on the cards.' : margin > 17 ? 'That was a clear round.' : '';
    if (verdict) parts.push(verdict);

    return parts.join(' ');
  }

  /**
   * Finish description assembled from the actual closing sequence, including the setup,
   * the technique, the target, the defensive failure and the official time.
   */
  finishDescription(result: FightResult, events: FightEvent[]): string {
    const time = `${formatClock(result.endTimeSeconds)} of round ${result.endRound}`;
    if (!result.winnerId) return `The fight goes the distance and to the judges after ${result.endRound} rounds.`;
    const winner = this.who(result.winnerId).lastName;
    const loser = result.loserId ? this.who(result.loserId).lastName : 'the opponent';

    const tail = events.slice(-14);
    const setup = tail.find((e) => e.action.kind === 'strike' && e.result === 'clean-land' && e.seq < (tail[tail.length - 1]?.seq ?? 0) - 1);
    const finisher = [...tail].reverse().find((e) => e.action.kind === 'strike' && (e.result === 'clean-land' || e.tags.includes('knockdown')));

    switch (result.method) {
      case 'ko': {
        const noun = finisher && finisher.action.kind === 'strike' ? STRIKE_NOUN[finisher.action.name][0] : 'clean shot';
        const setupNoun = setup && setup.action.kind === 'strike' ? STRIKE_NOUN[setup.action.name][0] : null;
        const area = finisher?.target === 'body' ? 'the body' : 'the head';
        return `${setupNoun ? `${winner} set it up with the ${setupNoun}, then ` : `${winner} `}landed the ${noun} to ${area}. ${loser} went down and did not recover. The referee did not need a second look. Knockout at ${time}.`;
      }
      case 'tko-strikes': {
        const noun = finisher && finisher.action.kind === 'strike' ? STRIKE_NOUN[finisher.action.name][0] : 'combination';
        return `${winner} hurt ${loser} with a ${noun} and stayed on it. ${loser} stopped answering back and covered up, and the referee stepped in. TKO at ${time}.`;
      }
      case 'tko-ground-strikes':
        return `${winner} landed the finishing sequence from the top. ${loser} could not improve position or defend, and the referee waved it off. TKO by ground strikes at ${time}.`;
      case 'submission': {
        const label = result.submissionName ? SUBMISSION_LABEL[result.submissionName] : 'submission';
        const entry = [...tail].reverse().find((e) => e.action.kind === 'submission' && e.action.stage === 'entry');
        const posText = entry ? POSITION_NAME[entry.stateBefore] : 'position';
        return `${winner} worked into ${posText}, secured the ${label} and adjusted once. ${loser} tried to defend the grip, could not, and tapped at ${time}.`;
      }
      case 'technical-submission': {
        const label = result.submissionName ? SUBMISSION_LABEL[result.submissionName] : 'choke';
        return `${winner} locked in the ${label} and ${loser} refused to tap. The referee stepped in when ${loser} went out. Technical submission at ${time}.`;
      }
      case 'doctor-stoppage':
        return `The doctor looked at the damage between rounds and would not let it continue. ${winner} wins by doctor stoppage after round ${result.endRound}.`;
      case 'corner-stoppage':
        return `${loser}'s corner made the call and pulled their fighter before round ${result.endRound + 1}. ${winner} wins by corner stoppage.`;
      case 'retirement':
        return `${loser} could not answer the horn for round ${result.endRound + 1}. ${winner} wins by retirement.`;
      default:
        return `The fight goes the distance and to the judges after ${result.endRound} rounds.`;
    }
  }

  /** Two sentence recap used on event pages and news items. */
  fightRecap(result: FightResult, rounds: RoundResult[]): string {
    if (!result.winnerId) {
      return `${this.a.lastName} and ${this.b.lastName} went the distance and the judges could not separate them.`;
    }
    const winner = this.who(result.winnerId).lastName;
    const loser = result.loserId ? this.who(result.loserId).lastName : 'the opponent';
    const winnerIsA = result.winnerId === this.a.id;
    const totals: RoundStatLine = winnerIsA ? result.totalsA : result.totalsB;
    const oppTotals: RoundStatLine = winnerIsA ? result.totalsB : result.totalsA;

    if (result.method.startsWith('decision')) {
      const style =
        totals.controlSeconds > oppTotals.controlSeconds + 120
          ? `controlled the grappling for ${formatClock(Math.round(totals.controlSeconds))}`
          : `out struck ${loser} ${totals.sigStrikesLanded} to ${oppTotals.sigStrikesLanded}`;
      const closeness = result.method === 'decision-split' ? 'in a fight that split the judges' : `over ${rounds.length} rounds`;
      return `${winner} ${style} and took the ${result.method === 'decision-split' ? 'split' : result.method === 'decision-majority' ? 'majority' : 'unanimous'} decision ${closeness}.`;
    }
    return this.finishDescription(result, result.events);
  }
}

export interface NarrationOptions {
  /** Render a line for every event. Off for background fights. */
  playByPlay?: boolean;
  /** Write a summary for each round. */
  roundSummaries?: boolean;
}

/**
 * Attaches rendered text to a finished result.
 *
 * The recap is always written, because every fight needs a readable one line account for
 * news, records and fighter pages. The play by play and the round summaries are optional,
 * which is what makes a background preliminary cheap to simulate and cheap to store.
 */
export function narrateResult(
  result: FightResult,
  a: NarrativeFighter,
  b: NarrativeFighter,
  opts: NarrationOptions = {}
): FightResult {
  const playByPlay = opts.playByPlay ?? true;
  const roundSummaries = opts.roundSummaries ?? true;
  const narrator = new FightNarrator(a, b, result.seed);

  if (playByPlay) {
    let currentRound = 0;
    for (const e of result.events) {
      if (e.round !== currentRound) {
        currentRound = e.round;
        narrator.fightStart();
      }
      const text = narrator.render(e);
      if (text) e.text = text;
    }
  }

  if (roundSummaries) {
    for (const r of result.rounds) {
      r.summary = narrator.roundSummary(
        r,
        result.events.filter((e) => e.round === r.round)
      );
    }
  }

  result.narrativeSummary = narrator.fightRecap(result, result.rounds);
  return result;
}
