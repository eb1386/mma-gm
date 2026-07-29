import { Link } from 'react-router-dom';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { daysBetween, formatDate } from '@core/types/common';
import { METHOD_LABEL } from '@core/types/fight';
import { useGame } from '../store';
import { Panel } from '../components';

export function CalendarPage() {
  const save = useGame((s) => s.save)!;
  const upcoming = Object.values(save.events)
    .filter((e) => e.status === 'announced')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const past = Object.values(save.events)
    .filter((e) => e.status === 'completed')
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .slice(0, 40);
  const playerId = save.player.fighterId;

  const mainOf = (eventId: string) => {
    const ev = save.events[eventId];
    const bout = ev.boutIds.map((id) => save.bouts[id]).find((b) => b?.isMainEvent) ?? save.bouts[ev.boutIds[0]];
    if (!bout) return null;
    return bout;
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Calendar</h1>
        <span className="sub">{formatDate(save.date)}</span>
      </div>

      <Panel title={`Upcoming (${upcoming.length})`} flush>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">In</th>
              <th>Event</th>
              <th>Location</th>
              <th>Main event</th>
              <th className="num">Bouts</th>
              <th>Tier</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map((e) => {
              const main = mainOf(e.id);
              const a = main ? save.fighters[main.fighterAId] : null;
              const b = main ? save.fighters[main.fighterBId] : null;
              const playerOnCard = main && playerId ? e.boutIds.some((id) => {
                const bt = save.bouts[id];
                return bt && (bt.fighterAId === playerId || bt.fighterBId === playerId);
              }) : false;
              return (
                <tr key={e.id} className={playerOnCard ? 'highlight' : undefined}>
                  <td className="nowrap">{formatDate(e.date)}</td>
                  <td className="num dim">{daysBetween(save.date, e.date)}d</td>
                  <td>
                    <Link to={`/event/${e.id}`}>{e.name}</Link>
                  </td>
                  <td className="dim small">
                    {e.city}, {e.country}
                  </td>
                  <td className="small">
                    {a && b ? (
                      <>
                        {a.name} against {b.name}
                        {main?.isTitleFight && <span className="tag champ" style={{ marginLeft: 4 }}>title</span>}
                        {main?.isInterimTitleFight && <span className="tag interim" style={{ marginLeft: 4 }}>interim</span>}
                        {main && <span className="dim"> · {DIVISION_BY_ID[main.divisionId].abbr}</span>}
                      </>
                    ) : (
                      <span className="faint">card not yet announced</span>
                    )}
                  </td>
                  <td className="num">{e.boutIds.filter((id) => save.bouts[id]?.status === 'scheduled').length}</td>
                  <td className="small dim">{e.tier.replace('-', ' ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title="Completed events" flush>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Event</th>
              <th>Location</th>
              <th>Main event result</th>
              <th className="num">Bouts</th>
              <th className="num">Attendance</th>
            </tr>
          </thead>
          <tbody>
            {past.map((e) => {
              const main = mainOf(e.id);
              const result = main?.resultId ? save.history.results[main.resultId] : null;
              return (
                <tr key={e.id}>
                  <td className="nowrap">{formatDate(e.date)}</td>
                  <td>
                    <Link to={`/event/${e.id}`}>{e.name}</Link>
                  </td>
                  <td className="dim small">{e.city}</td>
                  <td className="small">
                    {result ? (
                      <>
                        {result.winnerId ? (
                          <Link to={`/fighter/${result.winnerId}`}>{save.fighters[result.winnerId]?.name}</Link>
                        ) : (
                          'Draw'
                        )}{' '}
                        <span className="dim">
                          {METHOD_LABEL[result.method]} R{result.endRound}
                        </span>
                      </>
                    ) : (
                      <span className="faint">no result recorded</span>
                    )}
                  </td>
                  <td className="num">{e.boutIds.length}</td>
                  <td className="num dim">{e.attendance ? e.attendance.toLocaleString('en-US') : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
