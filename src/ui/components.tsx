import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DIVISION_BY_ID, type DivisionId } from '@core/config/divisions';
import { formatMoney, formatNumber } from '@core/types/common';
import { RATING_KEYS, RATING_LABEL, type Fighter, type FighterRatingEstimate, type RatingKey } from '@core/types/fighter';
import type { SaveGame } from '@core/types/save';

/** Colour bands for a 0 to 100 rating. */
export function ratingClass(v: number): string {
  if (v >= 90) return 'rating r90';
  if (v >= 80) return 'rating r80';
  if (v >= 70) return 'rating r70';
  if (v >= 60) return 'rating r60';
  if (v >= 50) return 'rating r50';
  return 'rating r0';
}

export function Rating({ value, title }: { value: number; title?: string }) {
  return (
    <span className={ratingClass(value)} title={title}>
      {Math.round(value)}
    </span>
  );
}

/** Shows an estimated rating with its uncertainty band when the value is not exact. */
export function EstimatedRating({ estimate, low, high }: { estimate: number; low?: number; high?: number }) {
  if (low === undefined || high === undefined || low === high) return <Rating value={estimate} />;
  return (
    <span title={`Estimate. Likely between ${low} and ${high}.`}>
      <Rating value={estimate} />
      <span className="range-band"> ±{Math.max(1, Math.round((high - low) / 2))}</span>
    </span>
  );
}

export function Bar({ value, max = 100, tone }: { value: number; max?: number; tone?: 'good' | 'warn' | 'bad' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const cls = tone ?? (pct > 66 ? 'good' : pct > 33 ? 'warn' : 'bad');
  return (
    <span className={`bar ${cls}`} title={`${Math.round(value)} of ${max}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function FighterLink({ fighter, showTags = true }: { fighter: Fighter | undefined; showTags?: boolean }) {
  if (!fighter) return <span className="faint">Unknown</span>;
  return (
    <>
      <Link to={`/fighter/${fighter.id}`}>{fighter.name}</Link>
      {showTags && fighter.isChampion && <span className="tag champ" style={{ marginLeft: 4 }}>C</span>}
      {showTags && fighter.isInterimChampion && <span className="tag interim" style={{ marginLeft: 4 }}>IC</span>}
    </>
  );
}

export function DivisionLink({ id }: { id: DivisionId }) {
  const d = DIVISION_BY_ID[id];
  return <Link to={`/division/${id}`}>{d.shortName}</Link>;
}

export function RecordText({ f }: { f: Fighter }) {
  return (
    <span className="mono">
      {f.record.wins}-{f.record.losses}
      {f.record.draws > 0 ? `-${f.record.draws}` : ''}
    </span>
  );
}

export function Panel({
  title,
  actions,
  children,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <div className="panel">
      {(title || actions) && (
        <div className="panel-head">
          <span>{title}</span>
          <span>{actions}</span>
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </div>
  );
}

export function KeyValues({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Sortable table
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  label: ReactNode;
  /** Value used for sorting. Omit to make the column unsortable. */
  sort?: (row: T) => number | string;
  render: (row: T, index: number) => ReactNode;
  numeric?: boolean;
  title?: string;
  width?: number;
}

export function DataTable<T>({
  rows,
  columns,
  initialSort,
  initialDir = 'desc',
  rowKey,
  rowClass,
  empty = 'Nothing to show.',
  maxHeight,
}: {
  rows: T[];
  columns: Column<T>[];
  initialSort?: string;
  initialDir?: 'asc' | 'desc';
  rowKey: (row: T, index: number) => string;
  rowClass?: (row: T) => string | undefined;
  empty?: string;
  maxHeight?: number;
}) {
  const [sortKey, setSortKey] = useState<string | undefined>(initialSort);
  const [dir, setDir] = useState<'asc' | 'desc'>(initialDir);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = col.sort!(a);
      const vb = col.sort!(b);
      if (typeof va === 'string' || typeof vb === 'string') {
        const r = String(va).localeCompare(String(vb));
        return dir === 'asc' ? r : -r;
      }
      return dir === 'asc' ? va - vb : vb - va;
    });
    return copy;
  }, [rows, columns, sortKey, dir]);

  if (rows.length === 0) return <p className="dim small" style={{ padding: 8 }}>{empty}</p>;

  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${c.numeric ? 'num' : ''}${c.sort ? '' : ' nosort'}`}
                title={c.title}
                style={c.width ? { width: c.width } : undefined}
                onClick={() => {
                  if (!c.sort) return;
                  if (sortKey === c.key) setDir(dir === 'asc' ? 'desc' : 'asc');
                  else {
                    setSortKey(c.key);
                    setDir(c.numeric ? 'desc' : 'asc');
                  }
                }}
              >
                {c.label}
                {sortKey === c.key && <span className="sort-arrow">{dir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey(row, i)} className={rowClass?.(row)}>
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : ''}>
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The six ratings rendered inline, used in every roster style table. */
export function RatingCells({ est }: { est: FighterRatingEstimate }) {
  return (
    <>
      {RATING_KEYS.map((k) => (
        <td key={k} className="num">
          <EstimatedRating estimate={est.ratings[k]} low={est.exact ? undefined : est.low[k]} high={est.exact ? undefined : est.high[k]} />
        </td>
      ))}
    </>
  );
}

export const RATING_COLUMN_HEADS: { key: RatingKey; label: string; title: string }[] = RATING_KEYS.map((k) => ({
  key: k,
  label: RATING_LABEL[k],
  title:
    k === 'striking'
      ? 'Striking, offense and defense combined'
      : k === 'grappling'
        ? 'Grappling, positional control and escapes'
        : k === 'wrestling'
          ? 'Wrestling, takedowns and takedown defense'
          : k === 'submissions'
            ? 'Submissions, offense and defensive awareness'
            : k === 'cardio'
              ? 'Cardio, output retention and recovery'
              : 'Durability, damage tolerance and recovery under fire',
}));

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  x: number;
  y: number;
}

export function LineChart({
  series,
  height = 120,
  yMin = 0,
  yMax = 100,
}: {
  series: { points: SeriesPoint[]; className: string; label: string }[];
  height?: number;
  yMin?: number;
  yMax?: number;
}) {
  const width = 600;
  const pad = 4;
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <p className="dim small">Not enough history yet.</p>;
  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  const sx = (x: number) => (xMax === xMin ? pad : pad + ((x - xMin) / (xMax - xMin)) * (width - pad * 2));
  const sy = (y: number) => height - pad - ((y - yMin) / (yMax - yMin)) * (height - pad * 2);

  return (
    <>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
        <line className="axis" x1={0} y1={sy(yMin)} x2={width} y2={sy(yMin)} />
        <line className="axis" x1={0} y1={sy((yMin + yMax) / 2)} x2={width} y2={sy((yMin + yMax) / 2)} strokeDasharray="2 4" />
        {series.map((s, i) => (
          <path
            key={i}
            className={s.className}
            d={s.points.map((p, j) => `${j === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="row small dim" style={{ gap: 12, marginTop: 2 }}>
        {series.map((s, i) => (
          <span key={i}>
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 2,
                verticalAlign: 'middle',
                marginRight: 4,
                background:
                  s.className === 'line-ovr' ? 'var(--accent)' : s.className === 'line-pot' ? 'var(--link)' : 'var(--good)',
              }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

export function Money({ value }: { value: number | null | undefined }) {
  return <span className="mono">{formatMoney(value)}</span>;
}

export function Num({ value, digits = 0 }: { value: number | null | undefined; digits?: number }) {
  return <span className="mono">{formatNumber(value, digits)}</span>;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: ReactNode }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={`tab${t.key === active ? ' active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  return <div className={`notice${kind === 'info' ? '' : ` ${kind}`}`}>{children}</div>;
}

export function RealTag({ fighter }: { fighter: Fighter }) {
  return fighter.isRealPerson ? (
    <span className="tag real" title="Identity, physicals, record and ranking are sourced from the official UFC profile. Ratings are model derived.">
      real
    </span>
  ) : (
    <span className="tag fictional" title="Fictional fighter generated inside this save.">
      fictional
    </span>
  );
}

export function playerTagFor(save: SaveGame, fighter: Fighter): ReactNode {
  if (save.player.fighterId === fighter.id) return <span className="tag player">you</span>;
  if (save.player.gymId && fighter.gymId === save.player.gymId) return <span className="tag player">gym</span>;
  return null;
}

/**
 * The brand mark.
 *
 * A true eight sided polygon, not a rotated square. The previous mark was a rhombus
 * character, which is a diamond however it is styled.
 */
export function OctagonMark({ size = 22 }: { size?: number }) {
  // Eight points on a circle, rotated so the shape sits flat on top and bottom.
  const points = Array.from({ length: 8 }, (_, i) => {
    const angle = (Math.PI / 4) * i + Math.PI / 8;
    const x = 50 + 48 * Math.cos(angle);
    const y = 50 + 48 * Math.sin(angle);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return (
    <svg className="octagon-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <polygon points={points} fill="none" stroke="currentColor" strokeWidth="8" strokeLinejoin="round" />
      <polygon points={points} fill="currentColor" opacity="0.12" />
    </svg>
  );
}
