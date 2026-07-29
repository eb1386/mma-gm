import { Link } from 'react-router-dom';
import { DIVISIONS } from '@core/config/divisions';
import { formatDate } from '@core/types/common';
import { titleLineage } from '@core/world/history';
import { useGame } from '../store';
import { Panel } from '../components';

export function HistoryPage() {
  const save = useGame((s) => s.save)!;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Title history</h1>
        <span className="sub">
          {save.history.reigns.length} reigns recorded since {formatDate(save.startDate)}
        </span>
      </div>

      <div className="grid c2">
        {DIVISIONS.map((d) => {
          const lineage = titleLineage(save, d.id);
          return (
            <Panel key={d.id} title={<Link to={`/division/${d.id}`}>{d.name}</Link>} flush>
              <table>
                <thead>
                  <tr>
                    <th>Champion</th>
                    <th>From</th>
                    <th>To</th>
                    <th className="num">Days</th>
                    <th className="num">Def</th>
                    <th>Ended</th>
                  </tr>
                </thead>
                <tbody>
                  {lineage.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/fighter/${r.fighterId}`}>{r.fighterName}</Link>
                      </td>
                      <td className="small">{r.wonOn}</td>
                      <td className="small">{r.lostOn ?? <span className="good">current</span>}</td>
                      <td className="num">{r.days}</td>
                      <td className="num">{r.defenses}</td>
                      <td className="small dim">{r.endReason ?? ''}</td>
                    </tr>
                  ))}
                  {lineage.length === 0 && (
                    <tr>
                      <td colSpan={6} className="dim small">
                        No reigns recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          );
        })}
      </div>

      <Panel title="Retirements" flush>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Fighter</th>
              <th>Record</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {save.history.retirements
              .slice()
              .reverse()
              .slice(0, 60)
              .map((r, i) => {
                const f = save.fighters[r.fighterId];
                return (
                  <tr key={`${r.fighterId}-${i}`}>
                    <td>{formatDate(r.date)}</td>
                    <td>{f ? <Link to={`/fighter/${f.id}`}>{f.name}</Link> : 'Unknown'}</td>
                    <td className="mono small">
                      {f ? `${f.record.wins}-${f.record.losses}${f.record.draws ? `-${f.record.draws}` : ''}` : ''}
                    </td>
                    <td className="small dim wrap">{r.reason}</td>
                  </tr>
                );
              })}
            {save.history.retirements.length === 0 && (
              <tr>
                <td className="dim small">Nobody has retired yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="Awards" flush>
        <table>
          <thead>
            <tr>
              <th className="num">Year</th>
              <th>Award</th>
              <th>Winner</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {save.history.awards
              .slice()
              .reverse()
              .map((a, i) => (
                <tr key={i}>
                  <td className="num">{a.year}</td>
                  <td>{a.key.split('-').join(' ')}</td>
                  <td>
                    {a.fighterId ? (
                      <Link to={`/fighter/${a.fighterId}`}>{save.fighters[a.fighterId]?.name}</Link>
                    ) : a.gymId ? (
                      <Link to={`/gym/${a.gymId}`}>{save.gyms[a.gymId]?.name}</Link>
                    ) : a.boutId ? (
                      <Link to={`/fight/${a.boutId}`}>view the fight</Link>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="small dim wrap">{a.note}</td>
                </tr>
              ))}
            {save.history.awards.length === 0 && (
              <tr>
                <td colSpan={4} className="dim small">
                  Awards are decided at the end of each calendar year.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
