import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatMoney } from '@core/types/common';
import {
  EXPENSE_LABEL,
  INCOME_LABEL,
  ledger,
  managerFor,
  sponsorsFor,
  summarize,
  type ExpenseKind,
  type IncomeKind,
} from '@core/world/finance';
import { KeyValues, Notice, Panel, Tabs } from '../components';
import { useGame } from '../store';

/**
 * Money.
 *
 * Financial systems only. Sponsorship, representation and compliance used to live here and
 * have moved to their own pages: their money still lands in this ledger, but managing them
 * is not a financial task.
 *
 * Every figure is simulated. Real fighter pay is not public and nothing here is presented
 * as reported.
 */
export function MoneyPage() {
  const save = useGame((s) => s.save)!;
  const [tab, setTab] = useState('overview');

  const meId = save.player.fighterId;
  const me = meId ? save.fighters[meId] : null;
  if (!me) {
    return (
      <div className="page">
        <Notice kind="warn">This page is for a fighter career. Coach Mode finances are on the gym page.</Notice>
      </div>
    );
  }

  const finance = summarize(save, me.id);
  const entries = ledger(save)
    .filter((e) => e.fighterId === me.id)
    .slice(-80)
    .reverse();
  const activeSponsors = sponsorsFor(save, me.id).filter((s) => s.status === 'active');
  const manager = managerFor(save, me.id);
  const sponsorIncome = finance.incomeByKind.find((r) => r.kind === 'sponsorship')?.amount ?? 0;
  const commission = finance.expenseByKind.find((r) => r.kind === 'manager-commission')?.amount ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Money</h1>
        <span className="sub">{formatDate(save.date)} · every figure here is simulated</span>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'ledger', label: 'Ledger' },
          { key: 'earnings', label: 'Earnings' },
          { key: 'expenses', label: 'Expenses' },
          { key: 'forecast', label: 'Forecast' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <p className="small dim">
        Sponsorship is managed on <Link to="/sponsors">Sponsors</Link>, representation on{' '}
        <Link to="/management">Management</Link>, and anti-doping on <Link to="/compliance">Compliance</Link>. Money
        from all of them still appears here.
      </p>

      {tab === 'overview' && (
        <div className="grid c2">
          <Panel title="Where you stand">
            <KeyValues
              rows={[
                ['Cash', formatMoney(finance.cash)],
                ['Career earnings', formatMoney(finance.careerEarnings)],
                ['Career expenses', formatMoney(finance.careerExpenses)],
                ['Net worth estimate', formatMoney(finance.netWorthEstimate)],
                ['Debt', finance.debt > 0 ? formatMoney(finance.debt) : 'None'],
                ['Monthly outgoings', formatMoney(finance.monthlyExpenses)],
                ['Runway', `${finance.runwayMonths} months`],
                ['Financial pressure', finance.pressure],
                ['Retirement security', finance.retirementSecurity],
              ]}
            />
            {finance.pressure === 'in trouble' && (
              <Notice kind="bad">You are spending more than you bring in. Another fight or a sponsor would help.</Notice>
            )}
          </Panel>

          <Panel title="What is coming in">
            <KeyValues
              rows={[
                ['Active sponsors', activeSponsors.length === 0 ? 'None' : `${activeSponsors.length}`],
                ['Sponsor income to date', formatMoney(sponsorIncome)],
                ['Manager', manager ? `${manager.name} at ${manager.commissionPct} percent` : 'Unrepresented'],
                ['Commission paid to date', formatMoney(commission)],
                ['Last purse', me.lastPurse ? formatMoney(me.lastPurse) : 'No fight yet'],
              ]}
            />
            <p className="small faint mt">
              The ledger is the record. Cash, career earnings and net worth are all derived from it, so they cannot
              drift apart from what actually happened.
            </p>
          </Panel>
        </div>
      )}

      {(tab === 'earnings' || tab === 'expenses') && (
        <Panel title={tab === 'earnings' ? 'Where the money comes from' : 'Where the money goes'}>
          {(tab === 'earnings' ? finance.incomeByKind : finance.expenseByKind).length === 0 ? (
            <p className="dim">Nothing recorded yet. The first purse will start the ledger.</p>
          ) : (
            <table>
              <tbody>
                {(tab === 'earnings' ? finance.incomeByKind : finance.expenseByKind).map((row) => (
                  <tr key={row.kind}>
                    <td>
                      {tab === 'earnings'
                        ? INCOME_LABEL[row.kind as IncomeKind]
                        : EXPENSE_LABEL[row.kind as ExpenseKind]}
                    </td>
                    <td className="num">{formatMoney(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {tab === 'forecast' && (
        <Panel title="Forecast">
          <KeyValues
            rows={[
              ['Monthly outgoings', formatMoney(finance.monthlyExpenses)],
              ['Cash now', formatMoney(finance.cash)],
              ['Months covered', `${finance.runwayMonths}`],
              ['Pressure', finance.pressure],
              ['Retirement security', finance.retirementSecurity],
            ]}
          />
          <p className="small dim mt">
            The forecast assumes no further fight income. A booked fight changes it substantially, which is the point:
            a fighter who is not fighting is spending.
          </p>
        </Panel>
      )}

      {tab === 'ledger' && (
        <Panel title="Recent movements">
          {entries.length === 0 ? (
            <p className="dim">Nothing recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Note</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap dim small">{formatDate(e.date)}</td>
                    <td>
                      {e.direction === 'in'
                        ? INCOME_LABEL[e.kind as IncomeKind]
                        : EXPENSE_LABEL[e.kind as ExpenseKind]}
                    </td>
                    <td className="small">{e.note}</td>
                    <td className={`num ${e.direction === 'in' ? 'good' : 'bad'}`}>
                      {e.direction === 'in' ? '+' : '-'}
                      {formatMoney(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </div>
  );
}
