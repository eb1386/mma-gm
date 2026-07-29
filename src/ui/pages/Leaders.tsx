import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DIVISIONS, type DivisionId } from '@core/config/divisions';
import { formatNumber } from '@core/types/common';
import type { FightResult } from '@core/types/fight';
import { useGame } from '../store';
import { DataTable, Panel } from '../components';

interface LeaderRow {
  fighterId: string;
  name: string;
  divisionId: DivisionId;
  fights: number;
  minutes: number;
  sigLanded: number;
  sigAttempted: number;
  sigAbsorbed: number;
  takedowns: number;
  takedownAttempts: number;
  subAttempts: number;
  knockdowns: number;
  control: number;
}

/**
 * Career rate leaders, computed from stored bout totals. Every number here is derived
 * from fights simulated inside this save, not from any external statistic.
 */
export function LeadersPage() {
  const save = useGame((s) => s.save)!;
  const revision = useGame((s) => s.revision);
  const [division, setDivision] = useState<DivisionId | 'all'>('all');
  const [minFights, setMinFights] = useState(3);

  const rows = useMemo(() => {
    const map = new Map<string, LeaderRow>();
    const add = (id: string, r: FightResult, isA: boolean) => {
      const f = save.fighters[id];
      if (!f) return;
      let row = map.get(id);
      if (!row) {
        row = {
          fighterId: id,
          name: f.name,
          divisionId: f.divisionId,
          fights: 0,
          minutes: 0,
          sigLanded: 0,
          sigAttempted: 0,
          sigAbsorbed: 0,
          takedowns: 0,
          takedownAttempts: 0,
          subAttempts: 0,
          knockdowns: 0,
          control: 0,
        };
        map.set(id, row);
      }
      const mine = isA ? r.totalsA : r.totalsB;
      const theirs = isA ? r.totalsB : r.totalsA;
      row.fights++;
      row.minutes += (r.endRound - 1) * 5 + r.endTimeSeconds / 60;
      row.sigLanded += mine.sigStrikesLanded;
      row.sigAttempted += mine.sigStrikesAttempted;
      row.sigAbsorbed += theirs.sigStrikesLanded;
      row.takedowns += mine.takedownsLanded;
      row.takedownAttempts += mine.takedownsAttempted;
      row.subAttempts += mine.submissionAttempts;
      row.knockdowns += mine.knockdowns;
      row.control += mine.controlSeconds;
    };
    for (const r of Object.values(save.history.results)) {
      add(r.fighterAId, r, true);
      add(r.fighterBId, r, false);
    }
    return [...map.values()].filter((r) => r.fights >= minFights && (division === 'all' || r.divisionId === division));
  }, [save, revision, division, minFights]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Statistical leaders</h1>
        <span className="sub">Rate statistics from fights simulated in this save</span>
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
          <label>Minimum fights</label>
          <input type="number" min={1} max={30} value={minFights} onChange={(e) => setMinFights(Number(e.target.value))} style={{ width: 60 }} />
          <span className="small dim">{rows.length} qualifying fighters</span>
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.fighterId}
          initialSort="slpm"
          maxHeight={620}
          rowClass={(r) => (r.fighterId === save.player.fighterId ? 'highlight' : undefined)}
          columns={[
            { key: 'name', label: 'Fighter', sort: (r) => r.name, render: (r) => <Link to={`/fighter/${r.fighterId}`}>{r.name}</Link> },
            { key: 'div', label: 'Div', sort: (r) => r.divisionId, render: (r) => r.divisionId },
            { key: 'fights', label: 'Fights', numeric: true, sort: (r) => r.fights, render: (r) => r.fights },
            { key: 'minutes', label: 'Minutes', numeric: true, sort: (r) => r.minutes, render: (r) => formatNumber(r.minutes, 1) },
            {
              key: 'slpm',
              label: 'SLpM',
              title: 'Significant strikes landed per minute',
              numeric: true,
              sort: (r) => r.sigLanded / Math.max(1, r.minutes),
              render: (r) => formatNumber(r.sigLanded / Math.max(1, r.minutes), 2),
            },
            {
              key: 'sapm',
              label: 'SApM',
              title: 'Significant strikes absorbed per minute',
              numeric: true,
              sort: (r) => r.sigAbsorbed / Math.max(1, r.minutes),
              render: (r) => formatNumber(r.sigAbsorbed / Math.max(1, r.minutes), 2),
            },
            {
              key: 'acc',
              label: 'Acc',
              title: 'Significant strike accuracy',
              numeric: true,
              sort: (r) => r.sigLanded / Math.max(1, r.sigAttempted),
              render: (r) => `${Math.round((r.sigLanded / Math.max(1, r.sigAttempted)) * 100)}%`,
            },
            {
              key: 'td15',
              label: 'TD/15',
              title: 'Takedowns landed per fifteen minutes',
              numeric: true,
              sort: (r) => (r.takedowns / Math.max(1, r.minutes)) * 15,
              render: (r) => formatNumber((r.takedowns / Math.max(1, r.minutes)) * 15, 2),
            },
            {
              key: 'tdacc',
              label: 'TD acc',
              numeric: true,
              sort: (r) => r.takedowns / Math.max(1, r.takedownAttempts),
              render: (r) => `${Math.round((r.takedowns / Math.max(1, r.takedownAttempts)) * 100)}%`,
            },
            {
              key: 'sub15',
              label: 'Sub/15',
              title: 'Submission attempts per fifteen minutes',
              numeric: true,
              sort: (r) => (r.subAttempts / Math.max(1, r.minutes)) * 15,
              render: (r) => formatNumber((r.subAttempts / Math.max(1, r.minutes)) * 15, 2),
            },
            {
              key: 'kd15',
              label: 'KD/15',
              numeric: true,
              sort: (r) => (r.knockdowns / Math.max(1, r.minutes)) * 15,
              render: (r) => formatNumber((r.knockdowns / Math.max(1, r.minutes)) * 15, 2),
            },
            {
              key: 'ctrl',
              label: 'Control/fight',
              title: 'Average control seconds per fight',
              numeric: true,
              sort: (r) => r.control / Math.max(1, r.fights),
              render: (r) => formatNumber(r.control / Math.max(1, r.fights), 0),
            },
          ]}
          empty="No fights recorded yet."
        />
      </Panel>
    </div>
  );
}
