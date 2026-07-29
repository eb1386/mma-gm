import { clamp, Rng } from '../rng';
import { daysBetween, formatClock, yearOf, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, METHOD_LABEL, type FightResult } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { HallOfFameEntry, NewsItem, SeasonAward } from '../types/world';
import type { SaveGame } from '../types/save';
import { DIVISIONS } from '../config/divisions';

/**
 * World history: news, records, seasonal awards and the Hall of Fame.
 *
 * Everything here reads from the stored results rather than from any parallel bookkeeping,
 * so a record page can never disagree with the fight it came from.
 */

export function pushNews(save: SaveGame, item: Omit<NewsItem, 'id'>): NewsItem {
  const news: NewsItem = { ...item, id: `news-${++save.counters.news}` };
  save.history.news.unshift(news);
  // A very long save would otherwise grow the news list without bound.
  if (save.history.news.length > 4000) save.history.news.length = 4000;
  return news;
}

export function newsForResult(save: SaveGame, result: FightResult, eventName: string): void {
  const a = save.fighters[result.fighterAId];
  const b = save.fighters[result.fighterBId];
  if (!a || !b) return;
  const winner = result.winnerId ? save.fighters[result.winnerId] : null;
  const loser = result.loserId ? save.fighters[result.loserId] : null;

  const bout = save.bouts[result.boutId];
  let importance: NewsItem['importance'] = 1;
  if (isChampionshipBout(result)) importance = 5;
  else if (bout?.isMainEvent) importance = 4;
  else if (isFinish(result.method)) importance = 2;

  const divisionName = DIVISIONS.find((d) => d.id === result.divisionId)!.name;
  // A championship bout where somebody missed weight does not necessarily move the belt,
  // so applyTitleOutcome owns that headline and this one stays factual about the fight.
  const beltSettled = isChampionshipBout(result) && (result.titleIneligibleFighterIds ?? []).length === 0;
  const headline = winner
    ? beltSettled && result.isTitleFight
      ? `${winner.name} ${result.winnerId === save.rankings[result.divisionId].championId ? 'defends' : 'takes'} the ${divisionName} title`
      : beltSettled && result.isInterimTitleFight
        ? `${winner.name} ${result.winnerId === save.rankings[result.divisionId].interimChampionId ? 'defends' : 'takes'} the interim ${divisionName} title`
        : `${winner.name} beats ${loser?.name ?? 'the opponent'} by ${METHOD_LABEL[result.method].toLowerCase()}`
    : `${a.name} and ${b.name} fight to a draw`;

  pushNews(save, {
    date: result.date,
    headline,
    body: `${result.narrativeSummary} At ${eventName}.`,
    tags: ['result', result.divisionId, ...(isChampionshipBout(result) ? ['title'] : [])],
    fighterIds: [a.id, b.id],
    importance,
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RecordRow {
  fighterId: FighterId | null;
  name: string;
  value: number;
  detail: string;
}

export interface RecordBook {
  key: string;
  label: string;
  unit: string;
  rows: RecordRow[];
}

function topBy(
  save: SaveGame,
  score: (f: Fighter) => number,
  detail: (f: Fighter) => string,
  limit = 25,
  minimum = 1
): RecordRow[] {
  return Object.values(save.fighters)
    .map((f) => ({ fighterId: f.id, name: f.name, value: score(f), detail: detail(f) }))
    .filter((r) => r.value >= minimum)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

export function buildRecordBooks(save: SaveGame): RecordBook[] {
  const results = Object.values(save.history.results);

  const perFighterStats = new Map<
    FighterId,
    { sigStrikes: number; knockdowns: number; controlSeconds: number; mainEvents: number; fastestFinish: number | null; latestFinish: number | null }
  >();
  const get = (id: FighterId) => {
    let s = perFighterStats.get(id);
    if (!s) {
      s = { sigStrikes: 0, knockdowns: 0, controlSeconds: 0, mainEvents: 0, fastestFinish: null, latestFinish: null };
      perFighterStats.set(id, s);
    }
    return s;
  };

  for (const r of results) {
    const sa = get(r.fighterAId);
    const sb = get(r.fighterBId);
    sa.sigStrikes += r.totalsA.sigStrikesLanded;
    sb.sigStrikes += r.totalsB.sigStrikesLanded;
    sa.knockdowns += r.totalsA.knockdowns;
    sb.knockdowns += r.totalsB.knockdowns;
    sa.controlSeconds += r.totalsA.controlSeconds;
    sb.controlSeconds += r.totalsB.controlSeconds;
    const bout = save.bouts[r.boutId];
    if (bout?.isMainEvent) {
      sa.mainEvents++;
      sb.mainEvents++;
    }
    if (isFinish(r.method) && r.winnerId) {
      const totalSeconds = (r.endRound - 1) * 300 + r.endTimeSeconds;
      const w = get(r.winnerId);
      if (w.fastestFinish === null || totalSeconds < w.fastestFinish) w.fastestFinish = totalSeconds;
      if (w.latestFinish === null || totalSeconds > w.latestFinish) w.latestFinish = totalSeconds;
    }
  }

  const nameOf = (id: FighterId) => save.fighters[id]?.name ?? 'Unknown';

  const reigns = save.history.reigns;
  const reignRows: RecordRow[] = reigns
    .map((r) => {
      const end = r.lostOn ?? save.date;
      return {
        fighterId: r.fighterId,
        name: nameOf(r.fighterId),
        value: daysBetween(r.wonOn, end),
        detail: `${DIVISIONS.find((d) => d.id === r.divisionId)?.name ?? r.divisionId}, ${r.wonOn} to ${r.lostOn ?? 'present'}`,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 25);

  const defenseRows: RecordRow[] = reigns
    .map((r) => ({
      fighterId: r.fighterId,
      name: nameOf(r.fighterId),
      value: r.defenses,
      detail: `${DIVISIONS.find((d) => d.id === r.divisionId)?.name ?? r.divisionId}, from ${r.wonOn}`,
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 25);

  const statRow = (pick: (s: NonNullable<ReturnType<typeof perFighterStats.get>>) => number, unit: string): RecordRow[] =>
    [...perFighterStats.entries()]
      .map(([id, s]) => ({ fighterId: id, name: nameOf(id), value: pick(s), detail: unit }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 25);

  const fastest = [...perFighterStats.entries()]
    .filter(([, s]) => s.fastestFinish !== null)
    .map(([id, s]) => ({ fighterId: id, name: nameOf(id), value: s.fastestFinish!, detail: formatClock(s.fastestFinish!) }))
    .sort((a, b) => a.value - b.value)
    .slice(0, 25);

  const latest = [...perFighterStats.entries()]
    .filter(([, s]) => s.latestFinish !== null)
    .map(([id, s]) => ({ fighterId: id, name: nameOf(id), value: s.latestFinish!, detail: formatClock(s.latestFinish!) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 25);

  const upsets: RecordRow[] = [];
  for (const r of results) {
    if (!r.winnerId || !r.loserId) continue;
    const w = save.fighters[r.winnerId];
    const l = save.fighters[r.loserId];
    if (!w || !l) continue;
    // Ranking distance at the time is approximated by the best rank each fighter reached.
    const gap = (l.highestRanking ?? 16) - (w.highestRanking ?? 16);
    upsets.push({
      fighterId: w.id,
      name: `${w.name} beat ${l.name}`,
      value: -gap,
      detail: `${r.date}, ${METHOD_LABEL[r.method]}`,
    });
  }
  upsets.sort((a, b) => b.value - a.value);
  upsets.length = Math.min(upsets.length, 25);

  return [
    { key: 'wins', label: 'Most wins', unit: 'wins', rows: topBy(save, (f) => f.record.wins, (f) => `${f.record.wins}-${f.record.losses}-${f.record.draws}`) },
    { key: 'ufc-wins', label: 'Most promotional wins', unit: 'wins', rows: topBy(save, (f) => f.ufcRecord.wins, (f) => `${f.ufcRecord.wins}-${f.ufcRecord.losses}-${f.ufcRecord.draws}`) },
    { key: 'finishes', label: 'Most finishes', unit: 'finishes', rows: topBy(save, (f) => f.methods.koWins + f.methods.subWins, (f) => `${f.methods.koWins} by strikes, ${f.methods.subWins} by submission`) },
    { key: 'ko', label: 'Most knockouts', unit: 'knockouts', rows: topBy(save, (f) => f.methods.koWins, (f) => `${f.methods.koWins} knockout wins`) },
    { key: 'sub', label: 'Most submissions', unit: 'submissions', rows: topBy(save, (f) => f.methods.subWins, (f) => `${f.methods.subWins} submission wins`) },
    { key: 'streak', label: 'Longest current win streak', unit: 'fights', rows: topBy(save, (f) => f.winStreak, (f) => `${f.winStreak} straight`) },
    { key: 'reign', label: 'Longest title reigns', unit: 'days', rows: reignRows },
    { key: 'defenses', label: 'Most title defenses', unit: 'defenses', rows: defenseRows },
    { key: 'earnings', label: 'Highest career earnings', unit: 'dollars', rows: topBy(save, (f) => Math.round(f.careerEarnings), () => 'simulated career earnings') },
    { key: 'main-events', label: 'Most main events', unit: 'main events', rows: statRow((s) => s.mainEvents, 'main event bouts') },
    { key: 'sig-strikes', label: 'Most significant strikes landed', unit: 'strikes', rows: statRow((s) => s.sigStrikes, 'career significant strikes') },
    { key: 'knockdowns', label: 'Most knockdowns landed', unit: 'knockdowns', rows: statRow((s) => s.knockdowns, 'career knockdowns') },
    { key: 'control', label: 'Most control time', unit: 'seconds', rows: statRow((s) => Math.round(s.controlSeconds), 'career control seconds') },
    { key: 'fastest', label: 'Fastest finish', unit: 'time', rows: fastest },
    { key: 'latest', label: 'Latest finish', unit: 'time', rows: latest },
    { key: 'upsets', label: 'Greatest upsets', unit: 'ranking places', rows: upsets },
  ];
}

// ---------------------------------------------------------------------------
// Seasonal awards
// ---------------------------------------------------------------------------

export function computeSeasonAwards(save: SaveGame, year: number): SeasonAward[] {
  const yearResults = Object.values(save.history.results).filter((r) => yearOf(r.date) === year);
  if (yearResults.length === 0) return [];
  const awards: SeasonAward[] = [];

  // Fighter of the year: quality of wins, title activity, finishes.
  const scores = new Map<FighterId, number>();
  for (const r of yearResults) {
    if (!r.winnerId) continue;
    const winner = save.fighters[r.winnerId];
    const loser = r.loserId ? save.fighters[r.loserId] : null;
    if (!winner) continue;
    let s = 10;
    if (isChampionshipBout(r)) s += r.isTitleFight ? 30 : 22;
    if (isFinish(r.method)) s += 12;
    if (loser?.ranking !== null && loser?.ranking !== undefined) s += clamp(18 - loser.ranking, 2, 17);
    if (loser?.isChampion) s += 18;
    s += r.fightQuality * 0.12;
    scores.set(winner.id, (scores.get(winner.id) ?? 0) + s);
  }
  const foy = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  if (foy) {
    const f = save.fighters[foy[0]];
    awards.push({
      year,
      key: 'fighter-of-the-year',
      fighterId: foy[0],
      boutId: null,
      gymId: null,
      staffId: null,
      note: `${f?.name ?? 'Unknown'} on the strength of the year's results.`,
    });
    if (f) f.awards.push(`Fighter of the Year ${year}`);
  }

  // Fight of the year.
  const fotyResult = [...yearResults].sort((a, b) => b.fightQuality - a.fightQuality)[0];
  if (fotyResult) {
    const a = save.fighters[fotyResult.fighterAId];
    const b = save.fighters[fotyResult.fighterBId];
    awards.push({
      year,
      key: 'fight-of-the-year',
      fighterId: null,
      boutId: fotyResult.boutId,
      gymId: null,
      staffId: null,
      note: `${a?.name ?? '?'} against ${b?.name ?? '?'}, ${fotyResult.date}.`,
    });
  }

  // Prospect of the year: best year by a fighter under twenty six with few promotional fights.
  const prospects = [...scores.entries()]
    .map(([id, s]) => ({ f: save.fighters[id], s }))
    .filter((x) => x.f && (x.f.ageAtSnapshot ?? 30) < 27 && x.f.ufcRecord.wins + x.f.ufcRecord.losses <= 6)
    .sort((a, b) => b.s - a.s)[0];
  if (prospects) {
    awards.push({
      year,
      key: 'prospect-of-the-year',
      fighterId: prospects.f.id,
      boutId: null,
      gymId: null,
      staffId: null,
      note: `${prospects.f.name} was the year's standout young fighter.`,
    });
  }

  // Gym of the year: results plus titles produced.
  const gymScores = new Map<string, number>();
  for (const r of yearResults) {
    if (!r.winnerId) continue;
    const w = save.fighters[r.winnerId];
    if (!w?.gymId) continue;
    gymScores.set(w.gymId, (gymScores.get(w.gymId) ?? 0) + (r.isTitleFight ? 25 : r.isInterimTitleFight ? 18 : isFinish(r.method) ? 6 : 4));
  }
  const goy = [...gymScores.entries()].sort((a, b) => b[1] - a[1])[0];
  if (goy) {
    const gym = save.gyms[goy[0]];
    awards.push({
      year,
      key: 'gym-of-the-year',
      fighterId: null,
      boutId: null,
      gymId: goy[0],
      staffId: null,
      note: `${gym?.name ?? 'Unknown gym'} produced the year's best team results.`,
    });
    // Coach of the year goes to the head coach of that gym.
    const head = gym?.staffIds.map((id) => save.staff[id]).find((s) => s && s.role === 'head-coach');
    if (head) {
      awards.push({
        year,
        key: 'coach-of-the-year',
        fighterId: null,
        boutId: null,
        gymId: goy[0],
        staffId: head.id,
        note: `${head.name} of ${gym?.name ?? 'the gym'}.`,
      });
    }
  }

  // Comeback of the year: biggest turnaround from a losing run.
  const comeback = Object.values(save.fighters)
    .filter((f) => f.winStreak >= 3 && f.record.losses >= 3)
    .sort((a, b) => b.winStreak - a.winStreak)[0];
  if (comeback) {
    awards.push({
      year,
      key: 'comeback-of-the-year',
      fighterId: comeback.id,
      boutId: null,
      gymId: null,
      staffId: null,
      note: `${comeback.name} turned the career around with ${comeback.winStreak} straight wins.`,
    });
  }

  save.history.awards.push(...awards);
  for (const a of awards) {
    pushNews(save, {
      date: `${year}-12-20`,
      headline: `${a.key.split('-').join(' ').replace(/\b\w/g, (c) => c.toUpperCase())} ${year}`,
      body: a.note,
      tags: ['award', String(year)],
      fighterIds: a.fighterId ? [a.fighterId] : [],
      importance: 3,
    });
  }
  return awards;
}

// ---------------------------------------------------------------------------
// Hall of Fame
// ---------------------------------------------------------------------------

export function hallOfFameScore(save: SaveGame, f: Fighter): number {
  const reigns = save.history.reigns.filter((r) => r.fighterId === f.id && !r.isInterim);
  const totalDefenses = reigns.reduce((s, r) => s + r.defenses, 0);
  const reignDays = reigns.reduce((s, r) => s + daysBetween(r.wonOn, r.lostOn ?? save.date), 0);
  let score = 0;
  score += reigns.length * 26;
  score += totalDefenses * 13;
  score += reignDays / 55;
  score += f.ufcRecord.wins * 3.4;
  score -= f.ufcRecord.losses * 1.1;
  score += (f.methods.koWins + f.methods.subWins) * 1.9;
  score += (f.awards.length) * 9;
  score += clamp(f.popularity - 40, -10, 40) * 0.5;
  score += new Set(reigns.map((r) => r.divisionId)).size > 1 ? 30 : 0;
  return score;
}

export function runHallOfFameVote(save: SaveGame, year: number, rng: Rng): HallOfFameEntry[] {
  const eligible = Object.values(save.fighters).filter(
    (f) => f.retired && f.hallOfFameYear === null && f.retirementDate && yearOf(f.retirementDate) <= year - 2
  );
  const inducted: HallOfFameEntry[] = [];
  for (const f of eligible) {
    const score = hallOfFameScore(save, f);
    const votePct = clamp(score * 0.9 + rng.normal(0, 7), 0, 100);
    if (votePct >= 72) {
      f.hallOfFameYear = year;
      const reigns = save.history.reigns.filter((r) => r.fighterId === f.id);
      const entry: HallOfFameEntry = {
        fighterId: f.id,
        year,
        votePct: Math.round(votePct),
        summary: `${f.name} retired ${f.retirementDate} with a record of ${f.record.wins}-${f.record.losses}-${f.record.draws}, ${reigns.length} title reign${reigns.length === 1 ? '' : 's'} and ${reigns.reduce((s, r) => s + r.defenses, 0)} defenses.`,
      };
      save.history.hallOfFame.push(entry);
      inducted.push(entry);
      pushNews(save, {
        date: `${year}-07-01`,
        headline: `${f.name} is inducted into the Hall of Fame`,
        body: entry.summary,
        tags: ['hall-of-fame'],
        fighterIds: [f.id],
        importance: 4,
      });
    }
  }
  return inducted;
}

/** Title lineage for a division, newest first. */
export function titleLineage(save: SaveGame, divisionId: string) {
  return save.history.reigns
    .filter((r) => r.divisionId === divisionId && !r.isInterim)
    .sort((a, b) => (a.wonOn < b.wonOn ? 1 : -1))
    .map((r) => ({
      ...r,
      fighterName: save.fighters[r.fighterId]?.name ?? 'Unknown',
      days: daysBetween(r.wonOn, r.lostOn ?? save.date),
    }));
}

export function retirementNews(save: SaveGame, fighter: Fighter, reason: string, date: IsoDate): void {
  save.history.retirements.push({ fighterId: fighter.id, date, reason });
  pushNews(save, {
    date,
    headline: `${fighter.name} retires`,
    body: `${fighter.name} finishes with a record of ${fighter.record.wins}-${fighter.record.losses}-${fighter.record.draws}. ${reason}`,
    tags: ['retirement'],
    fighterIds: [fighter.id],
    importance: fighter.titleReigns > 0 ? 4 : 2,
  });
}
