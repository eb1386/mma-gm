import type { BoutId, ContractId, EventId, FighterId, GymId, IsoDate, MessageId, StaffId } from './common';
import type { DivisionId } from '../config/divisions';
import type { RatingKey } from './fighter';

// ---------------------------------------------------------------------------
// Events and cards
// ---------------------------------------------------------------------------

export type EventTier = 'numbered-ppv' | 'fight-night' | 'apex' | 'international';

export interface FightCardEvent {
  id: EventId;
  name: string;
  date: IsoDate;
  city: string;
  country: string;
  countryCode: string;
  venue: string;
  tier: EventTier;
  boutIds: BoutId[];
  status: 'announced' | 'completed' | 'canceled';
  attendance: number | null;
  /** Simulated commercial performance, used for pay and popularity effects. */
  drawScore: number;
  fightOfTheNightBoutId: BoutId | null;
  performanceBonusFighterIds: FighterId[];
  bonusAmount: number;

  /** Card shape chosen when the event was created, before any bouts were booked. */
  plannedBouts: number;
  plannedMain: number;
  plannedPrelim: number;
  plannedEarly: number;

  /**
   * Four separate views of the card, because they legitimately differ. A bout can be
   * announced, then replaced, then miss weight, then be pulled on the day.
   */
  announcedBoutIds: BoutId[];
  weighInBoutIds: BoutId[];
  contestedBoutIds: BoutId[];
  canceledBoutIds: BoutId[];
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface ContractTerms {
  fights: number;
  showPay: number;
  winBonus: number;
  signingBonus: number;
  /** Points on pay per view, expressed as dollars per thousand buys. Zero for most. */
  ppvPoints: number;
  championEscalator: number;
  mainEventBonus: number;
  shortNoticeBonus: number;
  guaranteedMinimum: number;
  performanceBonusEligible: boolean;
  exclusive: boolean;
}

export interface Contract {
  id: ContractId;
  fighterId: FighterId;
  promotion: string;
  startDate: IsoDate;
  endCondition: 'fights-exhausted' | 'date' | 'released';
  endDate: IsoDate | null;
  terms: ContractTerms;
  fightsRemaining: number;
  status: 'active' | 'expired' | 'released' | 'negotiating' | 'declined';
  /** True when every term is a simulated game value rather than a reported fact. */
  isSimulated: boolean;
  minimumTurnaroundDays: number;
  injuryExtension: boolean;
  championClause: boolean;
  weightClassClause: DivisionId | null;
  negotiationHistory: NegotiationRound[];
  signedOn: IsoDate;
  note: string;
}

export interface NegotiationRound {
  on: IsoDate;
  by: 'promotion' | 'fighter';
  terms: ContractTerms;
  message: string;
  accepted: boolean | null;
}

export interface ContractOffer {
  id: string;
  fighterId: FighterId;
  terms: ContractTerms;
  createdOn: IsoDate;
  deadline: IsoDate;
  /** Hidden promotion reservation values. Never shown to the player. */
  reservation: {
    maxShowPay: number;
    maxWinBonus: number;
    maxSigningBonus: number;
    maxPpvPoints: number;
    patience: number;
  };
  roundsUsed: number;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';
  leverageSummary: string;
}

// ---------------------------------------------------------------------------
// Fight offers
// ---------------------------------------------------------------------------

export interface FightOffer {
  id: string;
  fighterId: FighterId;
  opponentId: FighterId;
  eventId: EventId;
  eventName: string;
  date: IsoDate;
  city: string;
  country: string;
  divisionId: DivisionId;
  contractedWeightLb: number;
  scheduledRounds: 3 | 5;
  isMainEvent: boolean;
  isTitleFight: boolean;
  isInterimTitleFight: boolean;
  isCatchweight: boolean;
  noticeDays: number;
  campWeeksAvailable: number;
  showPay: number;
  winBonus: number;
  shortNoticeBonus: number;
  rankingImplication: string;
  travelKm: number;
  reason: string;
  /** The structured matchmaking category behind the offer, shown on the offer page. */
  bookingKind?: string;
  /** Set when this offer came from a persistent matchmaking interest such as a callout. */
  matchupInterestId?: string | null;
  createdOn: IsoDate;
  deadline: IsoDate;
  isReplacementSlot: boolean;
  /**
   * Stable identity for this offer. Regenerating the same offer returns the existing one
   * rather than adding a second copy. Optional so older saves still load.
   */
  idempotencyKey?: string;
  /** Set when the offer is medically contingent on the fighter being cleared in time. */
  medicallyContingent?: boolean;
  status: 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  /** Counter requests already used, to limit endless haggling. */
  requestsUsed: number;
}

// ---------------------------------------------------------------------------
// Training camps
// ---------------------------------------------------------------------------

export type CampFocus = Record<RatingKey, number>;

export type GamePlanKey =
  | 'pressure'
  | 'counter'
  | 'outside-range'
  | 'pocket-boxing'
  | 'body-attack'
  | 'leg-kick-attack'
  | 'clinch-attack'
  | 'takedown-pressure'
  | 'fence-wrestling'
  | 'top-control'
  | 'submission-hunting'
  | 'high-pace'
  | 'conservative-pace'
  | 'early-finish'
  | 'late-fight'
  | 'protect-injury'
  | 'avoid-strength';

export interface TrainingCamp {
  id: string;
  fighterId: FighterId;
  boutId: BoutId | null;
  startDate: IsoDate;
  endDate: IsoDate;
  weeks: number;
  intensity: number;
  focus: CampFocus;
  gymId: GymId | null;
  campType: 'home' | 'visiting' | 'split' | 'solo' | 'near-event';
  specialistHired: string | null;
  gamePlan: GamePlanKey[];
  arriveEarlyDays: number;
  status: 'planned' | 'running' | 'complete' | 'abandoned';
  weeksCompleted: number;
  /** Accumulated outcomes, revealed as summaries not as raw modifiers. */
  outcomes: CampOutcome[];
  resultingSharpness: number | null;
  resultingTacticalFamiliarity: number | null;
  resultingGains: Partial<Record<RatingKey, number>> | null;
  overtrained: boolean;
  cost: number;
}

export interface CampOutcome {
  week: number;
  key: string;
  headline: string;
  detail: string;
  severity: 'good' | 'neutral' | 'bad';
}

// ---------------------------------------------------------------------------
// Gyms
// ---------------------------------------------------------------------------

export interface GymStaff {
  id: StaffId;
  name: string;
  role:
    | 'head-coach'
    | 'striking-coach'
    | 'grappling-coach'
    | 'wrestling-coach'
    | 'submission-coach'
    | 'strength-conditioning'
    | 'recovery'
    | 'nutrition'
    | 'cutman'
    | 'psychologist'
    | 'scout'
    | 'manager';
  /** Internal coaching quality, 0 to 100. Never shown as a fighter rating. */
  quality: number;
  /** Which of the six areas this staff member develops. Null for support roles. */
  develops: RatingKey | null;
  salary: number;
  loyalty: number;
  hiredOn: IsoDate;
  reputation: number;
}

export interface Gym {
  /** The calendar month whose finances have already been settled, so it cannot be settled twice. */
  lastSettledMonth?: string;
  id: GymId;
  name: string;
  country: string;
  countryCode: string;
  city: string;
  reputation: number;
  facilities: number;
  capacity: number;
  staffIds: StaffId[];
  fighterIds: FighterId[];
  /** Quality of the training partner pool by area, 0 to 100. */
  trainingPartners: Record<RatingKey, number>;
  balance: number;
  monthlyCosts: number;
  revenueSharePct: number;
  culture: number;
  safety: number;
  hardSparringTendency: number;
  specializations: RatingKey[];
  championsProduced: number;
  rankedProduced: number;
  founded: IsoDate;
  isPlayerControlled: boolean;
  isReal: boolean;
  note: string;
  recentResults: { wins: number; losses: number };
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface RankingEntry {
  fighterId: FighterId;
  rank: number;
  previousRank: number | null;
  points: number;
  weeksRanked: number;
  movementReason: string | null;
}

export interface DivisionRankings {
  divisionId: DivisionId;
  championId: FighterId | null;
  interimChampionId: FighterId | null;
  entries: RankingEntry[];
  updatedOn: IsoDate;
  /** True while the ranking still reflects the imported official snapshot. */
  fromOfficialSnapshot: boolean;
}

export interface PfpRankings {
  entries: RankingEntry[];
  updatedOn: IsoDate;
  fromOfficialSnapshot: boolean;
}

export interface TitleReign {
  id: string;
  divisionId: DivisionId;
  fighterId: FighterId;
  isInterim: boolean;
  wonOn: IsoDate;
  wonBoutId: BoutId | null;
  lostOn: IsoDate | null;
  lostBoutId: BoutId | null;
  defenses: number;
  endReason: 'defeated' | 'stripped' | 'vacated' | 'retired' | 'promoted' | null;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export type MessageSender =
  | 'matchmaker'
  | 'manager'
  | 'head-coach'
  | 'gym-owner'
  | 'specialist-coach'
  | 'doctor'
  | 'commission'
  | 'replacement-coordinator'
  | 'fighter'
  | 'media'
  | 'contract-rep'
  | 'system';

export interface InboxChoice {
  key: string;
  label: string;
  hint?: string;
  destructive?: boolean;
}

export interface InboxMessage {
  id: MessageId;
  date: IsoDate;
  sender: MessageSender;
  senderName: string;
  subject: string;
  body: string;
  requiresAction: boolean;
  deadline: IsoDate | null;
  choices: InboxChoice[];
  linkedFighterId: FighterId | null;
  linkedEventId: EventId | null;
  linkedBoutId: BoutId | null;
  linkedContractId: ContractId | null;
  linkedOfferId: string | null;
  status: 'unread' | 'read' | 'resolved' | 'expired';
  resolution: string | null;
  /**
   * Stable identity for a decision, so the same injury or the same sponsor obligation is
   * never asked about twice. Identity used to be smuggled inside the human readable
   * resolution text, which broke the moment the resolution was written for a person.
   */
  decisionKey?: string;
  linkedInjuryId?: string;
  linkedSponsorId?: string;
  linkedSocialId?: string;
  linkedCalloutId?: string;
  linkedStageId?: string;
  decisionCreatedOn?: IsoDate;
  decisionResolvedOn?: IsoDate;
  /** When consequences were applied. Present exactly once, so a retry cannot repeat them. */
  effectsAppliedOn?: IsoDate;
  selectedChoiceKey?: string;
  /**
   * Whether this item blocks the calendar. Undefined means mandatory, which preserves the
   * behaviour of every message written before the distinction existed.
   */
  mandatory?: boolean;
  /** Signature used for anti repetition on items that are not decisions. */
  notificationSignature?: string;
  category: 'offer' | 'contract' | 'injury' | 'gym' | 'ranking' | 'news' | 'career' | 'medical';
}

// ---------------------------------------------------------------------------
// News and history
// ---------------------------------------------------------------------------

export interface NewsItem {
  id: string;
  date: IsoDate;
  headline: string;
  body: string;
  tags: string[];
  fighterIds: FighterId[];
  importance: 1 | 2 | 3 | 4 | 5;
}

export interface SeasonAward {
  year: number;
  key: 'fighter-of-the-year' | 'fight-of-the-year' | 'coach-of-the-year' | 'gym-of-the-year' | 'prospect-of-the-year' | 'comeback-of-the-year';
  fighterId: FighterId | null;
  boutId: BoutId | null;
  gymId: GymId | null;
  staffId: StaffId | null;
  note: string;
}

export interface HallOfFameEntry {
  fighterId: FighterId;
  year: number;
  votePct: number;
  summary: string;
}
