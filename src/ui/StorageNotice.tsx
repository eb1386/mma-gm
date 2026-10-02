import { useEffect, useState } from 'react';
import { isNativeApp, requestPersistentStorage, runningStandalone } from './native';

const DISMISSED_KEY = 'octagon-storage-notice-dismissed';

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Storage refused (a private window). The notice shows, and can still be closed for this visit.
    return false;
  }
}

/**
 * A one time warning that the browser may clear saved careers.
 *
 * Careers are kept only in this browser's storage. Safari removes a website's storage after a
 * week of use without a visit unless the site is on the Home Screen, and the game said nothing
 * about it, so a player could lose a long career to a holiday. Shown only on the website, only
 * when the browser has not agreed to keep the storage, and never again once closed. The iPhone app
 * keeps its own backup and does not need it.
 */
export function StorageNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isNativeApp() || runningStandalone() || dismissed()) return undefined;
    let live = true;
    void requestPersistentStorage().then((persisted) => {
      if (live && persisted === false) setShow(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Closed for this visit only.
    }
  };
  return (
    <div className="notice storage-notice" role="note">
      <p>
        Your careers are stored only in this browser, and some browsers clear a site's storage after a few weeks
        without a visit. On an iPhone or iPad, add the game to your Home Screen. Wherever you play, export a
        career from Settings now and then to keep a copy.
      </p>
      <button onClick={close}>Got it</button>
    </div>
  );
}
