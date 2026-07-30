import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { formatDate, type FighterId } from '@core/types/common';
import {
  relationshipsFor,
  RELATIONSHIP_LABEL,
  calloutsFor,
  type Relationship,
  type RelationshipState,
} from '@core/world/relationships';
import {
  liveInterestBetween,
  interestStatusLine,
  MATCHUP_SOURCE_LABEL,
  type MatchupInterest,
} from '@core/world/matchup-interest';
import { canCompete } from '@core/world/health';
import { useGame } from '../store';
import { Panel } from '../components';

/**
 * The rivalries page.
 *
 * Rivalry data already existed but had nowhere to live, so it was invisible unless the player
 * happened to open the right fighter profile. This is the dedicated view: who the rivalry is
 * with, how it started, whether the fight can actually be made right now, and what is stopping
 * it if not.
 */

type Bucket = 'active' | 'building' | 'resolved';

const RIVAL_STATES: RelationshipState[] = ['professional-rival', 'respected-opponent', 'heated-rival', 'bitter-rival', 'enemy'];

function intensityOf(r: Relationship): number {
  return Math.round(Math.max(r.rivalry, (r.publicHostility + r.privateHostility) / 2));
}

function IntensityBar({ value }: { value: number }) {
  const tone = value >= 70 ? 'bad' : value >= 45 ? 'warn' : 'faint';
  return (
    <span className="rivalry-bar" title={`Intensity ${value} of 100`}>
      <span className={`rivalry-fill ${tone}`} style={{ width: `${Math.max(4, value)}%` }} />
    </span>
  );
}

interface Row {
  otherId: FighterId;
  otherName: string;
  divisionId: string;
  state: RelationshipState;
  intensity: number;
  bucket: Bucket;
  relationship: Relationship;
  interest: MatchupInterest | null;
  fights: number;
  lastInteraction: string;
  calloutCount: number;
  matchupPossible: boolean;
  blockLine: string;
  publicInterest: number;
  ranking: string;
  bookedElsewhere: boolean;
}

export function RivalriesPage() {
  const save = useGame((s) => s.save)!;
  const playerId = save.player.fighterId;
  const [bucket, setBucket] = useState<Bucket | 'all'>('all');
  const [sortKey, setSortKey] = useState<'intensity' | 'interest' | 'recent' | 'fights'>('intensity');
  const [divisionFilter, setDivisionFilter] = useState<string>('all');
  const [eligibleOnly, setEligibleOnly] = useState(false);

  const rows = useMemo<Row[]>(() => {
    if (!playerId) return [];
    const me = save.fighters[playerId];
    if (!me) return [];
    const out: Row[] = [];
    for (const entry of relationshipsFor(save, playerId)) {
      const state = entry.state;
      const intensity = intensityOf(entry.relationship);
      // A rivalry worth showing either reads as one, or has heat building behind it.
      const isRival = RIVAL_STATES.includes(state);
      const building = intensity >= 18 && !isRival;
      if (!isRival && !building && entry.relationship.fights.length === 0) continue;

      const other = entry.other;
      const interest = liveInterestBetween(save, playerId, other.id);
      const callouts = calloutsFor(save, playerId).filter((c) => c.fromId === other.id || c.toId === other.id);

      const blockers: string[] = [];
      if (other.retired) blockers.push('They have retired.');
      if (other.nextBoutId) blockers.push('They are already booked.');
      if (me.nextBoutId) blockers.push('You are already booked.');
      if (!canCompete(other, save.date).ok) blockers.push('They are not medically cleared.');
      if (other.divisionId !== me.divisionId) {
        blockers.push(`They compete at ${DIVISION_BY_ID[other.divisionId]?.name ?? other.divisionId}.`);
      }

      // A rivalry is resolved once it has cooled and they have already settled it in the cage.
      const decided = entry.relationship.fights.length > 0 && intensity < 25;
      const rowBucket: Bucket = decided ? 'resolved' : isRival ? 'active' : 'building';

      out.push({
        otherId: other.id,
        otherName: other.name,
        divisionId: other.divisionId,
        state,
        intensity,
        bucket: rowBucket,
        relationship: entry.relationship,
        interest,
        fights: entry.relationship.fights.length,
        lastInteraction: entry.relationship.lastEventOn,
        calloutCount: callouts.length,
        matchupPossible: blockers.length === 0,
        blockLine: blockers.join(' '),
        publicInterest: Math.round((other.popularity + me.popularity) / 2 + intensity * 0.3),
        ranking: other.isChampion ? 'Champion' : other.ranking !== null ? `Ranked ${other.ranking}` : 'Unranked',
        bookedElsewhere: Boolean(other.nextBoutId),
      });
    }
    return out;
  }, [save, playerId]);

  const filtered = useMemo(() => {
    let list = rows;
    if (bucket !== 'all') list = list.filter((r) => r.bucket === bucket);
    if (divisionFilter !== 'all') list = list.filter((r) => r.divisionId === divisionFilter);
    if (eligibleOnly) list = list.filter((r) => r.matchupPossible);
    const sorted = [...list];
    if (sortKey === 'intensity') sorted.sort((a, b) => b.intensity - a.intensity);
    else if (sortKey === 'interest') sorted.sort((a, b) => b.publicInterest - a.publicInterest);
    else if (sortKey === 'fights') sorted.sort((a, b) => b.fights - a.fights);
    else sorted.sort((a, b) => (a.lastInteraction < b.lastInteraction ? 1 : -1));
    return sorted;
  }, [rows, bucket, sortKey, divisionFilter, eligibleOnly]);

  const divisions = useMemo(() => Array.from(new Set(rows.map((r) => r.divisionId))).sort(), [rows]);
  const counts = {
    active: rows.filter((r) => r.bucket === 'active').length,
    building: rows.filter((r) => r.bucket === 'building').length,
    resolved: rows.filter((r) => r.bucket === 'resolved').length,
  };

  if (!playerId) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Rivalries</h1>
        </div>
        <Panel title="No fighter">
          <p className="faint">Rivalries belong to a fighting career. Start one to see them here.</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Rivalries</h1>
        <span className="sub">
          {counts.active} active, {counts.building} building, {counts.resolved} settled
        </span>
      </div>

      <Panel title="Filter">
        <div className="row wrap">
          <label>
            Show
            <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket | 'all')}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="building">Building</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label>
            Division
            <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
              <option value="all">All divisions</option>
              {divisions.map((d) => (
                <option key={d} value={d}>
                  {DIVISION_BY_ID[d as keyof typeof DIVISION_BY_ID]?.name ?? d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sort by
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)}>
              <option value="intensity">Intensity</option>
              <option value="interest">Public interest</option>
              <option value="recent">Last interaction</option>
              <option value="fights">Fight history</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} />
            Only matchups that can be made
          </label>
        </div>
      </Panel>

      {filtered.length === 0 && (
        <Panel title="Nothing yet">
          <p className="faint">
            No rivalries match this filter. Rivalries build through callouts, press conferences, social media and close
            fights. Call somebody out and it will start here.
          </p>
        </Panel>
      )}

      {filtered.map((row) => {
        const recent = [...row.relationship.history].slice(-4).reverse();
        return (
          <Panel
            key={row.otherId}
            title={
              <>
                {row.otherName}{' '}
                <span className="faint small">
                  {RELATIONSHIP_LABEL[row.state]} · {row.ranking} ·{' '}
                  {DIVISION_BY_ID[row.divisionId as keyof typeof DIVISION_BY_ID]?.name ?? row.divisionId}
                </span>
              </>
            }
          >
            <div className="grid c4">
              <div>
                <span className="faint small">Intensity</span>
                <div className="row">
                  <IntensityBar value={row.intensity} />
                  <span className="small">{row.intensity}</span>
                </div>
              </div>
              <div>
                <span className="faint small">Public interest</span>
                <div>{row.publicInterest}</div>
              </div>
              <div>
                <span className="faint small">Fights between you</span>
                <div>{row.fights}</div>
              </div>
              <div>
                <span className="faint small">Callouts</span>
                <div>{row.calloutCount}</div>
              </div>
              <div>
                <span className="faint small">Last interaction</span>
                <div>{formatDate(row.lastInteraction)}</div>
              </div>
              <div>
                <span className="faint small">Can this fight be made</span>
                <div className={row.matchupPossible ? 'good' : 'warn'}>{row.matchupPossible ? 'Yes' : 'Not right now'}</div>
              </div>
            </div>

            {!row.matchupPossible && <p className="warn small">{row.blockLine}</p>}

            {row.interest && (
              <div className="rivalry-note">
                <strong>{MATCHUP_SOURCE_LABEL[row.interest.source]}</strong>
                <div className="small">{interestStatusLine(save, row.interest)}</div>
                {row.interest.promotionResponse && <div className="faint small">{row.interest.promotionResponse}</div>}
              </div>
            )}

            {row.relationship.fights.length > 0 && (
              <div>
                <span className="faint small">Fight history</span>
                <ul className="rivalry-list">
                  {row.relationship.fights.map((f) => (
                    <li key={f.boutId} className="small">
                      {formatDate(f.date)}:{' '}
                      {f.winnerId === null
                        ? 'no winner recorded'
                        : f.winnerId === playerId
                          ? 'you won'
                          : `${row.otherName} won`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {recent.length > 0 && (
              <div>
                <span className="faint small">Recent interactions</span>
                <ul className="rivalry-list">
                  {recent.map((h, i) => (
                    <li key={`${h.date}-${i}`} className="small">
                      {formatDate(h.date)}: {h.note}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="row">
              <Link className="button" to={`/fighter/${row.otherId}`}>
                Fighter profile
              </Link>
              <Link className="button" to="/career">
                Call them out
              </Link>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
