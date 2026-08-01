import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { GAME_PLAN_DESCRIPTION, GAME_PLAN_LABEL } from '@core/sim/plan';
import { addDays, daysBetween, formatDate, formatMoney } from '@core/types/common';
import { RATING_KEYS, RATING_LONG_LABEL, type RatingKey } from '@core/types/fighter';
import type { CampFocus, GamePlanKey, TrainingCamp } from '@core/types/world';
import { CAMP_PRESETS, campLengthLabel, createCamp, estimateCampCost, normalizeFocus } from '@core/world/camp';
import { activeInjuries, trainingCapacityOf } from '@core/world/health';
import { useGame } from '../store';
import { planSourceLabel, recallPlan, rememberPlan } from '@core/world/gameplan-memory';
import { Bar, KeyValues, Notice, Panel } from '../components';

const ALL_PLANS = Object.keys(GAME_PLAN_LABEL) as GamePlanKey[];

export function CampPage() {
  const save = useGame((s) => s.save)!;
  const runOperation = useGame((s) => s.runOperation);
  const mutate = useGame((s) => s.mutate);
  const busy = useGame((s) => s.busy);
  const showToast = useGame((s) => s.showToast);
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;

  const [presetKey, setPresetKey] = useState('balanced');
  const preset = CAMP_PRESETS.find((p) => p.key === presetKey)!;
  const [focus, setFocus] = useState<CampFocus>(preset.focus);
  const [intensity, setIntensity] = useState(preset.intensity);
  // The plan opens on whatever was last chosen for this bout, or the last plan used
  // anywhere. It is a default and stays editable; it is never reset on remount.
  const bootBoutId = save.player.fighterId ? save.fighters[save.player.fighterId]?.nextBoutId ?? null : null;
  const recalled = recallPlan(save, bootBoutId, 'camp');
  const [plans, setPlansState] = useState<GamePlanKey[]>(recalled.plans);
  const planLabel = planSourceLabel(recalled);
  // Every change is stored immediately, so leaving the page cannot lose it.
  const setPlans = (next: GamePlanKey[] | ((cur: GamePlanKey[]) => GamePlanKey[])) => {
    // The value is resolved first and the store written once, outside the updater. A setState
    // updater must be pure: React is free to call it more than once, which would have recorded
    // the same plan change twice.
    const value = typeof next === 'function' ? next(plans) : next;
    setPlansState(value);
    mutate((s) => rememberPlan(s, bootBoutId, 'camp', value));
  };
  const [campType, setCampType] = useState<TrainingCamp['campType']>('home');
  const [visitGymId, setVisitGymId] = useState<string>('');
  const [specialist, setSpecialist] = useState(false);
  const [arriveEarly, setArriveEarly] = useState(0);

  const bout = fighter?.nextBoutId ? save.bouts[fighter.nextBoutId] : null;
  const existing = useMemo(
    () => (fighter ? Object.values(save.camps).find((c) => c.fighterId === fighter.id && (c.status === 'planned' || c.status === 'running')) : null),
    [save, fighter]
  );

  if (!fighter) {
    return (
      <div className="page">
        <Notice>Training camps are managed for your own fighter. This save has no player fighter.</Notice>
      </div>
    );
  }

  const weeksAvailable = bout ? Math.max(0, Math.floor((daysBetween(save.date, bout.date) - 7) / 7)) : 0;
  const capacity = trainingCapacityOf(fighter, save.date);
  const injuries = activeInjuries(fighter, save.date);

  const applyPreset = (key: string) => {
    const p = CAMP_PRESETS.find((x) => x.key === key)!;
    setPresetKey(key);
    setFocus(p.focus);
    setIntensity(p.intensity);
    // A preset suggests a plan, but never overwrites a plan the player has already set.
    if (!recalled.remembered) setPlans(p.plans);
  };

  const totalFocus = RATING_KEYS.reduce((s, k) => s + focus[k], 0);

  const startCamp = async () => {
    if (!bout || busy) return;
    // A camp is created through the controller so the button reports what happened, and it
    // refuses rather than silently adding a second camp for the same bout.
    const result = await runOperation('other', 'Setting the camp', (report) => {
      report('updating-world', 'Booking gym time and staff');
      const existing = Object.values(save.camps).find(
        (c) => c.fighterId === save.player.fighterId && (c.status === 'planned' || c.status === 'running')
      );
      if (existing) {
        return {
          ok: true,
          noOpReason: 'A camp is already running for this bout. Abandon it before setting another.',
          error: null,
          fromDate: save.date,
          toDate: save.date,
          daysAdvanced: 0,
          eventsResolved: [],
          headlines: [],
          stoppedBecause: null,
          navigateTo: null,
          summary: '',
        };
      }
      const created = buildCamp(save);
      return {
        ok: true,
        noOpReason: null,
        error: null,
        fromDate: save.date,
        toDate: save.date,
        daysAdvanced: 0,
        eventsResolved: [],
        headlines: [`Camp set: ${created.weeks} weeks at ${Math.round(created.intensity * 100)} percent intensity.`],
        stoppedBecause: null,
        navigateTo: null,
        summary: '',
      };
    });
    if (result.noOpReason) showToast(result.noOpReason, 'bad');
    else showToast(result.headlines[0] ?? 'Camp set.', 'good');
  };

  const buildCamp = (s: typeof save) => {
    {
      if (!bout) throw new Error('There is no booked bout to build a camp for.');
      const f = s.fighters[s.player.fighterId!];
      const camp = createCamp(s, f, {
        boutId: bout.id,
        startDate: s.date,
        endDate: addDays(bout.date, -7),
        focus: normalizeFocus(focus),
        intensity,
        gymId: campType === 'solo' ? null : campType === 'visiting' ? visitGymId || f.gymId : f.gymId,
        campType,
        specialistHired: specialist ? 'Specialist coach' : null,
        gamePlan: plans,
        arriveEarlyDays: arriveEarly,
      });
      s.camps[camp.id] = camp;
      // The camp is paid for weekly through the ledger as it runs, in `runCampWeek`. Deducting the
      // whole cost here as well charged it twice, against two different money stores, and the
      // off-ledger deduction was overwritten the next time the ledger recomputed the balance.
      return camp;
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Training camp</h1>
        <span className="sub">
          {bout ? (
            <>
              Preparing for <Link to={`/fighter/${bout.fighterAId === fighter.id ? bout.fighterBId : bout.fighterAId}`}>
                {save.fighters[bout.fighterAId === fighter.id ? bout.fighterBId : bout.fighterAId]?.name}
              </Link>{' '}
              on {formatDate(bout.date)}, {weeksAvailable} weeks available
            </>
          ) : (
            'No bout booked. Camps are set once a fight is agreed.'
          )}
        </span>
      </div>

      {injuries.length > 0 && (
        <Notice kind="warn">
          Training capacity is limited to {Math.round(capacity * 100)}% by {injuries.map((i) => i.type).join(', ')}. A
          lighter camp protects the injury at the cost of sharpness.
        </Notice>
      )}

      {existing && (
        <Panel title="Camp in progress">
          <KeyValues
            rows={[
              ['Weeks completed', `${existing.weeksCompleted} of ${existing.weeks}`],
              ['Intensity', <Bar key="i" value={existing.intensity * 100} />],
              ['Location', existing.campType],
              ['Game plan', existing.gamePlan.map((p) => GAME_PLAN_LABEL[p]).join(', ') || 'None set'],
              ['Cost', formatMoney(existing.cost)],
              ['Overtrained', existing.overtrained ? <span key="o" className="bad">yes</span> : 'no'],
            ]}
          />
          <h3 className="mt">Camp log</h3>
          {existing.outcomes.length === 0 ? (
            <p className="dim small">Nothing notable has happened yet.</p>
          ) : (
            <table>
              <tbody>
                {existing.outcomes
                  .slice()
                  .reverse()
                  .map((o, i) => (
                    <tr key={i}>
                      <td className="dim small">Week {o.week}</td>
                      <td>
                        <strong className={o.severity === 'bad' ? 'bad' : o.severity === 'good' ? 'good' : undefined}>{o.headline}</strong>
                      </td>
                      <td className="small dim wrap">{o.detail}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {!existing && bout && (
        <div className="grid c2">
          <Panel title="Camp plan">
            <div className="field">
              <label>Preset</label>
              <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
                {CAMP_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="small dim">{preset.description}</span>
            </div>

            <h3>Focus</h3>
            <p className="small dim">
              Allocation across the six areas. Values are normalised, so what matters is the balance between them.
              Durability focus means safe preparation, recovery and injury prevention. It reduces avoidable damage, it
              does not make anyone hard to hurt.
            </p>
            {RATING_KEYS.map((k: RatingKey) => (
              <div className="focus-row" key={k}>
                <label>{RATING_LONG_LABEL[k]}</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  // The slider shows and writes the same quantity, the raw weight. It used to show
                  // the normalised share and write the raw value, so the thumb jumped away from
                  // wherever it was dragged as soon as the total changed.
                  value={Math.round(focus[k] * 100)}
                  onChange={(e) => setFocus({ ...focus, [k]: Number(e.target.value) / 100 })}
                />
                <span className="num mono small" title="Share of camp time once every weight is taken together">
                  {Math.round((focus[k] / Math.max(0.0001, totalFocus)) * 100)}%
                </span>
              </div>
            ))}

            <div className="field mt">
              <label>Intensity</label>
              <input type="range" min={20} max={100} value={Math.round(intensity * 100)} onChange={(e) => setIntensity(Number(e.target.value) / 100)} />
              <span className="small dim">
                {Math.round(intensity * 100)}%. A long camp at high intensity peaks early and then erodes. Overtraining
                costs sharpness and raises injury risk.
              </span>
            </div>
          </Panel>

          <Panel title="Location and staff">
            <div className="field">
              <label>Camp type</label>
              <select value={campType} onChange={(e) => setCampType(e.target.value as TrainingCamp['campType'])}>
                <option value="home">Stay at the home gym</option>
                <option value="visiting">Visit another gym for this camp</option>
                <option value="split">Split camp between two gyms</option>
                <option value="near-event">Train near the event location</option>
                <option value="solo">Train alone</option>
              </select>
              <span className="small dim">
                {campType === 'visiting'
                  ? 'A visiting fighter does not get the full benefit of an unfamiliar room on the first camp there.'
                  : campType === 'solo'
                    ? 'No coaching, no live partners. Sharpness and tactical preparation both suffer badly.'
                    : campType === 'near-event'
                      ? 'Travel and time zone adjustment handled early, at extra cost.'
                      : campType === 'split'
                        ? 'Two rooms, two skill sets, more travel and more disruption.'
                        : 'Familiar coaches and partners at the usual cost.'}
              </span>
            </div>

            {campType === 'visiting' && (
              <div className="field">
                <label>Gym to visit</label>
                <select value={visitGymId} onChange={(e) => setVisitGymId(e.target.value)}>
                  <option value="">Choose a gym</option>
                  {Object.values(save.gyms)
                    .filter((g) => g.id !== fighter.gymId)
                    .sort((a, b) => b.reputation - a.reputation)
                    .slice(0, 40)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.city}, reputation {g.reputation})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <label className="row tight mb">
              <input type="checkbox" checked={specialist} onChange={(e) => setSpecialist(e.target.checked)} />
              <span className="small">Hire a specialist coach for this camp</span>
            </label>

            <div className="field">
              <label>Arrive early at the venue</label>
              <select value={arriveEarly} onChange={(e) => setArriveEarly(Number(e.target.value))}>
                <option value={0}>Standard fight week arrival</option>
                <option value={4}>Four days early</option>
                <option value={7}>One week early</option>
                <option value={12}>Twelve days early</option>
              </select>
            </div>

            <h3 className="mt">Game plan</h3>
            <p className="small dim">
              Up to three. Camp focus is what you train; the game plan is how you intend to fight. Contradictory plans
              waste preparation.
            </p>
            {planLabel && (
              <p className="small">
                <span className="tag">{planLabel}</span> Preselected for you. Change them freely.
              </p>
            )}
            <div className="row" style={{ gap: 4 }}>
              {ALL_PLANS.map((p) => (
                <span
                  key={p}
                  className={`plan-chip${plans.includes(p) ? ' on' : ''}`}
                  title={GAME_PLAN_DESCRIPTION[p]}
                  onClick={() => setPlans((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : cur.length >= 3 ? cur : [...cur, p]))}
                >
                  {GAME_PLAN_LABEL[p]}
                </span>
              ))}
            </div>

            <div className="row mt">
              <span className="dim small">
                Camp length: {campLengthLabel(weeksAvailable)}. Estimated cost{' '}
                {formatMoney(
                  estimateCampCost(save, {
                    boutId: bout.id,
                    startDate: save.date,
                    endDate: addDays(bout.date, -7),
                    focus,
                    intensity,
                    // The gym that will actually be charged. The quote used to name the home gym
                    // whatever the player picked, and cost is derived from the gym's own running
                    // costs, so a visiting camp could be billed several times what it quoted.
                    gymId: campType === 'solo' ? null : campType === 'visiting' ? visitGymId || fighter.gymId : fighter.gymId,
                    campType,
                    specialistHired: specialist ? 'Specialist coach' : null,
                    gamePlan: plans,
                    arriveEarlyDays: arriveEarly,
                  }).cost
                )}
              </span>
            </div>
            <button className="primary mt" disabled={busy} onClick={() => void startCamp()}>
              Set this camp
            </button>
          </Panel>
        </div>
      )}

      <Panel title="Past camps" flush>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th className="num">Weeks</th>
              <th>Type</th>
              <th className="num">Sharpness</th>
              <th className="num">Tactical</th>
              <th>Game plan</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(save.camps)
              .filter((c) => c.fighterId === fighter.id && c.status === 'complete')
              .sort((a, b) => (a.startDate > b.startDate ? -1 : 1))
              .slice(0, 25)
              .map((c) => (
                <tr key={c.id}>
                  <td>{formatDate(c.startDate)}</td>
                  <td className="num">{c.weeksCompleted}</td>
                  <td className="small">{c.campType}</td>
                  <td className="num">{c.resultingSharpness !== null ? Math.round(c.resultingSharpness * 100) : '-'}</td>
                  <td className="num">{c.resultingTacticalFamiliarity !== null ? Math.round(c.resultingTacticalFamiliarity * 100) : '-'}</td>
                  <td className="small dim">{c.gamePlan.map((p) => GAME_PLAN_LABEL[p]).join(', ')}</td>
                  <td className="small dim wrap">
                    {c.overtrained ? 'Overtrained. ' : ''}
                    {c.outcomes.filter((o) => o.severity !== 'neutral').length} notable events
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
