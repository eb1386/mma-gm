import { useState } from 'react';
import { Rng } from '@core/rng';
import { formatDate, formatMoney } from '@core/types/common';
import type { ContractTerms } from '@core/types/world';
import { computeLeverage, respondToCounter } from '@core/world/economy';
import { PROMOTION_NAME } from '@core/config/branding';
import { useGame } from '../store';
import { Bar, KeyValues, Notice, Panel } from '../components';

export function ContractPage() {
  const save = useGame((s) => s.save)!;
  const mutate = useGame((s) => s.mutate);
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const [log, setLog] = useState<string[]>([]);
  const [ask, setAsk] = useState<Partial<ContractTerms>>({});

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

  const act = (kind: 'accept' | 'reject' | 'walk-away' | 'counter') => {
    if (!offer) return;
    mutate((s) => {
      const rng = new Rng(s.rng);
      const response = respondToCounter(offer, kind === 'counter' ? { kind: 'counter', terms: ask } : { kind }, s, rng);
      s.rng = rng.getState();
      setLog((l) => [response.message, ...l]);
      if (response.outcome === 'accepted') {
        const c = s.contracts[fighter.contractId ?? ''] ?? null;
        const next = {
          id: `contract-${fighter.id}-${s.date}`,
          fighterId: fighter.id,
          promotion: PROMOTION_NAME,
          startDate: s.date,
          endCondition: 'fights-exhausted' as const,
          endDate: null,
          terms: { ...offer.terms },
          fightsRemaining: offer.terms.fights,
          status: 'active' as const,
          isSimulated: true,
          minimumTurnaroundDays: 42,
          injuryExtension: true,
          championClause: fighter.isChampion,
          weightClassClause: fighter.divisionId,
          negotiationHistory: [...(c?.negotiationHistory ?? []), response.round],
          signedOn: s.date,
          note: 'Simulated game contract agreed through negotiation. Real fighter contract terms are not public.',
        };
        s.contracts[next.id] = next;
        s.fighters[fighter.id].contractId = next.id;
        if (offer.terms.signingBonus > 0) {
          s.fighters[fighter.id].careerEarnings += offer.terms.signingBonus;
          s.player.balance += offer.terms.signingBonus;
        }
      }
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Contract</h1>
        <span className="sub">{fighter.name}</span>
      </div>

      <Notice>
        Every contract in this game is a simulated object. Real fighter pay is not public, so nothing here is presented
        as a reported figure.
      </Notice>

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
                  ['Guaranteed minimum', contract.terms.guaranteedMinimum > 0 ? formatMoney(contract.terms.guaranteedMinimum) : 'None'],
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
        <Panel title="Offer on the table">
          <div className="grid c2">
            <KeyValues
              rows={[
                ['Fights', offer.terms.fights],
                ['Show pay', formatMoney(offer.terms.showPay)],
                ['Win bonus', formatMoney(offer.terms.winBonus)],
                ['Signing bonus', formatMoney(offer.terms.signingBonus)],
                ['Pay per view points', offer.terms.ppvPoints > 0 ? formatMoney(offer.terms.ppvPoints) : 'None'],
                ['Guaranteed minimum', offer.terms.guaranteedMinimum > 0 ? formatMoney(offer.terms.guaranteedMinimum) : 'None'],
                ['Reply by', offer.deadline],
                ['Rounds used', offer.roundsUsed],
              ]}
            />
            <div>
              <h3>Counter</h3>
              <div className="field">
                <label>Show pay</label>
                <input type="number" placeholder={String(offer.terms.showPay)} onChange={(e) => setAsk({ ...ask, showPay: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Win bonus</label>
                <input type="number" placeholder={String(offer.terms.winBonus)} onChange={(e) => setAsk({ ...ask, winBonus: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Signing bonus</label>
                <input type="number" placeholder="0" onChange={(e) => setAsk({ ...ask, signingBonus: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Pay per view points</label>
                <input type="number" placeholder="0" onChange={(e) => setAsk({ ...ask, ppvPoints: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Number of fights</label>
                <input type="number" placeholder={String(offer.terms.fights)} onChange={(e) => setAsk({ ...ask, fights: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Guaranteed minimum</label>
                <input type="number" placeholder="0" onChange={(e) => setAsk({ ...ask, guaranteedMinimum: Number(e.target.value) })} />
              </div>
              <div className="row">
                <button className="primary" onClick={() => act('accept')}>
                  Accept
                </button>
                <button onClick={() => act('counter')}>Send counter</button>
                <button className="danger" onClick={() => act('reject')}>
                  Reject
                </button>
                <button className="danger" onClick={() => act('walk-away')}>
                  Walk away
                </button>
              </div>
              <p className="small dim mt">
                The promotion holds a private reservation range and has finite patience. Repeated aggressive counters end
                the negotiation.
              </p>
            </div>
          </div>
          {log.length > 0 && (
            <div className="mt">
              <h3>Negotiation log</h3>
              <ul className="small" style={{ paddingLeft: 16 }}>
                {log.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
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
                  <td>{r.on}</td>
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
