import type {
  ActivityStatus,
  BuildType,
  Confidence,
  ContractId,
  FighterId,
  GymId,
  IsoDate,
  Provenance,
  Stance,
} from './common';
import type { DivisionId } from '../config/divisions';
import type { ActivityProfile, FameProfile, Personality, PublicLabel, SocialProfile } from './identity';

/**
 * The six primary performance ratings. This list is closed on purpose. Speed, power,
 * defense, fight IQ, chin, takedown defense and every other commonly requested attribute
 * is an emergent product of these six plus physicals, tendencies and fight state. Adding
 * a seventh visible rating is a design regression, not a feature.
 */
export interface Ratings {
  striking: number;
  grappling: number;
  wrestling: number;
  submissions: number;
  cardio: number;
  durability: number;
}

export const RATING_KEYS = [
  'striking',
  'grappling',
  'wrestling',
  'submissions',
  'cardio',
  'durability',
] as const;

export type RatingKey = (typeof RATING_KEYS)[number];

export const RATING_LABEL: Record<RatingKey, string> = {
  striking: 'Str',
  grappling: 'Grp',
  wrestling: 'Wrs',
  submissions: 'Sub',
  cardio: 'Car',
  durability: 'Dur',
};

export const RATING_LONG_LABEL: Record<RatingKey, string> = {
  striking: 'Striking',
  grappling: 'Grappling',
  wrestling: 'Wrestling',
  submissions: 'Submissions',
  cardio: 'Cardio',
  durability: 'Durability',
};

/**
 * Ovr is the unweighted arithmetic mean of the six ratings. Never weighted, never nudged
 * by record, popularity, ranking or championship status.
 */
export function ovrRaw(r: Ratings): number {
  return (r.striking + r.grappling + r.wrestling + r.submissions + r.cardio + r.durability) / 6;
}

/**
 * Ratings as stored in a rating history snapshot: two decimals. The history only feeds the fighter
 * page's chart and table, which show whole numbers, and full precision floats made it about a fifth
 * of every fighter record. Rounding at the moment of writing keeps a saved world identical to the
 * same world reloaded.
 */
export function historyRatings(r: Ratings): Ratings {
  const out = { ...r };
  for (const k of Object.keys(out) as (keyof Ratings)[]) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

export function ovrDisplayed(r: Ratings): number {
  return Math.round(ovrRaw(r));
}

/** Per rating confidence, used for scouting fog in career mode. */
export type RatingConfidence = Record<RatingKey, Confidence>;

/**
 * Career wear tracked as separate components. The UI shows a single Longevity number
 * plus an expandable breakdown. Longevity is never part of Ovr.
 */
export interface WearComponents {
  neurological: number;
  facial: number;
  joint: number;
  body: number;
  weightCut: number;
  recovery: number;
}

export type TendencyKey =
  | 'pressure'
  | 'counter'
  | 'range'
  | 'pocket'
  | 'kicking'
  | 'clinch'
  | 'takedownEntry'
  | 'topControl'
  | 'submissionHunt'
  | 'scramble'
  | 'pace'
  | 'starterSpeed'
  | 'riskTolerance'
  | 'finishSeeking'
  | 'chinTucking'
  | 'legKickDefense';

/**
 * Tendencies are 0 to 1 behavioral dials, not performance ratings. They shape which
 * actions a fighter chooses, never how good the fighter is at them.
 */
export type Tendencies = Record<TendencyKey, number>;

export interface StyleLabel {
  key: string;
  label: string;
}

export interface FightRecord {
  wins: number;
  losses: number;
  draws: number;
  noContests: number;
}

export interface CareerMethodTotals {
  koWins: number;
  subWins: number;
  decWins: number;
  koLosses: number;
  subLosses: number;
  decLosses: number;
}

/** Injury as tracked on a fighter. */
export interface Injury {
  id: string;
  type: string;
  area: 'head' | 'face' | 'shoulder' | 'elbow' | 'hand' | 'ribs' | 'back' | 'hip' | 'knee' | 'ankle' | 'foot' | 'neck' | 'general';
  severity: 1 | 2 | 3 | 4 | 5;
  startedAt: IsoDate;
  expectedReturn: IsoDate;
  actualReturn: IsoDate | null;
  cause: 'training' | 'sparring' | 'weight-cut' | 'fight' | 'accumulated' | 'accident';
  /** Multiplicative training capacity while injured, 0 to 1. */
  trainingCapacity: number;
  /**
   * How the injury is felt in the cage is derived from its area and severity by the fight engine,
   * which also decides whether it blocks kicks or takedowns. A second stored map of rating
   * penalties used to sit here, read by nothing, describing the same thing differently.
   */
  blocksCompetition: boolean;
  recurrenceChance: number;
  treatment: 'none' | 'rest' | 'rehab' | 'train-around' | 'surgery';
  note: string;
}

export interface MedicalSuspension {
  until: IsoDate;
  reason: string;
  clearanceRequired: boolean;
}

export interface RatingSnapshot {
  date: IsoDate;
  ratings: Ratings;
  ovr: number;
  pot: number;
  longevity: number;
  reason: string;
}

export interface RelationshipSet {
  /** Relationship with the UFC matchmaking department, 0 to 100. */
  matchmaker: number;
  /** Relationship with the head coach at the current gym. */
  coach: number;
  /** Relationship with the manager. */
  manager: number;
  /** Relationship with the player, in Coach Mode. */
  player: number;
  /** Relationship with teammates as a group. */
  team: number;
}

export interface DevelopmentProfile {
  /** Age at which growth peaks for this individual. */
  peakAge: number;
  /** How fast the fighter improves before peak, multiplier around 1. */
  growthRate: number;
  /** How fast the fighter declines after peak, multiplier around 1. */
  declineRate: number;
  /** Per rating individual affinity multipliers. */
  affinity: Record<RatingKey, number>;
  /** Hidden ceiling used by the development model. Not shown; Pot is the shown estimate. */
  hiddenCeiling: number;
  /** How well the fighter absorbs coaching, 0.6 to 1.4. */
  coachability: number;
  /** How resistant the body is to cumulative wear, 0.6 to 1.4. */
  resilience: number;
}

/**
 * The real fighter's official career statistics, exactly as the athlete profile published them when
 * the snapshot was built. They are history, not the simulation: nothing in a save changes them, and
 * they are shown beside the simulated career rather than merged into it. Absent for fictional fighters.
 */
export interface OfficialStats {
  sigStrLandedPerMin: number | null;
  sigStrAbsorbedPerMin: number | null;
  sigStrAccuracyPct: number | null;
  sigStrDefensePct: number | null;
  takedownAvgPer15: number | null;
  takedownAccuracyPct: number | null;
  takedownDefensePct: number | null;
  submissionAvgPer15: number | null;
  knockdownAvgPer15: number | null;
  avgFightTime: string | null;
  firstRoundFinishes: number | null;
  strikeTarget: { head: number; body: number; leg: number } | null;
  strikePosition: { standing: number; clinch: number; ground: number } | null;
  winMethod: { ko: number; sub: number; dec: number } | null;
  fightingStyle: string | null;
  trainsAt: string | null;
  placeOfBirth: string | null;
  /** The last card the fighter competed on, on or before the snapshot date. */
  lastEventDate: string | null;
  /**
   * A card the fighter was booked on after the snapshot date. Kept apart from lastEventDate because
   * the save never runs that card. Absent on snapshots built before the split.
   */
  nextEventDate?: string | null;
  sourceUrl: string;
  fetchedAt: string;
}

export interface Fighter {
  id: FighterId;

  // Identity
  firstName: string;
  lastName: string;
  name: string;
  nickname: string | null;
  country: string;
  countryCode: string;
  hometown: string | null;

  // Real world linkage. Null for generated fighters.
  realSourceIds: Record<string, string> | null;
  isRealPerson: boolean;
  provenance: Record<string, Provenance>;

  // Physicals
  birthDate: IsoDate | null;
  /**
   * Set when birthDate was estimated from the published age rather than published itself. The
   * estimate keeps the fighter aging; the interface shows the date of birth as not published.
   */
  birthDateEstimated?: boolean;
  /** Populated when the source gave an age but not a date of birth. */
  ageAtSnapshot: number | null;
  heightIn: number | null;
  reachIn: number | null;
  legReachIn: number | null;
  stance: Stance;
  build: BuildType;
  walkingWeightLb: number;

  // Division
  divisionId: DivisionId;
  eligibleDivisions: DivisionId[];

  // Performance
  ratings: Ratings;
  ratingConfidence: RatingConfidence;
  pot: number;
  potConfidence: Confidence;
  longevity: number;
  wear: WearComponents;
  tendencies: Tendencies;
  styleLabels: StyleLabel[];
  development: DevelopmentProfile;

  // Career state
  record: FightRecord;
  ufcRecord: FightRecord;
  methods: CareerMethodTotals;
  boutIds: string[];
  winStreak: number;
  lossStreak: number;
  lastFightDate: IsoDate | null;
  nextBoutId: string | null;
  octagonDebut: IsoDate | null;

  // Standing
  ranking: number | null;
  previousRanking: number | null;
  weeksRanked: number;
  highestRanking: number | null;
  pfpRanking: number | null;
  isChampion: boolean;
  isInterimChampion: boolean;
  titleReigns: number;
  titleDefenses: number;
  /**
   * A championship held in a division the fighter is no longer competing in.
   *
   * Set when a champion moves weight but keeps the belt for now. It is what allows a double
   * champion attempt to exist without a champion silently disappearing from a division, and
   * the deadline is when the promotion strips the title if they never come back.
   */
  heldTitleDivisionId?: DivisionId | null;
  titleHoldDeadline?: IsoDate | null;

  // Affiliation
  gymId: GymId | null;
  managerName: string;
  contractId: ContractId | null;

  // Standing in the world
  popularity: number;
  regionalPopularity: Record<string, number>;
  momentum: number;
  morale: number;
  happiness: number;
  relationships: RelationshipSet;

  // Health
  injuries: Injury[];
  medicalSuspension: MedicalSuspension | null;
  /** Suspension handed down by an athletic commission, distinct from a medical hold. */
  commissionSuspension?: MedicalSuspension | null;
  /** Anti-doping suspension. Abstract: a period of ineligibility with a stated reason. */
  antiDopingSuspension?: MedicalSuspension | null;
  conditioning: number;
  /**
   * Camp form, 0 to 100, neutral at 50.
   *
   * Nudged by the week to week camp life decisions and read by `finalizeCamp`, where it scales
   * fight night sharpness. It resets to neutral when a camp starts and when one completes.
   */
  campSharpness: number;

  // Money
  careerEarnings: number;
  lastPurse: number | null;

  // Status
  activityStatus: ActivityStatus;
  /** When an inactive fighter is expected back. Null means no date has been given. */
  expectedReturnDate?: IsoDate | null;
  /** No new offer is generated before this date. Set when an offer is declined or expires. */
  offerCooldownUntil?: IsoDate | null;
  retired: boolean;
  retirementDate: IsoDate | null;
  hallOfFameYear: number | null;

  // History
  ratingHistory: RatingSnapshot[];
  peakOvr: number;
  peakOvrDate: IsoDate | null;
  awards: string[];

  /**
   * Public identity. None of this is part of Ovr. Personality shapes choices, fame shapes
   * value and matchmaking, activity shapes how often the fighter competes. Optional so
   * that saves written before these systems existed still load.
   */
  personality?: Personality;
  activityProfile?: ActivityProfile;
  fame?: FameProfile;
  social?: SocialProfile;
  publicLabels?: PublicLabel[];

  // Simulation bookkeeping
  weightMisses: number;
  lastWeightCutQuality: number | null;
  declinedOffers: number;
  /** When the last refusal happened, so the penalty for refusing can fade with time. */
  lastDeclineOn?: IsoDate | null;
  acceptedShortNotice: number;
  /**
   * Set when the fighter volunteers for short notice work, until the date the offer lapses. The
   * replacement search prefers a fighter who asked to be on the list. Optional so older saves
   * still load: absent means the fighter never volunteered.
   */
  volunteeredShortNoticeUntil?: IsoDate | null;
  createdBy:'real-snapshot' | 'generated' | 'user';

  /**
   * The regional promotion this fighter competes for, by id. Absent or null means the fighter
   * belongs to the main promotion's world, which is every fighter written before the regional
   * circuit existed. A fighter with a circuit is invisible to the main promotion's rankings,
   * matchmaking, titles and record books until they are called up.
   */
  circuit?: string | null;
  /** Amateur bouts, kept apart from the professional record the way the sport keeps them. */
  amateurRecord?: FightRecord;
  /**
   * The regional promotion a Proving Ground tryout opponent was drawn from, so a winner who is
   * signed is credited to the circuit they actually fought on. Absent for everyone else, and for
   * tryout opponents in saves written before it existed.
   */
  originPromotionId?: string;
  /** Official career statistics for a real fighter, as published. */
  officialStats?: OfficialStats | null;
}

export interface FighterRatingEstimate {
  ratings: Ratings;
  low: Ratings;
  high: Ratings;
  ovr: number;
  ovrLow: number;
  ovrHigh: number;
  pot: number;
  confidence: Confidence;
  exact: boolean;
}
