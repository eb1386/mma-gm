# Attribution and data sources

## Unofficial project

MMA GM is an unofficial fan-made MMA simulation. It is not affiliated with, sponsored by, approved by, or endorsed by UFC, Zuffa, UWFS as a real organization, or any fighter represented in the game. UWFS is a fictional promotion used by the simulation.

No UFC trademark, logo, promotional artwork, event poster or fighter photograph is included
in this repository. Every visual asset here is original: the octagon mark, the icons and the
sharing image were produced for this project.

Venue names in the game are generated descriptive strings rather than the trademarked names
of real buildings.

## Where the real data comes from

The only production source is the official UFC website, read by the crawler in
`tools/ingest/`. That crawler reads and obeys `https://www.ufc.com/robots.txt`, including
the published `crawl-delay: 15`, and refuses every disallowed path. Responses are cached to
disk so a re-run costs zero requests.

Because `Disallow: /athletes/all?*` covers the complete historical athlete directory, that
directory is never crawled. This is why the real roster is the ranked roster: every champion
plus the officially ranked one through fifteen in each contested division.

UFCStats was evaluated and rejected as a production source because it sits behind a
JavaScript proof of work bot wall. `UFCStatsAdapter` exists in the provider layer and reports
that capability as unavailable rather than pretending otherwise. No third party API is
described anywhere in this project as official.

## What is factual and what is not

Every value in the game is one of six kinds and the interface distinguishes them:

- **Sourced fact.** Name, nickname, height, reach, listed weight, age, place of birth,
  professional record, wins by knockout and submission, activity status, gym affiliation,
  octagon debut, official ranking, championship status. Each carries a source URL, a fetch
  timestamp, a confidence and the transformation applied, shown on the fighter page.
- **Derived rating.** The six performance ratings, produced by a documented reproducible
  model from published rate statistics plus official standing.
- **Model estimate.** Pot, Longevity, wear, popularity, style tendencies, personality.
- **Simulated.** Every contract, purse, camp, injury, bout, result and business figure.
- **User created.** Anything entered on the Create a Fighter screen.
- **Unknown.** Anything the source does not publish. Nothing is invented to fill a gap.

**No pay figure in this game is real.** Fighter pay is not public. Every contract object
carries `isSimulated: true` and a visible note saying so.

Ratings are values produced by the game model. They are not measurements of a real person
and should not be read as an assessment of anyone.

## Removal

If you are represented in this game and want to be removed, the roster is rebuilt from a
snapshot and an exclusion can be applied at that layer without affecting anything else.


## The simulated promotion

The promotion inside the game is the **Unified World Fight Series**, abbreviated **UWFS**.
It is fictional. Every generated card, championship and contract belongs to it:

- Numbered cards are named `UWFS 300`, `UWFS 301` and so on.
- Fight nights are named `UWFS Fight Night 84`.
- Championships are named `UWFS Lightweight Champion`.

The real promotion is named in this repository in exactly two situations, and both are
factual rather than fictional:

1. Describing where the sourced roster data came from, including the crawler, the provenance
   records and this document.
2. A historical result that belongs to a real athlete's real record, which would be
   misattributed if it were relabelled.

Nothing the simulation invents is ever attributed to a real promotion.
