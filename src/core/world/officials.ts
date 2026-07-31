import { clamp, Rng } from '../rng';
import type { BoutId, IsoDate } from '../types/common';
import type { Bout, FightResult } from '../types/fight';
import type { SaveGame } from '../types/save';
import type { JudgePersona } from '../sim/judging';

/**
 * Officials.
 *
 * Judges used to be drawn fresh from a name pool for every fight and thrown away, so the same
 * three names could appear twice in a night with different tendencies, a judge could never
 * build a record, and a controversial card had nobody attached to it. An official is now a
 * persistent person in the save with a history that accumulates.
 *
 * The leanings are deliberately small. A judge who reads control time generously is realistic;
 * a judge who scores at random is not, and it would make the fight engine feel arbitrary rather
 * than imperfect.
 */

export type OfficialRole = 'judge' | 'referee';

export interface Official {
  id: string;
  name: string;
  role: OfficialRole;
  /** The commission that licenses them, which is where regional differences live. */
  commission: string;
  licensedOn: IsoDate;
  retiredOn: IsoDate | null;

  /** 0 to 100. Rises slowly with work. Experience narrows noise, it does not remove leaning. */
  experience: number;
  boutsWorked: number;
  titleBoutsWorked: number;

  // Judge leanings. Each is a small persistent multiplier or offset.
  grapplingLean: number;
  damageLean: number;
  /** How much control time alone sways them, over and above the grappling lean. */
  controlLean: number;
  /** Willingness to score a round 10-8. 0 gives a judge who almost never does. */
  tenEightWillingness: number;
  /** Susceptibility to a partisan crowd. Small, and only applies in a home market. */
  hometownSusceptibility: number;
  bias: number;

  // Referee tendencies. Below 1 is patient, above 1 stops fights early.
  stoppageTendency: number;
  standUpTendency: number;
  foulStrictness: number;

  // History.
  splitDecisionsWorked: number;
  /** Cards that disagreed with the other two by a wide margin. */
  outlierCards: number;
  controversies: { date: IsoDate; boutId: BoutId; note: string }[];
}

export const COMMISSIONS = [
  'Nevada',
  'California',
  'New York',
  'Texas',
  'Florida',
  'Ontario',
  'Sao Paulo',
  'Abu Dhabi',
  'London',
  'Sydney',
  'Singapore',
] as const;

const JUDGE_NAMES = [
  'D. Carter', 'M. Beltran', 'S. Okafor', 'J. Rinaldi', 'A. Novak', 'T. Lindqvist',
  'R. Aoki', 'P. Dufresne', 'K. Whitaker', 'L. Moreau', 'C. Vasquez', 'H. Nakamura',
  'B. Osei', 'G. Petrov', 'N. Haddad', 'E. Sandoval', 'W. Fitzgerald', 'I. Kowalski',
  'V. Mbeki', 'O. Lindgren', 'F. Castellano', 'Y. Tanaka', 'Q. Ferreira', 'Z. Abadi',
];

const REFEREE_NAMES = [
  'H. Marston', 'J. Okonkwo', 'R. Delacroix', 'S. Yamamoto', 'A. Petrakis', 'M. Colvin',
  'T. Adeyemi', 'L. Bergstrom', 'C. Navarro', 'P. Sundaram', 'D. Kavanagh', 'N. Rossi',
];

function officialStore(save: SaveGame): Record<string, Official> {
  if (!save.officials) save.officials = {};
  return save.officials;
}

export function allOfficials(save: SaveGame): Official[] {
  return Object.values(officialStore(save));
}

export function officialsByRole(save: SaveGame, role: OfficialRole): Official[] {
  return allOfficials(save).filter((o) => o.role === role);
}

export function getOfficial(save: SaveGame, id: string): Official | null {
  return officialStore(save)[id] ?? null;
}

function makeOfficial(id: string, name: string, role: OfficialRole, rng: Rng, today: IsoDate): Official {
  const experience = rng.normalClamped(52, 20, 8, 96);
  // An experienced official has been working for longer, so their bout count starts higher.
  const boutsWorked = Math.round(clamp(experience * rng.range(1.4, 3.2), 0, 400));
  return {
    id,
    name,
    role,
    commission: COMMISSIONS[Math.floor(rng.range(0, COMMISSIONS.length)) % COMMISSIONS.length],
    licensedOn: today,
    retiredOn: null,
    experience,
    boutsWorked,
    titleBoutsWorked: Math.round(boutsWorked * clamp(experience / 260, 0, 0.14)),
    // Experience narrows the leanings rather than removing them.
    grapplingLean: rng.normalClamped(0, 0.16 * (1 - experience / 300), -0.4, 0.4),
    damageLean: rng.normalClamped(0, 0.16 * (1 - experience / 300), -0.4, 0.4),
    controlLean: rng.normalClamped(0, 0.14, -0.35, 0.35),
    tenEightWillingness: rng.normalClamped(1, 0.18, 0.55, 1.45),
    hometownSusceptibility: clamp(rng.normalClamped(0.1, 0.08, 0, 0.35) * (1 - experience / 220), 0, 0.3),
    bias: rng.normal(0, 0.05),
    stoppageTendency: rng.normalClamped(1, 0.13, 0.7, 1.35),
    standUpTendency: rng.normalClamped(1, 0.18, 0.6, 1.4),
    foulStrictness: rng.normalClamped(1, 0.2, 0.6, 1.45),
    splitDecisionsWorked: 0,
    outlierCards: 0,
    controversies: [],
  };
}

/**
 * Creates the officials roster once per save.
 *
 * Seeded from the save seed so the same world always has the same officials, which is what
 * makes a judge's record mean anything across a long career.
 */
export function ensureOfficials(save: SaveGame): number {
  const store = officialStore(save);
  if (Object.keys(store).length > 0) return 0;
  const rng = new Rng(`officials-${save.seed}`);
  let created = 0;
  JUDGE_NAMES.forEach((name, i) => {
    const id = `judge-${i + 1}`;
    store[id] = makeOfficial(id, name, 'judge', rng, save.date);
    created++;
  });
  REFEREE_NAMES.forEach((name, i) => {
    const id = `referee-${i + 1}`;
    store[id] = makeOfficial(id, name, 'referee', rng, save.date);
    created++;
  });
  return created;
}

export interface OfficialAssignment {
  judgeIds: string[];
  refereeId: string | null;
}

/**
 * Assigns three judges and a referee to a bout.
 *
 * A championship bout draws from the more experienced end of the pool, which is the real
 * pattern and also means a title fight is less likely to be decided by the widest leaning
 * judge in the roster. The draw is derived from the bout id and the save seed rather than
 * consuming the simulation rng, so assigning officials cannot shift fight outcomes.
 */
export function assignOfficials(save: SaveGame, bout: Bout): OfficialAssignment {
  ensureOfficials(save);
  if (bout.officials && bout.officials.judgeIds.length === 3) return bout.officials;

  const isTitle = bout.isTitleFight || bout.isInterimTitleFight;
  const rng = new Rng(`assign-${save.seed}-${bout.id}`);

  const judges = officialsByRole(save, 'judge').filter((o) => !o.retiredOn);
  const referees = officialsByRole(save, 'referee').filter((o) => !o.retiredOn);

  const judgePool = isTitle
    ? [...judges].sort((a, b) => b.experience - a.experience).slice(0, Math.max(6, Math.ceil(judges.length / 2)))
    : judges;

  const picked: string[] = [];
  const available = [...judgePool];
  while (picked.length < 3 && available.length > 0) {
    const index = Math.floor(rng.range(0, available.length)) % available.length;
    picked.push(available[index].id);
    available.splice(index, 1);
  }

  const refPool = isTitle
    ? [...referees].sort((a, b) => b.experience - a.experience).slice(0, Math.max(3, Math.ceil(referees.length / 2)))
    : referees;
  const refereeId = refPool.length > 0 ? refPool[Math.floor(rng.range(0, refPool.length)) % refPool.length].id : null;

  const assignment: OfficialAssignment = { judgeIds: picked, refereeId };
  bout.officials = assignment;
  return assignment;
}

/** Converts assigned judges into the personas the fight engine scores with. */
export function judgePersonasFor(save: SaveGame, assignment: OfficialAssignment, homeAdvantage = 0): JudgePersona[] {
  const out: JudgePersona[] = [];
  for (const id of assignment.judgeIds) {
    const o = getOfficial(save, id);
    if (!o) continue;
    out.push({
      name: o.name,
      grapplingLean: o.grapplingLean + o.controlLean * 0.4,
      damageLean: o.damageLean,
      // A partisan crowd nudges a susceptible judge toward the home fighter. It is a small
      // effect on top of an already small bias, never a decisive one.
      bias: o.bias + homeAdvantage * o.hometownSusceptibility,
      tenEightWillingness: o.tenEightWillingness,
    });
  }
  return out;
}

/** The referee tendency for a bout, or null when no referee is assigned. */
export function refereeTendencyFor(save: SaveGame, assignment: OfficialAssignment): number | null {
  if (!assignment.refereeId) return null;
  const ref = getOfficial(save, assignment.refereeId);
  return ref ? ref.stoppageTendency : null;
}

/**
 * Records what the officials did, after a fight is resolved.
 *
 * An outlier card is one that disagreed with the other two by three points or more. That is
 * the concrete, checkable definition of a judge being out of step, rather than a subjective
 * label.
 */
export function recordOfficialOutcome(save: SaveGame, bout: Bout, result: FightResult): void {
  const assignment = bout.officials;
  if (!assignment) return;
  const isTitle = bout.isTitleFight || bout.isInterimTitleFight;

  for (const id of assignment.judgeIds) {
    const judge = getOfficial(save, id);
    if (!judge) continue;
    judge.boutsWorked++;
    if (isTitle) judge.titleBoutsWorked++;
    // Experience accrues slowly and saturates.
    judge.experience = clamp(judge.experience + (isTitle ? 0.5 : 0.15), 0, 100);
  }
  if (assignment.refereeId) {
    const ref = getOfficial(save, assignment.refereeId);
    if (ref) {
      ref.boutsWorked++;
      if (isTitle) ref.titleBoutsWorked++;
      ref.experience = clamp(ref.experience + (isTitle ? 0.5 : 0.15), 0, 100);
    }
  }

  const cards = result.scorecards ?? [];
  if (cards.length !== 3) return;
  const split = result.method === 'decision-split' || result.method === 'decision-majority' || result.method === 'draw-split';

  const margins = cards.map((c) => c.totalA - c.totalB);
  cards.forEach((card, i) => {
    const judge = allOfficials(save).find((o) => o.role === 'judge' && o.name === card.judgeName);
    if (!judge) return;
    if (split) judge.splitDecisionsWorked++;
    // The card has to be adrift of every colleague, not of their average. Using the average
    // let a single wide card drag the two judges who agreed with each other over the line too.
    const others = margins.filter((_, j) => j !== i);
    const gap = others.length > 0 ? Math.min(...others.map((m) => Math.abs(margins[i] - m))) : 0;
    if (gap >= 3) {
      judge.outlierCards++;
      judge.controversies.push({
        date: result.date,
        boutId: bout.id,
        note: `Scored ${card.totalA}-${card.totalB}, out of step with the other two cards by ${Math.round(gap)} points.`,
      });
      if (judge.controversies.length > 20) judge.controversies.splice(0, judge.controversies.length - 20);
    }
  });
}

/** A short readable description of how an official works. */
export function officialSummary(o: Official): string {
  if (o.role === 'referee') {
    const stoppage = o.stoppageTendency > 1.12 ? 'stops fights early' : o.stoppageTendency < 0.9 ? 'lets fights run' : 'stops fights around the average point';
    const fouls = o.foulStrictness > 1.15 ? 'strict on fouls' : o.foulStrictness < 0.85 ? 'lenient on fouls' : 'even handed on fouls';
    return `${stoppage}, ${fouls}.`;
  }
  const parts: string[] = [];
  if (o.grapplingLean > 0.08) parts.push('rewards grappling');
  else if (o.grapplingLean < -0.08) parts.push('rewards striking');
  if (o.controlLean > 0.1) parts.push('values control time');
  if (o.damageLean > 0.08) parts.push('scores damage heavily');
  if (o.tenEightWillingness > 1.2) parts.push('willing to score 10-8');
  else if (o.tenEightWillingness < 0.8) parts.push('reluctant to score 10-8');
  if (parts.length === 0) parts.push('no strong leaning');
  return `${parts.join(', ')}.`;
}

/** The controversy rate, used to order the officials list. */
export function controversyRate(o: Official): number {
  if (o.boutsWorked === 0) return 0;
  return o.outlierCards / o.boutsWorked;
}
