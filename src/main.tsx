import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { App, SKIP_AUTOLOAD_PARAM } from './ui/App';
import './ui/styles.css';
import { flushPendingSave, useGame } from './ui/store';
import { ErrorBoundary } from './ui/components';
import { applyTheme, isNativeApp, mirrorSave, requestPersistentStorage, restoreMirroredSaves } from './ui/native';

let stored: string | null = null;
try {
  stored = localStorage.getItem('octagon-theme');
} catch {
  // Storage can be refused (a private window). The dark default applies.
}
applyTheme(stored === 'light' ? 'light' : 'dark');

/**
 * The last resort, when even the career chrome fails to draw.
 *
 * It uses no router and no store hook, since either may be what failed. Closing the career keeps
 * it on the device: the save list opens without loading it, so the player can export it, load
 * another or start again. A career is never deleted from here.
 */
function AppCrash({ error }: { error: Error }) {
  return (
    <div className="splash" role="alert">
      <h1>The game could not be shown</h1>
      <p className="lede">Something went wrong while drawing the screen. Your saved careers are still on this device.</p>
      <p className="small mono" style={{ overflowWrap: 'anywhere' }}>
        {error.message}
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="primary"
          onClick={() => {
            try {
              useGame.getState().setSave(null);
            } catch {
              // Leaving through a full page load below clears the loaded career anyway.
            }
            window.location.assign(`/load?${SKIP_AUTOLOAD_PARAM}=1`);
          }}
        >
          Close this career
        </button>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    </div>
  );
}

/**
 * Starts the game. In the iPhone app, careers whose storage was emptied by iOS are put back from
 * the app's own backup first, so the last played career can open as usual. Anywhere else, and
 * whenever the storage is intact, that is one read of the save list.
 */
async function boot(): Promise<void> {
  // Asked as early as possible. Granted, the browser will not clear the saves to make room.
  void requestPersistentStorage();
  try {
    await restoreMirroredSaves();
  } catch {
    // A failed restore must not stop the game opening. The careers that are there still load.
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary fallback={(error) => <AppCrash error={error} />}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
      {/* The analytics script only exists on the Vercel platform. Mounting it locally logged a 404
          on every page load, which the browser tests rightly treat as a broken happy path. The
          iPhone app serves from capacitor://localhost, but it is checked by platform as well so
          the app stays free of it whatever its host name becomes. */}
      {!isNativeApp() && !['localhost', '127.0.0.1'].includes(window.location.hostname) && <Analytics />}
    </StrictMode>
  );
}
void boot();

// A change made in the last three quarters of a second before the tab closes was simply lost to
// the debounce. This writes it before the page goes away. iOS almost never fires `beforeunload`:
// Safari and the iPhone app are suspended when they go to the background and may be killed there
// without another event, so the write also happens on `pagehide` and whenever the page is hidden.
const flush = () => flushPendingSave(useGame.getState().save);
// Going to the background is also when the iPhone app writes its backup copy of the career. It is
// skipped mid advance, because the world is half way through a day loop until the advance ends.
const background = () => {
  flush();
  if (!useGame.getState().busy) void mirrorSave(useGame.getState().save);
};
window.addEventListener('beforeunload', flush);
window.addEventListener('pagehide', background);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') background();
});
if (isNativeApp()) {
  void import('@capacitor/app')
    .then(({ App: NativeApp }) =>
      NativeApp.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) background();
      })
    )
    .catch(() => {
      // The page visibility events above cover the same moment.
    });
}
