import { clamp, Rng } from '../rng';
import { addDays, daysBetween, type IsoDate } from '../types/common';
import type { Fighter, Injury } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { hasLiveBooking, postponeBout, releaseBooking } from './availability';
import { activeInjuries } from './health';
import { addInboxMessage, resolveMessagesForBout } from './inbox';
import { cancelBout, findReplacement, applyReplacement } from './matchmaking';
import { clearFightWeek } from './fightweek';
import { record } from './finance';

/**
 * What happens when a fighter with a booked bout gets hurt.
 *
 * The old behaviour was that nothing happened: the injury was recorded, the bout stayed on
 * the books, and the player was told nothing. The booked fight now becomes an explicit
 * decision that blocks the calendar until it is answered, and the resolution is a real
 * transaction on the booking rather than a message.
 */

export type InjurySeverityClass =
  | 'minor-trainable'
  | 'limits-camp'
  | 'requires-medical-review'
  | 'blocks-temporarily'
  | 'requires-withdrawal'
  | 'requires-surgery'
  | 'career-threatening';

export const SEVERITY_LABEL: Record<InjurySeverityClass, string> = {
  'minor-trainable': 'Minor, trainable',
  'limits-camp': 'Limits camp',
  'requires-medical-review': 'Needs a medical review',
  'blocks-temporarily': 'Blocks competition for now',
  'requires-withdrawal': 'Requires withdrawal',
  'requires-surgery': 'Requires surgery',
  'career-threatening': 'Career threatening',
};

/**
 * Classifies an injury against the fight that is booked.
 *
 * The same injury is a different problem depending on how close the fight is, which is why
 * this takes the bout date rather than only the injury.
 */
export function classifyInjury(injury: Injury, fightDate: IsoDate | null, today: IsoDate): InjurySeverityClass {
  const daysToFight = fightDate ? daysBetween(today, fightDate) : null;
  const daysOut = daysBetween(today, injury.expectedReturn);

  if (injury.severity >= 5 && daysOut > 180) return 'career-threatening';
  if (injury.severity >= 5) return 'requires-surgery';
  if (!injury.blocksCompetition) {
    if (injury.trainingCapacity < 0.55) return 'limits-camp';
    return 'minor-trainable';
  }
  // Blocking. Whether it forces a withdrawal depends on whether it clears in time.
  if (daysToFight === null) return 'blocks-temporarily';
  if (daysOut > daysToFight) return 'requires-withdrawal';
  if (daysOut > daysToFight - 14) return 'requires-medical-review';
  return 'blocks-temporarily';
}

export type InjuryChoiceKey =
  | 'continue-normal'
  | 'reduce-intensity'
  | 'train-around'
  | 'rest'
  | 'rehabilitate'
  | 'seek-specialist'
  | 'request-evaluation'
  | 'request-postponement'
  | 'withdraw'
  | 'continue-despite-risk'
  | 'choose-surgery';

export interface InjuryChoice {
  key: InjuryChoiceKey;
  label: string;
  /** What the player is told will probably happen. Shown before selection. */
  consequence: string;
  /** True when the choice ends the booking. */
  endsBooking: boolean;
}

const ALL_CHOICES: Record<InjuryChoiceKey, Omit<InjuryChoice, 'key'>> = {
  'continue-normal': {
    label: 'Continue training normally',
    consequence: 'Camp proceeds at full intensity. The injury is likely to get worse.',
    endsBooking: false,
  },
  'reduce-intensity': {
    label: 'Reduce camp intensity',
    consequence: 'Less sharpness on fight night, but the injury is less likely to worsen.',
    endsBooking: false,
  },
  'train-around': {
    label: 'Train around the injury',
    consequence: 'Camp continues with the affected work removed. Sharpness suffers a little.',
    endsBooking: false,
  },
  rest: {
    label: 'Rest completely',
    consequence: 'Recovery is faster. Camp effectively stops for the rest period.',
    endsBooking: false,
  },
  rehabilitate: {
    label: 'Begin rehabilitation',
    consequence: 'Shortens the expected return. Costs money and most of the camp.',
    endsBooking: false,
  },
  'seek-specialist': {
    label: 'See a specialist',
    consequence: 'A clearer prognosis and a modest reduction in recovery time. It is expensive.',
    endsBooking: false,
  },
  'request-evaluation': {
    label: 'Request a medical evaluation',
    consequence: 'The commission doctor gives a definite answer on whether you can be cleared.',
    endsBooking: false,
  },
  'request-postponement': {
    label: 'Ask the promotion to postpone',
    consequence: 'The promotion may move the bout to a later card with the same opponent, or refuse.',
    endsBooking: false,
  },
  withdraw: {
    label: 'Withdraw from the bout',
    consequence: 'The fight is off. The opponent may be given a replacement. Relationship damage.',
    endsBooking: true,
  },
  'continue-despite-risk': {
    label: 'Fight anyway',
    consequence: 'You take the fight hurt. Expect reduced performance and a real chance of lasting damage.',
    endsBooking: false,
  },
  'choose-surgery': {
    label: 'Have surgery',
    consequence: 'Long layoff and a full withdrawal, but the best long term outcome.',
    endsBooking: true,
  },
};

/** Which choices are medically sensible for this classification. */
export function choicesFor(severity: InjurySeverityClass, hasBooking: boolean): InjuryChoice[] {
  const keys: InjuryChoiceKey[] = [];
  switch (severity) {
    case 'minor-trainable':
      keys.push('continue-normal', 'reduce-intensity', 'train-around', 'rest');
      break;
    case 'limits-camp':
      keys.push('reduce-intensity', 'train-around', 'rest', 'rehabilitate', 'seek-specialist');
      break;
    case 'requires-medical-review':
      keys.push('request-evaluation', 'rehabilitate', 'seek-specialist', 'reduce-intensity');
      if (hasBooking) keys.push('request-postponement', 'withdraw');
      break;
    case 'blocks-temporarily':
      keys.push('rest', 'rehabilitate', 'seek-specialist', 'request-evaluation');
      if (hasBooking) keys.push('request-postponement', 'withdraw', 'continue-despite-risk');
      break;
    case 'requires-withdrawal':
      if (hasBooking) keys.push('request-postponement', 'withdraw', 'continue-despite-risk');
      keys.push('rehabilitate', 'seek-specialist');
      break;
    case 'requires-surgery':
      keys.push('choose-surgery', 'rehabilitate', 'seek-specialist');
      if (hasBooking) keys.push('withdraw');
      break;
    case 'career-threatening':
      keys.push('choose-surgery', 'seek-specialist', 'rest');
      if (hasBooking) keys.push('withdraw');
      break;
  }
  return keys.map((key) => ({ key, ...ALL_CHOICES[key] }));
}

/** Stable id so one injury raises exactly one decision. */
function decisionKey(injuryId: string): string {
  return `injury-decision-${injuryId}`;
}

/**
 * Raises the mandatory decision for a player injury, exactly once per injury.
 *
 * Returns the message id when one was created, or null when the decision already exists or
 * the injury is not worth stopping the game for.
 */
export function raiseInjuryDecision(save: SaveGame, fighter: Fighter, injury: Injury, development?: string): string | null {
  if (save.player.fighterId !== fighter.id) return null;
  // Identity is a real field. A decision for this injury is raised once, and only a genuine
  // new development ever raises another one for the same injury.
  const key = development ? `${decisionKey(injury.id)}-${development}` : decisionKey(injury.id);
  const existing = save.inbox.find((m) => m.decisionKey === key || m.resolution === key);
  if (existing) return null;
  // Do not stop the game for a scratch with no booking and no training effect.
  const bout = hasLiveBooking(save, fighter);
  const severity = classifyInjury(injury, bout?.date ?? null, save.date);
  if (!bout && severity === 'minor-trainable') return null;

  const opponent = bout ? save.fighters[bout.fighterAId === fighter.id ? bout.fighterBId : bout.fighterAId] : null;
  const event = bout ? save.events[bout.eventId] : null;
  const choices = choicesFor(severity, Boolean(bout));

  const bookingLine = bout
    ? `You are booked against ${opponent?.name ?? 'an opponent'} at ${event?.name ?? 'an event'} on ${bout.date}, ${daysBetween(save.date, bout.date)} days away. That booking stands until this is answered.`
    : 'You have no fight booked.';

  const message = addInboxMessage(save, {
    sender: 'doctor',
    senderName: 'Team doctor',
    subject: `Injury: ${injury.type}`,
    body: `${injury.type} (${SEVERITY_LABEL[severity]}). Expected return ${injury.expectedReturn}. ${bookingLine} ${injury.note}`,
    category: 'injury',
    requiresAction: true,
    deadline: bout ? bout.date : addDays(save.date, 21),
    choices: choices.map((c) => ({ key: c.key, label: c.label, hint: c.consequence, destructive: c.endsBooking })),
    linkedFighterId: opponent?.id ?? null,
    linkedEventId: event?.id ?? null,
    linkedBoutId: bout?.id ?? null,
  });
  message.decisionKey = key;
  message.linkedInjuryId = injury.id;
  message.decisionCreatedOn = save.date;
  return message.id;
}

export interface InjuryDecisionOutcome {
  message: string;
  boutStatus: 'unchanged' | 'postponed' | 'canceled' | 'withdrawn';
  newBoutDate: IsoDate | null;
  cost: number;
}

/**
 * Applies the player's injury decision. This is the transaction that resolves the booking.
 */
export function applyInjuryDecision(
  save: SaveGame,
  fighter: Fighter,
  injury: Injury,
  choice: InjuryChoiceKey,
  rng: Rng
): InjuryDecisionOutcome {
  const bout = hasLiveBooking(save, fighter);
  // The choice is recorded against the injury so treatment continues automatically and the
  // same question is not asked again next week.
  if (!save.injuryTreatments) save.injuryTreatments = {};
  save.injuryTreatments[injury.id] = {
    injuryId: injury.id,
    treatment: choice,
    startedOn: save.date,
    expectedReturnAtChoice: injury.expectedReturn,
    severityAtChoice: classifyInjury(injury, bout?.date ?? null, save.date),
    lastDevelopmentOn: save.date,
  };
  const opponent = bout ? save.fighters[bout.fighterAId === fighter.id ? bout.fighterBId : bout.fighterAId] : null;
  let cost = 0;

  switch (choice) {
    case 'continue-normal': {
      // Training through it makes it worse. The model is honest about that.
      injury.expectedReturn = addDays(injury.expectedReturn, Math.round(rng.range(7, 21)));
      injury.trainingCapacity = clamp(injury.trainingCapacity - 0.1, 0.05, 1);
      return { message: 'Camp continues at full intensity. The team is not happy about it.', boutStatus: 'unchanged', newBoutDate: null, cost };
    }
    case 'reduce-intensity': {
      const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && (c.status === 'planned' || c.status === 'running'));
      if (camp) camp.intensity = clamp(camp.intensity * 0.7, 0.2, 1);
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(0, 5)));
      return { message: 'Camp intensity is cut back for the rest of the preparation.', boutStatus: 'unchanged', newBoutDate: null, cost };
    }
    case 'train-around': {
      injury.trainingCapacity = clamp(injury.trainingCapacity + 0.1, 0.05, 1);
      return { message: 'The affected work comes out of camp and everything else continues.', boutStatus: 'unchanged', newBoutDate: null, cost };
    }
    case 'rest': {
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(4, 12)));
      const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && (c.status === 'planned' || c.status === 'running'));
      if (camp) camp.intensity = clamp(camp.intensity * 0.4, 0.1, 1);
      return { message: 'Full rest for now. Camp is effectively paused.', boutStatus: 'unchanged', newBoutDate: null, cost };
    }
    case 'rehabilitate': {
      cost = 4000 + Math.round(rng.range(0, 6000));
      record(save, fighter.id, 'out', 'rehabilitation', cost, 'Rehabilitation programme');
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(10, 25)));
      injury.treatment = 'rehab';
      return { message: `Rehabilitation begins. Expected return moves to ${injury.expectedReturn}.`, boutStatus: 'unchanged', newBoutDate: null, cost };
    }
    case 'seek-specialist': {
      cost = 9000 + Math.round(rng.range(0, 12000));
      record(save, fighter.id, 'out', 'rehabilitation', cost, 'Specialist consultation');
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(6, 18)));
      injury.note = `${injury.note} A specialist has reviewed it and given a clear prognosis.`;
      return { message: `The specialist gives a firm date of ${injury.expectedReturn}.`, boutStatus: 'unchanged', newBoutDate: null, cost };
    }
    case 'request-evaluation': {
      const clears = daysBetween(save.date, injury.expectedReturn) < (bout ? daysBetween(save.date, bout.date) : 0);
      return {
        message: clears
          ? 'The commission doctor expects to clear you in time, subject to the final check in fight week.'
          : 'The commission doctor will not clear you for this date.',
        boutStatus: 'unchanged',
        newBoutDate: null,
        cost,
      };
    }
    case 'request-postponement': {
      if (!bout) return { message: 'There is no bout to postpone.', boutStatus: 'unchanged', newBoutDate: null, cost };
      // The promotion agrees when the fighter is worth waiting for and the delay is sane.
      const clearBy = addDays(injury.expectedReturn, 21);
      const candidates = Object.values(save.events)
        .filter((e) => e.status === 'announced' && e.date > clearBy)
        .sort((x, y) => (x.date < y.date ? -1 : 1));
      const relationship = fighter.relationships.matchmaker;
      const worthWaiting = fighter.popularity > 30 || (fighter.ranking ?? 99) <= 10 || bout.isTitleFight;
      const agrees = candidates.length > 0 && worthWaiting && rng.chance(clamp(0.35 + relationship / 200 + (bout.isTitleFight ? 0.25 : 0), 0.1, 0.92));
      if (!agrees) {
        return {
          message: 'The promotion will not move the date. The bout stands or you withdraw.',
          boutStatus: 'unchanged',
          newBoutDate: null,
          cost,
        };
      }
      const target = candidates[0];
      // Fight week tasks belong to the old date and are rebuilt for the new one.
      clearFightWeek(save, bout.id);
      postponeBout(save, bout, target.id, `postponed after ${fighter.name} was injured`);
      resolveMessagesForBout(save, bout.id, `The bout was postponed to ${target.date}.`);
      fighter.relationships.matchmaker = clamp(relationship - 3, 0, 100);
      return {
        message: `The promotion agrees to move the bout to ${target.name} on ${target.date}, same opponent.`,
        boutStatus: 'postponed',
        newBoutDate: target.date,
        cost,
      };
    }
    case 'withdraw':
    case 'choose-surgery': {
      if (choice === 'choose-surgery') {
        cost = 25000 + Math.round(rng.range(0, 40000));
        record(save, fighter.id, 'out', 'surgery', cost, 'Surgery');
        injury.treatment = 'surgery';
        injury.expectedReturn = addDays(save.date, Math.round(rng.range(120, 260)));
      }
      if (!bout) {
        return {
          message: choice === 'choose-surgery' ? `Surgery scheduled. Expected return ${injury.expectedReturn}.` : 'Nothing to withdraw from.',
          boutStatus: 'unchanged',
          newBoutDate: null,
          cost,
        };
      }
      // The opponent stays on the card if a replacement can be found; otherwise the bout
      // is canceled. Either way this fighter's booking is resolved first.
      const opponentId = opponent?.id ?? null;
      releaseBooking(save, fighter.id, bout.id);
      clearFightWeek(save, bout.id);
      let replaced = false;
      if (opponentId) {
        const replacement = findReplacement(save, bout, fighter.id, rng);
        if (replacement) {
          replaced = applyReplacement(save, bout, fighter.id, replacement.fighter, replacement.reason);
        }
      }
      if (!replaced) {
        cancelBout(save, bout, `${fighter.name} withdrew: ${injury.type}`);
      }
      resolveMessagesForBout(save, bout.id, `${fighter.name} withdrew from the bout.`);
      fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 8, 0, 100);
      for (const camp of Object.values(save.camps)) {
        if (camp.fighterId !== fighter.id) continue;
        if (camp.status === 'planned' || camp.status === 'running') camp.status = 'abandoned';
      }
      return {
        message: replaced
          ? `You are out. ${opponent?.name ?? 'The opponent'} stays on the card against a replacement.`
          : `You are out and the bout has been canceled.`,
        boutStatus: replaced ? 'withdrawn' : 'canceled',
        newBoutDate: null,
        cost,
      };
    }
    case 'continue-despite-risk': {
      injury.note = `${injury.note} Fighting through it against medical advice.`;
      // Taking a fight hurt is recorded so the fight engine and the wear model both see it.
      fighter.wear.recovery = clamp(fighter.wear.recovery + 6, 0, 100);
      injury.expectedReturn = addDays(injury.expectedReturn, Math.round(rng.range(14, 45)));
      return { message: 'You are taking the fight hurt. The corner has been told.', boutStatus: 'unchanged', newBoutDate: null, cost };
    }
  }
}

/**
 * Called from the weekly pass. Raises a decision for any new player injury that matters.
 * Returns the number of decisions raised, which is always zero or one per injury.
 */
export function checkPlayerInjuries(save: SaveGame): number {
  const fighterId = save.player.fighterId;
  if (!fighterId) return 0;
  const fighter = save.fighters[fighterId];
  if (!fighter || fighter.retired) return 0;
  let raised = 0;
  for (const injury of activeInjuries(fighter, save.date)) {
    // A treated injury only raises another decision on a real development, never on
    // ordinary weekly recovery. That distinction is what stopped one injury from blocking
    // every single advance.
    const treated = save.injuryTreatments?.[injury.id];
    if (treated) {
      const development = detectDevelopment(save, fighter, injury, treated);
      if (!development) continue;
      treated.lastDevelopmentOn = save.date;
      if (raiseInjuryDecision(save, fighter, injury, development)) raised++;
      continue;
    }
    if (raiseInjuryDecision(save, fighter, injury)) raised++;
  }
  return raised;
}

/** A real change worth asking about again, or null for ordinary recovery. */
function detectDevelopment(save: SaveGame, fighter: Fighter, injury: Injury, treated: InjuryTreatment): string | null {
  // Only look once per day at most.
  if (treated.lastDevelopmentOn === save.date) return null;
  const bout = hasLiveBooking(save, fighter);
  const severity = classifyInjury(injury, bout?.date ?? null, save.date);

  // The prognosis got worse than it was when the choice was made.
  if (injury.expectedReturn > treated.expectedReturnAtChoice) {
    const slipDays = daysBetween(treated.expectedReturnAtChoice, injury.expectedReturn);
    if (slipDays >= 21) return `setback-${injury.expectedReturn}`;
  }
  // A booked fight has come inside the recovery window since the choice was made.
  if (bout && severity === 'requires-withdrawal' && treated.severityAtChoice !== 'requires-withdrawal') {
    return `conflicts-with-${bout.id}`;
  }
  // Surgery has become the recommendation when it was not before.
  if (severity === 'requires-surgery' && treated.severityAtChoice !== 'requires-surgery') {
    return 'surgery-recommended';
  }
  return null;
}


/** What the player chose for one injury, so treatment continues without re-asking. */
export interface InjuryTreatment {
  injuryId: string;
  treatment: InjuryChoiceKey;
  startedOn: IsoDate;
  expectedReturnAtChoice: IsoDate;
  severityAtChoice: InjurySeverityClass;
  lastDevelopmentOn: IsoDate;
}
