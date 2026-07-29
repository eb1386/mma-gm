import { clamp, Rng } from '../rng';
import { addDays, daysBetween, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { addInboxMessage } from './inbox';
import { hasLiveBooking } from './availability';
import { cancelBout } from './matchmaking';
import { record } from './finance';

/**
 * Anti-doping, kept deliberately abstract.
 *
 * This models the consequences a fighter faces, not the methods. There is nothing here
 * about what substances exist, how a test works, or how anyone might avoid one. The player
 * chooses a compliance posture and lives with the risk that posture carries.
 */

export type CompliancePosture = 'strict' | 'standard' | 'loose' | 'questionable';

export const POSTURE_LABEL: Record<CompliancePosture, string> = {
  strict: 'Strict compliance',
  standard: 'Standard compliance',
  loose: 'Careless with supplements',
  questionable: 'Willing to cut corners',
};

export const POSTURE_DETAIL: Record<CompliancePosture, string> = {
  strict: 'Everything is checked and logged. Nothing goes in that has not been cleared. No risk beyond bad luck.',
  standard: 'Ordinary professional care. A small chance of a contaminated product slipping through.',
  loose: 'Supplements are bought without much scrutiny. A real chance of an adverse finding you did not intend.',
  questionable: 'Deliberately close to the line. A substantial chance of an adverse finding and a long ban if it lands.',
};

/** Base annual chance of an adverse finding for each posture. */
const POSTURE_RISK: Record<CompliancePosture, number> = {
  strict: 0.004,
  standard: 0.012,
  loose: 0.05,
  questionable: 0.16,
};

/** Performance effect. Only the questionable posture gives one, and it is small. */
const POSTURE_RECOVERY_BONUS: Record<CompliancePosture, number> = {
  strict: 0,
  standard: 0,
  loose: 0.02,
  questionable: 0.08,
};

export interface DopingState {
  posture: CompliancePosture;
  testsThisYear: number;
  lastTestedOn: IsoDate | null;
  findings: {
    on: IsoDate;
    kind: 'adverse' | 'atypical' | 'whereabouts-failure';
    resolved: boolean;
    outcome: string | null;
  }[];
  underInvestigation: boolean;
  appealOpen: boolean;
}

export function dopingState(save: SaveGame, fighterId: string): DopingState {
  if (!save.doping) save.doping = {};
  if (!save.doping[fighterId]) {
    save.doping[fighterId] = {
      posture: 'standard',
      testsThisYear: 0,
      lastTestedOn: null,
      findings: [],
      underInvestigation: false,
      appealOpen: false,
    };
  }
  return save.doping[fighterId];
}

export function setPosture(save: SaveGame, fighterId: string, posture: CompliancePosture): DopingState {
  const state = dopingState(save, fighterId);
  state.posture = posture;
  return state;
}

export function recoveryBonusFor(save: SaveGame, fighterId: string): number {
  return POSTURE_RECOVERY_BONUS[dopingState(save, fighterId).posture];
}

/**
 * One week of testing and consequences.
 *
 * Testing frequency rises with ranking and with being booked, which is how it works in
 * practice. An adverse finding suspends the fighter, voids a booked bout, costs sponsors
 * and can strip a title.
 */
export function runAntiDopingWeek(save: SaveGame, fighter: Fighter, rng: Rng): string[] {
  const notes: string[] = [];
  const state = dopingState(save, fighter.id);
  if (fighter.retired) return notes;

  // Reset the annual counter on the turn of the year.
  if (state.lastTestedOn && state.lastTestedOn.slice(0, 4) !== save.date.slice(0, 4)) state.testsThisYear = 0;

  const booked = hasLiveBooking(save, fighter);
  const ranked = fighter.ranking !== null || fighter.isChampion;
  // Roughly: a ranked booked fighter is tested often, an unranked inactive one rarely.
  const weeklyTestChance = (ranked ? 0.09 : 0.03) * (booked ? 2.2 : 1) * (fighter.isChampion ? 1.4 : 1);
  if (!rng.chance(weeklyTestChance)) return notes;

  state.testsThisYear++;
  state.lastTestedOn = save.date;

  const annualRisk = POSTURE_RISK[state.posture];
  // Convert the annual risk into a per test chance, given how often this fighter is tested.
  const perTest = clamp(annualRisk / Math.max(1, state.testsThisYear > 0 ? 8 : 1), 0.0005, 0.35);
  if (!rng.chance(perTest)) return notes;

  const kind = rng.chance(0.72) ? 'adverse' : rng.chance(0.5) ? 'atypical' : 'whereabouts-failure';
  state.findings.push({ on: save.date, kind, resolved: false, outcome: null });
  state.underInvestigation = true;

  if (kind === 'atypical') {
    notes.push(`${fighter.name} has an atypical finding under review. No suspension while it is investigated.`);
    addInboxMessage(save, {
      sender: 'commission',
      senderName: 'Anti-doping programme',
      subject: 'Atypical finding under review',
      body: 'A sample has returned an atypical result. It is being investigated and no provisional suspension applies while that happens. You may continue to compete.',
      category: 'medical',
      requiresAction: false,
      deadline: null,
      choices: [],
      linkedFighterId: fighter.id,
    });
    return notes;
  }

  // An adverse finding or a whereabouts failure both suspend.
  const months = kind === 'adverse' ? (state.posture === 'questionable' ? rng.int(18, 30) : rng.int(6, 18)) : rng.int(3, 9);
  const until = addDays(save.date, months * 30);
  fighter.antiDopingSuspension = {
    until,
    reason: kind === 'adverse' ? 'adverse analytical finding' : 'missed tests',
    clearanceRequired: true,
  };
  fighter.activityStatus = 'suspended';
  notes.push(`${fighter.name} is provisionally suspended until ${until}.`);

  // A booked fight is void.
  if (booked) {
    cancelBout(save, booked, `${fighter.name} was provisionally suspended`);
    notes.push('The booked fight has been canceled.');
  }

  // A champion is stripped.
  const table = save.rankings[fighter.divisionId];
  if (table?.championId === fighter.id) {
    table.championId = null;
    fighter.isChampion = false;
    const reign = save.history.reigns.find((r) => r.fighterId === fighter.id && r.lostOn === null && !r.isInterim);
    if (reign) {
      reign.lostOn = save.date;
      reign.endReason = 'stripped';
    }
    notes.push(`${fighter.name} has been stripped of the title.`);
  }

  // Sponsors with a morality clause walk, and a fine lands.
  if (save.sponsors) {
    for (const sponsor of Object.values(save.sponsors)) {
      if (!sponsor.id.includes(fighter.id) || sponsor.status !== 'active') continue;
      if (sponsor.moralityClause) {
        sponsor.status = 'terminated';
        notes.push(`${sponsor.name} has ended their deal.`);
      }
    }
  }
  if (save.player.fighterId === fighter.id) {
    const fine = Math.round(fighter.lastPurse ? fighter.lastPurse * 0.2 : 10000);
    record(save, fighter.id, 'out', 'fine', fine, 'Anti-doping fine');
  }
  if (fighter.fame) {
    fighter.fame.controversy = clamp(fighter.fame.controversy + 25, 0, 100);
    fighter.fame.favorability = clamp(fighter.fame.favorability - 18, 0, 100);
    fighter.fame.promotionalTrust = clamp(fighter.fame.promotionalTrust - 25, 0, 100);
  }

  if (save.player.fighterId === fighter.id) {
    addInboxMessage(save, {
      sender: 'commission',
      senderName: 'Anti-doping programme',
      subject: kind === 'adverse' ? 'Adverse analytical finding' : 'Whereabouts failure',
      body: `A provisional suspension applies until ${until}. You may accept the sanction or appeal it. An appeal can shorten or overturn the ban, and can also fail and leave it standing.`,
      category: 'medical',
      requiresAction: true,
      deadline: addDays(save.date, 21),
      choices: [
        { key: 'doping-accept', label: 'Accept the sanction', hint: 'Serve the suspension as handed down.' },
        { key: 'doping-appeal', label: 'Appeal it', hint: 'Costly, and the outcome is genuinely uncertain.' },
      ],
      linkedFighterId: fighter.id,
    });
  }
  return notes;
}

export interface AppealOutcome {
  message: string;
  reducedMonths: number;
  overturned: boolean;
  cost: number;
}

/** Resolves an appeal. Honest about the odds: most appeals reduce rather than overturn. */
export function appealSanction(save: SaveGame, fighter: Fighter, rng: Rng): AppealOutcome {
  const state = dopingState(save, fighter.id);
  state.appealOpen = false;
  const cost = Math.round(15000 + rng.range(0, 60000));
  if (save.player.fighterId === fighter.id) record(save, fighter.id, 'out', 'fine', cost, 'Legal costs of the appeal');

  const suspension = fighter.antiDopingSuspension;
  if (!suspension) return { message: 'There is no sanction to appeal.', reducedMonths: 0, overturned: false, cost };

  // A contamination case is far more likely to succeed than a deliberate one.
  const contamination = state.posture === 'strict' || state.posture === 'standard';
  const overturnChance = contamination ? 0.28 : 0.05;
  const reduceChance = contamination ? 0.55 : 0.3;

  if (rng.chance(overturnChance)) {
    fighter.antiDopingSuspension = null;
    fighter.activityStatus = 'active';
    state.underInvestigation = false;
    const finding = state.findings[state.findings.length - 1];
    if (finding) {
      finding.resolved = true;
      finding.outcome = 'overturned on appeal';
    }
    if (fighter.fame) fighter.fame.favorability = clamp(fighter.fame.favorability + 12, 0, 100);
    return { message: 'The sanction has been overturned. You are cleared to compete immediately.', reducedMonths: 0, overturned: true, cost };
  }

  if (rng.chance(reduceChance)) {
    const remaining = daysBetween(save.date, suspension.until);
    const cut = Math.round(remaining * rng.range(0.25, 0.55));
    suspension.until = addDays(suspension.until, -cut);
    const finding = state.findings[state.findings.length - 1];
    if (finding) {
      finding.resolved = true;
      finding.outcome = `reduced by ${Math.round(cut / 30)} months`;
    }
    return { message: `The panel reduced the suspension by about ${Math.round(cut / 30)} months. It now runs to ${suspension.until}.`, reducedMonths: Math.round(cut / 30), overturned: false, cost };
  }

  const finding = state.findings[state.findings.length - 1];
  if (finding) {
    finding.resolved = true;
    finding.outcome = 'upheld';
  }
  return { message: 'The appeal failed. The suspension stands in full, and the legal costs are yours.', reducedMonths: 0, overturned: false, cost };
}

/** Accepting the sanction without appealing. */
export function acceptSanction(save: SaveGame, fighter: Fighter): string {
  const state = dopingState(save, fighter.id);
  state.appealOpen = false;
  const finding = state.findings[state.findings.length - 1];
  if (finding) {
    finding.resolved = true;
    finding.outcome = 'accepted';
  }
  return `The suspension stands until ${fighter.antiDopingSuspension?.until ?? 'the stated date'}.`;
}

/** Clears expired suspensions. Called from the weekly health pass. */
export function clearExpiredSuspensions(save: SaveGame, fighter: Fighter): boolean {
  if (!fighter.antiDopingSuspension) return false;
  if (fighter.antiDopingSuspension.until > save.date) return false;
  fighter.antiDopingSuspension = null;
  if (fighter.activityStatus === 'suspended') fighter.activityStatus = 'active';
  const state = dopingState(save, fighter.id);
  state.underInvestigation = false;
  return true;
}
