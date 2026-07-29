import type { FightPosition, StrikeAction, SubmissionName, WrestlingAction } from '../types/fight';

/**
 * Phrase banks for the compositional narrative engine.
 *
 * The renderer never stores whole sentences. It assembles a sentence from a structural
 * pattern plus interchangeable fragments, then filters the result against what it has
 * already said in this fight. That is what produces variety without a hand written
 * paragraph for every possible outcome.
 */

export const STRIKE_NOUN: Record<StrikeAction, string[]> = {
  jab: ['jab', 'lead hand', 'stiff jab', 'pawing jab'],
  cross: ['straight hand', 'cross', 'rear straight', 'one two'],
  hook: ['hook', 'looping hook', 'short hook', 'left hook'],
  uppercut: ['uppercut', 'short uppercut', 'rising uppercut'],
  overhand: ['overhand', 'looping overhand', 'big right hand'],
  combination: ['combination', 'three piece', 'burst of punches', 'flurry'],
  'body-punch': ['body shot', 'hook to the body', 'digging body punch'],
  'low-kick': ['low kick', 'leg kick', 'thigh kick'],
  'calf-kick': ['calf kick', 'kick to the lead calf', 'low inside kick'],
  'body-kick': ['body kick', 'kick to the ribs', 'round kick to the body'],
  'head-kick': ['head kick', 'high kick', 'kick upstairs'],
  'front-kick': ['front kick', 'teep', 'push kick'],
  'side-kick': ['side kick', 'oblique kick', 'stabbing side kick'],
  'spinning-kick': ['spinning kick', 'spinning back kick', 'wheel kick'],
  knee: ['knee', 'knee up the middle', 'driving knee'],
  'flying-knee': ['flying knee', 'jumping knee'],
  elbow: ['elbow', 'short elbow', 'slicing elbow'],
  'spinning-elbow': ['spinning elbow', 'spinning back elbow'],
  'clinch-strike': ['short strike', 'inside punch', 'close range shot'],
  'ground-strike': ['ground strike', 'punch from the top', 'hammer fist'],
  'ground-elbow': ['elbow on the ground', 'short elbow from the top'],
};

export const LAND_VERB = [
  'lands',
  'connects with',
  'gets through with',
  'finds a home for',
  'snaps out',
  'digs in',
  'rips',
  'fires',
  'buries',
  'sticks',
];

export const CLEAN_ADVERB = ['cleanly', 'flush', 'right down the middle', 'on the button', 'square', 'squarely'];

export const PARTIAL_VERB = ['grazes with', 'catches part of', 'half lands', 'clips', 'scrapes'];

export const MISS_VERB = ['misses with', 'comes up short with', 'swings and misses on', 'falls short with', 'is wide with'];

export const BLOCK_VERB = ['is blocked', 'is picked off', 'is caught on the guard', 'is smothered'];

export const SLIP_VERB = ['is slipped', 'sails past', 'finds only air', 'is rolled under'];

export const HURT_PHRASE = [
  'is visibly shaken',
  'goes stiff for a moment',
  'is hurt',
  'stumbles backward',
  'has the legs go',
  'is on unsteady footing',
];

export const KNOCKDOWN_PHRASE = [
  'goes down',
  'crashes to the canvas',
  'drops',
  'falls hard',
  'is put on the mat',
  'hits the floor',
];

export const TAKEDOWN_VERB: Record<WrestlingAction, string[]> = {
  'single-leg': ['a single leg', 'a low single', 'the single'],
  'double-leg': ['a double leg', 'a driving double', 'the double'],
  'body-lock': ['a body lock', 'an over under lock', 'a waist lock'],
  'outside-trip': ['an outside trip', 'an outside foot trip'],
  'inside-trip': ['an inside trip', 'an inside leg trip'],
  'foot-sweep': ['a foot sweep', 'a sweeping trip'],
  'hip-throw': ['a hip throw', 'a headlock throw'],
  'reactive-takedown': ['a reactive shot', 'a takedown off the strike'],
  'catch-kick-takedown': ['a catch kick takedown', 'the caught kick'],
  'fence-takedown': ['a takedown on the fence', 'the fence takedown'],
  'mat-return': ['a mat return', 'the return to the mat'],
  sprawl: ['a sprawl'],
  whizzer: ['a whizzer'],
  'underhook-defense': ['underhook defense'],
  'stand-up': ['a stand up'],
  'wall-walk': ['a wall walk'],
};

export const POSITION_NAME: Record<FightPosition, string> = {
  'long-range': 'long range',
  'kick-range': 'kicking range',
  'boxing-range': 'boxing range',
  pocket: 'the pocket',
  'open-clinch': 'the open clinch',
  'fence-clinch': 'the fence',
  'takedown-attempt': 'a takedown scramble',
  scramble: 'a scramble',
  knockdown: 'the canvas',
  'top-guard': 'guard',
  'bottom-guard': 'guard',
  'top-half-guard': 'half guard',
  'bottom-half-guard': 'half guard',
  'top-side-control': 'side control',
  'bottom-side-control': 'side control',
  'top-mount': 'mount',
  'bottom-mount': 'mount',
  'back-control': 'back control',
  'back-taken': 'back control',
  'turtle-top': 'the turtle',
  'turtle-bottom': 'the turtle',
  'leg-entanglement': 'a leg entanglement',
  'standing-reset': 'a standing reset',
};

export const SUBMISSION_ENTRY_VERB = [
  'goes after',
  'threads through',
  'locks up',
  'reaches for',
  'attacks with',
  'sets up',
];

export const SUBMISSION_ESCAPE_PHRASE = [
  'works the grip loose',
  'peels the hands apart',
  'spins free',
  'gets the posture back',
  'slips the head out',
  'survives it',
];

export const CONTROL_PHRASE = [
  'settles into position and works',
  'stays heavy and controls',
  'grinds from the top',
  'holds position and lands short shots',
  'keeps the weight on',
];

export const RANGE_CHANGE_PHRASE = {
  closing: ['steps in behind the guard', 'closes the distance', 'walks forward', 'cuts the cage down', 'presses in'],
  opening: ['circles out', 'resets to the outside', 'gives ground', 'steps back to range', 'creates space'],
  circling: ['circles to the outside', 'moves laterally', 'works around the outside', 'switches angles'],
  feint: ['feints the level change', 'shows the hand and pulls it back', 'fakes the entry', 'baits the counter'],
};

export const FIGHT_START = [
  'The referee waves them in.',
  'Touch of gloves and the round is on.',
  'They meet in the middle to start.',
  'The horn sounds and the fight is underway.',
  'They step out and the fight begins.',
];

export const FEELING_OUT = [
  'Early feeling out here.',
  'Neither one wants to commit first.',
  'Range finding to start.',
  'A quiet opening minute.',
];

export const CORNER_ADVICE = {
  behind: [
    'You need this round. Push the pace and take a risk.',
    'You are giving away rounds. Start first, throw first.',
    'Nothing is happening standing there. Go get it.',
  ],
  ahead: [
    'Stay disciplined. Do not get careless with a lead.',
    'Keep doing what you are doing. Do not chase it.',
    'You are up. Fight smart for five more minutes.',
  ],
  hurt: [
    'Clear your head and tie up if you have to.',
    'Move your feet, do not stand in front of them.',
    'Buy yourself a minute and get your legs back.',
  ],
  tired: [
    'Breathe. Pick your shots, stop wasting energy.',
    'Slow it down and make them come to you.',
    'You are burning gas. Fight in bursts.',
  ],
  neutral: [
    'Keep the jab going and stay off the fence.',
    'Same as before, just add volume.',
    'Good round. More of the same.',
  ],
};

export const REFEREE_PHRASE = {
  standUp: ['The referee stands them up.', 'Not enough work, and they are restarted standing.', 'The referee calls for action and resets them.'],
  warning: ['The referee issues a warning.', 'A warning from the referee.', 'The referee steps in with a warning.'],
  deduction: ['A point is taken.', 'The referee takes a point.', 'That is a point deduction.'],
  doctorCheck: ['The doctor takes a look at the cut.', 'The action pauses for a doctor check.'],
};

export const FOUL_NAME: Record<string, string> = {
  'eye-poke': 'an accidental eye poke',
  'groin-strike': 'a strike below the belt',
  'illegal-knee': 'an illegal knee',
  'fence-grab': 'a fence grab',
  'back-of-head': 'a shot to the back of the head',
};

export const MOMENTUM_PHRASE = [
  'The momentum has turned.',
  'That changes the shape of the round.',
  'The fight has a different feel now.',
  'That was the swing moment.',
];

export const SUBMISSION_TAP_PHRASE = ['taps', 'is forced to tap', 'taps out', 'has to submit'];

export const SUBMISSION_TECHNICAL_PHRASE = [
  'goes out and the referee steps in',
  'is unconscious and the referee dives in',
  'stops responding and it is waved off',
];

export function submissionLabel(name: SubmissionName): string {
  return name
    .split('-')
    .join(' ')
    .replace('darce', "d'arce");
}
