import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate } from '@core/types/common';
import {
  allOfficials,
  controversyRate,
  ensureOfficials,
  officialSummary,
  type Official,
  type OfficialRole,
} from '@core/world/officials';
import { useGame } from '../store';
import { Panel } from '../components';

/**
 * Judges and referees.
 *
 * Officials used to be three names drawn per fight and thrown away. They are people in the
 * world now, so this page is a record: who they are, how they lean, how much they have worked,
 * and which of their cards were out of step with the other two.
 */

function experienceLabel(o: Official): string {
  if (o.experience >= 85) return 'Vastly experienced';
  if (o.experience >= 65) return 'Experienced';
  if (o.experience >= 40) return 'Established';
  if (o.experience >= 20) return 'Developing';
  return 'New to the role';
}

export function OfficialsPage() {
  const save = useGame((s) => s.save)!;
  const [role, setRole] = useState<OfficialRole>('judge');
  const [sortKey, setSortKey] = useState<'experience' | 'bouts' | 'controversy' | 'name'>('experience');

  const officials = useMemo(() => {
    // A save from before officials existed has an empty roster until it is next written. The
    // read is defensive so the page never renders blank.
    const list = allOfficials(save);
    return list.length > 0 ? list : [];
  }, [save]);

  const rows = useMemo(() => {
    const filtered = officials.filter((o) => o.role === role);
    const sorted = [...filtered];
    if (sortKey === 'experience') sorted.sort((a, b) => b.experience - a.experience);
    else if (sortKey === 'bouts') sorted.sort((a, b) => b.boutsWorked - a.boutsWorked);
    else if (sortKey === 'controversy') sorted.sort((a, b) => controversyRate(b) - controversyRate(a));
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [officials, role, sortKey]);

  if (officials.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Officials</h1>
        </div>
        <Panel title="No officials yet">
          <p className="faint">
            The officials roster is created with the world. Advance one week and the judges and referees for this save
            will appear here.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Officials</h1>
        <span className="sub">
          {officials.filter((o) => o.role === 'judge').length} judges, {officials.filter((o) => o.role === 'referee').length}{' '}
          referees
        </span>
      </div>

      <Panel title="View">
        <div className="row wrap">
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as OfficialRole)}>
              <option value="judge">Judges</option>
              <option value="referee">Referees</option>
            </select>
          </label>
          <label>
            Sort by
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)}>
              <option value="experience">Experience</option>
              <option value="bouts">Bouts worked</option>
              <option value="controversy">Controversial cards</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        <p className="small faint">
          Leanings are small and persistent. A judge who values control time is realistic; a judge who scores at random
          is not, so nobody here is incompetent. Every value on this page is simulated.
        </p>
      </Panel>

      <Panel title={role === 'judge' ? 'Judges' : 'Referees'} flush>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Commission</th>
              <th>Experience</th>
              <th className="num">Bouts</th>
              <th className="num">Title bouts</th>
              {role === 'judge' && <th className="num">Split</th>}
              {role === 'judge' && <th className="num">Outlier cards</th>}
              <th>Tendencies</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} id={o.id}>
                <td>
                  <strong>{o.name}</strong>
                </td>
                <td className="small">{o.commission}</td>
                <td className="small">{experienceLabel(o)}</td>
                <td className="num">{o.boutsWorked}</td>
                <td className="num">{o.titleBoutsWorked}</td>
                {role === 'judge' && <td className="num">{o.splitDecisionsWorked}</td>}
                {role === 'judge' && (
                  <td className="num">
                    <span className={o.outlierCards > 0 ? 'warn' : undefined}>{o.outlierCards}</span>
                  </td>
                )}
                <td className="small faint">{officialSummary(o)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {rows.some((o) => o.controversies.length > 0) && (
        <Panel title="Cards that were out of step">
          <p className="small faint">
            A card counted here disagreed with both other judges by three points or more. That is a measurable
            disagreement, not a judgement about competence.
          </p>
          <table>
            <tbody>
              {rows
                .filter((o) => o.controversies.length > 0)
                .flatMap((o) =>
                  o.controversies
                    .slice(-4)
                    .reverse()
                    .map((c, i) => (
                      <tr key={`${o.id}-${c.boutId}-${i}`}>
                        <td className="dim small nowrap">{formatDate(c.date)}</td>
                        <td>{o.name}</td>
                        <td className="small">
                          <Link to={`/fight/${c.boutId}`}>{c.note}</Link>
                        </td>
                      </tr>
                    ))
                )}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

/** Exported so a caller can guarantee the roster exists before rendering. */
export { ensureOfficials };
