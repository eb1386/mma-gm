# MMA GM

A free text based MMA career and management simulation for the browser. Real ranked roster,
a deterministic event driven fight engine, and a world that keeps running for decades.

The backend simulation is the product. There are no animated fighters, no 3D, no art
assets, and no placeholder screens.

---

## Quick start

```bash
npm install
npx vite-node tools/build-snapshot.ts    # build the playable roster snapshot
npm run dev                              # http://localhost:5177
```

A new career takes about 440 ms to build and reports its progress phase by phase.

The repository ships with a built snapshot in `public/data/`, so `npm run dev` works
immediately. Rebuild it only after re-running ingestion.

```bash
npm run test:fast     # 55 unit tests, about 3 seconds
npm run test:flow     # 166 unit, player flow, career flow and release tests, about 19 seconds
npm test              # 193 unit and integration tests, about 250 seconds
npm run test:world    # 6 multi year world simulations, about 13 seconds
npm run test:browser  # 12 Playwright checks on desktop and mobile
npm run test:all      # everything
npm run check         # dash guard, terminology guard, typecheck, unit and integration tests
npm run build         # production bundle
npm run perf          # phase by phase performance report
```

`npm run test:flow` is the practical pre commit suite: it covers the whole player flow in
under twenty seconds.

## Deployment

The app is a static single page build. `npm run build` writes to `dist/`.

It uses browser history routing, so any host must rewrite unknown paths to `index.html`.
`vercel.json` does that for Vercel. The equivalent on other hosts is a single rewrite rule
from `/(.*)` to `/index.html`.

```bash
npm run build
npm run preview       # serves dist/ on http://localhost:4173
```

Useful harnesses:

```bash
npx vite-node tools/calibrate.ts 3000     # batch fight engine calibration report
npx vite-node tools/sim-world.ts 5        # simulate five years of world history
npx vite-node tools/demo-fight.ts         # one fight with full commentary
npx vite-node tools/acceptance.ts 4 1 0   # multi seed balance report, about 15 minutes
npx vite-node tools/score-calibration.ts 1500  # scorecard distribution release gate
node tools/ingest/run.mjs                 # re-crawl the official source
```

---

## Data: what is real and what is not

This matters more than any other section, so it is stated precisely.

### The source

The only production source is the official UFC website. The ingestion crawler in
`tools/ingest/` reads `https://www.ufc.com/robots.txt` and obeys it:

- It honours the published `crawl-delay: 15`, literally. A full ingest takes about 33
  minutes for 128 athletes and cannot be sped up without violating the directive.
- It refuses every disallowed path. `Disallow: /athletes/all?*` covers the complete
  historical athlete directory, so that directory is never crawled.
- Responses are cached to disk, so a re-run costs zero requests.

**That robots rule is why the real roster is the ranked roster.** `/rankings` and
`/athlete/<slug>` are permitted; the full directory is not. The snapshot therefore
contains every champion plus the officially ranked one through fifteen in each of the
eight men's divisions and the three contested women's divisions: **176 real athletes, zero
fetch failures.** Women's Featherweight is configured as a division that is no longer
contested, so it correctly imports no roster and the build reports that as a note rather
than a warning.

UFCStats was evaluated and rejected as a production source: it now sits behind a
JavaScript proof of work bot wall. `UFCStatsAdapter` exists in the provider layer and
reports that capability as unavailable rather than pretending otherwise. No third party
API is described anywhere in this project as official.

### Value kinds

Every value in the game is one of six kinds, and the interface distinguishes them.

| Kind | Examples |
| --- | --- |
| **Sourced fact** | Name, nickname, height, reach, leg reach, listed weight, age, place of birth, professional record, wins by knockout and submission, activity status, gym affiliation, octagon debut, official ranking, championship status |
| **Derived rating** | The six performance ratings, produced by a documented, reproducible model from published rate statistics plus official standing |
| **Model estimate** | Pot, Longevity, wear components, popularity, style tendencies |
| **Simulated** | Every contract, purse, camp, injury, bout and result |
| **User created** | Anything entered on the Create a Fighter screen |
| **Unknown** | Anything the source did not publish |

Field level provenance is stored on every real fighter and is displayed on the fighter
page under **Data and sources**, including the source URL, fetch timestamp, confidence,
and the transformation applied.

Nothing is ever invented to fill a gap. Dates of birth are not published on athlete
profiles, so `birthDate` is `null` for every real fighter and the world ages them forward
from a sourced age. The snapshot's validation report counts every missing field.

**Contracts are always simulated.** Real fighter pay is not public. Every contract object
carries `isSimulated: true` and a visible note saying so. The game never presents a pay
figure as reported.

No copyrighted media ships with this project. No fighter photographs, no promotional
logos, no event posters. Event venue names are generated descriptive strings rather than
the trademarked names of real buildings.

### The simulated world never writes back

Creating a save copies a snapshot into it. From that moment the save's world is fictional.
Nothing simulated is ever merged into the canonical snapshot, and a live roster change
never mutates an existing career.

---

## What a career looks like

Twelve divisions. A rolling twelve months of about 45 events, 13 of them numbered cards,
each carrying 11 to 14 bouts across several weight classes, with about six weekends left
clear. Roughly 1.7 title fights per division per year, a champion defending about every six
months. Active fighters compete about 1.9 times a year and nobody exceeds four.

Beyond the six ratings, every fighter carries a personality, an activity profile, a fame
profile that separates attention from approval, social reach across four platforms, and a
set of derived public labels. Booked fights carry hype tracked separately for hardcore,
casual, regional and media audiences. Completed cards produce attendance, gate, pay per
view and profit figures, every one of them labelled as simulated.

None of it touches Ovr.

## Ratings

Every fighter has exactly six visible performance ratings on a 0 to 100 scale:

**Striking, Grappling, Wrestling, Submissions, Cardio, Durability.**

There is no seventh rating. Speed, power, chin, fight IQ, athleticism, takedown defense,
submission defense and every other commonly requested attribute is emergent, produced in
`src/core/sim/effective.ts` from those six blended against physicals, style tendencies,
game plan, camp state, fatigue, damage and position.

- **Ovr** is the plain arithmetic mean of the six. Never weighted. Never adjusted for
  record, ranking, popularity or championship status. There is a test that asserts this
  against 500 random rating sets.
- **Pot** is a projection of peak Ovr. It is produced by running the same development
  model forward many times with independent variation and taking a configurable
  optimistic percentile. It is not a skill, it does not pull ratings upward, and a fighter
  can fall short of it or exceed it.
- **Longevity** is remaining career resilience. It is never part of Ovr. It tracks six
  wear components internally and is shown as one number plus a plain language health
  report.

### How ratings are derived from real data

`src/core/data/ratings-pipeline.ts` combines two independent evidence channels.

1. **Performance channel.** Per minute and per fifteen minute rate statistics from the
   official athlete profile, normalized against division priors, then shrunk toward those
   priors by sample size using empirical Bayes. Cumulative cage minutes are recovered from
   the landed total divided by the per minute rate, which is far better sample evidence
   than a raw fight count. A fighter with two fights of evidence sits near the division
   mean no matter how extreme the raw numbers look.

2. **Results channel.** Official ranking and championship status. A ranking is the
   accumulated verdict on who a fighter has beaten, which is exactly the opponent quality
   information rate statistics do not carry. The compliant source does not expose bout by
   bout opponent data, so ranking is used as the opponent adjustment proxy and is
   documented as such rather than being passed off as something stronger.

Neither channel alone is trusted. Every calibration constant lives in editable config.

The resulting distribution across the 128 ranked fighters spreads properly rather than
clustering:

```
65-69: ##                                                       2
70-74: ##############                                          14
75-79: #######################################################  55
80-84: #######################################                 39
85-89: ##############                                          14
90-94: ###                                                      3
95-99: #                                                        1
```

---

## The fight engine

`src/core/sim/` is a deterministic, event driven simulation. The result emerges from the
simulation. No winner is chosen first, no language model is involved, and no single
weighted dice roll decides anything.

- **Explicit position state machine.** Standing at four ranges, open and fence clinch,
  eight ground positions plus scrambles, turtle, leg entanglements and knockdowns. Each
  position defines available actions, transitions, time cost, energy cost and referee
  intervention conditions.
- **Semantic events first.** The engine emits structured `FightEvent` records with actor,
  defender, position before and after, action, result, damage delta, stamina cost, score
  impact and importance. The narrative layer consumes those events. Commentary can never
  change what happened.
- **Opposed checks** resolve through a bounded logistic function on effective ability
  differences. Every constant is in `src/core/config/calibration.ts`.
- **Staged submissions.** Entry, secured, defense, adjustment, resolution. A submission is
  never one roll, and only a genuine attempt is recorded in the statistics.
- **A missed weight changes who can win the belt, not whether it is a title fight.** The
  bout records who forfeited their claim. The title goes to the winner only if the winner
  made weight, nobody who missed weight is holding it afterwards, and every other case
  leaves it vacant. Interim titles are a separate tracked lineage that unifies or is
  promoted.
- **Continuous cardio and damage.** Head, body, per leg, cuts, swelling, balance, joints
  and stun state, with partial between round recovery and real downstream effects.
- **Judging** implements the ten point must system with the criteria in order: effective
  striking and grappling first, aggression only when that is effectively even, cage
  control only when the first two are. Three judges each carry a small perception lean.
- **Fighter AI** reads only what a fighter could know. It never sees future random
  outcomes, and the opponent runs the identical code path.
- **Form on the night.** A per fight variance draw keeps a large ability gap from
  compounding into certainty, because upsets happen.

Calibration against a 6000 fight batch (`npx vite-node tools/calibrate.ts 6000`):

| Metric | Engine | Reference band | |
| --- | --- | --- | --- |
| Finish rate | 41.8% | 44% to 52% | below band |
| KO / TKO / SUB / DEC | 7.7 / 11.5 / 19.1 / 57.1 | roughly 10 / 22 / 15 / 50 | |
| Significant strikes per minute | 3.81 | 3.4 to 4.4 | ok |
| Takedowns per 15 minutes | 1.41 | 1.3 to 2.1 | ok |
| Submission attempts per 15 minutes | 0.61 | 0.4 to 0.9 | ok |
| Knockdowns per 15 minutes | 0.69 | 0.4 to 0.8 | ok |
| Average fight length | 13.0 min | 9.0 to 11.5 | above band |

The reference bands are the shape of publicly reported aggregate outcomes. They are
calibration targets for this engine, not claims about any specific promotion statistic.

**Two of them are missed and it is one fault, not two.** Too few fights end early, so too
many go to the scorecards and the average length runs long. Submissions carry more of the
finishing than knockouts and technical knockouts do. In a full simulated world the finish
rate measures 41.5 percent, inside the wider band the acceptance harness uses, so this
shows up as a calibration gap rather than as a broken world. It is listed in
`docs/STATUS.md` as outstanding, and it is the largest single piece of balance work left.

---

## Determinism

Every random outcome comes from a seeded xoshiro128** generator whose four word state is
serialized into the save. The same seed with the same decisions reproduces the same world,
the same cards and the same fights event for event. `Math.random` is not called anywhere in
`src/core`. There is a test that builds two worlds from one seed, advances both, and
asserts that every result matches.

Each fight's own seed is shown on its statistics tab.

---

## Architecture

```
src/core/               simulation, no React, no DOM
  rng.ts                seeded generator and maths helpers
  config/               divisions, builds, calibration, difficulty (all editable data)
  types/                domain model
  sim/                  fight engine: state, effective ability, actions, AI, judging
  narrative/            compositional commentary with anti-repetition
  data/                 provider interface, adapters, rating pipeline, snapshot
  world/                calendar, matchmaking, rankings, camps, health, economy,
                        gyms, development, history, the tick loop
  save/                 IndexedDB persistence and schema migrations
src/ui/                 React interface, compact tables, no simulation logic
tools/                  ingestion crawler, snapshot builder, calibration harnesses
scripts/                repository guards
```

The dependency direction is strict: `ui` imports `core`, never the reverse.

---

## Game modes

- **Play as a real fighter.** Any of the 128 ranked athletes, with their sourced identity,
  physicals, record and standing preserved at the save date.
- **Create a fighter.** Fair point allocation with six presets, meaningful builds, and a
  country that affects naming, home market popularity, travel and nearby gyms but never
  grants a biological or skill bonus.
- **Coach mode.** Run a gym. You advise rather than command. Fighters can refuse a plan,
  take a fight against your advice, object to hard sparring or favouritism, ask for a
  different corner, change divisions, and leave. There is no single victory condition.
- **Spectator.** Control nobody and watch decades of world history unfold.

---

## Repository guards

`npm run check` fails the build on:

- **Any Unicode em dash.** `scripts/check-dashes.mjs` scans every source, documentation,
  data and template file for U+2014 and four look alike characters that would defeat the
  intent of the rule.
- **The long form of Ovr or Pot.** `scripts/check-terms.mjs` enforces the abbreviations
  everywhere, including in identifiers. Both guards caught real violations in this
  codebase during development, including a struct field name and a test fixture.

Save schema is at version 6. Every version has a migration and old saves keep opening.

---

## Documented decisions

- `docs/STATUS.md` is the honest account of what is built, what is partial, and what is
  not built at all, phase by phase.
- `docs/PERFORMANCE.md` has the phase by phase timings and what produced them.
- `docs/ACCEPTANCE.json` holds the raw multi seed balance numbers.

See `docs/DESIGN.md` for the resolution of every technically ambiguous requirement,
including why the real roster stops at the rankings, how contracts are handled without
public pay data, how weight cutting is modelled without becoming a spreadsheet chore, and
how a decades long save is kept from growing without bound.


---

## Unofficial

MMA GM is an unofficial fan-made MMA simulation. It is not affiliated with, sponsored by, approved by, or endorsed by UFC, Zuffa, UWFS as a real organization, or any fighter represented in the game. UWFS is a fictional promotion used by the simulation.

No UFC trademark, logo, promotional artwork, event poster or fighter photograph is included
in this repository. Every visual asset is original.

The simulated promotion is the **Unified World Fight Series (UWFS)**. Generated cards are
named `UWFS 300` and `UWFS Fight Night 84`, and championships are `UWFS Lightweight
Champion`. Where the documentation refers to UFC it is describing the real world source of
factual roster data, never the promotion the game simulates.

See `ATTRIBUTION.md` for the full data and sourcing statement, and `LICENSE` for the
software license.
