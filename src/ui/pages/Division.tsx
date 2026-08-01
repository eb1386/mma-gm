import { Link, useParams } from 'react-router-dom';
import { DIVISION_BY_ID, type DivisionId } from '@core/config/divisions';
import { ageOn, daysBetween, formatDate } from '@core/types/common';
import { METHOD_LABEL } from '@core/types/fight';
import { estimateRatings } from '@core/world/scouting';
import { titleLineage } from '@core/world/history';
import { deriveFighterStatus, FIGHTER_STATUS_LABEL, statusTone } from '@core/world/status';
import { useGame } from '../store';
import { DataTable, EstimatedRating, Notice, Panel, RATING_COLUMN_HEADS, Rating, RealTag } from '../components';
import { currentContender } from '@core/world/contender';

export function DivisionPage() {
  const save = useGame((s) => s.save)!;
  const { divisionId } = useParams();
  const id = divisionId as DivisionId;
  const division = DIVISION_BY_ID[id];
  if (!division) return <div className="page"><Notice kind="bad">Unknown division.</Notice></div>;

  const table = save.rankings[id];
  const champ = table.championId ? save.fighters[table.championId] : null;
  const interim = table.interimChampionId ? save.fighters[table.interimChampionId] : null;
  const contender = currentContender(save, id);
  const contenderFighter = contender ? save.fighters[contender.fighterId] : null;
  const fighters = Object.values(save.fighters).filter((f) => f.divisionId === id && !f.retired && f.activityStatus === 'active');
  const lineage = titleLineage(save, id);
  const recent = Object.values(save.history.results)
    .filter((r) => r.divisionId === id)
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .slice(0, 20);
  const upcoming = Object.values(save.bouts)
    .filter((b) => b.divisionId === id && b.status === 'scheduled')
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return (
    <div className="page">
      <div className="page-head">
        <h1>{division.name}</h1>
        <span className="sub">
          Championship limit {division.limitLb} lb, non title bouts at {division.limitLb + division.nonTitleAllowanceLb} lb ·{' '}
          {fighters.length} active fighters
        </span>
      </div>

      <div className="grid c2">
        <Panel title="Championship">
          {champ ? (
            <p>
              <strong style={{ fontSize: 15 }}>
                <Link to={`/fighter/${champ.id}`}>{champ.name}</Link>
              </strong>{' '}
              <span className="tag champ">Champion</span>
              <br />
              <span className="dim small">
                {champ.ufcRecord.wins}-{champ.ufcRecord.losses} in the promotion ·{' '}
                {lineage.find((r) => r.fighterId === champ.id && r.lostOn === null)?.defenses ?? 0} defenses · champion
                since {lineage.find((r) => r.fighterId === champ.id && r.lostOn === null)?.wonOn ?? 'unknown'}
              </span>
            </p>
          ) : (
            <Notice kind="warn">The title is vacant. The next available contenders will fight for it.</Notice>
          )}
          {interim && (
            <p className="small">
              Interim champion: <Link to={`/fighter/${interim.id}`}>{interim.name}</Link>
            </p>
          )}
          {contender && contenderFighter && (
            <p className="small">
              Number one contender: <Link to={`/fighter/${contenderFighter.id}`}>{contenderFighter.name}</Link>
              <br />
              {/* The record has always carried why the position was earned and when it expires.
                  Nothing displayed any of it, so the one rule that decides who fights for the belt
                  was invisible to the player it decides for. */}
              <span className="dim">
                {contender.note} Claimed {formatDate(contender.earnedOn)}, held until {formatDate(contender.expiresOn)}.
              </span>
            </p>
          )}
        </Panel>

        <Panel title="Upcoming bouts in this division" flush>
          <table>
            <tbody>
              {upcoming.slice(0, 10).map((b) => (
                <tr key={b.id}>
                  <td className="dim small nowrap">{formatDate(b.date)}</td>
                  <td>
                    <Link to={`/fighter/${b.fighterAId}`}>{save.fighters[b.fighterAId]?.name}</Link> against{' '}
                    <Link to={`/fighter/${b.fighterBId}`}>{save.fighters[b.fighterBId]?.name}</Link>
                  </td>
                  <td className="small">
                    {b.isTitleFight && <span className="tag champ">title</span>}
                    {b.isInterimTitleFight && <span className="tag interim">interim</span>}
                  </td>
                  <td className="small dim">
                    <Link to={`/event/${b.eventId}`}>{save.events[b.eventId]?.name}</Link>
                  </td>
                </tr>
              ))}
              {upcoming.length === 0 && (
                <tr>
                  <td className="dim small">Nothing booked yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Division roster" flush>
        <DataTable
          rows={fighters}
          rowKey={(f) => f.id}
          initialSort="rank"
          initialDir="asc"
          maxHeight={520}
          rowClass={(f) => (save.player.fighterId === f.id ? 'highlight' : undefined)}
          columns={[
            {
              key: 'rank',
              label: 'Rk',
              numeric: true,
              sort: (f) => (f.isChampion ? 0 : (f.ranking ?? 99)),
              render: (f) => (f.isChampion ? <span className="gold">C</span> : (f.ranking ?? <span className="faint">-</span>)),
            },
            { key: 'name', label: 'Fighter', sort: (f) => f.name, render: (f) => <Link to={`/fighter/${f.id}`}>{f.name}</Link> },
            { key: 'age', label: 'Age', numeric: true, sort: (f) => ageOn(f.birthDate, save.date) ?? f.ageAtSnapshot ?? 0, render: (f) => ageOn(f.birthDate, save.date) ?? f.ageAtSnapshot ?? '?' },
            {
              key: 'record',
              label: 'Promo',
              sort: (f) => f.ufcRecord.wins - f.ufcRecord.losses,
              render: (f) => `${f.ufcRecord.wins}-${f.ufcRecord.losses}`,
            },
            {
              key: 'streak',
              label: 'Streak',
              numeric: true,
              sort: (f) => f.winStreak - f.lossStreak,
              render: (f) =>
                f.winStreak > 0 ? <span className="good">W{f.winStreak}</span> : f.lossStreak > 0 ? <span className="bad">L{f.lossStreak}</span> : <span className="faint">-</span>,
            },
            {
              key: 'ovr',
              label: 'Ovr',
              numeric: true,
              sort: (f) => estimateRatings(save, f).ovr,
              render: (f) => {
                const e = estimateRatings(save, f);
                return <EstimatedRating estimate={e.ovr} low={e.exact ? undefined : e.ovrLow} high={e.exact ? undefined : e.ovrHigh} />;
              },
            },
            { key: 'pot', label: 'Pot', numeric: true, sort: (f) => estimateRatings(save, f).pot, render: (f) => <Rating value={estimateRatings(save, f).pot} /> },
            ...RATING_COLUMN_HEADS.map((h) => ({
              key: h.key,
              label: h.label,
              title: h.title,
              numeric: true,
              sort: (f: (typeof fighters)[number]) => estimateRatings(save, f).ratings[h.key],
              render: (f: (typeof fighters)[number]) => {
                const e = estimateRatings(save, f);
                return <EstimatedRating estimate={e.ratings[h.key]} low={e.exact ? undefined : e.low[h.key]} high={e.exact ? undefined : e.high[h.key]} />;
              },
            })),
            { key: 'lng', label: 'Lng', numeric: true, sort: (f) => f.longevity, render: (f) => <Rating value={f.longevity} /> },
            {
              key: 'active',
              label: 'Last fight',
              numeric: true,
              sort: (f) => (f.lastFightDate ? daysBetween(f.lastFightDate, save.date) : 9999),
              render: (f) => (f.lastFightDate ? `${daysBetween(f.lastFightDate, save.date)}d` : <span className="faint">-</span>),
            },
            {
              key: 'status',
              label: 'Status',
              render: (f) => {
                const v = deriveFighterStatus(save, f);
                const tone = statusTone(v.status);
                return (
                  <span className={`small ${tone === 'dim' ? 'faint' : tone}`} title={v.detail}>
                    {FIGHTER_STATUS_LABEL[v.status]}
                  </span>
                );
              },
            },
            { key: 'origin', label: '', render: (f) => <RealTag fighter={f} /> },
          ]}
        />
      </Panel>

      <div className="grid c2">
        <Panel title="Title lineage" flush>
          <table>
            <thead>
              <tr>
                <th>Champion</th>
                <th>Won</th>
                <th>Lost</th>
                <th className="num">Days</th>
                <th className="num">Def</th>
                <th>End</th>
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
            </tbody>
          </table>
        </Panel>

        <Panel title="Recent results" flush>
          <table>
            <tbody>
              {recent.map((r) => (
                <tr key={r.boutId}>
                  <td className="dim small nowrap">{formatDate(r.date)}</td>
                  <td className="wrap">
                    {r.winnerId ? (
                      <>
                        <Link to={`/fighter/${r.winnerId}`}>{save.fighters[r.winnerId]?.name}</Link>{' '}
                        <span className="dim">beat</span>{' '}
                        <Link to={`/fighter/${r.loserId ?? ''}`}>{r.loserId ? save.fighters[r.loserId]?.name : 'opponent'}</Link>
                      </>
                    ) : (
                      <>
                        {save.fighters[r.fighterAId]?.name} drew with {save.fighters[r.fighterBId]?.name}
                      </>
                    )}
                  </td>
                  <td className="small dim">{METHOD_LABEL[r.method]}</td>
                  <td>
                    <Link className="btn small" to={`/fight/${r.boutId}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
