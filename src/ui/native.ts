import { Capacitor } from '@capacitor/core';
import type { SaveGame } from '@core/types/save';
import { exportSaveToBlob, exportSaveToText, importSaveFromText, listSaves, saveExportFileName } from '@core/save/store';

/**
 * The iPhone app's native pieces.
 *
 * The game runs the same code in a browser and in the app. The one thing a browser does that the
 * app's web view cannot is download a file: `<a download>` is silently ignored inside the app, so
 * exporting a career appeared to work and produced nothing. In the app the file is written to the
 * cache and handed to the iOS share sheet, which saves it to Files, AirDrops it or sends it on.
 */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export async function exportSave(save: SaveGame): Promise<string> {
  const name = saveExportFileName(save);
  if (isNativeApp()) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const text = exportSaveToText(save);
    const written = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    try {
      await Share.share({ title: `${save.saveName} save`, files: [written.uri], dialogTitle: 'Export career' });
    } catch (e) {
      // Dismissing the share sheet rejects with "Share canceled". That is the player changing their
      // mind, not a failure, and was reported as "Export failed".
      if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return 'Export canceled.';
      throw e;
    }
    return 'Choose where to keep the save file.';
  }
  // Safari on an iPhone can share a file too, which is a better experience than a download there.
  const file = new File([exportSaveToBlob(save)], name, { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  if (touch && nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: `${save.saveName} save` });
      return 'Save shared.';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'Export canceled.';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in the same tick could cancel the download in WebKit before it started.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'Save downloaded.';
}

// ---------------------------------------------------------------------------
// Device backup in the iPhone app
// ---------------------------------------------------------------------------

/**
 * Careers live in the web view's IndexedDB, and iOS may reclaim web view storage when the device
 * runs short of space. A multi season career is many hours of play, so the app also keeps a copy of
 * each career as a file in its Documents folder, which iOS backs up and does not purge. The copy is
 * written when the app goes to the background, not on every autosave: serialising a large world
 * on every change would cost the phone more than the backup is worth.
 */
const MIRROR_DIR = 'saves';
const mirrorPath = (saveId: string) => `${MIRROR_DIR}/${saveId}.json`;

/** The last save object written, so the visibility and app state events of one trip to the background write once. */
let lastMirrored: SaveGame | null = null;

export async function mirrorSave(save: SaveGame | null): Promise<void> {
  if (!save || !isNativeApp() || save === lastMirrored) return;
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const path = mirrorPath(save.saveId);
    // Written beside the backup and then moved over it, so a write cut off by iOS ending the app
    // leaves the previous backup whole rather than half a file.
    const temp = `${path}.partial`;
    await Filesystem.writeFile({ path: temp, data: exportSaveToText(save), directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    const move = () => Filesystem.rename({ from: temp, to: path, directory: Directory.Data, toDirectory: Directory.Data });
    try {
      await move();
    } catch {
      // A move onto an existing file is refused on some versions. The new copy is complete by now,
      // so the old one can go first.
      await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
      await move();
    }
    lastMirrored = save;
  } catch {
    // The backup is a second copy. Failing to write it must never get in the way of playing.
  }
}

/** Deletes a career's backup, or the career would come back the next time the app starts. */
export async function removeMirroredSave(saveId: string): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.deleteFile({ path: mirrorPath(saveId), directory: Directory.Data });
  } catch {
    // No backup had been written yet.
  }
}

/**
 * Puts the backed up careers back when the web view's storage has been emptied.
 *
 * Only when no career is listed at all: that is what an eviction looks like, and restoring into a
 * list that has careers could bring back one the player deleted on another install. Each file goes
 * through the import path, so it is validated and upgraded like any other save, and keeps its id so
 * it stays the same career. Returns how many were restored.
 */
export async function restoreMirroredSaves(): Promise<number> {
  if (!isNativeApp()) return 0;
  try {
    if ((await listSaves()).length > 0) return 0;
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const dir = await Filesystem.readdir({ path: MIRROR_DIR, directory: Directory.Data });
    let restored = 0;
    for (const file of dir.files) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const read = await Filesystem.readFile({ path: `${MIRROR_DIR}/${file.name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
        const text = typeof read.data === 'string' ? read.data : await read.data.text();
        await importSaveFromText(text, { keepSaveId: true });
        restored++;
      } catch {
        // One unreadable backup does not stop the others.
      }
    }
    return restored;
  } catch {
    // No backup folder: nothing was ever mirrored.
    return 0;
  }
}

/**
 * Asks the browser to keep this site's storage, once per launch.
 *
 * Safari deletes a website's storage, IndexedDB included, after seven days of use without a visit
 * unless the site is on the Home Screen, and any browser may clear it when the disk runs low. A
 * site whose storage is marked persistent is exempt from the second. Resolves to whether the
 * storage is persistent, or null where the browser cannot say.
 */
let persistRequest: Promise<boolean | null> | null = null;
export function requestPersistentStorage(): Promise<boolean | null> {
  if (!persistRequest) {
    persistRequest = (async () => {
      try {
        const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
        if (!storage?.persist) return null;
        if (storage.persisted && (await storage.persisted())) return true;
        return await storage.persist();
      } catch {
        return null;
      }
    })();
  }
  return persistRequest;
}

/** True when the website is running from the Home Screen, where Safari does not expire its storage. */
export function runningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || Boolean(window.matchMedia?.('(display-mode: standalone)').matches);
}

export type Theme = 'dark' | 'light';

/**
 * Applies a colour theme everywhere it shows, not only in the page.
 *
 * Setting the attribute alone left the browser toolbar colour fixed at near black over a white
 * page, and left the iPhone app's status bar text white (the style set in the app config) over the
 * white strip the light theme paints behind it, so the clock and battery disappeared. Startup and
 * the Settings control both call this, so the two can never drift apart.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  // The header colour, read from the stylesheet so it follows the tokens. The fallbacks cover a
  // call made before the stylesheet has been applied.
  const raised = getComputedStyle(root).getPropertyValue('--bg-raised').trim() || (theme === 'light' ? '#ffffff' : '#171b22');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', raised);
  if (isNativeApp()) {
    void (async () => {
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        // Capacitor names the style after the background it suits: Light means dark text.
        await StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark });
      } catch {
        // The status bar is cosmetic. A plugin that is missing or refuses must not stop the game.
      }
    })();
  }
}
