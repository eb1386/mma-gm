import { GAME_PLAN_DESCRIPTION, GAME_PLAN_LABEL } from '@core/sim/plan';
import type { GamePlanKey } from '@core/types/world';

/** The most plans a fighter can take into one fight. */
export const MAX_GAME_PLANS = 3;

/** Every game plan, in the order both pickers list them. */
export const ALL_GAME_PLANS = Object.keys(GAME_PLAN_LABEL) as GamePlanKey[];

/**
 * The game plan chips, shared by the camp and the fight page.
 *
 * Each chip is a real toggle button. They were spans with a click handler, so they could not be
 * reached from the keyboard, a screen reader did not know they were controls, and on a phone they
 * were 22 pixels tall. A plan's meaning lived only in a hover title, which a touch screen never
 * shows, so the chosen plans are described under the group. Once three are chosen the rest are
 * disabled and say why, rather than ignoring the tap.
 */
export function GamePlanPicker({
  plans,
  onChange,
  disabled = false,
}: {
  plans: GamePlanKey[];
  onChange: (next: GamePlanKey[]) => void;
  disabled?: boolean;
}) {
  const full = plans.length >= MAX_GAME_PLANS;
  const toggle = (p: GamePlanKey) => {
    if (plans.includes(p)) onChange(plans.filter((x) => x !== p));
    else if (!full) onChange([...plans, p]);
  };
  return (
    <>
      <div className="plan-chips" role="group" aria-label="Game plan">
        {ALL_GAME_PLANS.map((p) => {
          const on = plans.includes(p);
          return (
            <button
              key={p}
              type="button"
              className={`plan-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              disabled={disabled || (!on && full)}
              title={GAME_PLAN_DESCRIPTION[p]}
              onClick={() => toggle(p)}
            >
              {GAME_PLAN_LABEL[p]}
            </button>
          );
        })}
      </div>
      <p className="small dim plan-count">
        {plans.length} of {MAX_GAME_PLANS} chosen{full ? '. Max three: remove one to pick another.' : '.'}
      </p>
      {plans.length > 0 && (
        <ul className="small dim plan-descriptions">
          {plans.map((p) => (
            <li key={p}>
              <strong>{GAME_PLAN_LABEL[p]}:</strong> {GAME_PLAN_DESCRIPTION[p]}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
