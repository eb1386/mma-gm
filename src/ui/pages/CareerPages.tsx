import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Rng } from '@core/rng';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { formatDate, formatMoney } from '@core/types/common';
import {
  acceptSponsor,
  conflictsOfInterest,
  declineSponsor,
  fireManager,
  generateManager,
  hireManager,
  managerFor,
  SPONSOR_CATEGORY_LABEL,
  sponsorAppealOf,
  sponsorsFor,
} from '@core/world/finance';
import {
  acceptSanction,
  appealSanction,
  dopingState,
  POSTURE_DETAIL,
  POSTURE_LABEL,
  setPosture,
  type CompliancePosture,
} from '@core/world/antidoping';
import {
  adjacentDivisions,
  assessChampionMove,
  cancelPlan,
  CHAMPION_PATH_LABEL,
  commitMove,
  currentPlan,
  evaluateOption,
  explore,
  MOVE_KIND_LABEL,
  requestApproval,
  TITLE_DECISION_LABEL,
  type MoveKind,
  type TitleDecision,
} from '@core/world/weightclass';
import {
  assessCallout,
  CALLOUT_TONE_LABEL,
  calloutsFor,
  makeCallout,
  RELATIONSHIP_LABEL,
  relationshipsFor,
  type CalloutTone,
} from '@core/world/relationships';
import { CAREER_STATE_LABEL } from '@core/world/career';
import { assessTitleOpportunity, assessTitleRematch, lastTitleLoss, OPPORTUNITY_LABEL } from '@core/world/title-logic';
import { offerBlockReason, BLOCK_REASON_TEXT } from '@core/world/availability';
import { addDays } from '@core/types/common';
import { KeyValues, Notice, Panel, Tabs } from '../components';
import { useCareerStatus, useGame } from '../store';
import { interestStatusLine, matchupInterestsFor, MATCHUP_SOURCE_LABEL } from '@core/world/matchup-interest';

const POSTURES: CompliancePosture[] = ['strict', 'standard', 'loose', 'questionable'];
const TONES: CalloutTone[] = ['respectful', 'confident', 'aggressive', 'personal', 'promotional'];

/** Shared helper so every button on these pages routes through the operation controller. */
function useAct() {
  const runOperation = useGame((s) => s.runOperation);
  const showToast = useGame((s) => s.showToast);
  const busy = useGame((s) => s.busy);
  const save = useGame((s) => s.save)!;
  const act = async (label: string, work: () => string) => {
    const result = await runOperation('other', label, (report) => {
      report('updating-world', label);
      const message = work();
      return {
        ok: true,
        noOpReason: null,
        error: null,
        fromDate: save.date,
        toDate: save.date,
        daysAdvanced: 0,
        eventsResolved: [],
        headlines: [message],
        stoppedBecause: null,
        navigateTo: null,
        summary: message,
      };
    });
    showToast(result.headlines[0] ?? result.error ?? 'Done.', result.ok ? 'good' : 'bad');
    return result;
  };
  return { act, busy };
}

// ---------------------------------------------------------------------------
// Sponsors
// ---------------------------------------------------------------------------

export function SponsorsPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const { act, busy } = useAct();
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me) {
    return (
      <div className="page">
        <Notice kind="warn">Sponsorship is managed for your own fighter.</Notice>
      </div>
    );
  }
  const sponsors = sponsorsFor(save, me.id);
  const offered = sponsors.filter((s) => s.status === 'offered');
  const active = sponsors.filter((s) => s.status === 'active');
  const past = sponsors.filter((s) => s.status === 'expired' || s.status === 'terminated');

  return (
    <div className="page">
      <div className="page-head">
        <h1>Sponsors</h1>
        <span className="sub">Interest is driven by reach and approval, never by Ovr</span>
      </div>

      <Panel title={`Offers on the table${offered.length > 0 ? ` (${offered.length})` : ''}`}>
        <p className="small dim">Your current sponsor appeal is {Math.round(sponsorAppealOf(me))} out of 100.</p>
        {offered.length === 0 && <p className="dim">Nothing on the table right now.</p>}
        {offered.map((s) => (
          <div key={s.id} className="social-item">
            <div className="src">{SPONSOR_CATEGORY_LABEL[s.category]}</div>
            <p>
              <strong>{s.name}</strong>
            </p>
            <KeyValues
              rows={[
                ['Per fight', formatMoney(s.perFight)],
                ['Monthly retainer', s.monthly > 0 ? formatMoney(s.monthly) : 'None'],
                ['Win bonus', formatMoney(s.winBonus)],
                ['Champion bonus', formatMoney(s.championBonus)],
                ['Posts owed', `${s.postsPerMonth} per month`],
                ['Appearances', `${s.appearancesPerYear} per year`],
                ['Category exclusive', s.exclusiveCategory ? 'Yes, blocks other deals in this category' : 'No'],
                ['Morality clause', s.moralityClause ? 'Yes, they can walk over controversy' : 'No'],
                ['Runs until', formatDate(s.endsOn)],
              ]}
            />
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act('Signing the sponsor', () => {
                    const signed = mutate((st) => acceptSponsor(st, s.id));
                    return signed ? `Signed with ${signed.name}.` : 'That offer is no longer available.';
                  })
                }
              >
                Sign
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void act('Declining the sponsor', () => {
                    mutate((st) => declineSponsor(st, s.id));
                    return `Turned down ${s.name}.`;
                  })
                }
              >
                Decline
              </button>
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Active deals">
        {active.length === 0 ? (
          <p className="dim">No active sponsorship.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sponsor</th>
                <th>Category</th>
                <th className="num">Per fight</th>
                <th className="num">Monthly</th>
                <th>Obligations</th>
                <th className="num">Relationship</th>
                <th>Until</th>
              </tr>
            </thead>
            <tbody>
              {active.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{SPONSOR_CATEGORY_LABEL[s.category]}</td>
                  <td className="num">{formatMoney(s.perFight)}</td>
                  <td className="num">{s.monthly > 0 ? formatMoney(s.monthly) : ''}</td>
                  <td className="small">
                    {s.postsPerMonth} posts, {s.appearancesPerYear} appearances
                    {s.moralityClause ? ', morality clause' : ''}
                  </td>
                  <td className="num">{Math.round(s.satisfaction)}</td>
                  <td>{formatDate(s.endsOn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {past.length > 0 && (
        <Panel title="Contract history">
          <table>
            <tbody>
              {past.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="small dim">{s.status === 'expired' ? 'Ran its term' : 'Ended early'}</td>
                  <td className="small dim">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

export function ManagementPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const { act, busy } = useAct();
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me) {
    return (
      <div className="page">
        <Notice kind="warn">Representation is managed for your own fighter.</Notice>
      </div>
    );
  }
  const manager = managerFor(save, me.id);
  const conflicts = conflictsOfInterest(save, me.id);
  const available = Object.values(save.managers ?? {}).filter((m) => m.id !== manager?.id && m.clientIds.length < m.clientCapacity);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Management</h1>
        <span className="sub">Your representation and the people around your career</span>
      </div>

      <div className="grid c2">
        <Panel title="Your manager">
          {manager ? (
            <>
              <KeyValues
                rows={[
                  ['Manager', manager.name],
                  ['Commission', `${manager.commissionPct} percent of every purse`],
                  ['Negotiation', Math.round(manager.negotiation)],
                  ['Matchmaking influence', Math.round(manager.matchmakingInfluence)],
                  ['Sponsor network', Math.round(manager.sponsorNetwork)],
                  ['Media skill', Math.round(manager.mediaSkill)],
                  ['Loyalty', Math.round(manager.loyalty)],
                  ['Aggressiveness', Math.round(manager.aggressiveness)],
                  ['Honesty', Math.round(manager.honesty)],
                  ['Clients', `${manager.clientIds.length} of ${manager.clientCapacity}`],
                  ['Your relationship', Math.round(me.relationships.manager)],
                ]}
              />
              <p className="small dim">{manager.note}</p>
              {conflicts.length > 0 && (
                <Notice kind="warn">
                  Conflict of interest: {manager.name} also represents {conflicts.map((f) => f.name).join(', ')} in your
                  division.
                </Notice>
              )}
              <button
                className="danger mt"
                disabled={busy}
                onClick={() => void act('Releasing the manager', () => mutate((st) => fireManager(st, me.id))?.message ?? 'Done.')}
              >
                Release {manager.name}
              </button>
            </>
          ) : (
            <p className="dim">You are unrepresented. A manager takes a percentage but negotiates better purses.</p>
          )}
        </Panel>

        <Panel title="Available managers">
          <p className="small dim">
            A better negotiator gets you more of the purse and charges more for it. An aggressive one pushes harder and
            burns goodwill.
          </p>
          {available.slice(0, 5).map((m) => (
            <div key={m.id} className="social-item">
              <p>
                <strong>{m.name}</strong> <span className="dim small">{m.commissionPct} percent</span>
              </p>
              <p className="small">
                Negotiation {Math.round(m.negotiation)}, influence {Math.round(m.matchmakingInfluence)}, sponsor network{' '}
                {Math.round(m.sponsorNetwork)}, honesty {Math.round(m.honesty)}.
              </p>
              <p className="small dim">{m.note}</p>
              <button
                disabled={busy}
                onClick={() => void act('Hiring the manager', () => mutate((st) => hireManager(st, me.id, m.id))?.message ?? 'Done.')}
              >
                Hire {m.name}
              </button>
            </div>
          ))}
          <button
            className="mt"
            disabled={busy}
            onClick={() =>
              void act('Looking for representation', () => {
                const created = mutate((st) => {
                  const rng = new Rng(st.rng);
                  const out = generateManager(st, rng);
                  st.rng = rng.getState();
                  return out;
                });
                return created ? `${created.name} is interested in representing you.` : 'Nobody new is interested.';
              })
            }
          >
            Ask around for representation
          </button>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export function CompliancePage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const { act, busy } = useAct();
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me) {
    return (
      <div className="page">
        <Notice kind="warn">Compliance is tracked for your own fighter.</Notice>
      </div>
    );
  }
  const doping = dopingState(save, me.id);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Compliance</h1>
        <span className="sub">Anti-doping, licensing and commission standing</span>
      </div>

      <div className="grid c2">
        <Panel title="Where you stand">
          <p className="small dim">
            This is deliberately abstract. It models the consequences a fighter faces, not any method of avoiding a
            test.
          </p>
          <KeyValues
            rows={[
              ['Current posture', POSTURE_LABEL[doping.posture]],
              ['Tests this year', doping.testsThisYear],
              ['Last tested', doping.lastTestedOn ? formatDate(doping.lastTestedOn) : 'Not yet tested'],
              ['Findings on record', doping.findings.length],
              ['Under investigation', doping.underInvestigation ? 'Yes' : 'No'],
              [
                'Anti-doping suspension',
                me.antiDopingSuspension ? `Until ${formatDate(me.antiDopingSuspension.until)}: ${me.antiDopingSuspension.reason}` : 'None',
              ],
              [
                'Medical suspension',
                me.medicalSuspension ? `Until ${formatDate(me.medicalSuspension.until)}: ${me.medicalSuspension.reason}` : 'None',
              ],
              [
                'Commission suspension',
                me.commissionSuspension ? `Until ${formatDate(me.commissionSuspension.until)}` : 'None',
              ],
              ['Eligible to compete', me.antiDopingSuspension || me.medicalSuspension ? 'No' : 'Yes'],
            ]}
          />
          {me.antiDopingSuspension && (
            <div className="row mt">
              <button
                disabled={busy}
                onClick={() =>
                  void act('Appealing the sanction', () => {
                    const outcome = mutate((st) => {
                        const rng = new Rng(st.rng);
                        const out = appealSanction(st, st.fighters[me.id], rng);
                        st.rng = rng.getState();
                        return out;
                      });
                    return outcome?.message ?? 'Done.';
                  })
                }
              >
                Appeal the sanction
              </button>
              <button
                disabled={busy}
                onClick={() => void act('Accepting the sanction', () => mutate((st) => acceptSanction(st, st.fighters[me.id])) ?? 'Done.')}
              >
                Accept it
              </button>
            </div>
          )}
          {doping.findings.length > 0 && (
            <>
              <h3 className="mt">Findings</h3>
              <table>
                <tbody>
                  {doping.findings.map((f, i) => (
                    <tr key={i}>
                      <td className="dim small">{formatDate(f.on)}</td>
                      <td>{f.kind}</td>
                      <td className="small">{f.outcome ?? (f.resolved ? 'Resolved' : 'Open')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        <Panel title="Choose a posture">
          {POSTURES.map((p) => (
            <div key={p} className="social-item">
              <p>
                <strong>{POSTURE_LABEL[p]}</strong>
                {doping.posture === p && (
                  <span className="tag" style={{ marginLeft: 6 }}>
                    current
                  </span>
                )}
              </p>
              <p className="small">{POSTURE_DETAIL[p]}</p>
              {doping.posture !== p && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act('Changing compliance posture', () => {
                      mutate((st) => setPosture(st, me.id, p));
                      return `Compliance posture set to ${POSTURE_LABEL[p].toLowerCase()}.`;
                    })
                  }
                >
                  Adopt this
                </button>
              )}
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Career: state, weight class, relationships, callouts
// ---------------------------------------------------------------------------

export function CareerPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const status = useCareerStatus();
  const navigate = useNavigate();
  // The one executor that understands every CareerAction kind, shared with the advance bar.
  const runAction = useGame((s) => s.runAction);
  const { act, busy } = useAct();
  const [tab, setTab] = useState('state');
  const [tone, setTone] = useState<CalloutTone>('confident');
  const [moveKind, setMoveKind] = useState<MoveKind>('permanent');
  const [titleDecision, setTitleDecision] = useState<TitleDecision>('vacate-now');
  const [target, setTarget] = useState<string>('');

  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me || !status) {
    return (
      <div className="page">
        <Notice kind="warn">This page is for a fighter career.</Notice>
      </div>
    );
  }

  const { up, down } = adjacentDivisions(me);
  const plan = currentPlan(save, me.id);
  const relationships = relationshipsFor(save, me.id).slice(0, 25);
  const myCallouts = calloutsFor(save, me.id).slice(0, 12);
  // Every matchup the promotion is still considering, so a callout is never a dead end.
  const liveInterests = matchupInterestsFor(save, me.id).filter((m) => m.eligibility !== 'expired');
  const division = save.rankings[me.divisionId];
  const calloutTargets = [
    ...(division?.championId ? [division.championId] : []),
    ...(division?.entries ?? []).slice(0, 15).map((e) => e.fighterId),
  ].filter((id) => id !== me.id);
  const chosen = target ? save.fighters[target] : null;
  const assessment = chosen
    ? assessCallout(save, me.id, chosen.id, (() => {
        const reason = offerBlockReason(save, chosen, { eventDate: addDays(save.date, 60) });
        return reason ? BLOCK_REASON_TEXT[reason] : null;
      })())
    : null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Career</h1>
        <span className="sub">{CAREER_STATE_LABEL[status.state]}</span>
      </div>

      <Tabs
        tabs={[
          { key: 'state', label: 'Where you stand' },
          { key: 'weight', label: 'Weight class' },
          { key: 'relationships', label: `Relationships${relationships.length > 0 ? ` (${relationships.length})` : ''}` },
          { key: 'callouts', label: 'Callouts' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'state' && (
        <Panel title="Career state">
          <KeyValues
            rows={[
              ['State', CAREER_STATE_LABEL[status.state]],
              ['Why', status.reason],
              ['Next action', status.action?.label ?? 'Nothing outstanding'],
              ['Division', DIVISION_BY_ID[me.divisionId].name],
              ['Ranking', me.isChampion ? 'Champion' : me.ranking !== null ? `Number ${me.ranking}` : 'Unranked'],
              ['Record', `${me.record.wins}-${me.record.losses}${me.record.draws ? `-${me.record.draws}` : ''}`],
              ['Booked opponent', status.opponentName ?? 'Nobody'],
              ['Fight date', status.eventDate ? formatDate(status.eventDate) : 'None'],
              ['Injury', status.injurySummary ?? 'None'],
              ['Advancement', status.advanceBlocked ? `Blocked: ${status.blockedReason}` : 'Available'],
            ]}
          />
          {status.action && (
            // The action is a discriminated union. Navigating for anything that is not a
            // navigate action sent the player to the dashboard and ran nothing, so the primary
            // button on this page did nothing at all whenever the next step was to advance time.
            <button className="primary mt" disabled={busy} onClick={() => void runAction(status.action!, navigate)}>
              {status.action.label}
            </button>
          )}
          {(() => {
            const leverage = assessTitleOpportunity(save, me, me.divisionId);
            const loss = lastTitleLoss(save, me.id);
            const rematch = loss ? assessTitleRematch(save, me, loss) : null;
            return (
              <>
                <h3 className="mt">Where you stand for a title</h3>
                <p>
                  <strong>{OPPORTUNITY_LABEL[leverage.opportunity]}</strong>
                </p>
                {leverage.reasons.map((r, i) => (
                  <div key={i} className="small good">
                    {r}
                  </div>
                ))}
                {leverage.cautions.map((c, i) => (
                  <div key={i} className="small warn">
                    {c}
                  </div>
                ))}
                {rematch && (
                  <>
                    <h3 className="mt">Rematch claim</h3>
                    <p className="small">
                      {rematch.granted
                        ? 'You have a live claim on an immediate rematch.'
                        : 'You do not currently have an automatic rematch claim.'}
                    </p>
                    {rematch.reasons.map((r, i) => (
                      <div key={i} className="small good">
                        {r}
                      </div>
                    ))}
                    {rematch.blockers.map((b, i) => (
                      <div key={i} className="small warn">
                        {b}
                      </div>
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </Panel>
      )}

      {tab === 'weight' && (
        <>
          {plan && plan.status !== 'completed' && plan.status !== 'canceled' && (
            <Panel title="Current plan">
              <KeyValues
                rows={[
                  ['Moving', `${DIVISION_BY_ID[plan.fromDivisionId].name} to ${DIVISION_BY_ID[plan.toDivisionId].name}`],
                  ['Direction', plan.direction],
                  ['Status', plan.status],
                  ['Manager', plan.managerOpinion ?? 'No opinion given'],
                  ['Head coach', plan.coachOpinion ?? 'No opinion given'],
                  ['Promotion', plan.promotionResponse ?? 'Not asked yet'],
                  ['Move type', MOVE_KIND_LABEL[plan.kind ?? 'permanent']],
                  ['Your championship', TITLE_DECISION_LABEL[plan.titleDecision ?? 'not-applicable']],
                ]}
              />
              {plan.championPathExplanation && (
                <Notice kind="info">
                  <strong>{plan.championPath ? CHAMPION_PATH_LABEL[plan.championPath] : 'Championship path'}:</strong>{' '}
                  {plan.championPathExplanation}
                </Notice>
              )}
              <div className="row mt">
                {(plan.status === 'exploring' || plan.status === 'refused') && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void act('Asking the promotion', () => {
                        const updated = mutate((st) => {
                          const rng = new Rng(st.rng);
                          const out = requestApproval(st, st.fighters[me.id], rng);
                          st.rng = rng.getState();
                          return out;
                        });
                        return updated?.promotionResponse ?? 'The promotion has been asked.';
                      })
                    }
                  >
                    Ask the promotion
                  </button>
                )}
                {plan.status === 'approved' && (
                  <>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act('Committing to the move', () => {
                          const outcome = mutate((st) => commitMove(st, st.fighters[me.id], true));
                          return outcome?.message ?? 'Done.';
                        })
                      }
                    >
                      Commit and announce it
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act('Committing quietly', () => {
                          const outcome = mutate((st) => commitMove(st, st.fighters[me.id], false));
                          return outcome?.message ?? 'Done.';
                        })
                      }
                    >
                      Commit without announcing
                    </button>
                  </>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void act('Canceling the plan', () => {
                      mutate((st) => cancelPlan(st, me.id));
                      return 'The move is off for now.';
                    })
                  }
                >
                  Cancel the plan
                </button>
              </div>
            </Panel>
          )}

          <div className="grid c2">
            {[down, up].filter(Boolean).map((d) => {
              const option = evaluateOption(save, me, d!);
              return (
                <Panel key={d!.id} title={`${option.direction === 'up' ? 'Moving up to' : 'Moving down to'} ${d!.name}`}>
                  <KeyValues
                    rows={[
                      ['Weight management', option.weightDifficulty],
                      ['Speed', option.speedEffect],
                      ['Strength', option.strengthEffect],
                      ['Cardio', option.cardioEffect],
                      ['Durability', option.durabilityEffect],
                      ['Adaptation', option.adaptationPeriod],
                      ['Ranking', option.rankingConsequence],
                      ['Title', option.titleConsequence],
                      ['Contract', option.contractConsequence],
                      ['Health risk', option.healthRisk],
                      ['Champion there', option.championName ?? 'Vacant'],
                      ['Promotion likelihood', `${Math.round(option.promotionLikelihood)} out of 100`],
                    ]}
                  />
                  <h3 className="mt">What it buys</h3>
                  <ul className="small">
                    {option.benefits.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                  <h3>What it costs</h3>
                  <ul className="small">
                    {option.costs.map((cst, i) => (
                      <li key={i}>{cst}</li>
                    ))}
                  </ul>
                  {option.likelyOpponents.length > 0 && (
                    <p className="small dim">Likely opponents: {option.likelyOpponents.join(', ')}.</p>
                  )}
                  {(() => {
                    const leverage = assessTitleOpportunity(save, me, d!.id, { direction: option.direction });
                    return (
                      <div className="notice mt">
                        <strong>{OPPORTUNITY_LABEL[leverage.opportunity]}</strong>
                        {leverage.reasons.map((r, i) => (
                          <div key={i} className="small good">
                            {r}
                          </div>
                        ))}
                        {leverage.cautions.map((c, i) => (
                          <div key={i} className="small warn">
                            {c}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {(() => {
                    // A champion moving weight has to say what happens to the belt they hold,
                    // because both divisions depend on the answer.
                    const isChampion = save.rankings[me.divisionId]?.championId === me.id;
                    const championPath = isChampion ? assessChampionMove(save, me, d!.id) : null;
                    return (
                      <>
                        {championPath && (
                          <Notice kind="info">
                            <strong>{CHAMPION_PATH_LABEL[championPath.path]}:</strong> {championPath.explanation}
                            {championPath.cautions.map((c, i) => (
                              <div key={i} className="small warn">
                                {c}
                              </div>
                            ))}
                          </Notice>
                        )}
                        <div className="row wrap mt">
                          <label>
                            Move type
                            <select
                              value={moveKind}
                              onChange={(e) => setMoveKind(e.target.value as MoveKind)}
                              disabled={busy}
                            >
                              <option value="permanent">{MOVE_KIND_LABEL.permanent}</option>
                              <option value="one-fight">{MOVE_KIND_LABEL['one-fight']}</option>
                              {isChampion && <option value="double-champion">{MOVE_KIND_LABEL['double-champion']}</option>}
                              {me.eligibleDivisions.includes(d!.id) && <option value="return">{MOVE_KIND_LABEL.return}</option>}
                            </select>
                          </label>
                          {isChampion && (
                            <label>
                              Your championship
                              <select
                                value={titleDecision}
                                onChange={(e) => setTitleDecision(e.target.value as TitleDecision)}
                                disabled={busy}
                              >
                                <option value="vacate-now">{TITLE_DECISION_LABEL['vacate-now']}</option>
                                <option value="keep-temporarily">{TITLE_DECISION_LABEL['keep-temporarily']}</option>
                                <option value="defend-both">{TITLE_DECISION_LABEL['defend-both']}</option>
                              </select>
                            </label>
                          )}
                        </div>
                      </>
                    );
                  })()}
                  <button
                    className="mt"
                    disabled={busy || Boolean(plan && plan.status !== 'canceled' && plan.status !== 'completed')}
                    onClick={() =>
                      void act('Exploring the move', () => {
                        mutate((st) => explore(st, st.fighters[me.id], d!, moveKind, titleDecision));
                        return `You are looking into a move to ${d!.name}. Nothing is committed.`;
                      })
                    }
                  >
                    Explore this move
                  </button>
                </Panel>
              );
            })}
          </div>
          {!up && !down && <Notice>There is no adjacent division to move to from here.</Notice>}
        </>
      )}

      {tab === 'relationships' && (
        <Panel title="People in your career">
          {relationships.length === 0 ? (
            <p className="dim">Nobody yet. Fights, training and social exchanges all build relationships.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Fighter</th>
                  <th>Standing</th>
                  <th className="num">Respect</th>
                  <th className="num">Friendship</th>
                  <th className="num">Rivalry</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {relationships.map((r) => (
                  <tr key={r.other.id}>
                    <td>{r.other.name}</td>
                    <td>{RELATIONSHIP_LABEL[r.state]}</td>
                    <td className="num">{Math.round(r.relationship.respect)}</td>
                    <td className="num">{Math.round(r.relationship.friendship)}</td>
                    <td className="num">{Math.round(r.relationship.rivalry)}</td>
                    <td className="small dim">{r.relationship.history[r.relationship.history.length - 1]?.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {tab === 'callouts' && (
        <>
          <Panel title="Call someone out">
            <p className="small dim">
              A callout never books a fight by itself. The matchmaker still decides, weighing rankings, availability and
              what the promotion wants.
            </p>
            <div className="row">
              <label>Target</label>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a fighter</option>
                {calloutTargets.map((id) => (
                  <option key={id} value={id}>
                    {save.fighters[id]?.name ?? id}
                  </option>
                ))}
              </select>
              <label>Tone</label>
              <select value={tone} onChange={(e) => setTone(e.target.value as CalloutTone)}>
                {TONES.map((tn) => (
                  <option key={tn} value={tn}>
                    {CALLOUT_TONE_LABEL[tn]}
                  </option>
                ))}
              </select>
            </div>
            {assessment && (
              <>
                <KeyValues
                  rows={[
                    ['Target', assessment.targetName],
                    ['Ranking', assessment.ranking],
                    ['Available', assessment.available ? 'Yes' : assessment.availabilityNote],
                    ['Ranking gap', assessment.rankingGap === 0 ? 'Level' : `${Math.abs(assessment.rankingGap)} places`],
                    ['Chance they accept', `${Math.round(assessment.acceptanceChance * 100)} percent`],
                    ['Promotion interest', `${Math.round(assessment.promotionInterest)} out of 100`],
                    ['Expected hype', `${Math.round(assessment.expectedHype)} out of 100`],
                    ['Relationship', RELATIONSHIP_LABEL[assessment.relationship]],
                  ]}
                />
                {assessment.reasons.map((r, i) => (
                  <p key={i} className="small good">
                    {r}
                  </p>
                ))}
                {assessment.warnings.map((w, i) => (
                  <p key={i} className="small warn">
                    {w}
                  </p>
                ))}
                <button
                  className="primary mt"
                  disabled={busy}
                  onClick={() =>
                    void act('Calling them out', () => {
                      const callout = mutate((st) => {
                        const rng = new Rng(st.rng);
                        const out = makeCallout(st, me.id, chosen!.id, tone, rng);
                        st.rng = rng.getState();
                        return out;
                      });
                      return callout ? `You called out ${chosen!.name}. ${callout.text}` : 'That callout could not be made.';
                    })
                  }
                >
                  Call out {chosen?.name}
                </button>
              </>
            )}
          </Panel>

          <Panel title="Where these matchups stand">
            {liveInterests.length === 0 ? (
              <p className="dim">
                Nothing is currently with the matchmaker. A callout that goes well creates a matchmaking record here, and
                you can follow it until it becomes an offer or the promotion explains why it will not.
              </p>
            ) : (
              <table>
                <tbody>
                  {liveInterests.map((interest) => {
                    const other = save.fighters[interest.targetId === me.id ? interest.callerId : interest.targetId];
                    return (
                      <tr key={interest.id}>
                        <td>{other?.name ?? 'Unknown fighter'}</td>
                        <td className="small nowrap">{MATCHUP_SOURCE_LABEL[interest.source]}</td>
                        <td className={interest.eligibility === 'eligible' ? 'small good' : 'small warn'}>
                          {interestStatusLine(save, interest)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Callout history">
            {myCallouts.length === 0 ? (
              <p className="dim">You have not called anyone out, and nobody has called you out.</p>
            ) : (
              <table>
                <tbody>
                  {myCallouts.map((c) => (
                    <tr key={c.id}>
                      <td className="dim small nowrap">{formatDate(c.madeOn)}</td>
                      <td>
                        {c.fromId === me.id ? `You called out ${save.fighters[c.toId]?.name}` : `${save.fighters[c.fromId]?.name} called you out`}
                      </td>
                      <td className="small">{c.responseText ?? (c.status === 'open' ? 'Awaiting an answer' : 'No answer came')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
