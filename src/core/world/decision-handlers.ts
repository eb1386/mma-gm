import { Rng } from '../rng';
import type { InboxMessage } from '../types/world';
import type { SaveGame } from '../types/save';
import { registerDecisionHandler } from './decisions';
import { applyCampChoice } from './camp-life';
import { applyInjuryDecision, type InjuryChoiceKey } from './injury-flow';
import { acceptSponsor, declineSponsor } from './finance';
import { replyToSocialItem } from './social';
import { acceptSanction, appealSanction } from './antidoping';

/**
 * Consequence handlers, one per inbox category.
 *
 * Registering them here keeps the transaction in `decisions.ts` free of any knowledge about
 * what a particular decision means, and it means every category resolves through the same
 * validated, idempotent path.
 */

const INJURY_CHOICES = new Set<string>([
  'continue-normal',
  'reduce-intensity',
  'train-around',
  'rest',
  'rehabilitate',
  'seek-specialist',
  'request-evaluation',
  'request-postponement',
  'withdraw',
  'continue-despite-risk',
  'choose-surgery',
]);

function player(save: SaveGame) {
  return save.player.fighterId ? save.fighters[save.player.fighterId] : null;
}

registerDecisionHandler('injury', (save, message, choiceKey, rng) => {
  const me = player(save);
  if (!me) return 'Noted.';
  if (!INJURY_CHOICES.has(choiceKey)) return applyCampChoice(save, message.id, choiceKey, rng);
  const injuryId = message.linkedInjuryId;
  const injury = injuryId ? me.injuries.find((i) => i.id === injuryId) : me.injuries[me.injuries.length - 1];
  if (!injury) return 'That injury has already healed.';
  const outcome = applyInjuryDecision(save, me, injury, choiceKey as InjuryChoiceKey, rng);
  return outcome.message;
});

registerDecisionHandler('medical', (save, message, choiceKey, rng) => {
  const me = player(save);
  if (!me) return 'Noted.';
  if (choiceKey === 'doping-appeal') return appealSanction(save, me, rng).message;
  if (choiceKey === 'doping-accept') return acceptSanction(save, me);
  return applyCampChoice(save, message.id, choiceKey, rng);
});

registerDecisionHandler('gym', (save, message, choiceKey, rng) => applyCampChoice(save, message.id, choiceKey, rng));

registerDecisionHandler('career', (save, message, choiceKey, rng) => {
  if (message.linkedSponsorId) return sponsorChoice(save, message, choiceKey);
  if (message.linkedSocialId) {
    const reaction = replyToSocialItem(save, message.linkedSocialId, choiceKey, rng);
    return reaction ?? 'Posted.';
  }
  if (message.linkedCalloutId) return calloutChoice(save, message, choiceKey, rng);
  return applyCampChoice(save, message.id, choiceKey, rng);
});

registerDecisionHandler('news', (save, message, choiceKey, rng) => {
  if (message.linkedSocialId) {
    const reaction = replyToSocialItem(save, message.linkedSocialId, choiceKey, rng);
    return reaction ?? 'Posted.';
  }
  return applyCampChoice(save, message.id, choiceKey, rng);
});

function sponsorChoice(save: SaveGame, message: InboxMessage, choiceKey: string): string {
  const id = message.linkedSponsorId!;
  if (choiceKey === 'sponsor-accept') {
    const signed = acceptSponsor(save, id);
    return signed ? `Signed with ${signed.name}.` : 'That offer is no longer on the table.';
  }
  if (choiceKey === 'sponsor-decline') {
    const declined = declineSponsor(save, id);
    return declined ? `Turned down ${declined.name}.` : 'That offer is no longer on the table.';
  }
  return 'Noted.';
}

function calloutChoice(save: SaveGame, message: InboxMessage, choiceKey: string, rng: Rng): string {
  const callout = save.callouts?.[message.linkedCalloutId!];
  if (!callout) return 'That callout has passed.';
  const other = save.fighters[callout.fromId === save.player.fighterId ? callout.toId : callout.fromId];
  const name = other?.name ?? 'They';
  switch (choiceKey) {
    case 'callout-accept':
      callout.status = 'answered';
      callout.response = 'accept';
      callout.responseText = `You accepted publicly. The pressure is on the matchmaker now.`;
      return `You accepted. ${name} has what they wanted, and the promotion has a decision to make.`;
    case 'callout-reject':
      callout.status = 'answered';
      callout.response = 'reject';
      callout.responseText = 'You turned it down publicly.';
      return `You turned ${name} down in public.`;
    case 'callout-respectful':
      callout.status = 'answered';
      callout.response = 'respectful-answer';
      callout.responseText = 'You answered without taking the bait.';
      return `You gave ${name} a straight answer and left it there.`;
    case 'callout-aggressive':
      callout.status = 'answered';
      callout.response = 'insult';
      callout.responseText = 'You answered in kind.';
      return `You answered ${name} in kind. That clip will run all week.`;
    case 'callout-ignore':
      callout.status = 'answered';
      callout.response = 'silence';
      callout.responseText = 'You said nothing at all.';
      return `You said nothing. ${name} is left talking to himself.`;
    default:
      void rng;
      return 'Noted.';
  }
}
