/**
 * Every tunable constant in the fight engine lives here. Nothing in sim/ may hardcode a
 * magic number that changes behavior. The calibration harness in tools/ reads this file,
 * runs large batches, and reports division level rate drift against the priors.
 */

export interface Calibration {
  /** Divisor in the logistic opposed check. Larger means less deterministic. */
  actionSpread: number;
  /** Divisor for grappling opposed checks, which are stickier than striking. */
  grappleSpread: number;
  /** Divisor for submission resolution. */
  submissionSpread: number;

  round: {
    seconds: number;
    restSeconds: number;
  };

  /** Seconds of fight clock consumed by each action family. */
  timeCost: {
    strikeSingle: number;
    strikeCombination: number;
    kick: number;
    movement: number;
    feint: number;
    clinchWork: number;
    takedownAttempt: number;
    scramble: number;
    groundControl: number;
    groundStrike: number;
    positionAdvance: number;
    submissionStage: number;
    standUp: number;
    refereeAction: number;
    knockdownFollowUp: number;
  };

  stamina: {
    /** Base pool. Cardio scales effective capacity, not this number. */
    max: number;
    /** Multiplier from cardio rating onto every stamina cost. */
    cardioCostScale: number;
    /** Recovery per second while at range and not exchanging. */
    passiveRecoveryPerSecond: number;
    /** Fraction of missing stamina restored during the between round rest. */
    betweenRoundRecovery: number;
    /** Recovery reduction from accumulated body damage. */
    bodyDamageRecoveryPenalty: number;
    costs: {
      punch: number;
      powerPunch: number;
      kick: number;
      spinning: number;
      knee: number;
      elbow: number;
      clinchWork: number;
      takedownAttempt: number;
      takedownDefense: number;
      scramble: number;
      groundControlPerSecond: number;
      submissionAttempt: number;
      standUp: number;
      wallWalk: number;
      pressureMovement: number;
    };
    /** Extra cost multiplier when a power strike misses badly. */
    missPenalty: number;
    /** Fatigue level below which effective ability starts dropping. */
    fatigueThreshold: number;
    /** Effective ability lost per point of stamina below the threshold. */
    fatiguePenaltyPerPoint: number;
  };

  damage: {
    /** Head damage that reliably produces a stoppage check failure. */
    headStoppageThreshold: number;
    /** Effective ability lost per point of head damage. */
    headPenaltyPerPoint: number;
    bodyPenaltyPerPoint: number;
    legPenaltyPerPoint: number;
    /** Between round recovery fraction per damage type. */
    recovery: { head: number; body: number; leg: number; balance: number };
    /** Base damage of a clean head strike before power scaling. */
    baseCleanHead: number;
    baseCleanBody: number;
    baseCleanLeg: number;
    baseGroundStrike: number;
    partialMultiplier: number;
    blockedMultiplier: number;
    /** Multiplier on damage from durability difference. */
    durabilityScale: number;
    /** Chance a clean head strike opens or worsens a cut, before modifiers. */
    cutBaseChance: number;
    cutStoppageThreshold: number;
  };

  knockdown: {
    /** Base chance a clean head strike scores a knockdown at parity. */
    base: number;
    /** Multiplier per point of striking advantage. */
    strikingScale: number;
    /** Multiplier per point of durability deficit. */
    durabilityScale: number;
    /** Multiplier from accumulated head damage. */
    accumulationScale: number;
    /** Multiplier when the defender is stunned. */
    stunnedMultiplier: number;
    /** Multiplier when the defender is badly fatigued. */
    fatiguedMultiplier: number;
    /** Seconds of vulnerability after a knockdown. */
    vulnerabilitySeconds: number;
  };

  stun: {
    base: number;
    durationSeconds: number;
    abilityPenalty: number;
  };

  stoppage: {
    /** Unanswered clean strikes on a hurt fighter before a stoppage check begins. */
    unansweredThreshold: number;
    /** Per check probability at the threshold. */
    baseCheck: number;
    /** Growth per additional unanswered strike. */
    perExtraStrike: number;
    /** Referee tendency spread. Drawn per fight. */
    refereeTendencySd: number;
    /** Chance a badly cut fighter gets a doctor stoppage at a round break. */
    doctorBase: number;
    /** Chance a corner stops it when the fighter is badly beaten between rounds. */
    cornerBase: number;
    /** Chance of retirement on stool from a severe body or leg injury. */
    retirementBase: number;
  };

  striking: {
    /** Reach advantage in inches converted to effective ability at long range. */
    reachAdvantagePerInch: number;
    /** Height advantage effect, smaller than reach. */
    heightAdvantagePerInch: number;
    /** Bonus for the southpaw in an open stance matchup. */
    openStanceBonus: number;
    /** Accuracy loss per point of the defender's striking advantage. */
    defenseWeight: number;
    /** Chance a miss is punished by a counter. */
    counterBase: number;
    /** Multiplier on counter chance for counter tendency. */
    counterTendencyScale: number;
    /** Leg damage that starts degrading movement and takedown entries. */
    legDamageMobilityThreshold: number;
  };

  wrestling: {
    /** Effective ability weight of the wrestling rating on takedown entries. */
    entryWeight: number;
    /** Weight of grappling on scramble outcomes. */
    scrambleGrapplingWeight: number;
    /** Chance a stuffed takedown gives the defender an advantageous position. */
    stuffCounterChance: number;
    /** Chance a completed takedown lands directly in a better position than guard. */
    dominantLandingChance: number;
    /** Fence proximity chance when a takedown stalls. */
    fenceStallChance: number;
  };

  grappling: {
    /** Base per attempt chance of advancing position at parity. */
    advanceBase: number;
    /** Base sweep chance from bottom at parity. */
    sweepBase: number;
    /** Base stand up chance from bottom at parity. */
    standUpBase: number;
    /** Referee stand up after this many seconds of no meaningful action. */
    inactivityStandUpSeconds: number;
  };

  submission: {
    /** Base chance an entry becomes a secured position. */
    entryBase: number;
    /** Base chance a secured submission progresses past defense. */
    securedBase: number;
    /** Base chance the final adjustment forces a tap. */
    finishBase: number;
    /** Multiplier on finish chance from defender fatigue. */
    fatigueScale: number;
    /** Chance a failed submission costs the attacker position. */
    positionLossOnFail: number;
    /** Chance a technical submission occurs instead of a tap. */
    technicalChance: number;
  };

  judging: {
    /** Score weight of significant strike differential. */
    strikeWeight: number;
    /** Score weight of damage differential. */
    damageWeight: number;
    /** Score weight of knockdowns. */
    knockdownWeight: number;
    /** Score weight of control seconds. */
    controlWeight: number;
    /** Score weight of takedowns. */
    takedownWeight: number;
    /** Score weight of submission attempts. */
    submissionAttemptWeight: number;
    /** Score weight of aggression, used only when the first criterion is close. */
    aggressionWeight: number;
    /** Score weight of cage control, used only as the third criterion. */
    cageControlWeight: number;
    /** Margin below which the round is considered effectively even. */
    evenMargin: number;
    tenEightImpact: number;
    tenSevenImpact: number;
    impactNoiseSd: number;
    /** Margin above which a 10-8 becomes likely. */
    dominantMargin: number;
    /** Margin for a 10-7. */
    overwhelmingMargin: number;
    /** Per judge perception noise standard deviation. */
    judgeNoiseSd: number;
    /** Individual judge bias sd, drawn once per fight per judge. */
    judgeBiasSd: number;
  };

  ai: {
    /** How strongly a fighter chases a finish when behind late. */
    desperationScale: number;
    /** How strongly a fighter protects a lead late. */
    leadProtectionScale: number;
    /** Weight the AI puts on exploiting an opponent weakness it has scouted. */
    exploitWeight: number;
    /** Pacing target for five round fights, 0 to 1. */
    fiveRoundPacing: number;
    /** Chance per exchange the AI re evaluates its primary approach. */
    reevaluateChance: number;
  };

  fight: {
    /** Multiplier on all output for the high pace game plan. */
    highPaceOutput: number;
    highPaceStaminaCost: number;
    conservativeOutput: number;
    conservativeStaminaCost: number;
    /** Camp sharpness effect on effective ability, at full sharpness. */
    sharpnessMax: number;
    /** Tactical familiarity effect on defensive reads. */
    familiarityMax: number;
    /** Effective ability penalty for a badly missed weight cut. */
    badCutPenalty: number;
    /** Effective ability penalty for a short notice fight with no camp. */
    noCampPenalty: number;
    /** Experience curve, effective ability bonus at high UFC fight counts. */
    experienceMax: number;
    /** Fights needed to reach most of the experience bonus. */
    experienceHalfLife: number;
    /** Age at which the in fight composure bonus peaks. */
    composurePeakAge: number;
  };

  longevity: {
    /** Longevity cost per point of head damage taken in a fight. */
    perHeadDamage: number;
    perKnockdown: number;
    perKoLoss: number;
    perBodyDamage: number;
    perLegDamage: number;
    perJointDamage: number;
    perCut: number;
    /** Cost of a five round fight beyond the damage taken. */
    perChampionshipRound: number;
    /** Cost per severe weight cut. */
    perSevereCut: number;
    /** Cost per hard training camp week. */
    perHardCampWeek: number;
    /** Passive recovery per rest week, applied to the recovery component only. */
    restRecoveryPerWeek: number;
    /** Fraction of neurological wear that is permanent. */
    permanentFraction: number;
  };
}

export const CALIBRATION: Calibration = {
  actionSpread: 11.5,
  grappleSpread: 10.0,
  submissionSpread: 9.0,

  round: { seconds: 300, restSeconds: 60 },

  timeCost: {
    strikeSingle: 1.95,
    strikeCombination: 3.5,
    kick: 2.4,
    movement: 3.4,
    feint: 2.4,
    clinchWork: 4.6,
    takedownAttempt: 5.0,
    scramble: 4.4,
    groundControl: 8.0,
    groundStrike: 2.7,
    positionAdvance: 6.0,
    submissionStage: 5.0,
    standUp: 5.4,
    refereeAction: 8.0,
    knockdownFollowUp: 2.0,
  },

  stamina: {
    max: 100,
    cardioCostScale: 0.85,
    passiveRecoveryPerSecond: 0.22,
    betweenRoundRecovery: 0.34,
    bodyDamageRecoveryPenalty: 0.006,
    costs: {
      punch: 0.55,
      powerPunch: 1.15,
      kick: 1.05,
      spinning: 1.9,
      knee: 1.1,
      elbow: 0.8,
      clinchWork: 1.5,
      takedownAttempt: 3.4,
      takedownDefense: 2.6,
      scramble: 2.9,
      groundControlPerSecond: 0.13,
      submissionAttempt: 2.2,
      standUp: 2.4,
      wallWalk: 1.8,
      pressureMovement: 0.5,
    },
    missPenalty: 1.45,
    fatigueThreshold: 62,
    fatiguePenaltyPerPoint: 0.32,
  },

  damage: {
    headStoppageThreshold: 100,
    headPenaltyPerPoint: 0.15,
    bodyPenaltyPerPoint: 0.08,
    legPenaltyPerPoint: 0.1,
    recovery: { head: 0.2, body: 0.14, leg: 0.05, balance: 0.85 },
    baseCleanHead: 6.6,
    baseCleanBody: 5.0,
    baseCleanLeg: 5.6,
    baseGroundStrike: 4.4,
    partialMultiplier: 0.42,
    blockedMultiplier: 0.14,
    durabilityScale: 0.011,
    cutBaseChance: 0.028,
    cutStoppageThreshold: 96,
  },

  knockdown: {
    base: 0.0098,
    strikingScale: 0.019,
    durabilityScale: 0.021,
    accumulationScale: 0.011,
    stunnedMultiplier: 2.7,
    fatiguedMultiplier: 1.7,
    vulnerabilitySeconds: 12,
  },

  stun: { base: 0.042, durationSeconds: 10, abilityPenalty: 13 },

  stoppage: {
    unansweredThreshold: 5,
    baseCheck: 0.185,
    perExtraStrike: 0.135,
    refereeTendencySd: 0.13,
    doctorBase: 0.034,
    cornerBase: 0.021,
    retirementBase: 0.012,
  },

  striking: {
    reachAdvantagePerInch: 0.62,
    heightAdvantagePerInch: 0.24,
    openStanceBonus: 1.2,
    defenseWeight: 0.92,
    counterBase: 0.1,
    counterTendencyScale: 0.16,
    legDamageMobilityThreshold: 26,
  },

  wrestling: {
    entryWeight: 1.0,
    scrambleGrapplingWeight: 0.62,
    stuffCounterChance: 0.17,
    dominantLandingChance: 0.19,
    fenceStallChance: 0.24,
  },

  grappling: {
    advanceBase: 0.3,
    sweepBase: 0.16,
    standUpBase: 0.26,
    inactivityStandUpSeconds: 48,
  },

  submission: {
    entryBase: 0.3,
    securedBase: 0.26,
    finishBase: 0.072,
    fatigueScale: 0.5,
    positionLossOnFail: 0.27,
    technicalChance: 0.11,
  },

  judging: {
    strikeWeight: 1.0,
    damageWeight: 1.55,
    knockdownWeight: 9.0,
    controlWeight: 0.032,
    takedownWeight: 3.1,
    submissionAttemptWeight: 2.4,
    aggressionWeight: 0.5,
    cageControlWeight: 0.35,
    evenMargin: 2.4,
    // A round must be clearly won before it can be scored wide at all. These are measured
    // on the criteria scale, which is dominated by landed strikes.
    dominantMargin: 12,
    overwhelmingMargin: 30,
    // Impact thresholds on a 0 to 1 scale. Reaching 10-8 needs real damage, a knockdown or
    // genuine submission danger. Reaching 10-7 additionally needs two knockdowns.
    tenEightImpact: 0.95,
    tenSevenImpact: 0.97,
    impactNoiseSd: 0.05,
    judgeNoiseSd: 2.5,
    judgeBiasSd: 1.6,
  },

  ai: {
    desperationScale: 1.5,
    leadProtectionScale: 1.15,
    exploitWeight: 0.8,
    fiveRoundPacing: 0.82,
    reevaluateChance: 0.3,
  },

  fight: {
    highPaceOutput: 1.24,
    highPaceStaminaCost: 1.3,
    conservativeOutput: 0.79,
    conservativeStaminaCost: 0.82,
    sharpnessMax: 4.0,
    familiarityMax: 3.0,
    badCutPenalty: 6.5,
    noCampPenalty: 5.0,
    experienceMax: 4.0,
    experienceHalfLife: 8,
    composurePeakAge: 31,
  },

  longevity: {
    perHeadDamage: 0.016,
    perKnockdown: 0.55,
    perKoLoss: 1.9,
    perBodyDamage: 0.009,
    perLegDamage: 0.008,
    perJointDamage: 0.05,
    perCut: 0.16,
    perChampionshipRound: 0.24,
    perSevereCut: 0.9,
    perHardCampWeek: 0.075,
    restRecoveryPerWeek: 0.34,
    permanentFraction: 0.72,
  },
};

export interface DifficultyConfig {
  /** Multiplier applied to camp gains and development. */
  developmentScale: number;
  /** Multiplier applied to contract and purse offers to the player. */
  payScale: number;
  /** Multiplier on the promotion's willingness to concede in negotiation. */
  negotiationScale: number;
  /** Multiplier on injury probability for the player's fighters. */
  injuryScale: number;
  /** Bias added to opponent quality selection, in ranking places. */
  matchmakingBias: number;
  /** Multiplier on Longevity costs for the player. */
  longevityScale: number;
  /** Scouting accuracy bonus levels. */
  scoutingBonus: number;
}

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard' | 'brutal', DifficultyConfig> = {
  easy: {
    developmentScale: 1.25,
    payScale: 1.25,
    negotiationScale: 1.3,
    injuryScale: 0.7,
    matchmakingBias: 1.5,
    longevityScale: 0.75,
    scoutingBonus: 1,
  },
  normal: {
    developmentScale: 1.0,
    payScale: 1.0,
    negotiationScale: 1.0,
    injuryScale: 1.0,
    matchmakingBias: 0,
    longevityScale: 1.0,
    scoutingBonus: 0,
  },
  hard: {
    developmentScale: 0.85,
    payScale: 0.85,
    negotiationScale: 0.78,
    injuryScale: 1.2,
    matchmakingBias: -1.5,
    longevityScale: 1.15,
    scoutingBonus: 0,
  },
  brutal: {
    developmentScale: 0.72,
    payScale: 0.72,
    negotiationScale: 0.6,
    injuryScale: 1.45,
    matchmakingBias: -3,
    longevityScale: 1.35,
    scoutingBonus: -1,
  },
};
