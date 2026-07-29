# Performance

Measured with `npm run perf` (add `--quick` to skip the multi year phases). Raw numbers
are written to `docs/PERFORMANCE.json` on every run.

Machine: Apple Silicon laptop, Node 25, single process, no worker.

## Career creation and load

| Phase | Before | After | Target | Status |
| --- | --- | --- | --- | --- |
| Load snapshot index | 0.3 ms | 0.3 ms | under 1000 ms | ok |
| Read snapshot from disk | 4.6 ms | 4.6 ms | under 1000 ms | ok |
| Parse snapshot JSON | 7.8 ms | 7.8 ms | under 1000 ms | ok |
| New career, Spectator Mode | about 37 s | **440 ms** | under 5000 ms | ok |
| New career, Fighter Mode | about 37 s | **410 ms** | under 5000 ms | ok |
| New career, Coach Mode | about 37 s | **407 ms** | under 5000 ms | ok |
| New career, reduced performance mode | not available | **10 ms** | under 2000 ms | ok |

Career creation is roughly **85 times faster**. The work is unchanged in kind; what changed
is how much projection work it does and how often it repeats it.

## Advancing time

| Phase | Time | Target | Status |
| --- | --- | --- | --- |
| Advance one day | 0.4 ms | under 200 ms | ok |
| Advance one week | 103 ms | under 1000 ms | ok |
| Advance one month | 176 ms | under 3000 ms | ok |
| Advance to next event | 141 ms | under 2000 ms | ok |
| Annual Pot refresh, cold | 1065 ms | under 3000 ms | ok |
| Annual Pot refresh, warm | **1.4 ms** | under 500 ms | ok |
| Simulate one year | about 21 s | | |
| Simulate five years | about 110 s | | |

## Serialization

| Phase | Time | Detail |
| --- | --- | --- |
| Serialize save to JSON | 22 ms | 4.6 MB after one month |
| Parse save from JSON | 20 ms | |
| Migrate a loaded save | 19 ms | |
| Serialize a five year world | about 300 ms | about 25 MB |

## Test suite

| Tier | Command | Contents | Time |
| --- | --- | --- | --- |
| Fast | `npm run test:fast` | 55 unit tests | **4.8 s** |
| Normal | `npm test` | 82 unit and integration tests | 393 s |
| World | `npm run test:world` | 6 multi year simulations | **21 s** |
| All | `npm run test:all` | everything | about 420 s |

The fast tier meets the under ten seconds target. The world tier fell from 360 seconds to
21 seconds purely from the Pot work. The normal tier is dominated by the integration
flows, which deliberately run multi year worlds because that is the only place the
invariants they check can be violated; it is above the sixty second pre commit target and
is listed in the honest remaining work.

## What made the difference

**Tiered Pot projection.** Running a full fidelity twelve year projection for every fighter
was the single dominant cost, in career creation and in the test suite. It is now tiered by
how much the answer matters, from 90 paths for the player down to 6 for a veteran and none
at all for a retired fighter, and the projection walks the career in fortnightly to
quarterly steps rather than weekly ones. Deterministic terms scale linearly with the step
and the random term scales with its square root, so a quarterly step produces the same
expected path and the same spread as thirteen weekly steps.

**Pot caching.** The projection is cached against a key holding the ratings hash, age,
Longevity band, wear band, gym quality band, development profile and model version. The
annual refresh is 1065 ms cold and 1.4 ms warm, because only the fighters whose inputs
actually changed are recomputed.

**Constant time availability.** The open offer check introduced during stabilization
scanned every offer inside a per candidate loop, which is quadratic in a long save. The
open offer set is now built once per booking pass.

**Simulation detail levels.** Every fight runs through the same engine, so outcomes are
identical at every level. What changes is what is written down. Player fights, title
fights and main events keep everything; ranked and main card fights keep major events;
background preliminaries keep the result, totals, scorecards and a recap. This cut the
one month save from 7.4 MB to 4.6 MB.

**Real history pruning.** The first pruning pass replaced old round statistics with zeroed
objects, which serializes to almost the same number of bytes. Deleting the properties
instead took a five year world from 41 MB to about 25 MB.

## Not done

- No Web Worker. Career creation at 440 ms and a year advance at 21 seconds are both
  inside what a single frame budget can absorb with a progress panel, so the worker was
  not the highest value remaining work. The creation path already reports phase progress
  and supports cancellation, which is the part a worker would have been for.
- The normal test tier is 395 seconds rather than the 60 second target.
- No chunked IndexedDB layout or compressed export. Saves are written whole.
