import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The iPhone app.
 *
 * The app is the same game as the website: Capacitor wraps the production build in a native iOS
 * shell. Saves live in the web view's IndexedDB. iOS can still reclaim web view storage when the
 * device is short of space, so the app also writes a backup of each career to its Documents folder
 * when it goes to the background, and restores from it at launch if the storage was emptied (see
 * src/ui/native.ts). Exporting a save opens the iOS share sheet. Build and run with `npm run ios`.
 */
const config: CapacitorConfig = {
  appId: 'app.mmagm.game',
  appName: 'MMA GM',
  webDir: 'dist',
  backgroundColor: '#0d1117',
  ios: {
    // The page handles the notch and home indicator itself with safe area insets.
    contentInset: 'never',
    backgroundColor: '#0d1117',
    scrollEnabled: true,
    // Careers are kept in IndexedDB with a file backup in Documents. Neither depends on this.
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#0d1117',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      overlaysWebView: true,
    },
  },
};

export default config;
