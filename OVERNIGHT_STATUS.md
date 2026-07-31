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


---

# Full audit and improvement pass

A twelve area parallel audit followed by a second five area wave, each finding adversarially
verified by an independent agent instructed to refute it. 49 agents in the second wave alone.
Findings were applied centrally rather than by the agents, so the systems stayed coherent.

## Confirmed defects fixed

### Title shots and contenders
- Winning a title eliminator conferred nothing. The category was a label on the bout that no
  later code read, so the promise that winning it puts you next was never kept. `contender.ts`
  is the earned, forfeitable claim, and it is the highest input to `titleShotEligibility`.
- A champion promised a championship bout on changing division received a non title fight,
  because `matchup-pass.ts` hardcoded `isTitleFight: false`. The move now grants a real claim.
- The claim was consumed when a title bout was created, so a player who declined lost the
  position they had earned. It is consumed on acceptance and restored if the bout is cancelled.
- Granting a claim froze the division: `rankChallengers` builds its pool from the ranked table,
  and a champion arriving from another division is unranked by definition.
- Vacant and interim championships became unbookable, because they need two eligible fighters.
- A unification bout could be blocked by a claim earned afterwards.
- An eliminator winner from another division could take a claim they had not earned there.

### Matchmaking
- Loss streaks, championship history, strength of schedule and promotional momentum were not
  considered at all. All four are now inputs, with every weight named in `config/matchmaking.ts`.
- `findReplacement` re-implemented availability and would book a commission suspended, anti
  doping suspended or out of contract fighter. It now uses the shared gate.
- A reigning champion could be booked as short notice cover with no turnaround gate.
- Choosing the best opponent and then discarding the pairing when it turned out to be an
  undefendable champion threw the seeded fighter's card slot away.
- Card seeding could create a second championship bout for a belt already booked.
- A title offer made last week did not stop a second being created for the same belt.

### Rankings
- The points ledger and the fifteen slot display list were the same object, so a fighter who
  dropped out had their entire results history erased and restarted from zero.
- A fighter could be ranked below somebody they had just beaten. `applyHeadToHead` corrects it
  in bounded passes.
- The permanent ledger could accumulate unbounded negative totals with no way back.

### Fight simulation
- `roundImpact` read the damage fields with the opposite convention to `trueRoundScore`, so the
  damage term clamped to zero for a dominant winner and contributed nothing to a wide round.
- Round scoring was fed cumulative fight damage while the stat lines reset each round.
- The 10-10 early return skipped an rng draw, so toggling a scoring setting changed fight
  outcomes. This is the third instance of that class of bug found in this codebase.
- Doctor, corner and retirement stoppages were recorded as decision wins, contradicting
  `isFinish` and every finish rate derived from it.

### Career loop
- Fight week read its blocking flag from the first pending stage rather than the first mandatory
  one, so an optional stage at the front let the calendar walk past a due weigh in.
- The official weigh in was simulated again at fight time and overwrote the ruling the player was
  shown, including a second attempt they had taken.
- A weigh in ruling that cancelled the bout left it scheduled, so the fight happened anyway.
- Releasing a booking left the camp running against a fight that no longer existed.
- A camp could run past its planned length.
- Training camps were never charged for.

### Interface
- The Career page primary action navigated to the dashboard for any action that was not a
  navigation, so the main button did nothing whenever the next step was to advance time.
- Four buttons consumed randomness without writing the advanced state back, so repeating them
  produced the same result forever.
- `mutate` bumped a revision counter that only three of twenty four pages read, so most pages
  showed stale state after an in page action.
- The camp cost estimate called `createCamp` during render, incrementing a persisted counter.
- The Settings save button showed a success message and wrote nothing.
- Social posting was an unlimited button with no downside; going quiet counted as posting and
  cancelled the decay it was supposed to cause.
- The dashboard counted actionable inbox items with its own predicate and contradicted the badge.
- The weekly headline named the opening preliminary winner as the main event winner.

### Test infrastructure
- The browser suite served a prebuilt `dist` without building, so it could pass against code
  that no longer existed.
- `advanceUntil` stops at the first player decision, so a test asking for a year of simulation
  was getting about six days.

## Balance values now exposed as configuration

See the table at the end of `docs/INTEGRATION-MAP.md`.

## Honest notes

- One audit agent overwrote `src/core/world/matchmaking.ts` mid session and reverted it to a
  partial state, losing that file's edits. They were reapplied and verified item by item. Agents
  in future waves should be read only.
- The activity bands are measured over the final twelve months of a three year run across three
  seeds. Classifying by tier at the end of a run and counting every fight ever had was the first
  measurement, and it was wrong.
