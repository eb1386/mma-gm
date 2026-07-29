/**
 * Divisions are configuration, not hardcoded logic. Adding a division is a data edit.
 * Nothing in the engine may branch on a specific division id.
 */

export type DivisionId =
  | 'flyweight'
  | 'bantamweight'
  | 'featherweight'
  | 'lightweight'
  | 'welterweight'
  | 'middleweight'
  | 'light-heavyweight'
  | 'heavyweight'
  | 'womens-strawweight'
  | 'womens-flyweight'
  | 'womens-bantamweight'
  | 'womens-featherweight';

export type DivisionGender = 'men' | 'women';

export interface DivisionConfig {
  id: DivisionId;
  name: string;
  shortName: string;
  abbr: string;
  gender: DivisionGender;
  /** First year this division existed. Used by historical start dates. */
  activeFrom: number;
  /** Last year this division existed, or null while it is still contested. */
  activeUntil: number | null;
  /** Championship weight limit in pounds. */
  limitLb: number;
  /** Allowance above the limit for non title bouts. */
  nonTitleAllowanceLb: number;
  /** Lower bound of the division for catchweight and division move logic. */
  floorLb: number;
  order: number;
  /** Typical walking weight above the limit, used for weight cut modelling. */
  typicalWalkAroundOverLb: number;
  /** Division wide physical priors used by generation and by rating normalization. */
  priors: {
    heightIn: { mean: number; sd: number };
    reachIn: { mean: number; sd: number };
    /** Sig strikes landed per minute across the division. */
    slpm: { mean: number; sd: number };
    /** Sig strikes absorbed per minute. */
    sapm: { mean: number; sd: number };
    /** Significant strike accuracy as a fraction. */
    strAcc: { mean: number; sd: number };
    /** Significant strike defense as a fraction. */
    strDef: { mean: number; sd: number };
    /** Takedowns landed per 15 minutes. */
    tdAvg: { mean: number; sd: number };
    /** Takedown accuracy as a fraction. */
    tdAcc: { mean: number; sd: number };
    /** Takedown defense as a fraction. */
    tdDef: { mean: number; sd: number };
    /** Submission attempts per 15 minutes. */
    subAvg: { mean: number; sd: number };
    /** Knockdowns per 15 minutes. */
    kdAvg: { mean: number; sd: number };
  };
  /** Multiplier on knockdown and knockout probability. Heavier hits harder. */
  powerFactor: number;
  /** Multiplier on stamina drain. Heavier fighters tire faster. */
  fatigueFactor: number;
  /** Baseline number of active fighters the world keeps in this division. */
  targetRosterSize: number;
  /** Division specific age distribution for generated fighters. */
  ageProfile: { mean: number; sd: number; min: number; max: number };
  /** Division specific finish rate target, used by the calibration harness. */
  finishRateTarget: number;
  /** Multiplier on the base knockdown chance beyond the power factor. */
  knockdownScale: number;
  /** Multiplier on submission attempt frequency. */
  submissionScale: number;
  /** Relative interest a card built around this division draws. */
  drawWeight: number;
}

/**
 * Physical and rate priors are set from the shape of publicly reported UFC division
 * statistics. They are calibration constants for the normalization step, deliberately
 * kept in one editable place. They are not presented anywhere as official measurements.
 */
export const DIVISIONS: DivisionConfig[] = [
  {
    id: 'flyweight',
    gender: 'men',
    activeFrom: 2012,
    activeUntil: null,
    name: 'Flyweight',
    shortName: 'Flyweight',
    abbr: 'FLW',
    limitLb: 125,
    nonTitleAllowanceLb: 1,
    floorLb: 116,
    order: 0,
    typicalWalkAroundOverLb: 18,
    powerFactor: 0.72,
    fatigueFactor: 0.86,
    targetRosterSize: 44,
    ageProfile: { mean: 28.5, sd: 3.4, min: 21, max: 39 },
    finishRateTarget: 0.42,
    knockdownScale: 0.85,
    submissionScale: 1.15,
    drawWeight: 0.72,
    priors: {
      heightIn: { mean: 65.5, sd: 1.9 },
      reachIn: { mean: 67.0, sd: 2.4 },
      slpm: { mean: 4.35, sd: 1.15 },
      sapm: { mean: 3.75, sd: 1.05 },
      strAcc: { mean: 0.44, sd: 0.07 },
      strDef: { mean: 0.57, sd: 0.07 },
      tdAvg: { mean: 1.95, sd: 1.35 },
      tdAcc: { mean: 0.38, sd: 0.13 },
      tdDef: { mean: 0.62, sd: 0.16 },
      subAvg: { mean: 0.75, sd: 0.75 },
      kdAvg: { mean: 0.35, sd: 0.35 },
    },
  },
  {
    id: 'bantamweight',
    gender: 'men',
    activeFrom: 2010,
    activeUntil: null,
    name: 'Bantamweight',
    shortName: 'Bantamweight',
    abbr: 'BW',
    limitLb: 135,
    nonTitleAllowanceLb: 1,
    floorLb: 126,
    order: 1,
    typicalWalkAroundOverLb: 19,
    powerFactor: 0.79,
    fatigueFactor: 0.9,
    targetRosterSize: 56,
    ageProfile: { mean: 29.0, sd: 3.5, min: 21, max: 39 },
    finishRateTarget: 0.44,
    knockdownScale: 0.92,
    submissionScale: 1.1,
    drawWeight: 0.82,
    priors: {
      heightIn: { mean: 67.0, sd: 2.0 },
      reachIn: { mean: 68.8, sd: 2.6 },
      slpm: { mean: 4.15, sd: 1.15 },
      sapm: { mean: 3.6, sd: 1.05 },
      strAcc: { mean: 0.43, sd: 0.07 },
      strDef: { mean: 0.57, sd: 0.07 },
      tdAvg: { mean: 1.9, sd: 1.4 },
      tdAcc: { mean: 0.37, sd: 0.13 },
      tdDef: { mean: 0.63, sd: 0.16 },
      subAvg: { mean: 0.72, sd: 0.72 },
      kdAvg: { mean: 0.42, sd: 0.4 },
    },
  },
  {
    id: 'featherweight',
    gender: 'men',
    activeFrom: 2010,
    activeUntil: null,
    name: 'Featherweight',
    shortName: 'Featherweight',
    abbr: 'FW',
    limitLb: 145,
    nonTitleAllowanceLb: 1,
    floorLb: 136,
    order: 2,
    typicalWalkAroundOverLb: 20,
    powerFactor: 0.86,
    fatigueFactor: 0.94,
    targetRosterSize: 58,
    ageProfile: { mean: 29.2, sd: 3.6, min: 21, max: 40 },
    finishRateTarget: 0.47,
    knockdownScale: 0.98,
    submissionScale: 1.02,
    drawWeight: 0.92,
    priors: {
      heightIn: { mean: 68.5, sd: 2.1 },
      reachIn: { mean: 70.5, sd: 2.7 },
      slpm: { mean: 3.95, sd: 1.15 },
      sapm: { mean: 3.45, sd: 1.05 },
      strAcc: { mean: 0.43, sd: 0.07 },
      strDef: { mean: 0.57, sd: 0.07 },
      tdAvg: { mean: 1.7, sd: 1.4 },
      tdAcc: { mean: 0.36, sd: 0.13 },
      tdDef: { mean: 0.64, sd: 0.16 },
      subAvg: { mean: 0.66, sd: 0.7 },
      kdAvg: { mean: 0.45, sd: 0.42 },
    },
  },
  {
    id: 'lightweight',
    gender: 'men',
    activeFrom: 1997,
    activeUntil: null,
    name: 'Lightweight',
    shortName: 'Lightweight',
    abbr: 'LW',
    limitLb: 155,
    nonTitleAllowanceLb: 1,
    floorLb: 146,
    order: 3,
    typicalWalkAroundOverLb: 21,
    powerFactor: 0.93,
    fatigueFactor: 0.98,
    targetRosterSize: 70,
    ageProfile: { mean: 29.4, sd: 3.6, min: 21, max: 40 },
    finishRateTarget: 0.48,
    knockdownScale: 1.02,
    submissionScale: 0.98,
    drawWeight: 1.1,
    priors: {
      heightIn: { mean: 70.0, sd: 2.1 },
      reachIn: { mean: 72.0, sd: 2.8 },
      slpm: { mean: 3.8, sd: 1.15 },
      sapm: { mean: 3.35, sd: 1.05 },
      strAcc: { mean: 0.43, sd: 0.07 },
      strDef: { mean: 0.58, sd: 0.07 },
      tdAvg: { mean: 1.6, sd: 1.4 },
      tdAcc: { mean: 0.36, sd: 0.13 },
      tdDef: { mean: 0.65, sd: 0.16 },
      subAvg: { mean: 0.6, sd: 0.68 },
      kdAvg: { mean: 0.5, sd: 0.45 },
    },
  },
  {
    id: 'welterweight',
    gender: 'men',
    activeFrom: 1997,
    activeUntil: null,
    name: 'Welterweight',
    shortName: 'Welterweight',
    abbr: 'WW',
    limitLb: 170,
    nonTitleAllowanceLb: 1,
    floorLb: 156,
    order: 4,
    typicalWalkAroundOverLb: 22,
    powerFactor: 1.0,
    fatigueFactor: 1.02,
    targetRosterSize: 64,
    ageProfile: { mean: 29.8, sd: 3.7, min: 21, max: 41 },
    finishRateTarget: 0.49,
    knockdownScale: 1.06,
    submissionScale: 0.94,
    drawWeight: 1.05,
    priors: {
      heightIn: { mean: 71.3, sd: 2.2 },
      reachIn: { mean: 73.6, sd: 2.9 },
      slpm: { mean: 3.6, sd: 1.1 },
      sapm: { mean: 3.2, sd: 1.0 },
      strAcc: { mean: 0.44, sd: 0.07 },
      strDef: { mean: 0.58, sd: 0.07 },
      tdAvg: { mean: 1.55, sd: 1.4 },
      tdAcc: { mean: 0.36, sd: 0.13 },
      tdDef: { mean: 0.66, sd: 0.16 },
      subAvg: { mean: 0.55, sd: 0.65 },
      kdAvg: { mean: 0.55, sd: 0.48 },
    },
  },
  {
    id: 'middleweight',
    gender: 'men',
    activeFrom: 1997,
    activeUntil: null,
    name: 'Middleweight',
    shortName: 'Middleweight',
    abbr: 'MW',
    limitLb: 185,
    nonTitleAllowanceLb: 1,
    floorLb: 171,
    order: 5,
    typicalWalkAroundOverLb: 23,
    powerFactor: 1.08,
    fatigueFactor: 1.07,
    targetRosterSize: 56,
    ageProfile: { mean: 30.2, sd: 3.8, min: 21, max: 42 },
    finishRateTarget: 0.52,
    knockdownScale: 1.12,
    submissionScale: 0.88,
    drawWeight: 0.98,
    priors: {
      heightIn: { mean: 73.0, sd: 2.2 },
      reachIn: { mean: 75.3, sd: 3.0 },
      slpm: { mean: 3.5, sd: 1.1 },
      sapm: { mean: 3.15, sd: 1.0 },
      strAcc: { mean: 0.45, sd: 0.07 },
      strDef: { mean: 0.57, sd: 0.07 },
      tdAvg: { mean: 1.5, sd: 1.4 },
      tdAcc: { mean: 0.36, sd: 0.13 },
      tdDef: { mean: 0.66, sd: 0.16 },
      subAvg: { mean: 0.5, sd: 0.62 },
      kdAvg: { mean: 0.62, sd: 0.52 },
    },
  },
  {
    id: 'light-heavyweight',
    gender: 'men',
    activeFrom: 1997,
    activeUntil: null,
    name: 'Light Heavyweight',
    shortName: 'Light Heavy',
    abbr: 'LHW',
    limitLb: 205,
    nonTitleAllowanceLb: 1,
    floorLb: 186,
    order: 6,
    typicalWalkAroundOverLb: 25,
    powerFactor: 1.16,
    fatigueFactor: 1.14,
    targetRosterSize: 44,
    ageProfile: { mean: 30.8, sd: 4.0, min: 21, max: 43 },
    finishRateTarget: 0.56,
    knockdownScale: 1.22,
    submissionScale: 0.8,
    drawWeight: 0.94,
    priors: {
      heightIn: { mean: 74.5, sd: 2.2 },
      reachIn: { mean: 77.0, sd: 3.0 },
      slpm: { mean: 3.35, sd: 1.1 },
      sapm: { mean: 3.05, sd: 1.0 },
      strAcc: { mean: 0.46, sd: 0.07 },
      strDef: { mean: 0.56, sd: 0.07 },
      tdAvg: { mean: 1.45, sd: 1.4 },
      tdAcc: { mean: 0.37, sd: 0.13 },
      tdDef: { mean: 0.65, sd: 0.16 },
      subAvg: { mean: 0.45, sd: 0.58 },
      kdAvg: { mean: 0.72, sd: 0.58 },
    },
  },
  {
    id: 'heavyweight',
    gender: 'men',
    activeFrom: 1993,
    activeUntil: null,
    name: 'Heavyweight',
    shortName: 'Heavyweight',
    abbr: 'HW',
    limitLb: 265,
    nonTitleAllowanceLb: 0,
    floorLb: 206,
    order: 7,
    typicalWalkAroundOverLb: 8,
    powerFactor: 1.3,
    fatigueFactor: 1.26,
    targetRosterSize: 40,
    ageProfile: { mean: 31.6, sd: 4.4, min: 21, max: 45 },
    finishRateTarget: 0.66,
    knockdownScale: 1.45,
    submissionScale: 0.7,
    drawWeight: 1.0,
    priors: {
      heightIn: { mean: 75.5, sd: 2.4 },
      reachIn: { mean: 77.8, sd: 3.2 },
      slpm: { mean: 3.2, sd: 1.15 },
      sapm: { mean: 3.0, sd: 1.05 },
      strAcc: { mean: 0.47, sd: 0.08 },
      strDef: { mean: 0.54, sd: 0.08 },
      tdAvg: { mean: 1.35, sd: 1.35 },
      tdAcc: { mean: 0.38, sd: 0.14 },
      tdDef: { mean: 0.63, sd: 0.17 },
      subAvg: { mean: 0.4, sd: 0.55 },
      kdAvg: { mean: 0.95, sd: 0.7 },
    },
  },
  {
    id: 'womens-strawweight',
    gender: 'women',
    activeFrom: 2014,
    activeUntil: null,
    name: "Women's Strawweight",
    shortName: 'W Strawweight',
    abbr: 'WSW',
    limitLb: 115,
    nonTitleAllowanceLb: 1,
    floorLb: 105,
    order: 8,
    typicalWalkAroundOverLb: 15,
    powerFactor: 0.58,
    fatigueFactor: 0.8,
    targetRosterSize: 34,
    ageProfile: { mean: 29.6, sd: 3.3, min: 21, max: 39 },
    finishRateTarget: 0.36,
    knockdownScale: 0.6,
    submissionScale: 1.2,
    drawWeight: 0.72,
    priors: {
      heightIn: { mean: 64.0, sd: 1.8 },
      reachIn: { mean: 64.6, sd: 2.2 },
      slpm: { mean: 4.6, sd: 1.2 },
      sapm: { mean: 4.0, sd: 1.1 },
      strAcc: { mean: 0.4, sd: 0.07 },
      strDef: { mean: 0.58, sd: 0.07 },
      tdAvg: { mean: 2.35, sd: 1.5 },
      tdAcc: { mean: 0.36, sd: 0.13 },
      tdDef: { mean: 0.6, sd: 0.17 },
      subAvg: { mean: 0.85, sd: 0.8 },
      kdAvg: { mean: 0.22, sd: 0.28 },
    },
  },
  {
    id: 'womens-flyweight',
    gender: 'women',
    activeFrom: 2017,
    activeUntil: null,
    name: "Women's Flyweight",
    shortName: 'W Flyweight',
    abbr: 'WFLW',
    limitLb: 125,
    nonTitleAllowanceLb: 1,
    floorLb: 116,
    order: 9,
    typicalWalkAroundOverLb: 16,
    powerFactor: 0.63,
    fatigueFactor: 0.83,
    targetRosterSize: 32,
    ageProfile: { mean: 30.0, sd: 3.4, min: 21, max: 40 },
    finishRateTarget: 0.4,
    knockdownScale: 0.66,
    submissionScale: 1.15,
    drawWeight: 0.7,
    priors: {
      heightIn: { mean: 65.4, sd: 1.9 },
      reachIn: { mean: 66.2, sd: 2.3 },
      slpm: { mean: 4.4, sd: 1.2 },
      sapm: { mean: 3.9, sd: 1.1 },
      strAcc: { mean: 0.41, sd: 0.07 },
      strDef: { mean: 0.58, sd: 0.07 },
      tdAvg: { mean: 2.15, sd: 1.5 },
      tdAcc: { mean: 0.36, sd: 0.13 },
      tdDef: { mean: 0.62, sd: 0.17 },
      subAvg: { mean: 0.8, sd: 0.78 },
      kdAvg: { mean: 0.26, sd: 0.3 },
    },
  },
  {
    id: 'womens-bantamweight',
    gender: 'women',
    activeFrom: 2012,
    activeUntil: null,
    name: "Women's Bantamweight",
    shortName: 'W Bantamweight',
    abbr: 'WBW',
    limitLb: 135,
    nonTitleAllowanceLb: 1,
    floorLb: 126,
    order: 10,
    typicalWalkAroundOverLb: 17,
    powerFactor: 0.7,
    fatigueFactor: 0.87,
    targetRosterSize: 30,
    ageProfile: { mean: 30.4, sd: 3.6, min: 21, max: 41 },
    finishRateTarget: 0.45,
    knockdownScale: 0.74,
    submissionScale: 1.1,
    drawWeight: 0.78,
    priors: {
      heightIn: { mean: 66.6, sd: 2.0 },
      reachIn: { mean: 67.4, sd: 2.5 },
      slpm: { mean: 4.15, sd: 1.2 },
      sapm: { mean: 3.75, sd: 1.1 },
      strAcc: { mean: 0.41, sd: 0.07 },
      strDef: { mean: 0.57, sd: 0.07 },
      tdAvg: { mean: 2.0, sd: 1.5 },
      tdAcc: { mean: 0.37, sd: 0.13 },
      tdDef: { mean: 0.62, sd: 0.17 },
      subAvg: { mean: 0.76, sd: 0.76 },
      kdAvg: { mean: 0.3, sd: 0.33 },
    },
  },
  {
    id: 'womens-featherweight',
    gender: 'women',
    activeFrom: 2017,
    activeUntil: 2023,
    name: "Women's Featherweight",
    shortName: 'W Featherweight',
    abbr: 'WFW',
    limitLb: 145,
    nonTitleAllowanceLb: 1,
    floorLb: 136,
    order: 11,
    typicalWalkAroundOverLb: 18,
    powerFactor: 0.76,
    fatigueFactor: 0.9,
    targetRosterSize: 12,
    ageProfile: { mean: 31.0, sd: 3.8, min: 21, max: 42 },
    finishRateTarget: 0.5,
    knockdownScale: 0.82,
    submissionScale: 1.05,
    drawWeight: 0.6,
    priors: {
      heightIn: { mean: 68.0, sd: 2.1 },
      reachIn: { mean: 68.8, sd: 2.6 },
      slpm: { mean: 4.0, sd: 1.2 },
      sapm: { mean: 3.7, sd: 1.1 },
      strAcc: { mean: 0.42, sd: 0.07 },
      strDef: { mean: 0.56, sd: 0.08 },
      tdAvg: { mean: 1.9, sd: 1.5 },
      tdAcc: { mean: 0.38, sd: 0.14 },
      tdDef: { mean: 0.6, sd: 0.18 },
      subAvg: { mean: 0.72, sd: 0.74 },
      kdAvg: { mean: 0.36, sd: 0.36 },
    },
  },
];

export const DIVISION_BY_ID: Record<DivisionId, DivisionConfig> = Object.fromEntries(
  DIVISIONS.map((d) => [d.id, d])
) as Record<DivisionId, DivisionConfig>;

export const DIVISION_IDS: DivisionId[] = DIVISIONS.map((d) => d.id);

/** Maps a name from a data source onto a division id. Returns null when unmatched. */
export function divisionFromLabel(label: string | null | undefined): DivisionId | null {
  if (!label) return null;
  const decoded = label.replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');
  const isWomens = /women/i.test(decoded);
  // Punctuation is stripped first, so a straight apostrophe, a typographic apostrophe and
  // an HTML escaped apostrophe all normalize to the same key.
  const letters = decoded.toLowerCase().replace(/division/g, '').replace(/[^a-z]/g, '');
  const norm = isWomens ? letters.replace(/^womens?/, '') : letters;
  const mens: Record<string, DivisionId> = {
    flyweight: 'flyweight',
    bantamweight: 'bantamweight',
    featherweight: 'featherweight',
    lightweight: 'lightweight',
    welterweight: 'welterweight',
    middleweight: 'middleweight',
    lightheavyweight: 'light-heavyweight',
    heavyweight: 'heavyweight',
  };
  const womens: Record<string, DivisionId> = {
    strawweight: 'womens-strawweight',
    flyweight: 'womens-flyweight',
    bantamweight: 'womens-bantamweight',
    featherweight: 'womens-featherweight',
  };
  return (isWomens ? womens[norm] : mens[norm]) ?? null;
}

/** Divisions that were being contested in a given year. */
export function divisionsInYear(year: number): DivisionConfig[] {
  return DIVISIONS.filter((d) => d.activeFrom <= year && (d.activeUntil === null || d.activeUntil >= year));
}

export function divisionsForGender(gender: DivisionGender): DivisionConfig[] {
  return DIVISIONS.filter((d) => d.gender === gender);
}

/** The contracted weight for a bout, respecting the non title allowance. */
export function contractedWeight(divisionId: DivisionId, isTitleFight: boolean): number {
  const d = DIVISION_BY_ID[divisionId];
  return isTitleFight ? d.limitLb : d.limitLb + d.nonTitleAllowanceLb;
}

export function adjacentDivisions(divisionId: DivisionId): DivisionId[] {
  const d = DIVISION_BY_ID[divisionId];
  return DIVISIONS.filter((x) => Math.abs(x.order - d.order) === 1).map((x) => x.id);
}
