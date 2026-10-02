// Renders the PNG icons iOS needs from the SVG artwork. iOS ignores SVG touch icons and app icons.
// Run: node tools/icons/render-icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const svg = readFileSync(join(root, 'tools/icons/app-icon.svg'), 'utf8');
const outputs = [
  ['public/apple-touch-icon.png', 180],
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['tools/icons/app-icon-1024.png', 1024],
];
// An explicit binary when the bundled one is missing, so the script does not depend on a browser download.
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [file, size] of outputs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0d1117">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
  mkdirSync(dirname(join(root, file)), { recursive: true });
  await page.screenshot({ path: join(root, file), clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
  console.log('wrote', file, size);
}
// The launch screen: the mark small in the middle of the app's background colour, so opening the
// app goes straight from black to the game without a flash of Capacitor's placeholder artwork.
const splash = svg
  .replace('width="1024" height="1024"', 'width="2732" height="2732"')
  .replace('<g transform="translate(50 50) scale(0.74) translate(-50 -50)">', '<g transform="translate(50 50) scale(0.16) translate(-50 -50)">')
  .replace(/<text[^>]*>GM<\/text>/, '');
await page.setViewportSize({ width: 2732, height: 2732 });
await page.setContent(`<html><body style="margin:0;background:#0d1117">${splash}</body></html>`);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  const file = join(root, 'ios/App/App/Assets.xcassets/Splash.imageset', name);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 2732, height: 2732 } });
  console.log('wrote', file);
}
// The App Store icon must be 1024 square with no transparency, which the render above already is.
await page.setViewportSize({ width: 1024, height: 1024 });
await page.setContent(`<html><body style="margin:0;background:#0d1117">${svg}</body></html>`);
await page.screenshot({ path: join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), clip: { x: 0, y: 0, width: 1024, height: 1024 } });
console.log('wrote app icon');
await browser.close();
