import { daysBetween } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';

/**
 * Explicit fighter status.
 *
 * The stored activityStatus is the roster relationship: whether the promotion considers
 * this fighter part of the roster at all. The displayed status is richer, because being
 * booked, injured or serving a suspension are different things from being released.
 *
 * Deriving the display status rather than storing it means it can never contradict the
 * underlying record, and every simulation check keeps reading the one stored field.
 */

export type FighterStatus =
  | 'active'
  | 'booked'
  | 'injured'
  | 'medically-suspended'
  | 'commission-suspended'
  | 'anti-doping-suspended'
  | 'inactive'
  | 'retired'
  | 'released'
  | 'free-agent'
  | 'unverified'
  | 'deceased'
  | 'historical-only';

export const FIGHTER_STATUS_LABEL: Record<FighterStatus, string> = {
  active: 'Active',
  booked: 'Booked',
  injured: 'Injured',
  'medically-suspended': 'Medically suspended',
  'commission-suspended': 'Commission suspended',
  'anti-doping-suspended': 'Anti-doping suspended',
  inactive: 'Inactive',
  retired: 'Retired',
  released: 'Released',
  'free-agent': 'Free agent',
  unverified: 'Unverified',
  deceased: 'Deceased',
  'historical-only': 'Historical only',
};

export interface StatusVerdict {
  status: FighterStatus;
  detail: string;
  /** Where the status came from, so a sourced status is never confused with a simulated one. */
  evidence: 'sourced' | 'simulated' | 'derived';
  until: string | null;
}

/** Number of days without a bout before an otherwise healthy fighter reads as inactive. */
const INACTIVE_AFTER_DAYS = 540;

export function deriveFighterStatus(save: SaveGame, fighter: Fighter): StatusVerdict {
  const sourced = fighter.provenance?.activityStatus !== undefined;

  if (fighter.activityStatus === 'historical') {
    return { status: 'historical-only', detail: 'Present for historical records only.', evidence: 'sourced', until: null };
  }
  if (fighter.retired || fighter.activityStatus === 'retired') {
    return {
      status: 'retired',
      detail: fighter.retirementDate ? `Retired on ${fighter.retirementDate}.` : 'Retired.',
      evidence: fighter.retirementDate && fighter.retirementDate >= save.startDate ? 'simulated' : sourced ? 'sourced' : 'derived',
      until: null,
    };
  }
  if (fighter.activityStatus === 'released') {
    return { status: 'released', detail: 'No longer under contract to the promotion.', evidence: 'simulated', until: null };
  }
  if (fighter.activityStatus === 'unverified') {
    return { status: 'unverified', detail: 'Current status could not be verified from the source.', evidence: 'sourced', until: null };
  }
  if (fighter.activityStatus === 'suspended') {
    return { status: 'commission-suspended', detail: 'Serving a commission suspension.', evidence: 'simulated', until: null };
  }

  const suspension = fighter.medicalSuspension;
  if (suspension && suspension.until > save.date) {
    return {
      status: 'medically-suspended',
      detail: suspension.reason,
      evidence: 'simulated',
      until: suspension.until,
    };
  }

  const blocking = fighter.injuries.find((i) => i.actualReturn === null && i.blocksCompetition && i.expectedReturn >= save.date);
  if (blocking) {
    return {
      status: 'injured',
      detail: `${blocking.type}. Expected back around ${blocking.expectedReturn}.`,
      evidence: 'simulated',
      until: blocking.expectedReturn,
    };
  }

  if (fighter.nextBoutId) {
    const bout = save.bouts[fighter.nextBoutId];
    if (bout && bout.status === 'scheduled') {
      const opponentId = bout.fighterAId === fighter.id ? bout.fighterBId : bout.fighterAId;
      const opponent = save.fighters[opponentId];
      return {
        status: 'booked',
        detail: `Booked against ${opponent?.name ?? 'an opponent'} on ${bout.date}.`,
        evidence: 'simulated',
        until: bout.date,
      };
    }
  }

  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  if (!contract || contract.status !== 'active') {
    return { status: 'free-agent', detail: 'No active promotional contract.', evidence: 'simulated', until: null };
  }

  const idle = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, save.date) : null;
  if (idle !== null && idle > INACTIVE_AFTER_DAYS) {
    return { status: 'inactive', detail: `No bout in ${idle} days.`, evidence: 'derived', until: null };
  }

  return {
    status: 'active',
    detail: idle === null ? 'Available.' : `Available. Last competed ${idle} days ago.`,
    evidence: sourced ? 'sourced' : 'derived',
    until: null,
  };
}

/** Grouped counts for the roster page and the data page. */
export function statusCounts(save: SaveGame): Record<FighterStatus, number> {
  const counts = Object.fromEntries(Object.keys(FIGHTER_STATUS_LABEL).map((k) => [k, 0])) as Record<FighterStatus, number>;
  for (const f of Object.values(save.fighters)) counts[deriveFighterStatus(save, f).status]++;
  return counts;
}

export function statusTone(status: FighterStatus): 'good' | 'warn' | 'bad' | 'dim' {
  switch (status) {
    case 'active':
      return 'good';
    case 'booked':
      return 'warn';
    case 'injured':
    case 'medically-suspended':
    case 'commission-suspended':
    case 'anti-doping-suspended':
      return 'bad';
    case 'retired':
    case 'deceased':
    case 'historical-only':
      return 'dim';
    default:
      return 'dim';
  }
}
