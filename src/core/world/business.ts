import { clamp, Rng } from '../rng';
import { DIVISION_BY_ID } from '../config/divisions';
import { daysBetween } from '../types/common';
import type { FightCardEvent } from '../types/world';
import type { EventBusiness } from '../types/identity';
import type { SaveGame } from '../types/save';
import { getHype } from './hype';
import { VENUE_CITIES } from './venues';
import { totalFollowersOf } from './identity-utils';

/**
 * Event business.
 *
 * Every simulated figure here is labelled as simulated. Real attendance, gate and pay per
 * view numbers are either verified, reported estimates, or unknown, and the model never
 * presents its own output as any of those.
 */

export function businessStore(save: SaveGame): Record<string, EventBusiness> {
  const anySave = save as unknown as { business?: Record<string, EventBusiness> };
  if (!anySave.business) anySave.business = {};
  return anySave.business;
}

const TICKET_PRICE_BY_TIER: Record<FightCardEvent['tier'], number> = {
  'numbered-ppv': 235,
  international: 165,
  'fight-night': 120,
  apex: 0,
};

/**
 * Demand for an event, built from the card rather than assumed from its tier. A numbered
 * card with a weak main event underperforms, and a fight night with a genuine attraction
 * on top does better than its label suggests.
 */
export function computeEventBusiness(save: SaveGame, event: FightCardEvent, rng: Rng): EventBusiness {
  const venue = VENUE_CITIES.find((v) => v.city === event.city);
  const capacity = venue?.capacity ?? 14000;
  const notes: string[] = [];

  const bouts = event.boutIds.map((id) => save.bouts[id]).filter(Boolean);
  const main = bouts.find((b) => b.isMainEvent) ?? bouts[0] ?? null;
  const coMain = bouts.find((b) => b.isCoMain) ?? null;

  const hypeOf = (boutId: string | undefined) => (boutId ? (getHype(save, boutId)?.total ?? null) : null);
  const drawOf = (fighterId: string | undefined) => {
    if (!fighterId) return 0;
    const f = save.fighters[fighterId];
    if (!f) return 0;
    return f.fame?.drawingPower ?? f.popularity;
  };

  const mainHype = hypeOf(main?.id) ?? (main ? (drawOf(main.fighterAId) + drawOf(main.fighterBId)) / 2 : 25);
  const coMainHype = hypeOf(coMain?.id) ?? (coMain ? (drawOf(coMain.fighterAId) + drawOf(coMain.fighterBId)) / 2 : 20);
  const titleFights = bouts.filter((b) => b.isTitleFight || b.isInterimTitleFight).length;
  const cardDepth = bouts.filter((b) => {
    const a = save.fighters[b.fighterAId];
    const c = save.fighters[b.fighterBId];
    return (a?.ranking ?? null) !== null || (c?.ranking ?? null) !== null;
  }).length;

  // Local fighters sell tickets.
  const localFighters = bouts.filter((b) => {
    const a = save.fighters[b.fighterAId];
    const c = save.fighters[b.fighterBId];
    return a?.country === event.country || c?.country === event.country;
  }).length;

  const cancellations = event.canceledBoutIds?.length ?? 0;
  const lateCancellationPenalty = clamp(cancellations * 0.03, 0, 0.2);

  // A competing major event in the same fortnight splits attention.
  const competing = Object.values(save.events).filter(
    (e) => e.id !== event.id && e.tier === 'numbered-ppv' && Math.abs(daysBetween(e.date, event.date)) <= 10
  ).length;
  if (competing > 0) notes.push('A competing major card landed in the same window.');

  let demand =
    mainHype * 0.5 +
    coMainHype * 0.18 +
    titleFights * 7 +
    cardDepth * 1.1 +
    localFighters * 2.2 -
    lateCancellationPenalty * 100 -
    competing * 6;
  demand = clamp(demand, 5, 130);
  if (titleFights === 0 && event.tier === 'numbered-ppv') {
    demand *= 0.78;
    notes.push('A numbered card without a title fight sold on star power alone.');
  }
  if (cancellations > 0) notes.push(`${cancellations} bout${cancellations === 1 ? '' : 's'} fell off the card.`);
  if (localFighters >= 3) notes.push(`${localFighters} bouts featured a fighter from the host country.`);

  // Attendance.
  const fillRate = clamp(0.45 + (demand / 130) * 0.6 + rng.normal(0, 0.06), 0.3, 1);
  const attendance = Math.round(capacity * fillRate);

  // Gate.
  const basePrice = TICKET_PRICE_BY_TIER[event.tier];
  const priceMultiplier = clamp(0.7 + (demand / 130) * 0.9, 0.6, 1.9);
  const gate = event.tier === 'apex' ? 0 : Math.round(attendance * basePrice * priceMultiplier);

  // Pay per view. Only numbered cards sell one.
  let ppvBuys: number | null = null;
  if (event.tier === 'numbered-ppv') {
    const starReach = bouts.reduce((s, b) => s + totalFollowersOf(save.fighters[b.fighterAId] ?? ({} as never)) + totalFollowersOf(save.fighters[b.fighterBId] ?? ({} as never)), 0);
    const reachScore = clamp(Math.log10(Math.max(1, starReach)) / 8, 0, 1);
    const base = 130_000 + Math.pow(demand / 100, 2.4) * 1_150_000;
    ppvBuys = Math.round(clamp(base * (0.75 + reachScore * 0.55) * clamp(rng.normal(1, 0.16), 0.5, 1.9), 45_000, 2_600_000));
  }

  const streamingViewers = Math.round(clamp(demand * 9_500 * clamp(rng.normal(1, 0.2), 0.4, 2), 40_000, 3_500_000));
  const broadcastAudience = Math.round(streamingViewers * clamp(rng.range(0.5, 1.4), 0.3, 2));
  const internationalAudience = Math.round((streamingViewers + broadcastAudience) * clamp(rng.range(0.3, 0.9), 0.2, 1.2));

  // Costs and revenue.
  const fighterPayroll = bouts.reduce((s, b) => s + b.purseA.show + b.purseA.win + b.purseB.show + b.purseB.win, 0);
  const bonusPayroll = (event.performanceBonusFighterIds.length + (event.fightOfTheNightBoutId ? 2 : 0)) * event.bonusAmount;
  const venueCost = Math.round(capacity * (event.tier === 'apex' ? 4 : 22) + 180_000);
  const marketingCost = Math.round((event.tier === 'numbered-ppv' ? 2_100_000 : 420_000) * clamp(demand / 80, 0.4, 1.7));
  const merchandise = Math.round(attendance * clamp(rng.range(9, 26), 5, 40));
  const sponsorship = Math.round((event.tier === 'numbered-ppv' ? 3_400_000 : 900_000) * clamp(demand / 80, 0.5, 1.6));
  const ppvRevenue = ppvBuys ? ppvBuys * 55 : 0;
  const estimatedProfit = Math.round(
    gate + merchandise + sponsorship + ppvRevenue - fighterPayroll - bonusPayroll - venueCost - marketingCost
  );

  const business: EventBusiness = {
    attendance,
    attendanceKind: 'simulated',
    gate,
    gateKind: 'simulated',
    ppvBuys,
    ppvKind: ppvBuys === null ? 'unknown' : 'simulated',
    streamingViewers,
    broadcastAudience,
    internationalAudience,
    merchandise,
    sponsorship,
    venueCost,
    fighterPayroll,
    bonusPayroll,
    marketingCost,
    estimatedProfit,
    demandNotes: notes,
  };

  businessStore(save)[event.id] = business;
  return business;
}

export function getBusiness(save: SaveGame, eventId: string): EventBusiness | null {
  return businessStore(save)[eventId] ?? null;
}

export interface BusinessRecordRow {
  eventId: string;
  name: string;
  date: string;
  value: number;
  kind: EventBusiness['attendanceKind'];
}

/** Business record books. Simulated and reported figures are never mixed silently. */
export function businessRecords(save: SaveGame): { key: string; label: string; unit: string; rows: BusinessRecordRow[] }[] {
  const store = businessStore(save);
  const rows = (pick: (b: EventBusiness) => number | null, kind: (b: EventBusiness) => EventBusiness['attendanceKind']) =>
    Object.entries(store)
      .map(([eventId, b]) => {
        const ev = save.events[eventId];
        const value = pick(b);
        if (!ev || value === null) return null;
        return { eventId, name: ev.name, date: ev.date, value, kind: kind(b) };
      })
      .filter((r): r is BusinessRecordRow => r !== null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 25);

  return [
    { key: 'ppv', label: 'Highest pay per view', unit: 'buys', rows: rows((b) => b.ppvBuys, (b) => b.ppvKind) },
    { key: 'gate', label: 'Highest gate', unit: 'dollars', rows: rows((b) => b.gate, (b) => b.gateKind) },
    { key: 'attendance', label: 'Largest attendance', unit: 'people', rows: rows((b) => b.attendance, (b) => b.attendanceKind) },
    { key: 'profit', label: 'Most profitable event', unit: 'dollars', rows: rows((b) => b.estimatedProfit, () => 'simulated') },
    {
      key: 'underperformance',
      label: 'Biggest underperformance',
      unit: 'dollars',
      rows: rows((b) => (b.estimatedProfit !== null ? -b.estimatedProfit : null), () => 'simulated'),
    },
    {
      key: 'international',
      label: 'Highest international audience',
      unit: 'viewers',
      rows: rows((b) => b.internationalAudience, () => 'simulated'),
    },
  ];
}

/** Division draw context, used by matchmaking to place fights on the right card. */
export function divisionDrawWeight(divisionId: string): number {
  const d = DIVISION_BY_ID[divisionId as keyof typeof DIVISION_BY_ID];
  return d?.drawWeight ?? 1;
}
