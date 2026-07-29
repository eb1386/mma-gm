import type { BuildType } from '../types/common';
import type { RatingKey } from '../types/fighter';

/**
 * Builds are not cosmetic labels and none of them is strictly better than another.
 * Every entry that grants an advantage pays for it somewhere else. The engine reads
 * these values for reach generation, healthy walking weight, cut difficulty, leverage,
 * damage, durability tendencies, takedown mechanics and development curves.
 */
export interface BuildProfile {
  id: BuildType;
  label: string;
  description: string;
  /** Height offset in inches against the division mean. */
  heightOffset: number;
  /** Reach offset in inches against the fighter's own height. */
  reachOverHeight: number;
  /** Walking weight above the division limit, offset against the division typical. */
  walkAroundOffset: number;
  /** Multiplier on weight cut difficulty. Above one is a harder cut. */
  cutDifficulty: number;
  /** Multiplier on strike damage output. Leverage and mass. */
  leverage: number;
  /** Multiplier on stamina costs. Above one tires faster. */
  fatigue: number;
  /** Generation bias applied to each rating at creation, in rating points. */
  ratingBias: Partial<Record<RatingKey, number>>;
  /** Multiplier on takedown entry effectiveness. Lower centre of gravity helps. */
  takedownLeverage: number;
  /** Multiplier on the rate of age related decline. */
  agingRate: number;
}

export const BUILDS: Record<BuildType, BuildProfile> = {
  compact: {
    id: 'compact',
    label: 'Compact',
    description: 'Short levers and a low centre of gravity. Easy cut and strong engine, but gives up range in every striking exchange.',
    heightOffset: -1.6,
    reachOverHeight: 0.4,
    walkAroundOffset: -3,
    cutDifficulty: 0.82,
    leverage: 0.93,
    fatigue: 0.93,
    ratingBias: { cardio: 3, wrestling: 2, striking: -2, grappling: 1 },
    takedownLeverage: 1.09,
    agingRate: 0.97,
  },
  stocky: {
    id: 'stocky',
    label: 'Stocky',
    description: 'Thick through the trunk. Hard to move and hits heavy up close, but the cut is rough and the gas tank suffers.',
    heightOffset: -1.2,
    reachOverHeight: 0.2,
    walkAroundOffset: 3,
    cutDifficulty: 1.16,
    leverage: 1.06,
    fatigue: 1.07,
    ratingBias: { durability: 3, wrestling: 2, cardio: -3, striking: -1 },
    takedownLeverage: 1.06,
    agingRate: 1.02,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'No pronounced strength and no pronounced weakness. The most forgiving frame to develop.',
    heightOffset: 0,
    reachOverHeight: 1.8,
    walkAroundOffset: 0,
    cutDifficulty: 1.0,
    leverage: 1.0,
    fatigue: 1.0,
    ratingBias: {},
    takedownLeverage: 1.0,
    agingRate: 1.0,
  },
  athletic: {
    id: 'athletic',
    label: 'Athletic',
    description: 'Explosive and quick to recover. Trades some absorbed punishment tolerance for speed of movement.',
    heightOffset: 0.3,
    reachOverHeight: 2.0,
    walkAroundOffset: -1,
    cutDifficulty: 0.94,
    leverage: 1.0,
    fatigue: 0.95,
    ratingBias: { cardio: 3, wrestling: 2, durability: -3 },
    takedownLeverage: 1.04,
    agingRate: 1.05,
  },
  long: {
    id: 'long',
    label: 'Long',
    description: 'Tall with proportional reach. Owns the outside, but is easier to take down and to hurt to the body.',
    heightOffset: 1.7,
    reachOverHeight: 2.4,
    walkAroundOffset: 1,
    cutDifficulty: 1.08,
    leverage: 1.02,
    fatigue: 1.02,
    ratingBias: { striking: 3, wrestling: -3, durability: -1 },
    takedownLeverage: 0.92,
    agingRate: 1.0,
  },
  rangy: {
    id: 'rangy',
    label: 'Rangy',
    description: 'Extreme reach for the division. Dominates at distance and struggles badly once the range is closed.',
    heightOffset: 2.2,
    reachOverHeight: 4.2,
    walkAroundOffset: 0,
    cutDifficulty: 1.05,
    leverage: 1.04,
    fatigue: 1.03,
    ratingBias: { striking: 5, grappling: -3, wrestling: -3, durability: -2 },
    takedownLeverage: 0.87,
    agingRate: 1.0,
  },
  powerful: {
    id: 'powerful',
    label: 'Powerful',
    description: 'Heavy musculature. Ends fights with one shot and pays for it in the later rounds.',
    heightOffset: -0.3,
    reachOverHeight: 1.6,
    walkAroundOffset: 4,
    cutDifficulty: 1.2,
    leverage: 1.13,
    fatigue: 1.12,
    ratingBias: { striking: 2, durability: 2, cardio: -5 },
    takedownLeverage: 1.02,
    agingRate: 1.06,
  },
  'heavy-frame': {
    id: 'heavy-frame',
    label: 'Heavy frame',
    description: 'Oversized for the division. Absorbs punishment and generates force, but the cut is brutal and the tank is small.',
    heightOffset: 1.0,
    reachOverHeight: 2.2,
    walkAroundOffset: 8,
    cutDifficulty: 1.35,
    leverage: 1.16,
    fatigue: 1.18,
    ratingBias: { durability: 5, striking: 1, cardio: -6, grappling: -1 },
    takedownLeverage: 0.96,
    agingRate: 1.08,
  },
};

export const BUILD_LIST: BuildProfile[] = Object.values(BUILDS);

/** Infers the most plausible build from sourced height, reach and weight. */
export function inferBuild(
  heightIn: number | null,
  reachIn: number | null,
  divisionMeanHeight: number
): BuildType {
  if (heightIn === null) return 'balanced';
  const heightDelta = heightIn - divisionMeanHeight;
  const reachDelta = reachIn === null ? 1.8 : reachIn - heightIn;

  if (reachDelta >= 3.6 && heightDelta >= 1) return 'rangy';
  if (heightDelta >= 1.5) return 'long';
  if (heightDelta <= -1.8 && reachDelta <= 1) return 'compact';
  if (heightDelta <= -1) return 'stocky';
  if (reachDelta >= 2.6) return 'long';
  if (heightDelta >= 0.8) return 'athletic';
  return 'balanced';
}
