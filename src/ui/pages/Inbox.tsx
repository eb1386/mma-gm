import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rng } from '@core/rng';
import { formatDate } from '@core/types/common';
import type { InboxMessage } from '@core/types/world';
import { actionableMessages, markRead, messageNeedsAction, SENDER_LABEL } from '@core/world/inbox';
import { resolvePlayerDecision } from '@core/world/decisions';
import '@core/world/decision-handlers';
import { useGame } from '../store';
import { Notice, Panel, Tabs } from '../components';

/**
 * The inbox. Every decision the game asks of the player arrives here with explicit
 * choices and a recorded resolution, so a career always has a readable decision log.
 */
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

    // Every category goes through the one transaction. There is no second implementation on this
    // page any more: the switch that used to sit here was unreachable for every category that had
    // a handler, and its Coach Mode branches are now in the core where they actually run.
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
