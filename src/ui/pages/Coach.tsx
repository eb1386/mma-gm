import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Rng } from '@core/rng';
import { formatMoney } from '@core/types/common';
import { RATING_LONG_LABEL } from '@core/types/fighter';
import type { GymStaff } from '@core/types/world';
import {
  fireStaff,
  generateStaffCandidates,
  GYM_UPGRADES,
  happinessFactors,
  hireStaff,
  moveFighterToGym,
  recruitmentChance,
  runGymMonth,
  STAFF_ROLE_LABEL,
} from '@core/world/gyms';
import { estimateRatings } from '@core/world/scouting';
import { useGame } from '../store';
import { Bar, DataTable, KeyValues, Notice, Panel, Rating, Tabs } from '../components';

const HIRABLE: GymStaff['role'][] = [
  'head-coach',
  'striking-coach',
  'grappling-coach',
  'wrestling-coach',
  'submission-coach',
  'strength-conditioning',
  'recovery',
  'nutrition',
  'cutman',
  'psychologist',
  'scout',
  'manager',
];

export function CoachPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const showToast = useGame((s) => s.showToast);
  const runOperation = useGame((s) => s.runOperation);
  const busy = useGame((s) => s.busy);
  const [tab, setTab] = useState('roster');
  const [hireRole, setHireRole] = useState<GymStaff['role']>('striking-coach');
  const [candidates, setCandidates] = useState<GymStaff[]>([]);
  const [recruitTarget, setRecruitTarget] = useState('');

  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  if (!gym) {
    return (
      <div className="page">
        <Notice>This save is not in Coach Mode.</Notice>
      </div>
    );
  }

  const roster = gym.fighterIds.map((id) => save.fighters[id]).filter(Boolean);
  const staff = gym.staffIds.map((id) => save.staff[id]).filter(Boolean);
  const monthly = useMemo(() => {
    const salaries = staff.reduce((s, c) => s + c.salary / 12, 0);
    return { salaries, overhead: gym.monthlyCosts };
  }, [staff, gym.monthlyCosts]);

  const freeAgents = Object.values(save.fighters)
    .filter((f) => !f.retired && f.activityStatus === 'active' && f.gymId !== gym.id)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 300);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{gym.name}</h1>
        <span className="sub">
          {gym.city}, {gym.country} · founded {gym.founded} · {roster.length} of {gym.capacity} fighters
        </span>
      </div>

      <Notice>
        In Coach Mode you advise. Fighters have autonomy: they can refuse a plan, take a fight you dislike, ask for more
        attention, object to how the room is run, and leave. There is no single victory condition.
      </Notice>

      <Tabs
        tabs={[
          { key: 'roster', label: `Roster (${roster.length})` },
          { key: 'staff', label: `Staff (${staff.length})` },
          { key: 'facilities', label: 'Facilities' },
          { key: 'recruit', label: 'Recruiting' },
          { key: 'finance', label: 'Finances' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'roster' && (
        <Panel title="Gym roster" flush>
          <DataTable
            rows={roster}
            rowKey={(f) => f.id}
            initialSort="ovr"
            columns={[
              { key: 'name', label: 'Fighter', sort: (f) => f.name, render: (f) => <Link to={`/fighter/${f.id}`}>{f.name}</Link> },
              { key: 'div', label: 'Division', sort: (f) => f.divisionId, render: (f) => f.divisionId },
              { key: 'rank', label: 'Rk', numeric: true, sort: (f) => (f.isChampion ? 0 : (f.ranking ?? 99)), render: (f) => (f.isChampion ? 'C' : (f.ranking ?? '-')) },
              { key: 'ovr', label: 'Ovr', numeric: true, sort: (f) => estimateRatings(save, f).ovr, render: (f) => <Rating value={estimateRatings(save, f).ovr} /> },
              { key: 'pot', label: 'Pot', numeric: true, sort: (f) => f.pot, render: (f) => <Rating value={f.pot} /> },
              { key: 'lng', label: 'Lng', numeric: true, sort: (f) => f.longevity, render: (f) => <Rating value={f.longevity} /> },
              { key: 'happy', label: 'Happiness', numeric: true, sort: (f) => f.happiness, render: (f) => <Bar value={f.happiness} /> },
              { key: 'trust', label: 'Trust in you', numeric: true, sort: (f) => f.relationships.player, render: (f) => <Bar value={f.relationships.player} /> },
              {
                key: 'issue',
                label: 'Main concern',
                render: (f) => {
                  const worst = happinessFactors(save, f).sort((a, b) => a.delta - b.delta)[0];
                  return worst && worst.delta < -2 ? <span className="small bad">{worst.label}</span> : <span className="small dim">none</span>;
                },
              },
              {
                key: 'release',
                label: '',
                render: (f) => (
                  <button
                    className="small danger"
                    onClick={() => {
                      mutate((s) => moveFighterToGym(s, f.id, null));
                      showToast(`${f.name} has left the gym.`, 'info');
                    }}
                  >
                    Release
                  </button>
                ),
              },
            ]}
            empty="No fighters at the gym yet. Recruit from the recruiting tab."
          />
        </Panel>
      )}

      {tab === 'staff' && (
        <div className="grid c2">
          <Panel title="Current staff" flush>
            <DataTable
              rows={staff}
              rowKey={(s) => s.id}
              initialSort="quality"
              columns={[
                { key: 'name', label: 'Name', sort: (s) => s.name, render: (s) => s.name },
                { key: 'role', label: 'Role', sort: (s) => s.role, render: (s) => STAFF_ROLE_LABEL[s.role] },
                { key: 'quality', label: 'Quality', numeric: true, sort: (s) => s.quality, render: (s) => <Rating value={s.quality} /> },
                { key: 'develops', label: 'Develops', render: (s) => (s.develops ? RATING_LONG_LABEL[s.develops] : <span className="faint">support</span>) },
                { key: 'salary', label: 'Salary', numeric: true, sort: (s) => s.salary, render: (s) => formatMoney(s.salary) },
                { key: 'loyalty', label: 'Loyalty', numeric: true, sort: (s) => s.loyalty, render: (s) => <Bar value={s.loyalty} /> },
                {
                  key: 'fire',
                  label: '',
                  render: (s) => (
                    <button
                      className="small danger"
                      onClick={() => {
                        mutate((sv) => fireStaff(sv, sv.gyms[gym.id], s.id));
                        showToast(`${s.name} has been let go. The room noticed.`, 'info');
                      }}
                    >
                      Release
                    </button>
                  ),
                },
              ]}
            />
            <p className="small faint" style={{ padding: 8 }}>
              Staff have internal coaching values. Fighter pages always show exactly six performance ratings.
            </p>
          </Panel>

          <Panel title="Hire">
            <div className="row mb">
              <select value={hireRole} onChange={(e) => setHireRole(e.target.value as GymStaff['role'])}>
                {HIRABLE.map((r) => (
                  <option key={r} value={r}>
                    {STAFF_ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button
                onClick={() =>
                  setCandidates(generateStaffCandidates(save, gym, hireRole, new Rng(`${save.seed}-${hireRole}-${save.date}`)))
                }
              >
                Find candidates
              </button>
            </div>
            {candidates.length === 0 ? (
              <p className="dim small">Search for candidates to see who is available.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Quality</th>
                    <th className="num">Salary</th>
                    <th className="num">Loyalty</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="num">
                        <Rating value={c.quality} />
                      </td>
                      <td className="num">{formatMoney(c.salary)}</td>
                      <td className="num">
                        <Bar value={c.loyalty} />
                      </td>
                      <td>
                        <button
                          className="small primary"
                          disabled={gym.balance < c.salary / 4}
                          onClick={() => {
                            mutate((s) => {
                              const hired = hireStaff(s, s.gyms[gym.id], c.role, new Rng(`${s.seed}-hire-${c.id}`), c.quality);
                              hired.name = c.name;
                              hired.salary = c.salary;
                              hired.loyalty = c.loyalty;
                              s.gyms[gym.id].balance -= Math.round(c.salary / 4);
                            });
                            setCandidates([]);
                            showToast(`${c.name} has joined the staff.`, 'good');
                          }}
                        >
                          Hire
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}

      {tab === 'facilities' && (
        <div className="grid c2">
          <Panel title="Gym profile">
            <KeyValues
              rows={[
                ['Reputation', <Bar key="r" value={gym.reputation} />],
                ['Facilities', <Bar key="f" value={gym.facilities} />],
                ['Culture', <Bar key="c" value={gym.culture} />],
                ['Safety', <Bar key="s" value={gym.safety} />],
                ['Hard sparring', <Bar key="h" value={gym.hardSparringTendency} tone={gym.hardSparringTendency > 65 ? 'bad' : 'good'} />],
                ['Capacity', `${roster.length} of ${gym.capacity}`],
                ['Revenue share', `${gym.revenueSharePct}%`],
                ['Champions produced', gym.championsProduced],
                ['Ranked fighters produced', gym.rankedProduced],
                ['Specializations', gym.specializations.map((s) => RATING_LONG_LABEL[s]).join(', ')],
              ]}
            />
            <h3 className="mt">Training partner quality</h3>
            <table>
              <tbody>
                {(Object.keys(gym.trainingPartners) as (keyof typeof gym.trainingPartners)[]).map((k) => (
                  <tr key={k}>
                    <td>{RATING_LONG_LABEL[k]}</td>
                    <td style={{ width: 110 }}>
                      <Bar value={gym.trainingPartners[k]} />
                    </td>
                    <td className="num">{Math.round(gym.trainingPartners[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Upgrades">
            <p className="small dim">Balance {formatMoney(gym.balance)}.</p>
            <table>
              <tbody>
                {GYM_UPGRADES.map((u) => (
                  <tr key={u.key}>
                    <td>{u.label}</td>
                    <td className="num">{formatMoney(u.cost)}</td>
                    <td>
                      <button
                        className="small"
                        disabled={gym.balance < u.cost}
                        onClick={() => {
                          mutate((s) => {
                            const g = s.gyms[gym.id];
                            g.balance -= u.cost;
                            u.apply(g);
                          });
                          showToast(`${u.label} complete.`, 'good');
                        }}
                      >
                        Buy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="field mt">
              <label>Revenue share taken from fighter purses</label>
              <input
                type="range"
                min={2}
                max={20}
                value={gym.revenueSharePct}
                onChange={(e) => mutate((s) => { s.gyms[gym.id].revenueSharePct = Number(e.target.value); })}
              />
              <span className="small dim">
                {gym.revenueSharePct}%. A higher share brings in more money and makes fighters less happy.
              </span>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'recruit' && (
        <Panel title="Recruiting" flush>
          <div className="row" style={{ padding: 8 }}>
            <input
              type="search"
              placeholder="Filter by name"
              value={recruitTarget}
              onChange={(e) => setRecruitTarget(e.target.value)}
            />
            <span className="small dim">
              A pitch is more likely to land when your gym is better than theirs, when they are unhappy, and when your
              revenue share is not greedy.
            </span>
          </div>
          <DataTable
            rows={freeAgents.filter((f) => !recruitTarget || f.name.toLowerCase().includes(recruitTarget.toLowerCase()))}
            rowKey={(f) => f.id}
            initialSort="chance"
            maxHeight={520}
            columns={[
              { key: 'name', label: 'Fighter', sort: (f) => f.name, render: (f) => <Link to={`/fighter/${f.id}`}>{f.name}</Link> },
              { key: 'div', label: 'Division', sort: (f) => f.divisionId, render: (f) => f.divisionId },
              { key: 'rank', label: 'Rk', numeric: true, sort: (f) => (f.isChampion ? 0 : (f.ranking ?? 99)), render: (f) => (f.isChampion ? 'C' : (f.ranking ?? '-')) },
              { key: 'ovr', label: 'Ovr', numeric: true, sort: (f) => estimateRatings(save, f).ovr, render: (f) => <Rating value={estimateRatings(save, f).ovr} /> },
              { key: 'pot', label: 'Pot', numeric: true, sort: (f) => estimateRatings(save, f).pot, render: (f) => <Rating value={estimateRatings(save, f).pot} /> },
              { key: 'happy', label: 'Happiness', numeric: true, sort: (f) => f.happiness, render: (f) => <Bar value={f.happiness} /> },
              { key: 'gym', label: 'Current gym', render: (f) => (f.gymId ? save.gyms[f.gymId]?.name : <span className="faint">none</span>) },
              {
                key: 'chance',
                label: 'Chance',
                numeric: true,
                sort: (f) => recruitmentChance(save, gym, f),
                render: (f) => `${Math.round(recruitmentChance(save, gym, f) * 100)}%`,
              },
              {
                key: 'pitch',
                label: '',
                render: (f) => (
                  <button
                    className="small"
                    disabled={roster.length >= gym.capacity}
                    onClick={() => {
                      const chance = recruitmentChance(save, gym, f);
                      mutate((s) => {
                        const rng = new Rng(s.rng);
                        if (rng.chance(chance)) {
                          moveFighterToGym(s, f.id, gym.id);
                          s.fighters[f.id].relationships.player = 55;
                          showToast(`${f.name} has joined ${gym.name}.`, 'good');
                        } else {
                          showToast(`${f.name} turned the pitch down.`, 'bad');
                        }
                        s.rng = rng.getState();
                      });
                    }}
                  >
                    Pitch
                  </button>
                ),
              },
            ]}
          />
        </Panel>
      )}

      {tab === 'finance' && (
        <Panel title="Finances">
          <KeyValues
            rows={[
              ['Balance', formatMoney(gym.balance)],
              ['Monthly overhead', formatMoney(monthly.overhead)],
              ['Monthly salaries', formatMoney(monthly.salaries)],
              ['Membership income estimate', formatMoney(roster.length * 900 + gym.reputation * 220)],
              ['Revenue share', `${gym.revenueSharePct}% of fighter purses`],
            ]}
          />
          <button
            className="mt"
            disabled={busy}
            onClick={() =>
              void runOperation('other', 'Closing out the month', (report) => {
                report('updating-world', 'Settling gym finances');
                const month = runGymMonth(save, save.gyms[gym.id]);
                return {
                  ok: true,
                  noOpReason: null,
                  error: null,
                  fromDate: save.date,
                  toDate: save.date,
                  daysAdvanced: 0,
                  eventsResolved: [],
                  headlines: [
                    month.lines.some((l) => l.includes('already been settled'))
                      ? 'This month has already been settled.'
                      : `Month closed. Net ${formatMoney(month.net)}.`,
                  ],
                  stoppedBecause: null,
                  navigateTo: null,
                  summary: '',
                };
              }).then((r) =>
              // A refusal is reported as a refusal rather than in green as a success.
              showToast(r.headlines[0] ?? 'Month closed.', r.headlines[0]?.includes('already been settled') ? 'info' : 'good')
            )
            }
          >
            {busy ? 'Working...' : 'Close out a month manually'}
          </button>
          <p className="small faint mt">
            Finances also run automatically at the start of each month as the calendar advances.
          </p>
        </Panel>
      )}
    </div>
  );
}
