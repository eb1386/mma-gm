import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { WelcomeSheet } from './Guide';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import { DIVISIONS } from '@core/config/divisions';
import { formatDate } from '@core/types/common';
import { lastPlayedSaveId, loadGame } from '@core/save/store';
import { actionableMessages } from '@core/world/inbox';
import { ErrorBoundary, OctagonMark } from './components';
import { foldName, nameMatches } from './search';
import { exportSave } from './native';
import { DISCLAIMER, GAME_NAME } from '@core/config/branding';
import { useGame } from './store';
import { AdvanceBar } from './AdvanceBar';
import { ActionDock, MobileHeader, MobileTabBar } from './MobileShell';
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
import { RegionalPage } from './pages/Regional';
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
    ? Object.values(save.sponsors ?? {}).filter((s) => s.status === 'offered' && s.id.startsWith(`sponsor-${save.player.fighterId ?? 'none'}-`)).length
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
    <nav
      id="app-menu"
      className={`sidebar${open ? ' open' : ''}`}
      onClick={onNavigate}
      // Only the phone opens the menu over the page, so only then is it a modal dialog. The desktop
      // sidebar is a plain column and never has `open` set.
      {...(open ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Menu' } : {})}
    >
      {/* The whole brand area is one control that opens the landing screen. */}
      <button className="sidebar-brand" onClick={() => navigate('/home')} title="Careers and world list">
        <OctagonMark />
        <span className="brand-text">
          <span className="brand-name">{GAME_NAME}</span>
          <span className="brand-sub">{save.saveName}</span>
        </span>
      </button>
      <div className="m-only m-menu-search">
        <FighterSearch onDone={onNavigate} />
      </div>
      <div className="nav-group">Career</div>
      {link('/dashboard', 'Dashboard')}
      {link('/inbox', 'Inbox', unread)}
      {save.player.fighterId && link(`/fighter/${save.player.fighterId}`, 'My fighter')}
      {save.player.fighterId && link('/camp', 'Training camp')}
      {save.player.fighterId && link('/contract', 'Contract')}
      {save.player.fighterId && save.regional && link('/regional', save.fighters[save.player.fighterId]?.circuit ? 'Regional circuit' : 'Regional history')}
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

/**
 * The fighter page, remounted per fighter.
 *
 * React Router reuses the element when only the :fighterId param changes, so the open tab and the
 * social posting log of one fighter carried over to the next: clicking an opponent in Fight history
 * opened their page on Fight history, and one fighter's posts showed on another's Identity tab.
 */
function FighterRoute() {
  const { fighterId } = useParams();
  return <FighterPage key={fighterId} />;
}

/** Fighter search. In the header on a wide screen, at the top of the menu on a phone. */
function FighterSearch({ onDone, className }: { onDone?: () => void; className?: string }) {
  const save = useGame((s) => s.save);
  const navigate = useNavigate();
  if (!save) return null;
  return (
    <input
      type="search"
      className={className}
      placeholder="Search fighters"
      enterKeyHint="search"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const input = e.target as HTMLInputElement;
        const q = input.value.trim();
        if (!q) return;
        // Jumping to the first substring hit sent 'jon' to whichever Jon came first in the save, not
        // Jon Jones. Only an exact name, or a query that matches one fighter alone, goes straight to a
        // fighter page. Anything ambiguous lands on the roster filtered by the query, so the player picks.
        const hits = Object.values(save.fighters).filter((f) => nameMatches(f.name, q));
        const folded = foldName(q);
        const exact = hits.filter((f) => foldName(f.name) === folded);
        // Two fighters can share a name across eras; the active one is almost always the one meant.
        const target = exact.find((f) => !f.retired) ?? exact[0] ?? (hits.length === 1 ? hits[0] : undefined);
        if (target) navigate(`/fighter/${target.id}`);
        else navigate(`/roster?q=${encodeURIComponent(q)}`);
        input.value = '';
        input.blur();
        onDone?.();
      }}
    />
  );
}

function TopBar() {
  const save = useGame((s) => s.save);
  if (!save) return null;

  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  const modeLabel = save.player.mode === 'fighter' ? 'Fighter career' : save.player.mode === 'coach' ? 'Coach mode' : 'Spectator';

  return (
    <div className="topbar">
      <div className="identity">
        <span className="name">{fighter ? fighter.name : gym ? gym.name : save.saveName}</span>
        <span className="sub">
          {modeLabel} · {formatDate(save.date)}
        </span>
      </div>
      <AdvanceBar />
      <span className="spacer" />
      <FighterSearch className="topbar-search" />
    </div>
  );
}

/**
 * Toasts and the operation panel, in one fixed layer.
 *
 * They used to sit in the page flow under the header bar. On a phone the header bar is hidden and
 * on any page the player has scrolled the top of the document is off screen, so the answer to a
 * tap near the bottom ("Saved.", "Approved as a five round bout.", a failure) was drawn where
 * nobody could see it. Without a career there was no header bar at all, so the landing screen's
 * toasts were never drawn. This renders once per tree, in the career shell and outside it.
 */
function Notifications() {
  const toast = useGame((s) => s.toast);
  const dismissToast = useGame((s) => s.dismissToast);
  const saveError = useGame((s) => s.saveError);
  return (
    <div className="notify-layer">
      {/* Stays until a write succeeds. A toast alone was gone in four seconds, and the player
          played on believing the career was being kept. */}
      {saveError && (
        <div className="notice bad save-error-chip" role="alert">
          Not saved: {saveError}{' '}
          <Link to="/settings">Export your career</Link>
        </div>
      )}
      {toast && (
        <div
          key={toast.id}
          className={`notice toast${toast.kind === 'good' ? ' good' : toast.kind === 'bad' ? ' bad' : ''}`}
          role="status"
          title="Tap to dismiss"
          onClick={() => dismissToast(toast.id)}
        >
          {toast.text}
        </div>
      )}
      <OperationPanel />
    </div>
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
  const clearResult = useGame((s) => s.clearResult);
  const busy = useGame((s) => s.busy);
  const cancelRequested = useGame((s) => s.cancelRequested);
  const requestCancel = useGame((s) => s.requestCancel);
  const navigate = useNavigate();

  if (operation?.phase === 'canceled') {
    return (
      <div className="notice operation-panel" role="status">
        <strong>{operation.label} stopped</strong>
        <span className="sub">{operation.detail}</span>
      </div>
    );
  }

  if (operation && operation.phase !== 'complete' && operation.phase !== 'failed') {
    // Only the advances can stop part way. A fight or an answer runs in one piece and is over
    // before a tap could land, so offering to cancel it would be a button that does nothing.
    const cancellable = busy && operation.kind.startsWith('advance');
    return (
      <div className="operation-panel" role="status" aria-live="polite">
        <strong>{operation.label}</strong>
        <span className="sub">{cancelRequested ? 'Stopping after this day.' : operation.detail}</span>
        {operation.progress !== null && (
          <div className="op-bar">
            <div style={{ width: `${Math.round(operation.progress * 100)}%` }} />
          </div>
        )}
        {cancellable && (
          <button className="op-cancel" disabled={cancelRequested} onClick={requestCancel}>
            {cancelRequested ? 'Stopping' : 'Cancel'}
          </button>
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
        <div className="row tight" style={{ marginTop: 6 }}>
          {result.navigateTo && (
            <button
              onClick={() => {
                const to = result.navigateTo!;
                clearResult();
                navigate(to);
              }}
            >
              Go there
            </button>
          )}
          <button onClick={clearResult}>Dismiss</button>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Puts a newly opened page at its top.
 *
 * The window is the scroll container, so its position carried over from one route to the next:
 * starting a career opened the dashboard at its footer, and a tab tapped from the bottom of the
 * calendar opened the fighter page 2300px down. Going back (a POP) keeps the browser's own
 * restoration. It runs on the path only, so a tab or a filter inside one page does not jump.
 */
function ScrollToTop({ onRouteChange }: { onRouteChange?: () => void }) {
  const { pathname } = useLocation();
  const navType = useNavigationType();
  const changeRef = useRef(onRouteChange);
  changeRef.current = onRouteChange;
  useLayoutEffect(() => {
    if (navType !== 'POP') window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    changeRef.current?.();
  }, [pathname]);
  return null;
}

/**
 * What a page shows instead of a blank screen when it throws while rendering.
 *
 * The chrome around it stays usable, and every way out keeps the career: back to the dashboard, to
 * the save list, a copy of the career to keep, or a reload.
 */
function PageCrash({ error, reset }: { error: Error; reset: () => void }) {
  const navigate = useNavigate();
  const hasSave = useGame((s) => s.save !== null);
  const [note, setNote] = useState<string | null>(null);
  const go = (to: string) => {
    navigate(to);
    reset();
  };
  // Not a `.page`: the browser tests treat a visible `.page` with text as a page that rendered.
  return (
    <div className="splash page-crash">
      <h1>This page could not be shown</h1>
      <div className="notice bad" role="alert">
        <strong>Something went wrong while drawing this page.</strong>
        <div className="small mono" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
          {error.message}
        </div>
      </div>
      <p className="small dim">The career has not been changed. Choose where to go next.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {hasSave ? (
          <button className="primary" onClick={() => go('/dashboard')}>
            Back to dashboard
          </button>
        ) : (
          <button className="primary" onClick={() => go('/home')}>
            Back to the start
          </button>
        )}
        <button onClick={() => go('/load')}>Manage saves</button>
        {hasSave && (
          <button
            onClick={async () => {
              const save = useGame.getState().save;
              if (!save) return;
              try {
                setNote(await exportSave(save));
              } catch (e) {
                setNote(`The export failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            Export this career
          </button>
        )}
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
      {note && <p className="small mt">{note}</p>}
    </div>
  );
}

/** The routes of one tree, inside a boundary that resets whenever the path changes. */
function GuardedRoutes({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary key={pathname} fallback={(error, reset) => <PageCrash error={error} reset={reset} />}>
      <Routes>{children}</Routes>
    </ErrorBoundary>
  );
}

function Shell() {
  const [navOpen, setNavOpen] = useState(false);
  // Whatever opened the menu (the header button or the More tab) gets focus back when it closes.
  // Safari does not focus a button on a tap, so the body may be what is focused; the header's
  // menu button stands in then.
  const openerRef = useRef<HTMLElement | null>(null);
  const openNav = () => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setNavOpen(true);
  };
  const wasOpen = useRef(false);

  useEffect(() => {
    if (navOpen) {
      wasOpen.current = true;
      // The first link rather than the search box: focusing a field on a phone raises the keyboard
      // over the menu the player just asked to see.
      document.querySelector<HTMLElement>('#app-menu .nav-link')?.focus({ preventScroll: true });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setNavOpen(false);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.m-header .m-icon-button')?.focus({ preventScroll: true });
    }
    return undefined;
  }, [navOpen]);

  return (
    <div className="app">
      <ScrollToTop onRouteChange={() => setNavOpen(false)} />
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className="main">
        <MobileHeader onMenu={openNav} navOpen={navOpen} />
        <TopBar />
        <GuardedRoutes>
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
          <Route path="/fighter/:fighterId" element={<FighterRoute />} />
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
          <Route path="/regional" element={<RegionalPage />} />
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
        </GuardedRoutes>
        <footer className="app-footer">
          <p className="m-only small">
            Unofficial fan made simulation. Not affiliated with any promotion or fighter. <NavLink to="/data">Data and sources</NavLink> ·{' '}
            <NavLink to="/privacy">Privacy</NavLink>
          </p>
          <p className="d-only">
            {DISCLAIMER}
          </p>
          <p className="small d-only">
            Real factual data comes from documented sources with per field provenance. Values the source does not
            publish are derived or simulated and are labelled as such. Every financial figure in the game is simulated.
            Ratings are game model values, not measurements of a real person.{' '}
            <NavLink to="/data">Data and sources</NavLink> · <NavLink to="/privacy">Privacy</NavLink>
          </p>
        </footer>
      </div>
      <WelcomeSheet />
      <ActionDock />
      <MobileTabBar onMore={openNav} navOpen={navOpen} />
      <Notifications />
    </div>
  );
}

/**
 * The screens that live outside a career's chrome: the landing screen and world creation always,
 * and with no career loaded also privacy, help and the save list.
 */
function BareTree({ children }: { children: ReactNode }) {
  return (
    <>
      <ScrollToTop />
      <GuardedRoutes>{children}</GuardedRoutes>
      <Notifications />
    </>
  );
}

/** Privacy outside a career, so the page is reachable and shareable without a save. */
function StandalonePrivacy() {
  return (
    <div className="main">
      {/* No menu or tab bar here, and the iPhone app has no back button of its own. */}
      <p className="small" style={{ margin: '12px 12px 0' }}>
        <Link to="/home">Back</Link>
      </p>
      <PrivacyPage />
      <footer className="app-footer">
        <p>{DISCLAIMER}</p>
      </footer>
    </div>
  );
}

/**
 * A query flag that opens the app without loading the last played career.
 *
 * The last resort error screen uses it. The career that failed to draw is kept, but loading it
 * again at launch would only show the same failure, so this launch goes to the save list instead.
 */
export const SKIP_AUTOLOAD_PARAM = 'closed';

export function App() {
  const save = useGame((s) => s.save);
  const setSave = useGame((s) => s.setSave);
  const [checked, setChecked] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const skip = new URLSearchParams(window.location.search).has(SKIP_AUTOLOAD_PARAM);
      const id = skip ? null : await lastPlayedSaveId();
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
      <BareTree>
        <Route path="/" element={<LandingPage />} />
        <Route path="/home" element={<LandingPage />} />
        <Route path="/privacy" element={<StandalonePrivacy />} />
        <Route path="/new" element={<NewGamePage />} />
        <Route path="/load" element={<LoadGamePage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to={location.pathname === '/load' ? '/load' : '/home'} replace />} />
      </BareTree>
    );
  }

  // The landing screen and world creation are outside any one career, so they never show the
  // loaded career's chrome. Inside the shell the docked button still offered to advance the old
  // career from the new world screen, and tapping it did. Both pages have their own way back.
  if (location.pathname === '/home' || location.pathname === '/new') {
    return (
      <BareTree>
        <Route path="/home" element={<LandingPage />} />
        <Route path="/new" element={<NewGamePage />} />
      </BareTree>
    );
  }

  return <Shell />;
}
