import { Link, useNavigate } from 'react-router-dom';
import { DIVISIONS, DIVISION_BY_ID } from '@core/config/divisions';
import { daysBetween, formatDate, formatMoney } from '@core/types/common';
import { ovrDisplayed } from '@core/types/fighter';
import { METHOD_LABEL } from '@core/types/fight';
import { activeInjuries, healthReport } from '@core/world/health';
import { computeLeverage } from '@core/world/economy';
import { recentEvents, upcomingEvents } from '@core/world/tick';
import { useCareerStatus, useGame } from '../store';
import { CAREER_STATE_LABEL } from '@core/world/career';
import { stageLabel } from '@core/world/fightweek';
import { Bar, FighterLink, KeyValues, Notice, Panel, Rating, RealTag } from '../components';
import { actionableMessages } from '@core/world/inbox';

export function DashboardPage() {
  const save = useGame((s) => s.save)!;
  const report = useGame((s) => s.lastReport);
  const status = useCareerStatus();
  const navigate = useNavigate();
  const runAction = useGame((s) => s.runAction);
  const busy = useGame((s) => s.busy);
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  const nextBout = fighter?.nextBoutId ? save.bouts[fighter.nextBoutId] : null;
  const opponent = nextBout ? save.fighters[nextBout.fighterAId === fighter?.id ? nextBout.fighterBId : nextBout.fighterAId] : null;
  // The one authoritative selector, shared with the sidebar badge and the advance gate. A local
  // predicate here disagreed with them, so the dashboard could show a count that the inbox and the
  // navigation badge both contradicted.
  const actionable = actionableMessages(save);
  const injuries = fighter ? activeInjuries(fighter, save.date) : [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <span className="sub">{formatDate(save.date)}</span>
      </div>

      {status && status.state !== 'not-a-fighter' && (
        <div className={`career-banner${status.advanceBlocked ? ' blocked' : ''}`}>
          <span className="state">{CAREER_STATE_LABEL[status.state]}</span>
          <span className="why">{status.reason}</span>
          {status.action && (
            <button className="primary" disabled={busy} onClick={() => void runAction(status.action!, navigate)}>
              {busy ? 'Working...' : status.action.label}
            </button>
          )}
        </div>
      )}

      {status && (status.boutId || status.injurySummary || status.fightWeekStage) && (
        <Panel title="Where the career stands">
          <KeyValues
            rows={[
              ['Career state', CAREER_STATE_LABEL[status.state]],
              ['Next mandatory action', status.action ? status.action.label : 'Nothing outstanding'],
              ['Booked opponent', status.opponentName ?? 'Nobody'],
              ['Event', status.eventName ?? 'None'],
              ['Date', status.eventDate ? formatDate(status.eventDate) : 'None'],
              ['Days remaining', status.daysToFight === null ? 'Not booked' : String(status.daysToFight)],
              [
                'Camp',
                status.campId
                  ? `${status.campWeeksCompleted ?? 0} of ${status.campWeeksPlanned ?? 0} weeks`
                  : status.boutId
                    ? 'Not planned yet'
                    : 'None',
              ],
              ['Injury', status.injurySummary ?? 'None active'],
              ['Expected return', status.expectedReturn ?? 'Not applicable'],
              ['Fight week stage', status.fightWeekStage ? stageLabel(status.fightWeekStage) : 'Not in fight week'],
              ['Unresolved decisions', status.openDecisions],
              ['Time advancement', status.advanceBlocked ? `Blocked: ${status.blockedReason}` : 'Available'],
            ]}
          />
        </Panel>
      )}

      {actionable.length > 0 && (
        <Notice kind="warn">
          {actionable.length} item{actionable.length === 1 ? '' : 's'} waiting for a decision.{' '}
          <Link to={`/inbox/${actionable[0].id}`}>Open the inbox</Link>.
        </Notice>
      )}

      {report && report.daysAdvanced > 0 && (
        <Panel title={`Since ${formatDate(report.from)}`}>
          {report.headlines.length === 0 && report.eventsResolved.length === 0 ? (
            <p className="dim small">A quiet stretch.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 16 }} className="small">
              {report.eventsResolved.map((e) => (
                <li key={e}>{e} has been contested.</li>
              ))}
              {report.headlines.slice(0, 12).map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
          {report.stoppedBecause && <p className="small dim mt">{report.stoppedBecause}</p>}
        </Panel>
      )}

      <div className="grid c2">
        {fighter && (
          <Panel
            title="Your fighter"
            actions={<Link to={`/fighter/${fighter.id}`} className="btn small">Full profile</Link>}
          >
            <div className="row mb">
              <strong style={{ fontSize: 15 }}>{fighter.name}</strong>
              <RealTag fighter={fighter} />
              {fighter.isChampion && <span className="tag champ">Champion</span>}
            </div>
            <KeyValues
              rows={[
                ['Division', DIVISION_BY_ID[fighter.divisionId].name],
                ['Ranking', fighter.isChampion ? 'Champion' : fighter.ranking ? `Number ${fighter.ranking}` : 'Unranked'],
                ['Record', `${fighter.record.wins}-${fighter.record.losses}${fighter.record.draws ? `-${fighter.record.draws}` : ''}`],
                ['Promotional record', `${fighter.ufcRecord.wins}-${fighter.ufcRecord.losses}`],
                ['Ovr', <Rating value={ovrDisplayed(fighter.ratings)} key="o" />],
                ['Pot', <Rating value={fighter.pot} key="p" />],
                ['Longevity', <span key="l" className="row tight" style={{ justifyContent: 'flex-end' }}><Bar value={fighter.longevity} /> <Rating value={fighter.longevity} /></span>],
                ['Morale', <Bar key="m" value={fighter.morale} />],
                ['Popularity', <Bar key="pop" value={fighter.popularity} />],
                ['Career earnings', formatMoney(fighter.careerEarnings)],
              ]}
            />
            {injuries.length > 0 && (
              <div className="mt">
                <span className="tag bad">Injured</span>{' '}
                <span className="small">
                  {injuries.map((i) => `${i.type} until ${i.expectedReturn}`).join('. ')}
                </span>
              </div>
            )}
            {fighter.medicalSuspension && (
              <p className="small warn mt">
                Medically suspended until {fighter.medicalSuspension.until}. {fighter.medicalSuspension.reason}
              </p>
            )}
          </Panel>
        )}

        {gym && (
          <Panel title="Your gym" actions={<Link to="/coach" className="btn small">Manage</Link>}>
            <div className="row mb">
              <strong style={{ fontSize: 15 }}>{gym.name}</strong>
              <span className="dim small">
                {gym.city}, {gym.country}
              </span>
            </div>
            <KeyValues
              rows={[
                ['Reputation', <Bar key="r" value={gym.reputation} />],
                ['Facilities', <Bar key="f" value={gym.facilities} />],
                ['Culture', <Bar key="c" value={gym.culture} />],
                ['Safety', <Bar key="s" value={gym.safety} />],
                ['Fighters', `${gym.fighterIds.length} of ${gym.capacity}`],
                ['Staff', gym.staffIds.length],
                ['Balance', formatMoney(gym.balance)],
                ['Champions produced', gym.championsProduced],
                ['Ranked fighters produced', gym.rankedProduced],
              ]}
            />
          </Panel>
        )}

        <Panel title="Next fight">
          {nextBout && opponent ? (
            <>
              <p>
                <strong>{opponent.name}</strong> {opponent.isChampion && <span className="tag champ">C</span>}
                <br />
                <span className="dim small">
                  {save.events[nextBout.eventId]?.name} on {formatDate(nextBout.date)} in {save.events[nextBout.eventId]?.city}
                </span>
              </p>
              <KeyValues
                rows={[
                  ['Days out', daysBetween(save.date, nextBout.date)],
                  ['Rounds', nextBout.scheduledRounds],
                  ['Weight', `${nextBout.contractedWeightLb} lb${nextBout.isCatchweight ? ' catchweight' : ''}`],
                  ['Title fight', nextBout.isTitleFight ? 'Yes' : nextBout.isInterimTitleFight ? 'Interim' : 'No'],
                  ['Show pay', formatMoney(nextBout.fighterAId === fighter?.id ? nextBout.purseA.show : nextBout.purseB.show)],
                  ['Win bonus', formatMoney(nextBout.fighterAId === fighter?.id ? nextBout.purseA.win : nextBout.purseB.win)],
                ]}
              />
              <div className="row mt">
                <Link className="btn" to="/camp">
                  Training camp
                </Link>
                <Link className="btn" to={`/fighter/${opponent.id}`}>
                  Scout opponent
                </Link>
              </div>
            </>
          ) : (
            <p className="dim">
              No bout booked. {fighter ? 'Offers arrive in the inbox as the matchmaker puts cards together.' : ''}
            </p>
          )}
        </Panel>

        {fighter && (
          <Panel title="Contract and leverage" actions={<Link to="/contract" className="btn small">Details</Link>}>
            {(() => {
              const c = fighter.contractId ? save.contracts[fighter.contractId] : null;
              const lev = computeLeverage(fighter, save);
              return (
                <>
                  <KeyValues
                    rows={[
                      ['Status', c ? c.status : 'No contract'],
                      ['Fights remaining', c ? c.fightsRemaining : '-'],
                      ['Show pay', c ? formatMoney(c.terms.showPay) : '-'],
                      ['Win bonus', c ? formatMoney(c.terms.winBonus) : '-'],
                      ['Leverage', <Bar key="l" value={lev.score} />],
                    ]}
                  />
                  <p className="small dim mt">{lev.summary}</p>
                  {c?.isSimulated && <p className="provenance">{c.note}</p>}
                </>
              );
            })()}
          </Panel>
        )}

        <Panel title="Champions">
          <table>
            <tbody>
              {DIVISIONS.map((d) => {
                const t = save.rankings[d.id];
                const champ = t.championId ? save.fighters[t.championId] : null;
                const interim = t.interimChampionId ? save.fighters[t.interimChampionId] : null;
                return (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/division/${d.id}`}>{d.shortName}</Link>
                    </td>
                    <td>{champ ? <FighterLink fighter={champ} showTags={false} /> : <span className="faint">Vacant</span>}</td>
                    <td className="num">{champ ? <Rating value={ovrDisplayed(champ.ratings)} /> : null}</td>
                    <td className="small dim">{interim ? `interim: ${interim.name}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Upcoming events" flush>
          <table>
            <tbody>
              {upcomingEvents(save, 8).map((e) => (
                <tr key={e.id}>
                  <td className="dim small">{formatDate(e.date)}</td>
                  <td>
                    <Link to={`/event/${e.id}`}>{e.name}</Link>
                  </td>
                  <td className="dim small">{e.city}</td>
                  <td className="num small dim">{e.boutIds.length} bouts</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Recent results" flush>
          <table>
            <tbody>
              {recentEvents(save, 6).map((e) => {
                const main = [...e.boutIds].map((id) => save.bouts[id]).find((b) => b?.isMainEvent);
                const result = main?.resultId ? save.history.results[main.resultId] : null;
                return (
                  <tr key={e.id}>
                    <td className="dim small">{formatDate(e.date)}</td>
                    <td>
                      <Link to={`/event/${e.id}`}>{e.name}</Link>
                    </td>
                    <td className="small">
                      {result ? (
                        <>
                          {result.winnerId ? save.fighters[result.winnerId]?.name : 'Draw'}{' '}
                          <span className="dim">{METHOD_LABEL[result.method]}</span>
                        </>
                      ) : (
                        <span className="faint">no main event recorded</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        {fighter && (
          <Panel title="Health report">
            <table>
              <tbody>
                {healthReport(fighter).map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td style={{ width: 90 }}>
                      <Bar value={100 - r.value} />
                    </td>
                    <td className="small dim">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small faint mt">
              Longevity is remaining career resilience. It is never part of Ovr and it does not fully recover.
            </p>
          </Panel>
        )}

        <Panel title="Latest news" flush>
          <table>
            <tbody>
              {save.history.news.slice(0, 10).map((n) => (
                <tr key={n.id}>
                  <td className="dim small nowrap">{n.date}</td>
                  <td className="wrap">{n.headline}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
