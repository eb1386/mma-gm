import { Link, useParams } from 'react-router-dom';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { formatClock, formatDate, formatMoney, formatNumber } from '@core/types/common';
import { METHOD_LABEL } from '@core/types/fight';
import { estimateRatings } from '@core/world/scouting';
import { useGame } from '../store';
import { EstimatedRating, KeyValues, Notice, Panel } from '../components';
import { getBusiness } from '@core/world/business';

export function EventPage() {
  const save = useGame((s) => s.save)!;
  const { eventId } = useParams();
  const event = eventId ? save.events[eventId] : null;
  if (!event) return <div className="page"><Notice kind="bad">Unknown event.</Notice></div>;

  const bouts = event.boutIds.map((id) => save.bouts[id]).filter(Boolean).sort((a, b) => b.boutOrder - a.boutOrder);
  const segments: { key: 'main' | 'prelim' | 'early-prelim'; label: string }[] = [
    { key: 'main', label: 'Main card' },
    { key: 'prelim', label: 'Preliminary card' },
    { key: 'early-prelim', label: 'Early preliminary card' },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <h1>{event.name}</h1>
        <span className="sub">
          {formatDate(event.date)} · {event.venue}, {event.city}, {event.country}
        </span>
        <span className="tag">{event.tier.replace('-', ' ')}</span>
        {event.status === 'completed' && <span className="tag good">completed</span>}
      </div>

      {event.status === 'completed' && (
        <Panel title="Event summary">
          <div className="row">
            <span>
              Attendance <strong>{event.attendance ? event.attendance.toLocaleString('en-US') : 'not recorded'}</strong>
            </span>
            <span>
              Bonus <strong>{formatMoney(event.bonusAmount)}</strong>
            </span>
            {event.fightOfTheNightBoutId && (
              <span>
                Fight of the Night:{' '}
                <Link to={`/fight/${event.fightOfTheNightBoutId}`}>
                  {(() => {
                    const b = save.bouts[event.fightOfTheNightBoutId];
                    return b ? `${save.fighters[b.fighterAId]?.name} against ${save.fighters[b.fighterBId]?.name}` : 'bout';
                  })()}
                </Link>
              </span>
            )}
          </div>
          {event.performanceBonusFighterIds.length > 0 && (
            <p className="small mt">
              Performance of the Night:{' '}
              {event.performanceBonusFighterIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <Link to={`/fighter/${id}`}>{save.fighters[id]?.name}</Link>
                </span>
              ))}
            </p>
          )}
        </Panel>
      )}

      {(() => {
        const business = getBusiness(save, event.id);
        if (!business) return null;
        const kindTag = (kind: string) =>
          kind === 'simulated' ? (
            <span className="tag" title="Produced by the game's business model, not a reported figure.">simulated</span>
          ) : kind === 'verified' ? (
            <span className="tag real">verified</span>
          ) : kind === 'reported-estimate' ? (
            <span className="tag warn">reported estimate</span>
          ) : (
            <span className="tag fictional">unknown</span>
          );
        return (
          <Panel title="Event business">
            <div className="grid c2">
              <KeyValues
                rows={[
                  [<span key="a">Attendance {kindTag(business.attendanceKind)}</span>, formatNumber(business.attendance)],
                  [<span key="g">Gate {kindTag(business.gateKind)}</span>, formatMoney(business.gate)],
                  [
                    <span key="p">Pay per view {kindTag(business.ppvKind)}</span>,
                    business.ppvBuys === null ? 'Not a pay per view card' : formatNumber(business.ppvBuys),
                  ],
                  ['Streaming viewers', formatNumber(business.streamingViewers)],
                  ['Broadcast audience', formatNumber(business.broadcastAudience)],
                  ['International audience', formatNumber(business.internationalAudience)],
                ]}
              />
              <KeyValues
                rows={[
                  ['Merchandise', formatMoney(business.merchandise)],
                  ['Sponsorship', formatMoney(business.sponsorship)],
                  ['Fighter payroll', formatMoney(business.fighterPayroll)],
                  ['Bonus payroll', formatMoney(business.bonusPayroll)],
                  ['Venue cost', formatMoney(business.venueCost)],
                  ['Marketing cost', formatMoney(business.marketingCost)],
                  [
                    'Estimated profit',
                    <strong key="pr" className={(business.estimatedProfit ?? 0) >= 0 ? 'good' : 'bad'}>
                      {formatMoney(business.estimatedProfit)}
                    </strong>,
                  ],
                ]}
              />
            </div>
            {business.demandNotes.length > 0 && (
              <ul className="small dim mt" style={{ paddingLeft: 16 }}>
                {business.demandNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            <p className="provenance">
              Every figure on this panel is produced by the game's business model. Nothing here is a reported or
              verified real world number.
            </p>
          </Panel>
        );
      })()}

      {segments.map((seg) => {
        const rows = bouts.filter((b) => b.cardSegment === seg.key);
        if (rows.length === 0) return null;
        return (
          <Panel key={seg.key} title={seg.label} flush>
            <table>
              <thead>
                <tr>
                  <th>Division</th>
                  <th>Fighter</th>
                  <th className="num">Ovr</th>
                  <th />
                  <th>Fighter</th>
                  <th className="num">Ovr</th>
                  <th>Result</th>
                  <th className="num">Rd</th>
                  <th className="num">Time</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const a = save.fighters[b.fighterAId];
                  const c = save.fighters[b.fighterBId];
                  const result = b.resultId ? save.history.results[b.resultId] : null;
                  const estA = a ? estimateRatings(save, a) : null;
                  const estB = c ? estimateRatings(save, c) : null;
                  const playerInvolved = save.player.fighterId === a?.id || save.player.fighterId === c?.id;
                  return (
                    <tr key={b.id} className={playerInvolved ? 'highlight' : undefined}>
                      <td className="small dim">
                        {DIVISION_BY_ID[b.divisionId].abbr}
                        {b.isTitleFight && <span className="tag champ" style={{ marginLeft: 4 }}>title</span>}
                        {b.isInterimTitleFight && <span className="tag interim" style={{ marginLeft: 4 }}>interim</span>}
                        {b.isCatchweight && <span className="tag warn" style={{ marginLeft: 4 }}>catchweight</span>}
                      </td>
                      <td className={result?.winnerId === a?.id ? 'good' : undefined}>
                        {a ? <Link to={`/fighter/${a.id}`}>{a.name}</Link> : 'TBD'}
                        {b.weighInA && !b.weighInA.madeWeight && <span className="tag bad" style={{ marginLeft: 4 }}>missed weight</span>}
                      </td>
                      <td className="num">{estA && <EstimatedRating estimate={estA.ovr} low={estA.exact ? undefined : estA.ovrLow} high={estA.exact ? undefined : estA.ovrHigh} />}</td>
                      <td className="dim center">vs</td>
                      <td className={result?.winnerId === c?.id ? 'good' : undefined}>
                        {c ? <Link to={`/fighter/${c.id}`}>{c.name}</Link> : 'TBD'}
                        {b.weighInB && !b.weighInB.madeWeight && <span className="tag bad" style={{ marginLeft: 4 }}>missed weight</span>}
                      </td>
                      <td className="num">{estB && <EstimatedRating estimate={estB.ovr} low={estB.exact ? undefined : estB.ovrLow} high={estB.exact ? undefined : estB.ovrHigh} />}</td>
                      <td className="small">
                        {result ? METHOD_LABEL[result.method] : b.status === 'canceled' ? <span className="bad">canceled</span> : <span className="dim">{b.scheduledRounds} rounds</span>}
                      </td>
                      <td className="num">{result ? result.endRound : ''}</td>
                      <td className="num small">{result ? formatClock(result.endTimeSeconds) : ''}</td>
                      <td>
                        {result ? (
                          <Link className="btn small" to={`/fight/${b.id}`}>
                            View
                          </Link>
                        ) : playerInvolved ? (
                          <Link className="btn small" to={`/fight/${b.id}`}>
                            Preview
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        );
      })}

      {bouts.length === 0 && <Notice>No bouts have been announced for this card yet.</Notice>}

      <Panel title="Booking notes" flush>
        <table>
          <tbody>
            {bouts.map((b) => (
              <tr key={b.id}>
                <td className="small">
                  {save.fighters[b.fighterAId]?.name} against {save.fighters[b.fighterBId]?.name}
                </td>
                <td className="small dim wrap">{b.bookingReason}</td>
                {b.replacementHistory.length > 0 && (
                  <td className="small warn wrap">
                    {b.replacementHistory
                      .map((r) => `${save.fighters[r.replacedFighterId]?.name ?? 'A fighter'} out, ${save.fighters[r.newFighterId]?.name ?? 'a replacement'} in (${r.reason})`)
                      .join('. ')}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
