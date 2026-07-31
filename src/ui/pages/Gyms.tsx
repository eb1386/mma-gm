import { Link, useParams } from 'react-router-dom';
import { RATING_LONG_LABEL } from '@core/types/fighter';
import { formatMoney } from '@core/types/common';
import { STAFF_ROLE_LABEL } from '@core/world/gyms';
import { estimateRatings } from '@core/world/scouting';
import { useGame } from '../store';
import { Bar, DataTable, KeyValues, Notice, Panel, Rating } from '../components';

export function GymsPage() {
  const save = useGame((s) => s.save)!;
  const gyms = Object.values(save.gyms);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Gyms</h1>
        <span className="sub">{gyms.length} gyms</span>
      </div>
      <Panel flush>
        <DataTable
          rows={gyms}
          rowKey={(g) => g.id}
          initialSort="reputation"
          maxHeight={640}
          rowClass={(g) => (g.isPlayerControlled ? 'highlight' : undefined)}
          columns={[
            { key: 'name', label: 'Gym', sort: (g) => g.name, render: (g) => <Link to={`/gym/${g.id}`}>{g.name}</Link> },
            { key: 'loc', label: 'Location', sort: (g) => g.country, render: (g) => `${g.city}, ${g.country}` },
            { key: 'reputation', label: 'Rep', numeric: true, sort: (g) => g.reputation, render: (g) => <Rating value={g.reputation} /> },
            { key: 'facilities', label: 'Facilities', numeric: true, sort: (g) => g.facilities, render: (g) => <Rating value={g.facilities} /> },
            { key: 'culture', label: 'Culture', numeric: true, sort: (g) => g.culture, render: (g) => <Rating value={g.culture} /> },
            { key: 'safety', label: 'Safety', numeric: true, sort: (g) => g.safety, render: (g) => <Rating value={g.safety} /> },
            { key: 'spar', label: 'Hard sparring', numeric: true, sort: (g) => g.hardSparringTendency, render: (g) => Math.round(g.hardSparringTendency) },
            { key: 'fighters', label: 'Fighters', numeric: true, sort: (g) => g.fighterIds.length, render: (g) => `${g.fighterIds.length}/${g.capacity}` },
            { key: 'champs', label: 'Champions', numeric: true, sort: (g) => g.championsProduced, render: (g) => g.championsProduced },
            {
              key: 'record',
              label: 'Recent',
              sort: (g) => g.recentResults.wins - g.recentResults.losses,
              render: (g) => `${g.recentResults.wins}-${g.recentResults.losses}`,
            },
            { key: 'real', label: 'Source', render: (g) => (g.isReal ? <span className="tag real">named from source</span> : <span className="tag fictional">fictional</span>) },
          ]}
        />
      </Panel>
      <p className="small faint">
        Gym names on records flagged as sourced come from the training affiliation published on official athlete
        profiles. Every attribute on a gym record, including reputation, facilities, culture and finances, is a
        simulated game value.
      </p>
    </div>
  );
}

export function GymPage() {
  const save = useGame((s) => s.save)!;
  const { gymId } = useParams();
  const gym = gymId ? save.gyms[gymId] : null;
  if (!gym) return <div className="page"><Notice kind="bad">Unknown gym.</Notice></div>;

  const roster = gym.fighterIds.map((id) => save.fighters[id]).filter(Boolean);
  const staff = gym.staffIds.map((id) => save.staff[id]).filter(Boolean);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{gym.name}</h1>
        <span className="sub">
          {gym.city}, {gym.country} · founded {gym.founded}
        </span>
        {gym.isPlayerControlled && <span className="tag player">your gym</span>}
      </div>

      <div className="grid c3">
        <Panel title="Profile">
          <KeyValues
            rows={[
              ['Reputation', <Bar key="r" value={gym.reputation} />],
              ['Facilities', <Bar key="f" value={gym.facilities} />],
              ['Culture', <Bar key="c" value={gym.culture} />],
              ['Safety', <Bar key="s" value={gym.safety} />],
              ['Hard sparring', <Bar key="h" value={gym.hardSparringTendency} tone={gym.hardSparringTendency > 65 ? 'bad' : 'good'} />],
              ['Capacity', `${roster.length} of ${gym.capacity}`],
              ['Revenue share', `${gym.revenueSharePct}%`],
              ['Balance', formatMoney(gym.balance)],
              ['Champions produced', gym.championsProduced],
              ['Fighters ranked', gym.rankedProduced],
              ['Specializations', gym.specializations.map((s) => RATING_LONG_LABEL[s]).join(', ')],
            ]}
          />
          <p className="provenance">{gym.note}</p>
        </Panel>

        <Panel title="Training partners">
          <table>
            <tbody>
              {(Object.keys(gym.trainingPartners) as (keyof typeof gym.trainingPartners)[]).map((k) => (
                <tr key={k}>
                  <td>{RATING_LONG_LABEL[k]}</td>
                  <td style={{ width: 100 }}>
                    <Bar value={gym.trainingPartners[k]} />
                  </td>
                  <td className="num">{Math.round(gym.trainingPartners[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Staff" flush>
          <table>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="small dim">{STAFF_ROLE_LABEL[s.role]}</td>
                  <td className="num">
                    <Rating value={s.quality} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Fighters" flush>
        <DataTable
          rows={roster}
          rowKey={(f) => f.id}
          initialSort="ovr"
          columns={[
            { key: 'name', label: 'Fighter', sort: (f) => f.name, render: (f) => <Link to={`/fighter/${f.id}`}>{f.name}</Link> },
            { key: 'div', label: 'Division', sort: (f) => f.divisionId, render: (f) => f.divisionId },
            { key: 'rank', label: 'Rk', numeric: true, sort: (f) => (f.isChampion ? 0 : (f.ranking ?? 99)), render: (f) => (f.isChampion ? 'C' : (f.ranking ?? '-')) },
            { key: 'ovr', label: 'Ovr', numeric: true, sort: (f) => estimateRatings(save, f).ovr, render: (f) => <Rating value={estimateRatings(save, f).ovr} /> },
            { key: 'pot', label: 'Pot', numeric: true, sort: (f) => estimateRatings(save, f).pot, render: (f) => <Rating value={estimateRatings(save, f).pot} /> },
            { key: 'happy', label: 'Happiness', numeric: true, sort: (f) => f.happiness, render: (f) => <Bar value={f.happiness} /> },
          ]}
          empty="No fighters currently train here."
        />
      </Panel>
    </div>
  );
}
