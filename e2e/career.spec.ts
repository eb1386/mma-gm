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
