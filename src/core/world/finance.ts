import { clamp, hashString, Rng } from '../rng';
import { addDays, daysBetween, type FighterId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { totalFollowers } from '../types/identity';

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
  | 'appearance';

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
  | 'purse-forfeit';

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
};

export const EXPENSE_LABEL: Record<ExpenseKind, string> = {
  'manager-commission': 'Manager commission',
  'gym-percentage': 'Gym percentage',
  'coaching-fees': 'Coaching fees',
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
  debt: number;
  /** Recurring monthly outgoings, recomputed as the career changes. */
  monthlyExpenses: number;
  lastMonthlyOn: IsoDate | null;
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
  const id = `ledger-${entries.length + 1}-${save.date}-${kind}`;
  // A repeated call with the same identity is ignored rather than double counting.
  if (entries.some((e) => e.id === id && e.boutId === boutId)) return null;
  const entry: LedgerEntry = { id, date: save.date, fighterId, direction, kind, amount: rounded, note, boutId };
  entries.push(entry);

  const finance = financeState(save);
  if (direction === 'in') {
    finance.cash += rounded;
    finance.careerEarnings += rounded;
  } else {
    finance.cash -= rounded;
    finance.careerExpenses += rounded;
    if (finance.cash < 0) {
      finance.debt = Math.max(finance.debt, -finance.cash);
    }
  }
  save.player.balance = finance.cash;
  return entry;
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
  /** Posts owed per month. */
  postsPerMonth: number;
  appearancesPerYear: number;
  exclusiveCategory: boolean;
  moralityClause: boolean;
  startedOn: IsoDate;
  endsOn: IsoDate;
  status: 'offered' | 'active' | 'expired' | 'terminated';
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
  const reach = clamp(Math.log10(Math.max(1, followers)) * 14, 0, 100);
  return clamp(fame.sponsorAppeal * 0.4 + fame.favorability * 0.25 + reach * 0.25 + fighter.popularity * 0.1 - fame.controversy * 0.15, 0, 100);
}

/** Generates a sponsorship offer, or null when nobody is interested right now. */
export function generateSponsorOffer(save: SaveGame, fighter: Fighter, rng: Rng): Sponsor | null {
  const appeal = sponsorAppealOf(fighter);
  if (appeal < 12) return null;
  const active = sponsorsFor(save, fighter.id).filter((s) => s.status === 'active');
  if (active.length >= 4) return null;
  if (!rng.chance(clamp(appeal / 260, 0.02, 0.35))) return null;

  const categories = Object.keys(SPONSOR_NAMES) as SponsorCategory[];
  const taken = new Set(active.filter((s) => s.exclusiveCategory).map((s) => s.category));
  const available = categories.filter((c) => !taken.has(c));
  if (available.length === 0) return null;
  const category = rng.pick(available);

  // A local business pays little and asks little. A telecom pays well and asks a lot.
  const tier = clamp(appeal / 100, 0, 1);
  const scale = category === 'local-business' ? 0.25 : category === 'telecoms' || category === 'finance' ? 1.4 : 1;
  const perFight = Math.round((2000 + tier * 60000) * scale * rng.range(0.8, 1.25));
  const monthly = rng.chance(0.35) ? Math.round(perFight * rng.range(0.05, 0.2)) : 0;

  const id = `sponsor-${fighter.id}-${save.date}-${category}`;
  if (save.sponsors?.[id]) return null;
  const sponsor: Sponsor = {
    id,
    name: rng.pick(SPONSOR_NAMES[category]),
    category,
    perFight,
    monthly,
    winBonus: Math.round(perFight * rng.range(0.2, 0.6)),
    championBonus: Math.round(perFight * rng.range(1, 3)),
    postsPerMonth: Math.max(0, Math.round(rng.range(0, 3) * (scale > 1 ? 1.6 : 1))),
    appearancesPerYear: Math.round(rng.range(0, 4) * (scale > 1 ? 1.5 : 1)),
    exclusiveCategory: rng.chance(0.55),
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

export function sponsorsFor(save: SaveGame, fighterId: FighterId): Sponsor[] {
  if (!save.sponsors) return [];
  return Object.values(save.sponsors).filter((s) => s.id.includes(fighterId));
}

export function acceptSponsor(save: SaveGame, sponsorId: string): Sponsor | null {
  const sponsor = save.sponsors?.[sponsorId];
  if (!sponsor || sponsor.status !== 'offered') return null;
  sponsor.status = 'active';
  return sponsor;
}

export function declineSponsor(save: SaveGame, sponsorId: string): Sponsor | null {
  const sponsor = save.sponsors?.[sponsorId];
  if (!sponsor || sponsor.status !== 'offered') return null;
  sponsor.status = 'terminated';
  return sponsor;
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
  const id = `manager-${Object.keys(save.managers ?? {}).length + 1}`;
  const honesty = clamp(rng.normal(62, 20), 5, 99);
  const manager: Manager = {
    id,
    name: `${rng.pick(MANAGER_FIRST)} ${rng.pick(MANAGER_LAST)}`,
    negotiation: clamp(rng.normal(55, 18), 10, 98),
    matchmakingInfluence: clamp(rng.normal(45, 20), 5, 95),
    sponsorNetwork: clamp(rng.normal(50, 22), 5, 98),
    mediaSkill: clamp(rng.normal(50, 18), 5, 95),
    loyalty: clamp(rng.normal(60, 20), 5, 99),
    aggressiveness: clamp(rng.normal(50, 22), 5, 98),
    honesty,
    // A better negotiator asks for more. An honest one is clearer about it.
    commissionPct: Math.round(clamp(rng.normal(12, 4), 5, 25)),
    clientCapacity: Math.round(clamp(rng.normal(9, 4), 2, 24)),
    clientIds: [],
    note: honesty < 40 ? 'Has a reputation for creative accounting.' : 'Straightforward to deal with.',
  };
  if (!save.managers) save.managers = {};
  save.managers[id] = manager;
  return manager;
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
  const lifestyleTier = clamp(earnings / 900000, 0.25, 4);
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  const out: { kind: ExpenseKind; amount: number }[] = [
    { kind: 'housing', amount: Math.round(1400 * lifestyleTier) },
    { kind: 'lifestyle', amount: Math.round(900 * lifestyleTier) },
    { kind: 'nutrition', amount: Math.round(500 + 300 * lifestyleTier) },
  ];
  if (gym) out.push({ kind: 'coaching-fees', amount: Math.round(gym.monthlyCosts * 0.04) });
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
  record(save, fighter.id, 'in', 'show-pay', gross.show, 'Show pay', boutId);
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
    const cut = Math.round(total * 0.08);
    record(save, fighter.id, 'out', 'gym-percentage', cut, `${gym.name} percentage`, boutId);
    deductions.push({ kind: 'gym-percentage', amount: cut });
  }
  const tax = Math.round(total * 0.32);
  record(save, fighter.id, 'out', 'taxes', tax, 'Taxes withheld', boutId);
  deductions.push({ kind: 'taxes', amount: tax });

  const travel = Math.round(1200 + total * 0.01);
  record(save, fighter.id, 'out', 'travel', travel, 'Fight week travel', boutId);
  deductions.push({ kind: 'travel', amount: travel });

  const net = total - deductions.reduce((s, d) => s + d.amount, 0);
  return { gross: total, net, deductions };
}

export interface FinanceSummary {
  cash: number;
  careerEarnings: number;
  careerExpenses: number;
  netWorthEstimate: number;
  debt: number;
  monthlyExpenses: number;
  /** Months of expenses the current cash covers. */
  runwayMonths: number;
  pressure: 'comfortable' | 'stable' | 'stretched' | 'under pressure' | 'in trouble';
  retirementSecurity: 'secure' | 'adequate' | 'thin' | 'nothing put aside';
  incomeByKind: { kind: IncomeKind; amount: number }[];
  expenseByKind: { kind: ExpenseKind; amount: number }[];
}

export function summarize(save: SaveGame, fighterId: FighterId): FinanceSummary {
  const finance = financeState(save);
  const entries = ledger(save).filter((e) => e.fighterId === fighterId);
  const income = new Map<IncomeKind, number>();
  const expense = new Map<ExpenseKind, number>();
  for (const e of entries) {
    if (e.direction === 'in') income.set(e.kind as IncomeKind, (income.get(e.kind as IncomeKind) ?? 0) + e.amount);
    else expense.set(e.kind as ExpenseKind, (expense.get(e.kind as ExpenseKind) ?? 0) + e.amount);
  }
  const fighter = save.fighters[fighterId];
  const monthly = finance.monthlyExpenses > 0 ? finance.monthlyExpenses : fighter ? monthlyExpensesFor(save, fighter).reduce((s, i) => s + i.amount, 0) : 3000;
  const runway = monthly > 0 ? finance.cash / monthly : 99;
  const netWorth = finance.cash - finance.debt;

  return {
    cash: Math.round(finance.cash),
    careerEarnings: Math.round(finance.careerEarnings),
    careerExpenses: Math.round(finance.careerExpenses),
    netWorthEstimate: Math.round(netWorth),
    debt: Math.round(finance.debt),
    monthlyExpenses: Math.round(monthly),
    runwayMonths: Math.round(runway * 10) / 10,
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
  if (spent > 0) notes.push(`Monthly costs of ${Math.round(spent)} went out.`);

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
    if (sponsor.status === 'offered' && daysBetween(sponsor.startedOn, save.date) > 14) {
      sponsor.status = 'terminated';
    }
  }
  pruneLedger(save);
  return notes;
}
