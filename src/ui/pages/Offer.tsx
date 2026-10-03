import { useState } from 'react';
import { PageTip } from '../Guide';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rng } from '@core/rng';
import { DIVISION_BY_ID } from '@core/config/divisions';
import { formatDate, formatMoney, formatNumber } from '@core/types/common';
import { ovrDisplayed, RATING_LONG_LABEL, RATING_KEYS } from '@core/types/fighter';
import { estimateRatings, scoutingReport } from '@core/world/scouting';
import { onShortNoticeList, respondToOffer, type OfferResponse, type OfferTone } from '@core/world/offers';
import { BOOKING_KIND_LABEL, type BookingKind } from '@core/world/matchmaking';
import { MATCHUP_SOURCE_LABEL, type MatchupSource } from '@core/world/matchup-interest';
import { activeInjuries, canCompete } from '@core/world/health';
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

/** A stored reason fragment ('a home market showcase') as a sentence on its own. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/** Fight offer review. Every response and its consequence is stated in plain language. */
export function OfferPage() {
  const save = useGame((s) => s.save)!;
  const runOperation = useGame((s) => s.runOperation);
  const busy = useGame((s) => s.busy);
  const showToast = useGame((s) => s.showToast);
  const { offerId } = useParams();
  const navigate = useNavigate();
  const [message, setMessage] = useState<{ text: string; tone: OfferTone } | null>(null);
  const [askAmount, setAskAmount] = useState<number | null>(null);

  const offer = offerId ? save.fightOffers[offerId] : null;
  if (!offer) return <div className="page"><Notice kind="bad">That offer no longer exists.</Notice></div>;

  const fighter = save.fighters[offer.fighterId];
  const opponent = save.fighters[offer.opponentId];
  const est = estimateRatings(save, opponent);
  const scout = scoutingReport(save, opponent);
  const health = canCompete(fighter, save.date);
  // A medical decline is free only with something on the medical record behind it.
  const noInjury = health.ok && activeInjuries(fighter, save.date).length === 0;
  const tryout = offer.bookingKind === 'tryout';
  const regional = Boolean(save.events[offer.eventId]?.promotionId) || Boolean(fighter.circuit);
  const volunteered = onShortNoticeList(fighter, save.date);
  const lastRequest = offer.requestsUsed >= 2;
  const division = DIVISION_BY_ID[offer.divisionId];

  // Answering an offer goes through the operation controller so the buttons disable, the
  // result is visible, and a double click cannot apply the answer twice.
  const respond = async (response: OfferResponse) => {
    if (busy) return;
    // The third request ends the negotiation, so it is never sent by accident.
    if (response.kind.startsWith('request') && lastRequest) {
      if (!window.confirm('A third request ends the negotiation and the matchmaker pulls the offer. Send it anyway?')) return;
    }
    let tone: OfferTone = 'info';
    const result = await runOperation('other', 'Answering the offer', (report) => {
      report('updating-world', 'Sending your answer to the matchmaker');
      // Only an answer to an offer that had already closed changed nothing. This used to be read
      // from the reply text, which broke whenever a message was reworded.
      const wasOpen = save.fightOffers[offer.id]?.status === 'open';
      const rng = new Rng(save.rng);
      const r = respondToOffer(save, offer.id, response, rng);
      save.rng = rng.getState();
      tone = r.tone;
      return {
        ok: true,
        noOpReason: wasOpen ? null : r.message,
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
    const shown: OfferTone = result.error ? 'bad' : tone;
    // The reply is shown next to the buttons that sent it. A toast is only needed when the page is
    // left behind, and it carries the same tone, so a refusal never shows as a success.
    setMessage({ text, tone: shown });
    if (result.navigateTo) {
      showToast(text, shown);
      navigate(result.navigateTo);
    }
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
      <PageTip id="offer" title="Your first fight offer">
        Check the opponent, the date and the camp time you would get. You can ask for more money, a different date or a different opponent, but the matchmaker's patience runs out after two requests. Declining with a real reason costs little; refusing again and again costs the relationship.
      </PageTip>

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
              ['Title', offer.isInterimTitleFight ? 'Interim championship' : offer.isTitleFight ? 'Championship' : offer.regionalTitle ? 'Regional championship' : 'No'],
              ['Notice', `${offer.noticeDays} days`],
              ['Camp available', `${offer.campWeeksAvailable} weeks`],
              ['Travel', `${formatNumber(offer.travelKm)} km`],
              ['Reply by', formatDate(offer.deadline)],
            ]}
          />
          <p className="small dim mt">
            <strong>Why this fight was made:</strong>{' '}
            {offer.bookingKind ? `${bookingKindLabel(offer.bookingKind)}. ` : ''}
            {sentence(offer.reason)}
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
          <div aria-live="polite">{message && <Notice kind={message.tone}>{message.text}</Notice>}</div>
          {closed ? (
            <p className="dim">This offer is closed. <Link to="/inbox">Back to the inbox</Link>.</p>
          ) : (
            <>
              <div className="row mb">
                <button className="primary" disabled={busy} onClick={() => void respond({ kind: 'accept' })}>
                  Accept
                </button>
                <button className={lastRequest ? 'danger' : ''} disabled={busy} onClick={() => void respond({ kind: 'request-date' })}>Ask for a different date</button>
                <button className={lastRequest ? 'danger' : ''} disabled={busy} onClick={() => void respond({ kind: 'request-opponent' })}>Ask for a different opponent</button>
              </div>
              <div className="row mb">
                <button
                  className={lastRequest ? 'danger' : ''}
                  disabled={busy || offer.scheduledRounds === 5 || tryout}
                  title={tryout ? 'Tryouts are three rounds.' : undefined}
                  onClick={() => void respond({ kind: 'request-five-rounds' })}
                >
                  Ask for five rounds
                </button>
                <button
                  className={lastRequest ? 'danger' : ''}
                  disabled={busy || offer.isTitleFight || offer.isInterimTitleFight || offer.bookingKind === 'regional' || tryout || regional}
                  title={regional ? 'Regional belts go to the top of the regional rankings.' : undefined}
                  onClick={() => void respond({ kind: 'request-title-fight' })}
                >
                  Make the case for a title shot
                </button>
                <button className={lastRequest ? 'danger' : ''} disabled={busy} onClick={() => void respond({ kind: 'request-more-time', weeks: 4 })}>Ask for four more weeks</button>
                <button
                  className={lastRequest ? 'danger' : ''}
                  disabled={busy || offer.isTitleFight || offer.isInterimTitleFight || offer.isCatchweight}
                  onClick={() => void respond({ kind: 'request-catchweight', weightLb: offer.contractedWeightLb + 4 })}
                >
                  Ask for a catchweight
                </button>
                <button disabled={busy || volunteered} onClick={() => void respond({ kind: 'volunteer-replacement' })}>
                  {volunteered ? 'On the short notice list' : 'Volunteer for short notice work'}
                </button>
              </div>
              <div className="row mb">
                <input
                  type="number"
                  placeholder="Ask for show pay"
                  value={askAmount ?? ''}
                  disabled={offer.moneyGranted}
                  onChange={(e) => setAskAmount(e.target.value === '' ? null : Number(e.target.value))}
                  style={{ width: 130 }}
                />
                <button
                  className={lastRequest ? 'danger' : ''}
                  disabled={busy || askAmount === null || offer.moneyGranted}
                  onClick={() => askAmount !== null && void respond({ kind: 'request-money', amount: askAmount })}
                >
                  {offer.moneyGranted ? 'Purse already raised' : 'Ask for more money'}
                </button>
              </div>
              <p className={`small ${lastRequest ? 'warn' : 'dim'}`}>
                {offer.requestsUsed} of 2 requests used. A third request ends the negotiation. Volunteering for short notice
                work does not use a request.
              </p>

              <h3 className="mt">Decline</h3>
              <p className="small dim">
                The consequence depends on the reason. Declining while injured costs nothing, and the medical team
                checks: a medical decline needs an injury on record. Repeated refusals without a
                reason damage the relationship and eventually put the contract at risk. You have declined{' '}
                {fighter.declinedOffers} offer{fighter.declinedOffers === 1 ? '' : 's'} so far.
              </p>
              <div className="row">
                <button
                  className="danger"
                  disabled={busy || noInjury}
                  title={noInjury ? 'No injury on record' : undefined}
                  onClick={() => void respond({ kind: 'decline', reason: 'injury' })}
                >
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
