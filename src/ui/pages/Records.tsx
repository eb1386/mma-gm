import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney } from '@core/types/common';
import { buildRecordBooks } from '@core/world/history';
import { businessRecords } from '@core/world/business';
import { bonusLeaders } from '@core/world/economy';
import { formatNumber } from '@core/types/common';
import { useGame } from '../store';
import { Panel, Tabs } from '../components';

export function RecordsPage() {
  const save = useGame((s) => s.save)!;
  const revision = useGame((s) => s.revision);
  const books = useMemo(() => {
    const core = buildRecordBooks(save);
    const bonuses = bonusLeaders(save);
    const bonusBooks = [
      {
        key: 'bonus-count',
        label: 'Most bonuses',
        unit: 'bonuses',
        rows: bonuses.slice(0, 25).map((b) => ({ fighterId: b.fighterId, name: b.name, value: b.bonuses, detail: `${formatNumber(b.earnings)} in bonus earnings` })),
      },
      {
        key: 'bonus-rate',
        label: 'Highest bonus rate',
        unit: 'per fight',
        rows: [...bonuses]
          .filter((b) => b.bonuses >= 2)
          .sort((a, b) => b.rate - a.rate)
          .slice(0, 25)
          .map((b) => ({ fighterId: b.fighterId, name: b.name, value: Math.round(b.rate * 100), detail: `${b.bonuses} bonuses` })),
      },
    ];
    const business = businessRecords(save).map((b) => ({
      key: `business-${b.key}`,
      label: b.label,
      unit: b.unit,
      rows: b.rows.map((r) => ({ fighterId: null, name: r.name, value: r.value, detail: `${r.date} · ${r.kind.replace('-', ' ')}` })),
    }));
    return [...core, ...bonusBooks, ...business];
  }, [save, revision]);
  const [active, setActive] = useState(books[0]?.key ?? 'wins');
  const book = books.find((b) => b.key === active) ?? books[0];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Records</h1>
        <span className="sub">{Object.keys(save.history.results).length} recorded fights in this world</span>
      </div>

      <Tabs tabs={books.map((b) => ({ key: b.key, label: b.label }))} active={active} onChange={setActive} />

      {book && (
        <Panel title={book.label} flush>
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Name</th>
                <th className="num">{book.unit}</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {book.rows.map((r, i) => (
                <tr key={`${r.fighterId}-${i}`} className={r.fighterId === save.player.fighterId ? 'highlight' : undefined}>
                  <td className="num dim">{i + 1}</td>
                  <td>{r.fighterId ? <Link to={`/fighter/${r.fighterId}`}>{r.name}</Link> : r.name}</td>
                  <td className="num mono">{book.key === 'earnings' ? formatMoney(r.value) : book.key === 'fastest' || book.key === 'latest' ? r.detail : r.value}</td>
                  <td className="small dim wrap">{r.detail}</td>
                </tr>
              ))}
              {book.rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="dim small">
                    Nothing recorded yet. Simulate some events.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
