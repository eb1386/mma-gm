# Overnight expansion status

Living record of what is done, what was measured, and what is not done. Written to be read by
somebody who was not here, so it states limitations plainly rather than summarising favourably.

## Phase 0: baseline verification

Complete and green. Run at the start of this session against the current tree.

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| fast tier | 256 passed |
| flow tier | 171 passed |
| normal tier | 256 passed |
| world tier | 6 passed |
| `npm run build` | pass |
| `node scripts/check-dashes.mjs` | pass, 151 files |
| `node scripts/check-terms.mjs` | pass, 150 files |
| `npx playwright test` | 22 passed, desktop and mobile |
| `tools/score-calibration.ts` | release gate passes, 10-7 at 0.00 percent |
| `tools/perf.ts --quick` | 0 phases over target |
| `tools/acceptance.ts 4 1 0` | 5 runs, 0 metrics outside band |

Phase 0 checklist items verified by existing tests rather than by inspection alone:

- Accepted fights are not cancelled or re-offered: `flows.int.test.ts`, booking integrity.
- One camp per accepted bout: `flows.int.test.ts`.
- Fight day advancement stops for the player and resumes after the result: `advance-target` tests.
- Champions changing divisions vacate and leave the old ranking table: `matchmaking.int.test.ts`.
- No fighter booked twice: `matchmaking.int.test.ts`, year long invariant run.

Test tiers already exist and are already split, so no new work was required for the speed
item: `test:fast`, `test:flow`, `test`, `test:world`, `test:all`, `test:browser`. Slow world
simulations are already isolated in the world tier.

## What the expansion specification asks for that already exists

Audited by reading the modules, not by searching for keywords alone.

| Specification section | State |
| --- | --- |
| 5 Activity and career pacing | Implemented. `identity.ts` activity profiles, `willingToFight`, activity report. |
| 6 Personality | Implemented. `types/identity.ts`, generated per fighter, read by callouts, press, social. |
| 7 Fame and public identity | Implemented. Attention and approval are separate, labels derived. |
| 8 Social media and followers | Implemented. `social.ts`, per platform reach, growth and loss. |
| 9 Fight hype model | Implemented. `hype.ts`, four audiences, timeline. |
| 10 Media activities | Implemented. `presser.ts`, `fightweek.ts`. |
| 11 Trash talk, callouts, rivalries | Implemented, and connected to matchmaking this session. |
| 12 Fight week sequence | Implemented. `fightweek.ts` dated stages. |
| 13 Performance bonuses | Implemented. |
| 14 Event business | Implemented. `business.ts`. |
| 15 Sponsorships | Implemented. `finance.ts`. |
| 16 Managers | Implemented. `finance.ts`. |
| 17 Career finances | Implemented. Ledger backed. |
| 18 Weight management | Implemented, including one sided title eligibility via `titleIneligibleFighterIds`. |
| 19 Injuries and recovery | Implemented. `injury-flow.ts`, one decision per injury. |
| 20 Optional anti-doping | Implemented, abstract choices only. |
| 23 Fouls | Partly. Fouls, warnings and deductions are simulated; referees are anonymous. |
| 26 Matchmaking explanations | Implemented this session. Every bout stores a reason and a category. |
| 27 Championship calibration | Implemented and measured by `tools/acceptance.ts`. |
| 29 Records | Implemented. Milestones are not. |

## Not implemented, stated plainly

This was the state at the start of the session. Items 1 and 5 were completed during it and are
struck through; everything else remains genuinely absent, not partially built.

1. ~~Persistent official identities (section 22).~~ **Done this session.**
2. **Historical start dates and the historical data layer (section 3).** Not started. This is
   the single largest item in the specification and cannot be sourced compliantly without a
   licensed dataset. See limitations below.
3. **Feeder systems and prospect pathways (section 4).** Prospects are generated and signed,
   but there are no named pathways and no prospect identity track.
4. **Roster presets (section 1).** One roster shape exists. Presets are not implemented.
5. ~~Feature flags (section 32).~~ **Done this session.** The flags exist with defensive
   defaults, but note that only `persistentOfficials` and `antiDoping` correspond to systems
   that actually branch on them today. The rest are declared and stored, and reading them is
   safe, but no code path yet changes behaviour based on `historicalWorlds`, `womensDivisions`,
   `mediaDepth`, `businessDepth` or `detailedCommissions`. They are scaffolding for the
   sections that are still unimplemented, and should not be read as those sections being done.
6. **Milestones (section 29).** Records exist; the milestone list does not.
7. **Simulation detail levels (section 31).** Pot has tiered evaluation and caching already,
   but there is no full, standard and fast bout simulation split.
8. **Web worker for long simulations (section 31).** Long runs are synchronous.
9. **Referee tendencies are not fully wired (section 23).** `standUpTendency` and
   `foulStrictness` are generated, persisted and displayed, but the fight engine still reads
   only `stoppageTendency`. This is stated here rather than counted as complete.

## Work completed this session, after Phase 0

### Persistent officials, specification section 22 and part of 23

Complete: backend, migration, interface and tests.

- `src/core/world/officials.ts`. Judges and referees are persistent people in the save,
  generated once from the save seed so the same world always has the same officials. Each
  carries experience, title bout experience, grappling, damage and control leanings, 10-8
  willingness, hometown susceptibility, referee stoppage, stand up and foul strictness, and a
  history of bouts worked, split decisions and cards that were out of step.
- Assignment happens per bout, is stable, and draws a championship from the more experienced
  half of the pool. It is derived from the bout id and the save seed rather than the
  simulation rng, so assigning officials cannot move a fight result.
- `tenEightWillingness` is now read by `scoreRoundForJudge`. A persona without the field
  behaves exactly as before, which is asserted by a test.
- An outlier card is defined concretely: a card adrift of **both** colleagues by three points
  or more. My first implementation compared against the average of the other two, which flagged
  the two judges who agreed with each other whenever a third turned in a wide card. Caught by a
  test, fixed, and the corrected rule is asserted in both directions.
- Interface: judges and the referee appear on the fight page with their tendencies, linking to
  a new Officials page in the left navigation showing the roster, records and controversies.
- Migration 13. Completed fights keep the judge names already recorded on their scorecards,
  because reassigning a fight that has already happened would rewrite history. Only scheduled
  bouts receive an assignment.

### Feature flags, specification section 32

`FeatureFlags` with `featureEnabled(settings, key)` reading a defensive default, so a save
written before the flags existed behaves exactly as it did. `historicalWorlds` and `antiDoping`
default off as the specification requires; the rest default on.

### Two real defects found and fixed while doing the above

1. **Determinism break of my own making.** Supplying assigned judges skipped `drawJudges(rng)`,
   so the rng no longer advanced by the same amount and every subsequent draw shifted. That
   changed fight outcomes across the world and surfaced as the save round trip test failing on a
   camp week. The pool draw now always happens and its result is discarded when officials are
   supplied. I had guarded `refereeTendency` against exactly this and failed to apply the same
   reasoning to the judges.
2. **`advanceUntil` stops at the first player decision.** A test asking for 365 days of
   simulation was getting about six, because a career fixture blocks within days. The year long
   matchmaking invariant test I wrote earlier in this session was therefore far weaker than it
   claimed. `runWorld(save, weeks)` in `testing/fixtures.ts` answers what is blocking and keeps
   going. The invariant test now takes 4.3 seconds rather than 0.3 and still passes, which is
   the evidence that it is now doing what it said.

### Gate after this work

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| fast tier | 278 passed |
| flow tier | 171 passed |
| normal tier | 278 passed |
| world tier | 6 passed |
| `npm run build` | pass |
| dash and terminology guards | pass |
| `npx playwright test` | 24 passed, desktop and mobile |
| score calibration | release gate passes |
| `tools/perf.ts --quick` | 0 phases over target |
| `tools/acceptance.ts 4 1 0` | 5 runs, 0 metrics outside band |

22 new officials tests. Acceptance confirms the officials work did not move any world metric
out of band.

## Known limitations and conservative defaults taken

- **Historical data cannot be sourced compliantly in this environment.** The specification
  itself anticipates this in operating rule 10 and asks for the import architecture and
  clearly labelled partial datasets rather than fabricated data. No historical facts have
  been invented, and none will be.
- Multi seed balance runs use `tools/acceptance.ts` at 5 runs rather than the 20 five year
  seeds the specification suggests, because a 20 seed run takes far longer than the time
  available. The harness supports a larger count; only the count used here is smaller.
- No push, deploy or history rewrite has been performed in this phase, per the operating
  rules.

## Exact next task

Complete the persistent officials slice: roster, assignment, history, migration, interface and
tests. Then reassess the execution order against remaining time.
