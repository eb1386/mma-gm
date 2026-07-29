/** Shared primitives used across every subsystem. */

/** ISO calendar date, "YYYY-MM-DD". All in game dates use this form. */
export type IsoDate = string;

export type FighterId = string;
export type EventId = string;
export type BoutId = string;
export type GymId = string;
export type ContractId = string;
export type StaffId = string;
export type MessageId = string;

/**
 * Field level provenance. Attached wherever a value came from outside the simulation so
 * the UI can always answer "is this a real fact, a derived rating, or a game value".
 */
export interface Provenance {
  source: string;
  sourceId?: string;
  sourceUrl?: string;
  fetchedAt?: string;
  verifiedAt?: string;
  confidence: 'high' | 'medium' | 'low';
  transformation?: string;
  manuallyOverridden?: boolean;
}

/**
 * The five kinds of value in the game. Displayed distinctly so a model derived rating is
 * never mistaken for an official measurement.
 */
export type ValueKind =
  | 'sourced-fact'
  | 'derived-rating'
  | 'simulated'
  | 'user-created'
  | 'estimate'
  | 'unknown';

export interface Sourced<T> {
  value: T | null;
  kind: ValueKind;
  provenance?: Provenance;
}

export function sourcedFact<T>(value: T | null, provenance: Provenance): Sourced<T> {
  return { value, kind: value === null ? 'unknown' : 'sourced-fact', provenance };
}

export function unknownValue<T>(): Sourced<T> {
  return { value: null, kind: 'unknown' };
}

export function simulatedValue<T>(value: T): Sourced<T> {
  return { value, kind: 'simulated' };
}

export type Confidence = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

export const CONFIDENCE_ORDER: Confidence[] = ['very-low', 'low', 'medium', 'high', 'very-high'];

/** Numeric width of the uncertainty band shown for a scouted rating. */
export const CONFIDENCE_BAND: Record<Confidence, number> = {
  'very-low': 14,
  low: 10,
  medium: 7,
  high: 4,
  'very-high': 2,
};

export type Stance = 'orthodox' | 'southpaw' | 'switch';

export type BuildType =
  | 'compact'
  | 'stocky'
  | 'balanced'
  | 'athletic'
  | 'long'
  | 'rangy'
  | 'powerful'
  | 'heavy-frame';

/**
 * Roster relationship with the promotion. The richer display status, which also covers
 * being booked, injured or serving a specific kind of suspension, is derived rather than
 * stored so it can never contradict this field.
 */
export type ActivityStatus =
  | 'active'
  | 'inactive'
  | 'retired'
  | 'released'
  | 'suspended'
  | 'historical'
  | 'unverified'
  | 'deceased';

export type GameMode = 'fighter' | 'coach' | 'spectator';

export type Difficulty = 'easy' | 'normal' | 'hard' | 'brutal';

// ---------------------------------------------------------------------------
// Date helpers. The world clock is a day counter; ISO strings are the interface.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86400000;

export function toDayNumber(iso: IsoDate): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function fromDayNumber(day: number): IsoDate {
  const dt = new Date(day * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(iso) + days);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toDayNumber(b) - toDayNumber(a);
}

export function weeksBetween(a: IsoDate, b: IsoDate): number {
  return Math.floor(daysBetween(a, b) / 7);
}

export function yearOf(iso: IsoDate): number {
  return Number(iso.slice(0, 4));
}

export function monthOf(iso: IsoDate): number {
  return Number(iso.slice(5, 7));
}

/** Day of week, 0 is Sunday. Used to place events on Saturdays. */
export function dayOfWeek(iso: IsoDate): number {
  return ((toDayNumber(iso) + 4) % 7 + 7) % 7;
}

export function nextDayOfWeek(iso: IsoDate, target: number): IsoDate {
  const cur = dayOfWeek(iso);
  const delta = (target - cur + 7) % 7 || 7;
  return addDays(iso, delta);
}

export function ageOn(birthDate: IsoDate | null, on: IsoDate): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age--;
  return age;
}

export function formatDate(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatDateShort(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'Unknown';
  return CURRENCY.format(Math.round(v));
}

const NUMBER = new Intl.NumberFormat('en-US');

export function formatNumber(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  if (digits > 0) return v.toFixed(digits);
  return NUMBER.format(Math.round(v));
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatHeight(inches: number | null): string {
  if (inches === null || !Number.isFinite(inches)) return 'Unknown';
  const ft = Math.floor(inches / 12);
  const inch = Math.round((inches - ft * 12) * 2) / 2;
  return `${ft}' ${inch}"`;
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(digits)}%`;
}
