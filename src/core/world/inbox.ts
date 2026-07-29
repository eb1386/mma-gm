import type { InboxChoice, InboxMessage, MessageSender } from '../types/world';
import type { SaveGame } from '../types/save';
import type { IsoDate } from '../types/common';

/**
 * The inbox is the single decision surface. Anything that needs the player produces a
 * message with explicit choices, a deadline where one applies, and a recorded resolution.
 */

export interface NewMessage {
  sender: MessageSender;
  senderName: string;
  subject: string;
  body: string;
  category: InboxMessage['category'];
  requiresAction: boolean;
  choices: InboxChoice[];
  deadline?: IsoDate | null;
  linkedFighterId?: string | null;
  linkedEventId?: string | null;
  linkedBoutId?: string | null;
  linkedContractId?: string | null;
  linkedOfferId?: string | null;
}

export function addInboxMessage(save: SaveGame, msg: NewMessage): InboxMessage {
  const message: InboxMessage = {
    id: `msg-${++save.counters.message}`,
    date: save.date,
    sender: msg.sender,
    senderName: msg.senderName,
    subject: msg.subject,
    body: msg.body,
    requiresAction: msg.requiresAction,
    deadline: msg.deadline ?? null,
    choices: msg.choices,
    linkedFighterId: msg.linkedFighterId ?? null,
    linkedEventId: msg.linkedEventId ?? null,
    linkedBoutId: msg.linkedBoutId ?? null,
    linkedContractId: msg.linkedContractId ?? null,
    linkedOfferId: msg.linkedOfferId ?? null,
    status: 'unread',
    resolution: null,
    category: msg.category,
  };
  save.inbox.unshift(message);
  if (save.inbox.length > 3000) save.inbox.length = 3000;
  return message;
}

export function markRead(save: SaveGame, messageId: string): void {
  const m = save.inbox.find((x) => x.id === messageId);
  if (m && m.status === 'unread' && !m.requiresAction) m.status = 'read';
}

export function resolveMessage(save: SaveGame, messageId: string, choiceKey: string, resolution: string): void {
  const m = save.inbox.find((x) => x.id === messageId);
  if (!m) return;
  m.status = 'resolved';
  m.resolution = resolution;
  void choiceKey;
  if (save.pendingDecision?.messageId === messageId) save.pendingDecision = null;
}

/**
 * Closes out every message tied to an offer once that offer is no longer open.
 *
 * Without this the advance control keeps demanding an answer for a fight the player has
 * already accepted, because the message that carried the offer is still marked as needing
 * action even though the decision was taken on the offer screen.
 */
export function resolveMessagesForOffer(save: SaveGame, offerId: string, resolution: string): number {
  let closed = 0;
  for (const m of save.inbox) {
    if (m.linkedOfferId !== offerId) continue;
    if (m.status === 'resolved' || m.status === 'expired') continue;
    m.status = 'resolved';
    m.resolution = resolution;
    closed++;
    if (save.pendingDecision?.messageId === m.id) save.pendingDecision = null;
  }
  return closed;
}

/** Closes out every message tied to a bout, used when a bout is canceled or contested. */
export function resolveMessagesForBout(save: SaveGame, boutId: string, resolution: string): number {
  let closed = 0;
  for (const m of save.inbox) {
    if (m.linkedBoutId !== boutId) continue;
    if (m.status === 'resolved' || m.status === 'expired') continue;
    m.status = 'resolved';
    m.resolution = resolution;
    closed++;
  }
  return closed;
}

/**
 * A message only counts as needing an answer when the thing it points at is still open.
 * This is the single source of truth for the inbox badge and the advance control, so the
 * two can never disagree.
 */
export function messageNeedsAction(save: SaveGame, m: InboxMessage): boolean {
  if (!m.requiresAction) return false;
  if (m.status === 'resolved' || m.status === 'expired') return false;
  // A deadline that has passed cannot be answered, whatever the status field says.
  if (m.deadline && m.deadline < save.date) return false;

  // The item is only real when the thing it points at is still real and still open.
  if (m.linkedOfferId) {
    const fightOffer = save.fightOffers[m.linkedOfferId];
    if (fightOffer) return fightOffer.status === 'open';
    const contractOffer = save.contractOffers[m.linkedOfferId];
    if (contractOffer) return contractOffer.status === 'open';
    return false;
  }
  if (m.linkedInjuryId) {
    const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
    const injury = me?.injuries.find((i) => i.id === m.linkedInjuryId);
    // A healed injury, or one whose treatment is already chosen, needs nothing.
    if (!injury || injury.actualReturn !== null) return false;
    // A base decision for this injury is closed once a treatment has been chosen. A
    // development decision carries a suffix and is judged on its own.
    const treated = save.injuryTreatments?.[m.linkedInjuryId];
    const isBaseDecision = m.decisionKey === `injury-decision-${m.linkedInjuryId}`;
    if (treated && isBaseDecision) return false;
  }
  if (m.linkedSponsorId) {
    const sponsor = save.sponsors?.[m.linkedSponsorId];
    if (!sponsor || sponsor.status !== 'offered') return false;
  }
  if (m.linkedSocialId) {
    const item = save.socialFeed?.[m.linkedSocialId];
    if (!item || item.resolvedOn !== null || item.expiresOn < save.date) return false;
  }
  if (m.linkedCalloutId) {
    const callout = save.callouts?.[m.linkedCalloutId];
    if (!callout || callout.status !== 'open') return false;
  }
  if (m.linkedStageId) {
    const task = save.fightWeek?.[m.linkedStageId];
    if (!task || task.status === 'complete' || task.status === 'skipped') return false;
  }
  if (m.linkedBoutId) {
    const bout = save.bouts[m.linkedBoutId];
    if (!bout || bout.status !== 'scheduled') return false;
  }
  if (m.linkedContractId) {
    const contract = save.contracts[m.linkedContractId];
    if (!contract) return false;
  }
  // A message about a fighter who no longer exists is dead.
  if (m.linkedFighterId && !save.fighters[m.linkedFighterId]) return false;
  return true;
}

/**
 * Resolves every message whose underlying action has already been dealt with elsewhere.
 *
 * Called whenever the world changes, so the badge is right immediately rather than after
 * the next weekly tick. Returns how many were closed.
 */
export function reconcileInbox(save: SaveGame): number {
  let closed = 0;
  for (const m of save.inbox) {
    if (m.status === 'resolved' || m.status === 'expired') continue;
    if (!m.requiresAction) continue;
    if (messageNeedsAction(save, m)) continue;
    m.status = 'resolved';
    m.resolution = m.resolution ?? 'Handled elsewhere.';
    m.decisionResolvedOn = save.date;
    closed++;
  }
  return closed;
}

export function expireMessages(save: SaveGame): string[] {
  const expired: string[] = [];
  for (const m of save.inbox) {
    if (m.status !== 'unread' && m.status !== 'read') continue;
    if (m.deadline && m.deadline < save.date) {
      m.status = 'expired';
      m.resolution = 'No answer was given before the deadline.';
      expired.push(m.id);
    }
  }
  return expired;
}

export function unreadCount(save: SaveGame): number {
  return save.inbox.filter((m) => m.status === 'unread').length;
}

export function actionableMessages(save: SaveGame): InboxMessage[] {
  return save.inbox.filter((m) => messageNeedsAction(save, m));
}

export const SENDER_LABEL: Record<MessageSender, string> = {
  matchmaker: 'Matchmaker',
  manager: 'Manager',
  'head-coach': 'Head coach',
  'gym-owner': 'Gym',
  'specialist-coach': 'Specialist coach',
  doctor: 'Doctor',
  commission: 'Athletic commission',
  'replacement-coordinator': 'Matchmaking',
  fighter: 'Fighter',
  media: 'Media',
  'contract-rep': 'Contracts',
  system: 'System',
};
