import { BUILDS } from '../config/builds';
import { DIVISION_BY_ID, type DivisionConfig, type DivisionId } from '../config/divisions';
import { NAME_BANKS, NICKNAMES, type NameBank } from '../data/names';
import { clamp, Rng } from '../rng';
import type { ActivityStatus, BuildType, Confidence, IsoDate, Stance } from '../types/common';
import { addDays } from '../types/common';
import { generateActivityProfile, generateFame, generatePersonality, generateSocial } from './identity';
import { clampWalkingWeight } from './health';
import {
  ovrDisplayed,
  RATING_KEYS,
  type DevelopmentProfile,
  type Fighter,
  type RatingConfidence,
  type RatingKey,
  type Ratings,
  type StyleLabel,
  type Tendencies,
} from '../types/fighter';

export function pickNameBank(rng: Rng): NameBank {
  return rng.weighted(NAME_BANKS, (b) => b.weight);
}

export function makeTendencies(rng: Rng, ratings: Ratings): Tendencies {
  // Tendencies correlate loosely with ability. A good wrestler is more likely, but not
  // certain, to want the fight on the ground.
  const n = (mean: number, sd = 0.18) => clamp(rng.normal(mean, sd), 0.03, 1);
  const strikeLean = clamp((ratings.striking - (ratings.wrestling + ratings.grappling) / 2) / 40 + 0.5, 0, 1);
  return {
    pressure: n(0.5),
    counter: n(1 - 0.5),
    range: n(0.35 + strikeLean * 0.3),
    pocket: n(0.5),
    kicking: n(0.45),
    clinch: n(0.4 + (1 - strikeLean) * 0.2),
    takedownEntry: n(0.2 + (1 - strikeLean) * 0.55),
    topControl: n(0.25 + (ratings.grappling / 100) * 0.5),
    submissionHunt: n(0.15 + (ratings.submissions / 100) * 0.6),
    scramble: n(0.4 + (ratings.grappling / 100) * 0.3),
    pace: n(0.35 + (ratings.cardio / 100) * 0.45),
    starterSpeed: n(0.5),
    riskTolerance: n(0.45),
    finishSeeking: n(0.4 + (ratings.striking / 100) * 0.25),
    chinTucking: n(0.4 + (ratings.durability / 100) * 0.3),
    legKickDefense: n(0.5),
  };
}

const STYLE_RULES: { key: string; label: string; test: (t: Tendencies, r: Ratings) => boolean }[] = [
  { key: 'pressure-striker', label: 'Pressure striker', test: (t, r) => t.pressure > 0.62 && r.striking >= r.wrestling },
  { key: 'counter-striker', label: 'Counter striker', test: (t) => t.counter > 0.62 && t.pressure < 0.5 },
  { key: 'outside-kicker', label: 'Outside kicker', test: (t) => t.range > 0.6 && t.kicking > 0.55 },
  { key: 'pocket-boxer', label: 'Pocket boxer', test: (t) => t.pocket > 0.62 && t.kicking < 0.45 },
  { key: 'opportunistic-wrestler', label: 'Opportunistic wrestler', test: (t, r) => t.takedownEntry > 0.45 && t.takedownEntry < 0.68 && r.wrestling > 60 },
  { key: 'chain-wrestler', label: 'Chain wrestler', test: (t, r) => t.takedownEntry > 0.68 && r.wrestling > 65 },
  { key: 'control-grappler', label: 'Control grappler', test: (t, r) => t.topControl > 0.62 && r.grappling > 62 },
  { key: 'submission-hunter', label: 'Submission hunter', test: (t, r) => t.submissionHunt > 0.6 && r.submissions > 60 },
  { key: 'scrambler', label: 'Scrambler', test: (t) => t.scramble > 0.68 },
  { key: 'high-pace', label: 'High pace', test: (t, r) => t.pace > 0.68 && r.cardio > 65 },
  { key: 'slow-starter', label: 'Slow starter', test: (t) => t.starterSpeed < 0.34 },
  { key: 'fast-starter', label: 'Fast starter', test: (t) => t.starterSpeed > 0.7 },
  { key: 'front-runner', label: 'Front-runner', test: (t) => t.riskTolerance > 0.6 && t.pace > 0.6 },
  { key: 'late-surge', label: 'Late surge', test: (t, r) => t.starterSpeed < 0.45 && r.cardio > 72 },
  { key: 'risk-averse', label: 'Risk averse', test: (t) => t.riskTolerance < 0.32 },
  { key: 'aggressive-finisher', label: 'Aggressive finisher', test: (t) => t.finishSeeking > 0.68 },
];

export function deriveStyleLabels(t: Tendencies, r: Ratings): StyleLabel[] {
  const out: StyleLabel[] = [];
  for (const rule of STYLE_RULES) {
    if (rule.test(t, r)) out.push({ key: rule.key, label: rule.label });
    if (out.length >= 3) break;
  }
  if (out.length === 0) out.push({ key: 'balanced', label: 'Balanced' });
  return out;
}

export function makeDevelopmentProfile(rng: Rng, ratings: Ratings, ageNow: number): DevelopmentProfile {
  const affinity = {} as Record<RatingKey, number>;
  for (const k of RATING_KEYS) affinity[k] = clamp(rng.normal(1, 0.22), 0.45, 1.6);
  const currentOvr = (RATING_KEYS.reduce((s, k) => s + ratings[k], 0) / 6);
  // The hidden ceiling is drawn once, biased by present ability and youth.
  const youthRoom = clamp((30 - ageNow) / 12, -0.4, 1);
  const ceiling = clamp(currentOvr + rng.normal(6 + youthRoom * 9, 6.5), currentOvr - 3, 99);
  return {
    peakAge: clamp(rng.normal(29.5, 2.4), 24, 36),
    growthRate: clamp(rng.normal(1, 0.24), 0.4, 1.8),
    declineRate: clamp(rng.normal(1, 0.24), 0.45, 1.8),
    affinity,
    hiddenCeiling: ceiling,
    coachability: clamp(rng.normal(1, 0.19), 0.6, 1.4),
    resilience: clamp(rng.normal(1, 0.17), 0.6, 1.4),
  };
}

export function uniformConfidence(level: Confidence): RatingConfidence {
  return {
    striking: level,
    grappling: level,
    wrestling: level,
    submissions: level,
    cardio: level,
    durability: level,
  };
}

export interface PhysicalProfile {
  heightIn: number;
  reachIn: number;
  legReachIn: number;
  walkingWeightLb: number;
  build: BuildType;
  stance: Stance;
}

export function generatePhysicals(rng: Rng, division: DivisionConfig, build: BuildType): PhysicalProfile {
  const b = BUILDS[build];
  const heightIn = Math.round((rng.normal(division.priors.heightIn.mean + b.heightOffset, division.priors.heightIn.sd * 0.8)) * 2) / 2;
  const reachIn = Math.round((heightIn + rng.normal(b.reachOverHeight, 1.1)) * 2) / 2;
  const legReachIn = Math.round((heightIn * 0.56 + rng.normal(0, 0.9)) * 2) / 2;
  const walking = division.limitLb + division.typicalWalkAroundOverLb + b.walkAroundOffset + rng.normal(0, 3);
  const stanceRoll = rng.next();
  const stance: Stance = stanceRoll < 0.74 ? 'orthodox' : stanceRoll < 0.95 ? 'southpaw' : 'switch';
  return {
    heightIn,
    reachIn,
    legReachIn,
    walkingWeightLb: Math.round(walking),
    build,
    stance,
  };
}

export interface GenerateFighterOptions {
  divisionId: DivisionId;
  /** Target displayed Ovr around which the six ratings are generated. */
  targetOvr: number;
  /** Spread of the individual ratings around the target. A specialist has a wide spread. */
  spread?: number;
  age?: number;
  today: IsoDate;
  activityStatus?: ActivityStatus;
  idPrefix?: string;
  idNumber: number;
  countryBank?: NameBank;
  build?: BuildType;
}

export function generateRatings(rng: Rng, targetOvr: number, spread: number, build: BuildType): Ratings {
  const b = BUILDS[build];
  const raw = {} as Ratings;
  for (const k of RATING_KEYS) {
    const bias = b.ratingBias[k] ?? 0;
    raw[k] = clamp(rng.normal(targetOvr + bias, spread), 12, 98);
  }
  // Renormalize so the mean lands on the requested target. Ovr is the plain mean, so
  // this keeps generated Ovr honest without flattening the individual spread.
  const currentMean = RATING_KEYS.reduce((s, k) => s + raw[k], 0) / 6;
  const shift = targetOvr - currentMean;
  for (const k of RATING_KEYS) raw[k] = clamp(Math.round(raw[k] + shift), 12, 98);
  return raw;
}

export function generateFighter(rng: Rng, opts: GenerateFighterOptions): Fighter {
  const division = DIVISION_BY_ID[opts.divisionId];
  const bank = opts.countryBank ?? pickNameBank(rng);
  const firstName = rng.pick(bank.first);
  const lastName = rng.pick(bank.last);
  const build = opts.build ?? rng.pick(Object.keys(BUILDS) as BuildType[]);
  const phys = generatePhysicals(rng, division, build);
  const age = opts.age ?? Math.round(clamp(rng.normal(27, 3.6), 20, 40));
  const ratings = generateRatings(rng, opts.targetOvr, opts.spread ?? 7.5, build);
  const tendencies = makeTendencies(rng, ratings);
  const development = makeDevelopmentProfile(rng, ratings, age);

  const birthYear = Number(opts.today.slice(0, 4)) - age;
  const birthDate: IsoDate = `${birthYear}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;

  // A generated professional record consistent with age and ability.
  const proFights = Math.max(0, Math.round(clamp(rng.normal((age - 20) * 2.4, 3.5), 0, 45)));
  const winRate = clamp(0.5 + (opts.targetOvr - 62) / 70, 0.35, 0.9);
  const wins = Math.round(proFights * winRate);
  const losses = Math.max(0, proFights - wins);

  const id = `${opts.idPrefix ?? 'gen'}-${opts.idNumber}`;
  const koShare = clamp(rng.normal(0.34, 0.14), 0.05, 0.7);
  const subShare = clamp(rng.normal(0.24, 0.13), 0.02, 0.6);

  const shell = {
    id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    nickname: rng.chance(0.32) ? rng.pick(NICKNAMES) : null,
    country: bank.country,
    countryCode: bank.code,
    hometown: rng.pick(bank.cities),
    realSourceIds: null,
    isRealPerson: false,
    provenance: {},
    birthDate,
    ageAtSnapshot: age,
    heightIn: phys.heightIn,
    reachIn: phys.reachIn,
    legReachIn: phys.legReachIn,
    stance: phys.stance,
    build,
    walkingWeightLb: phys.walkingWeightLb,
    divisionId: opts.divisionId,
    eligibleDivisions: [opts.divisionId],
    ratings,
    ratingConfidence: uniformConfidence('medium'),
    pot: 0,
    potConfidence: 'low',
    longevity: clamp(Math.round(rng.normal(88 - Math.max(0, age - 28) * 2.4, 5)), 30, 100),
    wear: {
      neurological: clamp(rng.normal(Math.max(0, age - 24) * 1.4, 3), 0, 60),
      facial: clamp(rng.normal(Math.max(0, age - 24) * 1.1, 3), 0, 60),
      joint: clamp(rng.normal(Math.max(0, age - 24) * 1.2, 3), 0, 60),
      body: clamp(rng.normal(Math.max(0, age - 24) * 0.9, 3), 0, 60),
      weightCut: clamp(rng.normal(Math.max(0, age - 24) * 0.8, 3), 0, 60),
      recovery: clamp(rng.normal(Math.max(0, age - 26) * 1.5, 4), 0, 70),
    },
    tendencies,
    styleLabels: deriveStyleLabels(tendencies, ratings),
    development,
    record: { wins, losses, draws: 0, noContests: 0 },
    ufcRecord: { wins: 0, losses: 0, draws: 0, noContests: 0 },
    methods: {
      koWins: Math.round(wins * koShare),
      subWins: Math.round(wins * subShare),
      decWins: Math.max(0, wins - Math.round(wins * koShare) - Math.round(wins * subShare)),
      koLosses: Math.round(losses * 0.35),
      subLosses: Math.round(losses * 0.22),
      decLosses: Math.max(0, losses - Math.round(losses * 0.35) - Math.round(losses * 0.22)),
    },
    boutIds: [],
    winStreak: Math.max(0, Math.round(rng.normal(2, 2))),
    lossStreak: 0,
    lastFightDate: addDays(opts.today, -rng.int(60, 400)),
    nextBoutId: null,
    octagonDebut: null,
    ranking: null,
    previousRanking: null,
    weeksRanked: 0,
    highestRanking: null,
    pfpRanking: null,
    isChampion: false,
    isInterimChampion: false,
    titleReigns: 0,
    titleDefenses: 0,
    gymId: null,
    managerName: `${rng.pick(bank.first)} ${rng.pick(bank.last)}`,
    contractId: null,
    popularity: clamp(Math.round(rng.normal(18 + (opts.targetOvr - 60) * 0.7, 8)), 1, 100),
    regionalPopularity: { [bank.region]: clamp(Math.round(rng.normal(28, 10)), 1, 100) },
    momentum: 50,
    morale: clamp(Math.round(rng.normal(62, 12)), 10, 100),
    happiness: clamp(Math.round(rng.normal(64, 12)), 10, 100),
    relationships: {
      matchmaker: clamp(Math.round(rng.normal(52, 10)), 5, 95),
      coach: clamp(Math.round(rng.normal(65, 12)), 5, 100),
      manager: clamp(Math.round(rng.normal(65, 12)), 5, 100),
      player: 50,
      team: clamp(Math.round(rng.normal(62, 12)), 5, 100),
    },
    injuries: [],
    medicalSuspension: null,
    conditioning: clamp(Math.round(rng.normal(70, 10)), 20, 100),
    campSharpness: 50,
    careerEarnings: Math.max(0, Math.round(rng.normal(proFights * 22000, 30000))),
    lastPurse: null,
    activityStatus: opts.activityStatus ?? 'active',
    retired: false,
    retirementDate: null,
    hallOfFameYear: null,
    ratingHistory: [],
    peakOvr: ovrDisplayed(ratings),
    peakOvrDate: opts.today,
    awards: [],
    weightMisses: 0,
    lastWeightCutQuality: null,
    declinedOffers: 0,
    acceptedShortNotice: 0,
    createdBy: 'generated',
  } as Fighter;

  // Identity is generated after the shell so it can read the fighter's own attributes.
  shell.personality = generatePersonality(rng);
  shell.activityProfile = generateActivityProfile(rng, shell.personality, shell);
  shell.fame = generateFame(rng, shell);
  shell.social = generateSocial(rng, shell);
  shell.publicLabels = [];
  // Longevity, build and age are all known by now, so the starting walking weight can be
  // held to what this particular fighter can actually cut.
  clampWalkingWeight(shell, opts.today);
  return shell;
}

/** Difficulty and archetype presets offered by the Create a Fighter screen. */
export interface CreationPreset {
  key: string;
  label: string;
  description: string;
  points: number;
  spread: number;
  ageRange: [number, number];
  startingRecord: { wins: number; losses: number };
  potBias: number;
}

export const CREATION_PRESETS: CreationPreset[] = [
  {
    key: 'raw-prospect',
    label: 'Raw prospect',
    description: 'Young, unpolished and a long way from the top. The highest ceiling and the longest road.',
    points: 288,
    spread: 8,
    ageRange: [20, 23],
    startingRecord: { wins: 4, losses: 0 },
    potBias: 12,
  },
  {
    key: 'balanced-prospect',
    label: 'Balanced prospect',
    description: 'A well rounded regional standout with no glaring hole and no standout weapon.',
    points: 342,
    spread: 4,
    ageRange: [23, 26],
    startingRecord: { wins: 8, losses: 1 },
    potBias: 7,
  },
  {
    key: 'specialist',
    label: 'Specialist',
    description: 'Elite in one area and exposed in another. Matchup dependent from day one.',
    points: 348,
    spread: 15,
    ageRange: [24, 28],
    startingRecord: { wins: 9, losses: 2 },
    potBias: 5,
  },
  {
    key: 'experienced-signing',
    label: 'Experienced regional signing',
    description: 'A proven regional champion arriving with a full toolbox and less room to grow.',
    points: 396,
    spread: 6,
    ageRange: [27, 31],
    startingRecord: { wins: 15, losses: 3 },
    potBias: 2,
  },
  {
    key: 'late-veteran',
    label: 'Late career veteran',
    description: 'High current ability, low remaining Longevity and a short runway.',
    points: 426,
    spread: 7,
    ageRange: [33, 37],
    startingRecord: { wins: 24, losses: 8 },
    potBias: -2,
  },
  {
    key: 'sandbox',
    label: 'Custom sandbox',
    description: 'Unrestricted allocation for testing and experimentation. Not a fair career start.',
    points: 540,
    spread: 0,
    ageRange: [20, 40],
    startingRecord: { wins: 0, losses: 0 },
    potBias: 10,
  },
];
