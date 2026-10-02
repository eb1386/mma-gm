import { Link } from 'react-router-dom';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { daysBetween, formatDate } from '@core/types/common';
import { METHOD_LABEL } from '@core/types/fight';
import { useGame } from '../store';
import { Panel } from '../components';
import { headliner } from '../headliner';
import { scheduledBoutCount, scheduledBoutLabel } from '../bouts';

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

  const mainOf = (eventId: string) => headliner(save, save.events[eventId]);

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
              <th className="col-wide">Location</th>
              <th className="d-only">Main event</th>
              <th className="num col-wide">Bouts</th>
              <th className="col-wide">Tier</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.length === 0 && (
              <tr>
                <td className="faint small" colSpan={7}>
                  No events scheduled.
                </td>
              </tr>
            )}
            {upcoming.map((e) => {
              const main = mainOf(e.id);
              const a = main ? save.fighters[main.fighterAId] : null;
              const b = main ? save.fighters[main.fighterBId] : null;
              const playerOnCard = main && playerId ? e.boutIds.some((id) => {
                const bt = save.bouts[id];
                return bt && (bt.fighterAId === playerId || bt.fighterBId === playerId);
              }) : false;
              const n = scheduledBoutCount(save, e);
              const mainLine =
                a && b ? (
                  <>
                    {a.name} against {b.name}
                    {main?.isTitleFight && <span className="tag champ" style={{ marginLeft: 4 }}>title</span>}
                    {main?.isInterimTitleFight && <span className="tag interim" style={{ marginLeft: 4 }}>interim</span>}
                    {main?.regionalTitle && <span className="tag champ" style={{ marginLeft: 4 }}>regional title</span>}
                    {main && <span className="dim"> · {DIVISION_BY_ID[main.divisionId].abbr}</span>}
                  </>
                ) : (
                  <span className="faint">card not yet announced</span>
                );
              return (
                <tr key={e.id} className={playerOnCard ? 'highlight' : undefined}>
                  <td className="nowrap">{formatDate(e.date)}</td>
                  <td className="num dim">{daysBetween(save.date, e.date)}d</td>
                  <td>
                    <Link to={`/event/${e.id}`}>{e.name}</Link>
                    {/* The main event column is the one a phone hides off screen, so it rides under the name. */}
                    <div className="small m-only cal-main">
                      {mainLine}
                      {n > 0 && <span className="dim"> · {scheduledBoutLabel(save, e)}</span>}
                    </div>
                  </td>
                  <td className="dim small col-wide">
                    {e.city}, {e.country}
                  </td>
                  <td className="small d-only">{mainLine}</td>
                  <td className="num col-wide">{n > 0 ? n : <span className="faint">TBA</span>}</td>
                  <td className="small dim col-wide">{e.tier.replace('-', ' ')}</td>
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
              <th className="col-wide">Location</th>
              <th>Main event result</th>
              <th className="num col-wide">Bouts</th>
              <th className="num col-wide">Attendance</th>
            </tr>
          </thead>
          <tbody>
            {past.length === 0 && (
              <tr>
                <td className="faint small" colSpan={6}>
                  No events have been contested yet.
                </td>
              </tr>
            )}
            {past.map((e) => {
              const main = mainOf(e.id);
              const result = main ? (save.history.results[main.resultId ?? main.id] ?? null) : null;
              return (
                <tr key={e.id}>
                  <td className="nowrap">{formatDate(e.date)}</td>
                  <td>
                    <Link to={`/event/${e.id}`}>{e.name}</Link>
                  </td>
                  <td className="dim small col-wide">{e.city}</td>
                  <td className="small wrap">
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
                  <td className="num col-wide">{e.boutIds.length}</td>
                  <td className="num dim col-wide">{e.attendance ? e.attendance.toLocaleString('en-US') : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
