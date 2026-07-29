# The player flow

What was broken, what was built, and what is still missing. Written against the flow
repair specification.

---

## The reported bugs

### A booked player could be offered another fight

Availability was decided independently by the matchmaker, the title pass, the replacement
finder and the player offer path. Each knew some of the reasons a fighter is already spoken
for and none knew all of them.

There is now one authority, `src/core/world/availability.ts`. `offerBlockReason` returns
one of 23 reasons a fighter cannot take a new fight, covering booking, acceptance, camp,
fight week, an unresolved bout, blocking injury, medical, commission and anti-doping
suspension, retirement, inactivity without a return date, an existing offer, negotiation, a
recently declined matchup, an offer cooldown, contract state, turnaround and notice. Every
generator calls it.

### An injured player was offered fights

Health was judged only against the event date. A card four months out fell past the
expected return, so an offer to an injured fighter looked perfectly healthy.

Health is now judged twice: the fighter must be clear on the day of the event, and a
fighter who is hurt today is only approached under the contingent rules. A contingent offer
requires the event to be past the expected return plus a 28 day buffer, is capped at one at
a time, and is labelled as medically contingent in the inbox. Measured over 30 simulated
weeks with a blocking injury: **0 offers**, down from 1 unlabelled ordinary offer.

### An injured booked player was told nothing

This was the worst of the three. A player with a booked fight could be injured and the game
would say nothing at all: no message, no decision, and the fight stayed on the books with no
way to resolve it.

`src/core/world/injury-flow.ts` classifies every injury against the booked fight date into
seven severity classes, raises exactly one mandatory decision per injury, and offers only
the choices that are medically sensible for that class. The decision blocks the calendar.
Resolving it is a real transaction: a postponement moves the bout and keeps the opponent, a
withdrawal releases the booking and either finds the opponent a replacement or cancels the
bout, and surgery does both plus a long layoff.

---

## Idempotency

Every offer carries a stable key built from fighter, opponent, event, card slot, offer type
and replacement status. Generating the same offer twice returns the existing one. The key is
persisted, and migration 7 derives one for offers written before it existed so the duplicate
check works on old saves too.

Accepting an offer runs one transaction that creates the bout, takes both booking pointers,
and withdraws every other open offer either fighter holds.

## Invariants

`checkBookingInvariants` returns findings for: two scheduled bouts for one fighter, a booked
fighter with an open ordinary offer, multiple active camps, a scheduled bout not referenced
by both fighters, a fighter pointing at a canceled, completed, missing or foreign bout, and
two offers for the same matchup on the same card. A test asserts it stays empty across eight
weeks of advancement, and the end to end test asserts it after the fight resolves.

---

## The career state machine

`src/core/world/career.ts` derives the career state from world facts and writes it into the
save. It is derived rather than stored as the primary record because a stored state drifts
out of step with the bouts and injuries it describes.

Twenty states, with precedence: a fight in progress outranks an injury, an injury with a
booked fight outranks an unplanned camp, and so on down to plain availability. Seven states
block the calendar. `CAREER_TRANSITIONS` declares which moves are legal and is asserted by a
test.

The dashboard shows the state, the reason, the next mandatory action, the booked opponent,
the event, the date, days remaining, camp progress, injury state, fight week stage,
unresolved decisions, and whether time advancement is blocked and why.

---

## One advancement controller

Every world changing action goes through `runOperation` in `src/ui/store.ts`. It owns the
current operation, its phase, its progress, its result and its failure. Two operations can
never run at once, so the header advance button and a page button cannot start the same
fight.

Before any heavy work it yields to the browser through `requestAnimationFrame` followed by a
timeout, so the loading state is painted first. This is what fixes Start Fight appearing to
do nothing.

Every operation returns a structured result: dates, days advanced, events, fights,
headlines, why it stopped, where to navigate, and a `noOpReason`. **An action that changes
nothing reports why.** The operation panel renders that rather than the interface guessing.
A failure shows the actual error with a retry and a way back, never a swallowed promise.

### Buttons routed through the controller

Global advance (day, week, month, event, year), Start Fight, offer accept, decline and all
eight negotiation requests, camp creation, and every fight week stage. The advance buttons
disable when a mandatory action is outstanding and the reason is shown next to them.

---

## Fight playback

`src/core/world/playback.ts` is one authoritative state machine over one stored
deterministic result. Live, round by round and instant all replay the same object; none of
them runs a second simulation.

Playback stops at the finishing event. `playbackEndIndex` returns the index of the official
finish, so nothing after it is ever shown, the continue button never appears after a finish,
and the between rounds panel is gated on the round having reached the horn.

`summarizeRound` produces a finish specific summary for a finishing round, naming the
winner, loser, method, official time, finishing action, position, referee or doctor note,
and whether the winner had been hurt earlier in the round. A normal round summary is built
from the recorded statistics and the event stream: significant strikes, knockdowns,
takedowns, submission attempts, control time, fouls, the best moment and the closing
position. There is no generic filler.

A bug found while writing the tests: a decision fight ends in its final round, so the naive
check treated that round as ending the fight and refused to give it a normal summary. Only a
bout cut short without a finish gets the early ending treatment now.

### Speeds

Playback is deliberately unhurried. The old speeds were 110 to 900 ms per event; they are
now **700 to 2600 ms**, and important moments are held longer: a decisive event holds 3.2
times the base, a major event 2.1 times. A knockout is no longer one flicker.

---

## Fight week

Fourteen stages with dates relative to the event, generated exactly once per bout. Which
optional stages a bout carries depends on card position, championship status, popularity and
event tier: a preliminary bout between two unranked fighters does not get a press
conference. Official weigh in, final clearance and fight night are always mandatory.

Each stage is a real page state with a visible outcome, and is resolved once.

## Press conferences

Twenty six question templates selected by context tags, each with three to five replies
across twelve tones. Answers are composed from tone keyed fragment banks, so the same
question does not produce the same words twice, and a rolling four hundred day history keeps
recently used questions out of the pool. Consequences cover hype across four audiences,
favorability, controversy, followers, rivalry, confidence, media reputation, promotional
trust and a realized fine risk.

## Social media

Eighteen item templates across nine sources with a weekly budget: zero to two in an ordinary
week, more during a promotion, more again in fight week and for a major rivalry, fewer for a
private personality. At most four unanswered items exist at once. Replies apply once and
record an immediate reaction.

## Weigh ins

A visible sequence with ten stages. The scale reading stays deterministic, drawn once from
the same weight model the rest of the game uses and then revealed a step at a time. Before
fight week the forecast shows current weight, target, remaining pounds, expected difficulty,
hydration risk, nutrition support, previous misses, allowance and title eligibility.

A miss stops for a decision with six options. The ruling covers purse forfeit, catchweight,
one sided title eligibility, opponent acceptance and cancellation, and it closes the fight
week stage exactly once.

---

## Performance

| Measurement | Before | After |
| --- | --- | --- |
| Advance one week, full world | 178 ms | **100 ms** |
| Advance one year | 6205 ms | **4027 ms** |
| Fast unit tier | 3.0 s | 3.0 s |
| Flow tier, 93 tests | did not exist | **18 s** |
| Player flow suite, 38 tests | did not exist | **14 s** |

The week and year improvements come from one fix: `offerBlockReason` scanned every camp in
the save for every candidate fighter, which is quadratic in a long career. That was a
regression introduced by the availability service itself and is now a set built once per
booking pass, the same pattern the open offer check already used.

`npm run test:flow` is the new pre commit suite: every unit test plus the entire player flow,
in 18 seconds.


---

## Priority 12: what was built and what was not

### Built, connected, persisted, migrated and tested

**Fighter finances.** `src/core/world/finance.ts` keeps one ledger of every money movement.
Cash, career earnings, career expenses, net worth, debt, monthly outgoings, runway, a
financial pressure reading and a retirement security reading are all derived from it rather
than tracked separately and allowed to drift. Eleven income kinds and fourteen expense kinds.
A fight purse is split through the ledger: manager commission, gym percentage, tax and
travel come off the top and each is recorded once. Monthly costs apply at most once per
calendar month and scale with how the fighter actually lives.

**Sponsors.** Ten categories, offers driven by reach and approval and never by Ovr, with per
fight payment, monthly retainer, win bonus, champion bonus, post and appearance obligations,
category exclusivity, morality clauses, expiry and renewal. A morality clause can and does
terminate a deal when controversy rises.

**Managers and agents.** Nine attributes including negotiation, matchmaking influence,
sponsor network, media skill, loyalty, aggressiveness, honesty, commission and client
capacity. Hiring, firing, capacity limits and conflicts of interest when a manager holds two
clients in one division.

**Anti-doping, abstract.** Four compliance postures with stated risk and stated consequence.
This models what a fighter faces, not any method: there is nothing about substances, testing
mechanics or avoidance. Testing frequency scales with ranking and with being booked. An
adverse finding suspends, voids the booked bout, strips a title, terminates sponsors with a
morality clause, fines, and damages favorability and promotional trust. Appeals can overturn,
reduce or fail, and a test asserts all three outcomes are reachable.

All four appear on a **Money** page with five tabs, are in the sidebar, are persisted, are
covered by migration 8, and have eleven tests.

### Not built

Honestly, and unchanged from `docs/STATUS.md`:

- **Historical mode.** No historical roster, events, rankings, champions, title lineages or
  era rules. This needs a compliant historical source and none exists: the only compliant
  source publishes current rankings and current athlete profiles. The architecture is there
  and the data is not, which is exactly where it was.
- **Trash talk and callouts as a system.** Rivalries exist, escalate from fight outcomes and
  from social exchanges, and press conference answers move them. There is no dedicated
  callout interface, no callout acceptance logic and no trilogy pressure model.
- **Expanded commissions, referees and fouls.** Judges have leans, referees have a stoppage
  tendency, fouls occur with warnings and deductions. Named officials with tracked histories,
  the full foul vocabulary, appeals and result changes are not built.
- **Gym politics and prospect pathways.** Gyms, staff, happiness, autonomy and recruiting
  exist. Rivalries between gyms, poaching, mentorship, teammate refusals and labelled
  prospect pathways are not.
- **Legacy and career goals.** Retirement, Hall of Fame and a wide record book exist.
  Explicit goals, goal progress, a legacy score, comebacks, farewell fights and the coaching
  or ownership transitions are not.

### Also outstanding

- No Web Worker. Career creation is 417 ms and a year advance is 4.0 s.
- The normal test tier is 476 s against a 60 s target. `npm run test:flow` at 31 seconds is
  the practical pre commit suite.
- The Coach Mode and Spectator page buttons have not been routed through the advancement
  controller. The global advance bar covers them, but page level buttons on those two screens
  still call `mutate` directly.
- The ceremonial weigh in faceoff reads rivalry intensity as zero rather than the real value,
  so the shove option never appears.


---

# The refinement pass

## The camp bug, and its root cause

`CareerAction` carried a label and a route and nothing else, so the header had to work out
what pressing it should do. It worked that out from the route string. Camp said "Advance
camp", pointed at `/camp`, and the header treated a `/camp` route as navigation. A player
already on the camp page clicked and nothing at all happened.

`CareerAction` is now a discriminated union: `navigate`, `advance-target`,
`advance-duration`. The camp action is
`{ kind: 'advance-target', label: 'Advance to Fight Week', target: { kind: 'fight-week', boutId } }`.
One executor in the store runs it. Nothing infers behaviour from a route, a label, whether
the user is already there, or whether the action is blocking.

The second half of the bug was that target advancement did not exist at all. The interface
could only ask for a day, a week or a month, so reaching fight week meant pressing the week
button five or six times and hoping. `advanceUntil(save, target)` in
`src/core/world/advance-target.ts` loops inside the core, one day at a time so a stage that
falls mid week is not walked past, and stops the moment a real decision appears.

Measured on a fixture with a bout eight weeks out: **one click, 280 ms, 50 days, 7 camp
weeks, 11 fight week tasks created, ending on the fight week page.**

Writing that test found a second bug. Fight week tasks were generated in the Monday
maintenance pass, so a bout on a Wednesday could reach fight week with no stages at all.
They are now created on the day fight week actually begins.

## No invisible success

`advanceUntil` returns a structured result with 24 fields: dates, days, the target, whether
it was reached, career state before and after, events, fights, camp weeks, camp events,
injuries, decisions, inbox items, fight week tasks, offers, rankings, money in and out,
headlines, why it stopped, the mandatory action, where to navigate, and a written summary.

A move of zero days always carries a reason. That was a real bug found by a test: when the
target was already satisfied the reason was discarded because the code only reported a
reason when the target was missed, which left the interface with nothing to show.

## One decision per injury

Identity was stored inside the human readable `resolution` text, which stopped working the
moment a resolution was written for a person to read. There are now real fields:
`decisionKey`, `linkedInjuryId`, `decisionCreatedOn`, `decisionResolvedOn` and
`selectedChoiceKey`, plus a treatment record per injury holding the chosen treatment, the
prognosis at the time and the severity at the time.

After a treatment is chosen the question is not asked again. A new decision is raised only
for a genuine development: a prognosis that slipped by three weeks or more, a booked fight
that has come inside the recovery window, or surgery becoming the recommendation when it
was not before. Ordinary weekly recovery is a passive update.

A test advances twelve weeks after a resolved injury and asserts nothing new is raised.

## One authoritative inbox

`messageNeedsAction` now validates the linked offer, injury, sponsor, social item, callout,
fight week stage, bout, contract and fighter, and refuses anything past its deadline.
`reconcileInbox` closes items whose underlying action was handled elsewhere, immediately
rather than at the next weekly tick.

That work found a bug in my own code: `String.prototype.includes('-', position)` is always
true when later dashes exist, so the check meant to identify a base injury decision never
fired and the decision stayed open forever.

## Everything reaches the player

`src/core/world/camp-life.ts` is how the systems become visible. Teammate encouragement and
conflict, coach concerns, gym politics, poaching, mentorship requests, sponsor obligations,
manager advice, promotional requests, documentary crews, nutrition updates, fan requests,
ranking news, and the compliance items: a supplement of unknown provenance appearing in the
gym, and a whereabouts filing coming due.

That last pair is the point. The anti-doping system was previously only reachable by
visiting a page. It now arrives as something a teammate puts in front of you.

Budget: two to three meaningful items a week during camp, one to two otherwise, three in
fight week, and never more than two mandatory items open at once. Only mandatory items stop
the calendar.

## Relationships, friendships and callouts

`src/core/world/relationships.ts` tracks respect, friendship, familiarity, rivalry,
resentment, trust, public hostility, private hostility, teammate bond and mentor bond. The
state is **derived** from those values rather than stored, so two fighters who have fought
three times and respect each other come out as respected opponents without anything setting
that label.

Twelve states from stranger through training partner to enemy. Social replies, press
conference answers, camp choices and fights all move the underlying values, so a friendship
really can deteriorate into a rivalry.

Callouts carry a tone, are assessed honestly before they are made, and **never book a fight
by themselves**. The assessment shows availability, ranking gap, acceptance chance,
promotion interest and the relationship, with explicit warnings. A test asserts that
accepting, rejecting, countering, insulting and silence are all reachable and that
`ledToOffer` is never set by the callout itself.

## Weight class moves

Adjacent divisions for the same gender, with descriptive projections rather than numbers,
so no hidden rating leaks. A test asserts the option object never contains a rating key.

Explore, gather manager and coach opinions which can disagree, ask the promotion which can
refuse, then commit. Committing removes the fighter from the old ranking table, resets the
ranking, updates eligibility, moves walking weight, and vacates a title if one was held.
A move is refused outright while a fight is booked.

## Page reorganization

Money now holds financial systems only, with Overview, Ledger, Earnings, Expenses and
Forecast. Sponsors, Management, Compliance and Career each have their own page and their
own sidebar entry. Sponsor money and manager commission still appear in the ledger, because
that is financial; managing them is not.

## Fight presentation

`fightVisibility` is one selector deciding what the screen may show. Before it, scattered
`result !== null` checks meant the winner, the method and the scorecards could all be on
screen before a single event had been revealed.

Nothing about the outcome is visible until playback reaches the end. A round summary
appears only after that round reaches its horn, so at the midpoint of round two the round
one summary is visible and nothing else is. A decision shows "Scorecards Being Collected"
before the winner. Instant mode holds a visible processing state before revealing.

Commentary scrolls inside its own container, never the page, pauses when the user scrolls
up, offers `Jump to Live`, and can be turned off.

## Language

Player facing text no longer says validating, no-op, mutation, recomputing or controller
refused. It says `Advancing to Fight Week`, `Running Training Camp`, `Fight Week Begins`,
`Saving Career`, `No future event is currently scheduled`.

## Verification

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run test:fast` | 55 passed, 3.6 s |
| `npm run test:flow` | 135 passed, 17 s |
| `npm test` | 162 passed, 226 s |
| `npm run test:world` | 6 passed, 13 s |
| `npm run build` | clean |
| Dash and terminology guards | clean, 130 files |
| `npm run perf --quick` | 0 phases over target, week advance 59 ms |

The terminology guard caught a real violation in this pass: a field called the long form of
Pot in the callout assessment. It is now `expectedHype`.

## What is still missing

- **No browser tests.** Priority 24 asked for a Playwright suite covering the fifty step
  career path. It is not written. Every claim above rests on unit and integration tests.
- **Career goals, legacy scoring and comebacks** have no engine.
- **Officials are anonymous.** Judges have leans and referees have stoppage tendencies, but
  they are not named, carry no history, and there is no appeals process.
- **Money and Management have no dashboard presence** and the contextual action never points
  at them. They are reachable from the sidebar and through inbox items.
- **No Web Worker.** Advancement is fast enough now that the interface stays responsive, but
  a multi year simulation still blocks the main thread.
- **The normal test tier is 226 seconds** against a 60 second target. `npm run test:flow` at
  17 seconds is the practical pre commit suite.
