import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { formatDate } from '@core/types/common';
import { actionableMessages } from '@core/world/inbox';
import { CAREER_STATE_LABEL } from '@core/world/career';
import { useAdvanceControls } from './AdvanceBar';
import { useCareerStatus, useGame } from './store';

/**
 * The phone layout.
 *
 * On a narrow screen the desktop chrome (a sidebar, a header with four advance buttons and a search
 * box) used a quarter of the screen before any content and wrapped into overlapping rows. This is
 * the layout a phone game uses instead: a slim header, the career's next step as one large button
 * above the thumb, and a tab bar for the screens a career lives on. Everything else is one tap away
 * in the menu. On a wide screen none of this renders; the stylesheet hides it.
 */

function Icon({ name }: { name: 'home' | 'inbox' | 'fighter' | 'world' | 'more' | 'menu' | 'clock' | 'close' }) {
  const paths: Record<string, ReactNode> = {
    home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
    inbox: (
      <>
        <path d="M3 13h5l1.5 3h5L16 13h5" />
        <path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
      </>
    ),
    fighter: (
      <>
        <circle cx="12" cy="7" r="4" />
        <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
      </>
    ),
    world: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6 6 18" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function MobileHeader({ onMenu, navOpen = false }: { onMenu: () => void; navOpen?: boolean }) {
  const save = useGame((s) => s.save);
  const fightPlayback = useGame((s) => s.fightPlayback);
  const status = useCareerStatus();
  if (!save) return null;
  const fighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const gym = save.player.gymId ? save.gyms[save.player.gymId] : null;
  const title = fighter ? fighter.name : gym ? gym.name : save.saveName;
  // While the fight is replayed the career state is already the one after it ('Medically
  // suspended' at round one), so the header holds the fight night label until the result shows.
  const state = !save.player.fighterId
    ? null
    : fightPlayback
      ? 'Fight night'
      : status
        ? CAREER_STATE_LABEL[status.state as keyof typeof CAREER_STATE_LABEL]
        : null;
  return (
    <header className="m-header">
      <button className="m-icon-button" aria-label="Open the menu" aria-expanded={navOpen} aria-controls="app-menu" onClick={onMenu}>
        <Icon name="menu" />
      </button>
      <div className="m-title">
        <span className="m-title-name">{title}</span>
        <span className="m-title-sub">
          {formatDate(save.date)}
          {state ? ` · ${state}` : ''}
        </span>
      </div>
      {/* Balances the menu button so the title stays centred. The inbox lives in the tab bar. */}
      <span className="m-header-spacer" />
    </header>
  );
}

export function MobileTabBar({ onMore, navOpen = false }: { onMore: () => void; navOpen?: boolean }) {
  const save = useGame((s) => s.save);
  const fightPlayback = useGame((s) => s.fightPlayback);
  const location = useLocation();
  // The count from before the fight is held while its result is replayed. The fight's own inbox
  // items (an injury, a suspension) arrive with the result and otherwise lit the badge at round one.
  const heldUnread = useRef(0);
  if (!save) return null;
  const liveUnread = actionableMessages(save).length;
  if (!fightPlayback) heldUnread.current = liveUnread;
  const unread = fightPlayback ? heldUnread.current : liveUnread;
  const fighterId = save.player.fighterId;
  const gymId = save.player.gymId;
  // Every route belongs to exactly one tab. Rankings and the divisions belong to the third tab when
  // that tab is Rankings (a spectator world), and to World otherwise; a gym page belongs to the Gym
  // tab in a coach career. Listing a route under two tabs lit both at once.
  const thirdOwnsRankings = !fighterId && !gymId;
  const fighterAlso = ['/camp', '/contract', '/career', '/money', '/regional', '/fightweek', '/fight/', '/sponsors', '/management', '/compliance', '/rivalries'];
  const worldAlso = [
    '/event/',
    '/roster',
    '/news',
    '/officials',
    '/history',
    '/records',
    '/leaders',
    '/hall-of-fame',
    ...(thirdOwnsRankings ? [] : ['/rankings', '/division/']),
    ...(gymId ? [] : ['/gyms', '/gym/']),
    ...(fighterId ? [] : ['/rivalries']),
  ];
  const tab = (to: string, label: string, icon: Parameters<typeof Icon>[0]['name'], badge = 0, also: string[] = []) => {
    const active = location.pathname === to || also.some((p) => location.pathname.startsWith(p));
    // A function, so this check is the only one. Given a string, NavLink adds its own `active`
    // class whenever its path matches, a second rule that could disagree with this one.
    return (
      <NavLink to={to} className={() => `m-tab${active ? ' active' : ''}`}>
        <span className="m-tab-icon">
          <Icon name={icon} />
          {badge > 0 && <span className="m-badge">{badge > 99 ? '99+' : badge}</span>}
        </span>
        <span>{label}</span>
      </NavLink>
    );
  };
  return (
    <nav className="m-tabbar" aria-label="Main">
      {tab('/dashboard', 'Home', 'home')}
      {tab('/inbox', 'Inbox', 'inbox', unread, ['/inbox/', '/offer/'])}
      {fighterId
        ? tab(`/fighter/${fighterId}`, 'Fighter', 'fighter', 0, fighterAlso)
        : gymId
          ? tab('/coach', 'Gym', 'fighter', 0, ['/gym/'])
          : tab('/rankings', 'Rankings', 'fighter', 0, ['/division/'])}
      {tab('/calendar', 'World', 'world', 0, worldAlso)}
      <button className="m-tab" aria-expanded={navOpen} aria-controls="app-menu" onClick={onMore}>
        <span className="m-tab-icon">
          <Icon name="more" />
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}

/**
 * The next step, docked above the tab bar. Moving time by a fixed span is a secondary choice and
 * lives in a sheet, so the one thing the career is waiting for is always the big button.
 */
export function ActionDock() {
  const c = useAdvanceControls();
  const [sheet, setSheet] = useState(false);
  // The sheet closes on Escape like the menu does. A hardware keyboard or switch control user
  // otherwise had no way out but the Cancel button.
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);
  // On the page the next step leads to, a button that only leads here again is wasted space. The
  // page's own controls are the next step, so the dock steps aside until the player moves on.
  if (!c || c.alreadyThere) return null;
  const spans: { key: 'day' | 'week' | 'month' | 'year'; label: string }[] = [
    { key: 'day', label: 'One day' },
    { key: 'week', label: 'One week' },
    { key: 'month', label: 'One month' },
    ...(c.spectator ? [{ key: 'year' as const, label: 'One year' }] : []),
  ];
  return (
    <>
      <div className="m-dock">
        {c.blocked && !c.busy && <div className="m-dock-note">{c.reason}</div>}
        <div className="m-dock-row">
          <button className={`primary m-dock-primary${c.blocked ? ' urgent' : ''}`} disabled={c.busy} onClick={() => void c.primaryClick()}>
            {c.primaryLabel}
          </button>
          {/* While an advance runs, the time button's place holds the way to stop it, under the
              thumb that started it. */}
          {c.cancellable ? (
            <button className="m-dock-cancel" disabled={c.cancelRequested} onClick={c.cancel}>
              {c.cancelRequested ? 'Stopping' : 'Cancel'}
            </button>
          ) : (
            <button className="m-dock-time" disabled={c.busy || c.blocked} aria-label="Advance by a set time" onClick={() => setSheet(true)}>
              <Icon name="clock" />
            </button>
          )}
        </div>
      </div>
      {sheet && (
        <div className="m-sheet-scrim" onClick={() => setSheet(false)}>
          <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Advance by a set time" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-title">Advance the calendar</div>
            {spans.map((s) => (
              <button
                key={s.key}
                className="m-sheet-option"
                onClick={() => {
                  setSheet(false);
                  void c.runDuration(s.key);
                }}
              >
                {s.label}
              </button>
            ))}
            <button className="m-sheet-option m-sheet-cancel" onClick={() => setSheet(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
