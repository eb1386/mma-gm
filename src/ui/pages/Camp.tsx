import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { GAME_PLAN_LABEL } from '@core/sim/plan';
import { formatDate, formatMoney } from '@core/types/common';
import { RATING_KEYS, RATING_LONG_LABEL, type RatingKey } from '@core/types/fighter';
import type { CampFocus, GamePlanKey, TrainingCamp } from '@core/types/world';
import {
  ARRIVE_EARLY_CAP_DAYS,
  arriveEarlyCostFor,
  baseBuildingFor,
  CAMP_PRESETS,
  campEndFor,
  campLengthLabel,
  campStartFor,
  campWeeksAvailable,
  createCamp,
  estimateCampCost,
  IDEAL_CAMP_WEEKS,
  normalizeFocus,
  setFocusShare,
  specialistCostFor,
  type CampSetup,
} from '@core/world/camp';
import { activeInjuries, trainingCapacityOf } from '@core/world/health';
import { gymLocation } from '@core/world/gyms';
import { useGame } from '../store';
import { planSourceLabel, recallPlan, rememberPlan } from '@core/world/gameplan-memory';
import { Bar, KeyValues, Notice, Panel } from '../components';
import { GamePlanPicker } from '../GamePlanPicker';

/** Past this many weeks a camp is warned about: the overtraining check starts to bite. */
const LONG_CAMP_WEEKS = 10;

const CAMP_TYPE_LABEL: Record<TrainingCamp['campType'], string> = {
  home: 'Home gym',
  visiting: 'Visiting another gym',
  split: 'Split between two gyms',
  'near-event': 'Near the event',
  solo: 'Alone',
};

export function CampPage() {
  const save = useGame((s) => s.save)!;
  const runOperation = useGame((s) => s.runOperation);
  const mutate = useGame((s) => s.mutate);
  const busy = useGame((s) => s.busy);
  const showToast = useGame((s) => s.showToast);
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;

  const [presetKey, setPresetKey] = useState('balanced');
  const preset = CAMP_PRESETS.find((p) => p.key === presetKey)!;
  // Normalised on the way in, so the six shares always add up to one whole camp.
  const [focus, setFocus] = useState<CampFocus>(() => normalizeFocus(preset.focus));
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
  const [secondGymId, setSecondGymId] = useState<string>('');
  const [specialist, setSpecialist] = useState(false);
  const [arriveEarly, setArriveEarly] = useState(0);
  // Null until the player picks a length, so the default follows the notice available.
  const [chosenWeeks, setChosenWeeks] = useState<number | null>(null);

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

  const weeksAvailable = bout ? campWeeksAvailable(save.date, bout.date) : 0;
  // The camp no longer runs from today to the bout whatever the notice. Its length is chosen, and
  // it is counted back from the end of camp, so on long notice the camp waits until it is due.
  // Booking every week available ran a fight booked four months out into a sixteen week camp,
  // which the length and overtraining penalties made far worse than eight weeks.
  const campWeeks = weeksAvailable > 0 ? Math.min(weeksAvailable, Math.max(1, chosenWeeks ?? Math.min(IDEAL_CAMP_WEEKS, weeksAvailable))) : 0;
  const campStart = bout ? campStartFor(bout.date, campWeeks) : save.date;
  // A visiting or split camp needs its other gym named. Both used to fall back to the home gym when
  // none was picked, which billed two to three times a home camp for a worse camp in the same room.
  const campGymId = campType === 'solo' ? null : campType === 'visiting' ? visitGymId || null : fighter.gymId;
  const gymMissing = (campType === 'visiting' && !visitGymId) || (campType === 'split' && !secondGymId);
  const setupFor = (boutId: string, boutDate: string): CampSetup => ({
    boutId,
    startDate: campStartFor(boutDate, campWeeks),
    endDate: campEndFor(boutDate),
    focus: normalizeFocus(focus),
    intensity,
    // The gym that will actually be charged. The quote used to name the home gym whatever the
    // player picked, and cost is derived from the gym's own running costs, so a visiting camp could
    // be billed several times what it quoted.
    gymId: campGymId,
    secondGymId: campType === 'split' ? secondGymId || null : null,
    campType,
    specialistHired: specialist ? 'Specialist coach' : null,
    gamePlan: plans,
    arriveEarlyDays: arriveEarly,
  });
  const capacity = trainingCapacityOf(fighter, save.date);
  const injuries = activeInjuries(fighter, save.date);

  const applyPreset = (key: string) => {
    const p = CAMP_PRESETS.find((x) => x.key === key)!;
    setPresetKey(key);
    setFocus(normalizeFocus(p.focus));
    setIntensity(p.intensity);
    // A preset suggests a plan, but never overwrites a plan the player has already set.
    if (!recalled.remembered) setPlans(p.plans);
  };

  const totalFocus = RATING_KEYS.reduce((s, k) => s + focus[k], 0);

  // The allocation rule lives in the core, so the camp the player builds and the camp the
  // engine runs agree about what a share means: move one slider and the other five give or take
  // the difference in equal parts, so the six always total one camp.
  const setShare = (key: RatingKey, nextShare: number) => setFocus(setFocusShare(focus, key, nextShare));

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
        headlines: [
          `Camp set: ${campLengthLabel(created.weeks).toLowerCase()} at ${Math.round(created.intensity * 100)} percent intensity, ${
            created.startDate > save.date ? `starting ${formatDate(created.startDate)}` : 'starting now'
          }.`,
        ],
        stoppedBecause: null,
        navigateTo: null,
        summary: '',
      };
    });
    // A no-op reason is already shown by the operation panel. Toasting it as well put the same
    // sentence on screen twice. A failure is shown by the panel too, and is not a camp being set.
    if (result.ok && !result.noOpReason) showToast(result.headlines[0] ?? 'Camp set.', 'good');
  };

  const buildCamp = (s: typeof save) => {
    {
      if (!bout) throw new Error('There is no booked bout to build a camp for.');
      // The page hides the form in these cases; this keeps a stale click from getting past it.
      if (campWeeksAvailable(s.date, bout.date) === 0) throw new Error('Too close to the fight for a camp. Set the game plan in fight week.');
      if (gymMissing) throw new Error(campType === 'split' ? 'Choose the second gym for the split camp.' : 'Choose the gym to visit.');
      const f = s.fighters[s.player.fighterId!];
      const camp = createCamp(s, f, setupFor(bout.id, bout.date));
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
              ...(existing.status === 'planned' && existing.startDate > save.date
                ? ([['Starts', formatDate(existing.startDate)]] as [string, string][])
                : []),
              ['Weeks completed', `${existing.weeksCompleted} of ${existing.weeks}`],
              ['Intensity', <Bar key="i" value={existing.intensity * 100} />],
              ['Location', CAMP_TYPE_LABEL[existing.campType] ?? existing.campType],
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

      {!existing && bout && weeksAvailable === 0 && (
        <Notice>Too close to the fight for a camp. Set the game plan in fight week.</Notice>
      )}

      {!existing && bout && weeksAvailable > 0 && (
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

            <p className="small dim">
              Base built since the last camp:{' '}
              <strong>{Math.round(baseBuildingFor(save, fighter, save.date) * 100)}%</strong>. Ordinary weeks in the
              gym are not dead air; a built base makes the whole camp train better and open sharper.
            </p>

            <h3>Focus</h3>
            <p className="small dim">
              One camp, split six ways. Move a slider and the other five adjust equally, so the shares always add
              up to the whole week. Durability focus means safe preparation, recovery and injury prevention. It
              reduces avoidable damage, it does not make anyone hard to hurt.
            </p>
            {RATING_KEYS.map((k: RatingKey) => {
              const pct = Math.round((focus[k] / Math.max(0.0001, totalFocus)) * 100);
              return (
                <div className="focus-row" key={k}>
                  <label>{RATING_LONG_LABEL[k]}</label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={pct}
                    onChange={(e) => setShare(k, Number(e.target.value) / 100)}
                  />
                  <span className="num mono small">{pct}%</span>
                </div>
              );
            })}

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
                        ? 'Each area is worked in whichever room does it better, under the better coaching staff, at the cost of travel and disruption. Worth it when the second gym covers a weakness of the home room.'
                        : 'Familiar coaches and partners at the usual cost.'}
              </span>
            </div>

            {campType === 'split' && (
              <div className="field">
                <label>Second gym</label>
                <select value={secondGymId} onChange={(e) => setSecondGymId(e.target.value)}>
                  <option value="">Choose a gym</option>
                  {Object.values(save.gyms)
                    .filter((g) => g.id !== fighter.gymId)
                    .sort((a, b) => b.reputation - a.reputation)
                    .slice(0, 40)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({gymLocation(g) ? `${gymLocation(g)}, ` : ''}reputation {g.reputation})
                      </option>
                    ))}
                </select>
              </div>
            )}

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
                        {g.name} ({gymLocation(g) ? `${gymLocation(g)}, ` : ''}reputation {g.reputation})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <label className="row tight mb">
              <input type="checkbox" checked={specialist} onChange={(e) => setSpecialist(e.target.checked)} />
              <span className="small">Hire a specialist coach for this camp ({formatMoney(specialistCostFor(fighter))})</span>
            </label>

            <div className="field">
              <label>Arrive early at the venue</label>
              <select value={arriveEarly} onChange={(e) => setArriveEarly(Number(e.target.value))}>
                <option value={0}>Standard fight week arrival</option>
                {[
                  [4, 'Four days early'],
                  [7, 'One week early'],
                  [ARRIVE_EARLY_CAP_DAYS, 'Twelve days early'],
                ].map(([days, label]) => (
                  <option key={days} value={days}>
                    {label} (about {formatMoney(arriveEarlyCostFor(fighter, Number(days)))})
                  </option>
                ))}
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
            <GamePlanPicker plans={plans} onChange={(next) => setPlans(next)} />

            <div className="field mt">
              <label>Camp length</label>
              <select value={campWeeks} onChange={(e) => setChosenWeeks(Number(e.target.value))}>
                {Array.from({ length: weeksAvailable }, (_, i) => i + 1).map((w) => (
                  <option key={w} value={w}>
                    {w === 1 ? 'One week' : `${w} weeks`}
                    {w === IDEAL_CAMP_WEEKS ? ' (ideal)' : ''}
                  </option>
                ))}
              </select>
              <span className="small dim">
                Eight weeks is ideal; longer camps start to wear the fighter down.{' '}
                {campStart > save.date ? `This camp starts ${formatDate(campStart)}.` : 'This camp starts now.'}
              </span>
              {campWeeks > LONG_CAMP_WEEKS && (
                <span className="small warn">
                  A camp this long risks overtraining, which costs sharpness and raises injury risk. A shorter camp
                  started later is usually sharper on the night.
                </span>
              )}
            </div>

            <div className="row mt">
              <span className="dim small">
                {gymMissing
                  ? campType === 'split'
                    ? 'Choose the second gym for the split camp.'
                    : 'Choose the gym to visit.'
                  : `Camp length: ${campLengthLabel(campWeeks)}. Estimated cost ${formatMoney(estimateCampCost(save, setupFor(bout.id, bout.date)).cost)}`}
              </span>
            </div>
            <button className="primary mt" disabled={busy || gymMissing} onClick={() => void startCamp()}>
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
                  <td className="small">{CAMP_TYPE_LABEL[c.campType] ?? c.campType}</td>
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
