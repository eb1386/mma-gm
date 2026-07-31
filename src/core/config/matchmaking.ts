/**
 * Matchmaking weights.
 *
 * These were previously numeric literals scattered through `scoreCandidate`, which made the
 * matchmaker impossible to reason about or tune without reading the whole function. Every value
 * that changes how a matchup is chosen lives here, named, with the effect it has stated.
 *
 * The scale is deliberately shared: a candidate score is roughly 0 to 130, so a weight of 20 is a
 * large thumb on the scale and a weight of 5 is a tiebreak.
 */
export const MATCHMAKING = {
  /** Base scores for the shape of the pairing before any modifier. */
  base: {
    /** A championship pairing dominates everything else. */
    titleFight: 100,
    /** Subtracted per ranking place of the challenger, so number one scores highest. */
    titleFightRankPenalty: 7,
    /** Two ranked fighters meeting. */
    rankedMatchup: 62,
    /** Subtracted per place of ranking gap between them. */
    rankedGapPenalty: 5.5,
    /** Added when both are inside the top five, which is what makes an eliminator. */
    eliminatorBonus: 22,
    /** A gap this wide is a mismatch. */
    wideGapThreshold: 8,
    wideGapPenalty: 25,
    /** A ranked fighter against an unranked one. */
    prospectTest: 26,
    prospectStreakBonus: 5,
    /** Penalty when a top ten fighter is matched with an unranked opponent. */
    topTenAgainstUnrankedPenalty: 18,
    /** Two unranked fighters. */
    unrankedPairing: 30,
    unrankedStreakGapPenalty: 2,
  },

  /**
   * Recent form.
   *
   * A losing streak makes a fighter a softer assignment and moves them down the card, which is
   * the pattern a real matchmaker follows. It was not considered at all before.
   */
  form: {
    /** Per loss in the current streak, applied to the pairing's appeal. */
    lossStreakPenalty: 7,
    /** A fighter on three or more losses is protected from a step up. */
    lossStreakProtectionAt: 3,
    lossStreakProtectionPenalty: 22,
    /** Per win in the current streak, capped. */
    winStreakBonus: 3.5,
    winStreakCap: 6,
  },

  /**
   * Championship history.
   *
   * A former champion is a bigger fight than their current ranking alone suggests, and matching
   * one against a preliminary opponent is a waste the matchmaker avoids.
   */
  pedigree: {
    formerChampionBonus: 9,
    perDefenseBonus: 1.6,
    perDefenseCap: 12,
    /** Penalty for pairing a decorated former champion with an unranked opponent. */
    pedigreeMismatchPenalty: 16,
  },

  /**
   * Strength of schedule.
   *
   * Measured over recent bouts as the share fought against ranked opposition. A fighter who has
   * been beating ranked opponents earns harder assignments; one who has not is stepped up
   * gradually rather than thrown in.
   */
  schedule: {
    /** How many recent bouts are considered. */
    window: 5,
    /** Applied to the difference in the two fighters' schedule strength. */
    mismatchPenalty: 18,
    /** Bonus when both have been facing comparable opposition. */
    parityBonus: 8,
  },

  /** Momentum with the promotion: recent bonuses, main events and finishes. */
  momentum: {
    perRecentFinish: 3,
    perRecentBonus: 4,
    recentWindowDays: 540,
    cap: 14,
  },

  /** Style, market and sales considerations. */
  appeal: {
    styleContrastWeight: 22,
    styleClashThreshold: 0.42,
    popularityWeight: 0.09,
    sameRegionBonus: 9,
    homeCountryBonus: 8,
  },

  /** Age and career stage. */
  age: {
    /** A gap this wide with a young fighter involved reads as a veteran test. */
    veteranTestGap: 7,
    veteranTestYoungerThan: 27,
    veteranTestBonus: 8,
  },

  /** Activity and availability pressure. */
  activity: {
    /** A long layoff means an easier assignment, unless the fighter is highly ranked. */
    longLayoffDays: 400,
    longLayoffBonus: 8,
    longLayoffRankedPenalty: 14,
    /** Waiting fighters are preferred. */
    waitBaselineDays: 220,
    waitDivisor: 40,
    waitFloor: -6,
    waitCeiling: 12,
  },

  /** Relationship and contract pressure. */
  relations: {
    lastFightOnContractBonus: 6,
    perDeclinedOfferPenalty: 4,
    matchmakerRelationshipDivisor: 6,
    matchmakerRelationshipCap: 8,
  },

  /** Rematch and trilogy handling. */
  rematch: {
    /** Meetings beyond this are refused outright. */
    maxMeetings: 3,
    /** A rematch inside this many days needs the first fight to have been close. */
    cooldownDays: 400,
    /** How close the first fight had to be, from `fightCloseness`. */
    closenessRequired: 0.7,
    rematchBonus: 14,
    trilogyBonus: 26,
  },

  /** Division congestion. */
  congestion: {
    crowdedRankedCount: 10,
    fillerPenalty: 10,
  },

  /** Random jitter so a long save stays varied. Applied last. */
  jitter: 7,

  /**
   * How the difficulty setting expresses itself in matchmaking.
   *
   * Score added per Ovr point of gap between the player and a candidate, times the difficulty
   * bias. A harder setting pulls stronger opponents up the list and a softer one pulls them down.
   *
   * This replaced shifting an index into the sorted candidate list. That could only ever make a
   * fight harder, because the list is sorted by what the matchmaker wants and index zero is its
   * floor, so both softer settings were inert and did nothing at all. Ovr gap is the measure
   * because it is the one thing that says how hard an assignment actually is, independent of
   * whether the matchmaker happens to like the pairing.
   *
   * Measured over three careers at a player Ovr of about 79.6, mean opponent Ovr comes out at
   * 62.7 / 68.4 / 72.4 / 73.7 across easy, normal, hard and brutal, with at least three distinct
   * opponents drawn at every setting. A larger value widens that spread but starts collapsing the
   * hardest setting onto a single opponent, which is the variety the draw exists to protect.
   */
  difficultyPerOvrPoint: 1,

  /**
   * Ceiling on the Ovr gap the difficulty adjustment will consider, in rating points.
   *
   * The gap is bounded before the bias multiplies it, not after. Bounding the finished product
   * compresses the difference between a strong candidate and a very strong one at exactly the
   * settings that are supposed to care about it most, which made the hardest setting less
   * discriminating than the one below it. Bounding the gap keeps the shape identical at every
   * setting and lets the bias scale it, so a harder setting is always more aggressive.
   *
   * At the hardest setting the adjustment therefore tops out near this value times the bias times
   * the per point weight, which stays under the 38 point gap between a championship pairing and
   * an ordinary ranked one. Difficulty picks among reasonable opponents. It does not get to
   * overrule what kind of fight is on offer.
   */
  difficultyOvrCap: 10,
} as const;

/**
 * Roster size against card supply.
 *
 * The calendar supplies about 46 events a year of roughly 12 bouts, which is 1104 fighter slots.
 * Divided by the configured roster that sets the average fights per fighter per year, and it is
 * the binding constraint on the activity bands: at a roster of 540 the average is 2.04, and once
 * champions and ranked contenders take their share there is nothing left for the unranked tier to
 * reach two fights a year.
 *
 * Scaling the target roster down is the single lever that makes the unranked band reachable
 * without inflating the number of events, which acceptance holds inside 40 to 52 a year.
 */
export const ROSTER_TARGET_SCALE = 0.82;

/** How strongly a live matchup interest or rivalry pulls a specific pairing. */
export const MATCHUP_PULL = {
  /** Multiplier on the 0 to 1 pull value for a positive pull. */
  positive: 85,
  /** Multiplier for a negative pull, which pushes two fighters apart. */
  negative: 60,
  /** At or below this the pairing is refused entirely, for example training partners. */
  refuseAtOrBelow: -0.9,
} as const;
