import { Rng } from '../rng';
import type { IsoDate } from '../types/common';
import type { InboxMessage } from '../types/world';
import type { SaveGame } from '../types/save';
import { messageNeedsAction, reconcileInbox } from './inbox';
import { syncCareerState } from './career';

/**
 * The one decision transaction.
 *
 * Every inbox choice goes through `resolvePlayerDecision`. Before this, each page applied
 * its own consequences and then set a status, so a choice could be accepted by the engine
 * while the item stayed actionable until the browser was refreshed, and a double click
 * could apply the consequences twice.
 *
 * The transaction validates, applies once, records identity, reconciles everything that
 * depends on the item, and returns a structured result the interface renders directly.
 */

export type DecisionKind = 'mandatory' | 'optional' | 'passive';

export interface ResolveRequest {
  messageId: string;
  choiceKey: string;
  /** Guards against resolving something that has already moved on. */
  expectedStatus?: 'open';
}

export interface ResolveResult {
  ok: boolean;
  /** True when the decision had already been handled. Not an error. */
  alreadyHandled: boolean;
  message: string;
  /** Concise player facing outcome, stored on the item. */
  resolution: string | null;
  messageId: string;
  choiceKey: string;
  /** How many items still need an answer after this one. */
  remainingActionable: number;
  /** The next item that needs an answer, when there is one. */
  nextMessageId: string | null;
  /** Where the interface should go next. */
  navigateTo: string | null;
  error: string | null;
}

/** Applies the consequences of one choice. Registered per category. */
export type DecisionHandler = (save: SaveGame, message: InboxMessage, choiceKey: string, rng: Rng) => string;

const HANDLERS = new Map<string, DecisionHandler>();

/** Registers a handler for a category. The last registration wins. */
export function registerDecisionHandler(category: string, handler: DecisionHandler): void {
  HANDLERS.set(category, handler);
}

/** Whether an item blocks the calendar, is an opportunity, or is read only. */
export function decisionKind(message: InboxMessage): DecisionKind {
  if (!message.requiresAction) return 'passive';
  if (message.choices.length === 0) return 'passive';
  return message.mandatory === false ? 'optional' : 'mandatory';
}

function failure(request: ResolveRequest, error: string): ResolveResult {
  return {
    ok: false,
    alreadyHandled: false,
    message: error,
    resolution: null,
    messageId: request.messageId,
    choiceKey: request.choiceKey,
    remainingActionable: 0,
    nextMessageId: null,
    navigateTo: null,
    error,
  };
}

/**
 * Resolves one decision, exactly once.
 *
 * Safe to call twice: the second call reports that it was already handled and changes
 * nothing. That is what makes a double click, a stale tab and a retry all harmless.
 */
export function resolvePlayerDecision(save: SaveGame, request: ResolveRequest, rng: Rng): ResolveResult {
  const message = save.inbox.find((m) => m.id === request.messageId);
  if (!message) return failure(request, 'That message no longer exists.');

  // Already handled is a normal outcome, not a failure. `effectsAppliedOn` is the field that
  // records that consequences actually ran, so it is checked here rather than only written.
  if (message.effectsAppliedOn || message.selectedChoiceKey || message.status === 'resolved') {
    const remaining = save.inbox.filter((m) => messageNeedsAction(save, m));
    return {
      ok: true,
      alreadyHandled: true,
      message: 'This decision has already been handled.',
      resolution: message.resolution,
      messageId: message.id,
      choiceKey: message.selectedChoiceKey ?? request.choiceKey,
      remainingActionable: remaining.length,
      nextMessageId: remaining[0]?.id ?? null,
      navigateTo: null,
      error: null,
    };
  }

  if (message.status === 'expired') return failure(request, 'That decision expired before it was answered.');
  if (!messageNeedsAction(save, message)) {
    // The underlying situation moved on. Close it rather than leaving it stuck.
    message.status = 'resolved';
    message.resolution = 'The situation moved on before you answered.';
    message.decisionResolvedOn = save.date;
    reconcileInbox(save);
    syncCareerState(save);
    const remaining = save.inbox.filter((m) => messageNeedsAction(save, m));
    return {
      ok: true,
      alreadyHandled: true,
      message: 'The situation moved on before you answered.',
      resolution: message.resolution,
      messageId: message.id,
      choiceKey: request.choiceKey,
      remainingActionable: remaining.length,
      nextMessageId: remaining[0]?.id ?? null,
      navigateTo: null,
      error: null,
    };
  }

  const choice = message.choices.find((c) => c.key === request.choiceKey);
  if (!choice) return failure(request, 'That is not one of the available choices.');

  // Apply the consequences exactly once.
  let resolution: string;
  try {
    const handler = HANDLERS.get(message.category);
    resolution = handler ? handler(save, message, request.choiceKey, rng) : choice.label;
  } catch (err) {
    return failure(request, err instanceof Error ? err.message : String(err));
  }

  message.selectedChoiceKey = request.choiceKey;
  message.decisionResolvedOn = save.date;
  message.effectsAppliedOn = save.date;
  message.status = 'resolved';
  message.resolution = resolution;

  // Everything that depended on this item is brought up to date now, not next week.
  reconcileInbox(save);
  syncCareerState(save);

  const remaining = save.inbox.filter((m) => messageNeedsAction(save, m));
  const next = remaining[0] ?? null;
  return {
    ok: true,
    alreadyHandled: false,
    message: resolution,
    resolution,
    messageId: message.id,
    choiceKey: request.choiceKey,
    remainingActionable: remaining.length,
    nextMessageId: next?.id ?? null,
    navigateTo: next ? `/inbox/${next.id}` : null,
    error: null,
  };
}

/** Marks a passive item read without treating it as a decision. */
export function acknowledgeMessage(save: SaveGame, messageId: string): boolean {
  const message = save.inbox.find((m) => m.id === messageId);
  if (!message) return false;
  if (message.status === 'unread') message.status = 'read';
  return true;
}

// ---------------------------------------------------------------------------
// Anti repetition
// ---------------------------------------------------------------------------

export interface NotificationGuard {
  /** Stable signature for this kind of notification in this situation. */
  signature: string;
  /** Days before the same signature may appear again. */
  cooldownDays: number;
}

/**
 * Whether a notification with this signature may be created right now.
 *
 * The cooldowns are deliberately long. The inbox was filling with the same sponsor request
 * and the same supplement question every few weeks, which is worse than having no content
 * at all because it teaches the player to stop reading.
 */
export function mayNotify(save: SaveGame, guard: NotificationGuard): boolean {
  const cutoff = daysAgo(save.date, guard.cooldownDays);
  for (const m of save.inbox) {
    if (m.decisionKey !== guard.signature && m.notificationSignature !== guard.signature) continue;
    // An unresolved copy always blocks, whatever the cooldown says.
    if (m.status === 'unread' || m.status === 'read') return false;
    const when = m.decisionResolvedOn ?? m.date;
    if (when >= cutoff) return false;
  }
  return true;
}

function daysAgo(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Standard cooldowns, in days. */
export const COOLDOWNS = {
  socialSameFighterArchetype: 21,
  mediaQuestionTheme: 90,
  gymIssue: 70,
  supplement: 9999,
  sponsorRequest: 120,
  callout: 30,
  injuryBase: 9999,
  weightClassSuggestion: 240,
  complianceRoutine: 120,
} as const;

/**
 * Repairs old saves whose inbox is in a state the current rules would never produce.
 *
 * Returns a count of each repair so a migration can report what it did.
 */
export function repairInbox(save: SaveGame): { resolvedStale: number; deduped: number; fixedIdentity: number } {
  let resolvedStale = 0;
  let deduped = 0;
  let fixedIdentity = 0;

  // A choice was recorded, or consequences ran, but the item never closed. Both fields are
  // checked because the resolution guard accepts either, and a message the guard treats as
  // handled while the inbox still demands an answer is a career that cannot be advanced.
  for (const m of save.inbox) {
    const handled = m.selectedChoiceKey || m.effectsAppliedOn;
    if (handled && m.status !== 'resolved' && m.status !== 'expired') {
      m.status = 'resolved';
      if (!m.decisionResolvedOn) m.decisionResolvedOn = m.date;
      if (!m.resolution) m.resolution = 'Handled.';
      fixedIdentity++;
    }
    if (handled && !m.decisionResolvedOn) {
      m.decisionResolvedOn = m.date;
      fixedIdentity++;
    }
  }

  // Duplicate open decisions with the same identity: keep the newest, close the rest.
  const seen = new Map<string, InboxMessage>();
  for (const m of save.inbox) {
    const key = m.decisionKey ?? m.notificationSignature;
    if (!key) continue;
    if (m.status === 'resolved' || m.status === 'expired') continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, m);
      continue;
    }
    const older = existing.date <= m.date ? existing : m;
    const newer = older === existing ? m : existing;
    older.status = 'resolved';
    older.resolution = 'Superseded by a more recent update.';
    older.decisionResolvedOn = save.date;
    seen.set(key, newer);
    deduped++;
  }

  // Anything whose linked object is gone.
  for (const m of save.inbox) {
    if (m.status === 'resolved' || m.status === 'expired') continue;
    if (!m.requiresAction) continue;
    if (messageNeedsAction(save, m)) continue;
    m.status = 'resolved';
    m.resolution = m.resolution ?? 'No longer relevant.';
    m.decisionResolvedOn = save.date;
    resolvedStale++;
  }

  return { resolvedStale, deduped, fixedIdentity };
}
