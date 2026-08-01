import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rng } from '@core/rng';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { formatDate, formatMoney, formatNumber } from '@core/types/common';
import { ovrDisplayed, RATING_LONG_LABEL, RATING_KEYS } from '@core/types/fighter';
import { estimateRatings, scoutingReport } from '@core/world/scouting';
import { respondToOffer, type OfferResponse } from '@core/world/offers';
import { BOOKING_KIND_LABEL, type BookingKind } from '@core/world/matchmaking';
import { MATCHUP_SOURCE_LABEL, type MatchupSource } from '@core/world/matchup-interest';
import { canCompete } from '@core/world/health';
import { useGame } from '../store';
import { EstimatedRating, KeyValues, Notice, Panel, Rating, RealTag } from '../components';

/**
 * The plain label for a stored booking category.
 *
 * The category is stored as a string so an older save with a category this build no longer
 * knows about still renders, rather than showing an empty line.
 */
function bookingKindLabel(kind: string): string {
  if (kind in BOOKING_KIND_LABEL) return BOOKING_KIND_LABEL[kind as BookingKind];
  if (kind in MATCHUP_SOURCE_LABEL) return MATCHUP_SOURCE_LABEL[kind as MatchupSource];
  return 'Matchmaking decision';
}

/** Fight offer review. Every response and its consequence is stated in plain language. */
export function OfferPage() {
  const save = useGame((s) => s.save)!;
  const runOperation = useGame((s) => s.runOperation);
  const busy = useGame((s) => s.busy);
  const showToast = useGame((s) => s.showToast);
  const { offerId } = useParams();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const [askAmount, setAskAmount] = useState<number | null>(null);

  const offer = offerId ? save.fightOffers[offerId] : null;
  if (!offer) return <div className="page"><Notice kind="bad">That offer no longer exists.</Notice></div>;

  const fighter = save.fighters[offer.fighterId];
  const opponent = save.fighters[offer.opponentId];
  const est = estimateRatings(save, opponent);
  const scout = scoutingReport(save, opponent);
  const health = canCompete(fighter, save.date);
  const division = DIVISION_BY_ID[offer.divisionId];

  // Answering an offer goes through the operation controller so the buttons disable, the
  // result is visible, and a double click cannot apply the answer twice.
  const respond = async (response: OfferResponse) => {
    if (busy) return;
    const result = await runOperation('other', 'Answering the offer', (report) => {
      report('updating-world', 'Sending your answer to the matchmaker');
      const rng = new Rng(save.rng);
      const r = respondToOffer(save, offer.id, response, rng);
      save.rng = rng.getState();
      return {
        ok: true,
        noOpReason: r.accepted || r.newOffer ? null : r.message.includes('no longer') ? r.message : null,
        error: null,
        fromDate: save.date,
        toDate: save.date,
        daysAdvanced: 0,
        eventsResolved: [],
        headlines: [r.message],
        stoppedBecause: null,
        navigateTo: r.accepted ? '/camp' : null,
        summary: '',
      };
    });
    const text = result.headlines[0] ?? result.error ?? 'Nothing changed.';
    setMessage(text);
    showToast(text, result.navigateTo ? 'good' : 'info');
    if (result.navigateTo) navigate(result.navigateTo);
  };

  const closed = offer.status !== 'open';

  return (
    <div className="page">
      <div className="page-head">
        <h1>Fight offer</h1>
        <span className="sub">
          {offer.eventName} · {formatDate(offer.date)} · {offer.city}, {offer.country}
        </span>
      </div>

      {message && <Notice kind="good">{message}</Notice>}
      {closed && <Notice kind="warn">This offer is {offer.status}.</Notice>}
      {!health.ok && <Notice kind="bad">Currently unable to compete: {health.reason}. Declining for medical reasons carries no penalty.</Notice>}

      <div className="grid c2">
        <Panel title="The bout">
          <KeyValues
            rows={[
              ['Opponent', <Link key="o" to={`/fighter/${opponent.id}`}>{opponent.name}</Link>],
              ['Opponent ranking', opponent.isChampion ? 'Champion' : opponent.ranking ? `Number ${opponent.ranking}` : 'Unranked'],
              ['Opponent record', `${opponent.record.wins}-${opponent.record.losses}${opponent.record.draws ? `-${opponent.record.draws}` : ''}`],
              ['Division', division.name],
              ['Contracted weight', `${offer.contractedWeightLb} lb${offer.isCatchweight ? ' catchweight' : ''}`],
              ['Rounds', offer.scheduledRounds],
              ['Main event', offer.isMainEvent ? 'Yes' : 'No'],
              ['Title', offer.isInterimTitleFight ? 'Interim championship' : offer.isTitleFight ? 'Championship' : 'No'],
              ['Notice', `${offer.noticeDays} days`],
              ['Camp available', `${offer.campWeeksAvailable} weeks`],
              ['Travel', `${formatNumber(offer.travelKm)} km`],
              ['Reply by', offer.deadline],
            ]}
          />
          <p className="small dim mt">
            <strong>Why this fight was made:</strong>{' '}
            {offer.bookingKind ? `${bookingKindLabel(offer.bookingKind)}. ` : ''}
            {offer.reason}
          </p>
          <p className="small dim">
            <strong>Ranking implication:</strong> {offer.rankingImplication}
          </p>
          {offer.isReplacementSlot && <p className="small warn">This is a short notice replacement slot.</p>}
        </Panel>

        <Panel title="Money">
          <KeyValues
            rows={[
              ['Show pay', formatMoney(offer.showPay)],
              ['Win bonus', formatMoney(offer.winBonus)],
              [
                'Short notice bonus',
                offer.shortNoticeBonus > 0 ? `${formatMoney(offer.shortNoticeBonus)}, already in the show pay` : 'None',
              ],
              // The short notice bonus is added to the show pay when the purse is built, so adding
              // it again here overstated what a win was worth by the size of the bonus.
              ['Maximum for a win', formatMoney(offer.showPay + offer.winBonus)],
            ]}
          />
          <p className="provenance">
            Simulated game figures. Real fighter pay is not public and is never presented here as reported.
          </p>
        </Panel>

        <Panel title="Scouting report">
          <p className="small">{scout.headline}</p>
          <ul className="small" style={{ paddingLeft: 16 }}>
            {scout.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <table className="mt">
            <tbody>
              {RATING_KEYS.map((k) => (
                <tr key={k}>
                  <td>{RATING_LONG_LABEL[k]}</td>
                  <td className="num">
                    <EstimatedRating estimate={est.ratings[k]} low={est.exact ? undefined : est.low[k]} high={est.exact ? undefined : est.high[k]} />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Ovr</strong>
                </td>
                <td className="num">
                  <EstimatedRating estimate={est.ovr} low={est.exact ? undefined : est.ovrLow} high={est.exact ? undefined : est.ovrHigh} />
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row mt">
            <RealTag fighter={opponent} />
            <span className="small dim">
              Your Ovr {fighter ? ovrDisplayed(fighter.ratings) : '-'} against an estimated <Rating value={est.ovr} />
            </span>
          </div>
          <p className="small faint mt">
            Better scouting narrows the estimate. It never changes the fighter underneath.
          </p>
        </Panel>

        <Panel title="Response">
          {closed ? (
            <p className="dim">This offer is closed. <Link to="/inbox">Back to the inbox</Link>.</p>
          ) : (
            <>
              <div className="row mb">
                <button className="primary" disabled={busy} onClick={() => void respond({ kind: 'accept' })}>
                  Accept
                </button>
                <button disabled={busy} onClick={() => void respond({ kind: 'request-date' })}>Ask for a different date</button>
                <button disabled={busy} onClick={() => void respond({ kind: 'request-opponent' })}>Ask for a different opponent</button>
              </div>
              <div className="row mb">
                <button disabled={busy || offer.scheduledRounds === 5} onClick={() => void respond({ kind: 'request-five-rounds' })}>
                  Ask for five rounds
                </button>
                <button disabled={busy || offer.isTitleFight || offer.isInterimTitleFight} onClick={() => void respond({ kind: 'request-title-fight' })}>
                  Make the case for a title shot
                </button>
                <button disabled={busy} onClick={() => void respond({ kind: 'request-more-time', weeks: 4 })}>Ask for four more weeks</button>
                <button disabled={busy} onClick={() => void respond({ kind: 'request-catchweight', weightLb: offer.contractedWeightLb + 4 })}>
                  Ask for a catchweight
                </button>
                <button disabled={busy} onClick={() => void respond({ kind: 'volunteer-replacement' })}>Volunteer for short notice work</button>
              </div>
              <div className="row mb">
                <input
                  type="number"
                  placeholder="Ask for show pay"
                  value={askAmount ?? ''}
                  onChange={(e) => setAskAmount(e.target.value === '' ? null : Number(e.target.value))}
                  style={{ width: 130 }}
                />
                <button disabled={busy || askAmount === null} onClick={() => askAmount !== null && void respond({ kind: 'request-money', amount: askAmount })}>
                  Ask for more money
                </button>
              </div>
              <p className="small dim">
                Requests are limited. After two the matchmaker pulls the offer.{' '}
                {offer.requestsUsed > 0 ? `${offer.requestsUsed} used.` : ''}
              </p>

              <h3 className="mt">Decline</h3>
              <p className="small dim">
                The consequence depends on the reason. Declining while injured costs nothing. Repeated refusals without a
                reason damage the relationship and eventually put the contract at risk. You have declined{' '}
                {fighter.declinedOffers} offer{fighter.declinedOffers === 1 ? '' : 's'} so far.
              </p>
              <div className="row">
                <button className="danger" disabled={busy} onClick={() => void respond({ kind: 'decline', reason: 'injury' })}>
                  Decline: not healthy
                </button>
                <button className="danger" disabled={busy} onClick={() => void respond({ kind: 'decline', reason: 'short-notice' })}>
                  Decline: too short notice
                </button>
                <button className="danger" disabled={busy} onClick={() => void respond({ kind: 'decline', reason: 'unreasonable' })}>
                  Decline: unreasonable terms
                </button>
                <button className="danger" disabled={busy} onClick={() => void respond({ kind: 'decline', reason: 'no-reason' })}>
                  Decline without a reason
                </button>
              </div>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
