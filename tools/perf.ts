/**
 * Performance harness.
 *
 * Measures every phase the expansion specification calls out, separately rather than as
 * one total, so a regression can be attributed to the step that caused it.
 *
 * Run with:  npx vite-node tools/perf.ts [--quick]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SnapshotFile } from '../src/core/data/snapshot';
import { createNewGame } from '../src/core/world/newgame';
import { advance } from '../src/core/world/tick';
import { migrateSave } from '../src/core/save/migrate';
import { refreshPotForAll } from '../src/core/world/pot';
import { DIVISIONS } from '../src/core/config/divisions';
import type { SaveGame } from '../src/core/types/save';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'public', 'data');
const QUICK = process.argv.includes('--quick');

interface Measurement {
  phase: string;
  ms: number;
  detail?: string;
  target?: number;
}

const results: Measurement[] = [];

function time<T>(phase: string, fn: () => T, target?: number, detail?: (v: T) => string): T {
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  results.push({ phase, ms, target, detail: detail ? detail(value) : undefined });
  return value;
}

const file = readdirSync(DATA).find((f) => f.startsWith('snapshot-'));
if (!file) {
  console.error('No snapshot found. Run: npx vite-node tools/build-snapshot.ts');
  process.exit(2);
}

const indexRaw = time('Load snapshot index', () => readFileSync(join(DATA, 'snapshots.json'), 'utf8'), 1000);
void JSON.parse(indexRaw);

const snapshotText = time('Read snapshot file from disk', () => readFileSync(join(DATA, file), 'utf8'), 1000, (t) =>
  `${(t.length / 1024 / 1024).toFixed(2)} MB`
);
const snapshot = time('Parse snapshot JSON', () => JSON.parse(snapshotText) as SnapshotFile, 1000, (s) =>
  `${s.fighters.length} fighters`
);

// ---------------------------------------------------------------------------
// Career creation, by mode
// ---------------------------------------------------------------------------

const spectator = time(
  'New career: Spectator Mode',
  () => createNewGame(snapshot, { saveName: 'perf', seed: 11, mode: 'spectator' }),
  5000,
  (r) => `${r.summary.realFighters} real, ${r.summary.generatedFighters} fictional, ${r.summary.gyms} gyms`
);

const playerId = snapshot.fighters.find((f) => f.ranking !== null)!.id;
time(
  'New career: Fighter Mode',
  () => createNewGame(snapshot, { saveName: 'perf', seed: 12, mode: 'fighter', playerFighterId: playerId }),
  5000
);

time(
  'New career: Coach Mode',
  () =>
    createNewGame(snapshot, {
      saveName: 'perf',
      seed: 13,
      mode: 'coach',
      coach: { name: 'Perf Coach', newGym: { name: 'Perf Gym', country: 'United States', city: 'Denver' } },
    }),
  5000
);

time(
  'New career: reduced performance mode',
  () =>
    createNewGame(snapshot, {
      saveName: 'perf',
      seed: 14,
      mode: 'spectator',
      settings: { fillRosterWithGenerated: false, potPaths: 20 },
    }),
  2000
);

// ---------------------------------------------------------------------------
// Advancing time
// ---------------------------------------------------------------------------

const save = spectator.save;

time('Advance one day', () => advance(save, { mode: 'day', stopOnDecision: false }), 200);
time('Advance one week', () => advance(save, { mode: 'week', stopOnDecision: false }), 1000);
time('Advance one month', () => advance(save, { mode: 'month', stopOnDecision: false }), 3000);

const beforeEvents = Object.values(save.events).filter((e) => e.status === 'completed').length;
time('Advance to next event', () => advance(save, { mode: 'next-event', stopOnDecision: false }), 2000, () => {
  const after = Object.values(save.events).filter((e) => e.status === 'completed').length;
  return `${after - beforeEvents} events resolved`;
});

time('Annual Pot refresh', () => refreshPotForAll(save), 3000, (r) => `${r.recomputed} recomputed, ${r.cached} cached`);
time('Annual Pot refresh, second pass', () => refreshPotForAll(save), 500, (r) => `${r.recomputed} recomputed, ${r.cached} cached`);

if (!QUICK) {
  time(
    'Simulate one full year',
    () => advance(save, { mode: 'year', maxDays: 366, stopOnDecision: false }),
    30000,
    (r) => `${r.eventsResolved.length} events`
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const serialized = time('Serialize save to JSON', () => JSON.stringify(save), 2000, (s) => `${(s.length / 1024 / 1024).toFixed(2)} MB`);
time('Parse save from JSON', () => JSON.parse(serialized) as SaveGame, 2000);
time('Migrate a loaded save', () => migrateSave(JSON.parse(serialized) as SaveGame), 1000);

if (!QUICK) {
  const fiveYear = createNewGame(snapshot, { saveName: 'perf5', seed: 21, mode: 'spectator' }).save;
  time(
    'Simulate five years',
    () => {
      for (let y = 0; y < 5; y++) advance(fiveYear, { mode: 'year', maxDays: 366, stopOnDecision: false });
    },
    150000
  );
  time('Serialize a five year world', () => JSON.stringify(fiveYear), 4000, (s) => `${(s.length / 1024 / 1024).toFixed(2)} MB`);
  const results5 = Object.keys(fiveYear.history.results).length;
  results.push({ phase: 'Five year world size', ms: 0, detail: `${results5} fights, ${Object.keys(fiveYear.fighters).length} fighters` });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n${pad('PHASE', 40)} ${'MS'.padStart(9)}  ${'TARGET'.padStart(8)}  STATUS  DETAIL`);
console.log('-'.repeat(110));
let failures = 0;
for (const r of results) {
  const ok = r.target === undefined ? '' : r.ms <= r.target ? 'ok' : 'SLOW';
  if (ok === 'SLOW') failures++;
  console.log(
    `${pad(r.phase, 40)} ${r.ms.toFixed(1).padStart(9)}  ${(r.target ? String(r.target) : '').padStart(8)}  ${pad(ok, 6)}  ${r.detail ?? ''}`
  );
}
console.log('-'.repeat(110));
console.log(`${failures} phase${failures === 1 ? '' : 's'} over target.`);
console.log(`divisions configured: ${DIVISIONS.length}`);

writeFileSync(
  join(ROOT, 'docs', 'PERFORMANCE.json'),
  JSON.stringify({ measuredAt: new Date().toISOString(), quick: QUICK, results }, null, 2)
);
console.log('written to docs/PERFORMANCE.json');
