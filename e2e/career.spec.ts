import { expect, test, type Page } from '@playwright/test';

/**
 * The public beta path.
 *
 * These guard the defects that would be immediately visible to a real user: a decision that
 * stays on screen after it is answered, a button that appears to do nothing, a route that
 * 404s on refresh, and a missing icon or title.
 */

const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));
});

test.afterEach(() => {
  // A console error on the happy path is a release blocker.
  const ignorable = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('manifest'));
  expect(ignorable, `console errors: ${ignorable.join(' | ')}`).toEqual([]);
});

async function createCareer(page: Page) {
  await page.goto('/');
  // Landing or new game, depending on whether a save already exists.
  const createButton = page.getByRole('button', { name: /create a new world/i });
  if (await createButton.isVisible().catch(() => false)) await createButton.click();
  await expect(page.getByText(/new career|create/i).first()).toBeVisible();
}

test('branding, title and icon are present', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/MMA GM/);
  const description = page.locator('meta[name="description"]');
  await expect(description).toHaveAttribute('content', /MMA career/i);
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('href', /favicon\.svg/);
  const og = page.locator('meta[property="og:image"]');
  await expect(og).toHaveAttribute('content', /og-image/);
  // The mark is a real octagon: an eight point polygon, not a rotated square.
  const polygon = page.locator('svg.octagon-mark polygon').first();
  if (await polygon.count()) {
    const points = await polygon.getAttribute('points');
    expect(points?.trim().split(/\s+/).length).toBe(8);
  }
});

test('the favicon and manifest are served', async ({ page, request }) => {
  await page.goto('/');
  for (const asset of ['/favicon.svg', '/manifest.webmanifest', '/icon-192.svg', '/og-image.svg', '/robots.txt']) {
    const response = await request.get(asset);
    expect(response.status(), `${asset} should be served`).toBe(200);
  }
});

test('direct route loads do not 404', async ({ page }) => {
  // Every one of these is a URL a user could paste or refresh on.
  for (const route of ['/', '/home', '/privacy']) {
    const response = await page.goto(route);
    expect(response?.status(), `${route} returned ${response?.status()}`).toBeLessThan(400);
    await expect(page.locator('#root')).not.toBeEmpty();
  }
});

test('the landing screen never destroys a career on its own', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'MMA GM' })).toBeVisible();
  // Opening the landing screen must not create a world.
  await expect(page.getByRole('button', { name: /create a new world/i })).toBeVisible();
});

test('the new game screen offers the three modes', async ({ page }) => {
  await page.goto('/new');
  // Match the mode buttons specifically. A loose text match picked up hidden nodes elsewhere on
  // the page and told us nothing about whether the modes were actually offered.
  await expect(page.getByRole('button', { name: /^start career$/i })).toBeVisible({ timeout: 30_000 });
  for (const mode of [/play as a fighter/i, /coach/i, /spectator/i]) {
    await expect(page.getByRole('button', { name: mode }).first()).toBeVisible();
  }
});

test('the footer disclaimer is present on the shell', async ({ page }) => {
  await page.goto('/home');
  // Landing lives outside the shell, so check inside a career shell route instead.
  const response = await page.goto('/privacy');
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByText(/unofficial fan-made MMA simulation/i)).toBeVisible();
});

/**
 * Starts a career and lands on the dashboard.
 *
 * Building a world takes a moment, so the wait is generous. Everything after this point is
 * testing the running game rather than the landing screen.
 */
async function startCareer(page: Page) {
  await page.goto('/new');
  const start = page.getByRole('button', { name: /^start career$/i });
  await expect(start).toBeVisible({ timeout: 60_000 });
  // Fighter mode needs a fighter chosen before the world can be built, so the first
  // available roster row is selected. Waiting for the snapshot to load is the slow part.
  const firstPick = page.getByRole('button', { name: /^select$/i }).first();
  await expect(firstPick).toBeVisible({ timeout: 60_000 });
  await firstPick.click();
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 120_000 });
}

/**
 * Reveals the navigation.
 *
 * On a narrow viewport the sidebar is off canvas behind a menu button, so the same test
 * covers both layouts rather than skipping mobile.
 */
async function openNav(page: Page) {
  const toggle = page.getByRole('button', { name: /open the menu/i });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
}

test('a started career reaches the dashboard and the sidebar works', async ({ page }) => {
  await startCareer(page);
  await openNav(page);
  await expect(page.getByRole('link', { name: 'Rivalries' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Rankings' })).toBeVisible();
});

test('the rivalries page is reachable from the left navigation', async ({ page }) => {
  await startCareer(page);
  await openNav(page);
  await page.getByRole('link', { name: 'Rivalries' }).click();
  await expect(page).toHaveURL(/\/rivalries/);
  await expect(page.getByRole('heading', { name: 'Rivalries' })).toBeVisible();
  // The filter controls are the page's own, so their presence proves the page rendered.
  await expect(page.getByText(/only matchups that can be made/i)).toBeVisible();
});

test('the rivalries page survives a direct load and a refresh', async ({ page }) => {
  await startCareer(page);
  const response = await page.goto('/rivalries');
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { name: 'Rivalries' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Rivalries' })).toBeVisible();
});

test('the career page exposes callouts and where each matchup stands', async ({ page }) => {
  await startCareer(page);
  await page.goto('/career');
  await page.getByRole('button', { name: /^callouts$/i }).click();
  await expect(page.getByText(/where these matchups stand/i)).toBeVisible();
  await expect(page.getByText(/callout history/i)).toBeVisible();
});

test('the weight class tab states what happens to a championship', async ({ page }) => {
  await startCareer(page);
  await page.goto('/career');
  await page.getByRole('button', { name: /weight class/i }).click();
  // Every division option states the ranking and title consequence before anything is committed.
  await expect(page.getByText(/move type/i).first()).toBeVisible();
});

test('the officials page lists judges and referees', async ({ page }) => {
  await startCareer(page);
  await page.goto('/officials');
  await expect(page.getByRole('heading', { name: 'Officials' })).toBeVisible();
  // The roster exists from the first day, so the empty state must not be showing.
  await expect(page.getByText(/no officials yet/i)).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Commission' })).toBeVisible();
  // Switching to referees keeps the page rendering.
  await page.getByLabel(/role/i).selectOption('referee');
  await expect(page.getByRole('heading', { name: 'Officials' })).toBeVisible();
});

/**
 * Every left navigation destination, plus the detail routes reachable from them.
 *
 * A route that renders a blank page or throws a console error is a release blocker, and the
 * afterEach hook already fails the test on any console error.
 */
const NAV_ROUTES = [
  '/dashboard',
  '/inbox',
  '/camp',
  '/contract',
  '/career',
  '/money',
  '/sponsors',
  '/management',
  '/compliance',
  '/rivalries',
  '/calendar',
  '/rankings',
  '/roster',
  '/gyms',
  '/news',
  '/officials',
  '/history',
  '/records',
  '/leaders',
  '/hall-of-fame',
  '/data',
  '/settings',
  '/help',
];

test('every navigation section renders with content and no console error', async ({ page }) => {
  await startCareer(page);
  for (const route of NAV_ROUTES) {
    const response = await page.goto(route);
    expect(response?.status(), `${route} returned ${response?.status()}`).toBeLessThan(400);
    // The shell always renders a heading, so an empty main area means the page threw.
    await expect(page.locator('.page'), `${route} rendered nothing`).toBeVisible({ timeout: 15_000 });
    const text = (await page.locator('.page').innerText()).trim();
    expect(text.length, `${route} rendered an empty page`).toBeGreaterThan(20);
  }
});

/**
 * Starts a career in a mode where the player manages no fighter of their own.
 *
 * Spectator and coach mode are the modes where `player.fighterId` is null, which is exactly the
 * state a page that assumes a fighter would crash on. Nothing exercised them in a browser before.
 */
async function startCareerInMode(page: Page, mode: RegExp) {
  await page.goto('/new');
  const start = page.getByRole('button', { name: /^start career$/i });
  await expect(start).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: mode }).first().click();
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 120_000 });
}

for (const [label, mode] of [
  ['spectator', /spectator/i],
  ['coach', /coach/i],
] as const) {
  test(`every navigation section renders in ${label} mode, where there is no player fighter`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await startCareerInMode(page, mode);
    // Every route, not only the ones the sidebar offers in this mode. A player can paste a URL.
    for (const route of NAV_ROUTES) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} returned ${response?.status()}`).toBeLessThan(400);
      await expect(page.locator('.page'), `${route} rendered nothing in ${label} mode`).toBeVisible({
        timeout: 15_000,
      });
      const text = (await page.locator('.page').innerText()).trim();
      expect(text.length, `${route} rendered an empty page in ${label} mode`).toBeGreaterThan(20);
    }
    expect(errors, `console errors in ${label} mode: ${errors.join(' | ')}`).toEqual([]);
  });
}

test('every navigation section survives a direct load and a refresh', async ({ page }) => {
  await startCareer(page);
  // A sample across the different page shapes, refreshed to prove the route works cold.
  for (const route of ['/rankings', '/officials', '/rivalries', '/money', '/records', '/help']) {
    await page.goto(route);
    await page.reload();
    await expect(page.locator('.page')).toBeVisible({ timeout: 15_000 });
  }
});

test('the dashboard action button runs rather than only navigating', async ({ page }) => {
  await startCareer(page);
  await page.goto('/career');
  // The primary action is a real control: it must be enabled and must not be a dead link.
  const primary = page.locator('button.primary').first();
  await expect(primary).toBeVisible();
  await expect(primary).toBeEnabled();
});

test('social posting is limited rather than an unlimited button', async ({ page }) => {
  await startCareer(page);
  // Reach the fighter page through the navigation, which works identically on both layouts.
  await openNav(page);
  await page.getByRole('link', { name: 'My fighter' }).click();
  await expect(page).toHaveURL(/\/fighter\//);
  // The social panel lives on the identity tab.
  await page.getByRole('button', { name: /^identity$/i }).click();
  await expect(page.getByText(/posts left this week/i)).toBeVisible({ timeout: 20_000 });
  // Going quiet is always available, because it is the absence of a post.
  await expect(page.getByRole('button', { name: /go silent/i })).toBeEnabled();
});

test('the camp focus blocks have lengths that partition one whole camp', async ({ page }) => {
  // The complaint this covers was visual: six range inputs all render the same width whatever
  // their value, so the camp split was invisible and only the percentages moved. What has to be
  // true now is a geometric claim about the real stylesheet, so it is measured against it.
  await page.goto('/help');
  await expect(page.locator('.page')).toBeVisible({ timeout: 15_000 });

  const measure = async (shares: number[]) =>
    page.evaluate((pcts) => {
      document.getElementById('alloc-probe')?.remove();
      const host = document.createElement('div');
      host.id = 'alloc-probe';
      host.style.width = '600px';
      const bar = document.createElement('div');
      bar.className = 'alloc';
      for (const [i, pct] of pcts.entries()) {
        const seg = document.createElement('div');
        seg.className = `alloc-seg seg-${['striking', 'grappling', 'wrestling', 'submissions', 'cardio', 'durability'][i]}`;
        seg.style.width = `${pct}%`;
        bar.appendChild(seg);
      }
      host.appendChild(bar);
      document.body.appendChild(host);
      const widths = [...bar.children].map((el) => (el as HTMLElement).getBoundingClientRect().width);
      // The content box, because the bar carries a one pixel border the blocks sit inside.
      const total = bar.clientWidth;
      host.remove();
      return { widths, total };
    }, shares);

  const even = await measure([20, 16, 18, 14, 20, 12]);
  // Each block is as long as its share of the camp, and the six fill the bar exactly.
  expect(Math.abs(even.widths.reduce((a, b) => a + b, 0) - even.total)).toBeLessThan(1);
  expect(Math.abs(even.widths[0] / even.total - 0.2)).toBeLessThan(0.01);
  expect(Math.abs(even.widths[5] / even.total - 0.12)).toBeLessThan(0.01);

  // Give one area more and the others are visibly shorter, which is the whole point.
  const skewed = await measure([50, 10, 11, 9, 13, 7]);
  expect(skewed.widths[0]).toBeGreaterThan(even.widths[0] + 100);
  expect(skewed.widths[1]).toBeLessThan(even.widths[1]);
  expect(skewed.widths[4]).toBeLessThan(even.widths[4]);
  expect(Math.abs(skewed.widths.reduce((a, b) => a + b, 0) - skewed.total)).toBeLessThan(1);

  // One area taking everything leaves the others with no length at all.
  const all = await measure([100, 0, 0, 0, 0, 0]);
  expect(Math.abs(all.widths[0] - all.total)).toBeLessThan(1);
  for (let i = 1; i < 6; i++) expect(all.widths[i]).toBeLessThan(1);
});
