import { Link } from 'react-router-dom';
import { DIVISIONS, DIVISION_BY_ID } from '@core/config/divisions';
import { formatDate } from '@core/types/common';
import { estimateRatings } from '@core/world/scouting';
import { useGame } from '../store';
import { EstimatedRating, Panel, RealTag } from '../components';

function Movement({ from, to }: { from: number | null; to: number }) {
  if (from === null) return <span className="good small">new</span>;
  if (from === to) return <span className="faint small">-</span>;
  const delta = from - to;
  return <span className={`small ${delta > 0 ? 'good' : 'bad'}`}>{delta > 0 ? `▲${delta}` : `▼${-delta}`}</span>;
}

export function RankingsPage() {
  const save = useGame((s) => s.save)!;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Rankings</h1>
        <span className="sub">
          {save.rankings.lightweight.fromOfficialSnapshot
            ? `Imported from the official rankings captured ${save.snapshot.snapshotDate}`
            : `Simulated standings, updated ${formatDate(save.rankings.lightweight.updatedOn)}`}
        </span>
      </div>

      <Panel title="Pound for pound" flush>
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Fighter</th>
              <th>Division</th>
              <th className="num">Ovr</th>
              <th className="num">Move</th>
              <th>Origin</th>
            </tr>
          </thead>
          <tbody>
            {save.pfp.entries.map((e) => {
              const f = save.fighters[e.fighterId];
              if (!f) return null;
              const est = estimateRatings(save, f);
              return (
                <tr key={e.fighterId} className={save.player.fighterId === f.id ? 'highlight' : undefined}>
                  <td className="num">{e.rank}</td>
                  <td>
                    <Link to={`/fighter/${f.id}`}>{f.name}</Link>
                    {f.isChampion && <span className="tag champ" style={{ marginLeft: 4 }}>C</span>}
                  </td>
                  <td>
                    <Link to={`/division/${f.divisionId}`}>{DIVISION_BY_ID[f.divisionId].shortName}</Link>
                  </td>
                  <td className="num">
                    <EstimatedRating estimate={est.ovr} low={est.exact ? undefined : est.ovrLow} high={est.exact ? undefined : est.ovrHigh} />
                  </td>
                  <td className="num">
                    <Movement from={e.previousRank} to={e.rank} />
                  </td>
                  <td>
                    <RealTag fighter={f} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <div className="grid c2">
        {DIVISIONS.map((d) => {
          const t = save.rankings[d.id];
          const champ = t.championId ? save.fighters[t.championId] : null;
          const interim = t.interimChampionId ? save.fighters[t.interimChampionId] : null;
          return (
            <Panel key={d.id} title={<Link to={`/division/${d.id}`}>{d.name}</Link>} actions={<span className="small dim">{d.limitLb} lb</span>} flush>
              <table>
                <tbody>
                  <tr>
                    <td className="num gold">C</td>
                    <td colSpan={3}>
                      {champ ? (
                        <>
                          <Link to={`/fighter/${champ.id}`}>{champ.name}</Link>{' '}
                          <span className="dim small">
                            {champ.ufcRecord.wins}-{champ.ufcRecord.losses}
                          </span>
                        </>
                      ) : (
                        <span className="faint">Vacant</span>
                      )}
                    </td>
                  </tr>
                  {interim && (
                    <tr>
                      <td className="num warn">IC</td>
                      <td colSpan={3}>
                        <Link to={`/fighter/${interim.id}`}>{interim.name}</Link>
                      </td>
                    </tr>
                  )}
                  {t.entries.map((e) => {
                    const f = save.fighters[e.fighterId];
                    if (!f) return null;
                    const est = estimateRatings(save, f);
                    return (
                      <tr key={e.fighterId} className={save.player.fighterId === f.id ? 'highlight' : undefined}>
                        <td className="num dim">{e.rank}</td>
                        <td>
                          <Link to={`/fighter/${f.id}`}>{f.name}</Link>
                        </td>
                        <td className="num">
                          <EstimatedRating estimate={est.ovr} low={est.exact ? undefined : est.ovrLow} high={est.exact ? undefined : est.ovrHigh} />
                        </td>
                        <td className="num">
                          <Movement from={e.previousRank} to={e.rank} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          );
        })}
      </div>

      <p className="small faint">
        Rankings follow results, not ratings. Nothing on this page reads Ovr: a highly rated inactive fighter falls, and
        a lower rated fighter who beats ranked opposition rises.
      </p>
    </div>
  );
}
