import { useLocation, useNavigate } from 'react-router-dom';
import type { SaveGame } from '@core/types/save';
import { actionRoute, type CareerAction } from '@core/world/career';
import { suggestTarget, targetLabel } from '@core/world/advance-target';
import { useCareerStatus, useGame } from './store';

/**
 * Everything the advance controls need, shared by the desktop bar and the phone dock so the two
 * can never disagree about what the next step is or whether time may move.
 */
export function useAdvanceControls() {
  const save = useGame((s) => s.save);
  const busy = useGame((s) => s.busy);
  const operation = useGame((s) => s.operation);
  const advanceTime = useGame((s) => s.advanceTime);
  const advanceToTarget = useGame((s) => s.advanceToTarget);
  const runAction = useGame((s) => s.runAction);
  const fightPlayback = useGame((s) => s.fightPlayback);
  const cancelRequested = useGame((s) => s.cancelRequested);
  const requestCancel = useGame((s) => s.requestCancel);
  const status = useCareerStatus();
  const navigate = useNavigate();
  const location = useLocation();
  if (!save || !status) return null;

  const blocked = status.advanceBlocked;
  const action = status.action;

  const runDuration = async (span: 'day' | 'week' | 'month' | 'year') => {
    const result = await advanceTime(span);
    if (result.navigateTo) navigate(result.navigateTo);
  };

  const primaryClick = async () => {
    if (action) {
      await runAction(action, navigate);
      return;
    }
    // No specific action: fall back to the most useful target for the situation.
    const target = suggestTarget(save);
    const result = await advanceToTarget(target);
    if (result.navigateTo) navigate(result.navigateTo);
  };

  // While the player's fight is still being replayed the career state already reflects the
  // result, so its next step ('Advance Until Recovered', 'Review Injury') gave the result away and
  // one tap skipped the fight and moved the calendar. The fight page is the next step until the
  // result is revealed.
  if (fightPlayback) {
    return {
      busy: true,
      blocked: true,
      reason: 'The fight is still in progress.',
      detail: 'The fight is still in progress.',
      primaryLabel: 'Fight in progress',
      primaryClick: async () => {},
      runDuration: async () => {},
      spectator: save.player.mode === 'spectator',
      alreadyThere: true,
      fightInProgress: true,
      cancellable: false,
      cancelRequested: false,
      cancel: () => {},
    };
  }

  const primaryLabel = busy ? (operation?.label ?? 'Working') : (action?.label ?? targetLabel(suggestTarget(save)));
  return {
    busy,
    blocked,
    reason: status.reason,
    detail: action?.detail ?? 'Move the career forward',
    primaryLabel,
    primaryClick,
    runDuration,
    spectator: save.player.mode === 'spectator',
    alreadyThere: actionIsHere(save, status.action, location.pathname),
    fightInProgress: false,
    // A running advance can be stopped at the next day. Nothing else that sets busy can.
    cancellable: busy && Boolean(operation?.kind.startsWith('advance')),
    cancelRequested,
    cancel: requestCancel,
  };
}

/**
 * True when the next step only leads to the page the player is already on. The offer a message
 * opens and the contract a message opens count as the same place as the message itself.
 */
function actionIsHere(save: SaveGame, action: CareerAction | null, path: string): boolean {
  if (!action || action.kind !== 'navigate') return false;
  const route = actionRoute(action)?.split('?')[0] ?? null;
  if (!route) return false;
  if (route === path) return true;
  const inbox = route.match(/^\/inbox\/(.+)$/);
  if (inbox) {
    const message = save.inbox.find((m) => m.id === inbox[1]);
    if (message?.linkedOfferId && path === `/offer/${message.linkedOfferId}`) return true;
    if (message?.category === 'contract' && path === '/contract') return true;
  }
  return false;
}

/**
 * The global advancement control on a wide screen.
 *
 * One contextual button whose label, behaviour and destination all come from the career
 * state, plus explicit duration buttons. Nothing here infers what to do from a route or a
 * label: the action carries its own kind and the store executes it.
 */
export function AdvanceBar() {
  const c = useAdvanceControls();
  if (!c) return null;
  return (
    <div className="row tight advance-bar">
      <button className={`primary${c.blocked ? ' urgent' : ''}`} disabled={c.busy} title={c.detail} onClick={() => void c.primaryClick()}>
        {c.primaryLabel}
      </button>
      <button disabled={c.busy || c.blocked} onClick={() => void c.runDuration('day')} title={c.blocked ? c.reason : 'Move forward one day'}>
        Advance a Day
      </button>
      <button disabled={c.busy || c.blocked} onClick={() => void c.runDuration('week')} title={c.blocked ? c.reason : 'Move forward one week'}>
        Advance a Week
      </button>
      <button disabled={c.busy || c.blocked} onClick={() => void c.runDuration('month')} title={c.blocked ? c.reason : 'Move forward one month'}>
        Advance a Month
      </button>
      {c.spectator && (
        <button disabled={c.busy || c.blocked} onClick={() => void c.runDuration('year')} title="Move forward a full year">
          Advance a Year
        </button>
      )}
      {c.cancellable && (
        <button className="op-cancel" disabled={c.cancelRequested} onClick={c.cancel}>
          {c.cancelRequested ? 'Stopping' : 'Cancel'}
        </button>
      )}
      {c.blocked && !c.busy && !c.fightInProgress && <span className="blocked-note">{c.reason}</span>}
    </div>
  );
}
