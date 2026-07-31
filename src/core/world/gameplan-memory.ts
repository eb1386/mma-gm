import type { BoutId, IsoDate } from '../types/common';
import type { SaveGame } from '../types/save';
import type { GamePlanKey } from '../types/world';

/**
 * Remembered game plans.
 *
 * A planning screen used to reset to `pressure` every time it mounted, so leaving the page
 * and coming back threw away the player's choice. The plan is now stored, scoped to the
 * bout where that matters, and preselected with a clear label saying it was the last one
 * used. It is a default, never a lock: the player can always change it.
 */

export type PlanScope = 'camp' | 'preFight' | 'inFight';

export const DEFAULT_PLAN: GamePlanKey[] = ['pressure'];

function store(save: SaveGame) {
  if (!save.gamePlans) {
    save.gamePlans = { lastGeneral: null, lastGeneralOn: null, byBout: {} };
  }
  if (!save.gamePlans.byBout) save.gamePlans.byBout = {};
  return save.gamePlans;
}

export interface RememberedPlan {
  plans: GamePlanKey[];
  /** True when this came from a stored choice rather than the fallback. */
  remembered: boolean;
  /** Where it came from, for the label the interface shows. */
  source: 'this bout camp' | 'this bout pre fight' | 'the fight in progress' | 'your last game plan' | 'default';
  updatedOn: IsoDate | null;
}

/**
 * The plan a screen should open with.
 *
 * Scopes inherit sensibly: pre fight planning starts from the camp plan for that bout, and
 * between round adjustment starts from the plan currently being used in the fight.
 */
export function recallPlan(save: SaveGame, boutId: BoutId | null, scope: PlanScope): RememberedPlan {
  const s = store(save);
  const forBout = boutId ? s.byBout[boutId] : undefined;

  if (scope === 'camp' && forBout?.camp !== undefined) {
    return { plans: forBout.camp, remembered: true, source: 'this bout camp', updatedOn: forBout.updatedOn };
  }
  if (scope === 'preFight') {
    if (forBout?.preFight !== undefined) {
      return { plans: forBout.preFight, remembered: true, source: 'this bout pre fight', updatedOn: forBout.updatedOn };
    }
    if (forBout?.camp !== undefined) {
      return { plans: forBout.camp, remembered: true, source: 'this bout camp', updatedOn: forBout.updatedOn };
    }
  }
  if (scope === 'inFight') {
    if (forBout?.inFight !== undefined) {
      return { plans: forBout.inFight, remembered: true, source: 'the fight in progress', updatedOn: forBout.updatedOn };
    }
    if (forBout?.preFight !== undefined) {
      return { plans: forBout.preFight, remembered: true, source: 'this bout pre fight', updatedOn: forBout.updatedOn };
    }
    if (forBout?.camp !== undefined) {
      return { plans: forBout.camp, remembered: true, source: 'this bout camp', updatedOn: forBout.updatedOn };
    }
  }
  if (s.lastGeneral?.length) {
    return { plans: s.lastGeneral, remembered: true, source: 'your last game plan', updatedOn: s.lastGeneralOn };
  }
  return { plans: DEFAULT_PLAN, remembered: false, source: 'default', updatedOn: null };
}

/** Stores a chosen plan. Called the moment the player picks one, not only on submit. */
export function rememberPlan(
  save: SaveGame,
  boutId: BoutId | null,
  scope: PlanScope,
  plans: GamePlanKey[],
  opponentId?: string
): void {
  const s = store(save);
  // An empty selection is a decision, not a mistake. Discarding it meant a player who cleared
  // every chip had their previous plan silently restored the next time the screen opened.
  if (plans.length > 0) {
    s.lastGeneral = [...plans];
    s.lastGeneralOn = save.date;
  }
  if (!boutId) return;
  const existing = s.byBout[boutId] ?? { updatedOn: save.date };
  existing[scope] = [...plans];
  existing.updatedOn = save.date;
  if (opponentId) existing.opponentId = opponentId;
  s.byBout[boutId] = existing;
}

/** Drops plans for bouts that are long finished. */
export function pruneGamePlans(save: SaveGame, keep = 40): number {
  const s = store(save);
  const ids = Object.keys(s.byBout);
  if (ids.length <= keep) return 0;
  const sorted = ids.sort((a, b) => (s.byBout[a].updatedOn < s.byBout[b].updatedOn ? -1 : 1));
  const drop = sorted.slice(0, ids.length - keep);
  for (const id of drop) delete s.byBout[id];
  return drop.length;
}

/** A short label for the interface, such as "Last used for this camp". */
export function planSourceLabel(recalled: RememberedPlan): string | null {
  if (!recalled.remembered) return null;
  switch (recalled.source) {
    case 'this bout camp':
      return 'Last Used in this camp';
    case 'this bout pre fight':
      return 'Last Used for this fight';
    case 'the fight in progress':
      return 'Currently in use';
    case 'your last game plan':
      return 'Last Used';
    default:
      return null;
  }
}
