import { create } from 'zustand';
import type { SaveGame } from '@core/types/save';
import type { AdvanceMode, AdvanceReport } from '@core/world/tick';
import { advanceSteps, STOPPED_AT_REQUEST } from '@core/world/tick';
import { deleteSave, saveGame } from '@core/save/store';
import { addDays, daysBetween, formatDate, type IsoDate } from '@core/types/common';
import { FIGHT_WEEK_DAYS } from '@core/world/availability';
import { actionRoute, careerStatus, type CareerAction, type CareerStatus } from '@core/world/career';
import { advanceUntilSteps, targetLabel, type AdvancePhase, type AdvanceTarget, type AdvanceUntilResult } from '@core/world/advance-target';
import { removeMirroredSave } from './native';

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
  /**
   * Set by the Cancel button. The running advance checks it after every simulated day and stops
   * there, so the world is left as a shorter advance would have left it.
   */
  cancelRequested: boolean;
  requestCancel: () => void;
  /**
   * Why the last background write failed, until a write succeeds. An autosave that failed used to
   * say nothing at all, so a player could play on for an hour with nothing being kept.
   */
  saveError: string | null;
  /** The id tells two toasts with the same words apart, so an older timer never clears a newer one. */
  toast: { id: number; text: string; kind: 'info' | 'good' | 'bad' } | null;
  /**
   * The bout whose result is being replayed on the fight page, until the result is revealed.
   *
   * The result is in the save before playback starts, so everything outside the page (the header
   * state, the next step button, the inbox badge) already reflects it. While this is set they hold
   * the pre fight view, and the next step cannot move time out from under the fight. Never saved.
   */
  fightPlayback: string | null;
  setFightPlayback: (boutId: string | null) => void;

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
  /** Removes the last result, and with it a no-op notice the player has read. */
  clearResult: () => void;
  persist: () => Promise<void>;
  showToast: (text: string, kind?: 'info' | 'good' | 'bad') => void;
  /** Clears the toast with this id, or any toast when no id is given. */
  dismissToast: (id?: number) => void;
  status: () => CareerStatus | null;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let toastCounter = 0;

/**
 * True while an advance is moving the world in slices.
 *
 * The long advances hand the main thread back to the browser between days so the page can paint
 * and the Cancel button can be pressed. That also lets other controls run in the gaps, and a change
 * made to a world half way through a day loop would interleave with it. Changes are refused for
 * the length of the advance instead; it can be cancelled at any day.
 */
let worldInMotion = false;

/** The last autosave failure toasted, and when, so a full disk does not toast on every change. */
let lastSaveErrorToast: { message: string; at: number } | null = null;
const SAVE_ERROR_TOAST_GAP_MS = 60_000;

function reportSaveError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // The store is declared below. This only runs after a write has failed, long after it exists.
  const state = useGame.getState();
  if (state.saveError !== message) useGame.setState({ saveError: message });
  const now = Date.now();
  if (lastSaveErrorToast && lastSaveErrorToast.message === message && now - lastSaveErrorToast.at < SAVE_ERROR_TOAST_GAP_MS) return;
  lastSaveErrorToast = { message, at: now };
  state.showToast(`Autosave failed: ${message}. Export your career from Settings.`, 'bad');
}

function clearSaveError(): void {
  lastSaveErrorToast = null;
  if (useGame.getState().saveError !== null) useGame.setState({ saveError: null });
}

/**
 * Careers that have been deleted in this session.
 *
 * Any write naming one of these is dropped. Cancelling the debounce is not enough on its own,
 * because an operation that is still finishing will queue its own write afterwards and put the
 * deleted career back.
 */
const deletedSaveIds = new Set<string>();

/**
 * The background write. It never throws, because nothing awaits it: a failure is reported to the
 * player instead of becoming an unhandled rejection nobody sees.
 */
function persistUnlessDeleted(save: SaveGame | null): Promise<void> {
  if (!save || deletedSaveIds.has(save.saveId)) return Promise.resolve();
  return saveGame(save).then(clearSaveError, reportSaveError);
}

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
  void persistUnlessDeleted(save);
}

/**
 * Throws away a queued write without performing it.
 *
 * Deleting a career removes the record and then clears the loaded save, and clearing the loaded
 * save flushes whatever write was still queued for it, which wrote the deleted career straight
 * back. The queued write has to be dropped before the record is removed.
 */
export function discardPendingSave(saveId?: string): void {
  if (saveId) deletedSaveIds.add(saveId);
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

/**
 * Deletes a career everywhere it is kept: the queued write, the stored record and its index entry,
 * the iPhone app's backup file, and the loaded career if it is this one. The landing screen and the
 * save list both delete through here, so neither can miss a step.
 */
export async function deleteCareer(saveId: string): Promise<void> {
  // Dropped before the record goes, because clearing the loaded save flushes any queued write and
  // that write would put the deleted career straight back.
  discardPendingSave(saveId);
  await deleteSave(saveId);
  await removeMirroredSave(saveId);
  if (useGame.getState().save?.saveId === saveId) useGame.getState().setSave(null);
}

/**
 * Hands the main thread back to the browser for a moment, so a long loop can let the page paint
 * and take a tap. A message task rather than an animation frame: frames stop in a hidden tab, and
 * an advance left running in one would stall until the player came back.
 */
function yieldTask(): Promise<void> {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** How long a slice of simulation runs before the browser gets the thread back. */
const SLICE_MS = 30;

/**
 * Runs a stepped advance to the end, giving the browser the thread every slice.
 *
 * `onSlice` is called with the date reached before each hand over, which is where progress is
 * reported. The steps are the same ones the synchronous advance drains, so the world ends in the
 * same state either way.
 */
export async function driveSteps<T>(steps: Generator<IsoDate, T, void>, onSlice?: (date: IsoDate) => void): Promise<T> {
  let sliceStart = Date.now();
  let step = steps.next();
  while (!step.done) {
    if (Date.now() - sliceStart >= SLICE_MS) {
      onSlice?.(step.value);
      await yieldTask();
      sliceStart = Date.now();
    }
    step = steps.next();
  }
  return step.value;
}

/** Fraction of the way from one date to another, for a progress bar that only moves forward. */
function fractionBetween(from: IsoDate, to: IsoDate | null, now: IsoDate): number | null {
  if (!to) return null;
  const span = daysBetween(from, to);
  if (span <= 0) return null;
  return Math.max(0, Math.min(0.99, daysBetween(from, now) / span));
}

/** The furthest a fixed span can go. The open ended modes have no end date to measure against. */
const SPAN_DAYS: Partial<Record<AdvanceMode, number>> = { day: 1, week: 7, month: 31, year: 366 };

/** Where a target advance will end at the latest, when that is known from the save. */
function targetEndDate(save: SaveGame, target: AdvanceTarget): IsoDate | null {
  switch (target.kind) {
    case 'duration':
      return addDays(save.date, target.days);
    case 'date':
      return target.date;
    case 'fight-week': {
      const bout = save.bouts[target.boutId];
      return bout ? addDays(bout.date, -FIGHT_WEEK_DAYS) : null;
    }
    case 'fight-day':
    case 'media-day':
    case 'press-conference':
    case 'official-weigh-in':
      return save.bouts[target.boutId]?.date ?? null;
    default:
      return null;
  }
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
  cancelRequested: false,
  saveError: null,
  toast: null,
  fightPlayback: null,
  setFightPlayback: (boutId) => {
    if (get().fightPlayback !== boutId) set({ fightPlayback: boutId });
  },

  // Loading another save also ends any playback, so a fight left mid replay cannot hold the dock.
  setSave: (save) => (flushPendingSave(get().save), set({ save, revision: get().revision + 1, lastReport: null, lastResult: null, operation: null, busy: false, fightPlayback: null })),

  touch: () => set({ revision: get().revision + 1 }),

  requestCancel: () => {
    if (get().busy && !get().cancelRequested) set({ cancelRequested: true });
  },

  mutate: (fn) => {
    const save = get().save;
    if (!save) return undefined;
    if (worldInMotion) {
      get().showToast(`Wait for ${get().operation?.label ?? 'the advance'} to finish, or cancel it.`, 'info');
      return undefined;
    }
    const result = fn(save);
    // A new top level reference is published so that every page selecting `save` re-renders.
    // Bumping only the revision counter left twenty one of the twenty four pages showing stale
    // state after an in page action, because they never read the counter. The copy is shallow, so
    // it costs one object and every nested structure stays shared with the core.
    // A no-op notice explains why an earlier action changed nothing. Once the player changes the
    // world it may no longer be true (the camp they were told is running has been abandoned), so it
    // goes with the change rather than following them to every page.
    set({ save: { ...save }, revision: get().revision + 1, lastResult: null });
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistUnlessDeleted(get().save);
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
      cancelRequested: false,
      lastResult: null,
      operation: { kind, label, phase: 'validating', detail: label, progress: null, startedAt: Date.now() },
    });
    // A change made on the page just before this is still waiting for its debounced write. The
    // operation writes the whole save when it ends, which includes that change, so the queued write
    // is taken over rather than left to fire mid operation (writing a half advanced world) or just
    // after (writing the same world a second time). If the operation fails, it is put back.
    const tookPendingWrite = persistTimer !== null;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }

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
      worldInMotion = false;
      const message = err instanceof Error ? err.message : String(err);
      if (tookPendingWrite) {
        persistTimer = setTimeout(() => {
          persistTimer = null;
          void persistUnlessDeleted(get().save);
        }, 700);
      }
      set({
        busy: false,
        cancelRequested: false,
        operation: { kind, label, phase: 'failed', detail: message, progress: null, startedAt: Date.now() },
        lastResult: { ...EMPTY_RESULT, ok: false, error: message },
        // The work may have mutated the save before throwing, so it is republished on the failure
        // path too. Leaving it unpublished showed the player a world that no longer matched the
        // one they were playing.
        save: { ...save },
        revision: get().revision + 1,
      });
      return { ...EMPTY_RESULT, ok: false, error: message };
    }

    // The same republish `mutate` does. Bumping only the revision left every page that selects
    // `save` showing the world as it was before the operation, which is most of them.
    set({ save: { ...save }, revision: get().revision + 1, lastResult: result });
    // The dashboard's recap keeps the stretch of time it describes, but its stop reason ("A
    // decision needs an answer in the inbox.") is about the moment time stopped. An action that
    // does not move the clock, such as answering that decision or fighting that bout, is the
    // player dealing with it, so the reason goes and the headlines stay.
    const recap = get().lastReport;
    if (!kind.startsWith('advance') && result.ok && !result.noOpReason && recap?.stoppedBecause) {
      set({ lastReport: { ...recap, stoppedBecause: null } });
    }
    report('saving', 'Saving Career');
    try {
      // A career deleted while this was running stays deleted. Writing it here put it back.
      if (!deletedSaveIds.has(save.saveId)) {
        await saveGame(save);
        clearSaveError();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ busy: false, cancelRequested: false, saveError: message, operation: { kind, label, phase: 'failed', detail: `Saved state could not be written: ${message}`, progress: null, startedAt: Date.now() } });
      return { ...result, ok: false, error: message };
    }

    const canceled = result.stoppedBecause === STOPPED_AT_REQUEST;
    set({
      busy: false,
      cancelRequested: false,
      operation: {
        kind,
        label,
        phase: canceled ? 'canceled' : result.ok ? 'complete' : 'failed',
        detail: canceled ? result.summary || STOPPED_AT_REQUEST : (result.noOpReason ?? result.error ?? 'Done'),
        progress: canceled ? null : 1,
        startedAt: Date.now(),
      },
    });
    // The completion panel clears itself so it can never stay stuck on screen.
    setTimeout(() => {
      const current = get().operation;
      if (current && (current.phase === 'complete' || current.phase === 'canceled')) set({ operation: null });
    }, 2500);
    // A no-op notice used to stay on every page until some other operation ran. It is given long
    // enough to read and then goes, unless a newer result has already replaced it.
    if (result.noOpReason) {
      setTimeout(() => {
        if (get().lastResult === result) set({ lastResult: null });
      }, 6000);
    }
    return result;
  },

  advanceTime: async (mode) => {
    return get().runOperation(MODE_KIND[mode], MODE_LABEL[mode], async (report) => {
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
      report('advancing', `Moving forward from ${formatDate(save.date)}`);
      const from = save.date;
      const span = SPAN_DAYS[mode];
      const end = span ? addDays(from, span) : null;
      worldInMotion = true;
      let advanceReport: AdvanceReport;
      try {
        advanceReport = await driveSteps(
          advanceSteps(save, { mode }, () => get().cancelRequested),
          (date) => report('advancing', `Simulating ${formatDate(date)}`, fractionBetween(from, end, date))
        );
      } finally {
        worldInMotion = false;
      }
      const canceled = advanceReport.stoppedBecause === STOPPED_AT_REQUEST;
      report('updating-world', 'Updating Rankings');
      set({ lastReport: advanceReport });
      const after = careerStatus(save);
      const noOp =
        canceled
          ? null
          : advanceReport.daysAdvanced === 0
            ? after.advanceBlocked
              ? after.reason
              : 'Nothing moved. There is no future event scheduled to advance to.'
            : null;
      const passed = `${advanceReport.daysAdvanced} day${advanceReport.daysAdvanced === 1 ? '' : 's'} passed.`;
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
        // A bout on the night comes first, then the inbox. Stopping because something arrived and
        // then leaving the player wherever they were is how a message goes unread and the clock
        // appears to be stuck for no reason.
        // Fight week sits between them: the clock stopped because it began or because the official
        // weigh in came due, and the place to be is that fight week.
        // A cancelled advance goes nowhere: the player stopped it to stay where they are.
        navigateTo: canceled
          ? null
          : advanceReport.playerBoutPending
            ? `/fight/${advanceReport.playerBoutPending}`
            : advanceReport.fightWeekBoutId
              ? `/fightweek/${advanceReport.fightWeekBoutId}`
              : advanceReport.inboxWaiting
                ? '/inbox'
                : after.advanceBlocked
                  ? actionRoute(after.action)
                  : null,
        summary: canceled ? `${STOPPED_AT_REQUEST} ${passed}` : `${passed}${after.action ? ` Next: ${after.action.label}.` : ''}`,
      };
    });
  },

  advanceToTarget: async (target) => {
    return get().runOperation('advance-target', targetLabel(target), async (report) => {
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
      const from = save.date;
      const end = targetEndDate(save, target);
      // The core names what it is doing (a camp week, the card being simulated), and that is shown
      // for the slice it happened in; otherwise the date being simulated is. The bar is measured by
      // date wherever the end date is known, because the day ceiling (up to nine hundred days)
      // barely moved for a short advance.
      let named: { phase: OperationPhase; detail: string } | null = null;
      worldInMotion = true;
      let outcome: AdvanceUntilResult;
      try {
        outcome = await driveSteps(
          advanceUntilSteps(save, target, {
            onProgress: (p, d) => {
              if (p === 'running-camp' || p === 'simulating-events') named = { phase: PHASE_MAP[p], detail: d };
            },
            shouldCancel: () => get().cancelRequested,
          }),
          (date) => {
            const fraction = fractionBetween(from, end, date);
            if (named) report(named.phase, named.detail, fraction);
            else report('advancing', `Simulating ${formatDate(date)}`, fraction);
            named = null;
          }
        );
      } finally {
        worldInMotion = false;
      }
      const canceled = outcome.stoppedBecause === STOPPED_AT_REQUEST;
      // The dashboard's "Since" recap reads lastReport. Only the fixed span advances wrote it, so
      // after the main button (which is nearly always a target advance) the recap described an
      // older stretch with none of the new results in it. A move of zero days leaves the last
      // recap alone, as a fixed span advance of zero days would have nothing to show.
      if (outcome.daysAdvanced > 0) {
        set({
          lastReport: {
            from: outcome.fromDate,
            to: outcome.toDate,
            daysAdvanced: outcome.daysAdvanced,
            eventsResolved: outcome.eventsResolved,
            headlines: outcome.headlines,
            stoppedBecause: outcome.stoppedBecause,
            playerBoutPending: null,
            inboxWaiting: outcome.inboxCreated > 0,
          },
        });
      }
      return {
        ok: true,
        noOpReason: outcome.daysAdvanced === 0 && !canceled ? outcome.stoppedBecause : null,
        error: null,
        fromDate: outcome.fromDate,
        toDate: outcome.toDate,
        daysAdvanced: outcome.daysAdvanced,
        eventsResolved: outcome.eventsResolved,
        headlines: outcome.headlines,
        stoppedBecause: outcome.stoppedBecause,
        // A mandatory step reached on the way still takes the player to it; otherwise a cancelled
        // advance stays where the player is.
        navigateTo: canceled && !outcome.mandatoryAction ? null : outcome.navigateTo,
        summary: canceled ? `${STOPPED_AT_REQUEST} ${outcome.summary}` : outcome.summary,
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

  clearResult: () => set({ lastResult: null }),

  // An explicit write covers any queued one, so the queued one is dropped rather than repeated.
  persist: async () => {
    const save = get().save;
    if (!save) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await saveGame(save);
    clearSaveError();
  },

  showToast: (text, kind = 'info') => {
    const id = ++toastCounter;
    set({ toast: { id, text, kind } });
    // Cleared by id, not by text. Matching the text let the timer of an earlier toast with the
    // same words remove a later one after a fraction of its time.
    setTimeout(() => get().dismissToast(id), 4000);
  },

  dismissToast: (id) => {
    const current = get().toast;
    if (current && (id === undefined || current.id === id)) set({ toast: null });
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
