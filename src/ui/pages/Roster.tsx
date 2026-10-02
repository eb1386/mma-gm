import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '@core/config/divisions';
import { ageOn, formatMoney } from '@core/types/common';
import type { Fighter } from '@core/types/fighter';
import { estimateRatings } from '@core/world/scouting';
import { deriveFighterStatus, FIGHTER_STATUS_LABEL, statusTone } from '@core/world/status';
import { useGame } from '../store';
import { nameMatches } from '../search';
import { DataTable, EstimatedRating, type Column, Panel, RATING_COLUMN_HEADS, Rating, RealTag, playerTagFor } from '../components';

export function RosterPage() {
  const save = useGame((s) => s.save)!;
  const [params, setParams] = useSearchParams();
  const [division, setDivision] = useState<DivisionId | 'all'>('all');
  const q = params.get('q') ?? '';
  // Arriving with a name from the fighter search shows everyone, so a retired fighter the search
  // matched is not filtered straight back out by the Active default.
  const [status, setStatus] = useState<'active' | 'all' | 'retired' | 'free-agent'>(() => (q ? 'all' : 'active'));
  const [origin, setOrigin] = useState<'all' | 'real' | 'fictional'>('all');

  const { rows, hiddenByStatus } = useMemo(() => {
    const out: Fighter[] = [];
    let hidden = 0;
    for (const f of Object.values(save.fighters)) {
      // The roster is the main promotion's. Regional fighters have their own page.
      if (f.circuit) continue;
      if (division !== 'all' && f.divisionId !== division) continue;
      if (origin === 'real' && !f.isRealPerson) continue;
      if (origin === 'fictional' && f.isRealPerson) continue;
      if (q && !nameMatches(f.name, q)) continue;
      let statusOk = true;
      if (status === 'active' && (f.retired || f.activityStatus !== 'active')) statusOk = false;
      if (status === 'retired' && !f.retired) statusOk = false;
      if (status === 'free-agent') {
        const c = f.contractId ? save.contracts[f.contractId] : null;
        if ((c && c.status === 'active') || f.retired) statusOk = false;
      }
      if (statusOk) out.push(f);
      else hidden++;
    }
    return { rows: out, hiddenByStatus: hidden };
  }, [save, division, status, origin, q]);

  // One estimate per fighter per render. The columns used to call estimateRatings for every cell and
  // twice per comparison while sorting, about twenty thousand calls for an Ovr sort, and each call
  // rebuilds the scouting context. Fighters are estimated one by one (no shared context), because
  // the own fighter and the booked opponent are decided per fighter.
  const estById = useMemo(() => new Map(rows.map((f) => [f.id, estimateRatings(save, f)])), [rows, save]);
  const estOf = (f: Fighter) => estById.get(f.id) ?? estimateRatings(save, f);

  // A stable columns array, so DataTable does not re-sort on renders that change nothing it shows.
  const columns = useMemo<Column<Fighter>[]>(
    () => [
      {
        key: 'name',
        label: 'Fighter',
        sort: (f) => f.name,
        render: (f) => (
          <span className="row tight">
            <Link to={`/fighter/${f.id}`}>{f.name}</Link>
            {f.isChampion && <span className="tag champ">C</span>}
            {f.isInterimChampion && <span className="tag interim">IC</span>}
            {playerTagFor(save, f)}
          </span>
        ),
      },
      {
        key: 'div',
        label: 'Div',
        sort: (f) => DIVISION_BY_ID[f.divisionId].order,
        render: (f) => <Link to={`/division/${f.divisionId}`}>{DIVISION_BY_ID[f.divisionId].abbr}</Link>,
      },
      {
        key: 'rank',
        label: 'Rk',
        numeric: true,
        sort: (f) => (f.isChampion ? 0 : (f.ranking ?? 99)),
        render: (f) => (f.isChampion ? 'C' : (f.ranking ?? '-')),
      },
      { key: 'age', label: 'Age', numeric: true, sort: (f) => ageOn(f.birthDate, save.date) ?? f.ageAtSnapshot ?? 0, render: (f) => ageOn(f.birthDate, save.date) ?? f.ageAtSnapshot ?? '?' },
      {
        key: 'record',
        label: 'Record',
        sort: (f) => f.record.wins - f.record.losses,
        render: (f) => (
          <span className="mono">
            {f.record.wins}-{f.record.losses}
            {f.record.draws ? `-${f.record.draws}` : ''}
          </span>
        ),
      },
      {
        key: 'ovr',
        label: 'Ovr',
        numeric: true,
        sort: (f) => estOf(f).ovr,
        render: (f) => {
          const e = estOf(f);
          return <EstimatedRating estimate={e.ovr} low={e.exact ? undefined : e.ovrLow} high={e.exact ? undefined : e.ovrHigh} />;
        },
      },
      { key: 'pot', label: 'Pot', numeric: true, sort: (f) => estOf(f).pot, render: (f) => <Rating value={estOf(f).pot} /> },
      ...RATING_COLUMN_HEADS.map((h) => ({
        key: h.key,
        label: h.label,
        title: h.title,
        numeric: true,
        sort: (f: Fighter) => estOf(f).ratings[h.key],
        render: (f: Fighter) => {
          const e = estOf(f);
          return <EstimatedRating estimate={e.ratings[h.key]} low={e.exact ? undefined : e.low[h.key]} high={e.exact ? undefined : e.high[h.key]} />;
        },
      })),
      { key: 'lng', label: 'Lng', title: 'Longevity, remaining career resilience', numeric: true, sort: (f) => f.longevity, render: (f) => <Rating value={f.longevity} /> },
      { key: 'pop', label: 'Pop', title: 'Popularity', numeric: true, sort: (f) => f.popularity, render: (f) => Math.round(f.popularity) },
      {
        key: 'gym',
        label: 'Gym',
        sort: (f) => (f.gymId ? save.gyms[f.gymId]?.name ?? '' : ''),
        render: (f) => (f.gymId && save.gyms[f.gymId] ? <Link to={`/gym/${f.gymId}`}>{save.gyms[f.gymId].name}</Link> : <span className="faint">none</span>),
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
      { key: 'earn', label: 'Earnings', numeric: true, sort: (f) => f.careerEarnings, render: (f) => <span className="mono">{formatMoney(f.careerEarnings)}</span> },
      { key: 'origin', label: 'Origin', render: (f) => <RealTag fighter={f} /> },
    ],
    [save, estById],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Roster</h1>
        <span className="sub">{rows.length} fighters</span>
      </div>

      <Panel flush>
        <div className="row" style={{ padding: 8 }}>
          <select value={division} onChange={(e) => setDivision(e.target.value as DivisionId | 'all')}>
            <option value="all">All divisions</option>
            {DIVISIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="free-agent">Free agents</option>
            <option value="retired">Retired</option>
            <option value="all">Everyone</option>
          </select>
          <select value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
            <option value="all">All origins</option>
            <option value="real">Real fighters</option>
            <option value="fictional">Fictional fighters</option>
          </select>
          <input
            type="search"
            placeholder="Filter by name"
            value={q}
            onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
          />
        </div>
        {/* A name typed here can match a retired fighter that the status filter hides, which looked like
            the fighter was missing from the game. */}
        {q && hiddenByStatus > 0 && (
          <p className="small dim" style={{ padding: '0 8px 8px' }}>
            {hiddenByStatus} more {hiddenByStatus === 1 ? 'fighter matches' : 'fighters match'} this name outside the status filter.{' '}
            <button className="small" onClick={() => setStatus('all')}>
              Show everyone
            </button>
          </p>
        )}
        <DataTable
          rows={rows}
          rowKey={(f) => f.id}
          initialSort="ovr"
          maxHeight={640}
          rowClass={(f) => (save.player.fighterId === f.id ? 'highlight' : undefined)}
          columns={columns}
        />
      </Panel>
    </div>
  );
}
