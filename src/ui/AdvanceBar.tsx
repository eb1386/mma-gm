import { useNavigate } from 'react-router-dom';
import { suggestTarget, targetLabel } from '@core/world/advance-target';
import { useCareerStatus, useGame } from './store';

/**
 * The global advancement control.
 *
 * One contextual button whose label, behaviour and destination all come from the career
 * state, plus three explicit duration buttons. Nothing here infers what to do from a route
 * or a label: the action carries its own kind and the store executes it.
 */
export function AdvanceBar() {
  const save = useGame((s) => s.save);
  const busy = useGame((s) => s.busy);
  const operation = useGame((s) => s.operation);
  const advanceTime = useGame((s) => s.advanceTime);
  const advanceToTarget = useGame((s) => s.advanceToTarget);
  const runAction = useGame((s) => s.runAction);
  const status = useCareerStatus();
  const navigate = useNavigate();
  if (!save || !status) return null;

  const blocked = status.advanceBlocked;
  const action = status.action;

  const runDuration = async (days: 1 | 7 | 30) => {
    const result = await advanceTime(days === 1 ? 'day' : days === 7 ? 'week' : 'month');
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

  const primaryLabel = busy
    ? (operation?.label ?? 'Working')
    : (action?.label ?? targetLabel(suggestTarget(save)));

  return (
    <div className="row tight advance-bar">
      <button className={`primary${blocked ? ' urgent' : ''}`} disabled={busy} title={action?.detail ?? 'Move the career forward'} onClick={() => void primaryClick()}>
        {primaryLabel}
      </button>
      <button disabled={busy || blocked} onClick={() => void runDuration(1)} title={blocked ? status.reason : 'Move forward one day'}>
        Advance a Day
      </button>
      <button disabled={busy || blocked} onClick={() => void runDuration(7)} title={blocked ? status.reason : 'Move forward one week'}>
        Advance a Week
      </button>
      <button disabled={busy || blocked} onClick={() => void runDuration(30)} title={blocked ? status.reason : 'Move forward one month'}>
        Advance a Month
      </button>
      {save.player.mode === 'spectator' && (
        <button disabled={busy || blocked} onClick={() => void advanceTime('year').then((r) => r.navigateTo && navigate(r.navigateTo))} title="Move forward a full year">
          Advance a Year
        </button>
      )}
      {blocked && !busy && <span className="blocked-note">{status.reason}</span>}
    </div>
  );
}
