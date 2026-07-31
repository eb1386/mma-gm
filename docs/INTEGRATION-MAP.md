# Integration map

Where every major system is reachable from normal play. A system is not complete when its
engine exists but a row here is empty.

| System | Engine | Save field | Migration | Dashboard | Inbox | Contextual action | Page | Stops advancement | Test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Offers | `world/offers.ts` | `fightOffers` | 7 | Career banner | Yes, offer category | `Review Fight Offer` | `/offer/:id` | Yes | playerflow, careerflow |
| Contracts | `world/economy.ts` | `contracts`, `contractOffers` | 3 | Career banner | Yes | `Answer Contract Offer` | `/contract` | Yes | playerflow |
| Camps | `world/camp.ts` | `camps` | 3, repaired in 9 | Camp progress row | Camp life items | `Plan Fight Camp`, `Advance to Fight Week` | `/camp` | Only for a real decision | careerflow |
| Game plans | `world/gameplan-memory.ts` | `gamePlans` | 9 | Not shown | No | Preselected on camp and fight pages | `/camp`, `/fight/:id` | No | careerflow |
| Injuries | `world/injury-flow.ts` | `injuryTreatments` | 9 | Injury row | Yes, one per injury | `Review Injury` | `/inbox/:id` | Yes | playerflow, careerflow |
| Weight management | `world/health.ts` | on the fighter | 6 | Fight week forecast | Nutrition update item | Part of weigh in | `/fightweek/:id` | At the weigh in | playerflow |
| Weight class moves | `world/weightclass.ts` | `weightClassPlans` | 9 | Career state | Coach suggestion, promotion reply | `Explore this move` | `/career` weight tab | No | careerflow |
| Fight week | `world/fightweek.ts` | `fightWeek` | 7 | Stage row | Stage tasks | Stage specific label | `/fightweek/:id` | Mandatory stages | playerflow |
| Media and press | `world/presser.ts` | `pressers` | 7 | Stage row | Stage task | `Attend press conference` | `/fightweek/:id` | Yes | playerflow |
| Social media | `world/social.ts` | `socialFeed` | 7 | No | Yes, budgeted | Answer from the inbox | `/inbox` | No | playerflow |
| Friendships | `world/relationships.ts` | `relationships` | 9 | No | Teammate items | Reply choices | `/career` relationships tab | No | careerflow |
| Rivalries | `world/relationships.ts` + `world/hype.ts` | `relationships`, `rivalries` | 9 | No | Opponent items | Reply choices | `/career` relationships tab | No | careerflow |
| Callouts | `world/relationships.ts` | `callouts` | 9 | No | Yes, the answer arrives | `Call out` | `/career` callouts tab | No | careerflow |
| Weigh ins | `world/weighin.ts` | `weighIns` | 7 | Stage row | Stage task | `Go to the official weigh in` | `/fightweek/:id` | Yes | playerflow |
| Fight presentation | `world/playback.ts` | none, derived | none | Fight ready state | No | `Enter Fight` | `/fight/:id` | Yes on fight day | playerflow |
| Money | `world/finance.ts` | `ledger`, `finance` | 8 | No | No | No | `/money` | No | playerflow |
| Sponsors | `world/finance.ts` | `sponsors` | 8 | No | Offer and obligation items | Sign or decline | `/sponsors` | Obligations only | playerflow |
| Managers | `world/finance.ts` | `managers` | 8 | No | Advice items | Hire or release | `/management` | No | playerflow |
| Compliance | `world/antidoping.ts` | `doping` | 8 | No | Findings, supplement and whereabouts items | Appeal or accept | `/compliance` | On a finding | playerflow |
| Gyms | `world/gyms.ts` | `gyms`, `staff` | 1 | No | Gym politics items | Coach Mode actions | `/coach`, `/gyms` | No | flows |
| Officials | `sim/judging.ts` | inside results | none | No | No | No | `/fight/:id` | No | core unit |
| Career goals | not built | none | none | No | No | No | none | No | none |
| Legacy | partial, Hall of Fame only | `history.hallOfFame` | 1 | No | No | No | `/hall-of-fame` | No | flows |
| Retirement | `world/development.ts` | on the fighter | 1 | Career state | Retirement news | No | `/dashboard` | No | flows |
| Comebacks | not built | none | none | No | No | No | none | No | none |

## Rows that are still incomplete

- **Career goals** and **comebacks** have no engine at all.
- **Legacy** is only the Hall of Fame and the record books. There is no legacy score.
- **Officials** are anonymous. Judges have leans and referees have tendencies, but they are
  not named, have no history, and there is no appeals process.
- **Money** and **Managers** have no dashboard presence and no contextual action. They are
  reachable from the sidebar and through inbox items, which is enough to find them, but the
  primary action never points at them.

---

## Title shots, division moves, matchmaking, callouts and rivalries

These five were built at different times and each reached the world through a different
route, which is why they behaved as if they were unaware of each other. They now share three
modules.

### `title-eligibility.ts` is the only gate on a belt

| Path that can create a championship bout | Calls |
| --- | --- |
| Weekly title pass in `tick.ts` | `rankChallengers`, then `titleShotEligibility` again before booking |
| Card seeding in `matchmaking.ts` | `titleShotEligibility` inside `scoreCandidate`, plus `existingTitleBout` before the bout is built |
| Champion division move | `assessChampionMove`, which calls `rankChallengers` and `interimTitleJustification` |
| Replacement finder | Demotes the bout when the replacement is not ranked in the top eight |

`existingTitleBout` is what prevents two live bouts for one belt. `interimTitleJustification`
is what prevents an interim championship existing for a scheduling reason.

### `matchup-interest.ts` is the only persistent matchmaking candidate

| Producer | Source recorded |
| --- | --- |
| `resolveCallout` when the answer is not a refusal | `callout` |
| `commitMove` | `division-debut`, or `title-claim` when a championship is on the line |
| Rivalry state, read live rather than stored | `matchupPull` |

| Consumer | Effect |
| --- | --- |
| `findBestOpponent` | `matchupPull` moves a specific opponent up or out of the list |
| `runMatchupInterestPass` | Converts an eligible interest into a real fight offer |
| Career page and Rivalries page | Show the current state and the blocker |
| `evaluateAllInterests` in the weekly tick | Recomputes eligibility against the world |

### What a player sees, and where it comes from

| Player visible thing | Written by | Read by |
| --- | --- | --- |
| "Why this fight was made" on an offer | `bookingKind` and `reason` on the offer | Offer page |
| Why a challenger was selected | `TitleEligibility.selectionReason` | Bout `bookingReason`, title offer body |
| Why a belt is interim | `InterimJustification.explanation` | Bout `bookingReason`, champion move panel |
| Why a callout has not produced a fight | `MatchupInterest.blockers` | Career page, Rivalries page, weekly inbox update |
| What happens to a championship on a move | `TitleDecision` and `ChampionMovePath` | Weight class panel, move confirmation message |

---

## The number one contender position

One earned claim per division, and the single highest input to championship eligibility.

| Producer | Source recorded |
| --- | --- |
| Winning a bout whose `bookingKind` is `eliminator` | `eliminator-win` |
| A reigning champion completing a division move where the belt is on the line | `division-move` |
| The promotion naming a challenger directly | `promotion-decision` |

| Consumer | Effect |
| --- | --- |
| `titleShotEligibility` | Adds the largest claim in the system, and blocks every other challenger with `contender-ahead` |
| `rankChallengers` | Adds the holder to the pool even when they are unranked, so a division cannot freeze |
| `bookTitleFights` | Consumes the claim when the bout stands |
| `acceptOffer` | Consumes it when the player accepts a championship offer, not when it is made |
| `cancelBout` | Gives it back when a championship bout never happens |
| `reviewContenderClaims` | Weekly upkeep: lapses, retirements, division changes, long absences |

Exceptions that permit looking past the holder, all named in `mayBypassContender`: they are
booked elsewhere, they are unavailable beyond the grace period, the belt is vacant, or the bout
is an interim or unification bout that the division already owes.

## Ranking points

| Concern | Owner |
| --- | --- |
| Accumulated points, every fighter, ranked or not | `save.rankingPoints`, via `rankingLedger` |
| The visible top fifteen | `save.rankings[division].entries` |
| Ordering correction against a recent head to head result | `applyHeadToHead`, bounded passes |
| Floor so a bad run remains recoverable | `RANKING_POINTS_FLOOR` |

Keeping these separate is the fix for a fighter who left the top fifteen having their entire
results history erased and restarted from zero.

## Balance values exposed as configuration

| Value | Where | What it controls |
| --- | --- | --- |
| `CHAMPION_TURNAROUND_DAYS` | `matchmaking.ts` | Champion fights per year, almost exactly 365 divided by it |
| `REPLACEMENT_MIN_TURNAROUND_DAYS` | `matchmaking.ts` | How soon a fighter can take short notice cover |
| `ROSTER_TARGET_SCALE` | `config/matchmaking.ts` | Roster size against card supply, which sets the unranked band |
| `MATCHMAKING` | `config/matchmaking.ts` | Every weight in candidate scoring, previously bare literals |
| `CONTENDER_CLAIM_DAYS`, `CONTENDER_INJURY_GRACE_DAYS` | `contender.ts` | How long a claim survives and how long a division waits |
| `RANKING_POINTS_FLOOR` | `rankings.ts` | How far a losing run can sink a fighter |
| `HEAD_TO_HEAD_WINDOW_DAYS`, `HEAD_TO_HEAD_PASSES` | `rankings.ts` | Recency and bound on the ordering correction |
| `SOCIAL_ACTIONS_PER_WEEK` | `identity.ts` | Weekly cap on deliberate social actions |
| `tenEightImpact` | `config/calibration.ts` | The 10-8 threshold, recalibrated after the damage fix |
