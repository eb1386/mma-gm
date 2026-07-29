import type { DivisionId } from '../config/divisions';
import { DIVISIONS } from '../config/divisions';
import { daysBetween, type BoutId, type EventId, type FighterId, type GymId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { canCompete } from './health';

/**
 * World indexes.
 *
 * The weekly pass used to scan every fighter, bout, event and offer several times over.
 * That is fine for a few hundred records and quadratic for a save that has been running
 * for twenty years. These indexes are built once per pass and read many times.
 *
 * An index is always derived state. It is never persisted, so it cannot go stale across a
 * save and reload, and it is rebuilt whenever the caller says the world has changed.
 */

export interface WorldIndex {
  builtOn: IsoDate;
  byDivision: Map<DivisionId, Fighter[]>;
  active: Fighter[];
  available: Fighter[];
  ranked: Fighter[];
  champions: Map<DivisionId, Fighter>;
  interimChampions: Map<DivisionId, Fighter>;
  byGym: Map<GymId, Fighter[]>;
  injured: Fighter[];
  suspended: Fighter[];
  freeAgents: Fighter[];
  prospects: Fighter[];
  retired: Fighter[];
  boutByFighter: Map<FighterId, BoutId>;
  scheduledBouts: BoutId[];
  eventsByDate: { date: IsoDate; eventId: EventId }[];
  upcomingEvents: EventId[];
  openOfferByFighter: Map<FighterId, string>;
  activeContracts: Map<FighterId, string>;
  /** Fighters with no open offer, no booking, healthy and under contract. */
  bookable: Fighter[];
}

/** Fighters considered prospects: young, promotionally inexperienced, and improving. */
function isProspect(f: Fighter, date: IsoDate): boolean {
  const age = f.ageAtSnapshot ?? 28;
  const promoFights = f.ufcRecord.wins + f.ufcRecord.losses + f.ufcRecord.draws;
  void date;
  return !f.retired && age <= 27 && promoFights <= 6 && f.pot - Math.round(avgOvr(f)) >= 4;
}

function avgOvr(f: Fighter): number {
  const r = f.ratings;
  return (r.striking + r.grappling + r.wrestling + r.submissions + r.cardio + r.durability) / 6;
}

export function buildWorldIndex(save: SaveGame): WorldIndex {
  const index: WorldIndex = {
    builtOn: save.date,
    byDivision: new Map(),
    active: [],
    available: [],
    ranked: [],
    champions: new Map(),
    interimChampions: new Map(),
    byGym: new Map(),
    injured: [],
    suspended: [],
    freeAgents: [],
    prospects: [],
    retired: [],
    boutByFighter: new Map(),
    scheduledBouts: [],
    eventsByDate: [],
    upcomingEvents: [],
    openOfferByFighter: new Map(),
    activeContracts: new Map(),
    bookable: [],
  };

  for (const d of DIVISIONS) index.byDivision.set(d.id, []);

  // One pass over bouts.
  for (const bout of Object.values(save.bouts)) {
    if (bout.status !== 'scheduled') continue;
    index.scheduledBouts.push(bout.id);
    index.boutByFighter.set(bout.fighterAId, bout.id);
    index.boutByFighter.set(bout.fighterBId, bout.id);
  }

  // One pass over offers.
  for (const offer of Object.values(save.fightOffers)) {
    if (offer.status !== 'open') continue;
    index.openOfferByFighter.set(offer.fighterId, offer.id);
    index.openOfferByFighter.set(offer.opponentId, offer.id);
  }

  // One pass over contracts.
  for (const contract of Object.values(save.contracts)) {
    if (contract.status !== 'active') continue;
    index.activeContracts.set(contract.fighterId, contract.id);
  }

  // One pass over events.
  for (const event of Object.values(save.events)) {
    index.eventsByDate.push({ date: event.date, eventId: event.id });
    if (event.status === 'announced' && event.date >= save.date) index.upcomingEvents.push(event.id);
  }
  index.eventsByDate.sort((a, b) => (a.date < b.date ? -1 : 1));
  index.upcomingEvents.sort((a, b) => (save.events[a].date < save.events[b].date ? -1 : 1));

  // One pass over fighters.
  for (const f of Object.values(save.fighters)) {
    const bucket = index.byDivision.get(f.divisionId);
    if (bucket) bucket.push(f);

    if (f.retired) {
      index.retired.push(f);
      continue;
    }

    if (f.activityStatus === 'active') index.active.push(f);
    if (f.ranking !== null) index.ranked.push(f);
    if (f.isChampion) index.champions.set(f.divisionId, f);
    if (f.isInterimChampion) index.interimChampions.set(f.divisionId, f);

    if (f.gymId) {
      const g = index.byGym.get(f.gymId);
      if (g) g.push(f);
      else index.byGym.set(f.gymId, [f]);
    }

    const hasBlockingInjury = f.injuries.some((i) => i.actualReturn === null && i.blocksCompetition && i.expectedReturn >= save.date);
    if (hasBlockingInjury) index.injured.push(f);
    if (f.medicalSuspension && f.medicalSuspension.until > save.date) index.suspended.push(f);
    if (!index.activeContracts.has(f.id)) index.freeAgents.push(f);
    if (isProspect(f, save.date)) index.prospects.push(f);

    const healthy = canCompete(f, save.date).ok;
    if (healthy && f.activityStatus === 'active') index.available.push(f);
    if (
      healthy &&
      f.activityStatus === 'active' &&
      !index.boutByFighter.has(f.id) &&
      !index.openOfferByFighter.has(f.id) &&
      index.activeContracts.has(f.id)
    ) {
      index.bookable.push(f);
    }
  }

  return index;
}

/** Bookable fighters in one division, the hot path for matchmaking. */
export function bookableInDivision(index: WorldIndex, divisionId: DivisionId, on: IsoDate, minTurnaroundDays: number): Fighter[] {
  const out: Fighter[] = [];
  for (const f of index.bookable) {
    if (f.divisionId !== divisionId) continue;
    if (f.lastFightDate && daysBetween(f.lastFightDate, on) < minTurnaroundDays) continue;
    out.push(f);
  }
  return out;
}

export function championOf(index: WorldIndex, divisionId: DivisionId): Fighter | null {
  return index.champions.get(divisionId) ?? null;
}

/** Summary used by the data page and the acceptance harness. */
export function indexSummary(index: WorldIndex): Record<string, number> {
  return {
    active: index.active.length,
    available: index.available.length,
    bookable: index.bookable.length,
    ranked: index.ranked.length,
    champions: index.champions.size,
    interimChampions: index.interimChampions.size,
    injured: index.injured.length,
    suspended: index.suspended.length,
    freeAgents: index.freeAgents.length,
    prospects: index.prospects.length,
    retired: index.retired.length,
    scheduledBouts: index.scheduledBouts.length,
    upcomingEvents: index.upcomingEvents.length,
    openOffers: index.openOfferByFighter.size,
  };
}
