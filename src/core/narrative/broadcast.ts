import type { FinishMethod, FightResult, RoundStatLine } from '../types/fight';

/**
 * Lines for the fight broadcast around the play by play: the banner on a big moment, the call at
 * the start of each round, the corners between rounds and the final horn.
 *
 * Every choice here is a pure function of the stored result. Nothing draws from a random stream,
 * so replaying a fight always reads the same, and nothing here can reach back into the
 * simulation. Variety comes from hashing the fight's seed with the moment being described.
 */

/** A stable index into a list, so the same moment always picks the same line. */
function pickStable<T>(options: readonly T[], ...keys: (number | string)[]): T {
  let h = 2166136261;
  for (const k of keys) {
    const s = String(k);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e37;
  }
  return options[(h >>> 0) % options.length];
}

function fill(template: string, actor: string, defender: string): string {
  return template.split('{a}').join(actor).split('{d}').join(defender);
}

const KNOCKDOWN_BANNER = ['Down goes {d}!', '{a} drops {d}!', '{d} is on the canvas!', '{a} puts {d} down!'];
const ROCKED_BANNER = ['{d} is hurt!', '{a} has {d} in trouble!', '{d} is wobbled!', '{a} rocks {d}!'];
const LOCKED_BANNER = ['{a} has it locked in!', '{d} is in deep trouble!', '{a} is squeezing!', 'This could be it for {d}!'];
const DEDUCTION_BANNER = ['The referee takes a point from {a}!', 'A point comes off for {a}!'];
const DOCTOR_BANNER = ['The doctor is in to look at {d}.', 'The doctor takes a close look at {d}.'];

const FINISH_BANNER: Partial<Record<FinishMethod, string[]>> = {
  ko: ['It is all over! {a} knocks out {d}!', '{d} is out! {a} wins it by knockout!', 'Lights out! {a} finishes {d}!'],
  'tko-strikes': ['The referee waves it off! {a} stops {d}!', 'That is the stoppage! {a} has finished {d}!', 'It is over! {a} gets the stoppage!'],
  'tko-ground-strikes': ['The referee dives in! {a} pounds out {d}!', 'That is enough! {a} finishes {d} on the ground!', 'Stopped on the mat! {a} gets it done!'],
  submission: ['{d} taps! It is all over!', 'The tap is there! {a} submits {d}!', '{d} has to tap! {a} wins it!'],
  'technical-submission': ['{d} is out cold in the hold! The referee stops it!', 'The referee jumps in! {d} went out in the hold!'],
  'doctor-stoppage': ['The doctor has stopped it! {a} wins!', 'It is over on the doctor\'s advice! {a} wins it!'],
  'corner-stoppage': ['{d}\'s corner has seen enough! It is over!', 'The towel is in! {a} wins it!'],
  retirement: ['{d} cannot continue! {a} wins it!', '{d} stays on the stool! It is over!'],
  disqualification: ['The referee has disqualified {d}!', 'Disqualification! {d} is thrown out!'],
};

/**
 * The banner line for a big moment, or null for a moment that does not get one.
 *
 * For a finish the actor of the finishing event is always the winner; a disqualification is the
 * one finish the engine records with the fouling fighter as the defender, which the line reads.
 */
export function momentBanner(kind: string, actor: string, defender: string, seq: number, method?: FinishMethod): string | null {
  const bank =
    kind === 'knockdown'
      ? KNOCKDOWN_BANNER
      : kind === 'rocked'
        ? ROCKED_BANNER
        : kind === 'submission-danger'
          ? LOCKED_BANNER
          : kind === 'deduction'
            ? DEDUCTION_BANNER
            : kind === 'doctor'
              ? DOCTOR_BANNER
              : kind === 'finish'
                ? (method && FINISH_BANNER[method]) || ['It is all over!']
                : null;
  if (!bank) return null;
  return fill(pickStable(bank, seq, kind), actor, defender);
}

const ROUND_ONE = [
  'Round one. The referee brings them to the center.',
  'Here we go. Round one is underway.',
  'They touch gloves and round one is on.',
  'The cage door is shut. Round one.',
];
const MIDDLE_ROUND = [
  'Round {n}. They come out of the corners.',
  'Round {n} is underway.',
  'Back to work for round {n}.',
  'Round {n}. Fresh instructions, same cage.',
];
const CHAMPIONSHIP_ROUND = [
  'Round {n}. Into the championship rounds.',
  'Round {n}. This is where titles are won and lost.',
  'Round {n}. Deep water now.',
];
const FINAL_ROUND = [
  'The final round. Five minutes to settle it.',
  'Round {n}, the last one. Everything on the table.',
  'Last round. Whatever is left, it has to come out now.',
];

/** The call at the start of a round. */
export function roundOpener(result: FightResult, round: number): string {
  const n = String(round);
  const bank =
    round === 1
      ? ROUND_ONE
      : round === result.scheduledRounds
        ? FINAL_ROUND
        : result.scheduledRounds === 5 && round >= 4
          ? CHAMPIONSHIP_ROUND
          : MIDDLE_ROUND;
  return pickStable(bank, result.seed, 'open', round).split('{n}').join(n);
}

const FINAL_HORN = [
  'The final horn. {a} and {b} have gone the full {r} rounds.',
  'That is the horn! We go to the judges\' scorecards.',
  'The fight goes the distance. It is in the hands of the judges now.',
];

/**
 * The call at the end of a fight that is not a finish. A bout cut short without one, a technical
 * decision or a no contest, did not go the distance and is not called as if it had.
 */
export function finalHorn(result: FightResult, nameA: string, nameB: string): string {
  if (result.method === 'no-contest') return 'The bout is waved off. There will be no winner tonight.';
  if (result.endRound < result.scheduledRounds) return 'The fight is stopped early and goes to the judges\' scorecards.';
  return pickStable(FINAL_HORN, result.seed, 'horn')
    .split('{a}')
    .join(nameA)
    .split('{b}')
    .join(nameB)
    .split('{r}')
    .join(String(result.endRound));
}

export interface CornerInput {
  round: number;
  /** This corner's fighter, and the other one, for the round just ended. */
  mine: RoundStatLine;
  theirs: RoundStatLine;
  /** Cardio at the horn. */
  stamina: number | undefined;
  /** Knocked down or rocked in the round. */
  wasHurt: boolean;
  /** Head damage taken in the round just ended. */
  headDamageTaken: number;
  legDamage: number;
  /** The unofficial read of the round from this corner's side. */
  read: 'won' | 'lost' | 'even';
  /** Rounds won minus rounds lost on the unofficial reads so far. */
  standing: number;
  finalRoundNext: boolean;
}

const CORNER = {
  hurt: [
    'Breathe. Clear your head. Tie up if you are hurt again, do not trade.',
    'You got caught. Hands up, chin down, move your feet for the first minute.',
    'Forget that round. Survive the start of this one and your legs come back.',
  ],
  tired: [
    'Slow your breathing. Pick your shots and stop chasing.',
    'You are burning gas. Fight in bursts, rest on the outside.',
    'Make them carry the pace. Breathe through the nose and get your legs back.',
  ],
  takedowns: [
    'Stay off the fence. Underhooks and get your back off the mat.',
    'Sprawl and punish the shot. Do not let them hold you down.',
    'Keep your hips back. When they shoot, get up straight away.',
  ],
  legs: [
    'Check the leg kicks. Lift that lead leg or switch stance.',
    'They are chopping the leg. Close the distance and make them pay for it.',
  ],
  behindLate: [
    'You need a finish or a big round. This is the round you take a risk.',
    'You are behind. Go and get it, right from the bell.',
    'Leave nothing in there. Throw first, throw more.',
  ],
  behind: [
    'You are giving that round away. Start first, throw first.',
    'Push the pace. Make them fight going backwards.',
    'Nothing happens standing there. Lead, do not wait.',
  ],
  aheadLate: [
    'You are up. Smart for five more minutes and do not get careless.',
    'Stay disciplined. No wild exchanges, just win the minutes.',
  ],
  aheadGrappling: [
    'Same again. Get it to the mat and stay heavy on top.',
    'They cannot stop the takedown. Keep chaining and keep the weight on.',
    'That is your round. Take them down and make them carry you.',
  ],
  ahead: [
    'Good round. More of the same, keep the jab in their face.',
    'That is working. Do not chase it, let it come.',
    'Keep doing exactly that. Stay patient.',
  ],
  even: [
    'That round is close. Win the last minute of this one.',
    'Coin flip on the cards. Be busier, let the judges see it.',
    'Even round. Find your rhythm and get your shots off first.',
  ],
};

/**
 * What a corner tells its fighter between rounds, built from that fighter's round.
 *
 * The first thing that is true wins: getting hurt outranks being tired, which outranks the
 * tactical problem, which outranks the scorecard. A corner whose fighter was just dropped does not
 * talk about volume.
 */
export function cornerAdvice(input: CornerInput, seed: number, sideKey: string): string {
  let bank: readonly string[];
  if (input.wasHurt || input.headDamageTaken > 45) bank = CORNER.hurt;
  else if (input.stamina !== undefined && input.stamina < 40) bank = CORNER.tired;
  else if (input.theirs.takedownsLanded >= 2 || input.theirs.controlSeconds > 120) bank = CORNER.takedowns;
  else if (input.theirs.legLanded >= 8 && input.legDamage > 25) bank = CORNER.legs;
  else if (input.standing < 0 || input.read === 'lost') bank = input.finalRoundNext || input.standing < -1 ? CORNER.behindLate : CORNER.behind;
  else if (input.read === 'won')
    bank = input.finalRoundNext ? CORNER.aheadLate : input.mine.controlSeconds > 90 || input.mine.takedownsLanded >= 2 ? CORNER.aheadGrappling : CORNER.ahead;
  else bank = CORNER.even;
  return pickStable(bank, seed, 'corner', input.round, sideKey);
}
