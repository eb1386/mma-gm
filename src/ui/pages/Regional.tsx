import { Link } from 'react-router-dom';
import { PageTip } from '../Guide';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { PROMOTION_ABBREVIATION, PROMOTION_NAME } from '@core/config/branding';
import { PRO_AGE, REGIONAL_LEVELS } from '@core/config/regional';
import { formatDate, toDayNumber } from '@core/types/common';
import { ovrDisplayed } from '@core/types/fighter';
import {
  CALL_UP_THRESHOLD,
  callUpReadiness,
  isAmateurFighter,
  promotionConfig,
  promotionOfFighter,
  regionalStandings,
  TRYOUT_THRESHOLD,
  type ReadinessFactor,
} from '@core/world/regional';
import { displayedPot } from '@core/world/pot';
import { useGame } from '../store';
import { Bar, FighterLink, KeyValues, LineChart, Notice, Panel, RecordText } from '../components';

/**
 * The regional circuit, from the player's side: where they stand on their promotion, and exactly
 * how close the call up is. Every factor the main promotion weighs is listed with what it adds, so
 * the player can see what to work on rather than waiting for an offer to appear.
 */
export function RegionalPage() {
  const save = useGame((s) => s.save)!;
  const state = save.regional;
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;

  if (!state || !me) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Regional circuit</h1>
        </div>
        <Notice>
          This career did not start on the regional circuit. Create a fighter and choose the regional circuit as the career start
          to come up through a regional promotion and earn the call up.
        </Notice>
      </div>
    );
  }

  const promotion = promotionOfFighter(me) ?? promotionConfig(state.graduates.find((g) => g.fighterId === me.id)?.promotionId);
  const onCircuit = Boolean(me.circuit);
  const readiness = onCircuit ? callUpReadiness(save, me) : null;
  const standing = promotion ? regionalStandings(save, promotion.id, me.divisionId) : null;
  const champion = standing?.championId ? save.fighters[standing.championId] : null;
  const amateur = isAmateurFighter(me);
  const cards = Object.values(save.events)
    .filter((e) => e.promotionId && e.status !== 'canceled')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const upcoming = cards.filter((e) => e.status === 'announced' && e.date >= save.date).slice(0, 4);
  const recent = cards.filter((e) => e.status === 'completed').slice(-6).reverse();
  const history = state.callUp.history.map((h) => ({ x: toDayNumber(h.date), y: h.readiness }));
  const am = me.amateurRecord;
  // Only this circuit's graduates. The list used to show every promotion's, including tryout
  // opponents who never fought here, under 'Nobody from this circuit has been called up yet'.
  const graduates = state.graduates.filter((g) => g.promotionId === promotion?.id);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{promotion?.name ?? 'Regional circuit'}</h1>
        <span className="sub">
          {promotion ? `${REGIONAL_LEVELS[promotion.level].label}, ${promotion.country}` : ''}
          {' · '}
          {DIVISION_BY_ID[me.divisionId].name}
        </span>
      </div>
      <PageTip id="regional" title="The call up">
        Readiness rises with wins, finishes, your regional ranking and the belt, and with how good you actually are. At 50 a tryout invitation can arrive; at 68 the main promotion offers a contract.
      </PageTip>

      {!onCircuit && state.callUp.calledUpOn && (
        <Notice kind="good">
          {me.name} was called up to {PROMOTION_NAME} on {formatDate(state.callUp.calledUpOn)}. The regional circuit is
          behind them now; this page is the record of how they got there.
        </Notice>
      )}
      {amateur && (
        <Notice>
          {me.name} is an amateur until {state.turnsProOn ? formatDate(state.turnsProOn) : `turning ${PRO_AGE}`}. Amateur bouts pay
          nothing and count only on the amateur record. {PROMOTION_ABBREVIATION} does not sign amateurs.
        </Notice>
      )}

      <div className="grid c2">
        <Panel title={onCircuit ? 'The call up' : 'Readiness when called up'}>
          {readiness && amateur ? (
            <>
              {/* An amateur cannot be signed, so a score, a red bar and the threshold copy only
                  contradicted the notice above. The countdown is what matters until then. */}
              <p>
                <strong>Turns pro on {state.turnsProOn ? formatDate(state.turnsProOn) : `turning ${PRO_AGE}`}</strong>
              </p>
              <p className="small dim">
                Amateur record {am ? `${am.wins}-${am.losses}${am.draws ? `-${am.draws}` : ''}` : '0-0'}. The call up is reviewed from
                the first professional fight.
              </p>
              <h3 className="mt">Preview: how {PROMOTION_ABBREVIATION} would weigh it today</h3>
              <FactorTable factors={readiness.factors} />
            </>
          ) : readiness ? (
            <>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <strong style={{ fontSize: 26 }}>{readiness.score}</strong>
                <span className="dim">of 100</span>
              </div>
              <div className="mb">
                <Bar value={readiness.score} tone={readiness.score >= CALL_UP_THRESHOLD ? 'good' : readiness.score >= TRYOUT_THRESHOLD ? 'warn' : 'bad'} />
              </div>
              {/* With blockers the verdict is the first blocker, so it is summarised here and the
                  list below is the one place each blocker appears. */}
              <p>{readiness.blockers.length > 0 ? 'Not eligible for a call up yet.' : readiness.verdict}</p>
              {readiness.blockers.length > 0 && (
                <ul className="small bad">
                  {readiness.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              <p className="small dim">
                A Proving Ground tryout invitation comes at {TRYOUT_THRESHOLD}. A contract offer comes at {CALL_UP_THRESHOLD}, when the
                fighter is not booked and nothing is waiting on an answer.
              </p>
              <FactorTable factors={readiness.factors} />
            </>
          ) : (
            <p className="dim">The call up has happened. Readiness is no longer tracked.</p>
          )}
        </Panel>

        <Panel title="Record">
          <KeyValues
            rows={[
              ['Professional record', <RecordText key="r" f={me} />],
              ['Amateur record', am ? `${am.wins}-${am.losses}${am.draws ? `-${am.draws}` : ''}` : 'None'],
              ['Win streak', me.winStreak],
              ['Ovr', ovrDisplayed(me.ratings)],
              ['Pot', displayedPot(me)],
              [
                'Regional standing',
                !onCircuit
                  ? 'Called up'
                  : champion?.id === me.id
                    ? `${promotion?.abbreviation} champion`
                    : (standing?.entries.find((e) => e.fighterId === me.id)?.rank ?? null) !== null
                      ? `Ranked number ${standing!.entries.find((e) => e.fighterId === me.id)!.rank}`
                      : amateur
                        ? 'Amateur'
                        : 'Unranked',
              ],
            ]}
          />
          <h3 className="mt">Call up readiness over time</h3>
          <LineChart series={[{ points: history, className: 'line-ovr', label: 'Readiness' }]} />
        </Panel>
      </div>

      {standing && onCircuit && promotion && (
        <Panel title={`${promotion.abbreviation} ${DIVISION_BY_ID[me.divisionId].name} rankings`} flush>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Fighter</th>
                <th>Record</th>
                <th className="num">Points</th>
              </tr>
            </thead>
            <tbody>
              <tr className={champion?.id === me.id ? 'highlight' : undefined}>
                <td>
                  <span className="tag champ">C</span>
                </td>
                <td>{champion ? <FighterLink fighter={champion} /> : <span className="dim">Vacant</span>}</td>
                <td>{champion ? <RecordText f={champion} /> : ''}</td>
                <td className="num">{champion ? Math.round(state.points[champion.id] ?? 0) : ''}</td>
              </tr>
              {standing.entries.map((e) => {
                const f = save.fighters[e.fighterId];
                return (
                  <tr key={e.fighterId} className={e.fighterId === me.id ? 'highlight' : undefined}>
                    <td>{e.rank}</td>
                    <td>
                      <FighterLink fighter={f} />
                    </td>
                    <td>{f ? <RecordText f={f} /> : ''}</td>
                    <td className="num">{e.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <div className="grid c2">
        <Panel title="Upcoming cards">
          {upcoming.length === 0 ? (
            <p className="dim">Nothing scheduled.</p>
          ) : (
            <ul className="plain">
              {upcoming.map((e) => (
                <li key={e.id}>
                  <Link to={`/event/${e.id}`}>{e.name}</Link> <span className="dim small">{formatDate(e.date)}, {e.city}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt">Recent cards</h3>
          {recent.length === 0 ? (
            <p className="dim">None yet.</p>
          ) : (
            <ul className="plain">
              {recent.map((e) => (
                <li key={e.id}>
                  <Link to={`/event/${e.id}`}>{e.name}</Link> <span className="dim small">{formatDate(e.date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={`Called up to ${PROMOTION_ABBREVIATION}`}>
          {graduates.length === 0 ? (
            <p className="dim">Nobody from this circuit has been called up yet.</p>
          ) : (
            <ul className="plain">
              {graduates.slice(0, 12).map((g) => (
                <li key={g.fighterId + g.date}>
                  <FighterLink fighter={save.fighters[g.fighterId]} />{' '}
                  <span className="dim small">
                    {formatDate(g.date)}
                    {g.wasChampion ? ', as champion' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="small faint mt">
            Regional rivals who get called up stay in the world. The fighter beaten for a regional belt can turn up again on a{' '}
            {PROMOTION_ABBREVIATION} card.
          </p>
        </Panel>
      </div>
    </div>
  );
}

/**
 * The readiness breakdown. Its own class lets the label wrap and keeps the points column a fixed
 * width, because on a phone the long detail lines pushed the points past the edge of the panel.
 */
function FactorTable({ factors }: { factors: ReadinessFactor[] }) {
  return (
    <table className="factor-table">
      <tbody>
        {factors.map((f) => (
          <tr key={f.key}>
            <td>
              {f.label}
              <div className="small dim">{f.detail}</div>
            </td>
            <td className={`num ${f.points > 0 ? 'good' : f.points < 0 ? 'bad' : 'dim'}`}>
              {f.points > 0 ? '+' : ''}
              {f.points.toFixed(1)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
