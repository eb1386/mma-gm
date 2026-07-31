import type { RngState } from '../rng';
import type { DivisionId } from '../config/divisions';
import type {
  BoutId,
  ContractId,
  Difficulty,
  EventId,
  FighterId,
  GameMode,
  GymId,
  IsoDate,
  StaffId,
} from './common';
import type { Fighter } from './fighter';
import type { Bout, FightResult } from './fight';
import type { GamePlanKey } from './world';
import type { FightWeekTask } from '../world/fightweek';
import type { SocialItem } from '../world/social';
import type { PresserSession } from '../world/presser';
import type { WeighInState } from '../world/weighin';
import type { FinanceState, LedgerEntry, Manager, Sponsor } from '../world/finance';
import type { DopingState } from '../world/antidoping';
import type { InjuryTreatment } from '../world/injury-flow';
import type { Callout, Relationship } from '../world/relationships';
import type { MatchupInterest } from '../world/matchup-interest';
import type { DivisionSpell } from '../world/weightclass';
import type { Official } from '../world/officials';
import type { ContenderStatus } from '../world/contender';
import type { WeightClassPlan } from '../world/weightclass';
import type {
  Contract,
  ContractOffer,
  DivisionRankings,
  FightCardEvent,
  FightOffer,
  Gym,
  GymStaff,
  HallOfFameEntry,
  InboxMessage,
  NewsItem,
  PfpRankings,
  SeasonAward,
  TitleReign,
  TrainingCamp,
} from './world';

export const SAVE_SCHEMA_VERSION = 15;

export interface SaveSettings {
  difficulty: Difficulty;
  /** Reveals exact opponent ratings instead of scouted ranges. */
  revealRatings: boolean;
  /** Reveals exact live judge scores during a fight. */
  revealLiveScores: boolean;
  /** Allows 10-10 rounds. Off by default, matching normal officiating. */
  allowTenTen: boolean;
  allowTenSeven: boolean;
  autoAdvanceStopsOnDecision: boolean;
  simSpeed: 'slow' | 'normal' | 'fast';
  /** Number of Monte Carlo paths used when recomputing Pot. */
  potPaths: number;
  potPercentile: number;
  injuriesEnabled: boolean;
  eventsPerMonth: number;
  fillRosterWithGenerated: boolean;
  retirementEnabled: boolean;
  /**
   * Optional systems, so an older or lower performance save stays usable.
   *
   * Every flag has a defensive default and every reader treats an absent flag as the default,
   * so a save written before this existed behaves exactly as it did.
   */
  featureFlags?: FeatureFlags;
}

/** The optional systems the expansion adds. Absent means the default below. */
export interface FeatureFlags {
  historicalWorlds: boolean;
  womensDivisions: boolean;
  mediaDepth: boolean;
  businessDepth: boolean;
  antiDoping: boolean;
  detailedCommissions: boolean;
  persistentOfficials: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  historicalWorlds: false,
  womensDivisions: true,
  mediaDepth: true,
  businessDepth: true,
  antiDoping: false,
  detailedCommissions: true,
  persistentOfficials: true,
};

/** Reads a flag with its default, so no caller has to handle an absent settings block. */
export function featureEnabled(settings: SaveSettings | undefined, key: keyof FeatureFlags): boolean {
  return settings?.featureFlags?.[key] ?? DEFAULT_FEATURE_FLAGS[key];
}

export const DEFAULT_SETTINGS: SaveSettings = {
  difficulty: 'normal',
  revealRatings: false,
  revealLiveScores: false,
  allowTenTen: false,
  allowTenSeven: true,
  autoAdvanceStopsOnDecision: true,
  simSpeed: 'normal',
  potPaths: 160,
  potPercentile: 0.72,
  injuriesEnabled: true,
  eventsPerMonth: 3.83,
  fillRosterWithGenerated: true,
  retirementEnabled: true,
  featureFlags: { ...DEFAULT_FEATURE_FLAGS },
};

export interface SnapshotMeta {
  snapshotId: string;
  snapshotDate: IsoDate;
  generatedAt: string;
  sources: { name: string; url: string; fetchedAt: string; recordCount: number }[];
  fighterCountByDivision: Record<string, number>;
  validation: {
    totalFighters: number;
    realFighters: number;
    generatedFighters: number;
    missingFieldCounts: Record<string, number>;
    duplicatesResolved: { keptSlug: string; droppedSlug: string; reason: string }[];
    warnings: string[];
    /** Expected conditions that are not problems, such as a division no longer contested. */
    notes?: string[];
  };
  changeLog: string[];
  note: string;
}

export interface PlayerState {
  mode: GameMode;
  fighterId: FighterId | null;
  gymId: GymId | null;
  /** Coach identity when in Coach Mode. */
  coachStaffId: StaffId | null;
  coachName: string | null;
  /** Career achievement tracking, no single victory condition. */
  achievements: { key: string; label: string; date: IsoDate }[];
  reputation: number;
  balance: number;
}

export interface WorldHistory {
  results: Record<string, FightResult>;
  reigns: TitleReign[];
  news: NewsItem[];
  awards: SeasonAward[];
  hallOfFame: HallOfFameEntry[];
  rankingHistory: { date: IsoDate; divisionId: DivisionId; entries: { fighterId: FighterId; rank: number }[] }[];
  retirements: { fighterId: FighterId; date: IsoDate; reason: string }[];
}

export interface SaveGame {
  schemaVersion: number;
  saveId: string;
  saveName: string;
  createdAt: string;
  updatedAt: string;
  seed: number;
  rng: RngState;

  date: IsoDate;
  startDate: IsoDate;

  settings: SaveSettings;
  player: PlayerState;
  snapshot: SnapshotMeta;

  fighters: Record<FighterId, Fighter>;
  gyms: Record<GymId, Gym>;
  staff: Record<StaffId, GymStaff>;
  contracts: Record<ContractId, Contract>;
  events: Record<EventId, FightCardEvent>;
  bouts: Record<BoutId, Bout>;
  camps: Record<string, TrainingCamp>;

  rankings: Record<DivisionId, DivisionRankings>;
  pfp: PfpRankings;

  inbox: InboxMessage[];
  fightOffers: Record<string, FightOffer>;
  contractOffers: Record<string, ContractOffer>;

  history: WorldHistory;

  /** Fight week tasks, keyed by task id. Optional so older saves still load. */
  fightWeek?: Record<string, FightWeekTask>;
  /** The derived player career state, written on every advance so it persists. */
  careerState?: { state: string; reason: string; since: IsoDate; actionKey: string | null };
  /** Social and media items awaiting a reply, keyed by item id. */
  socialFeed?: Record<string, SocialItem>;
  /** Press conference and interview sessions, keyed by session id. */
  pressers?: Record<string, PresserSession>;
  /** Weigh in state per bout, keyed by bout id. */
  weighIns?: Record<string, WeighInState>;
  /** Every money movement. Balances are derived from it rather than tracked separately. */
  ledger?: LedgerEntry[];
  finance?: FinanceState;
  sponsors?: Record<string, Sponsor>;
  managers?: Record<string, Manager>;
  /** Anti-doping compliance and findings, keyed by fighter id. */
  doping?: Record<string, DopingState>;
  /** Chosen treatment per injury, so one injury asks once. */
  injuryTreatments?: Record<string, InjuryTreatment>;
  /** Fighter to fighter relationships, keyed by a sorted id pair. */
  relationships?: Record<string, Relationship>;
  /** Callouts made and answered. */
  callouts?: Record<string, Callout>;
  /** Weight class plans, keyed by fighter id. */
  weightClassPlans?: Record<string, WeightClassPlan>;
  /**
   * Live matchmaking interest, keyed by its own id.
   *
   * This is what a callout, a rivalry or a division debut leaves behind so the matchmaker can
   * act on it weeks later rather than only in the moment it was created.
   */
  matchupInterests?: Record<string, MatchupInterest>;
  /** Every division a fighter has competed in, keyed by fighter id, oldest first. */
  divisionHistory?: Record<string, DivisionSpell[]>;
  /**
   * Judges and referees, keyed by id.
   *
   * Officials are people in the world rather than a name drawn per fight, so a judge builds a
   * record and a controversial card stays attached to whoever turned it in.
   */
  officials?: Record<string, Official>;
  /**
   * The standing number one contender per division, keyed by division id.
   *
   * A title eliminator used to confer nothing. This is the earned, forfeitable claim on the next
   * title shot, and it is what makes "win this and you are next" a promise the game keeps.
   */
  contenders?: Record<string, ContenderStatus>;
  /**
   * Accumulated ranking points per division, keyed by fighter id.
   *
   * Separate from the ranked table because that table is truncated to fifteen slots. Keeping the
   * points here means a fighter who drops out of the rankings keeps the record of what they have
   * achieved and can climb back on merit.
   */
  rankingPoints?: Record<string, Record<string, number>>;
  /**
   * Remembered game plans. The interface preselects these rather than resetting to a
   * default every time a planning screen is opened.
   */
  gamePlans?: {
    /** The most recent plan chosen anywhere, used as the default for a new booking. */
    lastGeneral: GamePlanKey[] | null;
    lastGeneralOn: IsoDate | null;
    /** Per bout: the camp plan, the pre fight plan and the plan currently in the fight. */
    byBout: Record<string, { camp?: GamePlanKey[]; preFight?: GamePlanKey[]; inFight?: GamePlanKey[]; updatedOn: IsoDate; opponentId?: string }>;
  };

  /** Monotonic counters so generated ids never collide across a long save. */
  counters: Record<string, number>;

  /** Pending user decision that blocks auto advance. */
  pendingDecision: { kind: string; messageId: string | null } | null;
}

export interface SaveIndexEntry {
  saveId: string;
  saveName: string;
  mode: GameMode;
  date: IsoDate;
  updatedAt: string;
  fighterName: string | null;
  gymName: string | null;
  snapshotId: string;
  schemaVersion: number;
}
