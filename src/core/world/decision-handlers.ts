import { Rng } from '../rng';
import type { InboxMessage } from '../types/world';
import type { SaveGame } from '../types/save';
import { registerDecisionHandler } from './decisions';
import { applyCampChoice } from './camp-life';
import { applyRoomChoice } from './room-decisions';
import { applyInjuryDecision, type InjuryChoiceKey } from './injury-flow';
import { acceptSponsor, declineSponsor } from './finance';
import { replyToSocialItem } from './social';
import { acceptSanction, appealSanction } from './antidoping';
import { applyCalloutResponse, type CalloutResponse } from './relationships';

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

registerDecisionHandler('gym', (save, message, choiceKey, rng) => {
  // Room management first. These are the decisions a coach answers, and they have to run before
  // the camp life fallback, which returns immediately when the player manages no fighter of their
  // own, which in Coach Mode is always.
  const room = applyRoomChoice(save, message, choiceKey, rng);
  if (room !== null) return room;
  return applyCampChoice(save, message.id, choiceKey, rng);
});

registerDecisionHandler('career', (save, message, choiceKey, rng) => {
  if (message.linkedSponsorId) return sponsorChoice(save, message, choiceKey);
  if (message.linkedSocialId) {
    const reaction = replyToSocialItem(save, message.linkedSocialId, choiceKey, rng);
    return reaction ?? 'Posted.';
  }
  if (message.linkedCalloutId) return calloutChoice(save, message, choiceKey, rng);
  const room = applyRoomChoice(save, message, choiceKey, rng);
  if (room !== null) return room;
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
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const name = other?.name ?? 'They';

  // The answer the player gives, and the sentence they are shown for giving it. The consequences
  // themselves are applied by the same function the promotion uses when an opponent answers, so
  // that answering a callout means the same thing whichever side of it the player is on. This
  // used to set the label and return the sentence and do nothing else at all.
  const ANSWERS: Record<string, { response: CalloutResponse; said: string; reply: string }> = {
    'callout-accept': {
      response: 'accept',
      said: 'You accepted publicly. The pressure is on the matchmaker now.',
      reply: `You accepted. ${name} has what they wanted, and the promotion has a decision to make.`,
    },
    'callout-reject': {
      response: 'reject',
      said: 'You turned it down publicly.',
      reply: `You turned ${name} down in public.`,
    },
    'callout-respectful': {
      response: 'respectful-answer',
      said: 'You answered without taking the bait.',
      reply: `You gave ${name} a straight answer and left it there.`,
    },
    'callout-aggressive': {
      response: 'insult',
      said: 'You answered in kind.',
      reply: `You answered ${name} in kind. That clip will run all week.`,
    },
    'callout-ignore': {
      response: 'silence',
      said: 'You said nothing at all.',
      reply: `You said nothing. ${name} is left talking to themselves.`,
    },
  };

  const answer = ANSWERS[choiceKey];
  if (!answer) {
    void rng;
    return 'Noted.';
  }
  callout.responseText = answer.said;
  applyCalloutResponse(save, callout, answer.response, other?.name ?? 'They', me?.name ?? 'They');
  return answer.reply;
}

// Offers, contracts and ranking notices are answered on their own pages, but the inbox can also
// carry a decision for them, and the replacement opponent choice is one. Without a handler the
// transaction recorded the label and applied nothing, which is how accepting or declining a
// replacement came to do the same thing.
for (const category of ['offer', 'contract', 'ranking'] as const) {
  registerDecisionHandler(category, (save, message, choiceKey, rng) => {
    const room = applyRoomChoice(save, message, choiceKey, rng);
    if (room !== null) return room;
    return message.choices.find((c) => c.key === choiceKey)?.label ?? 'Noted.';
  });
}
