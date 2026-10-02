import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveGame = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@core/save/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/save/store')>()),
  saveGame,
  deleteSave: vi.fn(async () => undefined),
}));

import { newCareer } from '@core/testing/fixtures';
import { advance, advanceSteps, STOPPED_AT_REQUEST } from '@core/world/tick';
import { advanceUntil, advanceUntilSteps } from '@core/world/advance-target';
import { driveSteps, useGame } from './store';

const fixture = newCareer(6161, { light: true });
const freshSave = () => structuredClone(fixture.save);

describe('the autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveGame.mockReset();
    saveGame.mockImplementation(async () => undefined);
    useGame.setState({ save: freshSave(), busy: false, operation: null, toast: null, saveError: null, cancelRequested: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes once when a change is followed by an operation, not twice', async () => {
    useGame.getState().mutate((s) => {
      s.saveName = 'Changed';
    });
    const run = useGame.getState().runOperation('other', 'Doing a thing', () => ({
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
    }));
    await vi.advanceTimersByTimeAsync(50);
    await run;
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveGame).toHaveBeenCalledTimes(1);
  });

  it('puts the queued write back when the operation fails', async () => {
    useGame.getState().mutate((s) => {
      s.saveName = 'Changed';
    });
    const run = useGame.getState().runOperation('other', 'Failing', () => {
      throw new Error('broken');
    });
    await vi.advanceTimersByTimeAsync(50);
    await run;
    expect(saveGame).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveGame).toHaveBeenCalledTimes(1);
  });

  it('tells the player when a background write fails, once, and clears when one succeeds', async () => {
    saveGame.mockImplementation(async () => {
      throw new Error('The disk is full');
    });
    useGame.getState().mutate((s) => {
      s.saveName = 'A';
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(useGame.getState().toast?.text).toMatch(/^Autosave failed: The disk is full\. Export your career from Settings\.$/);
    expect(useGame.getState().saveError).toBe('The disk is full');
    useGame.getState().dismissToast();
    useGame.getState().mutate((s) => {
      s.saveName = 'B';
    });
    await vi.advanceTimersByTimeAsync(800);
    // The same failure a moment later does not toast again.
    expect(useGame.getState().toast).toBeNull();
    saveGame.mockImplementation(async () => undefined);
    useGame.getState().mutate((s) => {
      s.saveName = 'C';
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(useGame.getState().saveError).toBeNull();
  });
});

describe('the sliced advance', () => {
  it('ends in exactly the state the one piece advance does', async () => {
    const a = freshSave();
    const b = freshSave();
    const sync = advance(a, { mode: 'month', stopOnDecision: false });
    const sliced = await driveSteps(advanceSteps(b, { mode: 'month', stopOnDecision: false }));
    expect(sliced).toEqual(sync);
    expect(b.date).toBe(a.date);
    expect(b.rng).toEqual(a.rng);
    expect(Object.keys(b.history.results).length).toBe(Object.keys(a.history.results).length);
  });

  it('a target advance sliced matches one run in one piece', async () => {
    const a = freshSave();
    const b = freshSave();
    const target = { kind: 'duration' as const, days: 20 };
    const sync = advanceUntil(a, target);
    const sliced = await driveSteps(advanceUntilSteps(b, target));
    expect(sliced).toEqual(sync);
    expect(b.rng).toEqual(a.rng);
  });

  it('stops at the end of the day the cancel arrives', async () => {
    const save = freshSave();
    const start = save.date;
    let days = 0;
    const report = await driveSteps(
      advanceSteps(save, { mode: 'year', stopOnDecision: false }, () => ++days >= 5)
    );
    expect(report.stoppedBecause).toBe(STOPPED_AT_REQUEST);
    expect(report.daysAdvanced).toBe(5);
    expect(report.from).toBe(start);

    const other = freshSave();
    let checks = 0;
    const outcome = advanceUntil(other, { kind: 'duration', days: 60 }, { shouldCancel: () => ++checks > 3 });
    expect(outcome.stoppedBecause).toBe(STOPPED_AT_REQUEST);
    expect(outcome.daysAdvanced).toBe(3);
  });
});
