import { clamp, hashString, Rng } from '../rng';
import { eventTravelScale, sponsorStageScale, trainingCostScale } from './circuit';
import { addDays, daysBetween, formatDate, formatMoney, type FighterId, type IsoDate } from '../types/common';
import type { Bout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { totalFollowers } from '../types/identity';
import { PRO_AGE } from '../config/regional';

/**
 * Fighter money: sponsors, management, income and expenses.
 *
 * Every figure here is simulated. Real fighter pay is not public, so nothing in this module
 * is ever presented as a reported fact. The ledger is the single record: purses, bonuses,
 * sponsorship and every cost land in it, and the balances are derived from it rather than
 * being tracked separately and allowed to drift.
 */

export type IncomeKind =
  | 'show-pay'
  | 'win-bonus'
  | 'performance-bonus'
  | 'fight-of-the-night'
  | 'ppv-points'
  | 'sponsorship'
  | 'social-deal'
  | 'merchandise'
  | 'seminar'
  | 'coaching'
  | 'appearance'
  | 'signing-bonus'
  | 'forfeit-received'
  /**
   * The savings a career starts with. Written to the ledger so the first screen can say where the
   * money came from, and never counted as earnings: it is not added to the career total or the
   * income breakdown, so it cannot buy the millionaire achievement or inflate the earnings tab.
   */
  | 'opening-balance';

export type ExpenseKind =
  | 'manager-commission'
  | 'gym-percentage'
  | 'coaching-fees'
  | 'camp-costs'
  | 'nutrition'
  | 'rehabilitation'
  | 'surgery'
  | 'travel'
  | 'taxes'
  | 'housing'
  | 'lifestyle'
  | 'family-support'
  | 'fine'
  | 'media-management'
  | 'purse-forfeit'
  | 'gym-investment';

export const INCOME_LABEL: Record<IncomeKind, string> = {
  'show-pay': 'Show pay',
  'win-bonus': 'Win bonus',
  'performance-bonus': 'Performance bonus',
  'fight-of-the-night': 'Fight of the Night',
  'ppv-points': 'Pay per view points',
  sponsorship: 'Sponsorship',
  'social-deal': 'Social media deal',
  merchandise: 'Merchandise',
  seminar: 'Seminars',
  coaching: 'Coaching',
  appearance: 'Appearances',
  'signing-bonus': 'Signing bonus',
  'forfeit-received': 'Opponent purse forfeit',
  'opening-balance': 'Opening balance',
};

export const EXPENSE_LABEL: Record<ExpenseKind, string> = {
  'manager-commission': 'Manager commission',
  'gym-percentage': 'Gym percentage',
  'coaching-fees': 'Coaching fees',
  'gym-investment': 'Money put into the gym',
  'camp-costs': 'Camp costs',
  'media-management': 'Media management',
  nutrition: 'Nutrition',
  rehabilitation: 'Rehabilitation',
  surgery: 'Surgery',
  travel: 'Travel',
  taxes: 'Taxes',
  housing: 'Housing',
  lifestyle: 'Lifestyle',
  'family-support': 'Family support',
  fine: 'Fines',
  'purse-forfeit': 'Purse forfeit',
};

export interface LedgerEntry {
  id: string;
  date: IsoDate;
  fighterId: FighterId;
  direction: 'in' | 'out';
  kind: IncomeKind | ExpenseKind;
  amount: number;
  note: string;
  boutId: string | null;
}

export interface FinanceState {
  cash: number;
  careerEarnings: number;
  careerExpenses: number;
  /**
   * What is currently owed, which is exactly the negative part of cash.
   *
   * This used to be a high water mark that only ever ratcheted upward, so a fighter who dipped
   * into overdraft once and then earned millions was still shown as carrying that old shortfall,
   * and it was subtracted from their net worth forever.
   */
  debt: number;
  /** Recurring monthly outgoings, recomputed as the career changes. */
  monthlyExpenses: number;
  lastMonthlyOn: IsoDate | null;
  /**
   * Running totals per kind, per fighter.
   *
   * The breakdown shown on the money page cannot be summed from the ledger, because the ledger is
   * pruned to recent detail and a long career would silently lose its early years while the career
   * totals printed beside it kept climbing. These counters are never pruned.
   */
  kindTotals?: Record<string, { in: Record<string, number>; out: Record<string, number> }>;
}

/** The ledger, stored on the save so it survives reload and export. */
export function ledger(save: SaveGame): LedgerEntry[] {
  if (!save.ledger) save.ledger = [];
  return save.ledger;
}

export function financeState(save: SaveGame): FinanceState {
  if (!save.finance) {
    save.finance = {
      cash: save.player.balance,
      careerEarnings: 0,
      careerExpenses: 0,
      debt: 0,
      monthlyExpenses: 0,
      lastMonthlyOn: null,
    };
  }
  return save.finance;
}

/** Records money moving, exactly once, and keeps the balances consistent with it. */
/**
 * Pays a bonus award through the ledger.
 *
 * Bonus money used to be added straight to `player.balance`, which `record` then overwrote from
 * `finance.cash` the next time any money moved, so the award silently vanished. Deductions match a
 * purse except for fight week travel, which the fight itself has already charged once.
 */
/** Withholding applied to fight income. One value, used by purses and by bonus awards alike. */
export const PURSE_TAX_RATE = 0.32;

export function applyBonusAward(
  save: SaveGame,
  fighter: Fighter,
  boutId: string | null,
  amount: number,
  note: string
): number {
  return applyFightIncome(save, fighter, boutId, 'performance-bonus', amount, note);
}

/**
 * Pays points on the pay per view gate through the ledger, with the same deductions as a bonus.
 *
 * Points were booked as a bare ledger line, so a champion's largest payday skipped the manager's
 * commission, the gym's percentage and tax that every other piece of fight money pays.
 */
export function applyPpvPoints(save: SaveGame, fighter: Fighter, boutId: string | null, amount: number): number {
  return applyFightIncome(save, fighter, boutId, 'ppv-points', amount, 'Pay per view points');
}

/** Fight money paid after the purse itself: commission, gym share and tax, but no second travel bill. */
function applyFightIncome(
  save: SaveGame,
  fighter: Fighter,
  boutId: string | null,
  kind: IncomeKind,
  amount: number,
  note: string
): number {
  if (amount <= 0) return 0;
  record(save, fighter.id, 'in', kind, amount, note, boutId ?? undefined);
  let deducted = 0;
  const manager = managerFor(save, fighter.id);
  if (manager) {
    const commission = Math.round((amount * manager.commissionPct) / 100);
    record(save, fighter.id, 'out', 'manager-commission', commission, `${manager.name} commission`, boutId ?? undefined);
    deducted += commission;
  }
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  if (gym) {
    const cut = Math.round(amount * (gym.revenueSharePct / 100));
    record(save, fighter.id, 'out', 'gym-percentage', cut, `${gym.name} percentage`, boutId ?? undefined);
    deducted += cut;
  }
  const tax = Math.round(amount * PURSE_TAX_RATE);
  record(save, fighter.id, 'out', 'taxes', tax, 'Taxes withheld', boutId ?? undefined);
  deducted += tax;
  return amount - deducted;
}

export function record(
  save: SaveGame,
  fighterId: FighterId,
  direction: 'in' | 'out',
  kind: IncomeKind | ExpenseKind,
  amount: number,
  note: string,
  boutId: string | null = null
): LedgerEntry | null {
  if (amount <= 0) return null;
  const rounded = Math.round(amount);
  const entries = ledger(save);
  // Monotonic, never derived from the ledger length.
  //
  // The length is the one thing pruning changes, so a length derived id walked back over numbers
  // already held by surviving entries. The next payment of the same kind on the same day then
  // collided with a retained entry and was dropped: no ledger line, no cash movement, no career
  // total, while the caller was told the money had gone out. The guard that dropped it could
  // never have caught a genuine repeat either, because a successful write changes the length and
  // therefore the id, so it only ever fired on a false positive.
  if (!save.counters) save.counters = {};
  save.counters.ledger = (save.counters.ledger ?? entries.length) + 1;
  const id = `ledger-${save.counters.ledger}-${save.date}-${kind}`;
  const entry: LedgerEntry = { id, date: save.date, fighterId, direction, kind, amount: rounded, note, boutId };
  entries.push(entry);

  const finance = financeState(save);
  if (direction === 'in') {
    finance.cash += rounded;
    finance.careerEarnings += rounded;
  } else {
    finance.cash -= rounded;
    finance.careerExpenses += rounded;
  }
  finance.debt = Math.max(0, -finance.cash);
  addKindTotal(finance, fighterId, direction, kind, rounded);
  save.player.balance = finance.cash;
  return entry;
}

/** Adds to the unpruned per kind totals that the money breakdown is built from. */
function addKindTotal(
  finance: FinanceState,
  fighterId: FighterId,
  direction: 'in' | 'out',
  kind: IncomeKind | ExpenseKind,
  amount: number
): void {
  if (!finance.kindTotals) finance.kindTotals = {};
  const forFighter = (finance.kindTotals[fighterId] ??= { in: {}, out: {} });
  const side = direction === 'in' ? forFighter.in : forFighter.out;
  side[kind] = (side[kind] ?? 0) + amount;
}

/** Keeps only recent detail, so a decades long career does not carry every line. */
export function pruneLedger(save: SaveGame, keepEntries = 600): number {
  const entries = ledger(save);
  if (entries.length <= keepEntries) return 0;
  const removed = entries.length - keepEntries;
  save.ledger = entries.slice(removed);
  return removed;
}

// ---------------------------------------------------------------------------
// Sponsors
// ---------------------------------------------------------------------------

export type SponsorCategory =
  | 'apparel'
  | 'nutrition'
  | 'energy-drink'
  | 'gym-equipment'
  | 'automotive'
  | 'gaming'
  | 'local-business'
  | 'finance'
  | 'telecoms'
  | 'streaming';

export const SPONSOR_CATEGORY_LABEL: Record<SponsorCategory, string> = {
  apparel: 'Apparel',
  nutrition: 'Nutrition',
  'energy-drink': 'Energy drink',
  'gym-equipment': 'Gym equipment',
  automotive: 'Automotive',
  gaming: 'Gaming',
  'local-business': 'Local business',
  finance: 'Finance',
  telecoms: 'Telecoms',
  streaming: 'Streaming',
};

export interface Sponsor {
  id: string;
  name: string;
  category: SponsorCategory;
  /** Flat payment per fight. */
  perFight: number;
  /** Monthly retainer, if any. */
  monthly: number;
  /** Extra paid on a win. */
  winBonus: number;
  /** Extra paid for a championship. */
  championBonus: number;
  /** Posts asked for per month. Not yet enforced, so the interface does not present it as owed. */
  postsPerMonth: number;
  appearancesPerYear: number;
  exclusiveCategory: boolean;
  moralityClause: boolean;
  startedOn: IsoDate;
  endsOn: IsoDate;
  /**
   * 'declined' and 'lapsed' are offers that were never signed. They used to be marked
   * 'terminated', the status of a signed deal cut short, so every offer the player turned down or
   * never answered sat in the contract history as a deal that had ended early.
   */
  status: 'offered' | 'active' | 'expired' | 'terminated' | 'declined' | 'lapsed';
  satisfaction: number;
  note: string;
}

const SPONSOR_NAMES: Record<SponsorCategory, string[]> = {
  apparel: ['Ironline Apparel', 'Northgate Fightwear', 'Cordon Athletic'],
  nutrition: ['Basewell Nutrition', 'Trueform Supplements', 'Anchor Foods'],
  'energy-drink': ['Voltway', 'Kindle Energy', 'Ridgeline Drinks'],
  'gym-equipment': ['Hardstock Equipment', 'Beltline Gear', 'Anvil Works'],
  automotive: ['Marlow Motors', 'Crossbay Auto', 'Ridge Automotive'],
  gaming: ['Latchkey Games', 'Sixth Frame', 'Bright Harbor Interactive'],
  'local-business': ['Fairmont Roofing', 'Halland Dental', 'Copperline Diner'],
  finance: ['Westbank Credit', 'Kestrel Financial', 'Fairhaven Lending'],
  telecoms: ['Linewave', 'Openreach Mobile', 'Corvid Telecom'],
  streaming: ['Longshot Streaming', 'Cutaway TV', 'Nightline Media'],
};

/** Sponsor interest scales with reach and approval, never with Ovr. */
export function sponsorAppealOf(fighter: Fighter): number {
  const fame = fighter.fame;
  if (!fame) return clamp(fighter.popularity, 0, 100);
  const followers = fighter.social ? totalFollowers(fighter.social) : 0;
  // Reach only counts once there is a real audience. A log scale from one follower gave a brand
  // new local fighter with eighty thousand followers two thirds of the reach of a star.
  const reach = clamp((Math.log10(Math.max(1, followers)) - 4) * 25, 0, 100);
  return clamp(fame.sponsorAppeal * 0.4 + fame.favorability * 0.25 + reach * 0.25 + fighter.popularity * 0.1 - fame.controversy * 0.15, 0, 100);
}

/** Generates a sponsorship offer, or null when nobody is interested right now. */
export function generateSponsorOffer(save: SaveGame, fighter: Fighter, rng: Rng): Sponsor | null {
  // Amateurs cannot take sponsorship money. An amateur bout pays nothing, and a brand paying a
  // sixteen year old more per bout than a ranked professional's purse was the whole regional
  // economy until this check existed.
  if (fighter.circuit?.endsWith(':am')) return null;
  const appeal = sponsorAppealOf(fighter);
  if (appeal < 12) return null;
  const mine = sponsorsFor(save, fighter.id);
  const active = mine.filter((s) => s.status === 'active');
  const pending = mine.filter((s) => s.status === 'offered');
  // Offers still waiting for an answer take a slot too. Counting only signed deals let three or
  // four offers stack up and all be signed, which went straight past the cap.
  if (active.length + pending.length >= SPONSOR_DEAL_CAP) return null;
  const network = sponsorNetworkFactor(managerFor(save, fighter.id));
  if (!rng.chance(clamp((appeal / 260) * network, 0.02, 0.35))) return null;

  const live = [...active, ...pending];
  const usedNames = new Set(live.map((s) => s.name));
  const occupied = new Set(live.map((s) => s.category));
  const taken = new Set(live.filter((s) => s.exclusiveCategory).map((s) => s.category));
  const recognition = fighter.fame?.recognition ?? fighter.popularity;
  const local = Boolean(fighter.circuit);
  const categories = Object.keys(SPONSOR_NAMES) as SponsorCategory[];
  const available = categories.filter(
    (c) =>
      !taken.has(c) &&
      // The national brands want a face people know, and a local card is not national exposure.
      !(PREMIUM_CATEGORIES.has(c) && (recognition < 45 || local)) &&
      SPONSOR_NAMES[c].some((n) => !usedNames.has(n))
  );
  if (available.length === 0) return null;
  const category = rng.pick(available);

  // A local business pays little and asks little. A telecom pays well and asks a lot.
  const tier = clamp(appeal / 100, 0, 1);
  const scale = category === 'local-business' ? 0.25 : category === 'telecoms' || category === 'finance' ? 1.4 : 1;
  const raw = (2000 + tier * 60000) * scale * sponsorStageScale(fighter) * network * rng.range(0.8, 1.25);
  // No brand pays a fighter more per fight than half of what the fight itself pays them.
  const perFight = Math.round(Math.min(raw, sponsorPerFightCap(save, fighter)));
  const monthly = rng.chance(0.35) ? Math.round(perFight * rng.range(0.05, 0.2)) : 0;

  const id = `sponsor-${fighter.id}-${save.date}-${category}`;
  if (save.sponsors?.[id]) return null;
  // The draw is taken from the full list so the stream is the same as before; a name already
  // signed or on the table is swapped for the first free one, so one brand is never held twice.
  const drawn = rng.pick(SPONSOR_NAMES[category]);
  const name = usedNames.has(drawn) ? SPONSOR_NAMES[category].find((n) => !usedNames.has(n))! : drawn;
  const winBonus = Math.round(perFight * rng.range(0.2, 0.6));
  const championBonus = Math.round(perFight * rng.range(1, 3));
  const postsPerMonth = Math.max(0, Math.round(rng.range(0, 3) * (scale > 1 ? 1.6 : 1)));
  const appearancesPerYear = Math.round(rng.range(0, 4) * (scale > 1 ? 1.5 : 1));
  // A category that already holds a deal cannot be made exclusive by a newcomer, or the offer
  // could never be signed.
  const exclusiveCategory = rng.chance(0.55) && !occupied.has(category);
  const sponsor: Sponsor = {
    id,
    name,
    category,
    perFight,
    monthly,
    winBonus,
    championBonus,
    postsPerMonth,
    appearancesPerYear,
    exclusiveCategory,
    moralityClause: rng.chance(scale > 1 ? 0.85 : 0.4),
    startedOn: save.date,
    endsOn: addDays(save.date, Math.round(rng.range(300, 800))),
    status: 'offered',
    satisfaction: 60,
    note: 'Simulated sponsorship. No real brand is represented here.',
  };
  if (!save.sponsors) save.sponsors = {};
  save.sponsors[id] = sponsor;
  return sponsor;
}

/** The most active deals a fighter can carry at once. */
export const SPONSOR_DEAL_CAP = 4;

const PREMIUM_CATEGORIES = new Set<SponsorCategory>(['telecoms', 'finance', 'automotive', 'streaming']);

/** The least a brand will offer to cap a deal at, so a fighter with no contract is not offered zero. */
const SPONSOR_FLOOR = 400;

/**
 * The most one sponsor pays this fighter per fight: half of their contracted show money, or of
 * their last purse when they have no contract, and never less than a few hundred dollars.
 */
export function sponsorPerFightCap(save: SaveGame, fighter: Fighter): number {
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const showPay = contract?.terms.showPay ?? Math.round((fighter.lastPurse ?? 0) / 2);
  return Math.max(SPONSOR_FLOOR, Math.round(showPay * 0.5));
}

/** How much a manager's sponsor contacts improve the chance and size of an offer. */
export function sponsorNetworkFactor(manager: Manager | null): number {
  if (!manager) return 1;
  return 1 + (manager.sponsorNetwork - 50) / 200;
}

export function sponsorsFor(save: SaveGame, fighterId: FighterId): Sponsor[] {
  if (!save.sponsors) return [];
  // The exact prefix. Matching anywhere in the id handed fighter f12's sponsors to fighter f1.
  const prefix = `sponsor-${fighterId}-`;
  return Object.values(save.sponsors).filter((s) => s.id.startsWith(prefix));
}

/** The fighter a sponsor deal belongs to, read from its id. */
function sponsorOwner(save: SaveGame, sponsor: Sponsor): FighterId | null {
  const me = save.player.fighterId;
  if (me && sponsor.id.startsWith(`sponsor-${me}-`)) return me;
  return Object.keys(save.fighters).find((id) => sponsor.id.startsWith(`sponsor-${id}-`)) ?? null;
}

/**
 * Why this offer cannot be signed right now, or null when it can.
 *
 * Signing used to check only that the offer was still open, so the four deal cap, category
 * exclusivity and the same brand twice were all enforced when an offer was made and never when it
 * was accepted, and a player could hold five deals or two with one brand.
 */
export function canSignSponsor(save: SaveGame, sponsor: Sponsor): string | null {
  if (sponsor.status !== 'offered') return 'That offer is no longer available.';
  const owner = sponsorOwner(save, sponsor);
  const active = owner ? sponsorsFor(save, owner).filter((s) => s.status === 'active' && s.id !== sponsor.id) : [];
  if (active.length >= SPONSOR_DEAL_CAP) return `You already carry ${SPONSOR_DEAL_CAP} sponsors, which is as many as you can serve.`;
  const sameBrand = active.find((s) => s.name === sponsor.name);
  if (sameBrand) return `You already have a deal with ${sponsor.name}.`;
  const category = SPONSOR_CATEGORY_LABEL[sponsor.category].toLowerCase();
  const exclusiveHolder = active.find((s) => s.category === sponsor.category && s.exclusiveCategory);
  if (exclusiveHolder) return `Your ${exclusiveHolder.name} deal is exclusive in ${category}.`;
  const sameCategory = active.find((s) => s.category === sponsor.category);
  if (sponsor.exclusiveCategory && sameCategory) {
    return `${sponsor.name} wants to be your only ${category} sponsor, and you already have ${sameCategory.name}.`;
  }
  return null;
}

/** Signs an offer, or returns null when it cannot be signed. canSignSponsor gives the reason. */
export function acceptSponsor(save: SaveGame, sponsorId: string): Sponsor | null {
  const sponsor = save.sponsors?.[sponsorId];
  if (!sponsor || canSignSponsor(save, sponsor) !== null) return null;
  // The term runs from the day it is signed, not the day it was offered.
  const term = daysBetween(sponsor.startedOn, sponsor.endsOn);
  sponsor.status = 'active';
  sponsor.startedOn = save.date;
  sponsor.endsOn = addDays(save.date, term);
  // Offers this signing has made impossible are withdrawn rather than left on the table to be
  // refused one by one: the same brand again, and anything in a category that is now exclusive.
  const owner = sponsorOwner(save, sponsor);
  for (const other of owner ? sponsorsFor(save, owner) : []) {
    if (other.status !== 'offered') continue;
    const clash = other.category === sponsor.category && (sponsor.exclusiveCategory || other.exclusiveCategory);
    if (other.name === sponsor.name || clash) {
      other.status = 'lapsed';
      other.note = `Withdrawn after you signed with ${sponsor.name}.`;
    }
  }
  return sponsor;
}

export function declineSponsor(save: SaveGame, sponsorId: string): Sponsor | null {
  const sponsor = save.sponsors?.[sponsorId];
  if (!sponsor || sponsor.status !== 'offered') return null;
  sponsor.status = 'declined';
  return sponsor;
}

/**
 * Brings sponsor deals made before the stage scaling into line with it. Safe to run on every load.
 *
 * Saves written before this carry amateur deals worth tens of thousands a bout and regional deals
 * larger than the purses beside them, which would otherwise keep paying for up to two years.
 * An amateur's deals end; a regional professional's are cut to what a new offer could be worth,
 * which is a no op once they already fit.
 */
export function repairStageSponsors(save: SaveGame): void {
  const meId = save.player?.fighterId;
  const me = meId ? save.fighters?.[meId] : null;
  if (!me?.circuit || !save.sponsors) return;
  const amateur = me.circuit.endsWith(':am');
  const cap = Math.round(Math.min(sponsorPerFightCap(save, me), 62000 * 1.4 * sponsorStageScale(me)));
  for (const sponsor of sponsorsFor(save, me.id)) {
    if (sponsor.status !== 'active' && sponsor.status !== 'offered') continue;
    if (amateur) {
      sponsor.status = sponsor.status === 'active' ? 'terminated' : 'lapsed';
      sponsor.note = 'Ended because amateurs cannot take sponsorship.';
      continue;
    }
    if (sponsor.perFight <= cap) continue;
    const ratio = cap / sponsor.perFight;
    sponsor.perFight = cap;
    sponsor.monthly = Math.round(sponsor.monthly * ratio);
    sponsor.winBonus = Math.round(sponsor.winBonus * ratio);
    sponsor.championBonus = Math.round(sponsor.championBonus * ratio);
  }
}

/** Pays out sponsorship for one completed fight. */
export function paySponsorsForFight(save: SaveGame, fighter: Fighter, boutId: string, won: boolean, isChampion: boolean): number {
  let total = 0;
  for (const sponsor of sponsorsFor(save, fighter.id)) {
    if (sponsor.status !== 'active') continue;
    let amount = sponsor.perFight;
    if (won) amount += sponsor.winBonus;
    if (isChampion) amount += sponsor.championBonus;
    record(save, fighter.id, 'in', 'sponsorship', amount, `${sponsor.name} fight payment`, boutId);
    total += amount;
  }
  return total;
}

/**
 * A controversy can cost a sponsor with a morality clause. Called when controversy jumps.
 * Returns the sponsors that walked away.
 */
export function checkMoralityClauses(save: SaveGame, fighter: Fighter, rng: Rng): Sponsor[] {
  const controversy = fighter.fame?.controversy ?? 0;
  if (controversy < 55) return [];
  const lost: Sponsor[] = [];
  for (const sponsor of sponsorsFor(save, fighter.id)) {
    if (sponsor.status !== 'active' || !sponsor.moralityClause) continue;
    if (rng.chance(clamp((controversy - 50) / 220, 0.01, 0.3))) {
      sponsor.status = 'terminated';
      sponsor.note = `${sponsor.note} Ended early under the morality clause.`;
      lost.push(sponsor);
    }
  }
  return lost;
}

// ---------------------------------------------------------------------------
// Managers
// ---------------------------------------------------------------------------

export interface Manager {
  id: string;
  name: string;
  /** How well they extract terms in a negotiation, 0 to 100. */
  negotiation: number;
  /** How much sway they have with matchmaking, 0 to 100. */
  matchmakingInfluence: number;
  sponsorNetwork: number;
  mediaSkill: number;
  loyalty: number;
  aggressiveness: number;
  honesty: number;
  commissionPct: number;
  clientCapacity: number;
  clientIds: FighterId[];
  /** Other clients in the same division are a conflict of interest. */
  note: string;
}

const MANAGER_FIRST = ['Ali', 'Dana', 'Marcus', 'Rosa', 'Ken', 'Priya', 'Tom', 'Lena', 'Victor', 'Amara'];
const MANAGER_LAST = ['Okafor', 'Brenner', 'Salvatierra', 'Ng', 'Whitlock', 'Diallo', 'Kastner', 'Moreau', 'Radic', 'Pell'];

export function generateManager(save: SaveGame, rng: Rng): Manager {
  // The highest number in use plus one. A count of the managers would reuse an id the moment one
  // was removed from the pool, and a client pointing at that id would follow the wrong person.
  const highest = Object.keys(save.managers ?? {}).reduce((m, id) => Math.max(m, Number(id.split('-').pop()) || 0), 0);
  const id = `manager-${highest + 1}`;
  const honesty = clamp(rng.normal(62, 20), 5, 99);
  const name = `${rng.pick(MANAGER_FIRST)} ${rng.pick(MANAGER_LAST)}`;
  const negotiation = clamp(rng.normal(55, 18), 10, 98);
  const matchmakingInfluence = clamp(rng.normal(45, 20), 5, 95);
  const sponsorNetwork = clamp(rng.normal(50, 22), 5, 98);
  const mediaSkill = clamp(rng.normal(50, 18), 5, 95);
  const loyalty = clamp(rng.normal(60, 20), 5, 99);
  const aggressiveness = clamp(rng.normal(50, 22), 5, 98);
  const manager: Manager = {
    id,
    name,
    negotiation,
    matchmakingInfluence,
    sponsorNetwork,
    mediaSkill,
    loyalty,
    aggressiveness,
    honesty,
    // A better negotiator asks for more. The rate used to be rolled on its own, so a poor
    // negotiator could charge the top rate and a great one the bottom.
    commissionPct: Math.round(clamp(6 + negotiation / 10 + rng.normal(0, 2), 5, 25)),
    clientCapacity: Math.round(clamp(rng.normal(9, 4), 2, 24)),
    clientIds: [],
    note: honesty < 40 ? 'Has a reputation for creative accounting.' : 'Straightforward to deal with.',
  };
  if (!save.managers) save.managers = {};
  save.managers[id] = manager;
  return manager;
}

/** How long the player waits between asking around for representation. */
export const MANAGER_SEARCH_COOLDOWN_DAYS = 30;
/** Unsigned managers kept in the pool. The oldest without clients makes room for a newcomer. */
const MANAGER_POOL_LIMIT = 6;

/** The first day the player may ask around again, or null when they may ask now. */
export function nextManagerSearchOn(save: SaveGame): IsoDate | null {
  const last = save.player.lastManagerSearch;
  if (!last) return null;
  const next = addDays(last, MANAGER_SEARCH_COOLDOWN_DAYS);
  return next > save.date ? next : null;
}

/**
 * Asking around for representation.
 *
 * Every tap used to produce a new manager with no limit and no chance of failing, so the player
 * could reroll until one had top negotiation at the lowest commission. The search now runs once a
 * month, a little known fighter often finds nobody, and the pool stays a readable size.
 */
export function searchForManager(save: SaveGame, fighter: Fighter, rng: Rng): { ok: boolean; message: string; manager: Manager | null } {
  const next = nextManagerSearchOn(save);
  if (next) return { ok: false, message: `You asked around recently. Try again from ${formatDate(next)}.`, manager: null };
  save.player.lastManagerSearch = save.date;
  const chance = clamp(0.45 + fighter.popularity / 150, 0.45, 0.95);
  if (!rng.chance(chance)) return { ok: true, message: 'Nobody new is interested.', manager: null };
  const manager = generateManager(save, rng);
  const unsigned = Object.values(save.managers ?? {}).filter((m) => m.clientIds.length === 0 && m.id !== manager.id);
  if (unsigned.length >= MANAGER_POOL_LIMIT) {
    const oldest = unsigned.sort((a, b) => (Number(a.id.split('-').pop()) || 0) - (Number(b.id.split('-').pop()) || 0))[0];
    delete save.managers![oldest.id];
  }
  return { ok: true, message: `${manager.name} is interested in representing you.`, manager };
}

/**
 * The managers a career starts with to choose from.
 *
 * Drawn from a stream of their own, so seeding them never moves the world rng and a new save's
 * world is the same with or without them.
 */
export function seedManagers(save: SaveGame, seed: number): void {
  if (Object.keys(save.managers ?? {}).length > 0) return;
  const rng = new Rng(hashString(`managers-${seed}`));
  const count = rng.int(3, 5);
  for (let i = 0; i < count; i++) generateManager(save, rng);
}

export function managerFor(save: SaveGame, fighterId: FighterId): Manager | null {
  if (!save.managers) return null;
  return Object.values(save.managers).find((m) => m.clientIds.includes(fighterId)) ?? null;
}

export function hireManager(save: SaveGame, fighterId: FighterId, managerId: string): { ok: boolean; message: string } {
  const manager = save.managers?.[managerId];
  if (!manager) return { ok: false, message: 'That manager does not exist.' };
  if (manager.clientIds.length >= manager.clientCapacity) {
    return { ok: false, message: `${manager.name} has no room for another client.` };
  }
  const current = managerFor(save, fighterId);
  if (current?.id === managerId) return { ok: false, message: `${manager.name} already represents you.` };
  if (current) current.clientIds = current.clientIds.filter((id) => id !== fighterId);
  manager.clientIds.push(fighterId);
  const fighter = save.fighters[fighterId];
  if (fighter) {
    fighter.managerName = manager.name;
    fighter.relationships.manager = 55;
  }
  return { ok: true, message: `${manager.name} now represents you at ${manager.commissionPct} percent.` };
}

export function fireManager(save: SaveGame, fighterId: FighterId): { ok: boolean; message: string } {
  const manager = managerFor(save, fighterId);
  if (!manager) return { ok: false, message: 'You do not have a manager to release.' };
  manager.clientIds = manager.clientIds.filter((id) => id !== fighterId);
  const fighter = save.fighters[fighterId];
  if (fighter) {
    fighter.managerName = 'Unrepresented';
    fighter.relationships.manager = 30;
  }
  return { ok: true, message: `${manager.name} no longer represents you.` };
}

/** Clients of the same manager in the same division, which is a conflict. */
export function conflictsOfInterest(save: SaveGame, fighterId: FighterId): Fighter[] {
  const manager = managerFor(save, fighterId);
  if (!manager) return [];
  const me = save.fighters[fighterId];
  if (!me) return [];
  return manager.clientIds
    .filter((id) => id !== fighterId)
    .map((id) => save.fighters[id])
    .filter((f): f is Fighter => Boolean(f) && f.divisionId === me.divisionId && !f.retired);
}

/** How much better a purse a manager can get. Multiplier on show pay. */
export function purseMultiplierFrom(manager: Manager | null): number {
  if (!manager) return 1;
  return 1 + (manager.negotiation / 100) * 0.18 + (manager.aggressiveness / 100) * 0.06;
}

// ---------------------------------------------------------------------------
// Recurring costs
// ---------------------------------------------------------------------------

/** Monthly outgoings, derived from how the fighter actually lives and trains. */
export function monthlyExpensesFor(save: SaveGame, fighter: Fighter): { kind: ExpenseKind; amount: number }[] {
  const earnings = fighter.careerEarnings;
  // A regional fighter keeps a day job and often lives at home; an amateur almost always does.
  const circuitScale = !fighter.circuit ? 1 : fighter.circuit.endsWith(':am') ? 0.15 : 0.45;
  const lifestyleTier = clamp(earnings / 900000, 0.25, 4) * circuitScale;
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  const out: { kind: ExpenseKind; amount: number }[] = [
    { kind: 'housing', amount: Math.round(1400 * lifestyleTier) },
    { kind: 'lifestyle', amount: Math.round(900 * lifestyleTier) },
    // The base scales with the stage like everything else here. A flat five hundred a month was
    // most of an amateur's outgoings, for a teenager eating at the family table.
    { kind: 'nutrition', amount: Math.round(500 * circuitScale + 300 * lifestyleTier) },
  ];
  if (gym) out.push({ kind: 'coaching-fees', amount: Math.round(gym.monthlyCosts * 0.012 * trainingCostScale(fighter)) });
  const dependents = fighter.personality?.loyalty ?? 50;
  if (dependents > 55) out.push({ kind: 'family-support', amount: Math.round(700 * lifestyleTier) });
  return out;
}

/** Applies one month of recurring costs, at most once per calendar month. */
export function applyMonthlyExpenses(save: SaveGame, fighter: Fighter): number {
  const finance = financeState(save);
  const month = save.date.slice(0, 7);
  if (finance.lastMonthlyOn && finance.lastMonthlyOn.slice(0, 7) === month) return 0;
  finance.lastMonthlyOn = save.date;
  let total = 0;
  for (const item of monthlyExpensesFor(save, fighter)) {
    record(save, fighter.id, 'out', item.kind, item.amount, `Monthly ${EXPENSE_LABEL[item.kind].toLowerCase()}`);
    total += item.amount;
  }
  // Sponsor retainers land the same day.
  for (const sponsor of sponsorsFor(save, fighter.id)) {
    if (sponsor.status !== 'active' || sponsor.monthly <= 0) continue;
    record(save, fighter.id, 'in', 'sponsorship', sponsor.monthly, `${sponsor.name} monthly retainer`);
  }
  finance.monthlyExpenses = total;
  return total;
}

/**
 * What a missed weight moved on this bout, from this fighter's side: the share of their own show
 * money they forfeited, and the share of the opponent's they were paid for making weight.
 *
 * The fallback weigh in (no official fight week reading) records the amounts on the bout. The
 * official weigh in records the player's own forfeit on its state and moves the opponent's share
 * straight into the purses, so that share is recovered from the opponent's reduced show money.
 */
export function weightForfeitsFor(save: SaveGame, boutId: string, fighterId: FighterId): { lost: number; received: number } {
  const bout = save.bouts[boutId];
  if (!bout) return { lost: 0, received: 0 };
  const isA = bout.fighterAId === fighterId;
  if (bout.forfeitA !== undefined || bout.forfeitB !== undefined) {
    const lost = (isA ? bout.forfeitA : bout.forfeitB) ?? 0;
    const theirs = (isA ? bout.forfeitB : bout.forfeitA) ?? 0;
    return { lost, received: forfeitCreditDue(bout, isA, theirs) };
  }
  const state = save.weighIns?.[boutId];
  if (!state || state.ineligible.length === 0) return { lost: 0, received: 0 };
  const playerSide = state.player?.fighterId === fighterId;
  if (!playerSide) return { lost: 0, received: 0 };
  const iMissed = state.ineligible.includes(fighterId);
  const opponentId = isA ? bout.fighterBId : bout.fighterAId;
  const lost = iMissed ? state.forfeitAmount : 0;
  let received = 0;
  if (!iMissed && state.ineligible.includes(opponentId)) {
    const pct = state.purseForfeitPct > 0 ? state.purseForfeitPct : 20;
    const reduced = (isA ? bout.purseB : bout.purseA).show;
    // The booked show S satisfies S - round(S * pct / 100) = reduced. Rounding allows a one dollar
    // wobble, so the nearby whole numbers are checked for the exact one.
    const estimate = Math.round(reduced / (1 - pct / 100));
    let booked = estimate;
    for (let s = estimate - 2; s <= estimate + 2; s++) {
      if (s - Math.round((s * pct) / 100) === reduced) {
        booked = s;
        break;
      }
    }
    received = Math.max(0, booked - reduced);
  }
  return { lost, received };
}

/** What one side is owed from the other's forfeit: all of it when they made weight, else nothing. */
function forfeitCreditDue(bout: Bout, isA: boolean, otherForfeit: number): number {
  const mine = isA ? bout.weighInA : bout.weighInB;
  return otherForfeit > 0 && mine?.madeWeight === true ? otherForfeit : 0;
}

/**
 * Pays a fallback weigh in's forfeits to the side that made weight, once both have weighed in.
 *
 * The official weigh in has always passed the forfeit to the fighter who made weight. This path
 * took it off the fighter who missed and gave it to nobody. A fighter who also missed is owed
 * nothing, which is the same rule the official path applies.
 */
export function creditWeightForfeits(bout: Bout): void {
  const toA = forfeitCreditDue(bout, true, bout.forfeitB ?? 0);
  const toB = forfeitCreditDue(bout, false, bout.forfeitA ?? 0);
  if (toA > 0) bout.purseA = { ...bout.purseA, show: bout.purseA.show + toA };
  if (toB > 0) bout.purseB = { ...bout.purseB, show: bout.purseB.show + toB };
}

/**
 * Splits a fight purse: manager commission, gym percentage and tax come off the top.
 * Returns what the fighter actually keeps.
 */
export function applyFightPurse(
  save: SaveGame,
  fighter: Fighter,
  boutId: string,
  gross: { show: number; win: number; bonuses: number },
  won: boolean
): { gross: number; net: number; deductions: { kind: ExpenseKind; amount: number }[] } {
  const total = gross.show + (won ? gross.win : 0) + gross.bonuses;
  // A missed weight is shown as what it is. The show money arrives already adjusted, which used
  // to leave a smaller show pay line with no explanation and a forfeit kind nothing ever wrote.
  // The lines net to the same show money, so the deductions below keep their old base.
  const forfeit = weightForfeitsFor(save, boutId, fighter.id);
  const booked = gross.show + forfeit.lost - forfeit.received;
  record(save, fighter.id, 'in', 'show-pay', booked, 'Show pay', boutId);
  record(save, fighter.id, 'out', 'purse-forfeit', forfeit.lost, 'Purse forfeit for missing weight', boutId);
  record(save, fighter.id, 'in', 'forfeit-received', forfeit.received, 'Opponent purse forfeit', boutId);
  if (won && gross.win > 0) record(save, fighter.id, 'in', 'win-bonus', gross.win, 'Win bonus', boutId);
  if (gross.bonuses > 0) record(save, fighter.id, 'in', 'performance-bonus', gross.bonuses, 'Performance bonus', boutId);

  const deductions: { kind: ExpenseKind; amount: number }[] = [];
  const manager = managerFor(save, fighter.id);
  if (manager) {
    const commission = Math.round((total * manager.commissionPct) / 100);
    record(save, fighter.id, 'out', 'manager-commission', commission, `${manager.name} commission`, boutId);
    deductions.push({ kind: 'manager-commission', amount: commission });
  }
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  if (gym) {
    // The gym's own agreed rate, as every other path uses. A hard coded eight percent meant a
    // gym could negotiate a share that was then ignored on the one payment that matters most.
    const cut = Math.round(total * (gym.revenueSharePct / 100));
    record(save, fighter.id, 'out', 'gym-percentage', cut, `${gym.name} percentage`, boutId);
    deductions.push({ kind: 'gym-percentage', amount: cut });
  }
  const tax = Math.round(total * PURSE_TAX_RATE);
  record(save, fighter.id, 'out', 'taxes', tax, 'Taxes withheld', boutId);
  deductions.push({ kind: 'taxes', amount: tax });

  // Scaled by the card, not the fighter: a main promotion card is a flight and a hotel, a local
  // card is a drive. Pay per view points are paid later and never reach this figure.
  const travel = Math.round((total > 0 ? 1200 + total * 0.01 : 300) * eventTravelScale(save, save.bouts[boutId]));
  record(save, fighter.id, 'out', 'travel', travel, 'Fight week travel', boutId);
  deductions.push({ kind: 'travel', amount: travel });

  const net = total - deductions.reduce((s, d) => s + d.amount, 0);
  return { gross: total, net, deductions };
}

/**
 * The savings a fighter career opens with.
 *
 * Every career used to start at zero, so a ranked veteran opened the money page in the red
 * "in trouble" state and was in debt within a week. A main roster professional has banked part of
 * the fights already on their record; a regional professional has a few months put by from a day
 * job. An amateur cannot earn at all until turning professional, so what the family puts by for
 * them covers their modest costs until then: with a single month an amateur was in debt for the
 * whole of the amateur career through no choice of their own. Careers already in progress are
 * never re-seeded.
 */
export function openingBalanceFor(save: SaveGame, fighter: Fighter): number {
  const monthly = monthlyExpensesFor(save, fighter).reduce((s, i) => s + i.amount, 0);
  if (fighter.circuit?.endsWith(':am')) {
    const turnsPro = fighter.birthDate ? `${Number(fighter.birthDate.slice(0, 4)) + PRO_AGE}${fighter.birthDate.slice(4)}` : null;
    const months = turnsPro ? clamp(Math.ceil(daysBetween(save.date, turnsPro) / 30.4) || 1, 1, 30) : 1;
    return Math.round(monthly * (months + 1));
  }
  if (fighter.circuit) return Math.round(monthly * 3);
  const ranked = fighter.ranking !== null && fighter.ranking !== undefined ? (16 - fighter.ranking) * 10000 : 0;
  const champion = fighter.isChampion ? 250000 : 0;
  return Math.round(clamp(fighter.record.wins * 15000 + fighter.record.losses * 8000 + ranked + champion, 15000, 1_500_000));
}

/** Sets the opening balance. Not routed through record(), because savings are not earnings. */
export function seedOpeningBalance(save: SaveGame, fighter: Fighter): number {
  const amount = openingBalanceFor(save, fighter);
  const finance = financeState(save);
  finance.cash = amount;
  finance.debt = 0;
  save.player.balance = finance.cash;
  if (amount > 0) {
    if (!save.counters) save.counters = {};
    save.counters.ledger = (save.counters.ledger ?? ledger(save).length) + 1;
    ledger(save).push({
      id: `ledger-${save.counters.ledger}-${save.date}-opening-balance`,
      date: save.date,
      fighterId: fighter.id,
      direction: 'in',
      kind: 'opening-balance',
      amount,
      note: 'Savings at the start of the career',
      boutId: null,
    });
  }
  return amount;
}

export interface FinanceSummary {
  cash: number;
  careerEarnings: number;
  careerExpenses: number;
  netWorthEstimate: number;
  debt: number;
  monthlyExpenses: number;
  /** Months of expenses the current cash covers. Never negative: an overdrawn fighter has none. */
  runwayMonths: number;
  pressure: 'comfortable' | 'stable' | 'stretched' | 'under pressure' | 'in trouble';
  retirementSecurity: 'secure' | 'adequate' | 'thin' | 'nothing put aside';
  incomeByKind: { kind: IncomeKind; amount: number }[];
  expenseByKind: { kind: ExpenseKind; amount: number }[];
}

export function summarize(save: SaveGame, fighterId: FighterId): FinanceSummary {
  const finance = financeState(save);
  // Built from the running totals rather than by summing the ledger, because the ledger only
  // keeps recent detail. Summing it made the breakdown quietly disagree with the career totals
  // printed directly above it once a career passed the prune threshold.
  const totals = finance.kindTotals?.[fighterId];
  const income = new Map<IncomeKind, number>(Object.entries(totals?.in ?? {}) as [IncomeKind, number][]);
  const expense = new Map<ExpenseKind, number>(Object.entries(totals?.out ?? {}) as [ExpenseKind, number][]);
  const fighter = save.fighters[fighterId];
  const monthly = finance.monthlyExpenses > 0 ? finance.monthlyExpenses : fighter ? monthlyExpensesFor(save, fighter).reduce((s, i) => s + i.amount, 0) : 3000;
  // With no outgoings at all the cash lasts indefinitely, but only when there is cash. The old
  // fallback gave an overdrawn fighter ninety nine months of runway.
  const runway = monthly > 0 ? finance.cash / monthly : finance.cash > 0 ? 99 : 0;
  // Cash is already negative when money is owed, so debt is the same shortfall seen from the
  // other side. Subtracting it as well counted the same hole twice.
  const netWorth = finance.cash;

  return {
    cash: Math.round(finance.cash),
    careerEarnings: Math.round(finance.careerEarnings),
    careerExpenses: Math.round(finance.careerExpenses),
    netWorthEstimate: Math.round(netWorth),
    debt: Math.round(finance.debt),
    monthlyExpenses: Math.round(monthly),
    // Shown clamped; the pressure reading below still sees the raw shortfall.
    runwayMonths: Math.max(0, Math.round(runway * 10) / 10),
    pressure:
      runway > 24 ? 'comfortable' : runway > 12 ? 'stable' : runway > 5 ? 'stretched' : runway > 1 ? 'under pressure' : 'in trouble',
    retirementSecurity:
      netWorth > 1500000 ? 'secure' : netWorth > 400000 ? 'adequate' : netWorth > 60000 ? 'thin' : 'nothing put aside',
    incomeByKind: [...income.entries()].map(([kind, amount]) => ({ kind, amount })).sort((a, b) => b.amount - a.amount),
    expenseByKind: [...expense.entries()].map(([kind, amount]) => ({ kind, amount })).sort((a, b) => b.amount - a.amount),
  };
}

/** Deterministic per fighter seed so money generation never touches the shared stream. */
export function financeRng(save: SaveGame, fighterId: FighterId): Rng {
  return new Rng(hashString(`finance-${fighterId}-${save.date}-${save.seed}`));
}

/** Weekly finance pass for the player. Returns anything worth telling them about. */
export function runFinanceWeek(save: SaveGame, fighter: Fighter): string[] {
  const notes: string[] = [];
  const rng = financeRng(save, fighter.id);
  const spent = applyMonthlyExpenses(save, fighter);
  if (spent > 0) notes.push(`Monthly costs of ${formatMoney(spent)} went out.`);

  const offer = generateSponsorOffer(save, fighter, rng);
  if (offer) notes.push(`${offer.name} has made a sponsorship offer.`);

  const lost = checkMoralityClauses(save, fighter, rng);
  for (const sponsor of lost) notes.push(`${sponsor.name} has ended their deal under the morality clause.`);

  // Expire deals that have run their term.
  for (const sponsor of sponsorsFor(save, fighter.id)) {
    if (sponsor.status === 'active' && sponsor.endsOn < save.date) {
      sponsor.status = 'expired';
      notes.push(`The ${sponsor.name} deal has expired.`);
    }
    // An unanswered offer lapses, and says so. It used to vanish silently into the contract
    // history as a deal that had ended early.
    if (sponsor.status === 'offered' && daysBetween(sponsor.startedOn, save.date) > 14) {
      sponsor.status = 'lapsed';
      sponsor.note = `${sponsor.name} withdrew their offer after no reply.`;
      notes.push(sponsor.note);
    }
  }
  pruneLedger(save);
  return notes;
}
