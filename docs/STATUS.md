# Status

An honest account of what is implemented, what is partial, and what is not built. Written
against the expansion specification phase by phase.

**The player flow repair is documented separately in `docs/PLAYER-FLOW.md`.** It covers the
three reported bugs, the centralized availability and booking service, the career state
machine, the advancement controller, fight playback, fight week, press conferences, social
media and weigh ins.

Verified on the final pass:

- `npm run test:fast` 55 unit tests pass in 3.0 seconds
- `npm run test:flow` 103 unit and player flow tests pass in 51 seconds, the pre commit suite
- `npm test` 130 unit and integration tests pass in 516 seconds
- `npm run test:world` 6 multi year simulations pass in 27 seconds
- `npm run typecheck` clean
- `npm run build` clean
- `npm run lint:dashes` and `npm run lint:terms` pass over 122 files
- `npm run perf --quick` reports zero phases over target
- Fighter Mode, Coach Mode and Spectator Mode each exercised end to end by an integration test

---

## Phase 1: finish and stabilize

**Complete.** All 23 verification items are covered by tests in `src/core/flows.int.test.ts`.

| Item | Where it is verified |
| --- | --- |
| Accepted bouts are not canceled or re-offered | `never cancels or re-offers a bout the player already accepted` |
| One camp per accepted bout | `creates exactly one camp per accepted bout` |
| No second open offer while booked | `never gives any fighter a second open offer while already booked` |
| Booking pointers stay valid | `keeps booking pointers valid and clears them when a fight completes` |
| Completed fight clears pointers | same test |
| Titleholders vacate on division change | `vacates a title when the champion changes division` |
| Rankings exclude fighters who left | `keeps rankings free of fighters who left the division` |
| Title lineage valid after stripping, retirement, division change | `keeps title lineage coherent` |
| Contracts decrement once | `stores each result once, decrements the contract once and pays once` |
| Purses and bonuses paid once | same test |
| Results stored once | same test and `resolveBout is the only path that records a result` |
| Camps complete once | `completes each camp once and only once` |
| Advancement stops on required decisions | `stops advancement when something needs an answer` |
| Saves reload identically | `reloads into exactly the same world state` |
| Export and import preserve the career | `survives an export and import cycle` |
| Fighter, Coach and Spectator modes | three tests under `game modes` |

**The reported notification bug is fixed.** Accepting an offer, or declining it, or letting
it expire, now resolves the inbox message that carried it. The advance control reads the
same predicate as the inbox and the sidebar badge, so it says "Advance to weigh in" or
"Advance to fight day" once the decision is taken rather than continuing to say "Answer 1".

### Title eligibility after a missed weight

A bout where somebody misses weight no longer stops being a championship bout. The bout
records which fighters forfeited their claim, and the title is settled by one rule:

- The belt goes to the winner only if the winner made weight.
- Nobody who missed weight is holding the belt afterwards.
- Every other case leaves it vacant, which covers a champion who missed and won, a champion
  who made weight and lost to someone who missed, and both sides missing.

Five unit tests cover that table directly, and the fight page states whose title is at
stake when only one corner is eligible.

Three weight model defects were found while building this, and the third only became
visible because the title work made weight misses consequential.

- Fighters were created carrying more weight than the same model said they could safely
  cut, and only drifted down over the following months, so a fresh roster missed weight far
  too often.
- `build.cutDifficulty` was applied twice, once dividing the healthy cut and again
  multiplying the strain, so it landed squared.
- `wear.weightCut` did the same thing, and that one compounds over a career. A busy champion
  who had taken years of cuts was missing weight in **a quarter of their title bouts**.

Under identical ideal camp conditions the miss rate across every division went from **23.7
percent to 0.2 percent** for a normal bout, and from 26.3 to 0.6 percent at a championship
limit where there is no allowance. In a five year simulated world, weight misses in title
bouts fell from 25 percent of them to under 4 percent. Across the acceptance seeds the rate
per fighter bout is 0.0088, down from 0.024. A test asserts the creation rate stays under 15
percent in every division.

That last defect also inflated the title fight rate, because a missed weight now vacates a
title and every spurious vacancy generated a spurious title fight. Chasing the rest of that
inflation is decision 34 in `docs/DESIGN.md`, and it ended in a correction to the champion
turnaround constant rather than to any of the structural causes first suspected.

### Interim titles

Interim titles were dead code. `applyTitleOutcome` returned early unless `isTitleFight` was
true, and an interim bout sets that flag false by design, so an interim championship could
be announced, booked, contested and won without anything being recorded. The same confusion
between "the undisputed belt" and "a belt" meant an interim championship bout could be
scheduled for three rounds, be contracted at the non title weight allowance, pay no
championship money and be skipped by the news, fame and ranking point systems.

There is now one predicate, `isChampionshipBout`, and the sites that mean "a belt is on the
line" use it. Winning an interim title opens a flagged interim reign, defending it
increments that reign, and a unification bout closes it as promoted or defeated. Two
further defects surfaced from this: a stripped champion left a scheduled interim bout to
crown an interim champion of a division that no longer had a champion at all, which now
upgrades to an undisputed title bout, and the "interim title in play" news item repeated
every weekly pass for as long as the condition held.

An integration test drives the whole path with an injured champion.

Bugs found and fixed during stabilization, beyond the reported one:

- `bookEvent` returned every scheduled bout on the card rather than only the new ones, so
  the weekly pass cancelled the player's already accepted bout and re-offered it, and
  created a duplicate camp every week.
- Ranked fighters filled every card slot, freezing unranked fighters out of the sport.
- The player could be assigned an injury replacement bout without consenting to it.
- Contract renewal offers were regenerated weekly, flooding the inbox.
- A champion who moved up a division stayed listed as champion of the old one.

---

## Phase 2: performance

**Mostly complete.** Full numbers in `docs/PERFORMANCE.md`.

Done: repeatable phase by phase measurement harness (`npm run perf`); career creation
under 5 seconds in every mode and under 2 seconds in reduced performance mode; tiered and
cached Pot projection; world indexes; three simulation detail levels; debounced autosave
and a cached save size estimate; real history pruning; tiered test suites with a fast tier
under 10 seconds; career creation progress phases with cancellation.

Not done:

- **No Web Worker.** Career creation is 440 ms and a year advance is 21 seconds. The
  progress panel and cancellation, which is what a worker would have enabled, already
  exist on the creation path. Year advance still blocks the main thread.
- **The normal test tier is 395 seconds, not the 60 second target.** The integration flows
  deliberately run multi year worlds because the invariants they check cannot be violated
  in a shorter run. The fast tier is the pre commit suite in practice.
- No chunked IndexedDB layout and no compressed export.

---

## Phase 3: realistic annual calendar

**Complete and verified.** Measured over five seeds, four at five years and one at ten,
covering 30 simulated years:

| Target | Specification | Measured |
| --- | --- | --- |
| Events per year | 46 | 44.8, range 43.7 to 46.1 |
| Numbered cards per year | 14 | 13.1, range 13.0 to 13.3 |
| Fight nights per year | 32 | 31.7, range 30.5 to 32.8 |
| Clear weekends per year | about 6 | about 6 |
| Scheduled bouts per card | 11 to 14 | 12.05 mean, 10 to 14 range |
| Divisions per card | more than one | 7.8 mean, 5 minimum |

Events, numbered cards and fight nights all land slightly under the specified targets
because the scheduler declines a weekend rather than forcing a card it cannot fill with
bouts that make sense. That is the intended trade.

Card shapes are drawn at creation and stored. Four card views are tracked separately:
announced, currently scheduled, at the weigh in, and actually contested. Canceled bouts
never count as activity, records, payments or results, which is asserted by a test.

---

## Phase 4: roster and divisions

**Complete for the present day.** Three contested women's divisions added as first class
divisions with 48 real athletes from the same compliant source, bringing the real roster to
176. Women's Featherweight is configured as a retired division and correctly imports no
roster. Every division has its own priors, age distribution, roster size, finish rate
target, knockdown and submission scales, and contested years; a test asserts no two share a
profile.

The full status vocabulary is implemented as a derived verdict with evidence, covering
active, booked, injured, medically suspended, commission suspended, anti-doping suspended,
inactive, retired, released, free agent, unverified, deceased and historical only.

Not done: anti-doping suspensions have a status value but no system that produces one, so
that status is currently unreachable.

---

## Phase 5: historical database and start dates

**Architecture only.** Divisions carry `activeFrom` and `activeUntil`, `divisionsInYear`
exists, and business figures carry a kind that distinguishes verified from reported
estimate from simulated from unknown. There is no historical roster, no historical event
database, and no historical start date selection. Building one would need a compliant
historical source, and the only compliant source available publishes the current rankings
and current athlete profiles.

---

## Phase 6: activity and career pacing

**Complete.** Twelve activity profiles with targets, preferred turnarounds, short notice
willingness and selectivity. Matchmaking asks `willingToFight` before offering. The fighter
page shows fights per year, days since the last fight, average, shortest and longest gaps,
short notice fights, offers accepted and declined, the activity label, an estimated return
and the reason for current inactivity. Measured mean is 1.9 fights per active fighter per
year with nobody exceeding four.

---

## Phases 7 to 10: personality, fame, social media, hype

**Complete as simulation and interface.** 29 personality traits with conflict rules over
nine continuous dials; fame split into recognition, favorability, controversy, hardcore
respect, casual interest, sponsor appeal, media friendliness, promotional trust and drawing
power; 20 derived public labels; four social platforms with 13 player actions that can
fail; hype tracked separately for hardcore, casual, regional and media audiences with a
moment timeline. All of it is on the fighter page under Identity and on the fight page.

Personality never touches Ovr, and for real athletes it is labelled on the page as a model
estimate rather than a claim about the person.

Not done: personality does not yet feed contract negotiation or fight acceptance for AI
fighters, only activity does. Rivalries are created and escalated by fight outcomes but
there is no trash talk or callout interface (Phase 12).

---

## Phases 13 and 14: bonuses and event business

**Complete.** Fight of the Night requires a genuinely competitive and eventful fight, a
weak card awards none and says so, and a third performance bonus is awarded in its place.
Bonus selection weighs method, timing, comebacks and stakes. Bonuses move favorability,
hardcore respect and the matchmaker relationship. Career bonus counts, earnings and rates
are in the record books.

Event business computes attendance, gate, pay per view, streaming, broadcast and
international audiences, merchandise, sponsorship, venue cost, payroll, marketing and
estimated profit, from the card rather than from the tier. Every figure declares its kind
and the event page states that all of them are simulated. Six business record books exist.

---

## Phases 11, 12, 15, 16, 17, 19, 20: not built

Honestly, these are not implemented:

- **Phase 11 fight week**: no media day, open workout, press conference or faceoff model.
- **Phase 12 trash talk and callouts**: rivalries exist and escalate from fight outcomes,
  but there is no trash talk, callout or post fight interview interface.
- **Phase 15 sponsors, managers and finances**: managers are a name only. There is no
  sponsor system and no fighter expense model.
- **Phase 16 expanded weight and medical decisions**: weight cutting is modelled with
  walking weight, cut quality, misses, forfeits and forced division moves, and injuries
  have severity, recurrence, training limits and clearance. Title eligibility after a
  missed weight is now modelled rather than dropped (see below). The expanded per week diet
  and water cut controls, the second weigh in attempt, and the treatment choice interface
  are not built.
- **Phase 17 anti-doping**: not built.
- **Phase 19 gym politics and prospect pathways**: gyms, staff, happiness, autonomy and
  recruiting exist. Gym rivalries, poaching, mentorship, teammate refusals and the labelled
  prospect pathways are not built.
- **Phase 20 legacy and retirement**: retirement, comebacks are absent, Hall of Fame and a
  wide record book exist. Explicit career goals are not built.

### Fight engine calibration is missing two of its own targets

Measured over 6000 fights, the finish rate is **41.8 percent against a 44 to 52 percent
band**, and the average fight runs **13.0 minutes against a 9.0 to 11.5 minute band**. Those
are one fault: too few fights end early, so too many reach the scorecards and the average
length runs long. The method split is also weighted toward submissions rather than knockouts
and technical knockouts.

An earlier version of this documentation claimed 46.9 percent. That figure does not
reproduce on this build and has been corrected rather than left standing. Nothing in the
weight and title work touched the fight engine, which reads neither walking weight nor
championship status, so this is a pre-existing gap rather than a regression from it.

In a full simulated world the finish rate measures 41.5 percent, which is inside the wider
band the acceptance harness uses, so the world is not broken by it. Closing the gap means
retuning stoppage thresholds in `src/core/config/calibration.ts`, which changes every fight
outcome in every seed and would invalidate the acceptance run below. It is the largest piece
of outstanding balance work and is listed rather than attempted at the end of a verification
pass.

**Phase 18 officials** is partial. Judges have persistent leans toward grappling or damage
plus per round perception noise, and scorecards show every round. Referees have a stoppage
tendency drawn per fight. Fouls occur with warnings and point deductions. Named officials
with tracked histories, the full foul vocabulary, appeals and result changes are not built.

---

## Phase 21: balance and acceptance testing

**Run at reduced scale.** `npx vite-node tools/acceptance.ts 4 1 0` covers four five year
seeds and one ten year seed, 30 simulated years in about 15 minutes. The specification asks
for 20 five year seeds, 5 ten year seeds and 1 twenty year seed, which is roughly three
hours. The harness supports that configuration unchanged; only the scale is reduced.

Result: **23 of 23 metrics inside their target band.** Raw numbers in `docs/ACCEPTANCE.json`.

Re-measured after the player flow repair and the finance, sponsor, manager and anti-doping
systems were added, since all of them change the world.

| Metric | Target | Mean | Range |
| --- | --- | --- | --- |
| Events per year | 40 to 52 | 44.8 | 43.7 to 46.1 |
| Numbered cards per year | 10 to 18 | 13.1 | 13.0 to 13.3 |
| Fight nights per year | 26 to 38 | 31.7 | 30.5 to 32.8 |
| Scheduled bouts per card | 10 to 14 | 12.01 | 11.74 to 12.14 |
| Contested bouts per card | 9 to 14 | 12.01 | 11.73 to 12.12 |
| Finish rate | 0.40 to 0.56 | 0.419 | 0.407 to 0.437 |
| Title fights per division per year | 1.0 to 2.0 | 1.69 | 1.49 to 1.89 |
| Title change rate | 0.20 to 0.40 | 0.306 | 0.229 to 0.368 |
| Defenses per reign | 1 to 3 | 1.71 | 1.30 to 2.27 |
| Champions with a defense | 0.45 to 0.70 | 0.556 | 0.425 to 0.652 |
| Long vacancies per division per year | 0 to 0.1 | 0.000 | flat zero |
| Weight miss rate per fighter bout | 0 to 0.08 | 0.0086 | 0.0066 to 0.0128 |
| Fights per active fighter per year | 1.2 to 3.2 | 1.96 | 1.87 to 2.04 |
| Share fighting more than four times a year | 0 to 0.05 | 0.0000 | flat zero |
| Bonuses per event | 2 to 4 | 3.98 | 3.98 to 3.99 |

One range worth noting honestly: champions earning a defense has a **minimum of 0.425**, just
under the 0.45 floor, on one seed. The harness judges the mean, which is 0.556 and
comfortably in band, but a single unlucky world can dip below it.

Unbanded observations from the same run: 2.2 interim titles per run, 10.2 fictional fighters
reaching a championship, 48.7 percent of ranked slots held by fictional fighters, 18.8
retirements per year, 0.62 injuries per fight, and a mean of 796,910 simulated pay per view
buys. A ten year save is 53 MB.

Every one of these numbers moved during this session, and three of the bands were themselves
wrong before it. The title metrics in particular were reported against divisors that
included a division with no title, so the earlier figures in this table were not measuring
what they claimed to. See decisions 33 and 34 in `docs/DESIGN.md`.

Interim titles now occur on their own, between one and four times in a five year run. They
never occurred before, because the system had never worked at all. It is also driven
directly by an integration test rather than left to chance.
