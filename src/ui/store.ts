import { create } from 'zustand';
import type { SaveGame } from '@core/types/save';
import type { AdvanceMode, AdvanceReport } from '@core/world/tick';
import { advance } from '@core/world/tick';
import { saveGame } from '@core/save/store';
import { actionRoute, careerStatus, type CareerAction, type CareerStatus } from '@core/world/career';
import { advanceUntil, targetLabel, type AdvancePhase, type AdvanceTarget, type AdvanceUntilResult } from '@core/world/advance-target';

/** Player facing wording for each phase the core reports. */
const PHASE_MAP: Record<AdvancePhase, OperationPhase> = {
  starting: 'advancing',
  'running-camp': 'advancing',
  'simulating-events': 'resolving-event',
  'updating-rankings': 'updating-world',
  'checking-health': 'updating-world',
  'reaching-target': 'advancing',
  complete: 'complete',
};

/**
 * UI state container and the single advancement controller.
 *
 * Every button that moves the world clock goes through `runOperation`. Before this, pages
 * called `advance` themselves, so two controls could start overlapping simulations and a
 * button could finish its work without anything on screen changing. The controller owns
 * the operation, its phase, its result and its failure, and it always yields to the browser
 * before heavy work so the loading state is painted first.
 */

export type OperationKind =
  | 'advance-day'
  | 'advance-week'
  | 'advance-month'
  | 'advance-to-event'
  | 'advance-to-message'
  | 'advance-to-fight'
  | 'advance-weigh-in'
  | 'advance-year'
  | 'advance-recovery'
  | 'simulate-fight'
  | 'resolve-stage'
  | 'advance-target'
  | 'save'
  | 'other';

export type OperationPhase =
  | 'idle'
  | 'validating'
  | 'navigating'
  | 'advancing'
  | 'resolving-event'
  | 'simulating-fight'
  | 'updating-world'
  | 'saving'
  | 'complete'
  | 'canceled'
  | 'failed';

export interface OperationState {
  kind: OperationKind;
  label: string;
  phase: OperationPhase;
  detail: string;
  /** 0 to 1 where known, null where the work is not divisible. */
  progress: number | null;
  startedAt: number;
}

/** What an operation actually did. The interface renders this rather than guessing. */
export interface OperationResult {
  ok: boolean;
  /** Set when the action legitimately changed nothing, explaining why. */
  noOpReason: string | null;
  error: string | null;
  fromDate: string | null;
  toDate: string | null;
  daysAdvanced: number;
  eventsResolved: string[];
  headlines: string[];
  stoppedBecause: string | null;
  /** Where the interface should send the user next. */
  navigateTo: string | null;
  /** One confident sentence for the player. */
  summary: string;
  /** The full structured detail, when the operation was a target advancement. */
  detail?: AdvanceUntilResult;
}

const EMPTY_RESULT: OperationResult = {
  ok: true,
  noOpReason: null,
  error: null,
  fromDate: null,
  toDate: null,
  daysAdvanced: 0,
  eventsResolved: [],
  headlines: [],
  stoppedBecause: null,
  navigateTo: null,
  summary: '',
};

interface GameState {
  save: SaveGame | null;
  revision: number;
  lastReport: AdvanceReport | null;
  lastResult: OperationResult | null;
  operation: OperationState | null;
  /** True while any operation is running. Nothing else may start. */
  busy: boolean;
  toast: { text: string; kind: 'info' | 'good' | 'bad' } | null;

  setSave: (save: SaveGame | null) => void;
  touch: () => void;
  mutate: <T>(fn: (save: SaveGame) => T) => T | undefined;
  /** The one entry point for anything that changes the world. */
  runOperation: (
    kind: OperationKind,
    label: string,
    work: (report: (phase: OperationPhase, detail: string, progress?: number | null) => void) => OperationResult | Promise<OperationResult>
  ) => Promise<OperationResult>;
  advanceTime: (mode: AdvanceMode) => Promise<OperationResult>;
  /** Runs a target advancement inside the core, reporting progress as it goes. */
  advanceToTarget: (target: AdvanceTarget) => Promise<OperationResult>;
  /**
   * The one executor for a career action. Every page calls this rather than deciding for
   * itself whether a button navigates or advances time.
   */
  runAction: (action: CareerAction, navigate: (to: string) => void) => Promise<OperationResult>;
  clearOperation: () => void;
  persist: () => Promise<void>;
  showToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
  status: () => CareerStatus | null;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Writes any pending debounced save immediately.
 *
 * The 700ms debounce means a change made just before the tab closes or the career is swapped was
 * simply lost. This is called on both.
 */
export function flushPendingSave(save: SaveGame | null): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  if (save) void saveGame(save);
}

const MODE_LABEL: Record<AdvanceMode, string> = {
  day: 'Advancing a Day',
  week: 'Advancing a Week',
  month: 'Advancing a Month',
  'next-event': 'Advancing to Next Event',
  'next-message': 'Advancing',
  'to-fight': 'Advancing to Fight Night',
  'weigh-in': 'Advancing to Weigh-In',
  year: 'Advancing a Year',
};

const MODE_KIND: Record<AdvanceMode, OperationKind> = {
  day: 'advance-day',
  week: 'advance-week',
  month: 'advance-month',
  'next-event': 'advance-to-event',
  'next-message': 'advance-to-message',
  'to-fight': 'advance-to-fight',
  'weigh-in': 'advance-weigh-in',
  year: 'advance-year',
};

/** Lets the browser paint before heavy synchronous work begins. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export const useGame = create<GameState>((set, get) => ({
  save: null,
  revision: 0,
  lastReport: null,
  lastResult: null,
  operation: null,
  busy: false,
  toast: null,

  setSave: (save) => (flushPendingSave(get().save), set({ save, revision: get().revision + 1, lastReport: null, lastResult: null, operation: null, busy: false })),

  touch: () => set({ revision: get().revision + 1 }),

  mutate: (fn) => {
    const save = get().save;
    if (!save) return undefined;
    const result = fn(save);
    // A new top level reference is published so that every page selecting `save` re-renders.
    // Bumping only the revision counter left twenty one of the twenty four pages showing stale
    // state after an in page action, because they never read the counter. The copy is shallow, so
    // it costs one object and every nested structure stays shared with the core.
    set({ save: { ...save }, revision: get().revision + 1 });
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const current = get().save;
      if (current) void saveGame(current);
      persistTimer = null;
    }, 700);
    return result;
  },

  runOperation: async (kind, label, work) => {
    const save = get().save;
    if (!save) {
      return { ...EMPTY_RESULT, ok: false, error: 'No career is loaded.' };
    }
    if (get().busy) {
      // Two operations must never run at once. This is what stops the header advance
      // button and a page button from starting the same fight twice.
      const running = get().operation;
      return {
        ...EMPTY_RESULT,
        ok: false,
        noOpReason: `${running?.label ?? 'Another action'} is still running.`,
      };
    }

    set({
      busy: true,
      lastResult: null,
      operation: { kind, label, phase: 'validating', detail: label, progress: null, startedAt: Date.now() },
    });

    const report = (phase: OperationPhase, detail: string, progress: number | null = null) => {
      const current = get().operation;
      if (!current) return;
      set({ operation: { ...current, phase, detail, progress } });
    };

    // Paint the loading state before anything expensive starts.
    await yieldToBrowser();

    let result: OperationResult;
    try {
      result = await work(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        busy: false,
        operation: { kind, label, phase: 'failed', detail: message, progress: null, startedAt: Date.now() },
        lastResult: { ...EMPTY_RESULT, ok: false, error: message },
      });
      return { ...EMPTY_RESULT, ok: false, error: message };
    }

    // The same republish `mutate` does. Bumping only the revision left every page that selects
    // `save` showing the world as it was before the operation, which is most of them.
    set({ save: { ...save }, revision: get().revision + 1, lastResult: result });
    report('saving', 'Saving Career');
    try {
      await saveGame(save);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ busy: false, operation: { kind, label, phase: 'failed', detail: `Saved state could not be written: ${message}`, progress: null, startedAt: Date.now() } });
      return { ...result, ok: false, error: message };
    }

    set({
      busy: false,
      operation: { kind, label, phase: result.ok ? 'complete' : 'failed', detail: result.noOpReason ?? result.error ?? 'Done', progress: 1, startedAt: Date.now() },
    });
    // The completion panel clears itself so it can never stay stuck on screen.
    setTimeout(() => {
      const current = get().operation;
      if (current && (current.phase === 'complete' || current.phase === 'canceled')) set({ operation: null });
    }, 2500);
    return result;
  },

  advanceTime: async (mode) => {
    return get().runOperation(MODE_KIND[mode], MODE_LABEL[mode], (report) => {
      const save = get().save!;
      const before = careerStatus(save);
      if (before.advanceBlocked) {
        return {
          ...EMPTY_RESULT,
          noOpReason: before.action ? `${before.reason} ${before.action.label} first.` : before.reason,
          navigateTo: actionRoute(before.action),
          fromDate: save.date,
          toDate: save.date,
          summary: before.reason,
        };
      }
      report('advancing', `Moving forward from ${save.date}`);
      const from = save.date;
      const advanceReport = advance(save, { mode });
      report('updating-world', 'Updating Rankings');
      set({ lastReport: advanceReport });
      const after = careerStatus(save);
      const noOp =
        advanceReport.daysAdvanced === 0
          ? after.advanceBlocked
            ? after.reason
            : 'Nothing moved. There is no future event scheduled to advance to.'
          : null;
      return {
        ok: true,
        noOpReason: noOp,
        error: null,
        fromDate: from,
        toDate: save.date,
        daysAdvanced: advanceReport.daysAdvanced,
        eventsResolved: advanceReport.eventsResolved,
        headlines: advanceReport.headlines,
        stoppedBecause: advanceReport.stoppedBecause,
        navigateTo: advanceReport.playerBoutPending
          ? `/fight/${advanceReport.playerBoutPending}`
          : after.advanceBlocked
            ? actionRoute(after.action)
            : null,
        summary: `${advanceReport.daysAdvanced} day${advanceReport.daysAdvanced === 1 ? '' : 's'} passed.${after.action ? ` Next: ${after.action.label}.` : ''}`,
      };
    });
  },

  advanceToTarget: async (target) => {
    return get().runOperation('advance-target', targetLabel(target), (report) => {
      const save = get().save!;
      const before = careerStatus(save);
      if (before.advanceBlocked) {
        return {
          ...EMPTY_RESULT,
          noOpReason: before.action ? `${before.reason} ${before.action.label} first.` : before.reason,
          navigateTo: actionRoute(before.action),
          fromDate: save.date,
          toDate: save.date,
          summary: before.reason,
        };
      }
      const outcome = advanceUntil(save, target, {
        onProgress: (phase, detail, fraction) => {
          report(PHASE_MAP[phase], detail, fraction);
        },
      });
      return {
        ok: true,
        noOpReason: outcome.daysAdvanced === 0 ? outcome.stoppedBecause : null,
        error: null,
        fromDate: outcome.fromDate,
        toDate: outcome.toDate,
        daysAdvanced: outcome.daysAdvanced,
        eventsResolved: outcome.eventsResolved,
        headlines: outcome.headlines,
        stoppedBecause: outcome.stoppedBecause,
        navigateTo: outcome.navigateTo,
        summary: outcome.summary,
        detail: outcome,
      };
    });
  },

  runAction: async (action, navigate) => {
    switch (action.kind) {
      case 'navigate':
        navigate(action.route);
        return { ...EMPTY_RESULT, navigateTo: action.route, summary: action.label };
      case 'advance-duration': {
        const mode: AdvanceMode = action.days === 1 ? 'day' : action.days === 7 ? 'week' : 'month';
        const result = await get().advanceTime(mode);
        if (result.navigateTo) navigate(result.navigateTo);
        return result;
      }
      case 'advance-target': {
        const result = await get().advanceToTarget(action.target);
        const destination = result.navigateTo ?? action.route ?? null;
        if (destination) navigate(destination);
        return result;
      }
    }
  },

  clearOperation: () => set({ operation: null }),

  persist: async () => {
    const save = get().save;
    if (save) await saveGame(save);
  },

  showToast: (text, kind = 'info') => {
    set({ toast: { text, kind } });
    setTimeout(() => {
      if (get().toast?.text === text) set({ toast: null });
    }, 4000);
  },

  status: () => {
    const save = get().save;
    return save ? careerStatus(save) : null;
  },
}));

/** Convenience hook that throws a readable error when no save is loaded. */
export function useSave(): SaveGame {
  const save = useGame((s) => s.save);
  if (!save) throw new Error('No save is loaded.');
  return save;
}

/** Recomputes the career status whenever the save revision changes. */
export function useCareerStatus(): CareerStatus | null {
  const save = useGame((s) => s.save);
  const revision = useGame((s) => s.revision);
  void revision;
  return save ? careerStatus(save) : null;
}
