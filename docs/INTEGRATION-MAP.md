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
