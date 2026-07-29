import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { BUILDS } from '@core/config/builds';
import { ageOn, daysBetween, formatDate, formatHeight, formatMoney, formatNumber, toDayNumber } from '@core/types/common';
import { METHOD_LABEL, type FightResult } from '@core/types/fight';
import { ovrDisplayed, RATING_KEYS, RATING_LONG_LABEL } from '@core/types/fighter';
import { healthReport } from '@core/world/health';
import { deriveFighterStatus, FIGHTER_STATUS_LABEL, statusTone } from '@core/world/status';
import { estimateRatings, scoutingReport } from '@core/world/scouting';
import { happinessFactors } from '@core/world/gyms';
import { Rng } from '@core/rng';
import { activityReport, performSocialAction, publicLabelText, SOCIAL_ACTIONS } from '@core/world/identity';
import { totalFollowers } from '@core/types/identity';
import { computeLeverage } from '@core/world/economy';
import { useGame } from '../store';
import { Bar, DataTable, EstimatedRating, KeyValues, LineChart, Notice, Panel, Rating, RealTag, Tabs } from '../components';

export function FighterPage() {
  const save = useGame((s) => s.save)!;
  const { fighterId } = useParams();
  const [tab, setTab] = useState('overview');
  const mutate = useGame((s) => s.mutate);
  const showToast = useGame((s) => s.showToast);
  const [socialLog, setSocialLog] = useState<string[]>([]);
  const fighter = fighterId ? save.fighters[fighterId] : null;

  if (!fighter) {
    return (
      <div className="page">
        <Notice kind="bad">No fighter with that identifier exists in this save.</Notice>
      </div>
    );
  }

  const est = estimateRatings(save, fighter);
  const division = DIVISION_BY_ID[fighter.divisionId];
  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot;
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const isMine = save.player.fighterId === fighter.id || (save.player.gymId !== null && fighter.gymId === save.player.gymId);
  const results: FightResult[] = fighter.boutIds
    .map((id) => save.history.results[id])
    .filter(Boolean)
    .sort((a, b) => (a.date > b.date ? -1 : 1));

  const historyPoints = fighter.ratingHistory.map((h) => ({ x: toDayNumber(h.date), y: h.ovr }));
  const potPoints = fighter.ratingHistory.map((h) => ({ x: toDayNumber(h.date), y: h.pot }));
  const lngPoints = fighter.ratingHistory.map((h) => ({ x: toDayNumber(h.date), y: h.longevity }));
  const scout = scoutingReport(save, fighter);

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          {fighter.name}
          {fighter.nickname ? <span className="dim" style={{ fontWeight: 400 }}> "{fighter.nickname}"</span> : null}
        </h1>
        <span className="sub">
          {division.name} · {fighter.isChampion ? 'Champion' : fighter.ranking ? `Ranked ${fighter.ranking}` : 'Unranked'}
          {fighter.pfpRanking ? ` · PFP ${fighter.pfpRanking}` : ''}
        </span>
        <RealTag fighter={fighter} />
        {(() => {
          const v = deriveFighterStatus(save, fighter);
          const tone = statusTone(v.status);
          return (
            <span className={`tag ${tone === 'dim' ? '' : tone}`} title={`${v.detail} Source: ${v.evidence}.`}>
              {FIGHTER_STATUS_LABEL[v.status]}
            </span>
          );
        })()}
        {fighter.hallOfFameYear && <span className="tag champ">Hall of Fame {fighter.hallOfFameYear}</span>}
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'history', label: `Fight history (${results.length})` },
          { key: 'development', label: 'Development' },
          { key: 'identity', label: 'Identity' },
          { key: 'health', label: 'Health' },
          { key: 'data', label: 'Data and sources' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="grid c3">
          <Panel title="Ratings">
            <table>
              <tbody>
                {RATING_KEYS.map((k) => (
                  <tr key={k}>
                    <td>{RATING_LONG_LABEL[k]}</td>
                    <td style={{ width: 70 }}>
                      <Bar value={est.ratings[k]} />
                    </td>
                    <td className="num">
                      <EstimatedRating
                        estimate={est.ratings[k]}
                        low={est.exact ? undefined : est.low[k]}
                        high={est.exact ? undefined : est.high[k]}
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Ovr</strong>
                  </td>
                  <td>
                    <Bar value={est.ovr} />
                  </td>
                  <td className="num">
                    <EstimatedRating estimate={est.ovr} low={est.exact ? undefined : est.ovrLow} high={est.exact ? undefined : est.ovrHigh} />
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Pot</strong>
                  </td>
                  <td>
                    <Bar value={est.pot} />
                  </td>
                  <td className="num">
                    <Rating value={est.pot} />
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Longevity</strong>
                  </td>
                  <td>
                    <Bar value={fighter.longevity} />
                  </td>
                  <td className="num">
                    <Rating value={fighter.longevity} />
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="small faint mt">
              Ovr is the plain mean of the six ratings. Pot is a projection of peak Ovr, not a seventh skill. Longevity
              is not part of Ovr.
            </p>
            {!est.exact && <p className="small dim">{scout.headline}</p>}
          </Panel>

          <Panel title="Profile">
            <KeyValues
              rows={[
                ['Age', age ?? 'Unknown'],
                ['Date of birth', fighter.birthDate ?? <span className="faint">Unknown</span>],
                ['Height', formatHeight(fighter.heightIn)],
                ['Reach', fighter.reachIn ? `${fighter.reachIn}"` : <span className="faint">Unknown</span>],
                ['Leg reach', fighter.legReachIn ? `${fighter.legReachIn}"` : <span className="faint">Unknown</span>],
                ['Stance', fighter.stance],
                ['Build', BUILDS[fighter.build]?.label ?? fighter.build],
                ['Walking weight', `${Math.round(fighter.walkingWeightLb)} lb`],
                ['Country', fighter.country],
                ['Hometown', fighter.hometown ?? <span className="faint">Unknown</span>],
                ['Gym', gym ? <Link key="g" to={`/gym/${gym.id}`}>{gym.name}</Link> : <span className="faint">None</span>],
                ['Octagon debut', fighter.octagonDebut ?? <span className="faint">Unknown</span>],
              ]}
            />
          </Panel>

          <Panel title="Record and standing">
            <KeyValues
              rows={[
                ['Professional record', `${fighter.record.wins}-${fighter.record.losses}${fighter.record.draws ? `-${fighter.record.draws}` : ''}`],
                ['Promotional record', `${fighter.ufcRecord.wins}-${fighter.ufcRecord.losses}${fighter.ufcRecord.draws ? `-${fighter.ufcRecord.draws}` : ''}`],
                ['Wins by strikes', fighter.methods.koWins],
                ['Wins by submission', fighter.methods.subWins],
                ['Wins by decision', fighter.methods.decWins],
                ['Current streak', fighter.winStreak > 0 ? `${fighter.winStreak} wins` : fighter.lossStreak > 0 ? `${fighter.lossStreak} losses` : 'None'],
                ['Ranking', fighter.isChampion ? 'Champion' : fighter.ranking ?? 'Unranked'],
                ['Highest ranking', fighter.highestRanking ?? '-'],
                ['Weeks ranked', fighter.weeksRanked],
                ['Title reigns', fighter.titleReigns],
                ['Title defenses', fighter.titleDefenses],
                ['Last fight', fighter.lastFightDate ? `${formatDate(fighter.lastFightDate)} (${daysBetween(fighter.lastFightDate, save.date)} days ago)` : 'None recorded'],
              ]}
            />
          </Panel>

          <Panel title="Style">
            <div className="row mb">
              {fighter.styleLabels.map((s) => (
                <span className="tag" key={s.key}>
                  {s.label}
                </span>
              ))}
            </div>
            <p className="small dim">
              Style labels describe what a fighter chooses to do. They are not extra performance ratings.
            </p>
            {isMine && (
              <table className="mt">
                <tbody>
                  {(
                    [
                      ['Pressure', fighter.tendencies.pressure],
                      ['Counter', fighter.tendencies.counter],
                      ['Range', fighter.tendencies.range],
                      ['Kicking', fighter.tendencies.kicking],
                      ['Clinch', fighter.tendencies.clinch],
                      ['Takedown entries', fighter.tendencies.takedownEntry],
                      ['Top control', fighter.tendencies.topControl],
                      ['Submission hunting', fighter.tendencies.submissionHunt],
                      ['Pace', fighter.tendencies.pace],
                      ['Risk tolerance', fighter.tendencies.riskTolerance],
                    ] as [string, number][]
                  ).map(([label, v]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td style={{ width: 90 }}>
                        <Bar value={v * 100} tone="good" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Standing and money">
            <KeyValues
              rows={[
                ['Popularity', <Bar key="p" value={fighter.popularity} />],
                ['Momentum', <Bar key="m" value={fighter.momentum} />],
                ['Morale', <Bar key="mo" value={fighter.morale} />],
                ['Happiness', <Bar key="h" value={fighter.happiness} />],
                ['Matchmaker relationship', <Bar key="mm" value={fighter.relationships.matchmaker} />],
                ['Career earnings', formatMoney(fighter.careerEarnings)],
                ['Last purse', fighter.lastPurse ? formatMoney(fighter.lastPurse) : '-'],
                ['Leverage', <Bar key="l" value={computeLeverage(fighter, save).score} />],
              ]}
            />
            {contract && (
              <p className="small dim mt">
                Contract: {contract.fightsRemaining} of {contract.terms.fights} fights remaining, {formatMoney(contract.terms.showPay)} to
                show and {formatMoney(contract.terms.winBonus)} to win.
              </p>
            )}
            {contract?.isSimulated && <p className="provenance">{contract.note}</p>}
          </Panel>

          {isMine && (
            <Panel title="Happiness drivers">
              <table>
                <tbody>
                  {happinessFactors(save, fighter)
                    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                    .slice(0, 10)
                    .map((f) => (
                      <tr key={f.label}>
                        <td>{f.label}</td>
                        <td className={`num ${f.delta > 0 ? 'good' : f.delta < 0 ? 'bad' : 'dim'}`}>
                          {f.delta > 0 ? '+' : ''}
                          {f.delta.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Panel>
          )}

          {fighter.awards.length > 0 && (
            <Panel title="Awards">
              <ul className="small" style={{ paddingLeft: 16, margin: 0 }}>
                {fighter.awards.slice(-14).reverse().map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {tab === 'history' && (
        <Panel title="Fight history" flush>
          <DataTable
            rows={results}
            rowKey={(r) => r.boutId}
            initialSort="date"
            columns={[
              { key: 'date', label: 'Date', sort: (r) => r.date, render: (r) => formatDate(r.date) },
              {
                key: 'event',
                label: 'Event',
                render: (r) => <Link to={`/event/${r.eventId}`}>{save.events[r.eventId]?.name ?? 'Event'}</Link>,
              },
              {
                key: 'opponent',
                label: 'Opponent',
                render: (r) => {
                  const oppId = r.fighterAId === fighter.id ? r.fighterBId : r.fighterAId;
                  const opp = save.fighters[oppId];
                  return opp ? <Link to={`/fighter/${opp.id}`}>{opp.name}</Link> : 'Unknown';
                },
              },
              {
                key: 'result',
                label: 'Result',
                render: (r) =>
                  r.winnerId === fighter.id ? (
                    <span className="good">Win</span>
                  ) : r.winnerId === null ? (
                    <span className="dim">Draw</span>
                  ) : (
                    <span className="bad">Loss</span>
                  ),
              },
              { key: 'method', label: 'Method', render: (r) => METHOD_LABEL[r.method] },
              { key: 'round', label: 'Rd', numeric: true, sort: (r) => r.endRound, render: (r) => r.endRound },
              {
                key: 'time',
                label: 'Time',
                render: (r) => `${Math.floor(r.endTimeSeconds / 60)}:${String(r.endTimeSeconds % 60).padStart(2, '0')}`,
              },
              {
                key: 'strikes',
                label: 'Sig str',
                numeric: true,
                sort: (r) => (r.fighterAId === fighter.id ? r.totalsA.sigStrikesLanded : r.totalsB.sigStrikesLanded),
                render: (r) =>
                  `${r.fighterAId === fighter.id ? r.totalsA.sigStrikesLanded : r.totalsB.sigStrikesLanded} to ${
                    r.fighterAId === fighter.id ? r.totalsB.sigStrikesLanded : r.totalsA.sigStrikesLanded
                  }`,
              },
              {
                key: 'td',
                label: 'TD',
                numeric: true,
                sort: (r) => (r.fighterAId === fighter.id ? r.totalsA.takedownsLanded : r.totalsB.takedownsLanded),
                render: (r) => (r.fighterAId === fighter.id ? r.totalsA.takedownsLanded : r.totalsB.takedownsLanded),
              },
              {
                key: 'title',
                label: '',
                render: (r) =>
                  r.isTitleFight ? <span className="tag champ">title</span> : r.isInterimTitleFight ? <span className="tag interim">interim</span> : null,
              },
              {
                key: 'view',
                label: '',
                render: (r) => (
                  <Link className="btn small" to={`/fight/${r.boutId}`}>
                    View
                  </Link>
                ),
              },
            ]}
            empty="No recorded fights in this save yet."
          />
        </Panel>
      )}

      {tab === 'development' && (
        <div className="grid c2">
          <Panel title="Rating history">
            <LineChart
              series={[
                { points: historyPoints, className: 'line-ovr', label: 'Ovr' },
                { points: potPoints, className: 'line-pot', label: 'Pot' },
                { points: lngPoints, className: 'line-lng', label: 'Longevity' },
              ]}
            />
            <KeyValues
              rows={[
                ['Peak Ovr', <Rating key="p" value={fighter.peakOvr} />],
                ['Peak reached', fighter.peakOvrDate ? formatDate(fighter.peakOvrDate) : '-'],
                ['Current Ovr', <Rating key="c" value={ovrDisplayed(fighter.ratings)} />],
                ['Pot', <Rating key="pt" value={fighter.pot} />],
                ['Pot confidence', fighter.potConfidence.replace('-', ' ')],
              ]}
            />
          </Panel>
          <Panel title="Rating log" flush>
            <DataTable
              rows={[...fighter.ratingHistory].reverse()}
              rowKey={(h, i) => `${h.date}-${i}`}
              maxHeight={420}
              columns={[
                { key: 'date', label: 'Date', render: (h) => formatDate(h.date) },
                { key: 'ovr', label: 'Ovr', numeric: true, render: (h) => <Rating value={h.ovr} /> },
                { key: 'pot', label: 'Pot', numeric: true, render: (h) => <Rating value={h.pot} /> },
                { key: 'lng', label: 'Lng', numeric: true, render: (h) => <Rating value={h.longevity} /> },
                { key: 'reason', label: 'Note', render: (h) => <span className="small dim">{h.reason}</span> },
              ]}
            />
          </Panel>
        </div>
      )}

      {tab === 'identity' && (
        <div className="grid c2">
          <Panel title="Public identity">
            <div className="row mb">
              {(fighter.publicLabels ?? []).length === 0 ? (
                <span className="dim small">No strong public identity yet.</span>
              ) : (
                (fighter.publicLabels ?? []).map((l) => (
                  <span className="tag" key={l}>
                    {publicLabelText(l)}
                  </span>
                ))
              )}
            </div>
            {fighter.fame ? (
              <table>
                <tbody>
                  {(
                    [
                      ['Name recognition', fighter.fame.recognition, 'How many people know the name at all'],
                      ['Favorability', fighter.fame.favorability, 'How well liked, separate from how well known'],
                      ['Controversy', fighter.fame.controversy, 'How much of the attention is negative'],
                      ['Hardcore respect', fighter.fame.hardcoreRespect, 'Standing with the dedicated audience'],
                      ['Casual interest', fighter.fame.casualInterest, 'Standing with the wider audience'],
                      ['Sponsor appeal', fighter.fame.sponsorAppeal, 'Willingness of sponsors to attach'],
                      ['Media friendliness', fighter.fame.mediaFriendliness, 'How the press finds them to deal with'],
                      ['Promotional trust', fighter.fame.promotionalTrust, 'How reliable the promotion considers them'],
                      ['Drawing power', fighter.fame.drawingPower, 'Composite commercial pull'],
                    ] as [string, number, string][]
                  ).map(([label, v, title]) => (
                    <tr key={label} title={title}>
                      <td>{label}</td>
                      <td style={{ width: 100 }}>
                        <Bar value={v} tone={label === 'Controversy' ? (v > 55 ? 'bad' : 'good') : undefined} />
                      </td>
                      <td className="num">{Math.round(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="dim small">No identity data on this record.</p>
            )}
            <p className="small faint mt">
              None of this is part of Ovr. Attention and approval are tracked separately on purpose, which is why a
              fighter can be famous and disliked at the same time.
            </p>
          </Panel>

          <Panel title="Personality">
            {fighter.personality ? (
              <>
                <div className="row mb">
                  {fighter.personality.traits.map((t) => (
                    <span className="tag" key={t}>
                      {t.replace('-', ' ')}
                    </span>
                  ))}
                </div>
                <table>
                  <tbody>
                    {(
                      [
                        ['Charisma', fighter.personality.charisma],
                        ['Media comfort', fighter.personality.mediaComfort],
                        ['Ego', fighter.personality.ego],
                        ['Loyalty', fighter.personality.loyalty],
                        ['Money motivation', fighter.personality.moneyMotivation],
                        ['Legacy motivation', fighter.personality.legacyMotivation],
                        ['Risk tolerance', fighter.personality.riskTolerance],
                        ['Discipline', fighter.personality.discipline],
                        ['Temper', fighter.personality.temper],
                      ] as [string, number][]
                    ).map(([label, v]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td style={{ width: 100 }}>
                          <Bar value={v} />
                        </td>
                        <td className="num">{Math.round(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="small faint mt">
                  Personality changes what a fighter chooses to do. It never changes Ovr. Repeated choices shift public
                  identity gradually rather than switching it.
                </p>
                {fighter.isRealPerson && (
                  <p className="provenance">
                    Personality is a model estimate generated inside the game. It is not sourced and is not a claim about
                    the real person.
                  </p>
                )}
              </>
            ) : (
              <p className="dim small">No personality data on this record.</p>
            )}
          </Panel>

          <Panel title="Activity">
            {(() => {
              const report = activityReport(save, fighter);
              return (
                <>
                  <div className="row mb">
                    <span className="tag">{report.label}</span>
                    {fighter.activityProfile && (
                      <span className="small dim">
                        targets {fighter.activityProfile.targetFightsPerYear.toFixed(1)} fights a year,{' '}
                        {fighter.activityProfile.preferredTurnaroundDays} day preferred turnaround
                      </span>
                    )}
                  </div>
                  <KeyValues
                    rows={[
                      ['Fights per year', report.fightsPerYear.toFixed(2)],
                      ['Days since last fight', report.daysSinceLastFight ?? 'No recorded fight'],
                      ['Average turnaround', report.averageTurnaroundDays ? `${Math.round(report.averageTurnaroundDays)} days` : '-'],
                      ['Shortest turnaround', report.shortestTurnaroundDays ? `${report.shortestTurnaroundDays} days` : '-'],
                      ['Longest layoff', report.longestLayoffDays ? `${report.longestLayoffDays} days` : '-'],
                      ['Short notice fights', report.shortNoticeFights],
                      ['Offers accepted', report.offersAccepted],
                      ['Offers declined', report.offersDeclined],
                      ['Estimated return', report.estimatedReturn ?? 'Unknown'],
                    ]}
                  />
                  {report.inactivityReason && <p className="small dim mt">{report.inactivityReason}</p>}
                </>
              );
            })()}
          </Panel>

          <Panel title="Social reach">
            {fighter.social ? (
              <>
                <KeyValues
                  rows={[
                    ['Photo platform', formatNumber(fighter.social.followers.photo)],
                    ['Short text platform', formatNumber(fighter.social.followers.text)],
                    ['Short video platform', formatNumber(fighter.social.followers.video)],
                    ['Long form video', formatNumber(fighter.social.followers.longform)],
                    ['Total followers', <strong key="t">{formatNumber(totalFollowers(fighter.social))}</strong>],
                    ['Engagement', <Bar key="e" value={fighter.social.engagement} />],
                    ['Last post', fighter.social.lastPostOn ?? 'Never'],
                  ]}
                />
                {isMine && save.player.fighterId === fighter.id && (
                  <>
                    <h3 className="mt">Post something</h3>
                    <p className="small dim">
                      Every action that can work can also fail. A failed post reads as desperate, forced or embarrassing.
                    </p>
                    <div className="row" style={{ gap: 4 }}>
                      {SOCIAL_ACTIONS.map((a) => (
                        <button
                          key={a.key}
                          className="small"
                          title={a.description}
                          onClick={() => {
                            const outcome = mutate((s) => {
                              const rng = new Rng(s.rng);
                              const r = performSocialAction(s, s.fighters[fighter.id], a.key, rng);
                              s.rng = rng.getState();
                              return r;
                            });
                            if (outcome) {
                              setSocialLog((l) => [`${outcome.headline}: ${outcome.detail}`, ...l].slice(0, 8));
                              showToast(outcome.detail, outcome.succeeded ? 'good' : 'bad');
                            }
                          }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                    {socialLog.length > 0 && (
                      <ul className="small dim mt" style={{ paddingLeft: 16 }}>
                        {socialLog.map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="dim small">No social data on this record.</p>
            )}
          </Panel>
        </div>
      )}

      {tab === 'health' && (
        <div className="grid c2">
          <Panel title="Longevity breakdown">
            <table>
              <tbody>
                {healthReport(fighter).map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td style={{ width: 100 }}>
                      <Bar value={100 - r.value} />
                    </td>
                    <td className="small dim">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small faint mt">
              Rest recovers some wear. Neurological wear is mostly permanent, which is why a long career of hard fights
              cannot be trained away.
            </p>
          </Panel>
          <Panel title="Injuries" flush>
            <DataTable
              rows={fighter.injuries.slice().reverse()}
              rowKey={(i) => i.id}
              columns={[
                { key: 'type', label: 'Injury', render: (i) => i.type },
                { key: 'area', label: 'Area', render: (i) => i.area },
                { key: 'sev', label: 'Severity', numeric: true, sort: (i) => i.severity, render: (i) => i.severity },
                { key: 'cause', label: 'Cause', render: (i) => i.cause },
                { key: 'start', label: 'From', render: (i) => i.startedAt },
                {
                  key: 'status',
                  label: 'Status',
                  render: (i) =>
                    i.actualReturn ? (
                      <span className="dim">cleared {i.actualReturn}</span>
                    ) : (
                      <span className="bad">out until {i.expectedReturn}</span>
                    ),
                },
              ]}
              empty="No recorded injuries."
            />
          </Panel>
        </div>
      )}

      {tab === 'data' && (
        <Panel title="Where this fighter's information comes from">
          {fighter.isRealPerson ? (
            <>
              <p className="small">
                This is a real athlete. The fields below were copied from the official source at the snapshot date.
                Everything not listed is a simulated game value.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Source</th>
                    <th>Confidence</th>
                    <th>Fetched</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(fighter.provenance).map(([field, p]) => (
                    <tr key={field}>
                      <td>{field}</td>
                      <td>
                        {p.sourceUrl ? (
                          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                            {p.source}
                          </a>
                        ) : (
                          p.source
                        )}
                      </td>
                      <td>{p.confidence}</td>
                      <td className="small dim">{p.fetchedAt?.slice(0, 10)}</td>
                      <td className="wrap small dim">{p.transformation ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="small">
              This is a fictional fighter generated inside this save. Nothing about this fighter refers to a real person.
            </p>
          )}
          <h3 className="mt">Value kinds on this page</h3>
          <ul className="small dim" style={{ paddingLeft: 16 }}>
            <li>Sourced fact: name, physicals, official record, ranking, activity status, gym affiliation.</li>
            <li>Derived rating: the six performance ratings, produced by the rating model from sourced statistics.</li>
            <li>Model estimate: Pot, Longevity, wear, popularity and tendencies.</li>
            <li>Simulated: contracts, purses, fight results and everything after the snapshot date.</li>
            <li>Unknown: any field shown as Unknown was not published by the source and has not been invented.</li>
          </ul>
        </Panel>
      )}
    </div>
  );
}
