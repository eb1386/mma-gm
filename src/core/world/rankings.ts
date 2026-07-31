import { DIVISIONS, type DivisionId } from '../config/divisions';
import { clamp } from '../rng';
import { daysBetween, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, type FightResult } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { DivisionRankings, PfpRankings, RankingEntry } from '../types/world';
import type { SaveGame } from '../types/save';

/**
 * Rankings are a results system, not a rating system. Nothing here reads Ovr. A highly
 * skilled inactive fighter falls, and a lower rated fighter who beats ranked opposition
 * rises.
 */

const RANKED_SLOTS = 15;

export interface RankingPointsInput {
  won: boolean;
  isDraw: boolean;
  opponentRank: number | null;
  opponentIsChampion: boolean;
  method: FightResult['method'];
  endRound: number;
  dominance: number;
  isTitleFight: boolean;
  shortNotice: boolean;
  ownRank: number | null;
}

/**
 * Points awarded for a single result. The magnitude of a win scales with the quality of
 * the opponent beaten, not with the winner's own standing.
 */
export function rankingPointsFor(input: RankingPointsInput): number {
  const oppQuality = input.opponentIsChampion ? 20 : input.opponentRank !== null ? clamp(17 - input.opponentRank, 2, 16) : 1.2;

  if (input.isDraw) return oppQuality * 0.12;

  if (input.won) {
    let pts = oppQuality * 1.0;
    if (isFinish(input.method)) pts *= 1.28;
    if (input.endRound === 1 && isFinish(input.method)) pts *= 1.12;
    pts *= 0.85 + clamp(input.dominance, 0, 1) * 0.4;
    if (input.isTitleFight) pts *= 1.25;
    if (input.shortNotice) pts *= 1.12;
    // Beating someone ranked well above you is worth more than beating a peer.
    if (input.ownRank !== null && input.opponentRank !== null && input.opponentRank < input.ownRank) {
      pts *= 1 + clamp((input.ownRank - input.opponentRank) / 22, 0, 0.5);
    }
    return pts;
  }

  // A loss costs more when it comes against lower ranked opposition.
  let penalty = -clamp(20 - oppQuality, 3, 18) * 0.62;
  if (isFinish(input.method)) penalty *= 1.16;
  if (input.shortNotice) penalty *= 0.7;
  return penalty;
}

/** Percentage of the fight the winner dominated, used to scale ranking movement. */
export function dominanceOf(result: FightResult, winnerIsA: boolean): number {
  const w = winnerIsA ? result.totalsA : result.totalsB;
  const l = winnerIsA ? result.totalsB : result.totalsA;
  const strikeEdge = (w.sigStrikesLanded - l.sigStrikesLanded) / Math.max(15, w.sigStrikesLanded + l.sigStrikesLanded);
  const controlEdge = (w.controlSeconds - l.controlSeconds) / Math.max(120, w.controlSeconds + l.controlSeconds);
  const kd = (w.knockdowns - l.knockdowns) * 0.14;
  return clamp(0.5 + strikeEdge * 0.6 + controlEdge * 0.35 + kd, 0, 1);
}

/** Inactivity decay applied on the weekly ranking pass. */
export function inactivityDecay(fighter: Fighter, today: IsoDate): number {
  if (!fighter.lastFightDate) return 0;
  const days = daysBetween(fighter.lastFightDate, today);
  if (days < 300) return 0;
  return -clamp((days - 300) / 120, 0, 6) * 0.8;
}

export interface RankingUpdate {
  divisionId: DivisionId;
  changes: { fighterId: FighterId; from: number | null; to: number | null; reason: string }[];
}

/**
 * Recomputes one division's ranked list from accumulated points. Points are the memory of
 * results; the ordering is derived from them plus recency and activity.
 */
/**
 * The accumulated points ledger for a division, keyed by fighter.
 *
 * Points used to live only on the ranked entries, which are truncated to the top fifteen. That
 * made the display list and the results memory the same object, so a fighter who slipped to
 * sixteenth had their entire career record silently erased and restarted from zero, and could
 * never climb back on merit. The ledger is now separate and keeps every fighter's history.
 */
export function rankingLedger(save: SaveGame, divisionId: DivisionId): Record<FighterId, number> {
  if (!save.rankingPoints) save.rankingPoints = {};
  if (!save.rankingPoints[divisionId]) {
    // Seed from the current table so an existing save keeps the standings it already had.
    const seeded: Record<FighterId, number> = {};
    for (const e of save.rankings[divisionId]?.entries ?? []) seeded[e.fighterId] = e.points;
    save.rankingPoints[divisionId] = seeded;
  }
  return save.rankingPoints[divisionId];
}

/** Adds points to a fighter's running total, which survives dropping out of the rankings. */
export function addRankingPoints(save: SaveGame, divisionId: DivisionId, fighterId: FighterId, points: number): number {
  const ledger = rankingLedger(save, divisionId);
  // Floored, because the ledger is permanent now. Without a floor a fighter on a bad run
  // accumulated a total so negative that no realistic number of wins could bring them back into
  // the rankings, which is a worse failure than the truncation this ledger replaced.
  ledger[fighterId] = Math.max(RANKING_POINTS_FLOOR, (ledger[fighterId] ?? 0) + points);
  return ledger[fighterId];
}

/**
 * The lowest a fighter's accumulated total can go.
 *
 * Deep enough that a losing run genuinely costs standing, shallow enough that a winning run can
 * climb out of it within a few fights.
 */
export const RANKING_POINTS_FLOOR = -30;

/**
 * The points bonus a fighter earns for a recent win over somebody above them.
 *
 * Expressed as an adjustment to the sort key rather than as a swap. An adjacent swap pass depends
 * on the order it is handed, can oscillate on a cycle, and leaves violations behind when three
 * fighters have beaten each other. A scalar adjustment is order independent, always terminates,
 * and produces the same table whatever order the eligible list arrives in.
 */
export function headToHeadAdjustment(
  save: SaveGame,
  fighter: Fighter,
  pointsOf: Map<FighterId, number>
): { bonus: number; over: FighterId | null } {
  const mine = pointsOf.get(fighter.id) ?? 0;
  let best: { gap: number; id: FighterId } | null = null;

  for (const id of fighter.boutIds) {
    const r = save.history.results[id];
    if (!r) continue;
    if (r.winnerId !== fighter.id) continue;
    if (daysBetween(r.date, save.date) > HEAD_TO_HEAD_WINDOW_DAYS) continue;
    const otherId = r.fighterAId === fighter.id ? r.fighterBId : r.fighterAId;
    const theirs = pointsOf.get(otherId);
    if (theirs === undefined) continue;
    // Only a win over somebody currently ahead needs correcting.
    const gap = theirs - mine;
    if (gap <= 0) continue;
    // A later loss to the same opponent settles it the other way, so the most recent meeting wins.
    const laterLoss = fighter.boutIds.some((bid) => {
      const later = save.history.results[bid];
      if (!later || later.date <= r.date) return false;
      const pair =
        (later.fighterAId === fighter.id && later.fighterBId === otherId) ||
        (later.fighterAId === otherId && later.fighterBId === fighter.id);
      return pair && later.winnerId === otherId;
    });
    if (laterLoss) continue;
    if (!best || gap > best.gap) best = { gap, id: otherId };
  }

  if (!best) return { bonus: 0, over: null };
  // Enough to clear the gap, capped so one win cannot vault a fighter over the whole division.
  const bonus = Math.min(best.gap + HEAD_TO_HEAD_MARGIN, HEAD_TO_HEAD_MAX_BONUS);
  return { bonus, over: best.id };
}

/** The margin a head to head correction clears the opponent by. */
export const HEAD_TO_HEAD_MARGIN = 0.5;
/** The most a single head to head result can be worth, so one win is not a shortcut to the top. */
export const HEAD_TO_HEAD_MAX_BONUS = 22;

/** How recent a head to head win has to be to override the points order. */
export const HEAD_TO_HEAD_WINDOW_DAYS = 730;
/** Bounded convergence passes, so the correction always terminates. */
export const HEAD_TO_HEAD_PASSES = 3;

export function recomputeDivision(save: SaveGame, divisionId: DivisionId, reasonBySlot: Map<FighterId, string>): RankingUpdate {
  const table = save.rankings[divisionId];
  const previous = new Map(table.entries.map((e) => [e.fighterId, e.rank]));
  const ledger = rankingLedger(save, divisionId);

  const eligible = Object.values(save.fighters).filter(
    (f) =>
      f.divisionId === divisionId &&
      !f.retired &&
      f.activityStatus === 'active' &&
      f.id !== table.championId &&
      f.id !== table.interimChampionId
  );

  const pointsOf = new Map<FighterId, number>();
  for (const f of eligible) {
    // The ledger is the memory, not the truncated display list, so a fighter outside the top
    // fifteen keeps everything they have earned.
    const decayed = Math.max(RANKING_POINTS_FLOOR, (ledger[f.id] ?? 0) + inactivityDecay(f, save.date));
    ledger[f.id] = decayed;
    pointsOf.set(f.id, decayed);
  }

  // Head to head is folded into the sort key, so the ordering is a pure function of the points.
  // Applied against the running result rather than the raw points, and repeated a bounded number
  // of times. Computing every bonus from the unadjusted table meant that once everybody had moved,
  // the ordering could still contradict a head to head result, which is the one thing this exists
  // to prevent. The pass count is fixed, so it always terminates and never depends on input order.
  const adjusted = new Map<FighterId, number>(eligible.map((f) => [f.id, pointsOf.get(f.id) ?? 0]));
  for (let pass = 0; pass < HEAD_TO_HEAD_PASSES; pass++) {
    let moved = false;
    const next = new Map(adjusted);
    for (const f of eligible) {
      const { bonus } = headToHeadAdjustment(save, f, adjusted);
      if (bonus <= 0) continue;
      next.set(f.id, (adjusted.get(f.id) ?? 0) + bonus);
      moved = true;
    }
    for (const [k, v] of next) adjusted.set(k, v);
    if (!moved) break;
  }

  const ordered = eligible
    .slice()
    .sort((a, b) => {
      const pa = adjusted.get(a.id) ?? 0;
      const pb = adjusted.get(b.id) ?? 0;
      if (Math.abs(pa - pb) > 0.001) return pb - pa;
      // Tie break on recent activity, then on record inside the promotion.
      const ra = a.lastFightDate ? daysBetween(a.lastFightDate, save.date) : 9999;
      const rb = b.lastFightDate ? daysBetween(b.lastFightDate, save.date) : 9999;
      if (ra !== rb) return ra - rb;
      return b.ufcRecord.wins - a.ufcRecord.wins;
    });

  const sorted = ordered.slice(0, RANKED_SLOTS);

  const entries: RankingEntry[] = sorted.map((f, i) => {
    const prevEntry = table.entries.find((e) => e.fighterId === f.id);
    return {
      fighterId: f.id,
      rank: i + 1,
      previousRank: previous.get(f.id) ?? null,
      points: pointsOf.get(f.id) ?? 0,
      weeksRanked: (prevEntry?.weeksRanked ?? 0) + 1,
      movementReason: reasonBySlot.get(f.id) ?? prevEntry?.movementReason ?? null,
    };
  });

  const changes: RankingUpdate['changes'] = [];
  for (const e of entries) {
    if (e.previousRank !== e.rank) {
      changes.push({
        fighterId: e.fighterId,
        from: e.previousRank,
        to: e.rank,
        reason: e.movementReason ?? (e.previousRank === null ? 'entered the rankings' : 'ranking recalculation'),
      });
    }
  }
  for (const old of table.entries) {
    if (!entries.some((e) => e.fighterId === old.fighterId)) {
      changes.push({ fighterId: old.fighterId, from: old.rank, to: null, reason: 'dropped out of the top fifteen' });
    }
  }

  table.entries = entries;
  table.updatedOn = save.date;
  table.fromOfficialSnapshot = false;

  // Mirror onto the fighter records so pages can read a single place.
  for (const f of Object.values(save.fighters)) {
    if (f.divisionId !== divisionId) continue;
    const e = entries.find((x) => x.fighterId === f.id);
    f.previousRanking = f.ranking;
    f.ranking = e ? e.rank : null;
    if (e) {
      f.weeksRanked = e.weeksRanked;
      f.highestRanking = f.highestRanking === null ? e.rank : Math.min(f.highestRanking, e.rank);
    }
  }

  return { divisionId, changes };
}

/**
 * Pound for pound. Normalizes achievement across weight classes: championship status,
 * quality of ranked wins, dominance, recent activity and long term excellence.
 */
export function recomputePfp(save: SaveGame): PfpRankings {
  const scored: { fighterId: FighterId; score: number }[] = [];

  for (const f of Object.values(save.fighters)) {
    if (f.retired || f.activityStatus !== 'active') continue;
    const table = save.rankings[f.divisionId];
    let score = 0;
    if (table.championId === f.id) score += 46;
    else if (table.interimChampionId === f.id) score += 32;
    else if (f.ranking !== null) score += clamp(24 - f.ranking * 1.4, 2, 24);
    else continue;

    score += f.titleDefenses * 5.5;
    score += f.titleReigns * 4;
    score += clamp(f.winStreak, 0, 12) * 1.5;
    score -= clamp(f.lossStreak, 0, 4) * 5;
    score += clamp(f.eligibleDivisions.length - 1, 0, 2) * 6;
    score += clamp((f.ufcRecord.wins - f.ufcRecord.losses) * 0.7, -8, 12);

    if (f.lastFightDate) {
      const days = daysBetween(f.lastFightDate, save.date);
      if (days > 400) score -= clamp((days - 400) / 60, 0, 14);
    }
    scored.push({ fighterId: f.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const prev = new Map(save.pfp.entries.map((e) => [e.fighterId, e.rank]));
  const entries: RankingEntry[] = scored.slice(0, RANKED_SLOTS).map((s, i) => ({
    fighterId: s.fighterId,
    rank: i + 1,
    previousRank: prev.get(s.fighterId) ?? null,
    points: s.score,
    weeksRanked: 0,
    movementReason: null,
  }));

  for (const f of Object.values(save.fighters)) {
    const e = entries.find((x) => x.fighterId === f.id);
    f.pfpRanking = e ? e.rank : null;
  }

  return { entries, updatedOn: save.date, fromOfficialSnapshot: false };
}

/** Applies one fight result to the ranking point totals of both fighters. */
export function applyResultToRankings(save: SaveGame, result: FightResult, shortNoticeA: boolean, shortNoticeB: boolean): string[] {
  const notes: string[] = [];
  const a = save.fighters[result.fighterAId];
  const b = save.fighters[result.fighterBId];
  if (!a || !b) return notes;

  const table = save.rankings[result.divisionId];
  const rankOf = (f: Fighter) => (table.championId === f.id ? 0 : f.ranking);

  for (const [self, other, shortNotice] of [
    [a, b, shortNoticeA],
    [b, a, shortNoticeB],
  ] as [Fighter, Fighter, boolean][]) {
    const won = result.winnerId === self.id;
    const isDraw = result.winnerId === null;
    const pts = rankingPointsFor({
      won,
      isDraw,
      opponentRank: rankOf(other),
      opponentIsChampion: table.championId === other.id,
      method: result.method,
      endRound: result.endRound,
      dominance: dominanceOf(result, result.winnerId === result.fighterAId),
      isTitleFight: isChampionshipBout(result),
      shortNotice,
      ownRank: rankOf(self),
    });

    // Points go to the ledger, which every fighter has, ranked or not. The entry is only the
    // display row and is rebuilt on the next recompute.
    addRankingPoints(save, result.divisionId, self.id, pts);
    const reason = won ? `beat ${other.name}` : isDraw ? `drew with ${other.name}` : `lost to ${other.name}`;
    const entry = table.entries.find((e) => e.fighterId === self.id);
    if (entry) {
      entry.points = rankingLedger(save, result.divisionId)[self.id] ?? entry.points;
      entry.movementReason = reason;
    }
    notes.push(`${self.name} ${won ? 'gains' : 'loses'} ${Math.abs(pts).toFixed(1)} ranking points`);
  }
  return notes;
}

export function emptyDivisionRankings(divisionId: DivisionId, on: IsoDate): DivisionRankings {
  return {
    divisionId,
    championId: null,
    interimChampionId: null,
    entries: [],
    updatedOn: on,
    fromOfficialSnapshot: false,
  };
}

export function allDivisionRankings(on: IsoDate): Record<DivisionId, DivisionRankings> {
  const out = {} as Record<DivisionId, DivisionRankings>;
  for (const d of DIVISIONS) out[d.id] = emptyDivisionRankings(d.id, on);
  return out;
}

/** Champion bookkeeping after a title fight, including vacating and stripping. */
function isHolder(table: DivisionRankings, fighterId: FighterId, interim: boolean): boolean {
  return interim ? table.interimChampionId === fighterId : table.championId === fighterId;
}

/** Ends the open reign of the given kind and clears the pointer. */
function vacateTitle(save: SaveGame, result: FightResult, interim: boolean, reason: 'stripped' | 'defeated'): void {
  const table = save.rankings[result.divisionId];
  const open = save.history.reigns.find((r) => r.divisionId === result.divisionId && r.isInterim === interim && r.lostOn === null);
  if (open) {
    open.lostOn = result.date;
    open.lostBoutId = result.boutId;
    open.endReason = reason;
    const held = save.fighters[open.fighterId];
    if (held) {
      if (interim) held.isInterimChampion = false;
      else held.isChampion = false;
    }
  }
  if (interim) table.interimChampionId = null;
  else table.championId = null;
}

export function applyTitleOutcome(save: SaveGame, result: FightResult): string[] {
  const notes: string[] = [];
  // An interim bout carries isTitleFight false by design, so this guard has to ask whether
  // any belt was on the line rather than whether the undisputed one was.
  if (!isChampionshipBout(result) || !result.winnerId) return notes;
  const table = save.rankings[result.divisionId];
  const winner = save.fighters[result.winnerId];
  const loser = result.loserId ? save.fighters[result.loserId] : null;

  // Missing weight forfeits any claim on the belt for this bout. The rule the game applies:
  // the title goes to the winner only if the winner made weight, and anyone who missed
  // weight cannot be holding it afterwards. Every other case leaves the belt vacant. That
  // covers a champion who missed and won, a champion who made weight and lost to someone
  // who missed, and both sides missing.
  const ineligible = result.titleIneligibleFighterIds ?? [];
  if (ineligible.length > 0) {
    const beltName = result.isInterimTitleFight ? 'interim title' : 'title';
    const heldByIneligible = result.isInterimTitleFight
      ? table.interimChampionId !== null && ineligible.includes(table.interimChampionId)
      : table.championId !== null && ineligible.includes(table.championId);

    if (!ineligible.includes(winner.id)) {
      notes.push(`${winner.name} takes the ${beltName}. The other corner was ineligible after missing weight.`);
      // Fall through to the normal path so the winner is installed as champion.
    } else {
      // The winner cannot hold the belt. It stays where it was unless the holder is the
      // one who missed weight, in which case it is vacated.
      if (heldByIneligible) {
        vacateTitle(save, result, result.isInterimTitleFight, 'stripped');
        notes.push(`The ${DIVISIONS.find((d) => d.id === result.divisionId)!.name} ${beltName} is vacant after a missed weight.`);
      } else if (loser && !ineligible.includes(loser.id) && isHolder(table, loser.id, result.isInterimTitleFight)) {
        // The holder made weight and lost to someone who cannot take the belt.
        vacateTitle(save, result, result.isInterimTitleFight, 'defeated');
        notes.push(`The ${DIVISIONS.find((d) => d.id === result.divisionId)!.name} ${beltName} is vacant. The winner missed weight and could not take it.`);
      } else {
        notes.push(`${winner.name} wins but missed weight, so the ${beltName} does not change hands.`);
      }
      return notes;
    }
  }

  if (result.isInterimTitleFight) {
    // An interim reign is recorded in the same lineage as an undisputed one, flagged so
    // that record books and the title history can tell them apart.
    const openInterim = save.history.reigns.find((r) => r.divisionId === result.divisionId && r.isInterim && r.lostOn === null);
    if (openInterim && openInterim.fighterId !== winner.id) {
      openInterim.lostOn = result.date;
      openInterim.lostBoutId = result.boutId;
      openInterim.endReason = 'defeated';
    }
    if (openInterim && openInterim.fighterId === winner.id) {
      openInterim.defenses++;
      notes.push(`${winner.name} defends the interim title.`);
      return notes;
    }
    // titleReigns counts undisputed reigns only. Interim history lives in the flagged reign
    // records so the two are never conflated in a record book.
    table.interimChampionId = winner.id;
    winner.isInterimChampion = true;
    if (loser) loser.isInterimChampion = false;
    save.history.reigns.push({
      id: `reign-interim-${result.divisionId}-${result.date}-${winner.id}`,
      divisionId: result.divisionId,
      fighterId: winner.id,
      isInterim: true,
      wonOn: result.date,
      wonBoutId: result.boutId,
      lostOn: null,
      lostBoutId: null,
      defenses: 0,
      endReason: null,
    });
    notes.push(`${winner.name} wins the interim title.`);
    return notes;
  }

  // A unification bout settles the interim belt whoever wins it, so the interim reign is
  // closed before the undisputed bookkeeping runs.
  const openInterim = save.history.reigns.find((r) => r.divisionId === result.divisionId && r.isInterim && r.lostOn === null);
  if (openInterim && (openInterim.fighterId === winner.id || openInterim.fighterId === loser?.id)) {
    openInterim.lostOn = result.date;
    openInterim.lostBoutId = result.boutId;
    openInterim.endReason = openInterim.fighterId === winner.id ? 'promoted' : 'defeated';
    table.interimChampionId = null;
    const held = save.fighters[openInterim.fighterId];
    if (held) held.isInterimChampion = false;
    notes.push(`The ${result.divisionId} interim title is settled.`);
  }

  const previousChampion = table.championId;
  if (previousChampion === winner.id) {
    winner.titleDefenses++;
    const reign = save.history.reigns.find(
      (r) => r.fighterId === winner.id && r.lostOn === null && !r.isInterim && r.divisionId === result.divisionId
    );
    if (reign) reign.defenses++;
    notes.push(`${winner.name} defends the title.`);
    return notes;
  }

  table.championId = winner.id;
  winner.isChampion = true;
  winner.isInterimChampion = false;
  winner.titleReigns++;
  if (loser) {
    loser.isChampion = false;
  }
  const oldReign = save.history.reigns.find((r) => r.divisionId === result.divisionId && r.lostOn === null && !r.isInterim);
  if (oldReign) {
    oldReign.lostOn = result.date;
    oldReign.lostBoutId = result.boutId;
    oldReign.endReason = 'defeated';
  }
  save.history.reigns.push({
    id: `reign-${result.divisionId}-${result.date}-${winner.id}`,
    divisionId: result.divisionId,
    fighterId: winner.id,
    isInterim: false,
    wonOn: result.date,
    wonBoutId: result.boutId,
    lostOn: null,
    lostBoutId: null,
    defenses: 0,
    endReason: null,
  });
  // An interim champion is unified when they win the undisputed title.
  if (table.interimChampionId === winner.id) table.interimChampionId = null;
  notes.push(`${winner.name} is the new champion.`);
  return notes;
}
