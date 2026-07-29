import type { StrikeAction } from '../types/fight';

export interface StrikeProfile {
  /** Effective ability penalty applied to the attacker. Harder shots land less. */
  difficulty: number;
  /** Damage multiplier against the base clean value for the target area. */
  damage: number;
  /** Knockdown multiplier on top of the base knockdown chance. */
  knockdown: number;
  /** Stamina cost key. */
  cost: 'punch' | 'powerPunch' | 'kick' | 'spinning' | 'knee' | 'elbow';
  /** Fight clock consumed. */
  time: 'strikeSingle' | 'strikeCombination' | 'kick' | 'groundStrike';
  /** How exposed the attacker is to a counter after a miss. */
  counterExposure: number;
  /** Number of strikes recorded in the statistics for one action. */
  strikeCount: number;
  /** Cut chance multiplier. */
  cut: number;
  label: string;
  /** True for strikes that can only happen in a clinch or on the ground. */
  restricted?: 'clinch' | 'ground';
}

export const STRIKE_PROFILE: Record<StrikeAction, StrikeProfile> = {
  jab: { difficulty: -6, damage: 0.52, knockdown: 0.35, cost: 'punch', time: 'strikeSingle', counterExposure: 0.5, strikeCount: 1, cut: 0.7, label: 'jab' },
  cross: { difficulty: 1, damage: 1.05, knockdown: 1.15, cost: 'powerPunch', time: 'strikeSingle', counterExposure: 1.1, strikeCount: 1, cut: 1.0, label: 'straight right' },
  hook: { difficulty: 2.5, damage: 1.15, knockdown: 1.35, cost: 'powerPunch', time: 'strikeSingle', counterExposure: 1.3, strikeCount: 1, cut: 1.1, label: 'hook' },
  uppercut: { difficulty: 4, damage: 1.12, knockdown: 1.3, cost: 'powerPunch', time: 'strikeSingle', counterExposure: 1.25, strikeCount: 1, cut: 0.9, label: 'uppercut' },
  overhand: { difficulty: 5.5, damage: 1.3, knockdown: 1.6, cost: 'powerPunch', time: 'strikeSingle', counterExposure: 1.6, strikeCount: 1, cut: 1.2, label: 'overhand' },
  combination: { difficulty: 2, damage: 0.95, knockdown: 1.0, cost: 'powerPunch', time: 'strikeCombination', counterExposure: 1.2, strikeCount: 3, cut: 1.0, label: 'combination' },
  'body-punch': { difficulty: 0, damage: 0.9, knockdown: 0.12, cost: 'punch', time: 'strikeSingle', counterExposure: 1.0, strikeCount: 1, cut: 0.1, label: 'body shot' },
  'low-kick': { difficulty: -1, damage: 1.0, knockdown: 0.05, cost: 'kick', time: 'kick', counterExposure: 1.1, strikeCount: 1, cut: 0.2, label: 'low kick' },
  'calf-kick': { difficulty: 0.5, damage: 1.15, knockdown: 0.06, cost: 'kick', time: 'kick', counterExposure: 1.0, strikeCount: 1, cut: 0.1, label: 'calf kick' },
  'body-kick': { difficulty: 3, damage: 1.25, knockdown: 0.35, cost: 'kick', time: 'kick', counterExposure: 1.5, strikeCount: 1, cut: 0.3, label: 'body kick' },
  'head-kick': { difficulty: 12, damage: 1.75, knockdown: 2.6, cost: 'kick', time: 'kick', counterExposure: 2.0, strikeCount: 1, cut: 1.4, label: 'head kick' },
  'front-kick': { difficulty: 3, damage: 1.0, knockdown: 0.8, cost: 'kick', time: 'kick', counterExposure: 1.2, strikeCount: 1, cut: 0.5, label: 'front kick' },
  'side-kick': { difficulty: 5, damage: 1.0, knockdown: 0.5, cost: 'kick', time: 'kick', counterExposure: 1.3, strikeCount: 1, cut: 0.3, label: 'side kick' },
  'spinning-kick': { difficulty: 16, damage: 1.85, knockdown: 2.9, cost: 'spinning', time: 'kick', counterExposure: 2.6, strikeCount: 1, cut: 1.5, label: 'spinning kick' },
  knee: { difficulty: 3, damage: 1.35, knockdown: 1.7, cost: 'knee', time: 'strikeSingle', counterExposure: 1.3, strikeCount: 1, cut: 1.6, label: 'knee' },
  'flying-knee': { difficulty: 17, damage: 1.95, knockdown: 3.0, cost: 'spinning', time: 'kick', counterExposure: 2.8, strikeCount: 1, cut: 1.8, label: 'flying knee' },
  elbow: { difficulty: 4, damage: 1.05, knockdown: 0.95, cost: 'elbow', time: 'strikeSingle', counterExposure: 1.1, strikeCount: 1, cut: 2.6, label: 'elbow' },
  'spinning-elbow': { difficulty: 15, damage: 1.5, knockdown: 2.2, cost: 'spinning', time: 'strikeSingle', counterExposure: 2.4, strikeCount: 1, cut: 2.8, label: 'spinning elbow' },
  'clinch-strike': { difficulty: -2, damage: 0.6, knockdown: 0.3, cost: 'punch', time: 'strikeSingle', counterExposure: 0.6, strikeCount: 1, cut: 0.7, label: 'short strike', restricted: 'clinch' },
  'ground-strike': { difficulty: -3, damage: 0.85, knockdown: 0.55, cost: 'punch', time: 'groundStrike', counterExposure: 0.5, strikeCount: 1, cut: 1.1, label: 'ground strike', restricted: 'ground' },
  'ground-elbow': { difficulty: 0, damage: 1.0, knockdown: 0.7, cost: 'elbow', time: 'groundStrike', counterExposure: 0.6, strikeCount: 1, cut: 2.9, label: 'ground elbow', restricted: 'ground' },
};

export const KICK_ACTIONS: StrikeAction[] = [
  'low-kick',
  'calf-kick',
  'body-kick',
  'head-kick',
  'front-kick',
  'side-kick',
  'spinning-kick',
];

export function isKick(a: StrikeAction): boolean {
  return KICK_ACTIONS.includes(a);
}

export function isSpinning(a: StrikeAction): boolean {
  return a === 'spinning-kick' || a === 'spinning-elbow' || a === 'flying-knee';
}
