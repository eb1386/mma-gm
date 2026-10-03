import { useRef, useState } from 'react';
import { PageTip } from '../Guide';
import { useNavigate } from 'react-router-dom';
import { Rng } from '@core/rng';
import { formatDate, formatMoney } from '@core/types/common';
import type { ContractTerms } from '@core/types/world';
import {
  computeLeverage,
  CONTRACT_FIGHTS_MAX,
  CONTRACT_FIGHTS_MIN,
  PPV_POINTS_MIN_LEVERAGE,
  respondToCounter,
  signContractOffer,
  SIGNING_BONUS_MIN_LEVERAGE,
  type NegotiationResponse,
} from '@core/world/economy';
import { signCallUpOffer } from '@core/world/regional';
import { PROMOTION_ABBREVIATION, PROMOTION_NAME } from '@core/config/branding';
import { useGame } from '../store';
import { Bar, KeyValues, Notice, Panel } from '../components';

/**
 * A counter field that has been cleared asks for nothing, rather than for zero. `Number('')` is zero,
 * so emptying a field used to send a counter demanding no show money at all.
 */
function askWith(ask: Partial<ContractTerms>, key: keyof ContractTerms, raw: string): Partial<ContractTerms> {
  const next = { ...ask } as Record<string, unknown>;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) delete next[key];
  else next[key] = Math.round(value);
  return next as Partial<ContractTerms>;
}

export function ContractPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const showToast = useGame((s) => s.showToast);
  const navigate = useNavigate();
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const [log, setLog] = useState<{ text: string; tone: 'good' | 'info' | 'bad' }[]>([]);
  const [ask, setAsk] = useState<Partial<ContractTerms>>({});
  // A second click before the page re-renders must not answer the same offer twice.
  const acting = useRef(false);

  if (!fighter) {
    return (
      <div className="page">
        <Notice>This save has no player fighter, so there is no contract to manage.</Notice>
      </div>
    );
  }

  const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
  const offer = Object.values(save.contractOffers).find((o) => o.fighterId === fighter.id && o.status === 'open') ?? null;
  const leverage = computeLeverage(fighter, save);

  const act = (kind: 'accept' | 'reject' | 'counter') => {
    if (!offer || acting.current) return;
    acting.current = true;
    try {
      const response = mutate((s): NegotiationResponse | null => {
        // The offer is read from the save inside the change, and only while it is still open, so a
        // stale page cannot answer an offer that has already been signed or turned down.
        const live = s.contractOffers[offer.id];
        if (!live || live.status !== 'open') return null;
        const rng = new Rng(s.rng);
        const r = respondToCounter(live, kind === 'counter' ? { kind: 'counter', terms: ask } : { kind }, s, rng);
        s.rng = rng.getState();
        if (r.outcome === 'accepted') {
          // One core transaction owns signing, so the screen and the simulation agree. A call up also
          // moves the fighter off the regional circuit and onto the main roster.
          if (live.callUp) signCallUpOffer(s, s.fighters[fighter.id], live, r.round);
          else signContractOffer(s, s.fighters[fighter.id], live, r.round);
        }
        return r;
      });
      if (!response) return;
      // The result is kept and shown outside the offer panel. It used to be written only inside
      // that panel, which unmounts as soon as the offer is accepted or turned down, so signing a
      // deal or a call up gave no confirmation at all.
      const tone = response.outcome === 'accepted' ? 'good' : response.outcome === 'withdrawn' ? 'bad' : 'info';
      const text =
        response.outcome === 'accepted' ? (offer.callUp ? `Signed with ${PROMOTION_ABBREVIATION}.` : 'Terms agreed.') : response.message;
      setLog((l) => [{ text, tone }, ...l]);
      // Every counter field is cleared so the new figures show, rather than the last ask.
      setAsk({});
      if (response.outcome !== 'countered') showToast(text, tone);
      if (response.outcome === 'accepted' && offer.callUp) navigate('/dashboard');
    } finally {
      acting.current = false;
    }
  };

  const signingAvailable = leverage.score > SIGNING_BONUS_MIN_LEVERAGE;
  // The same tests the promotion applies when it sets its budget, so a term shown as unavailable
  // is one the promotion would not have paid.
  const ppvAvailable = save.rankings[fighter.divisionId]?.championId === fighter.id || leverage.score > PPV_POINTS_MIN_LEVERAGE;
  const field = (key: keyof ContractTerms) => (ask[key] as number | undefined) ?? '';

  return (
    <div className="page">
      <div className="page-head">
        <h1>Contract</h1>
        <span className="sub">{fighter.name}</span>
      </div>
      <PageTip id="contract" title="Contracts">
        The promotion opens below what it will pay. Counter for more, but every round tests its patience, and walking away means waiting for the next offer.
      </PageTip>

      <Notice>
        Every contract in this game is a simulated object. Real fighter pay is not public, so nothing here is presented
        as a reported figure.
      </Notice>

      {contract?.status === 'released' && !offer && (
        <Notice kind="bad">
          Released by the promotion. A released fighter is not offered fights, and the promotion looks again at fighters it
          has let go only after most of a year.
        </Notice>
      )}

      <div className="grid c2">
        <Panel title="Current deal">
          {contract ? (
            <>
              <KeyValues
                rows={[
                  ['Status', contract.status],
                  ['Signed', formatDate(contract.signedOn)],
                  ['Fights', `${contract.fightsRemaining} of ${contract.terms.fights} remaining`],
                  ['Show pay', formatMoney(contract.terms.showPay)],
                  ['Win bonus', formatMoney(contract.terms.winBonus)],
                  ['Signing bonus', formatMoney(contract.terms.signingBonus)],
                  ['Main event bonus', formatMoney(contract.terms.mainEventBonus)],
                  ['Champion escalator', formatMoney(contract.terms.championEscalator)],
                  ['Short notice bonus', formatMoney(contract.terms.shortNoticeBonus)],
                  ['Pay per view points', contract.terms.ppvPoints > 0 ? `${formatMoney(contract.terms.ppvPoints)} per thousand buys` : 'None'],
                  ['Guaranteed show money', contract.terms.guaranteedMinimum > 0 ? formatMoney(contract.terms.guaranteedMinimum) : 'None'],
                  ['Performance bonus eligible', contract.terms.performanceBonusEligible ? 'Yes' : 'No'],
                  ['Exclusive', contract.terms.exclusive ? 'Yes' : 'No'],
                  ['Champion clause', contract.championClause ? 'Yes' : 'No'],
                  ['Minimum turnaround', `${contract.minimumTurnaroundDays} days`],
                  ['Injury extension', contract.injuryExtension ? 'Yes' : 'No'],
                ]}
              />
              <p className="provenance">{contract.note}</p>
            </>
          ) : (
            <p className="dim">No active contract.</p>
          )}
        </Panel>

        <Panel title="Leverage">
          <div className="mb">
            <Bar value={leverage.score} />
          </div>
          <p className="small">{leverage.summary}</p>
          <table>
            <tbody>
              {leverage.components
                .slice()
                .sort((a, b) => b.value - a.value)
                .map((c) => (
                  <tr key={c.label}>
                    <td>{c.label}</td>
                    <td className={`num ${c.value > 0 ? 'good' : c.value < 0 ? 'bad' : 'dim'}`}>
                      {c.value > 0 ? '+' : ''}
                      {c.value.toFixed(1)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="small faint mt">
            Ovr is not an input to pay anywhere in this game. Pay follows results, draw and reliability.
          </p>
        </Panel>
      </div>

      {offer && (
        <Panel title={offer.callUp ? `The call up: ${PROMOTION_NAME}` : 'Offer on the table'}>
          {offer.callUp && (
            <Notice kind="good">
              This is the call up. Signing ends the regional deal, vacates any regional title, and moves {fighter.name} to the{' '}
              {PROMOTION_NAME} roster, where the debut is against another newcomer.
            </Notice>
          )}
          <div className="grid c2">
            <KeyValues
              rows={[
                ['Fights', offer.terms.fights],
                ['Show pay', formatMoney(offer.terms.showPay)],
                ['Win bonus', formatMoney(offer.terms.winBonus)],
                ['Signing bonus', formatMoney(offer.terms.signingBonus)],
                ['Pay per view points', offer.terms.ppvPoints > 0 ? `${formatMoney(offer.terms.ppvPoints)} per thousand buys` : 'None'],
                ['Guaranteed show money', offer.terms.guaranteedMinimum > 0 ? formatMoney(offer.terms.guaranteedMinimum) : 'None'],
                ['Reply by', formatDate(offer.deadline)],
                ['Rounds used', offer.roundsUsed],
              ]}
            />
            <div>
              <h3>Counter</h3>
              <div className="field">
                <label>Show pay</label>
                <input type="number" placeholder={String(offer.terms.showPay)} inputMode="numeric" min={0} value={field('showPay')} onChange={(e) => setAsk(askWith(ask, 'showPay', e.target.value))} />
              </div>
              <div className="field">
                <label>Win bonus</label>
                <input type="number" placeholder={String(offer.terms.winBonus)} inputMode="numeric" min={0} value={field('winBonus')} onChange={(e) => setAsk(askWith(ask, 'winBonus', e.target.value))} />
              </div>
              <div className="field">
                <label>Signing bonus</label>
                <input
                  type="number"
                  placeholder={signingAvailable ? String(offer.terms.signingBonus) : 'Not on the table'}
                  inputMode="numeric"
                  min={0}
                  disabled={!signingAvailable}
                  value={field('signingBonus')}
                  onChange={(e) => setAsk(askWith(ask, 'signingBonus', e.target.value))}
                />
              </div>
              <div className="field">
                <label>Pay per view points, dollars per thousand buys</label>
                <input
                  type="number"
                  placeholder={ppvAvailable ? String(offer.terms.ppvPoints) : 'Not on the table'}
                  inputMode="numeric"
                  min={0}
                  disabled={!ppvAvailable}
                  value={field('ppvPoints')}
                  onChange={(e) => setAsk(askWith(ask, 'ppvPoints', e.target.value))}
                />
              </div>
              <div className="field">
                <label>Number of fights</label>
                <input
                  type="number"
                  placeholder={String(offer.terms.fights)}
                  inputMode="numeric"
                  min={CONTRACT_FIGHTS_MIN}
                  max={CONTRACT_FIGHTS_MAX}
                  value={field('fights')}
                  onChange={(e) => setAsk(askWith(ask, 'fights', e.target.value))}
                />
              </div>
              <div className="field">
                <label>Guaranteed show money</label>
                <input type="number" placeholder={String(offer.terms.guaranteedMinimum)} inputMode="numeric" min={0} value={field('guaranteedMinimum')} onChange={(e) => setAsk(askWith(ask, 'guaranteedMinimum', e.target.value))} />
              </div>
              <div className="row">
                <button className="primary" onClick={() => act('accept')}>
                  Accept
                </button>
                <button onClick={() => act('counter')}>Send counter</button>
                <button className="danger" onClick={() => act('reject')}>
                  Reject
                </button>
              </div>
              <p className="small dim mt">
                The promotion holds a private reservation range and has finite patience. Repeated aggressive counters end
                the negotiation. Rejecting turns this offer down, and the promotion comes back with another in about four
                weeks. Guaranteed show money is paid win or lose and counts against the same budget as show pay.
                {!signingAvailable && ' A signing bonus needs more leverage than this.'}
                {!ppvAvailable && ' Pay per view points are for champions and the biggest draws.'}
              </p>
            </div>
          </div>
        </Panel>
      )}

      {log.length > 0 && (
        <Panel title="Negotiation log">
          <div aria-live="polite">
            <Notice kind={log[0].tone}>{log[0].text}</Notice>
          </div>
          {log.length > 1 && (
            <ul className="small" style={{ paddingLeft: 16 }}>
              {log.slice(1).map((l, i) => (
                <li key={i}>{l.text}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {contract && contract.negotiationHistory.length > 0 && (
        <Panel title="Negotiation history" flush>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>By</th>
                <th className="num">Show</th>
                <th className="num">Win</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {contract.negotiationHistory.map((r, i) => (
                <tr key={i}>
                  <td>{formatDate(r.on)}</td>
                  <td>{r.by}</td>
                  <td className="num">{formatMoney(r.terms.showPay)}</td>
                  <td className="num">{formatMoney(r.terms.winBonus)}</td>
                  <td className="small dim">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
