import type { CSSProperties, ReactNode } from 'react';
import { formatClock } from '@core/types/common';
import { isFinish, METHOD_LABEL, type FightEvent, type FightResult, type FinishMethod, type RoundStatLine } from '@core/types/fight';
import { cornerAdvice, momentBanner } from '@core/narrative/broadcast';
import {
  momentOf,
  MOMENT_LABEL,
  roundRead,
  summarizeRound,
  type LiveSide,
  type LiveState,
  type MomentKind,
} from '@core/world/playback';

/**
 * The broadcast around a fight: the scoreboard, the banner on a big moment, the card between
 * rounds and the result as it is read out.
 *
 * Everything here is drawn from what playback has already revealed. The page decides how far the
 * fight has got; these components never look further ahead than they are told.
 */

export interface Corner {
  name: string;
  lastName: string;
  record: string;
}

/** The headline word for each way a fight can end, as a broadcast would put it on screen. */
const HERO_METHOD: Record<FinishMethod, string> = {
  ko: 'Knockout',
  'tko-strikes': 'Technical knockout',
  'tko-ground-strikes': 'TKO by ground and pound',
  submission: 'Submission',
  'technical-submission': 'Technical submission',
  'doctor-stoppage': 'Doctor stoppage',
  'corner-stoppage': 'Corner stoppage',
  retirement: 'Retirement',
  'decision-unanimous': 'Unanimous decision',
  'decision-split': 'Split decision',
  'decision-majority': 'Majority decision',
  'draw-unanimous': 'Unanimous draw',
  'draw-split': 'Split draw',
  'draw-majority': 'Majority draw',
  disqualification: 'Disqualification',
  'no-contest': 'No contest',
  'technical-decision': 'Technical decision',
  'technical-draw': 'Technical draw',
} as Record<FinishMethod, string>;

export function heroMethod(method: FinishMethod): string {
  return HERO_METHOD[method] ?? METHOD_LABEL[method];
}

/** The tone a moment is shown in. Damage is red, danger amber, control neutral. */
export function momentTone(kind: MomentKind | null): string {
  switch (kind) {
    case 'finish':
    case 'knockdown':
      return 'hot';
    case 'rocked':
    case 'submission-danger':
    case 'cut':
      return 'warm';
    case 'deduction':
    case 'doctor':
      return 'ref';
    case null:
      return '';
    default:
      return 'cool';
  }
}

function Meter({ value, side, tone, label }: { value: number; side: 'a' | 'b'; tone?: string; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={`fb-meter ${side}${tone ? ` ${tone}` : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function SideStats({ s, side }: { s: LiveSide; side: 'a' | 'b' }) {
  const bits: string[] = [];
  if (s.knockdowns) bits.push(`KD ${s.knockdowns}`);
  if (s.rocked) bits.push(`Rocked ${s.rocked}`);
  bits.push(`TD ${s.takedowns}`);
  if (s.submissionAttempts) bits.push(`Sub ${s.submissionAttempts}`);
  if (s.cardio !== null) bits.push(`Cardio ${Math.round(s.cardio)}`);
  return <div className={`fb-pips ${side}`}>{bits.join(' · ')}</div>;
}

export interface BannerInfo {
  key: string;
  kind: MomentKind;
  label: string;
  line: string;
}

/** The banner for the most recent big moment, while it is still the latest thing that happened. */
export function bannerFor(result: FightResult, events: FightEvent[], index: number | null, names: Record<string, string>): BannerInfo | null {
  if (index === null) return null;
  const e = events[index];
  const kind = momentOf(e);
  if (!e || !kind) return null;
  const line = momentBanner(kind, names[e.actorId] ?? '', names[e.defenderId] ?? '', e.seq, kind === 'finish' ? result.method : undefined);
  if (!line) return null;
  return { key: `${e.seq}`, kind, label: kind === 'finish' ? heroMethod(result.method) : MOMENT_LABEL[kind], line };
}

/**
 * The scoreboard. It sticks to the top of the screen while the fight plays, so the round, the
 * clock and who is winning the exchanges are always in view while the commentary scrolls.
 */
export function Scoreboard({
  a,
  b,
  live,
  scheduledRounds,
  status,
  banner,
  hornRound,
  final,
}: {
  a: Corner;
  b: Corner;
  live: LiveState;
  scheduledRounds: number;
  status: string;
  banner: BannerInfo | null;
  /** Set between rounds, when the clock shows the horn of this round. */
  hornRound: number | null;
  /** The fight is over, so the round bar is the round as it ended rather than so far. */
  final: boolean;
}) {
  const momentumPct = Math.abs(live.momentum) * 50;
  const leaning = Math.abs(live.momentum) < 0.08 ? 'even' : live.momentum > 0 ? 'a' : 'b';
  const momentumStyle: CSSProperties =
    leaning === 'a' ? { left: `${50 - momentumPct}%`, width: `${momentumPct}%` } : { left: '50%', width: `${leaning === 'b' ? momentumPct : 0}%` };
  const shareA = Math.round(live.roundShareA * 100);
  return (
    <div className="fight-scoreboard" aria-label="Scoreboard">
      <div className="fb-row fb-top">
        <div className={`fb-name a${live.a.inTrouble ? ' trouble' : ''}`}>
          <span className="fb-corner a" aria-hidden="true" />
          <span className="fb-full">{a.name}</span>
          <span className="fb-last">{a.lastName}</span>
          <span className="fb-record">{a.record}</span>
          {live.a.inTrouble && <span className="fb-flag">Hurt</span>}
        </div>
        <div className="fb-clock" aria-live="off">
          <span className="fb-round">
            R{hornRound ?? live.round}
            <span className="fb-of">/{scheduledRounds}</span>
          </span>
          <span className="fb-time">{hornRound ? '0:00' : formatClock(live.clockSecondsRemaining)}</span>
          <span className="fb-status">{status}</span>
        </div>
        <div className={`fb-name b${live.b.inTrouble ? ' trouble' : ''}`}>
          {live.b.inTrouble && <span className="fb-flag">Hurt</span>}
          <span className="fb-record">{b.record}</span>
          <span className="fb-full">{b.name}</span>
          <span className="fb-last">{b.lastName}</span>
          <span className="fb-corner b" aria-hidden="true" />
        </div>
      </div>

      <div className="fb-row fb-bars">
        <div className="fb-side a">
          <div className="fb-meter-label">
            <span>Damage</span>
            <span className="fb-dim">{live.a.damageLabel}</span>
          </div>
          <Meter value={live.a.damage} side="a" tone={live.a.damage >= 65 ? 'bad' : live.a.damage >= 35 ? 'warn' : ''} label={`${a.lastName} damage`} />
        </div>
        <div className="fb-center">
          <div className="fb-meter-label center">
            <span>Momentum</span>
          </div>
          <div className="fb-momentum" role="img" aria-label={leaning === 'even' ? 'Momentum even' : `Momentum with ${leaning === 'a' ? a.lastName : b.lastName}`}>
            <span className={`fb-momentum-fill ${leaning}`} style={momentumStyle} />
            <span className="fb-momentum-mid" />
          </div>
          <div className="fb-meter-label center fb-share-label">
            <span>
              Round {hornRound ?? live.round}
              {hornRound || final ? '' : ' so far'}
            </span>
          </div>
          <div className="fb-share" role="img" aria-label={`Round so far: ${a.lastName} ${shareA} percent, ${b.lastName} ${100 - shareA} percent`}>
            <span className="fb-share-a" style={{ width: `${shareA}%` }} />
            <span className="fb-share-b" style={{ width: `${100 - shareA}%` }} />
          </div>
        </div>
        <div className="fb-side b">
          <div className="fb-meter-label">
            <span className="fb-dim">{live.b.damageLabel}</span>
            <span>Damage</span>
          </div>
          <Meter value={live.b.damage} side="b" tone={live.b.damage >= 65 ? 'bad' : live.b.damage >= 35 ? 'warn' : ''} label={`${b.lastName} damage`} />
        </div>
      </div>

      <div className="fb-row fb-foot">
        <SideStats s={live.a} side="a" />
        <SideStats s={live.b} side="b" />
      </div>

      {banner && (
        <div key={banner.key} className={`fb-banner ${momentTone(banner.kind)}`} role="status" aria-live="assertive">
          <span className="fb-banner-label">{banner.label}</span>
          <span className="fb-banner-line">{banner.line}</span>
        </div>
      )}
    </div>
  );
}

function MirrorStat({ label, a, b, format }: { label: string; a: number; b: number; format?: (n: number) => string }) {
  const total = a + b;
  const pa = total > 0 ? (a / total) * 100 : 50;
  const f = format ?? ((n: number) => String(Math.round(n)));
  return (
    <div className="br-stat">
      <span className={`br-num a${a > b ? ' lead' : ''}`}>{f(a)}</span>
      <div className="br-bar" aria-hidden="true">
        <span className="br-bar-a" style={{ width: `${pa}%` }} />
        <span className="br-bar-b" style={{ width: `${100 - pa}%` }} />
      </div>
      <span className={`br-num b${b > a ? ' lead' : ''}`}>{f(b)}</span>
      <span className="br-label">{label}</span>
    </div>
  );
}

/**
 * Whether a fighter goes back to the corner still hurt: dropped in the round, or rocked late in it.
 * A fighter wobbled in the first minute who then ran the round has recovered, and a corner telling
 * him to survive would contradict the card above it.
 */
function hurtInRound(events: FightEvent[], round: number, fighterId: string): boolean {
  return events.some(
    (e) =>
      e.round === round &&
      e.defenderId === fighterId &&
      (momentOf(e) === 'knockdown' || (momentOf(e) === 'rocked' && e.clockSecondsRemaining <= 90))
  );
}

function damageTaken(events: FightEvent[], round: number, fighterId: string, part: 'head' | 'legs'): number {
  return events
    .filter((e) => e.round === round && e.defenderId === fighterId)
    .reduce((t, e) => t + (part === 'head' ? e.damage.head : e.damage.legLeft + e.damage.legRight), 0);
}

/**
 * The card between rounds: what the round was, what each corner is saying, and a viewer's read of
 * the scorecards. The judges' own numbers stay hidden unless the setting reveals them.
 */
export function BetweenRounds({
  result,
  round,
  a,
  b,
  revealScores,
  live,
  paused,
  intermissionMs,
  onContinue,
}: {
  result: FightResult;
  round: number;
  a: Corner;
  b: Corner;
  revealScores: boolean;
  live: boolean;
  paused: boolean;
  intermissionMs: number;
  onContinue: () => void;
}) {
  const r = result.rounds.find((x) => x.round === round);
  const summary = summarizeRound(result, round, a.lastName, b.lastName);
  const events = result.events ?? [];
  const sa = r?.statsA;
  const sb = r?.statsB;
  const next = round + 1;
  const finalNext = next === result.scheduledRounds;
  const read = roundRead(result, round, a.lastName, b.lastName);

  // A viewer's tally of the rounds so far, from the same reads the round summaries use.
  let tallyA = 0;
  let tallyB = 0;
  let even = 0;
  for (let i = 1; i <= round; i++) {
    const rr = roundRead(result, i, a.lastName, b.lastName);
    if (!rr) continue;
    if (rr.leader === 'a') tallyA++;
    else if (rr.leader === 'b') tallyB++;
    else even++;
  }

  const corner = (side: 'a' | 'b', mine: RoundStatLine, theirs: RoundStatLine) => {
    const id = side === 'a' ? result.fighterAId : result.fighterBId;
    const won = read?.leader === side;
    const lost = read?.leader !== null && read?.leader !== undefined && read.leader !== side;
    return cornerAdvice(
      {
        round,
        mine,
        theirs,
        stamina: side === 'a' ? r?.staminaEndA : r?.staminaEndB,
        wasHurt: hurtInRound(events, round, id),
        headDamageTaken: damageTaken(events, round, id, 'head'),
        legDamage: damageTaken(events, round, id, 'legs'),
        read: won ? 'won' : lost ? 'lost' : 'even',
        standing: side === 'a' ? tallyA - tallyB : tallyB - tallyA,
        finalRoundNext: finalNext,
      },
      result.seed,
      side
    );
  };

  return (
    <div className="between-rounds fb-card" role="region" aria-label={`End of round ${round}`}>
      <div className="br-head">
        <span className="br-kicker">End of round {round}</span>
        <span className="br-next">{finalNext ? 'Final round next' : `Round ${next} of ${result.scheduledRounds} next`}</span>
      </div>
      <p className="br-headline">{summary.headline}</p>
      {r?.summary && <p className="small br-analyst">{r.summary}</p>}

      <div className="br-body">
        {sa && sb && (
          <div className="br-stats">
            <div className="br-names">
              <span className="a">{a.lastName}</span>
              <span className="b">{b.lastName}</span>
            </div>
            <MirrorStat label="Significant strikes" a={sa.sigStrikesLanded} b={sb.sigStrikesLanded} />
            {(sa.knockdowns > 0 || sb.knockdowns > 0) && <MirrorStat label="Knockdowns" a={sa.knockdowns} b={sb.knockdowns} />}
            {(sa.takedownsAttempted > 0 || sb.takedownsAttempted > 0) && <MirrorStat label="Takedowns" a={sa.takedownsLanded} b={sb.takedownsLanded} />}
            {(sa.submissionAttempts > 0 || sb.submissionAttempts > 0) && <MirrorStat label="Submission attempts" a={sa.submissionAttempts} b={sb.submissionAttempts} />}
            {sa.controlSeconds + sb.controlSeconds > 15 && (
              <MirrorStat label="Control time" a={sa.controlSeconds} b={sb.controlSeconds} format={(n) => formatClock(Math.round(n))} />
            )}
            {r?.staminaEndA !== undefined && r?.staminaEndB !== undefined && (
              <MirrorStat label="Cardio at the horn" a={r.staminaEndA} b={r.staminaEndB} />
            )}
          </div>
        )}

        <div className="br-side">
          {sa && sb && (
            <div className="br-corners">
              <p>
                <span className="br-corner a">{a.lastName}'s corner</span> {corner('a', sa, sb)}
              </p>
              <p>
                <span className="br-corner b">{b.lastName}'s corner</span> {corner('b', sb, sa)}
              </p>
            </div>
          )}

          {read && (
            <p className="small br-read">
              <strong>Ringside read:</strong> round {round} {read.leader ? 'to ' : 'is '}
              {read.text}. Unofficially, {a.lastName} {tallyA}, {b.lastName} {tallyB}
              {even ? `, ${even} too close to call` : ''}.
              {revealScores && r && (
                <span className="mono br-margin" title="Exact round margin, revealed by a setting">
                  {' '}
                  Margin {r.trueScoreA > 0 ? '+' : ''}
                  {r.trueScoreA.toFixed(1)}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="br-foot">
        {live && !paused && (
          <div className="br-countdown" aria-hidden="true">
            <span key={round} style={{ animationDuration: `${intermissionMs}ms` }} />
          </div>
        )}
        <button className="primary" onClick={onContinue}>
          {live ? `Start round ${next} now` : `Continue to round ${next}`}
        </button>
        {live && <span className="small dim">{paused ? 'Paused between rounds.' : `Round ${next} starts in a moment.`}</span>}
      </div>
    </div>
  );
}

/**
 * The result as it is read out. A finish names the method the moment it lands; a decision reads
 * the judges' cards one at a time before the winner. While it is reading, the rest of the page
 * still treats the result as hidden.
 */
export function ResultReveal({
  result,
  names,
  step,
  concluded,
  playerId,
  onShowNow,
  banner,
}: {
  result: FightResult;
  names: Record<string, string>;
  /** For a decision, how many cards have been read; the winner follows the last. */
  step: number;
  concluded: boolean;
  playerId: string | null;
  onShowNow: () => void;
  banner: BannerInfo | null;
}) {
  const decision = !isFinish(result.method) && result.method !== 'disqualification';
  const winner = result.winnerId ? names[result.winnerId] : null;
  const loserId = result.winnerId ? (result.winnerId === result.fighterAId ? result.fighterBId : result.fighterAId) : null;
  const loser = loserId ? names[loserId] : null;
  const where = `Round ${result.endRound}, ${formatClock(result.endTimeSeconds)}`;
  const playerIn = playerId !== null && (playerId === result.fighterAId || playerId === result.fighterBId);
  const verdict: ReactNode =
    concluded && playerIn ? (
      result.winnerId === playerId ? (
        <span className="rr-verdict good">Your fighter wins</span>
      ) : result.winnerId ? (
        <span className="rr-verdict bad">Your fighter loses</span>
      ) : (
        <span className="rr-verdict">No winner</span>
      )
    ) : null;

  if (decision) {
    const cards = result.scorecards;
    const read = concluded ? cards.length : Math.min(step, cards.length);
    const winnerReady = concluded;
    return (
      <div className={`result-reveal decision${concluded ? ' done' : ''}`} aria-live="polite">
        <div className="rr-kicker">{concluded ? 'Official result' : 'The scorecards'}</div>
        {cards.length > 0 ? (
          <ol className="rr-cards">
            {cards.map((c, i) => {
              const shown = i < read;
              const forName = c.totalA === c.totalB ? 'even' : c.totalA > c.totalB ? names[result.fighterAId] : names[result.fighterBId];
              return (
                <li key={c.judgeName} className={shown ? 'shown' : 'waiting'}>
                  <span className="rr-judge">{c.judgeName}</span>
                  {shown ? (
                    <span className="rr-score">
                      <strong className="mono">
                        {Math.max(c.totalA, c.totalB)}-{Math.min(c.totalA, c.totalB)}
                      </strong>{' '}
                      {forName === 'even' ? 'even' : forName}
                    </span>
                  ) : (
                    <span className="rr-score dim">...</span>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          !concluded && <p className="dim">The scorecards are being collected.</p>
        )}
        {winnerReady ? (
          <div className="rr-winner">
            {winner ? (
              <>
                <span className="rr-name">{winner}</span>
                <span className="rr-method">wins by {heroMethod(result.method).toLowerCase()}</span>
              </>
            ) : (
              <span className="rr-name">{heroMethod(result.method)}</span>
            )}
            {verdict}
          </div>
        ) : (
          <div className="rr-foot">
            <span className="small dim">{read >= cards.length ? 'And the winner...' : 'Reading the cards.'}</span>
            <button className="small" onClick={onShowNow}>
              Show the result
            </button>
          </div>
        )}
        {concluded && <TotalsStrip result={result} names={names} />}
      </div>
    );
  }

  if (!concluded) {
    return (
      <div className={`result-reveal finish pending ${momentTone('finish')}`} aria-live="polite">
        <div className="rr-kicker">{banner?.label ?? 'It is over'}</div>
        <p className="rr-call">{banner?.line ?? 'The referee waves it off.'}</p>
        <div className="rr-foot">
          <span className="small dim">The official result is coming.</span>
          <button className="small" onClick={onShowNow}>
            Show the result
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`result-reveal finish done ${momentTone('finish')}`} aria-live="polite">
      <div className="rr-kicker">{heroMethod(result.method)}</div>
      <div className="rr-winner">
        <span className="rr-name">{winner ?? heroMethod(result.method)}</span>
        {loser && <span className="rr-method">defeats {loser}</span>}
        {verdict}
      </div>
      <p className="rr-where">
        {where}
        {result.submissionName ? ` · ${result.submissionName.split('-').join(' ')}` : ''}
      </p>
      <TotalsStrip result={result} names={names} />
    </div>
  );
}

function TotalsStrip({ result, names }: { result: FightResult; names: Record<string, string> }) {
  const a = result.totalsA;
  const b = result.totalsB;
  const rows: [string, number, number][] = [
    ['Sig strikes', a.sigStrikesLanded, b.sigStrikesLanded],
    ['Takedowns', a.takedownsLanded, b.takedownsLanded],
  ];
  if (a.knockdowns + b.knockdowns > 0) rows.push(['Knockdowns', a.knockdowns, b.knockdowns]);
  if (a.submissionAttempts + b.submissionAttempts > 0) rows.push(['Sub attempts', a.submissionAttempts, b.submissionAttempts]);
  return (
    <div className="rr-totals">
      <span className="rr-totals-names">
        {names[result.fighterAId]} <span className="dim">and</span> {names[result.fighterBId]}
      </span>
      {rows.map(([label, x, y]) => (
        <span key={label} className="rr-total">
          <span className="dim">{label}</span> <strong className="mono">{x}-{y}</strong>
        </span>
      ))}
    </div>
  );
}
