// Polite, resumable, disk cached HTTP client for the ingestion pipeline.
//
// Compliance notes for www.ufc.com (verified against https://www.ufc.com/robots.txt):
//   - "crawl-delay: 15" is honored literally. DEFAULT_DELAY_MS is 15000.
//   - "Disallow: /athletes/all?*" is honored. The crawler refuses that path outright,
//     which is why the real roster is built from /rankings plus /athlete/<slug> only.
//   - Responses are cached to disk so re-runs cost zero requests.
//   - A single connection is used. No parallelism, ever.

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_DELAY_MS = 15000;

const UA =
  'octagon-gm-ingest/1.0 (single player simulation game; personal, non commercial; honors robots.txt crawl-delay)';

// Paths the site owner disallows for automated agents. Checked as prefixes on the
// pathname plus query string.
const DISALLOWED = [
  '/core/',
  '/profiles/',
  '/admin/',
  '/search',
  '/taxonomy/term/',
  '/trending/all?',
  '/athletes/all?',
  '/watch/library?',
  '/facets-block-ajax',
  '/user/',
];

export class PoliteFetcher {
  constructor({ cacheDir, delayMs = DEFAULT_DELAY_MS, maxAgeHours = 168, log = console.log }) {
    this.cacheDir = cacheDir;
    this.delayMs = delayMs;
    this.maxAgeMs = maxAgeHours * 3600 * 1000;
    this.log = log;
    this.lastRequestAt = 0;
    this.stats = { network: 0, cache: 0, failed: 0, disallowed: 0 };
    mkdirSync(cacheDir, { recursive: true });
  }

  cachePathFor(url) {
    const h = createHash('sha1').update(url).digest('hex');
    return join(this.cacheDir, h.slice(0, 2), `${h}.html`);
  }

  isAllowed(url) {
    const u = new URL(url);
    const target = u.pathname + (u.search || '');
    for (const bad of DISALLOWED) {
      if (bad.endsWith('?')) {
        if (u.pathname === bad.slice(0, -1) && u.search) return false;
      } else if (target.startsWith(bad)) {
        return false;
      }
    }
    return true;
  }

  async sleepUntilAllowed() {
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = this.delayMs - elapsed;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * Returns { ok, body, fromCache, status, fetchedAt } and never throws for an
   * ordinary HTTP failure. A failed fetch is a reportable data gap, not a crash.
   */
  async get(url, { retries = 3 } = {}) {
    if (!this.isAllowed(url)) {
      this.stats.disallowed++;
      return { ok: false, body: null, fromCache: false, status: 0, reason: 'disallowed-by-robots' };
    }

    const cachePath = this.cachePathFor(url);
    if (existsSync(cachePath)) {
      const age = Date.now() - statSync(cachePath).mtimeMs;
      if (age < this.maxAgeMs) {
        this.stats.cache++;
        return {
          ok: true,
          body: readFileSync(cachePath, 'utf8'),
          fromCache: true,
          status: 200,
          fetchedAt: new Date(statSync(cachePath).mtimeMs).toISOString(),
        };
      }
    }

    let lastStatus = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.sleepUntilAllowed();
      this.lastRequestAt = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);
        const res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastStatus = res.status;
        if (res.status === 404) {
          this.stats.failed++;
          return { ok: false, body: null, fromCache: false, status: 404, reason: 'not-found' };
        }
        if (res.status === 429 || res.status >= 500) {
          const backoff = this.delayMs * Math.pow(2, attempt);
          this.log(`  retry ${attempt + 1} after status ${res.status}, backing off ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        if (!res.ok) {
          this.stats.failed++;
          return { ok: false, body: null, fromCache: false, status: res.status, reason: 'http-error' };
        }
        const body = await res.text();
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, body, 'utf8');
        this.stats.network++;
        return { ok: true, body, fromCache: false, status: 200, fetchedAt: new Date().toISOString() };
      } catch (err) {
        this.log(`  request error on attempt ${attempt + 1}: ${err.message}`);
        await new Promise((r) => setTimeout(r, this.delayMs * (attempt + 1)));
      }
    }
    this.stats.failed++;
    return { ok: false, body: null, fromCache: false, status: lastStatus, reason: 'exhausted-retries' };
  }
}
