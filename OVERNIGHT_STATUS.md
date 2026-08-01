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


---

# Third audit wave and finding closure

Three audit waves in total: twelve areas, then five, then five more reviewing everything the
earlier waves had caused me to change. 140 agents. Every finding attacked by an independent
agent instructed to refute it. Wave three returned 43 findings of which 30 survived refutation.

## The pattern worth recording

**Most of wave three's criticals were caused by wave two's fixes.** Not carelessness in the
usual sense: each fix was locally correct and globally wrong, because this codebase has a small
number of invariants that are not obvious from any single file.

- **Money has two representations.** `save.player.balance` and `save.finance.cash`, reconciled
  only inside `record()`, which assigns one from the other. Any write touching one side is
  silently reverted by the next ledger write. Making the player eligible for a performance bonus
  exposed a money bug that had been unreachable, and three more of the same kind were already
  there: social fines, the contract signing bonus and camp life payments. There is now a test
  that fails if any production file writes either field directly.
- **RNG must be consumed unconditionally.** Putting a call behind a feature flag or a setting
  looks like gating a feature and is actually gating a draw, which shifts every later draw and
  changes the whole world. I did this twice in one session, to `businessDepth` and to
  `injuriesEnabled`, having already fixed the same class of bug twice before. Both now always
  run and the flag decides what is kept.
- **A React store that mutates in place needs every publisher to republish.** Fixing `mutate`
  and not `runOperation` left the same staleness after every time advance.

## What changed since the last section

Every one of the 44 wave two findings and the 30 confirmed wave three findings has been either
fixed or, where the honest answer was that a control could not work, removed with accurate copy
in its place. Highlights beyond the list above:

- A fighter who has earned the next title shot is reserved from ordinary card seeding, so the
  claim cannot be spent on filler before the title pass reaches their division.
- A champion holding a belt in a division they have left is no longer booked to defend it there.
- NPC champions who change division get the same treatment as the player's.
- The weekly title pass now applies the same repeat meeting limit as ordinary matchmaking.
- Gym purse share was credited in two consecutive monthly settlements.
- A judge reluctant to score 10-8 could never score one at all, because the willingness divisor
  put their threshold above the ceiling `roundImpact` can produce. It is a bounded offset now.
- Camp form's positive half was clipped away by the final clamp, so only the penalty reached the
  cage. A good camp now closes part of the gap to a perfect one.
- One fighter could take both Fight of the Night and Performance of the Night for one fight.
- `opponentFocus` was still inert after being wired, because the opponent's camp is finalized at
  the start of fight week, before any press conference happens.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| fast | 340 passed |
| flow | 171 passed |
| world | 6 passed |
| `npm run build` | pass |
| dash and terminology guards | pass |
| `npx playwright test` | 32 passed, desktop and mobile, all 23 navigation sections |
| `npm run activity:bands` | champions 1.57, top 2.56, ranked 2.51, unranked 2.38, all in band |
| `npm run calibrate:scores` | 93.74 / 6.26 / 0.00, gate passes |
| `npm run perf -- --quick` | 0 phases over target |
| `npm run acceptance 4 1 0` | 0 metrics outside band |

## Still true and worth saying plainly

Three waves each found real defects in the work of the wave before. That rate is falling, but it
has not reached zero, and a fourth wave would be the honest way to find out whether it has. The
gates are green and the finding list is closed; that is a stronger claim than the last section
could make and still not the same as proof that nothing is left.


---

# Fourth wave

Run specifically to find out whether the defect rate had reached zero. It had not.

34 agents across five areas: three checking one invariant each exhaustively, two reading the core
and the player's week with fresh eyes and no reference to earlier findings.

## What it found that three previous waves and my own mechanical checks had missed

**Two more instances of the RNG invariant, and a guard test too weak to see them.** I had written
a test that looked back twelve lines from each draw for a settings conditional. Both remaining
offenders sat inside conditionals that opened further above, so the guard passed while the defect
was live. The guard now tracks brace depth and finds a draw anywhere inside a guarded block, however
long. That is five separate instances of the same invariant in one codebase, four of which I
introduced or missed while explicitly trying to prevent it.

**Three settings controls that were read by nothing.** The playback speed, the exact live judge
scores and the projection path budget were all stored and all ignored. A control that changes a
value nobody reads is worse than no control, because it tells the player they have changed
something. All three now do what they say, and a test fails if a setting is added without a reader.

**A weigh-in withdrawal that did not withdraw.** `withdraw-medical` returns before the finalisation
that cancels the bout, so the player was told the fight was off and then fought on the night. This
is the second instance of that exact shape; the first was fixed in wave two, in the same file.

**A forfeited purse deducted from one fighter and paid to nobody.** Accepting an opponent's missed
weight cost the player the inconvenience and paid them nothing.

Also: fines were charged through the ledger and subtracted from career earnings again; the fight
purse used a hard coded eight percent gym cut while every other path read the gym's agreed rate;
the ranking ledger was never cleared on a weight change; refusals were a lifetime counter treated
as a recent one; and staying out of a gym dispute was the only choice in the game with no
consequence at all.

## Gate after wave four

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| fast | 343 passed |
| flow | 171 passed |
| world | 6 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 32 passed, desktop and mobile |
| activity bands | champions 1.57, top 2.56, ranked 2.51, unranked 2.38, all in band |
| calibration | 93.74 / 6.26 / 0.00 |
| perf | 0 phases over target |

## The honest read on four waves

Each wave found real defects in the previous wave's work. The count fell across the four, and the
character changed: wave one found systems that were not connected to anything, wave four found a
guard test that was not strict enough. That is the shape of converging work rather than of a
codebase in trouble.

It is not proof that nothing is left. Three of the four automated invariant guards now in place
exist because a wave found something I had already tried to prevent by hand, which is the strongest
argument for having them and the clearest evidence that hand checking was not enough.


---

# Fifth pass, the remaining loose ends

Wave four had left a list of lower severity findings unaddressed. Working through them line by
line turned three of them into real defects rather than tidiness.

**Debt was a high water mark, not a balance.** It recorded the deepest overdraft a career ever
reached and never came down. Net worth subtracted it from cash forever, so a fighter who dipped
fifty thousand into the red once and then earned two million was shown as carrying that shortfall
for the rest of their life, and their retirement security was graded on the lower figure. Debt is
now the negative part of cash, which is what the money page always claimed it was.

**The money breakdown was summed from a pruned ledger.** The ledger keeps recent detail and drops
the rest, so the earnings and expenses breakdown quietly lost a career's early years while the
career totals printed directly above it kept counting. The two disagreed, on the same screen, with
no way to tell which was right. The breakdown now comes from running totals that pruning cannot
reach, and a test asserts the two agree.

**Difficulty froze matchmaking.** The difficulty bias returned a fixed index into the scored
candidate list, so on any setting other than normal, every matchup the player was offered was the
single same choice, and the draw that keeps a long save varied was skipped entirely. Six seeds
produced one distinct opponent. It now shifts which slice of the list is drawn from, so the bias
still makes harder difficulties hand out worse assignments while variety survives at every
setting. Measured: mean assignment score 67.4 on easy against 54.1 on brutal, with six distinct
opponents rather than one.

Also: gyms are now credited for the fighters they get ranked rather than only for belts, and the
count is shown where champions produced already was; `effectsAppliedOn` is read by the
idempotency guard instead of only being written by it; the persisted career state is shown on the
save list, including how long the career has been in that state, which is the one thing the live
recompute cannot work out; and `linkedStageId` was removed, being a link field no writer could
ever set.

A sweep of every field declared on the persisted types found no other case of something declared
and read but never written.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| default tier | 349 passed |
| flow | 171 passed |
| world | 6 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 32 passed, desktop and mobile |
| activity bands | 1.57 / 2.56 / 2.51 / 2.38, all in band |
| calibration | 93.74 / 6.26 / 0.00 |

Bands and calibration are unchanged to the decimal, which is the expected result: the matchmaking
change is a no-op at the default difficulty and only alters the biased path.

Save schema is now 20. Two migrations were added, both of which repair existing saves rather than
only accepting them.


---

# Sixth pass, verifying the fifth

Every wave so far has found defects caused by the previous wave's fixes, so the fifth pass was
verified the same way: four reviewers, each given one part of the diff and told to be adversarial.
They found seven things. Three were mine, from the day before. Two were older and worse than
anything the wave was looking for.

**A real payment could vanish, and had been able to for the life of the project.** The ledger id
was built from the ledger's own length, and pruning is the one thing that shortens it. After the
first prune the counter walked back over numbers that surviving entries already held, so the next
payment of the same kind on the same day collided with a retained entry and was silently dropped:
no ledger line, no cash movement, no career total, while the caller was told the money had gone
out. The guard that dropped it could never have caught a genuine repeat either, because a
successful write changes the length and therefore the id, so the only behaviour it had was the
false positive. The sequence now lives on the save and only ever rises.

**Champions produced counted title bouts, not champions.** It incremented on every title fight
won, so a champion with five defences added six to their gym's total on their own, and an interim
bout counted as well. It is now credited once, when a fighter first takes a belt. This mattered
more after the fifth pass, which put a second counter next to it in three panels.

**The new gym counter was zero on every new game.** The live counter fires the first time a
fighter is ranked, and every fighter imported from the snapshot already carries a highest ranking,
so it never fired for any of them. A gym with twelve ranked fighters read zero. Worse, a save
migrated from an older build got all of them credited, so two saves of the same world disagreed by
a hundred and fifty five. The rule is now one function used by the migration and by world
creation alike, called after gym affiliation is settled rather than before.

**The difficulty fix from the day before was wrong twice more.** Capping the adjustment made the
two hardest settings identical for any gap past twelve rating points, which is the same dead
setting problem in a new place. Bounding the finished product instead compressed the difference
between a strong candidate and a very strong one at exactly the settings that care about it most,
which made the hardest setting less discriminating than the one below it and was caught only
because the test averages over several careers. The gap is now bounded before the bias scales it,
which keeps the shape identical at every setting.

Also: the marker that records a decision's consequences as applied is now written by every path
that applies them and read by the repair pass as well as the guard, so a half applied decision
cannot leave a career unadvanceable; the career state has a defensive default so the save list
cannot meet a save without one; the money page no longer claims the breakdown is derived from the
ledger, which stopped being true when it moved onto running totals; and the migration that seeds
those totals no longer overwrites them, per this file's own contract that every step is safe to
re-run.

## What the sixth pass says about the fifth

Three of the seven findings were introduced the day before, by fixes that were themselves correct
in intent. That is the same pattern as every previous wave and it is the honest argument against
declaring this finished by inspection: the work that introduces defects is the work that fixes
them.

The two oldest findings, the ledger id and the champion counter, had survived five waves. Both
were found only because a reviewer was pointed at a small diff and told to be hostile to it, not
because anything in the test suite noticed. Both now have tests.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| default tier | 354 passed |
| world | 6 passed |
| flow | 171 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 32 passed, desktop and mobile |
| activity bands | 1.57 / 2.56 / 2.51 / 2.38, all in band |
| calibration | 93.74 / 6.26 / 0.00 |
| perf | 0 phases over target |
| acceptance | 5 runs, 0 metrics outside band |

The save round trip caught one of my own fixes on the way through: a defensive repair added a key
to a save that did not have it, so a spectator career no longer reloaded byte for byte. The
counter is now created with the world instead. That test earning its place is worth recording.

Save schema is 21. Three migrations were added across the two passes, all of which repair existing
saves rather than only accepting them.


---

# Seventh pass, part one: what five years of simulation says

The world tier tested one simulated year. A career is meant to last several, and the invariant
test never asserted the one rule the whole rating model rests on. A five year invariant run was
added that checks the Ovr identity on every stored snapshot, that a fighter is ranked in exactly
the division they compete in, that a belt is held by at most one fighter and booked into at most
one live bout, and that the collections which are supposed to close do not accumulate for ever.

It failed twice on the first run.

**A career peak lower than the current rating.** `peakOvr` was updated only in the fight result
path, so it was sampled on fight nights and nowhere else. A fighter who improved through a camp
and then declined never had that improvement recorded, and the figure the fighter page calls a
career peak could sit below the rating printed beside it. It is now one helper called from every
path that changes ratings.

**Two champions in one division.** The champion flag was cleared in six separate places, each
handling the case in front of it: a title changing hands, a champion stripped for inactivity, an
interim promoted, a doping sanction, a division move, a weight class change. A path none of them
covered left a deposed champion still flagged. Over five simulated years two divisions ended with
two fighters each flagged as champion, while the ranking tables named only one. Rather than add a
seventh place that would have to be remembered next time, the flags are now reconciled from the
tables once a week and again on load. The tables are the record; the flags are a convenience for
pages and matchmaking, and they now derive from the record rather than being maintained beside it.

Both were invisible to six previous waves and to every existing test, because nothing simulated
far enough or asserted the right thing.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| default tier | 354 passed |
| world | 7 passed, now including a five year run |
| flow | 171 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 32 passed, desktop and mobile |
| activity bands | 1.57 / 2.59 / 2.56 / 2.38, all in band |
| calibration | 93.74 / 6.26 / 0.00 |
| acceptance | 5 runs, 0 metrics outside band |


---

# Seventh pass, part two: the six systems nobody had attacked yet

Waves one to six had audited the code, and wave six had attacked the previous wave's diff. Nothing
had yet taken one player facing system at a time and tried to break it. Seventy two agents did
that across fight week, social and callouts, navigation and the store, contracts and offers,
progression and retirement, and championships and weight class. Every finding was then handed to
two independent skeptics, each told to refute it and to default to refuted.

Forty two findings. Four refuted. What follows is what survived.

## The five that mattered most

**Pot was projected for a child.** The projection walked a fabricated calendar starting in the
year 2000, and the development model derives age from the birth date whenever there is one, so
every real fighter was projected forward as a two to fourteen year old. Growth ran at its maximum
and the aging decline never applied at all, for the entire roster, for the life of every save. It
now projects from the real date. Measured afterward: fighters under 26 carry 6.8 points of
headroom above their current rating and fighters past 31 carry 0.05, which is what a Pot model
is supposed to say and the opposite of what it said before.

**A released player could never come back.** Refusing four fights got the contract terminated,
which set its status to released. The renewal pass only ever looked for expired. Nothing else in
the game approached a released fighter, so the career was over, permanently, while the career
screen said a new offer would arrive within a month. The promotion now comes back after most of a
year, signing lifts the released status, and the screen says what is actually happening.

**Answering a callout did nothing at all.** Accepting, refusing, answering respectfully or in
kind: all four set a label on the callout and returned a sentence. No relationship moved, no
rivalry moved, and above all no matchup interest was created, which is the record that actually
makes the fight happen. Meanwhile the promotion's own path for an opponent answering did all of
it. Both sides now run the same function.

**Every Coach Mode inbox decision was a no-op.** The page routed gym and career decisions to the
core, the core handler fell through to the camp life code, and the camp life code returns
immediately when the player manages no fighter of their own, which in Coach Mode is always. The
code that actually implemented those decisions sat in the same page in a switch nothing could
reach. It now lives in the core, where the transaction runs it, and the unreachable copy is gone.

**A belt could change hands in a fight the champion was not in.** When a champion withdrew, the
replacement rule only asked whether the incoming fighter was ranked highly enough, never whether
the fighter who left was the one holding the belt. Two challengers then fought for the title and
the winner was crowned while the champion was still champion. The bout is now stripped of the
title when the champion is the one who withdrew, and the contender whose claim was spent on it
gets the claim back.

## The rest

Sixteen more, all of the same character: something the game told the player it was doing, and
was not. A press conference answer labelled "escalates the rivalry" moved no rivalry, and the
faceoff then gated its confrontational option on a rivalry the player had no way to create. The
faceoff itself read three of the six effects it declared, so the fine it warned about never
happened. Offering a larger purse forfeit at the weigh in cost ten percent of the show purse and
was never put to the other camp. A camp at another gym quoted the home gym's price and charged the
visiting gym's, which could be six times more. A canceled bout left fight week running, so the
page went on offering the faceoff and then Enter fight, and fighting it wrote a real result.
Points on the pay per view were negotiated, displayed on the contract, and paid to nobody. A
negotiated five round bout was reset to three by the card ordering pass. Asking for more money
accepted any number below the ceiling, including a smaller one, and cut the purse while reporting
an increase. Beating an interim champion scored as beating an unranked fighter. No NPC champion
ever carried their standing into a new division, because the check for whether they were champion
was computed after the code that cleared both of its inputs. Automatic weight class movement
stepped by division order with no gender check, so a heavyweight could be moved to Women's
Strawweight. A champion with a title defence already booked could be stripped for inactivity days
before the fight. Nothing ever stripped an interim champion, and the stale pointer blocked the
division from ever crowning another. A move billed as "one fight at the new weight" never moved
anybody back. Rivalry intensity only ever rose. Arriving four days early was byte identical to not
arriving early. A camp near the event cost 1.8 times a home camp for a benefit no code delivered.
Skipping an optional obligation was free, under a line saying it costs attention and goodwill. The
ceremonial weigh in and the faceoff were the same screen shown twice with the effects applied
twice. Injuries computed and stored exactly what a bad knee takes away and nothing read it.
Deleting the loaded career could resurrect it, because clearing the save flushed the write that
had been queued for it. The number one contender position, the thing this whole body of work
started with, was not displayed anywhere in the game.

## What this says

Seven waves in, a pass aimed at systems rather than at code found forty two things, five of them
serious enough to break a career outright. That is not a codebase converging on done. It is a
codebase whose defects had moved: the earlier waves fixed what was wrong with the code, and this
one found what was wrong with the game. The difference between those two is most of this list.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| default tier | 363 passed |
| world | 7 passed, including the five year run |
| flow | 171 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 36 passed, desktop and mobile, now covering the modes with no player fighter |
| activity bands | 1.50 / 2.53 / 2.57 / 2.36, all in band |
| calibration | 93.74 / 6.26 / 0.00 |
| acceptance | 5 runs, 0 metrics outside band |

One test had to be widened rather than satisfied: the difficulty ordering was asserted over three
careers, and the gap between neighbouring settings is under a point, so a single unlucky draw
inverted it. Measured over eight careers the ordering is clean and monotonic, at minus 13.59,
13.14, 12.25 and 11.64 Ovr points relative to the player across easy, normal, hard and brutal. The
test now samples what was actually verified.


---

# Eighth pass, and the things the player found

The eighth wave verified the seventh: 52 agents, 46 verdicts, 15 refuted, 31 confirmed, which
consolidated to 16 distinct defects in the previous day's work. One of them was mine from a
careless regular expression: removing a dead field also deleted the deliberate starting reputation
on a player founded gym, so a gym opened that morning was as well regarded as one that had been
running for years.

The two that mattered most were both cases of a fix that did not actually run. Points on the gate
were paid from the per bout loop, and the night's buy figure is not computed until the card closes,
so the payment read a record that did not exist yet and paid zero to everyone: the fix from the
day before was inert. And injuries carried into a fight were being counted twice, because the
engine has always modelled them by area and severity and the new code subtracted a second stored
rating map on top. That map is now gone; one model, not two.

Also from the wave: released NPCs re-entered the contract renewal pass every week and were
re-released, pushing an identical news item every Monday until the world's history was nothing but
release notices; the one fight weight move was guarded on a status no code ever writes, so it was
unreachable and the move was permanent after all; the stale interim strip ran after the champion
strip, so a stale interim was promoted to undisputed instead of being vacated; the larger purse
forfeit at the weigh in had become strictly worse than accepting the miss; room decisions acted on
fighters who had already left the gym and told the player they had agreed to stay; the skip
penalty was erased by the next hype recompute; and no NPC champion could ever move weight, because
the damping put every champion below the candidate threshold, which made the double champion path
unreachable for anyone but the player.

## What the player reported, and what was actually wrong

Four things came back from playing rather than from auditing. Every one was real.

**The camp focus sliders did nothing.** They were six independent weights, and the percentage
beside each was that weight over their total, so every slider at the top gave exactly the same
camp as every slider at the bottom. They are shares of one camp now: moving one takes its time
from the others in proportion, and the six always add up.

**A champion who lost the belt became unranked.** A champion is deliberately kept out of the
ranked entries while they hold the title, so their points sit frozen for the length of the reign.
Rejoining on that stale total could drop them out of the fifteen entirely. A fighter now re-enters
at number three or better however the reign ended. Measured over three simulated years: 24 title
changes, zero deposed champions unranked.

**Notifications did not stop the clock.** Advancement only halted for messages that demanded an
answer, so a camp report or a fight week stage opening arrived silently while the weeks rolled on,
and even when it did stop it sent the player to an action page rather than to the inbox.

**The matchmaker made fights nobody would make.** Every mismatch rule was a score penalty rather
than a refusal, and a penalty only picks the best of the legal fights, so when a division ran thin
a mismatch was the best available and got booked. Measured over one simulated year: 17 of 173
scheduled bouts, one in ten, were a top five fighter against an unranked opponent, five of them
against a losing record, including a number one contender against a fighter at two and two. Three
pairings are refused outright now, and the same measurement gives 2 of 169, both defensible. A
live callout is exempt, because that is the stated reason an unusual fight gets made, and an
agreed callout now produces the fight rather than entering a weighted draw it could lose.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| default tier | 371 passed |
| world | 7 passed, including the five year run |
| flow | 171 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 36 passed, desktop and mobile |
| activity bands | 1.28 / 2.50 / 2.37 / 2.50, all in band |
| calibration | 93.74 / 6.26 / 0.00 |
| acceptance | 5 runs, 0 metrics outside band |

The bands moved with the matchmaking gate, which is what they are for: champion activity came down
and unranked activity went up, because the fights that used to be given to unranked fighters
against contenders are now made between unranked fighters instead. All four stayed inside their
bands.


---

# The camp focus control, properly this time

The first attempt at this fixed the arithmetic and left the control alone, and the player came
back and said it was still broken. They were right, and the detail in their report was the answer:
"it changes number instead of sizes".

A range input renders the same physical width whatever its value. The thumb slides inside a track
of fixed length. So six range inputs look identical however the camp is split, and the only thing
that moves is the percentage beside them. That control cannot express an allocation at all, which
is why fixing the maths behind it changed nothing anyone could see.

It is one bar now, divided into six blocks, and each block's width is that area's share. Dragging
a boundary moves time out of one block into the one beside it, so the lengths change together and
always fill the bar exactly. Underneath, each row keeps a proportional bar and a pair of nudge
buttons, so the control still works from a keyboard and under a thumb.

The verification had to change with it. The claim is geometric, so it is measured against the real
stylesheet in a browser: at shares of 20/16/18/14/20/12 the blocks sum to the bar and the first is
a fifth of it; at 50/10/11/9/13/7 the first block is more than a hundred pixels longer and the
others are measurably shorter; at 100/0/0/0/0/0 one block is the entire bar and the rest have no
length at all.

An earlier version of that test walked a whole career to reach the camp planner and either skipped
or timed out. A test that skips proves nothing, and reporting it as coverage would have been
worse than having no test, so it was replaced with one that measures the thing actually in
question.

## Gate

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| default tier | 373 passed |
| world | 7 passed |
| flow | 171 passed |
| build | pass |
| dash and terminology guards | pass |
| browser | 38 passed, desktop and mobile |
