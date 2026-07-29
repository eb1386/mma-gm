import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rng } from '@core/rng';
import { formatDate } from '@core/types/common';
import type { InboxMessage } from '@core/types/world';
import { actionableMessages, markRead, messageNeedsAction, reconcileInbox, resolveMessage, SENDER_LABEL } from '@core/world/inbox';
import { resolvePlayerDecision } from '@core/world/decisions';
import { syncCareerState } from '@core/world/career';
import '@core/world/decision-handlers';
import { applyInjuryDecision, type InjuryChoiceKey } from '@core/world/injury-flow';
import { moveFighterToGym } from '@core/world/gyms';
import { clamp } from '@core/rng';
import { useGame } from '../store';
import { Notice, Panel, Tabs } from '../components';

/**
 * The inbox. Every decision the game asks of the player arrives here with explicit
 * choices and a recorded resolution, so a career always has a readable decision log.
 */
/** Categories whose consequences run through the registered decision handlers. */
const HANDLED_CATEGORIES = new Set(['injury', 'medical', 'gym', 'career', 'news']);

const INJURY_CHOICE_KEYS: string[] = [
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
];

export function InboxPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const showToast = useGame((s) => s.showToast);
  const { messageId } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'action' | 'all' | 'resolved'>('action');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runOperation = useGame((s) => s.runOperation);
  const busy = useGame((s) => s.busy);

  const selected = messageId ? save.inbox.find((m) => m.id === messageId) ?? null : null;

  const list = save.inbox.filter((m) => {
    if (filter === 'action') return messageNeedsAction(save, m);
    if (filter === 'resolved') return m.status === 'resolved' || m.status === 'expired';
    return true;
  });

  /**
   * Answers a decision.
   *
   * One click disables every choice on the item, applies the consequences once through the
   * transaction, and removes the item from the actionable list immediately. The item is
   * restored and the buttons re-enabled if saving fails.
   */
  const applyChoice = async (message: InboxMessage, choiceKey: string) => {
    // Messages that only open another screen navigate rather than resolving.
    if (choiceKey === 'open-offer' && message.linkedOfferId) {
      navigate(`/offer/${message.linkedOfferId}`);
      return;
    }
    if (choiceKey === 'open-negotiation' && message.linkedOfferId) {
      navigate('/contract');
      return;
    }
    if (pending) return;
    setPending(message.id);
    setError(null);

    // Categories with a registered handler go straight through the transaction.
    if (HANDLED_CATEGORIES.has(message.category)) {
      const outcome = await runOperation('other', 'Saving your response', (report) => {
        report('updating-world', 'Saving your response');
        const rng = new Rng(save.rng);
        const result = resolvePlayerDecision(save, { messageId: message.id, choiceKey }, rng);
        save.rng = rng.getState();
        return {
          ok: result.ok,
          noOpReason: result.alreadyHandled ? result.message : null,
          error: result.error,
          fromDate: save.date,
          toDate: save.date,
          daysAdvanced: 0,
          eventsResolved: [],
          headlines: [result.message],
          stoppedBecause: null,
          navigateTo: null,
          summary: result.message,
        };
      });
      setPending(null);
      if (!outcome.ok) {
        setError(outcome.error ?? 'That response could not be saved.');
        return;
      }
      showToast(outcome.headlines[0] ?? 'Done.', 'good');
      // Move to the next item that needs an answer, or back to the list.
      const remaining = actionableMessages(save);
      navigate(remaining.length > 0 ? `/inbox/${remaining[0].id}` : '/inbox');
      return;
    }

    mutate((s) => {
      const rng = new Rng(s.rng);
      let resolution = 'Acknowledged.';

      // Injury decisions are a transaction on the booking, not a note. They are handled
      // before the generic switch so they can move, cancel or keep the booked bout.
      if (INJURY_CHOICE_KEYS.includes(choiceKey as InjuryChoiceKey) && message.category === 'injury') {
        const me = s.player.fighterId ? s.fighters[s.player.fighterId] : null;
        const injuryId = message.linkedInjuryId ?? message.decisionKey?.replace('injury-decision-', '').split('-')[0] ?? null;
        const injury = me && injuryId ? me.injuries.find((i) => i.id === injuryId) ?? me.injuries[me.injuries.length - 1] : null;
        if (me && injury) {
          const outcome = applyInjuryDecision(s, me, injury, choiceKey as InjuryChoiceKey, rng);
          resolveMessage(s, message.id, choiceKey, outcome.message);
          s.rng = rng.getState();
          return;
        }
      }

      switch (choiceKey) {
        case 'accommodate': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            f.happiness = clamp(f.happiness + 12, 0, 100);
            f.relationships.player = clamp(f.relationships.player + 10, 0, 100);
            // Attention given to one fighter is attention taken from the rest of the room.
            const gym = s.player.gymId ? s.gyms[s.player.gymId] : null;
            for (const other of gym?.fighterIds ?? []) {
              if (other === f.id) continue;
              const o = s.fighters[other];
              if (o) o.happiness = clamp(o.happiness - 2, 0, 100);
            }
            resolution = `Gave ${f.name} dedicated time. The rest of the room noticed.`;
          }
          break;
        }
        case 'decline': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            f.relationships.player = clamp(f.relationships.player - 9, 0, 100);
            f.happiness = clamp(f.happiness - 6, 0, 100);
            resolution = `Told ${f.name} the room comes first.`;
          }
          break;
        }
        case 'reduce-sparring': {
          const gym = s.player.gymId ? s.gyms[s.player.gymId] : null;
          if (gym) {
            gym.hardSparringTendency = clamp(gym.hardSparringTendency - 18, 0, 100);
            gym.safety = clamp(gym.safety + 7, 0, 100);
            for (const id of gym.fighterIds) {
              const o = s.fighters[id];
              if (o) o.happiness = clamp(o.happiness + 5, 0, 100);
            }
            resolution = 'Hard sparring has been cut back across the gym.';
          }
          break;
        }
        case 'hold-line': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            f.relationships.player = clamp(f.relationships.player - 12, 0, 100);
            f.happiness = clamp(f.happiness - 9, 0, 100);
            resolution = 'The sparring policy stands.';
          }
          break;
        }
        case 'rebalance': {
          const gym = s.player.gymId ? s.gyms[s.player.gymId] : null;
          if (gym) {
            for (const id of gym.fighterIds) {
              const o = s.fighters[id];
              if (!o) continue;
              if (o.ranking === null) o.happiness = clamp(o.happiness + 7, 0, 100);
              else o.happiness = clamp(o.happiness - 5, 0, 100);
            }
            gym.culture = clamp(gym.culture + 4, 0, 100);
            resolution = 'Attention has been spread more evenly across the roster.';
          }
          break;
        }
        case 'explain': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) f.relationships.player = clamp(f.relationships.player - 5, 0, 100);
          resolution = 'Explained the position. It was not well received.';
          break;
        }
        case 'change-corner': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            f.relationships.coach = clamp(f.relationships.coach + 18, 0, 100);
            f.happiness = clamp(f.happiness + 7, 0, 100);
            resolution = `${f.name} will have a different corner team.`;
          }
          break;
        }
        case 'refuse': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) f.relationships.player = clamp(f.relationships.player - 10, 0, 100);
          resolution = 'The corner stays as it is.';
          break;
        }
        case 'talk': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            const persuaded = rng.chance(clamp(0.3 + f.relationships.player / 200, 0.2, 0.8));
            if (persuaded) {
              f.happiness = clamp(f.happiness + 16, 0, 100);
              f.relationships.player = clamp(f.relationships.player + 8, 0, 100);
              resolution = `${f.name} has agreed to stay, for now.`;
            } else {
              resolution = `${f.name} listened, but nothing has changed.`;
            }
          }
          break;
        }
        case 'let-go': {
          resolution = 'Left the decision with the fighter.';
          break;
        }
        case 'support': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            f.relationships.player = clamp(f.relationships.player + 8, 0, 100);
            resolution = `Backed the move up in weight.`;
          }
          break;
        }
        case 'advise-against': {
          const f = message.linkedFighterId ? s.fighters[message.linkedFighterId] : null;
          if (f) {
            // The fighter has autonomy and may go ahead regardless.
            const goesAnyway = rng.chance(0.45);
            f.relationships.player = clamp(f.relationships.player - 6, 0, 100);
            resolution = goesAnyway
              ? `${f.name} is moving up regardless of the advice.`
              : `${f.name} has agreed to stay in the division.`;
          }
          break;
        }
        case 'accept-replacement': {
          resolution = 'Accepted the replacement opponent.';
          break;
        }
        case 'decline-replacement': {
          const bout = message.linkedBoutId ? s.bouts[message.linkedBoutId] : null;
          if (bout) {
            bout.status = 'canceled';
            bout.cancelReason = 'The player withdrew after an opponent change.';
            const a = s.fighters[bout.fighterAId];
            const b = s.fighters[bout.fighterBId];
            if (a?.nextBoutId === bout.id) a.nextBoutId = null;
            if (b?.nextBoutId === bout.id) b.nextBoutId = null;
            const ev = s.events[bout.eventId];
            if (ev) ev.boutIds = ev.boutIds.filter((id) => id !== bout.id);
            const self = s.player.fighterId ? s.fighters[s.player.fighterId] : null;
            if (self) self.relationships.matchmaker = clamp(self.relationships.matchmaker - 8, 0, 100);
          }
          resolution = 'Withdrew from the bout after the opponent change.';
          break;
        }
        default:
          resolution = 'Acknowledged.';
      }

      // A fighter leaving is applied immediately when the message is acknowledged.
      if (message.subject.includes('is leaving the gym') && message.linkedFighterId) {
        const f = s.fighters[message.linkedFighterId];
        if (f && s.player.gymId && f.gymId === s.player.gymId) moveFighterToGym(s, f.id, null);
      }

      // Legacy branches above compute a resolution string. The transaction records it,
      // closes the item, reconciles everything that depended on it and recomputes the
      // career state, so the interface updates on this click rather than on a refresh.
      resolveMessage(s, message.id, choiceKey, resolution);
      s.rng = rng.getState();
      // The badge, the career state and the next action all update on this click.
      reconcileInbox(s);
      syncCareerState(s);
      showToast(resolution, 'info');
    });
    setPending(null);
    const remaining = actionableMessages(save);
    navigate(remaining.length > 0 ? `/inbox/${remaining[0].id}` : '/inbox');
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Inbox</h1>
        <span className="sub">
          {save.inbox.filter((m) => m.status === 'unread').length} unread, {save.inbox.filter((m) => messageNeedsAction(save, m)).length} needing a decision
        </span>
      </div>

      <Tabs
        tabs={[
          { key: 'action', label: 'Needs a decision' },
          { key: 'all', label: 'All' },
          { key: 'resolved', label: 'Resolved' },
        ]}
        active={filter}
        onChange={(k) => setFilter(k as typeof filter)}
      />

      <div className="grid c2">
        <Panel title={`Messages (${list.length})`} flush>
          <div className="scroll-y">
            {list.length === 0 && <p className="dim small" style={{ padding: 9 }}>Nothing here.</p>}
            {list.map((m) => (
              <Link
                key={m.id}
                to={`/inbox/${m.id}`}
                className={`inbox-item${m.status === 'unread' ? ' unread' : ''}${m.status === 'resolved' || m.status === 'expired' ? ' resolved' : ''}`}
                onClick={() => mutate((s) => markRead(s, m.id))}
              >
                <div className="subject">{m.subject}</div>
                <div className="meta">
                  <span>{SENDER_LABEL[m.sender]}</span>
                  <span>{formatDate(m.date)}</span>
                  {m.deadline && <span className="warn">reply by {m.deadline}</span>}
                  {m.requiresAction && m.status !== 'resolved' && m.status !== 'expired' && <span className="tag warn">action</span>}
                </div>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel title={selected ? selected.subject : 'Select a message'}>
          {!selected ? (
            <p className="dim small">Choose a message on the left.</p>
          ) : (
            <>
              <p className="small dim">
                {SENDER_LABEL[selected.sender]} · {selected.senderName} · {formatDate(selected.date)}
                {selected.deadline ? ` · reply by ${selected.deadline}` : ''}
              </p>
              <p style={{ whiteSpace: 'pre-wrap' }}>{selected.body}</p>

              {selected.linkedFighterId && save.fighters[selected.linkedFighterId] && (
                <p className="small">
                  Linked fighter: <Link to={`/fighter/${selected.linkedFighterId}`}>{save.fighters[selected.linkedFighterId].name}</Link>
                </p>
              )}
              {selected.linkedEventId && save.events[selected.linkedEventId] && (
                <p className="small">
                  Event: <Link to={`/event/${selected.linkedEventId}`}>{save.events[selected.linkedEventId].name}</Link>
                </p>
              )}

              {error && (
                <div className="notice bad" role="alert">
                  <strong>Your response could not be saved.</strong>
                  <div>{error}</div>
                  <div className="row tight mt">
                    <button onClick={() => setError(null)}>Try again</button>
                    <button onClick={() => { setError(null); navigate('/inbox'); }}>Back to Inbox</button>
                  </div>
                </div>
              )}

              {!messageNeedsAction(save, selected) ? (
                <Notice kind={selected.status === 'expired' ? 'bad' : 'good'}>
                  {selected.resolution ??
                    (selected.requiresAction ? 'This has already been dealt with elsewhere.' : 'No action needed.')}
                </Notice>
              ) : (
                <div className="row mt">
                  {selected.choices.map((c) => (
                    <button
                      key={c.key}
                      className={c.destructive ? 'danger' : c.key === selected.choices[0].key ? 'primary' : ''}
                      title={c.hint}
                      disabled={pending !== null || busy}
                      onClick={() => void applyChoice(selected, c.key)}
                    >
                      {pending === selected.id ? 'Saving your response' : c.label}
                    </button>
                  ))}
                </div>
              )}
              {selected.choices.some((c) => c.hint) && (
                <ul className="small dim mt" style={{ paddingLeft: 16 }}>
                  {selected.choices
                    .filter((c) => c.hint)
                    .map((c) => (
                      <li key={c.key}>
                        <strong>{c.label}:</strong> {c.hint}
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
