import type { FighterId, IsoDate } from './common';

/**
 * Public identity, personality, activity and hype.
 *
 * None of this touches Ovr. Personality changes what a fighter chooses to do, fame changes
 * what they are worth and how they are matched, and activity changes how often they
 * compete. Ability is still exactly the six ratings.
 */

// ---------------------------------------------------------------------------
// Personality
// ---------------------------------------------------------------------------

export type PersonalityTrait =
  | 'humble'
  | 'arrogant'
  | 'respectful'
  | 'aggressive'
  | 'reserved'
  | 'charismatic'
  | 'funny'
  | 'awkward'
  | 'honest'
  | 'calculating'
  | 'emotional'
  | 'hot-tempered'
  | 'loyal'
  | 'mercenary'
  | 'disciplined'
  | 'reckless'
  | 'confident'
  | 'insecure'
  | 'risk-averse'
  | 'fame-seeking'
  | 'money-motivated'
  | 'legacy-focused'
  | 'family-oriented'
  | 'team-oriented'
  | 'independent'
  | 'controversial'
  | 'media-savvy'
  | 'private'
  | 'fan-friendly';

export const PERSONALITY_TRAITS: PersonalityTrait[] = [
  'humble',
  'arrogant',
  'respectful',
  'aggressive',
  'reserved',
  'charismatic',
  'funny',
  'awkward',
  'honest',
  'calculating',
  'emotional',
  'hot-tempered',
  'loyal',
  'mercenary',
  'disciplined',
  'reckless',
  'confident',
  'insecure',
  'risk-averse',
  'fame-seeking',
  'money-motivated',
  'legacy-focused',
  'family-oriented',
  'team-oriented',
  'independent',
  'controversial',
  'media-savvy',
  'private',
  'fan-friendly',
];

/** Traits that cannot sensibly be held at the same time. */
export const TRAIT_CONFLICTS: [PersonalityTrait, PersonalityTrait][] = [
  ['humble', 'arrogant'],
  ['respectful', 'controversial'],
  ['reserved', 'charismatic'],
  ['confident', 'insecure'],
  ['disciplined', 'reckless'],
  ['loyal', 'mercenary'],
  ['private', 'media-savvy'],
  ['private', 'fame-seeking'],
  ['risk-averse', 'reckless'],
  ['legacy-focused', 'money-motivated'],
  ['team-oriented', 'independent'],
  ['funny', 'awkward'],
];

export interface Personality {
  traits: PersonalityTrait[];
  /** Continuous dials the simulation reads. Traits are the readable surface of these. */
  charisma: number;
  mediaComfort: number;
  ego: number;
  loyalty: number;
  moneyMotivation: number;
  legacyMotivation: number;
  riskTolerance: number;
  discipline: number;
  temper: number;
  /** How much recent player choices have shifted public perception, 0 to 1. */
  identityDrift: number;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type ActivityProfileKey =
  | 'very-active'
  | 'normally-active'
  | 'selective'
  | 'inactive'
  | 'injury-prone'
  | 'short-notice-specialist'
  | 'frequent-replacement'
  | 'difficult-negotiator'
  | 'frequent-defender'
  | 'waits-for-big-events'
  | 'regional-preference'
  | 'long-recovery';

export interface ActivityProfile {
  key: ActivityProfileKey;
  /** Target fights per year before circumstances intervene. */
  targetFightsPerYear: number;
  /** Minimum days the fighter wants between bouts. */
  preferredTurnaroundDays: number;
  /** Willingness to take a bout on under three weeks notice, 0 to 1. */
  shortNoticeWillingness: number;
  /** How readily the fighter turns an offer down, 0 to 1. */
  selectivity: number;
}

// ---------------------------------------------------------------------------
// Fame and marketability
// ---------------------------------------------------------------------------

export interface FameProfile {
  /** How many people know the name at all, 0 to 100. */
  recognition: number;
  /** How well liked, 0 to 100. Separate from recognition on purpose. */
  favorability: number;
  /** How much of the attention is negative, 0 to 100. */
  controversy: number;
  hardcoreRespect: number;
  casualInterest: number;
  sponsorAppeal: number;
  mediaFriendliness: number;
  promotionalTrust: number;
  /** Composite drawing power used by event business, 0 to 100. */
  drawingPower: number;
}

export type PublicLabel =
  | 'fan-favorite'
  | 'cult-favorite'
  | 'action-fighter'
  | 'knockout-artist'
  | 'submission-hunter'
  | 'dominant-champion'
  | 'boring-winner'
  | 'peoples-champion'
  | 'polarizing-star'
  | 'villain'
  | 'respected-veteran'
  | 'rising-prospect'
  | 'media-darling'
  | 'hardcore-favorite'
  | 'internet-favorite'
  | 'unpopular-contender'
  | 'unmarketable-elite'
  | 'regional-superstar'
  | 'crossover-celebrity'
  | 'former-star-in-decline';

export const PUBLIC_LABEL_TEXT: Record<PublicLabel, string> = {
  'fan-favorite': 'Fan favorite',
  'cult-favorite': 'Cult favorite',
  'action-fighter': 'Action fighter',
  'knockout-artist': 'Knockout artist',
  'submission-hunter': 'Submission hunter',
  'dominant-champion': 'Dominant champion',
  'boring-winner': 'Boring winner',
  'peoples-champion': "People's champion",
  'polarizing-star': 'Polarizing star',
  villain: 'Villain',
  'respected-veteran': 'Respected veteran',
  'rising-prospect': 'Rising prospect',
  'media-darling': 'Media darling',
  'hardcore-favorite': 'Hardcore favorite',
  'internet-favorite': 'Internet favorite',
  'unpopular-contender': 'Unpopular contender',
  'unmarketable-elite': 'Unmarketable elite fighter',
  'regional-superstar': 'Regional superstar',
  'crossover-celebrity': 'Crossover celebrity',
  'former-star-in-decline': 'Former star in decline',
};

// ---------------------------------------------------------------------------
// Social media
// ---------------------------------------------------------------------------

export type SocialPlatform = 'photo' | 'text' | 'video' | 'longform';

export const SOCIAL_PLATFORM_LABEL: Record<SocialPlatform, string> = {
  photo: 'Photo platform',
  text: 'Short text platform',
  video: 'Short video platform',
  longform: 'Long form video platform',
};

export interface SocialProfile {
  followers: Record<SocialPlatform, number>;
  /** Engagement quality, 0 to 100. High engagement grows followers faster. */
  engagement: number;
  /** Recent posting cadence, 0 to 1. */
  activity: number;
  lastPostOn: IsoDate | null;
  /** Deliberate social actions taken in the current week, so posting is not unlimited. */
  actionsThisWeek?: number;
  /** The week the counter belongs to, so it resets rather than accumulating forever. */
  actionWeekOf?: IsoDate | null;
  history: { date: IsoDate; total: number }[];
}

export function totalFollowers(s: SocialProfile): number {
  return s.followers.photo + s.followers.text + s.followers.video + s.followers.longform;
}

export type SocialActionKey =
  | 'training-footage'
  | 'callout'
  | 'compliment-opponent'
  | 'respond-to-criticism'
  | 'promote-sponsor'
  | 'make-a-joke'
  | 'start-an-argument'
  | 'announce-injury'
  | 'tease-division-move'
  | 'demand-title-shot'
  | 'defend-teammate'
  | 'go-silent'
  | 'hire-social-manager';

export interface SocialActionOutcome {
  key: SocialActionKey;
  headline: string;
  detail: string;
  followerChange: Record<SocialPlatform, number>;
  favorabilityChange: number;
  controversyChange: number;
  recognitionChange: number;
  hypeChange: number;
  matchmakerChange: number;
  succeeded: boolean;
}

// ---------------------------------------------------------------------------
// Hype
// ---------------------------------------------------------------------------

export interface HypeMoment {
  date: IsoDate;
  label: string;
  delta: number;
}

export interface FightHype {
  boutId: string;
  total: number;
  hardcore: number;
  casual: number;
  regional: number;
  media: number;
  storyline: string;
  moments: HypeMoment[];
  projectedAttendance: number | null;
  projectedPpvBuys: number | null;
  updatedOn: IsoDate;
}

// ---------------------------------------------------------------------------
// Rivalries
// ---------------------------------------------------------------------------

export type RivalryType = 'competitive' | 'personal' | 'promotional' | 'gym-based' | 'national' | 'championship' | 'former-teammates';

export interface Rivalry {
  id: string;
  aId: FighterId;
  bId: FighterId;
  type: RivalryType;
  intensity: number;
  startedOn: IsoDate;
  lastEventOn: IsoDate;
  resolved: boolean;
  history: { date: IsoDate; note: string; delta: number }[];
}

// ---------------------------------------------------------------------------
// Event business
// ---------------------------------------------------------------------------

export type BusinessFigureKind = 'verified' | 'reported-estimate' | 'simulated' | 'unknown';

export interface EventBusiness {
  attendance: number | null;
  attendanceKind: BusinessFigureKind;
  gate: number | null;
  gateKind: BusinessFigureKind;
  ppvBuys: number | null;
  ppvKind: BusinessFigureKind;
  streamingViewers: number | null;
  broadcastAudience: number | null;
  internationalAudience: number | null;
  merchandise: number | null;
  sponsorship: number | null;
  venueCost: number | null;
  fighterPayroll: number | null;
  bonusPayroll: number | null;
  marketingCost: number | null;
  estimatedProfit: number | null;
  demandNotes: string[];
}
