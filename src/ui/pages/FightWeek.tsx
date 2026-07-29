import { useState } from 'react';
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
import { answerQuestion, createSession, faceoffChoices, presserRng } from '@core/world/presser';
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
import { addHypeMoment, findRivalry, hypeStore } from '@core/world/hype';
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
  const [note, setNote] = useState<string | null>(null);

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
  const nextTask = tasks.find((t) => t.status !== 'complete' && t.status !== 'skipped' && t.dueOn <= save.date) ?? null;

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
    if (outcome.ok) setNote(outcome.headlines[0] ?? null);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Fight week</h1>
        <span className="sub">
          {me?.name} against {opponent?.name} · <Link to={`/event/${event?.id}`}>{event?.name}</Link> ·{' '}
          {formatDate(bout.date)}
        </span>
      </div>

      {note && <Notice kind="good">{note}</Notice>}

      <div className="grid c2">
        <Panel title="Schedule">
          <ul className="stage-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <span className="when">{formatDate(t.dueOn)}</span>
                <span style={{ flex: 1 }}>
                  {stageLabel(t.stage)}
                  {t.mandatory && <span className="tag warn" style={{ marginLeft: 6 }}>required</span>}
                </span>
                <span className={t.status === 'complete' ? 'done' : t.status === 'skipped' ? 'dim' : 'pending'}>
                  {t.status === 'complete' ? 'Done' : t.status === 'skipped' ? 'Skipped' : t.dueOn <= save.date ? 'Due now' : 'Upcoming'}
                </span>
              </li>
            ))}
          </ul>
          {tasks.every((t) => t.status === 'complete' || t.status === 'skipped') && (
            <p className="small dim mt">Every stage is done. The next step is the fight itself.</p>
          )}
        </Panel>

        <Panel title="Where you stand">
          <KeyValues
            rows={[
              ['Opponent', opponent?.name ?? 'Unknown'],
              ['Event', event?.name ?? 'Unknown'],
              ['Date', formatDate(bout.date)],
              ['Contracted weight', `${bout.contractedWeightLb} lb`],
              ['Rounds', bout.scheduledRounds],
              ['Championship', bout.isTitleFight ? 'Undisputed title' : bout.isInterimTitleFight ? 'Interim title' : 'No'],
              ['Next stage', nextTask ? stageLabel(nextTask.stage) : 'Nothing outstanding'],
            ]}
          />
        </Panel>
      </div>

      {nextTask && (
        <StagePanel
          task={nextTask}
          save={save}
          busy={busy}
          onComplete={(work) => void runStage(nextTask, work)}
          mutate={mutate}
          navigate={navigate}
        />
      )}

      {tasks.filter((t) => t.status === 'complete' && t.outcome).length > 0 && (
        <Panel title="What has happened so far">
          <ul className="small">
            {tasks
              .filter((t) => t.status === 'complete' && t.outcome)
              .map((t) => (
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
    case 'ceremonial-weigh-in':
      return <FaceoffStage task={task} busy={busy} onComplete={onComplete} mutate={mutate} />;
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
  let session = save.pressers?.[sessionId] ?? null;
  if (!session) {
    session = mutate((s) => createSession(s, task.boutId, kind, presserRng(s, task.boutId, kind))) ?? null;
  }
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

  let state = save.weighIns?.[task.boutId] ?? null;
  if (!state) {
    state = mutate((s) => beginWeighIn(s, task.boutId)) ?? null;
  }
  const projection = forecast(save, task.boutId);

  if (!state) return <SimpleStage task={task} busy={busy} onComplete={onComplete} />;

  return (
    <Panel title="Official weigh in">
      <div className="weigh-in-stage">
        <div className="row mb">
          <span className="tag">{WEIGH_IN_STAGE_LABEL[state.stage]}</span>
          <span className="small dim">
            Contracted at {state.limitLb} lb
            {state.isChampionship ? ', championship limit with no allowance' : `, with a ${state.allowanceLb} lb allowance`}
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
            <button className="primary" disabled={busy} onClick={() => mutate((s) => resolveOpponentDecision(s, task.boutId, new Rng(s.rng)))}>
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
            <Notice kind={state.boutStatus === 'canceled' ? 'bad' : state.ineligible.length > 0 ? 'warn' : 'good'}>
              {state.rulingText}
            </Notice>
            <KeyValues
              rows={[
                ['Bout status', state.boutStatus === 'canceled' ? 'Canceled' : state.boutStatus === 'catchweight' ? 'Proceeding at catchweight' : 'Proceeding as contracted'],
                ['Purse forfeit', state.forfeitAmount > 0 ? formatMoney(state.forfeitAmount) : 'None'],
                ['Title eligible', state.isChampionship ? (state.ineligible.length === 0 ? 'Both fighters' : state.ineligible.length === 2 ? 'Neither fighter' : `${save.fighters[state.ineligible.includes(me?.id ?? '') ? opponent?.id ?? '' : me?.id ?? '']?.name ?? 'One fighter'} only`) : 'Not a title bout'],
                ['Media', state.mediaLine ?? ''],
              ]}
            />
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

function FaceoffStage({ task, busy, onComplete, mutate }: { task: FightWeekTask; busy: boolean; onComplete: (w: () => string) => void; mutate: ReturnType<typeof useGame.getState>['mutate'] }) {
  const save = useGame((s) => s.save)!;
  const bout = save.bouts[task.boutId];
  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  const opponent = me && bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;
  // The real rivalry intensity, so a heated build actually unlocks the confrontational
  // option rather than the list always looking the same.
  const rivalry = me && opponent ? findRivalry(save, me.id, opponent.id)?.intensity ?? 0 : 0;
  const choices = faceoffChoices(rivalry);

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
                  const h = hypeStore(s)[task.boutId];
                  if (h && c.effects.hype) {
                    h.total = Math.max(0, Math.min(100, h.total + c.effects.hype));
                    addHypeMoment(s, task.boutId, `Faceoff: ${c.label}`, c.effects.hype);
                  }
                  const f = s.player.fighterId ? s.fighters[s.player.fighterId] : null;
                  if (f?.fame) {
                    f.fame.controversy = Math.max(0, Math.min(100, f.fame.controversy + (c.effects.controversy ?? 0)));
                    f.fame.favorability = Math.max(0, Math.min(100, f.fame.favorability + (c.effects.favorability ?? 0)));
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
