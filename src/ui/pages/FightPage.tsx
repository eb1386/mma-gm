import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { ageOn, formatClock, formatDate, formatHeight, formatMoney } from '@core/types/common';
import { isChampionshipBout, isFinish, METHOD_LABEL, type Bout, type FightResult, type RoundStatLine } from '@core/types/fight';
import type { SaveGame } from '@core/types/save';
import { preFightBlocker, stageLabel, tasksForBout } from '@core/world/fightweek';
import { allOfficials, getOfficial, officialSummary } from '@core/world/officials';
import type { GamePlanKey } from '@core/types/world';
import { estimateRatings } from '@core/world/scouting';
import { simulatePlayerBout } from '@core/world/tick';
import {
  announcementHoldFor,
  atRoundBreak,
  holdFor,
  intermissionFor,
  lastIndexOfRound,
  liveState,
  momentOf,
  MOMENT_LABEL,
  nextBigMomentStop,
  playbackEndIndex,
  PLAYBACK_SPEEDS,
  roundAtIndex,
  roundEndStop,
  speedForSetting,
  fightVisibility,
  summarizeRound,
} from '@core/world/playback';
import { finalHorn, roundOpener } from '@core/narrative/broadcast';
import { getHype, hypeLabel } from '@core/world/hype';
import { Bar } from '../components';
import { GamePlanPicker } from '../GamePlanPicker';
import { BetweenRounds, bannerFor, momentTone, ResultReveal, Scoreboard, type Corner } from '../FightBroadcast';
import { useGame } from '../store';
import { planSourceLabel, recallPlan, rememberPlan } from '@core/world/gameplan-memory';
import { EstimatedRating, KeyValues, Notice, Panel, Rating, Tabs } from '../components';

const SPEEDS = PLAYBACK_SPEEDS;

function StatRow({ label, a, b, invert }: { label: string; a: number; b: number; invert?: boolean }) {
  const aLead = invert ? a < b : a > b;
  const bLead = invert ? b < a : b > a;
  return (
    <>
      <div className={`a${aLead ? ' lead' : ''}`}>{Math.round(a)}</div>
      <div className="label">{label}</div>
      <div className={`b${bLead ? ' lead' : ''}`}>{Math.round(b)}</div>
    </>
  );
}

function StatsBlock({ a, b, nameA, nameB }: { a: RoundStatLine; b: RoundStatLine; nameA: string; nameB: string }) {
  return (
    <div className="stat-compare">
      <div className="a">
        <strong>{nameA}</strong>
      </div>
      <div className="label" />
      <div className="b">
        <strong>{nameB}</strong>
      </div>
      <StatRow label="Sig strikes landed" a={a.sigStrikesLanded} b={b.sigStrikesLanded} />
      <StatRow label="Sig strikes attempted" a={a.sigStrikesAttempted} b={b.sigStrikesAttempted} />
      <StatRow label="Total strikes landed" a={a.totalStrikesLanded} b={b.totalStrikesLanded} />
      <StatRow label="Head" a={a.headLanded} b={b.headLanded} />
      <StatRow label="Body" a={a.bodyLanded} b={b.bodyLanded} />
      <StatRow label="Leg" a={a.legLanded} b={b.legLanded} />
      <StatRow label="Distance" a={a.distanceLanded} b={b.distanceLanded} />
      <StatRow label="Clinch" a={a.clinchLanded} b={b.clinchLanded} />
      <StatRow label="Ground" a={a.groundLanded} b={b.groundLanded} />
      <StatRow label="Knockdowns" a={a.knockdowns} b={b.knockdowns} />
      <StatRow label="Takedowns landed" a={a.takedownsLanded} b={b.takedownsLanded} />
      <StatRow label="Takedowns attempted" a={a.takedownsAttempted} b={b.takedownsAttempted} />
      <StatRow label="Submission attempts" a={a.submissionAttempts} b={b.submissionAttempts} />
      <StatRow label="Reversals" a={a.reversals} b={b.reversals} />
      <StatRow label="Control seconds" a={a.controlSeconds} b={b.controlSeconds} />
      <StatRow label="Fouls" a={a.fouls} b={b.fouls} invert />
    </div>
  );
}

function recordLine(r: { wins: number; losses: number; draws: number } | undefined): string {
  if (!r) return '0-0';
  return `${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function FightPage() {
  const save = useGame((s) => s.save)!;
  const runOperation = useGame((s) => s.runOperation);
  const mutate = useGame((s) => s.mutate);
  const busy = useGame((s) => s.busy);
  const { boutId } = useParams();
  const bout = boutId ? save.bouts[boutId] : null;
  // The pre fight plan inherits the camp plan for this bout when no separate one exists.
  const recalledPlan = recallPlan(save, boutId ?? null, 'preFight');
  const [plans, setPlansState] = useState<GamePlanKey[]>(recalledPlan.plans);
  const planLabel = planSourceLabel(recalledPlan);
  const setPlans = (next: GamePlanKey[] | ((cur: GamePlanKey[]) => GamePlanKey[])) => {
    // Resolved first and written once, outside the updater. React may call a setState updater more
    // than once, which would record the same plan change twice.
    const value = typeof next === 'function' ? next(plans) : next;
    setPlansState(value);
    mutate((s) => rememberPlan(s, boutId ?? null, 'preFight', value));
  };
  // The saved preference is the starting speed. The control on the fight page still overrides it
  // for this fight; without this the settings control chose a value nothing ever read.
  const [speedKey, setSpeedKey] = useState<string>(speedForSetting(save.settings.simSpeed));
  const [paused, setPaused] = useState(false);
  // A fight already on record opens on its result. Opening an old fight from the history or the
  // event page used to replay it live from the first event and hide the result until it finished.
  // The player's own fight still starts live, because it has no result until Start is pressed.
  const hadResultOnMount = Boolean(boutId && save.bouts[boutId]?.resultId);
  const [visible, setVisible] = useState(hadResultOnMount ? Number.MAX_SAFE_INTEGER : 0);
  const [mode, setMode] = useState<'instant' | 'live' | 'rounds'>(hadResultOnMount ? 'instant' : 'live');
  const [tab, setTab] = useState('play-by-play');
  const [startError, setStartError] = useState<string | null>(null);
  const [roundGate, setRoundGate] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentaryRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  // Instant mode still shows a visible processing step before the result appears.
  const [revealing, setRevealing] = useState(false);
  // Live and round by round playback reach the finish or the final horn first, then read the
  // result out. Until this is set the result is still hidden everywhere, the dock included.
  const [announced, setAnnounced] = useState(hadResultOnMount);
  const [announceStep, setAnnounceStep] = useState(0);
  const setFightPlayback = useGame((s) => s.setFightPlayback);
  const navigate = useNavigate();
  // Where the page scrolls once the fight starts: the commentary for a replay, the result for an
  // instant reveal. Nothing moved before, so the player was left looking at the hype timeline.
  const scrollTarget = useRef<'playback' | 'result' | null>(null);
  const playbackRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const result: FightResult | null = bout?.resultId ? save.history.results[bout.resultId] ?? null : null;
  const a = bout ? save.fighters[bout.fighterAId] : null;
  const b = bout ? save.fighters[bout.fighterBId] : null;
  const isPlayerBout = Boolean(bout && save.player.fighterId && (bout.fighterAId === save.player.fighterId || bout.fighterBId === save.player.fighterId));

  const events = useMemo(() => result?.events ?? [], [result]);
  // Playback never runs past the finishing event. Nothing after it happened.
  const endIndex = useMemo(() => (result ? playbackEndIndex(result) : 0), [result]);
  const maxVisible = events.length === 0 ? 0 : endIndex + 1;
  const shown = mode === 'instant' ? maxVisible : Math.min(visible, maxVisible);
  const currentRound = result && events.length > 0 ? roundAtIndex(result, Math.max(0, shown - 1)) : 1;
  const atEnd = shown >= maxVisible;
  const decision = Boolean(result) && !isFinish(result!.method) && result!.method !== 'disqualification';
  const announcing = Boolean(result) && mode !== 'instant' && events.length > 0 && atEnd && !announced;
  // One selector decides what the screen may show. Nothing else checks for a result.
  const visibility = fightVisibility({ result, revealed: shown, mode, revealing: revealing || announcing });
  // Round by round stops at the end of each round, but never offers to continue past a
  // round the fight actually ended in.
  const roundStopIndex = useMemo(() => {
    if (!result || mode !== 'rounds') return maxVisible;
    const last = lastIndexOfRound(result, roundGate);
    if (last < 0) return maxVisible;
    return Math.min(maxVisible, last + 1);
  }, [result, mode, roundGate, maxVisible]);
  // The horn has gone on a round and another is still to come. Both live and round by round show
  // the card here; live moves on by itself after the break, round by round waits for the player.
  const breakNow = Boolean(result) && mode !== 'instant' && atRoundBreak(result!, shown);
  const speedMs = SPEEDS.find((s) => s.key === speedKey)?.ms ?? 1100;
  const live = useMemo(() => (result && events.length > 0 ? liveState(result, shown) : null), [result, events.length, shown]);

  // The rest of the app holds its pre fight view while the result is still hidden here. The flag
  // is also raised by runFight before the simulation, so there is no render in between where the
  // header or the inbox badge already shows the outcome. Cleared when the result is revealed and
  // whenever the page goes away, so it can never strand the dock.
  const replaying = Boolean(result) && !visibility.concluded;
  useEffect(() => {
    if (!replaying || !boutId) return undefined;
    setFightPlayback(boutId);
    return () => setFightPlayback(null);
  }, [replaying, boutId, setFightPlayback]);
  useEffect(() => () => setFightPlayback(null), [setFightPlayback]);

  useEffect(() => {
    const target = scrollTarget.current;
    if (!target) return;
    const el = target === 'playback' ? playbackRef.current : visibility.showWinner ? resultRef.current : null;
    if (!el) return;
    scrollTarget.current = null;
    el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [result, visibility.showWinner]);

  // When the finish lands or the final horn sounds, the reveal is brought into view. The
  // scoreboard stops sticking at that point, so the top of the fight block is the reveal.
  useEffect(() => {
    if (!announcing) return;
    playbackRef.current?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [announcing]);

  // The round card sits above the commentary. On a phone the player is scrolled down to the
  // commentary when the horn goes, which left the card hidden behind the sticky scoreboard.
  const breakRef = useRef<HTMLDivElement | null>(null);
  const breakAtHorn = breakNow ? currentRound : 0;
  useEffect(() => {
    if (!breakAtHorn) return;
    const card = breakRef.current;
    const board = playbackRef.current?.querySelector('.fight-scoreboard');
    if (!card) return;
    const covered = board ? card.getBoundingClientRect().top < board.getBoundingClientRect().bottom : false;
    if (covered || card.getBoundingClientRect().top > window.innerHeight * 0.6) {
      playbackRef.current?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [breakAtHorn]);

  useEffect(() => {
    if (!result) return;
    if (mode === 'instant') return;
    if (paused) return;
    const ceiling = mode === 'rounds' ? roundStopIndex : maxVisible;
    if (visible >= ceiling) return;
    // The event just shown sets the pause after it, so a knockdown stays on screen for a beat
    // instead of being pushed up by the next exchange. The break between rounds is longer still.
    const wait = atRoundBreak(result, Math.min(visible, maxVisible)) ? intermissionFor(speedMs) : holdFor(events[visible - 1], speedMs);
    timer.current = setTimeout(() => {
      setVisible((v) => Math.min(ceiling, v + 1));
    }, wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [result, mode, speedMs, paused, visible, maxVisible, roundStopIndex, events]);

  // The announcement: a beat on the finish, or the judges' cards one at a time. It does not wait
  // on the pause control, which is gone by then, so a pause just before the end cannot strand it.
  useEffect(() => {
    if (!announcing || !result) return undefined;
    const cards = result.scorecards.length;
    const last = decision ? cards + 1 : 1;
    const wait = announceStep === 0 ? announcementHoldFor(speedMs, decision) : Math.max(1300, speedMs * 1.3);
    const t = setTimeout(() => {
      if (announceStep + 1 >= last) setAnnounced(true);
      else setAnnounceStep((s) => s + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [announcing, announceStep, result, decision, speedMs]);

  useEffect(() => {
    if (result && mode === 'instant') setVisible(maxVisible);
  }, [result, mode, maxVisible]);

  // Auto scroll the commentary container, never the page, and never while the user is
  // reading further up.
  useEffect(() => {
    if (!autoScroll || userScrolledUp) return;
    const el = commentaryRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [shown, autoScroll, userScrolledUp]);

  const onCommentaryScroll = () => {
    const el = commentaryRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setUserScrolledUp(!nearBottom);
  };

  /**
   * Moves playback to a given number of revealed events. Round by round mode follows along, so a
   * skip lands at the next horn and stops there rather than running on into the next round.
   */
  const jumpTo = (n: number) => {
    if (!result) return;
    const target = Math.max(0, Math.min(maxVisible, n));
    setVisible(target);
    if (target > 0) setRoundGate(roundAtIndex(result, target - 1));
  };
  const continueRound = () => {
    if (!result) return;
    setRoundGate(currentRound + 1);
    setVisible((v) => Math.min(maxVisible, v + 1));
  };

  // Space plays and pauses, the right arrow steps, N skips to the next big moment. Ignored while
  // typing or when a control has focus, where the key already means something.
  const keyState = useRef({ atEnd: true, live: false });
  keyState.current = { atEnd, live: Boolean(result) && mode !== 'instant' };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.closest('input, select, textarea, button, a, [contenteditable]') || ev.metaKey || ev.ctrlKey || ev.altKey)) return;
      if (!keyState.current.live || keyState.current.atEnd) return;
      if (ev.key === ' ') {
        ev.preventDefault();
        setPaused((p) => !p);
      } else if (ev.key === 'ArrowRight') {
        setVisible((v) => Math.min(maxVisible, v + 1));
      } else if (ev.key === 'n' || ev.key === 'N') {
        if (result) jumpTo(nextBigMomentStop(result, shown));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!bout || !a || !b) {
    return (
      <div className="page">
        <Notice kind="bad">That bout does not exist in this save.</Notice>
      </div>
    );
  }

  const event = save.events[bout.eventId];
  const estA = estimateRatings(save, a);
  const estB = estimateRatings(save, b);
  const division = DIVISION_BY_ID[bout.divisionId];
  // Until the result is revealed the bout is billed as it stood before the fight. The fighters
  // already carry the result, which put the new record and belt on the tape at round one.
  const pre = visibility.concluded ? undefined : bout.preFight;
  const recordA = bout.isAmateur ? (pre ? pre.amateurRecordA : a.amateurRecord) : (pre?.recordA ?? a.record);
  const recordB = bout.isAmateur ? (pre ? pre.amateurRecordB : b.amateurRecord) : (pre?.recordB ?? b.record);
  const standingA = (pre ? pre.championA : a.isChampion) ? 'Champion' : ((pre ? pre.rankingA : a.ranking) ?? 'Unranked');
  const standingB = (pre ? pre.championB : b.isChampion) ? 'Champion' : ((pre ? pre.rankingB : b.ranking) ?? 'Unranked');
  // The game plan and Start appear only when this fight can actually happen now: booked, on or
  // after its date, with the weigh in behind it. The event page preview reached Start weeks out.
  const blocker = !result && isPlayerBout ? preFightBlocker(save, bout.id) : null;
  const fightable = isPlayerBout && bout.status === 'scheduled' && save.date >= bout.date && !blocker;

  /**
   * Starts the fight through the central operation controller.
   *
   * The controller paints the preparing state and yields to the browser before the
   * simulation runs, so the screen changes the instant the button is pressed rather than
   * freezing and then jumping to a finished result.
   */
  const runFight = async () => {
    if (busy || result) return;
    setStartError(null);
    setVisible(0);
    setRoundGate(1);
    setPaused(false);
    setAnnounced(false);
    setAnnounceStep(0);
    // Raised before the result exists, so nothing outside this page renders the outcome first.
    setFightPlayback(bout.id);
    // Instant mode holds its reveal from the start for the same reason: the first render with a
    // result must already count as not concluded.
    if (mode === 'instant') setRevealing(true);
    scrollTarget.current = mode === 'instant' ? 'result' : 'playback';
    const outcome = await runOperation('simulate-fight', 'Preparing the fight', (report) => {
      report('simulating-fight', 'Loading fighters and camp state');
      const bt = save.bouts[bout.id];
      if (!bt) return { ok: false, noOpReason: null, error: 'That bout no longer exists.', fromDate: null, toDate: null, daysAdvanced: 0, eventsResolved: [], headlines: [], stoppedBecause: null, navigateTo: null, summary: '' };
      if (bt.resultId) {
        return { ok: true, noOpReason: 'This fight has already been contested.', error: null, fromDate: null, toDate: null, daysAdvanced: 0, eventsResolved: [], headlines: [], stoppedBecause: null, navigateTo: null, summary: '' };
      }
      report('simulating-fight', 'Preparing judges and starting round one');
      simulatePlayerBout(save, bout.id, plans);
      return { ok: true, noOpReason: null, error: null, fromDate: null, toDate: null, daysAdvanced: 0, eventsResolved: [], headlines: [], stoppedBecause: null, navigateTo: null, summary: '' };
    });
    if (!outcome.ok) {
      setRevealing(false);
      setFightPlayback(null);
      scrollTarget.current = null;
      setStartError(outcome.error ?? 'The fight could not be started.');
      return;
    }
    if (mode === 'instant') {
      // Even instant mode shows that something happened before the answer lands.
      setVisible(Number.MAX_SAFE_INTEGER);
      setTimeout(() => setRevealing(false), 900);
    } else {
      setVisible(0);
    }
  };

  const eventsToShow = events.slice(0, shown);
  const corners: [Corner, Corner] = [
    { name: a.name, lastName: a.lastName, record: recordLine(recordA) },
    { name: b.name, lastName: b.lastName, record: recordLine(recordB) },
  ];
  const lastNames: Record<string, string> = { [a.id]: a.lastName, [b.id]: b.lastName };
  const fullNames: Record<string, string> = { [a.id]: a.name, [b.id]: b.name };
  // The banner stays up while the moment is still among the last few things that happened.
  const banner =
    result && live && live.lastBigMomentIndex !== null && shown - 1 - live.lastBigMomentIndex <= 2 && !breakNow
      ? bannerFor(result, events, live.lastBigMomentIndex, lastNames)
      : null;
  const finishBanner = result && live && atEnd ? bannerFor(result, events, live.lastBigMomentIndex, lastNames) : null;
  const scoreboardStatus = revealing
    ? 'Preparing'
    : visibility.concluded
      ? 'Final'
      : announcing
        ? decision
          ? 'Scorecards'
          : 'Stopped'
        : breakNow
          ? 'Between rounds'
          : shown === 0
            ? 'Ready'
            : paused
              ? 'Paused'
              : 'Live';
  const showReveal = Boolean(result) && !revealing && (announcing || visibility.concluded);
  const sticky = Boolean(result) && !visibility.concluded && !announcing && !revealing;

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          {a.name} against {b.name}
        </h1>
        <span className="sub">
          <Link to={`/event/${event?.id}`}>{event?.name}</Link> · {formatDate(bout.date)} · {division.name} ·{' '}
          {bout.scheduledRounds} rounds at {bout.contractedWeightLb} lb
        </span>
        {bout.isTitleFight && <span className="tag champ">championship</span>}
        {bout.regionalTitle && <span className="tag champ">regional title</span>}
        {bout.isInterimTitleFight && <span className="tag interim">interim title</span>}
        {bout.isCatchweight && <span className="tag warn">catchweight</span>}
        {bout.titleIneligibleFighterIds.length > 0 && (
          <span className="tag warn">
            {bout.titleIneligibleFighterIds.length === 2
              ? 'both fighters ineligible for the title'
              : `title on the line only for ${
                  save.fighters[bout.titleIneligibleFighterIds[0] === a.id ? b.id : a.id]?.name ?? 'the other corner'
                }`}
          </span>
        )}
      </div>

      {result && (
        <div ref={playbackRef} className={`fight-live scroll-anchor${sticky ? ' playing' : ''}`}>
          {revealing && (
            <div className="fight-preparing mb" role="status" aria-live="polite">
              <strong>Scoring the fight</strong>
              <div className="small dim">The result is read out in a moment.</div>
            </div>
          )}
          {live && !revealing && (
            <Scoreboard
              a={corners[0]}
              b={corners[1]}
              live={live}
              scheduledRounds={result.scheduledRounds}
              status={scoreboardStatus}
              banner={announcing || visibility.concluded ? null : banner}
              hornRound={breakNow ? currentRound : null}
              final={announcing || visibility.concluded}
            />
          )}

          {showReveal && (
            <div ref={resultRef} className="scroll-anchor">
              <ResultReveal
                result={result}
                names={fullNames}
                step={announceStep}
                concluded={visibility.concluded}
                playerId={isPlayerBout ? save.player.fighterId : null}
                banner={finishBanner}
                onShowNow={() => setAnnounced(true)}
              />
            </div>
          )}

          {breakNow && (mode === 'live' || shown >= roundStopIndex) && (
            <div ref={breakRef}>
            <BetweenRounds
              result={result}
              round={currentRound}
              a={corners[0]}
              b={corners[1]}
              revealScores={save.settings.revealLiveScores}
              live={mode === 'live'}
              paused={paused}
              intermissionMs={intermissionFor(speedMs)}
              onContinue={continueRound}
            />
            </div>
          )}

          <Tabs
            tabs={[
              { key: 'play-by-play', label: 'Play by play' },
              { key: 'rounds', label: 'Round summaries' },
              { key: 'stats', label: 'Statistics' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'play-by-play' && (
            <Panel>
              {events.length === 0 ? (
                <p className="dim small">
                  The detailed play by play for this fight has been archived to keep the save small. The result, recap,
                  totals and scorecards are all preserved.
                </p>
              ) : (
                <div className="play-by-play" ref={commentaryRef} onScroll={onCommentaryScroll} aria-live="polite">
                  {(() => {
                    let round = 0;
                    const out: JSX.Element[] = [];
                    eventsToShow.forEach((e, i) => {
                      if (e.round !== round) {
                        round = e.round;
                        out.push(
                          <div className="pbp-round" key={`r${round}`}>
                            <span>Round {round}</span>
                            <span className="pbp-opener">{roundOpener(result, round)}</span>
                          </div>
                        );
                      }
                      if (!e.text) return;
                      const moment = momentOf(e);
                      const tone = momentTone(moment);
                      const label = moment === 'finish' ? 'Finish' : moment ? MOMENT_LABEL[moment] : null;
                      const fresh = i === shown - 1 && mode !== 'instant';
                      out.push(
                        <div
                          key={e.seq}
                          className={`pbp-line${e.importance === 'decisive' ? ' decisive' : e.importance === 'major' ? ' major' : ''}${tone ? ` moment ${tone}` : ''}${fresh ? ' fresh' : ''}`}
                        >
                          <span className="clock">{formatClock(e.clockSecondsRemaining)}</span>
                          <span className="pbp-text">
                            {label && <span className="pbp-tag">{label}</span>}
                            {e.text}
                          </span>
                        </div>
                      );
                    });
                    return out;
                  })()}
                  {atEnd && decision && <div className="pbp-round horn">{finalHorn(result, a.lastName, b.lastName)}</div>}
                  {visibility.concluded && (
                    <div className="pbp-round decisive">
                      {result.winnerId
                        ? `${save.fighters[result.winnerId]?.name} wins by ${METHOD_LABEL[result.method]}, round ${result.endRound} at ${formatClock(result.endTimeSeconds)}`
                        : `${METHOD_LABEL[result.method]}, round ${result.endRound} at ${formatClock(result.endTimeSeconds)}`}
                    </div>
                  )}
                </div>
              )}
              {userScrolledUp && !atEnd && (
                <button
                  className="jump-to-live"
                  onClick={() => {
                    setUserScrolledUp(false);
                    commentaryRef.current?.scrollTo({ top: commentaryRef.current.scrollHeight, behavior: 'smooth' });
                  }}
                >
                  Jump to Live
                </button>
              )}

              {events.length > 0 && mode !== 'instant' && !atEnd && (
                <div className="fight-controls" role="toolbar" aria-label="Playback">
                  <button className="primary fc-play" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
                    {paused ? 'Play' : 'Pause'}
                  </button>
                  <span className="fc-speeds" role="group" aria-label="Speed">
                    {SPEEDS.map((s) => (
                      <button key={s.key} className={`small${speedKey === s.key ? ' active' : ''}`} aria-pressed={speedKey === s.key} onClick={() => setSpeedKey(s.key)}>
                        {s.label}
                      </button>
                    ))}
                  </span>
                  <select className="fc-speed-select" aria-label="Speed" value={speedKey} onChange={(e) => setSpeedKey(e.target.value)}>
                    {SPEEDS.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <span className="fc-skips">
                    {paused && (
                      <button className="small" onClick={() => setVisible((v) => Math.min(maxVisible, v + 1))}>
                        Step
                      </button>
                    )}
                    <button className="small" title="Skip to the next big moment, or to the horn if none comes first" onClick={() => jumpTo(nextBigMomentStop(result, shown))}>
                      Next moment
                    </button>
                    <button className="small" onClick={() => jumpTo(roundEndStop(result, shown))}>
                      End of round
                    </button>
                    <button className="small" onClick={() => jumpTo(maxVisible)}>
                      Skip to result
                    </button>
                  </span>
                </div>
              )}
              <label className="small dim row tight" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                Follow the commentary automatically
              </label>

              <p className="small faint mt">
                The commentary is rendered from the simulation's own event stream. It never changes what happened.
                {!visibility.concluded && ' The official result, the scorecards, the purse and the rankings stay hidden until the fight is over.'}
                <span className="fc-keys"> Keys: space to pause, the right arrow to step, N for the next big moment.</span>
              </p>
            </Panel>
          )}

          {tab === 'rounds' && (
            <div className="grid c2">
              {result.rounds
                .filter((r) => visibility.visibleRounds.includes(r.round))
                .map((r) => {
                const summary = summarizeRound(result, r.round, a.name, b.name);
                return (
                <Panel key={r.round} title={summary.completedNormally ? `Round ${r.round}` : `Round ${r.round}: the fight ended here`}>
                  <p><strong>{summary.headline}</strong></p>
                  <ul className="small">
                    {summary.lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                  <div className="row small dim">
                    <span>
                      Unofficial read:{' '}
                      {Math.abs(r.trueScoreA) < 2.4
                        ? 'too close to call'
                        : r.trueScoreA > 0
                          ? `${a.name} by ${Math.abs(r.trueScoreA) > 17 ? 'a clear margin' : 'a narrow margin'}`
                          : `${b.name} by ${Math.abs(r.trueScoreA) > 17 ? 'a clear margin' : 'a narrow margin'}`}
                    </span>
                    {/* The setting promised the exact margin and was read by nothing, so turning it
                        on changed nothing on screen. */}
                    {save.settings.revealLiveScores && (
                      <span className="mono" title="Exact round margin, revealed by a setting">
                        margin {r.trueScoreA > 0 ? '+' : ''}
                        {r.trueScoreA.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {r.staminaEndA !== undefined && r.staminaEndB !== undefined && (
                    <div className="row small dim">
                      <span>
                        Cardio at the horn: {a.name} {Math.round(r.staminaEndA)}, {b.name} {Math.round(r.staminaEndB)}
                      </span>
                    </div>
                  )}
                  {r.statsA && r.statsB ? (
                    <div className="mt">
                      <StatsBlock a={r.statsA} b={r.statsB} nameA={a.lastName} nameB={b.lastName} />
                      {r.damageEndA && r.damageEndB && (
                        // Recorded per round and kept for recent fights alongside the stats, but
                        // never shown. Accumulated damage at the horn is what the judges were
                        // looking at, so it belongs next to the round they scored.
                        <p className="small dim mt">
                          Accumulated damage at the horn: {a.lastName} head {Math.round(r.damageEndA.head)}, body{' '}
                          {Math.round(r.damageEndA.body)}; {b.lastName} head {Math.round(r.damageEndB.head)}, body{' '}
                          {Math.round(r.damageEndB.body)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="small faint mt">
                      Round by round statistics for this fight have been compacted. The result, totals and scorecards are
                      preserved.
                    </p>
                  )}
                </Panel>
                );
              })}
              {visibility.visibleRounds.length === 0 && (
                <Panel title="Round summaries">
                  <p className="dim">Each round's summary appears once its horn has gone.</p>
                </Panel>
              )}
            </div>
          )}

          {tab === 'stats' && !visibility.showFinalStats && (
            <Panel title="Fight totals">
              <p className="dim">Final statistics appear once the fight is over.</p>
            </Panel>
          )}

          {tab === 'stats' && visibility.showFinalStats && (
            <Panel title="Fight totals">
              <StatsBlock a={result.totalsA} b={result.totalsB} nameA={a.name} nameB={b.name} />
              <div className="grid c2 mt">
                <KeyValues
                  rows={[
                    ['Scheduled rounds', result.scheduledRounds],
                    ['Ended', `round ${result.endRound} at ${formatClock(result.endTimeSeconds)}`],
                    ['Method', METHOD_LABEL[result.method]],
                    ['Fight quality', Math.round(result.fightQuality)],
                    ['Fight of the Night', result.fightOfTheNight ? 'Yes' : 'No'],
                  ]}
                />
                <KeyValues
                  rows={[
                    [`${a.lastName} damage taken (head)`, Math.round(result.finalDamageA.head)],
                    [`${b.lastName} damage taken (head)`, Math.round(result.finalDamageB.head)],
                    [`${a.lastName} cardio left`, Math.round(result.finalStaminaA)],
                    [`${b.lastName} cardio left`, Math.round(result.finalStaminaB)],
                    ['Seed', result.seed],
                  ]}
                />
              </div>
              <p className="small faint mt">
                The same seed and the same inputs reproduce this fight exactly, event for event.
              </p>
            </Panel>
          )}
        </div>
      )}

      <div className="grid c2">
        {result && visibility.showWinner && (
          <Panel title="Result">
            <p style={{ fontSize: 15 }}>
              {result.winnerId ? (
                <>
                  <strong>{save.fighters[result.winnerId]?.name}</strong> by {METHOD_LABEL[result.method]}
                </>
              ) : (
                <strong>{METHOD_LABEL[result.method]}</strong>
              )}
              <br />
              <span className="dim">
                Round {result.endRound}, {formatClock(result.endTimeSeconds)}
                {result.submissionName ? ` · ${result.submissionName.split('-').join(' ')}` : ''}
              </span>
            </p>
            <p>{result.narrativeSummary}</p>
            {result.scorecards.length > 0 && (
              <table className="mt">
                <thead>
                  <tr>
                    <th>Judge</th>
                    {result.rounds.map((r) => (
                      <th key={r.round} className="num">
                        R{r.round}
                      </th>
                    ))}
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.scorecards.map((c) => {
                    const judge = allOfficials(save).find((o) => o.role === 'judge' && o.name === c.judgeName);
                    return (
                    <tr key={c.judgeName}>
                      <td title={judge ? `${judge.commission} commission. ${officialSummary(judge)}` : undefined}>
                        {judge ? <Link to={`/officials#${judge.id}`}>{c.judgeName}</Link> : c.judgeName}
                      </td>
                      {c.rounds.map((r) => (
                        <td key={r.round} className="num mono">
                          {r.a}-{r.b}
                        </td>
                      ))}
                      <td className="num mono">
                        <strong>
                          {c.totalA}-{c.totalB}
                        </strong>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {(() => {
              // The referee is part of the official record of a fight, and their tendency is
              // what decides how late a stoppage comes.
              const refId = bout.officials?.refereeId;
              const referee = refId ? getOfficial(save, refId) : null;
              if (!referee) return null;
              return (
                <p className="small dim mt">
                  Referee: <Link to={`/officials#${referee.id}`}>{referee.name}</Link>. {officialSummary(referee)}
                </p>
              );
            })()}
            {(result.pointDeductionsA > 0 || result.pointDeductionsB > 0) && (
              <p className="small warn mt">
                Point deductions: {a.name} {result.pointDeductionsA}, {b.name} {result.pointDeductionsB}.
              </p>
            )}
            <div className="row mt small dim">
              <span>Longevity cost: {a.name} {result.longevityCostA.toFixed(1)}, {b.name} {result.longevityCostB.toFixed(1)}</span>
            </div>
            {(result.injuriesA.length > 0 || result.injuriesB.length > 0) && (
              <p className="small bad">
                Injuries: {[...result.injuriesA.map((i) => `${a.name}: ${i}`), ...result.injuriesB.map((i) => `${b.name}: ${i}`)].join('. ')}
              </p>
            )}
            {isPlayerBout && visibility.showMoney && <Aftermath save={save} bout={bout} result={result} />}
          </Panel>
        )}

        <Panel title="Tale of the tape">
          <div className="stat-compare">
            <div className="a">
              <strong>
                <Link to={`/fighter/${a.id}`}>{a.name}</Link>
              </strong>
            </div>
            <div className="label" />
            <div className="b">
              <strong>
                <Link to={`/fighter/${b.id}`}>{b.name}</Link>
              </strong>
            </div>
            {/* An amateur bout is billed on the amateur records, which is all either fighter has. */}
            <div className="a">{recordLine(recordA)}</div>
            <div className="label">{bout.isAmateur ? 'Amateur record' : 'Record'}</div>
            <div className="b">{recordLine(recordB)}</div>
            <div className="a">{standingA}</div>
            <div className="label">Ranking</div>
            <div className="b">{standingB}</div>
            <div className="a">{ageOn(a.birthDate, save.date) ?? a.ageAtSnapshot ?? '?'}</div>
            <div className="label">Age</div>
            <div className="b">{ageOn(b.birthDate, save.date) ?? b.ageAtSnapshot ?? '?'}</div>
            <div className="a">{formatHeight(a.heightIn)}</div>
            <div className="label">Height</div>
            <div className="b">{formatHeight(b.heightIn)}</div>
            <div className="a">{a.reachIn ? `${a.reachIn}"` : 'Unknown'}</div>
            <div className="label">Reach</div>
            <div className="b">{b.reachIn ? `${b.reachIn}"` : 'Unknown'}</div>
            <div className="a">{a.stance}</div>
            <div className="label">Stance</div>
            <div className="b">{b.stance}</div>
            <div className="a">
              <EstimatedRating estimate={estA.ovr} low={estA.exact ? undefined : estA.ovrLow} high={estA.exact ? undefined : estA.ovrHigh} />
            </div>
            <div className="label">Ovr</div>
            <div className="b">
              <EstimatedRating estimate={estB.ovr} low={estB.exact ? undefined : estB.ovrLow} high={estB.exact ? undefined : estB.ovrHigh} />
            </div>
            <div className="a">
              <Rating value={pre?.longevityA ?? a.longevity} />
            </div>
            <div className="label">Longevity</div>
            <div className="b">
              <Rating value={pre?.longevityB ?? b.longevity} />
            </div>
            <div className="a small dim">{a.styleLabels.map((s) => s.label).join(', ')}</div>
            <div className="label">Style</div>
            <div className="b small dim">{b.styleLabels.map((s) => s.label).join(', ')}</div>
          </div>
          {bout.weighInA && bout.weighInB && (
            <p className="small mt">
              Weigh in: {a.name} {bout.weighInA.weightLb} lb {bout.weighInA.madeWeight ? '' : '(missed)'} · {b.name}{' '}
              {bout.weighInB.weightLb} lb {bout.weighInB.madeWeight ? '' : '(missed)'}
            </p>
          )}
        </Panel>

        {!result && isPlayerBout && !fightable && (
          <NotYetPanel bout={bout} save={save} blockerLabel={blocker ? stageLabel(blocker.stage) : null} onGo={navigate} />
        )}

        {!result && fightable && (
          <Panel title="Game plan">
            <p className="small dim">
              Pick up to three. A coherent plan sharpens preparation. Stacking contradictory plans wastes the camp.
            </p>
            {planLabel && (
              <p className="small">
                <span className="tag">{planLabel}</span> Preselected from your camp. Change it if the read has moved on.
              </p>
            )}
            <GamePlanPicker plans={plans} onChange={(next) => setPlans(next)} />
            <div className="row mt">
              <label>Presentation</label>
              <select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="live">Live text</option>
                <option value="rounds">Round by round</option>
                <option value="instant">Instant result</option>
              </select>
              <button className="primary" disabled={busy} onClick={() => void runFight()}>
                {busy ? 'Preparing fight...' : 'Start the fight'}
              </button>
            </div>
            {busy && (
              <div className="fight-preparing mt" role="status" aria-live="polite">
                <strong>Preparing the fight</strong>
                <ul className="small dim">
                  <li>Loading fighters and records</li>
                  <li>Loading camp state and sharpness</li>
                  <li>Applying game plans</li>
                  <li>Assigning officials</li>
                  <li>Starting round one</li>
                </ul>
              </div>
            )}
            {startError && (
              <div className="notice bad mt" role="alert">
                <strong>The fight could not be started.</strong>
                <div>{startError}</div>
                <button className="mt" onClick={() => void runFight()}>
                  Try again
                </button>
              </div>
            )}
          </Panel>
        )}

        {(() => {
          const hype = getHype(save, bout.id);
          if (!hype) return null;
          return (
            <Panel title="Fight hype">
              <div className="row mb">
                <strong style={{ fontSize: 15 }}>{hypeLabel(hype.total)}</strong>
                <span className="dim small">{hype.storyline}</span>
              </div>
              <table>
                <tbody>
                  {(
                    [
                      ['Total hype', hype.total],
                      ['Hardcore interest', hype.hardcore],
                      ['Casual interest', hype.casual],
                      ['Regional interest', hype.regional],
                      ['Media interest', hype.media],
                    ] as [string, number][]
                  ).map(([label, v]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td style={{ width: 120 }}>
                        <Bar value={v} />
                      </td>
                      <td className="num">{Math.round(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hype.moments.length > 0 && (
                <>
                  <h3 className="mt">Hype timeline</h3>
                  <table>
                    <tbody>
                      {[...hype.moments].reverse().map((m, i) => (
                        <tr key={i}>
                          <td className="dim small nowrap">{formatDate(m.date)}</td>
                          <td className="wrap small">{m.label}</td>
                          <td className={`num ${m.delta > 0 ? 'good' : 'bad'}`}>
                            {m.delta > 0 ? '+' : ''}
                            {m.delta}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Panel>
          );
        })()}

        {!result && !isPlayerBout && (
          <Panel title="Not yet contested">
            <p className="dim">
              This bout has not happened. Advance the calendar to the event date and it will be simulated with the rest
              of the card.
            </p>
            <KeyValues
              rows={[
                ['Booked on', formatDate(bout.bookedOn)],
                ['Reason', bout.bookingReason],
                ['Purse', `${formatMoney(bout.purseA.show)} and ${formatMoney(bout.purseB.show)} to show`],
              ]}
            />
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * Shown in place of the game plan when the player's bout cannot be fought from here yet.
 *
 * The tale of the tape stays above it, so the event page preview is still a preview. It used to
 * offer Start the fight on any unfought bout, weeks early or after a cancellation.
 */
function NotYetPanel({
  bout,
  save,
  blockerLabel,
  onGo,
}: {
  bout: Bout;
  save: SaveGame;
  blockerLabel: string | null;
  onGo: (to: string) => void;
}) {
  if (bout.status === 'canceled') {
    return (
      <Panel title="Bout canceled">
        <Notice kind="bad">This bout was canceled.{bout.cancelReason ? ` ${bout.cancelReason}` : ''}</Notice>
        <button className="mt" onClick={() => onGo('/dashboard')}>
          Back to the dashboard
        </button>
      </Panel>
    );
  }
  if (bout.status !== 'scheduled') {
    return (
      <Panel title="Not on the card">
        <p>This bout is not scheduled to be fought.</p>
      </Panel>
    );
  }
  if (blockerLabel) {
    return (
      <Panel title="Before the fight">
        <p>{blockerLabel} has not happened yet. It comes before the walk to the cage.</p>
        <button className="primary" onClick={() => onGo(`/fightweek/${bout.id}`)}>
          Go to fight week
        </button>
      </Panel>
    );
  }
  // Fight week exists once its stages have been created; before that the camp is where the work is.
  const inFightWeek = tasksForBout(save, bout.id).length > 0;
  return (
    <Panel title="Not fight night yet">
      <p>Fight night is {formatDate(bout.date)}. The game plan is chosen here on the night, after the weigh in.</p>
      <button className="primary" onClick={() => onGo(inFightWeek ? `/fightweek/${bout.id}` : '/camp')}>
        {inFightWeek ? 'Go to fight week' : 'Go to camp'}
      </button>
    </Panel>
  );
}

function rankLabel(champion: boolean, ranking: number | null): string {
  return champion ? 'Champion' : ranking === null ? 'Unranked' : `#${ranking}`;
}

/**
 * What the fight changed for the player: the money, any bonus, the belt and the ranking.
 *
 * The result panel showed the method and the narrative and nothing else, so a player who had just
 * won a title or a bonus saw no sign of it beyond the tale of the tape quietly changing.
 */
function Aftermath({ save, bout, result }: { save: SaveGame; bout: Bout; result: FightResult }) {
  const meId = save.player.fighterId;
  if (!meId) return null;
  const isA = bout.fighterAId === meId;
  if (!isA && bout.fighterBId !== meId) return null;
  const me = save.fighters[meId];
  const event = save.events[bout.eventId];
  const regional = Boolean(event?.promotionId);
  const division = DIVISION_BY_ID[bout.divisionId];
  const won = result.winnerId === meId;
  const rows: [string, string][] = [];

  // The money as it was actually paid, from the ledger. A save that has pruned those lines falls
  // back to the purse agreed at booking.
  const entries = (save.ledger ?? []).filter((e) => e.boutId === bout.id && e.fighterId === meId);
  const sum = (pick: (e: (typeof entries)[number]) => boolean) => entries.filter(pick).reduce((t, e) => t + e.amount, 0);
  if (bout.isAmateur) {
    rows.push(['Purse', 'None. Amateur bouts pay nothing.']);
  } else if (entries.length > 0) {
    const show = sum((e) => e.kind === 'show-pay');
    const win = sum((e) => e.kind === 'win-bonus');
    const takeHome = sum((e) => e.direction === 'in') - sum((e) => e.direction === 'out');
    rows.push(['Purse', `${formatMoney(show)} to show${win > 0 ? `, ${formatMoney(win)} to win` : ''}`]);
    rows.push(['Take home', `${formatMoney(takeHome)} after commission, the gym's share, tax and travel`]);
  } else {
    const purse = isA ? bout.purseA : bout.purseB;
    rows.push(['Purse', `${formatMoney(purse.show)} to show${won && purse.win > 0 ? `, ${formatMoney(purse.win)} to win` : ''}`]);
  }

  // Regional cards pay no bonuses. On the main promotion they are decided once the card is done.
  if (!regional && event) {
    if (event.status !== 'completed') {
      rows.push(['Bonuses', 'Bonuses are announced after the card']);
    } else {
      const bonuses: string[] = [];
      if (event.performanceBonusFighterIds?.includes(meId)) bonuses.push(`Performance of the Night, ${formatMoney(event.bonusAmount)}`);
      if (event.fightOfTheNightBoutId === bout.id) bonuses.push('Fight of the Night');
      rows.push(['Bonuses', bonuses.length > 0 ? bonuses.join('. ') : 'None on this card']);
    }
  }

  // The belt, judged against who held it going in. The live champion flag cannot tell a new
  // champion from a successful defence once the result has been applied.
  const pre = bout.preFight;
  if (isChampionshipBout(bout) && pre && division) {
    const title = `${bout.isInterimTitleFight ? 'interim ' : ''}${division.name} title`;
    const winner = result.winnerId ? save.fighters[result.winnerId] : null;
    const winnerWasChampion = result.winnerId === bout.fighterAId ? pre.championA : pre.championB;
    const holder = pre.championA ? save.fighters[bout.fighterAId] : pre.championB ? save.fighters[bout.fighterBId] : null;
    if (winner && bout.titleIneligibleFighterIds.includes(winner.id)) {
      rows.push(['Title', `${winner.name} missed weight and could not win the ${title}`]);
    } else if (winner) {
      rows.push(['Title', winnerWasChampion ? `${winner.name} retains the ${title}` : `${winner.name} is the new ${bout.isInterimTitleFight ? 'interim ' : ''}${division.name} champion`]);
    } else {
      rows.push(['Title', holder ? `${holder.name} retains the ${title}` : `The ${title} stays vacant`]);
    }
  }

  // Rankings are recomputed in the weekly pass, so straight after the fight the number has not
  // moved yet. Saying so is better than showing the old number as if it were the new one.
  if (!regional && pre && me) {
    const before = rankLabel(isA ? pre.championA : pre.championB, isA ? pre.rankingA : pre.rankingB);
    const now = rankLabel(me.isChampion, me.ranking);
    const table = save.rankings[bout.divisionId];
    if (now !== before) rows.push(['Ranking', `${before} before the fight, ${now} now`]);
    else if (!table || table.updatedOn <= bout.date) rows.push(['Ranking', `${before}. Rankings update next week`]);
    else rows.push(['Ranking', `${before}, unchanged`]);
  }

  return (
    <div className="mt">
      <h3>Aftermath</h3>
      <KeyValues rows={rows} />
    </div>
  );
}
