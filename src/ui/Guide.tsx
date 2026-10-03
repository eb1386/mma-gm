import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SaveGame } from '@core/types/save';
import { PROMOTION_NAME } from '@core/config/branding';
import { useGame } from './store';

/**
 * The first career guide.
 *
 * A new player used to land on a dense dashboard with nothing telling them what to do first, in a
 * game with offers, camps, fight week, weigh ins, contracts and a dozen other screens. The guide is
 * three small things: a welcome sheet the first time a career opens, a checklist on the dashboard
 * that ticks itself off from what the career has actually done, and a short note the first time
 * each key screen is visited. All of it can be dismissed, and all of it is remembered in the save,
 * so it never comes back once a player is done with it.
 */

type GuideState = NonNullable<SaveGame['guide']>;

function guideOf(save: SaveGame): GuideState {
  return (save.guide ??= {});
}

function useGuide() {
  const save = useGame((s) => s.save);
  const mutate = useGame((s) => s.mutate);
  const revision = useGame((s) => s.revision);
  void revision;
  // Written straight away rather than on the debounce: a player who closes the welcome and then
  // refreshes or leaves within the second would otherwise see it again.
  const update = (fn: (g: GuideState) => void) => {
    mutate((s) => fn(guideOf(s)));
    void useGame.getState().persist();
  };
  return { save, guide: save?.guide ?? {}, update };
}

interface Step {
  key: string;
  label: string;
  detail: ReactNode;
  done: boolean;
}

/** The checklist, derived from facts about the career rather than from clicks. */
function stepsFor(save: SaveGame): Step[] {
  const pid = save.player.fighterId;
  if (save.player.mode === 'coach') {
    const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
    return [
      { key: 'advance', label: 'Move time forward', detail: 'The red button is always the next step. It stops whenever something needs you.', done: save.date > save.startDate },
      { key: 'gym', label: 'Look over your gym', detail: <>Staff, fighters and money live on <Link to="/coach">Gym management</Link>.</>, done: (gym?.fighterIds.length ?? 0) > 0 && save.date > save.startDate },
      { key: 'inbox', label: 'Answer your fighters', detail: 'Fighters bring decisions to the inbox. You advise; they can say no.', done: save.inbox.some((m) => m.status === 'resolved' && m.category === 'gym') },
    ];
  }
  if (!pid) {
    return [
      { key: 'advance', label: 'Move time forward', detail: 'Use the red button, or advance a week, a month or a year at a time.', done: save.date > save.startDate },
      { key: 'rankings', label: 'Follow the divisions', detail: <>Titles, contenders and results are on <Link to="/rankings">Rankings</Link> and each division page.</>, done: false },
    ];
  }
  const me = save.fighters[pid];
  const offers = Object.values(save.fightOffers).filter((o) => o.fighterId === pid);
  const fought = (me?.boutIds.length ?? 0) > 0;
  const steps: Step[] = [
    {
      key: 'advance',
      label: 'Press the red button',
      detail: 'It is always the next step of the career: advance to an offer, plan a camp, enter the fight. It stops by itself when something needs you.',
      done: save.date > save.startDate,
    },
    {
      key: 'offer',
      label: 'Accept a fight',
      detail: 'Offers arrive in the inbox. Read who, where and for how much, ask for changes if you want, then accept or decline.',
      done: offers.some((o) => o.status === 'accepted') || fought,
    },
    {
      key: 'camp',
      label: 'Plan the training camp',
      detail: 'Choose what to train and how hard, and pick a game plan for this opponent. A good camp is how fights are won.',
      done: Object.values(save.camps).some((c) => c.fighterId === pid) || fought,
    },
    {
      key: 'fightweek',
      label: 'Get through fight week',
      detail: 'Press, the weigh in and the faceoff. Making weight matters: a miss costs part of the purse and can cost a title.',
      done: Object.values(save.fightWeek ?? {}).some((t) => t.status === 'complete') || fought,
    },
    { key: 'fight', label: 'Fight', detail: 'Choose the plan, then watch it unfold round by round.', done: fought },
  ];
  if (me?.circuit) {
    steps.push({
      key: 'regional',
      label: 'Watch the call up',
      detail: <>The <Link to="/regional">Regional page</Link> shows how close {PROMOTION_NAME} is to signing you, and why.</>,
      done: fought && (me.record.wins + me.record.losses >= 2),
    });
  }
  return steps;
}

/**
 * The save records that the welcome was seen, but writing the save is asynchronous, and a reload in
 * the same second lost the write and showed the welcome again. Local storage writes at once, so it
 * covers that window. Either record is enough to keep the sheet closed.
 */
function welcomedLocally(saveId: string): boolean {
  try {
    return localStorage.getItem(`mmagm-welcomed:${saveId}`) === '1';
  } catch {
    return false;
  }
}

function markWelcomedLocally(saveId: string): void {
  try {
    localStorage.setItem(`mmagm-welcomed:${saveId}`, '1');
  } catch {
    // Private browsing can refuse storage; the save's own flag still records it.
  }
}

/** Shown once, the first time a career is opened. */
export function WelcomeSheet() {
  const { save, guide, update } = useGuide();
  if (!save || guide.welcomed || guide.dismissed || welcomedLocally(save.saveId)) return null;
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const regional = Boolean(me?.circuit);
  const close = () => {
    markWelcomedLocally(save.saveId);
    update((g) => (g.welcomed = true));
  };
  return (
    <div className="guide-scrim" onClick={close}>
      <div className="guide-sheet" role="dialog" aria-modal="true" aria-label="Welcome" onClick={(e) => e.stopPropagation()}>
        <h2>{me ? `Welcome, ${me.name}` : save.player.mode === 'coach' ? 'Welcome, coach' : 'Welcome'}</h2>
        {me ? (
          <ol className="guide-points">
            <li>
              <strong>The red button is always the next step.</strong> It advances to the next offer, opens what needs an answer,
              and stops by itself when something needs you.
            </li>
            <li>
              <strong>Every fight follows the same arc:</strong> an offer, a training camp, fight week with the weigh in, then the
              fight itself.
            </li>
            <li>
              <strong>{regional ? 'Earn the call up.' : 'Climb the rankings.'}</strong>{' '}
              {regional
                ? `Win on the regional circuit, take the belt, and ${PROMOTION_NAME} will offer a contract. The Regional page shows how close you are.`
                : 'Win and move up the top fifteen; the number one contender gets the title shot.'}
            </li>
          </ol>
        ) : (
          <p>Time moves with the red button or by a set week, month or year. Everything in the world keeps happening without you.</p>
        )}
        <p className="small dim">A short checklist on the dashboard follows your first fight. You can hide it at any time.</p>
        <button className="primary guide-start" onClick={close}>
          {me ? 'Start the career' : 'Start'}
        </button>
      </div>
    </div>
  );
}

/** The dashboard checklist, until every step is done or the player hides it. */
export function GuideCard() {
  const { save, guide, update } = useGuide();
  if (!save || guide.dismissed) return null;
  const steps = stepsFor(save);
  if (steps.every((s) => s.done)) return null;
  const next = steps.find((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <div className="guide-card">
      <div className="guide-card-head">
        <strong>Your first fight</strong>
        <span className="small dim">
          {doneCount} of {steps.length}
        </span>
        <button className="small ghost" onClick={() => update((g) => (g.dismissed = true))}>
          Hide guide
        </button>
      </div>
      <ol className="guide-steps">
        {steps.map((s) => (
          <li key={s.key} className={s.done ? 'done' : s === next ? 'next' : ''}>
            <span className="guide-tick" aria-hidden="true">
              {s.done ? '✓' : ''}
            </span>
            <span>
              <strong>{s.label}</strong>
              {s === next && <div className="small dim">{s.detail}</div>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A one time note on a key screen. */
export function PageTip({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const { save, guide, update } = useGuide();
  if (!save || guide.dismissed || guide.seenTips?.includes(id)) return null;
  return (
    <div className="page-tip" role="note">
      <div>
        <strong>{title}</strong>
        <div className="small">{children}</div>
      </div>
      <button className="small ghost" aria-label="Dismiss this tip" onClick={() => update((g) => (g.seenTips = [...(g.seenTips ?? []), id]))}>
        Got it
      </button>
    </div>
  );
}
