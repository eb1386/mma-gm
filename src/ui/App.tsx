import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { DIVISIONS } from '@core/config/divisions';
import { formatDate } from '@core/types/common';
import { lastPlayedSaveId, loadGame } from '@core/save/store';
import { actionableMessages } from '@core/world/inbox';
import { OctagonMark } from './components';
import { DISCLAIMER, GAME_NAME } from '@core/config/branding';
import { useGame } from './store';
import { AdvanceBar } from './AdvanceBar';
import { NewGamePage } from './pages/NewGame';

import { DashboardPage } from './pages/Dashboard';
import { InboxPage } from './pages/Inbox';
import { CalendarPage } from './pages/Calendar';
import { FighterPage } from './pages/FighterPage';
import { RosterPage } from './pages/Roster';
import { DivisionPage } from './pages/Division';
import { RankingsPage } from './pages/Rankings';
import { RivalriesPage } from './pages/Rivalries';
import { OfficialsPage } from './pages/Officials';
import { EventPage } from './pages/EventPage';
import { FightPage } from './pages/FightPage';
import { FightWeekPage } from './pages/FightWeek';
import { MoneyPage } from './pages/Money';
import { LandingPage } from './pages/Landing';
import { PrivacyPage } from './pages/Privacy';
import { CareerPage, CompliancePage, ManagementPage, SponsorsPage } from './pages/CareerPages';
import { CampPage } from './pages/Camp';
import { ContractPage } from './pages/Contract';
import { OfferPage } from './pages/Offer';
import { CoachPage } from './pages/Coach';
import { HistoryPage } from './pages/History';
import { RecordsPage } from './pages/Records';
import { LeadersPage } from './pages/Leaders';
import { GymPage, GymsPage } from './pages/Gyms';
import { DataPage, HallOfFamePage, HelpPage, LoadGamePage, NewsPage, SettingsPage } from './pages/Misc';

/**
 * The left navigation.
 *
 * Below the narrow breakpoint it is hidden until the menu button opens it, because the
 * sidebar was previously display:none there with nothing to replace it, which left a phone
 * with no way to reach any page at all.
 */
function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const save = useGame((s) => s.save);
  const navigate = useNavigate();
  const unread = save ? actionableMessages(save).length : 0;
  const sponsorOffers = save
    ? Object.values(save.sponsors ?? {}).filter((s) => s.status === 'offered' && s.id.includes(save.player.fighterId ?? 'none')).length
    : 0;
  // Fight week only appears in the sidebar once there is a bout to be in fight week for.
  const me = save?.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const liveBout = me?.nextBoutId ? save?.bouts[me.nextBoutId] : null;
  const nextBoutId = liveBout && liveBout.status === 'scheduled' ? liveBout.id : null;
  if (!save) return null;

  const link = (to: string, label: string, badge?: number) => (
    <NavLink key={to} to={to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      <span>{label}</span>
      {badge ? <span className="badge-count">{badge}</span> : null}
    </NavLink>
  );

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} onClick={onNavigate}>
      {/* The whole brand area is one control that opens the landing screen. */}
      <button className="sidebar-brand" onClick={() => navigate('/home')} title="Careers and world list">
        <OctagonMark />
        <span className="brand-text">
          <span className="brand-name">{GAME_NAME}</span>
          <span className="brand-sub">{save.saveName}</span>
        </span>
      </button>
      <div className="nav-group">Career</div>
      {link('/dashboard', 'Dashboard')}
      {link('/inbox', 'Inbox', unread)}
      {save.player.fighterId && link(`/fighter/${save.player.fighterId}`, 'My fighter')}
      {save.player.fighterId && link('/camp', 'Training camp')}
      {save.player.fighterId && link('/contract', 'Contract')}
      {save.player.fighterId && link('/career', 'Career')}
      {save.player.fighterId && link('/money', 'Money')}
      {save.player.fighterId && link('/sponsors', 'Sponsors', sponsorOffers)}
      {save.player.fighterId && link('/management', 'Management')}
      {save.player.fighterId && link('/compliance', 'Compliance')}
      {save.player.fighterId && link('/rivalries', 'Rivalries')}
      {save.player.fighterId && nextBoutId && link(`/fightweek/${nextBoutId}`, 'Fight week')}
      {save.player.gymId && link('/coach', 'Gym management')}
      <div className="nav-group">World</div>
      {link('/calendar', 'Calendar')}
      {link('/rankings', 'Rankings')}
      {link('/roster', 'Roster')}
      {link('/gyms', 'Gyms')}
      {link('/news', 'News')}
      {link('/officials', 'Officials')}
      <div className="nav-group">Divisions</div>
      {DIVISIONS.map((d) => link(`/division/${d.id}`, d.shortName))}
      <div className="nav-group">History</div>
      {link('/history', 'Title history')}
      {link('/records', 'Records')}
      {link('/leaders', 'Leaders')}
      {link('/hall-of-fame', 'Hall of Fame')}
      <div className="nav-group">Game</div>
      {link('/data', 'Data and sources')}
      {link('/settings', 'Settings')}
      {link('/help', 'Help')}
      {link('/load', 'Saves')}
    </nav>
  );
}

function TopBar() {
  const save = useGame((s) => s.save);
  const toast = useGame((s) => s.toast);
  const navigate = useNavigate();
  if (!save) return null;

  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  const modeLabel = save.player.mode === 'fighter' ? 'Fighter career' : save.player.mode === 'coach' ? 'Coach mode' : 'Spectator';

  return (
    <>
      <div className="topbar">
        <div className="identity">
          <span className="name">{fighter ? fighter.name : gym ? gym.name : save.saveName}</span>
          <span className="sub">
            {modeLabel} · {formatDate(save.date)}
          </span>
        </div>
        <AdvanceBar />
        <span className="spacer" />
        <input
          type="search"
          placeholder="Search fighters"
          style={{ width: 160 }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
            if (!q) return;
            const hit = Object.values(save.fighters).find((f) => f.name.toLowerCase().includes(q));
            if (hit) navigate(`/fighter/${hit.id}`);
            else navigate(`/roster?q=${encodeURIComponent(q)}`);
          }}
        />
      </div>
      {toast && (
        <div className={`notice${toast.kind === 'good' ? ' good' : toast.kind === 'bad' ? ' bad' : ''}`} style={{ margin: '8px 12px 0' }}>
          {toast.text}
        </div>
      )}
      <OperationPanel />
    </>
  );
}

/**
 * Shows what the current operation is doing and what the last one did.
 *
 * A primary action must never appear to succeed while nothing changed, so a no-op is
 * reported with its reason and a failure is reported with the actual error and a way back.
 */
function OperationPanel() {
  const operation = useGame((s) => s.operation);
  const result = useGame((s) => s.lastResult);
  const clearOperation = useGame((s) => s.clearOperation);
  const navigate = useNavigate();

  if (operation && operation.phase !== 'complete' && operation.phase !== 'failed') {
    return (
      <div className="operation-panel" role="status" aria-live="polite">
        <strong>{operation.label}</strong>
        <span className="sub">{operation.detail}</span>
        {operation.progress !== null && (
          <div className="op-bar">
            <div style={{ width: `${Math.round(operation.progress * 100)}%` }} />
          </div>
        )}
      </div>
    );
  }

  if (operation?.phase === 'failed') {
    return (
      <div className="notice bad operation-panel error" role="alert">
        <strong>{operation.label} failed</strong>
        <div>{operation.detail}</div>
        <div className="row tight" style={{ marginTop: 6 }}>
          <button onClick={clearOperation}>Dismiss</button>
          <button onClick={() => { clearOperation(); navigate('/dashboard'); }}>Back to dashboard</button>
        </div>
      </div>
    );
  }

  if (result?.noOpReason) {
    return (
      <div className="notice operation-panel" role="status">
        <strong>{result.noOpReason}</strong>
        {result.navigateTo && (
          <button style={{ marginLeft: 8 }} onClick={() => navigate(result.navigateTo!)}>
            Go there
          </button>
        )}
      </div>
    );
  }

  return null;
}

function Shell() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="app">
      <button
        className="nav-toggle"
        aria-expanded={navOpen}
        aria-label={navOpen ? 'Close the menu' : 'Open the menu'}
        onClick={() => setNavOpen((v) => !v)}
      >
        Menu
      </button>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className="main">
        <TopBar />
        <Routes>
          <Route path="/home" element={<LandingPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/:messageId" element={<InboxPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/rankings" element={<RankingsPage />} />
          <Route path="/rivalries" element={<RivalriesPage />} />
          <Route path="/officials" element={<OfficialsPage />} />
          <Route path="/roster" element={<RosterPage />} />
          <Route path="/gyms" element={<GymsPage />} />
          <Route path="/gym/:gymId" element={<GymPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="/division/:divisionId" element={<DivisionPage />} />
          <Route path="/fighter/:fighterId" element={<FighterPage />} />
          <Route path="/event/:eventId" element={<EventPage />} />
          <Route path="/fight/:boutId" element={<FightPage />} />
          <Route path="/fightweek/:boutId" element={<FightWeekPage />} />
          <Route path="/camp" element={<CampPage />} />
          <Route path="/contract" element={<ContractPage />} />
          <Route path="/money" element={<MoneyPage />} />
          <Route path="/sponsors" element={<SponsorsPage />} />
          <Route path="/management" element={<ManagementPage />} />
          <Route path="/compliance" element={<CompliancePage />} />
          <Route path="/career" element={<CareerPage />} />
          <Route path="/offer/:offerId" element={<OfferPage />} />
          <Route path="/coach" element={<CoachPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/leaders" element={<LeadersPage />} />
          <Route path="/hall-of-fame" element={<HallOfFamePage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/load" element={<LoadGamePage />} />
          <Route path="/new" element={<NewGamePage />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        <footer className="app-footer">
          <p>
            {DISCLAIMER}
          </p>
          <p className="small">
            Real factual data comes from documented sources with per field provenance. Values the source does not
            publish are derived or simulated and are labelled as such. Every financial figure in the game is simulated.
            Ratings are game model values, not measurements of a real person.{' '}
            <NavLink to="/data">Data and sources</NavLink> · <NavLink to="/privacy">Privacy</NavLink>
          </p>
        </footer>
      </div>
    </div>
  );
}

/** Privacy outside a career, so the page is reachable and shareable without a save. */
function StandalonePrivacy() {
  return (
    <div className="main">
      <PrivacyPage />
      <footer className="app-footer">
        <p>{DISCLAIMER}</p>
      </footer>
    </div>
  );
}

export function App() {
  const save = useGame((s) => s.save);
  const setSave = useGame((s) => s.setSave);
  const [checked, setChecked] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await lastPlayedSaveId();
      if (id && !cancelled) {
        try {
          const loaded = await loadGame(id);
          if (loaded && !cancelled) setSave(loaded);
        } catch {
          // A save that cannot be migrated should not block the app from starting.
        }
      }
      if (!cancelled) setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [setSave]);

  if (!checked) {
    return (
      <div className="splash">
        <p className="dim">Loading.</p>
      </div>
    );
  }

  if (!save) {
    // The landing screen, privacy and help all live outside a career and must load without
    // one. A first time visitor arriving at the root sees the landing screen, not a forced
    // world creation.
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/home" element={<LandingPage />} />
        <Route path="/privacy" element={<StandalonePrivacy />} />
        <Route path="/new" element={<NewGamePage />} />
        <Route path="/load" element={<LoadGamePage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to={location.pathname === '/load' ? '/load' : '/home'} replace />} />
      </Routes>
    );
  }

  return <Shell />;
}
