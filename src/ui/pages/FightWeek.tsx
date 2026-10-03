import { useEffect, useState } from 'react';
import { PageTip } from '../Guide';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rng } from '@core/rng';
import { formatDate, formatMoney } from '@core/types/common';
import {
  completeStage,
  skipStage,
  stageLabel,
  tasksForBout,
  type FightWeekTask,
} from '@core/world/fightweek';
import { answerQuestion, applyMediaEffects, createSession, faceoffChoices, presserRng } from '@core/world/presser';
import type { SocialEffects } from '@core/world/social';
import {
  acceptOpponentMiss,
  applySecondAttempt,
  beginWeighIn,
  forecast,
  resolveOpponentDecision,
  secondAttemptOptions,
  stepWeighIn,
  WEIGH_IN_STAGE_LABEL,
  type SecondAttemptChoice,
} from '@core/world/weighin';
import { findRivalry } from '@core/world/hype';
import { KeyValues, Notice, Panel } from '../components';
import { useGame } from '../store';

/**
 * Fight week.
 *
 * Every stage is a real page state with a visible outcome. Nothing here resolves during a
 * calendar advance: the advance controller stops when a mandatory stage is due and sends
 * the player here, and each stage records its result exactly once.
 */
export function FightWeekPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const busy = useGame((s) => s.busy);
  const runOperation = useGame((s) => s.runOperation);
  const navigate = useNavigate();
  const { boutId } = useParams();
  // The last stage's outcome, kept with the day it happened. It used to stay at the top through
  // every later stage of the week; stages on one day resolve back to back, so the note lasts the
  // day and a day advance clears it. Clearing it when the next stage changed would wipe it the
  // moment it was set, since completing a stage is what changes the next one.
  const [noteState, setNote] = useState<{ text: string; on: string } | null>(null);
  const note = noteState && noteState.on === save.date ? noteState.text : null;

  const bout = boutId ? save.bouts[boutId] : null;
  if (!bout) {
    return (
      <div className="page">
        <Notice kind="bad">That bout does not exist in this save.</Notice>
      </div>
    );
  }
  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  const opponent = me ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;
  const event = save.events[bout.eventId];
  const tasks = tasksForBout(save, bout.id);
  // The same rule careerStatus uses: a due mandatory stage comes first. Taking the first due stage
  // in order put an optional media day in front of the weigh in while the dock pointed at the
  // weigh in, so the page and the button disagreed about what came next.
  const due = tasks.filter((t) => t.status !== 'complete' && t.status !== 'skipped' && t.dueOn <= save.date);
  const nextTask = due.find((t) => t.mandatory) ?? due[0] ?? null;
  // A stage has happened once it is resolved and its day has come. Arrival and the medical record
  // themselves as done when fight week is created, days before their date, so status alone showed
  // 'Done' and narrated 'You arrived' while the calendar was still the day before.
  const happened = (t: FightWeekTask) => t.status === 'complete' && (t.resolvedOn ?? t.dueOn) <= save.date;
  const happenedSoFar = tasks.filter((t) => happened(t) && t.outcome);
  const scheduled = bout.status === 'scheduled';
  // The next stage names what is coming even when nothing is due today, so a mandatory weigh in
  // two days out no longer reads as 'Nothing outstanding'.
  const upcoming = tasks.find((t) => !happened(t) && t.status !== 'skipped') ?? null;
  const nextLabel = nextTask
    ? stageLabel(nextTask.stage)
    : scheduled && upcoming
      ? `${stageLabel(upcoming.stage)} on ${formatDate(upcoming.dueOn)}`
      : 'Nothing outstanding';
  const allDone = scheduled && tasks.length > 0 && tasks.every((t) => happened(t) || t.status === 'skipped');

  const runStage = async (task: FightWeekTask, work: () => string) => {
    const outcome = await runOperation('resolve-stage', stageLabel(task.stage), (report) => {
      report('updating-world', `Resolving ${stageLabel(task.stage).toLowerCase()}`);
      const text = work();
      return {
        ok: true,
        noOpReason: null,
        error: null,
        fromDate: save.date,
        toDate: save.date,
        daysAdvanced: 0,
        eventsResolved: [],
        headlines: [text],
        stoppedBecause: null,
        navigateTo: null,
        summary: '',
      };
    });
    const text = outcome.ok ? outcome.headlines[0] : null;
    if (text) setNote({ text, on: useGame.getState().save?.date ?? save.date });
  };

  const head = (
    <>
    <div className="page-head">
      <h1>Fight week</h1>
      <span className="sub">
        {me?.name} against {opponent?.name} · <Link to={`/event/${event?.id}`}>{event?.name}</Link> ·{' '}
        {formatDate(bout.date)}
      </span>
    </div>
      <PageTip id="fightweek" title="Fight week">
        Each stage opens on its day. Press answers move hype and your relationship with the opponent; the official weigh in decides whether you make weight. Miss it and you lose part of the purse, and a title if one is on the line.
      </PageTip>
    </>
  );

  // A canceled bout has no fight week left. Canceling clears its stages, so this page used to read
  // 'Every stage is done. The next step is the fight itself.' straight after a withdrawal, and the
  // ruling that canceled it never appeared, because the cancel happens in the same step that
  // completes the weigh in.
  if (bout.status === 'canceled') {
    const weighIn = save.weighIns?.[bout.id] ?? null;
    return (
      <div className="page">
        {head}
        <Panel title="Bout canceled">
          <Notice kind="bad">{weighIn?.rulingText ?? bout.cancelReason ?? 'This bout was canceled.'}</Notice>
          {weighIn && <WeighInSummary boutId={bout.id} />}
          {weighIn && weighIn.log.length > 0 && (
            <ul className="small dim mt">
              {weighIn.log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          <button className="primary mt" onClick={() => navigate('/dashboard')}>
            Back to the dashboard
          </button>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page">
      {head}

      {note && <Notice kind="good">{note}</Notice>}

      {/* The action leads the page. Below the schedule and the summary it sat about two screens
          down on a phone, where the dock is hidden on this page and nothing pointed to it. */}
      {!scheduled ? (
        <Panel title="The fight is over">
          <p>Fight week ended with the fight.</p>
          {bout.resultId && (
            <button className="primary" onClick={() => navigate(`/fight/${bout.id}`)}>
              See the result
            </button>
          )}
        </Panel>
      ) : (
        nextTask && (
          <StagePanel
            task={nextTask}
            save={save}
            busy={busy}
            onComplete={(work) => void runStage(nextTask, work)}
            mutate={mutate}
            navigate={navigate}
          />
        )
      )}

      <div className="grid c2">
        <Panel title="Schedule">
          <ul className="stage-list">
            {tasks.map((t) => {
              const label = happened(t)
                ? 'Done'
                : t.status === 'skipped'
                  ? 'Skipped'
                  : !scheduled
                    ? 'Not held'
                    : t.status !== 'complete' && t.dueOn <= save.date
                      ? 'Due now'
                      : 'Upcoming';
              return (
                <li key={t.id}>
                  <span className="when">{formatDate(t.dueOn)}</span>
                  <span style={{ flex: 1 }}>
                    {stageLabel(t.stage)}
                    {t.mandatory && <span className="tag warn" style={{ marginLeft: 6 }}>required</span>}
                  </span>
                  <span className={label === 'Done' ? 'done' : label === 'Skipped' || label === 'Not held' ? 'dim' : 'pending'}>{label}</span>
                </li>
              );
            })}
          </ul>
          {allDone && <p className="small dim mt">Every stage is done. The next step is the fight itself.</p>}
        </Panel>

        <Panel title="Where you stand">
          <KeyValues
            rows={[
              ['Opponent', opponent?.name ?? 'Unknown'],
              ['Event', event?.name ?? 'Unknown'],
              ['Date', formatDate(bout.date)],
              ['Contracted weight', `${bout.contractedWeightLb} lb`],
              ['Rounds', bout.scheduledRounds],
              ['Championship', bout.isTitleFight ? 'Undisputed title' : bout.isInterimTitleFight ? 'Interim title' : bout.regionalTitle ? 'Regional title' : 'No'],
              ['Next stage', nextLabel],
            ]}
          />
        </Panel>
      </div>

      {happenedSoFar.length > 0 && (
        <Panel title="What has happened so far">
          <ul className="small">
            {happenedSoFar.map((t) => (
              <li key={t.id}>
                <strong>{stageLabel(t.stage)}:</strong> {t.outcome}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/**
 * The weigh in's outcome: the ruling, the bout's status, any forfeit and the media line. Shared by
 * the weigh in panel and the canceled bout page, which is where a cancelling ruling ends up.
 */
function WeighInSummary({ boutId, showNotice = false }: { boutId: string; showNotice?: boolean }) {
  const save = useGame((s) => s.save)!;
  const state = save.weighIns?.[boutId] ?? null;
  const bout = save.bouts[boutId];
  if (!state) return null;
  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  const opponent = me && bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;
  return (
    <>
      {showNotice && (
        <Notice kind={state.boutStatus === 'canceled' ? 'bad' : state.ineligible.length > 0 ? 'warn' : 'good'}>{state.rulingText}</Notice>
      )}
      <KeyValues
        rows={[
          ['Bout status', state.boutStatus === 'canceled' ? 'Canceled' : state.boutStatus === 'catchweight' ? 'Proceeding at catchweight' : 'Proceeding as contracted'],
          ['Purse forfeit', state.forfeitAmount > 0 ? formatMoney(state.forfeitAmount) : 'None'],
          ['Title eligible', state.isChampionship ? (state.ineligible.length === 0 ? 'Both fighters' : state.ineligible.length === 2 ? 'Neither fighter' : `${save.fighters[state.ineligible.includes(me?.id ?? '') ? opponent?.id ?? '' : me?.id ?? '']?.name ?? 'One fighter'} only`) : 'Not a title bout'],
          ['Media', state.mediaLine ?? ''],
        ]}
      />
    </>
  );
}

interface StageProps {
  task: FightWeekTask;
  save: ReturnType<typeof useGame.getState>['save'];
  busy: boolean;
  onComplete: (work: () => string) => void;
  mutate: ReturnType<typeof useGame.getState>['mutate'];
  navigate: ReturnType<typeof useNavigate>;
}

function StagePanel({ task, save, busy, onComplete, mutate, navigate }: StageProps) {
  if (!save) return null;
  switch (task.stage) {
    case 'press-conference':
    case 'media-day':
      return <PresserStage task={task} busy={busy} onComplete={onComplete} mutate={mutate} />;
    case 'official-weigh-in':
    case 'second-weigh-in-attempt':
      return <WeighInStagePanel task={task} busy={busy} onComplete={onComplete} mutate={mutate} />;
    case 'faceoff':
      return <FaceoffStage task={task} busy={busy} onComplete={onComplete} mutate={mutate} />;
    // The ceremonial weigh in is its own occasion, not a second faceoff. Routing both here meant
    // the same choices were offered twice on the same day and their effects applied twice.
    case 'ceremonial-weigh-in':
      return <CeremonialWeighInStage task={task} busy={busy} onComplete={onComplete} mutate={mutate} />;
    case 'fight-night':
      return (
        <Panel title="Fight night">
          <p>Everything before the fight is done. The only thing left is the walk.</p>
          <button className="primary" disabled={busy} onClick={() => navigate(`/fight/${task.boutId}`)}>
            Enter fight
          </button>
        </Panel>
      );
    default:
      return <SimpleStage task={task} busy={busy} onComplete={onComplete} />;
  }
}

/** Stages that are an acknowledgement rather than a decision. */
function SimpleStage({ task, busy, onComplete }: { task: FightWeekTask; busy: boolean; onComplete: (w: () => string) => void }) {
  const { save } = useGame.getState();
  return (
    <Panel title={stageLabel(task.stage)}>
      <p>{task.detail}</p>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            onComplete(() => {
              if (!save) return 'Done.';
              completeStage(save, task.id, `${stageLabel(task.stage)} completed.`);
              return `${stageLabel(task.stage)} done.`;
            })
          }
        >
          {busy ? 'Working...' : task.actionLabel}
        </button>
        {!task.mandatory && (
          <button
            disabled={busy}
            onClick={() =>
              onComplete(() => {
                if (!save) return 'Skipped.';
                skipStage(save, task.id, 'Declined the obligation.');
                return `${stageLabel(task.stage)} skipped.`;
              })
            }
          >
            Skip it
          </button>
        )}
      </div>
      {!task.mandatory && <p className="small dim mt">Optional. Skipping costs a little attention and goodwill.</p>}
    </Panel>
  );
}

function PresserStage({ task, busy, onComplete, mutate }: { task: FightWeekTask; busy: boolean; onComplete: (w: () => string) => void; mutate: ReturnType<typeof useGame.getState>['mutate'] }) {
  const save = useGame((s) => s.save)!;
  const revision = useGame((s) => s.revision);
  void revision;
  const kind = task.stage === 'media-day' ? 'media-day' : 'press-conference';
  const sessionId = `presser-${task.boutId}-${kind}`;
  const session = save.pressers?.[sessionId] ?? null;

  // Creating the session writes to the save, so it happens in an effect rather than during
  // render. Writing persisted state while rendering runs twice under strict mode and makes the
  // component's output depend on a side effect it has just performed.
  useEffect(() => {
    if (session) return;
    mutate((s) => createSession(s, task.boutId, kind, presserRng(s, task.boutId, kind)));
  }, [session, task.boutId, kind, mutate]);

  if (!session) return <SimpleStage task={task} busy={busy} onComplete={onComplete} />;

  const answered = session.questions.filter((q) => q.selectedKey).length;
  const allAnswered = answered === session.questions.length;

  return (
    <Panel title={stageLabel(task.stage)}>
      <p className="small dim">
        {answered} of {session.questions.length} questions answered.
      </p>
      {session.questions.map((q) => (
        <div key={q.id} className="social-item">
          <div className="src">Asked by {q.askedBy}</div>
          <p>
            <strong>{q.text}</strong>
          </p>
          {q.selectedKey ? (
            <>
              <p className="small">{q.answers.find((a) => a.key === q.selectedKey)?.text}</p>
              <p className="small dim">{q.reaction}</p>
            </>
          ) : (
            <div className="replies">
              {q.answers.map((a) => (
                <button
                  key={a.key}
                  className="small"
                  disabled={busy}
                  style={{ textAlign: 'left' }}
                  onClick={() =>
                    mutate((s) => {
                      const rng = new Rng(s.rng);
                      answerQuestion(s, sessionId, q.id, a.key, rng);
                      s.rng = rng.getState();
                    })
                  }
                >
                  <strong>{a.label}:</strong> {a.text}
                  {a.risk && <div className="reply-risk">{a.risk}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {allAnswered && (
        <>
          <p>
            <strong>{session.summary}</strong>
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              onComplete(() => {
                completeStage(save, task.id, session!.summary ?? 'Session complete.');
                return session!.summary ?? 'Session complete.';
              })
            }
          >
            Leave the room
          </button>
        </>
      )}
    </Panel>
  );
}

function WeighInStagePanel({ task, busy, onComplete, mutate }: { task: FightWeekTask; busy: boolean; onComplete: (w: () => string) => void; mutate: ReturnType<typeof useGame.getState>['mutate'] }) {
  const save = useGame((s) => s.save)!;
  const revision = useGame((s) => s.revision);
  void revision;
  const bout = save.bouts[task.boutId];
  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  const opponent = me && bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;

  const state = save.weighIns?.[task.boutId] ?? null;
  const projection = forecast(save, task.boutId);

  // Beginning the weigh in writes persisted state, so it happens in an effect rather than during
  // render. A render that performs a side effect runs twice under strict mode and makes the
  // component's output depend on work it has just done.
  useEffect(() => {
    if (state) return;
    mutate((s) => beginWeighIn(s, task.boutId));
  }, [state, task.boutId, mutate]);

  if (!state) return <SimpleStage task={task} busy={busy} onComplete={onComplete} />;

  return (
    <Panel title="Official weigh in">
      <div className="weigh-in-stage">
        <div className="row mb">
          <span className="tag">{WEIGH_IN_STAGE_LABEL[state.stage]}</span>
          <span className="small dim">
            {/* The contracted weight already includes the non title allowance. 'Contracted at 156 lb,
                with a 1 lb allowance' read as a 157 lb limit. A catchweight is its own number. */}
            {state.isChampionship
              ? `Limit ${state.limitLb} lb, the championship limit with no allowance`
              : state.allowanceLb > 0 && state.divisionLimitLb !== undefined && state.limitLb === state.divisionLimitLb + state.allowanceLb
                ? `Limit ${state.limitLb} lb (${state.divisionLimitLb} plus the ${state.allowanceLb} lb non title allowance)`
                : `Limit ${state.limitLb} lb, the contracted weight`}
          </span>
        </div>

        {projection && state.stage === 'player-approaching' && (
          <KeyValues
            rows={[
              ['Current weight', `${projection.currentWeightLb} lb`],
              ['Target', `${projection.targetLb} lb`],
              ['Still to come off', `${projection.remainingLb} lb`],
              ['Expected difficulty', projection.difficulty],
              ['Hydration risk', projection.hydrationRisk],
              ['Nutrition support', projection.nutritionSupport],
              ['Previous misses', projection.previousMisses],
              ['Title eligible', projection.titleEligible ? 'Yes, if you make the limit' : 'Not a title bout'],
            ]}
          />
        )}

        {state.player && (
          <p className="scale-reading">
            {me?.name}: <span className={state.player.madeWeight ? 'made' : 'missed'}>{state.player.weightLb} lb</span>
            {state.player.madeWeight ? '' : ` (${state.player.overBy} over)`}
          </p>
        )}
        {state.opponent && (
          <p className="scale-reading">
            {opponent?.name}: <span className={state.opponent.madeWeight ? 'made' : 'missed'}>{state.opponent.weightLb} lb</span>
            {state.opponent.madeWeight ? '' : ` (${state.opponent.overBy} over)`}
          </p>
        )}

        <ul className="small dim">
          {state.log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>

        {state.stage === 'second-attempt-decision' && (
          <div className="replies">
            <p>
              <strong>You are {state.player?.overBy} lb over with one hour left.</strong>
            </p>
            {secondAttemptOptions(state).map((o) => (
              <button
                key={o.key}
                className="small"
                disabled={busy}
                style={{ textAlign: 'left' }}
                onClick={() => mutate((s) => applySecondAttempt(s, task.boutId, o.key as SecondAttemptChoice))}
              >
                <strong>{o.label}:</strong> {o.detail}
                {o.risk && <div className="reply-risk">{o.risk}</div>}
              </button>
            ))}
          </div>
        )}

        {state.stage === 'catchweight-negotiation' && (
          <div className="row">
            <p>The request has gone to the other camp at {state.catchweightLb} lb.</p>
            <button className="primary" disabled={busy} onClick={() =>
                mutate((s) => {
                  const rng = new Rng(s.rng);
                  const out = resolveOpponentDecision(s, task.boutId, rng);
                  s.rng = rng.getState();
                  return out;
                })
              }>
              Hear their answer
            </button>
          </div>
        )}

        {state.stage === 'opponent-decision' && (
          <div className="replies">
            <p>
              <strong>{opponent?.name} missed weight by {state.opponent?.overBy} lb. It is your call.</strong>
            </p>
            <button className="small" disabled={busy} onClick={() => mutate((s) => acceptOpponentMiss(s, task.boutId, true))}>
              <strong>Take the fight anyway:</strong> catchweight, with a share of their purse coming to you. The belt is
              only on the line for you.
            </button>
            <button className="small" disabled={busy} onClick={() => mutate((s) => acceptOpponentMiss(s, task.boutId, false))}>
              <strong>Refuse:</strong> the bout is canceled and you keep looking.
            </button>
          </div>
        )}

        {(state.stage === 'player-approaching' ||
          state.stage === 'player-revealed' ||
          state.stage === 'opponent-approaching' ||
          state.stage === 'opponent-revealed' ||
          state.stage === 'ruling') && (
          <button className="primary" disabled={busy} onClick={() => mutate((s) => stepWeighIn(s, task.boutId))}>
            {state.stage === 'player-approaching'
              ? 'Step on the scale'
              : state.stage === 'player-revealed'
                ? 'Watch the opponent weigh in'
                : state.stage === 'opponent-approaching'
                  ? 'Reveal their weight'
                  : state.stage === 'opponent-revealed'
                    ? 'Hear the ruling'
                    : 'Confirm the ruling'}
          </button>
        )}

        {state.stage === 'complete' && (
          <>
            <WeighInSummary boutId={task.boutId} showNotice />
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                onComplete(() => {
                  completeStage(save, task.id, state!.rulingText ?? 'Weigh in complete.');
                  return state!.rulingText ?? 'Weigh in complete.';
                })
              }
            >
              Continue
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * The ceremonial weigh in: the fighter makes weight in front of a crowd, hits a pose, and the
 * two are brought together for the cameras.
 *
 * Distinct from the faceoff, which is its own stage on the same day. Both used to render the
 * same faceoff component, so the player answered the identical prompt twice and every effect it
 * carried was applied twice.
 */
function CeremonialWeighInStage({ task, busy, onComplete, mutate }: { task: FightWeekTask; busy: boolean; onComplete: (w: () => string) => void; mutate: ReturnType<typeof useGame.getState>['mutate'] }) {
  const save = useGame((s) => s.save)!;
  const bout = save.bouts[task.boutId];
  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  const opponent = me && bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;

  const choices: { key: string; label: string; detail: string; effects: SocialEffects; risk: string | null }[] = [
    {
      key: 'ceremonial-pose',
      label: 'Play to the crowd',
      detail: 'Hit the pose they came for and let the room have it.',
      effects: { hype: 5, favorability: 4 },
      risk: null,
    },
    {
      key: 'ceremonial-business',
      label: 'Keep it businesslike',
      detail: 'Step on, step off, save it for the cage.',
      effects: { promotionRelationship: 3, confidence: 2 },
      risk: null,
    },
    {
      key: 'ceremonial-callout',
      label: 'Take the microphone',
      // Deliberately not a promise to name an opponent. Naming one is a callout, which is made
      // from the career page against a chosen target, and this stage has no target to offer.
      detail: 'Sell the fight in your own words, in front of everyone.',
      effects: { hype: 7, promotionRelationship: -3, rivalry: 5 },
      risk: 'The promotion does not enjoy having its matchmaking done for it.',
    },
  ];

  return (
    <Panel title={stageLabel(task.stage)}>
      <p>
        You step on the scale in front of a full room. {opponent?.name} is waiting on the other side of the stage.
      </p>
      <div className="replies">
        {choices.map((c) => (
          <button
            key={c.key}
            className="small"
            disabled={busy}
            style={{ textAlign: 'left' }}
            onClick={() =>
              onComplete(() => {
                mutate((s) => {
                  const f = s.player.fighterId ? s.fighters[s.player.fighterId] : null;
                  if (f) {
                    const rng = new Rng(s.rng);
                    applyMediaEffects(s, f, task.boutId, c.effects, `Ceremonial weigh in: ${c.label}`, rng, 'ceremonial weigh in');
                    s.rng = rng.getState();
                  }
                  completeStage(s, task.id, `${c.label}. ${c.detail}`);
                });
                return `${c.label} at the ceremonial weigh in.`;
              })
            }
          >
            <strong>{c.label}:</strong> {c.detail}
            {c.risk && <div className="reply-risk">{c.risk}</div>}
          </button>
        ))}
      </div>
    </Panel>
  );
}

function FaceoffStage({ task, busy, onComplete, mutate }: { task: FightWeekTask; busy: boolean; onComplete: (w: () => string) => void; mutate: ReturnType<typeof useGame.getState>['mutate'] }) {
  const save = useGame((s) => s.save)!;
  const bout = save.bouts[task.boutId];
  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  const opponent = me && bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;
  // The real rivalry intensity, so a heated build actually unlocks the confrontational
  // option rather than the list always looking the same.
  const rivalry = me && opponent ? findRivalry(save, me.id, opponent.id)?.intensity ?? 0 : 0;
  const choices = faceoffChoices(rivalry, opponent);

  return (
    <Panel title={stageLabel(task.stage)}>
      <p>
        You and {opponent?.name} are brought face to face in front of the crowd. The cameras are close enough to hear
        anything you say.
      </p>
      <div className="replies">
        {choices.map((c) => (
          <button
            key={c.key}
            className="small"
            disabled={busy}
            style={{ textAlign: 'left' }}
            onClick={() =>
              onComplete(() => {
                mutate((s) => {
                  const f = s.player.fighterId ? s.fighters[s.player.fighterId] : null;
                  if (f) {
                    // The same applier the press conference uses, so the fine this option warns
                    // about is actually charged, the rivalry it promises actually moves, and the
                    // opponent focus it costs actually reaches their camp. This used to read
                    // three of the six declared effects and drop the rest.
                    const rng = new Rng(s.rng);
                    applyMediaEffects(s, f, task.boutId, c.effects, `Faceoff: ${c.label}`, rng, 'faceoff');
                    s.rng = rng.getState();
                  }
                  completeStage(s, task.id, `${c.label}. ${c.detail}`);
                });
                return `${c.label} at the faceoff.`;
              })
            }
          >
            <strong>{c.label}:</strong> {c.detail}
            {c.risk && <div className="reply-risk">{c.risk}</div>}
          </button>
        ))}
      </div>
    </Panel>
  );
}
