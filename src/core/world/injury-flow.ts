import { clamp, Rng } from '../rng';
import { addDays, daysBetween, formatDate, type IsoDate } from '../types/common';
import { isChampionshipBout } from '../types/fight';
import type { Fighter, Injury } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { hasLiveBooking, postponeBout, releaseBooking } from './availability';
import { activeInjuries } from './health';
import { addInboxMessage, resolveMessagesForBout } from './inbox';
import { cancelBout, findReplacement, findTitleReplacement, applyReplacement, TITLE_REBOOK_NOTICE_DAYS } from './matchmaking';
import { clearFightWeek } from './fightweek';
import { record } from './finance';
import { autoCampFor } from './camp';
import { trainingCostScale } from './circuit';

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

/**
 * Which choices are medically sensible for this classification.
 *
 * A medical evaluation answers whether the fighter can be cleared for a date, so it is only
 * offered when there is a date. Surgery is not offered to somebody who has already had it: the
 * same decision came back after the operation and charged for a second one.
 */
export function choicesFor(severity: InjurySeverityClass, hasBooking: boolean, hadSurgery = false): InjuryChoice[] {
  const keys: InjuryChoiceKey[] = [];
  switch (severity) {
    case 'minor-trainable':
      keys.push('continue-normal', 'reduce-intensity', 'train-around', 'rest');
      break;
    case 'limits-camp':
      keys.push('reduce-intensity', 'train-around', 'rest', 'rehabilitate', 'seek-specialist');
      break;
    case 'requires-medical-review':
      if (hasBooking) keys.push('request-evaluation');
      keys.push('rehabilitate', 'seek-specialist', 'reduce-intensity');
      if (hasBooking) keys.push('request-postponement', 'withdraw');
      break;
    case 'blocks-temporarily':
      keys.push('rest', 'rehabilitate', 'seek-specialist');
      if (hasBooking) keys.push('request-evaluation', 'request-postponement', 'withdraw', 'continue-despite-risk');
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
  return keys.filter((key) => !(hadSurgery && key === 'choose-surgery')).map((key) => ({ key, ...ALL_CHOICES[key] }));
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
  const choices = choicesFor(severity, Boolean(bout), injury.treatment === 'surgery');

  const bookingLine = bout
    ? `You are booked against ${opponent?.name ?? 'an opponent'} at ${event?.name ?? 'an event'} on ${formatDate(bout.date)}, ${daysBetween(save.date, bout.date)} days away. That booking stands until this is answered.`
    : 'You have no fight booked.';

  const message = addInboxMessage(save, {
    sender: 'doctor',
    senderName: 'Team doctor',
    subject: `Injury: ${injury.type}`,
    body: `${injury.type} (${SEVERITY_LABEL[severity]}). Expected return ${formatDate(injury.expectedReturn)}. ${bookingLine} ${injury.note}`,
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
  const opponent = bout ? save.fighters[bout.fighterAId === fighter.id ? bout.fighterBId : bout.fighterAId] : null;
  let cost = 0;
  let outcome: InjuryDecisionOutcome;

  // Every case falls through to the treatment record below. The cases used to return directly,
  // and the record was written before them, holding the prognosis from before the choice. Fight
  // anyway and surgery both move the return date, so the next weekly check read the player's own
  // choice as a setback and asked the same question again.
  switch (choice) {
    case 'continue-normal': {
      // Training through it makes it worse. The model is honest about that.
      injury.expectedReturn = addDays(injury.expectedReturn, Math.round(rng.range(7, 21)));
      injury.trainingCapacity = clamp(injury.trainingCapacity - 0.1, 0.05, 1);
      outcome = { message: 'Camp continues at full intensity. The team is not happy about it.', boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
    case 'reduce-intensity': {
      const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && (c.status === 'planned' || c.status === 'running'));
      if (camp) camp.intensity = clamp(camp.intensity * 0.7, 0.2, 1);
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(0, 5)));
      outcome = { message: 'Camp intensity is cut back for the rest of the preparation.', boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
    case 'train-around': {
      injury.trainingCapacity = clamp(injury.trainingCapacity + 0.1, 0.05, 1);
      outcome = { message: 'The affected work comes out of camp and everything else continues.', boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
    case 'rest': {
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(4, 12)));
      const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && (c.status === 'planned' || c.status === 'running'));
      if (camp) camp.intensity = clamp(camp.intensity * 0.4, 0.1, 1);
      outcome = { message: 'Full rest for now. Camp is effectively paused.', boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
    case 'rehabilitate': {
      // Scaled to the circuit like camp costs, with the same floor as a camp specialist. A regional
      // fighter on two thousand dollar purses was billed main roster rates for the same treatment.
      cost = Math.round((4000 + Math.round(rng.range(0, 6000))) * Math.max(0.15, trainingCostScale(fighter)));
      record(save, fighter.id, 'out', 'rehabilitation', cost, 'Rehabilitation programme');
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(10, 25)));
      injury.treatment = 'rehab';
      outcome = { message: `Rehabilitation begins. Expected return moves to ${formatDate(injury.expectedReturn)}.`, boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
    case 'seek-specialist': {
      cost = Math.round((9000 + Math.round(rng.range(0, 12000))) * Math.max(0.15, trainingCostScale(fighter)));
      record(save, fighter.id, 'out', 'rehabilitation', cost, 'Specialist consultation');
      injury.expectedReturn = addDays(injury.expectedReturn, -Math.round(rng.range(6, 18)));
      injury.note = `${injury.note} A specialist has reviewed it and given a clear prognosis.`;
      outcome = { message: `The specialist gives a firm date of ${formatDate(injury.expectedReturn)}.`, boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
    case 'request-evaluation': {
      // With no bout there is no date to be cleared for, so the doctor gives the prognosis instead.
      // This still happens when a decision raised with a booking is answered after the bout is gone.
      if (!bout) {
        outcome = {
          message: `The commission doctor expects you to be medically cleared on ${formatDate(injury.expectedReturn)}.`,
          boutStatus: 'unchanged',
          newBoutDate: null,
          cost,
        };
        break;
      }
      const clears = daysBetween(save.date, injury.expectedReturn) < daysBetween(save.date, bout.date);
      outcome = {
        message: clears
          ? 'The commission doctor expects to clear you in time, subject to the final check in fight week.'
          : 'The commission doctor will not clear you for this date.',
        boutStatus: 'unchanged',
        newBoutDate: null,
        cost,
      };
      break;
    }
    case 'request-postponement': {
      if (!bout) {
        outcome = { message: 'There is no bout to postpone.', boutStatus: 'unchanged', newBoutDate: null, cost };
        break;
      }
      // The promotion agrees when the fighter is worth waiting for and the delay is sane.
      const clearBy = addDays(injury.expectedReturn, 21);
      // The same promotion's cards only: a regional bout is never postponed onto a main card.
      const fromPromotion = save.events[bout.eventId]?.promotionId;
      const candidates = Object.values(save.events)
        .filter((e) => e.status === 'announced' && e.date > clearBy && e.promotionId === fromPromotion)
        .sort((x, y) => (x.date < y.date ? -1 : 1));
      const relationship = fighter.relationships.matchmaker;
      const worthWaiting = fighter.popularity > 30 || (fighter.ranking ?? 99) <= 10 || bout.isTitleFight;
      const agrees = candidates.length > 0 && worthWaiting && rng.chance(clamp(0.35 + relationship / 200 + (bout.isTitleFight ? 0.25 : 0), 0.1, 0.92));
      if (!agrees) {
        outcome = {
          message: 'The promotion will not move the date. The bout stands or you withdraw.',
          boutStatus: 'unchanged',
          newBoutDate: null,
          cost,
        };
        break;
      }
      const target = candidates[0];
      // Fight week tasks belong to the old date and are rebuilt for the new one.
      clearFightWeek(save, bout.id);
      postponeBout(save, bout, target.id, `postponed after ${fighter.name} was injured`);
      resolveMessagesForBout(save, bout.id, `The bout was postponed to ${formatDate(target.date)}.`);
      fighter.relationships.matchmaker = clamp(relationship - 3, 0, 100);
      // The camp was built to peak a week before the old date. Left running, it ended months
      // before the new one and the fighter walked into the rescheduled bout with no preparation.
      const staleCamp = abandonCamps(save, fighter.id);
      outcome = {
        message: `The promotion agrees to move the bout to ${target.name} on ${formatDate(target.date)}, same opponent.${staleCamp ? ' Plan a new camp for the new date.' : ''}`,
        boutStatus: 'postponed',
        newBoutDate: target.date,
        cost,
      };
      break;
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
        outcome = {
          message: choice === 'choose-surgery' ? `Surgery scheduled. Expected return ${formatDate(injury.expectedReturn)}.` : 'Nothing to withdraw from.',
          boutStatus: 'unchanged',
          newBoutDate: null,
          cost,
        };
        break;
      }
      // The opponent stays on the card if a replacement can be found; otherwise the bout
      // is canceled. Either way this fighter's booking is resolved first.
      const opponentId = opponent?.id ?? null;
      releaseBooking(save, fighter.id, bout.id);
      clearFightWeek(save, bout.id);
      let replaced = false;
      if (opponentId) {
        // A title challenger is replaced the way the weekly withdrawal path does it: with time in
        // hand the bout is called off and the title rebooked, and close to the card only somebody
        // who passes the title gate may step in, so the champion is never left in a non-title bout.
        const table = save.rankings[bout.divisionId];
        const challengerOut = isChampionshipBout(bout) && table?.championId !== fighter.id && table?.interimChampionId !== fighter.id;
        const replacement = !challengerOut
          ? findReplacement(save, bout, fighter.id, rng)
          : daysBetween(save.date, bout.date) > TITLE_REBOOK_NOTICE_DAYS
            ? null
            : findTitleReplacement(save, bout, fighter.id);
        if (replacement) {
          replaced = applyReplacement(save, bout, fighter.id, replacement.fighter, replacement.reason);
          // The same as any other withdrawal: whoever steps in gets a camp for the date, or they
          // arrive at the fight having done no preparation at all.
          if (replaced) autoCampFor(save, replacement.fighter, bout.id, bout.date, rng);
        }
      }
      if (!replaced) {
        cancelBout(save, bout, `${fighter.name} withdrew: ${injury.type}`);
      }
      resolveMessagesForBout(save, bout.id, `${fighter.name} withdrew from the bout.`);
      fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker - 8, 0, 100);
      abandonCamps(save, fighter.id);
      outcome = {
        message: replaced
          ? `You are out. ${opponent?.name ?? 'The opponent'} stays on the card against a replacement.`
          : `You are out and the bout has been canceled.`,
        boutStatus: replaced ? 'withdrawn' : 'canceled',
        newBoutDate: null,
        cost,
      };
      break;
    }
    case 'continue-despite-risk': {
      injury.note = `${injury.note} Fighting through it against medical advice.`;
      // Taking a fight hurt is recorded so the fight engine and the wear model both see it.
      fighter.wear.recovery = clamp(fighter.wear.recovery + 6, 0, 100);
      injury.expectedReturn = addDays(injury.expectedReturn, Math.round(rng.range(14, 45)));
      outcome = { message: 'You are taking the fight hurt. The corner has been told.', boutStatus: 'unchanged', newBoutDate: null, cost };
      break;
    }
  }

  // The choice is recorded against the injury so treatment continues automatically and the
  // same question is not asked again next week. It holds the prognosis and the booking as they
  // stand after the choice: a withdrawal released the bout, a postponement moved it, and surgery
  // reset the return date, and a record of the state before any of that read as a development.
  const after = hasLiveBooking(save, fighter);
  if (!save.injuryTreatments) save.injuryTreatments = {};
  save.injuryTreatments[injury.id] = {
    injuryId: injury.id,
    treatment: choice,
    startedOn: save.date,
    expectedReturnAtChoice: injury.expectedReturn,
    severityAtChoice: classifyInjury(injury, after?.date ?? null, save.date),
    lastDevelopmentOn: save.date,
    boutIdAtChoice: after?.id ?? null,
    boutDateAtChoice: after?.date ?? null,
  };
  return outcome;
}

/** Abandons the fighter's live camp, if any. Returns true when one was running or planned. */
function abandonCamps(save: SaveGame, fighterId: string): boolean {
  let any = false;
  for (const camp of Object.values(save.camps)) {
    if (camp.fighterId !== fighterId) continue;
    if (camp.status === 'planned' || camp.status === 'running') {
      camp.status = 'abandoned';
      any = true;
    }
  }
  return any;
}

/**
 * Called from the weekly pass, and straight after anything that can change the player's booking
 * or treatment. Raises a decision for any new player injury that matters.
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
    if (raiseInjuryDecision(save, fighter, injury)) {
      raised++;
      continue;
    }
    // An untreated injury whose first decision lapsed without an answer, typically one raised
    // with no fight booked, has nothing left to ask. If a booking it cannot clear in time has
    // appeared since, that booking is a new question and it gets one.
    const bout = hasLiveBooking(save, fighter);
    if (bout && classifyInjury(injury, bout.date, save.date) === 'requires-withdrawal') {
      if (raiseInjuryDecision(save, fighter, injury, `conflicts-with-${bout.id}-${bout.date}`)) raised++;
    }
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
  // A booked fight the injury cannot clear in time, which the choice was not made against. That
  // covers a fight that came inside the recovery window since, and also a booking that did not
  // exist or has moved since: the old test only compared severities, so a treatment chosen with
  // no fight booked, or against the old date, never asked about the fight that replaced it.
  if (bout && severity === 'requires-withdrawal') {
    const sameBooking =
      treated.boutIdAtChoice === undefined
        ? treated.severityAtChoice === 'requires-withdrawal'
        : treated.boutIdAtChoice === bout.id && treated.boutDateAtChoice === bout.date && treated.severityAtChoice === 'requires-withdrawal';
    if (!sameBooking) return `conflicts-with-${bout.id}-${bout.date}`;
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
  /**
   * The booking the choice was made against, after the choice took effect. Optional because
   * records written before it existed carry none; those fall back to comparing severities.
   */
  boutIdAtChoice?: string | null;
  boutDateAtChoice?: IsoDate | null;
}
