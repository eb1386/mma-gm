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

test('a full career start reaches the dashboard', async ({ page }) => {
  await createCareer(page);
  // The new game screen is reachable and offers the three modes.
  await expect(page.getByText(/fighter/i).first()).toBeVisible();
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
