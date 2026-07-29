import { CONFIDENCE_BAND, type Confidence } from '../types/common';
import { clamp, hashString, Rng } from '../rng';
import { ovrDisplayed, ovrRaw, RATING_KEYS, type Fighter, type FighterRatingEstimate, type Ratings } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { DIFFICULTY } from '../config/calibration';

/**
 * Scouting fog.
 *
 * The player sees exact ratings for fighters they control. Everyone else is shown an
 * estimate with an uncertainty band. The displayed estimate is a deterministic function
 * of the save seed and the fighter id, so it does not jitter every time a page is opened,
 * and improving scouting narrows the band without moving the hidden truth underneath.
 */

const CONFIDENCE_ORDER: Confidence[] = ['very-low', 'low', 'medium', 'high', 'very-high'];

function shiftConfidence(c: Confidence, steps: number): Confidence {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return CONFIDENCE_ORDER[clamp(i + steps, 0, CONFIDENCE_ORDER.length - 1)];
}

export interface ScoutingContext {
  /** Quality of the scouting available to the player, 0 to 100. */
  scoutQuality: number;
  /** True when the player controls this fighter directly. */
  ownFighter: boolean;
  /** True when the fighter is a booked opponent, which unlocks film study. */
  isBookedOpponent: boolean;
  /** Extra confidence steps from difficulty settings. */
  difficultyBonus: number;
  revealAll: boolean;
}

export function scoutingContextFor(save: SaveGame, fighter: Fighter): ScoutingContext {
  const diff = DIFFICULTY[save.settings.difficulty];
  const ownFighter =
    save.player.fighterId === fighter.id ||
    (save.player.gymId !== null && fighter.gymId === save.player.gymId);

  let scoutQuality = 40;
  if (save.player.gymId) {
    const gym = save.gyms[save.player.gymId];
    if (gym) {
      const scout = gym.staffIds.map((id) => save.staff[id]).find((s) => s && s.role === 'scout');
      const head = gym.staffIds.map((id) => save.staff[id]).find((s) => s && s.role === 'head-coach');
      scoutQuality = Math.max(scout?.quality ?? 0, (head?.quality ?? 0) * 0.6, gym.reputation * 0.5);
    }
  } else if (save.player.fighterId) {
    const self = save.fighters[save.player.fighterId];
    const gym = self?.gymId ? save.gyms[self.gymId] : null;
    if (gym) {
      const scout = gym.staffIds.map((id) => save.staff[id]).find((s) => s && s.role === 'scout');
      scoutQuality = Math.max(scout?.quality ?? 0, gym.reputation * 0.6);
    }
  }

  const playerFighter = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const isBookedOpponent = Boolean(
    playerFighter?.nextBoutId &&
      save.bouts[playerFighter.nextBoutId] &&
      (save.bouts[playerFighter.nextBoutId].fighterAId === fighter.id || save.bouts[playerFighter.nextBoutId].fighterBId === fighter.id)
  );

  return {
    scoutQuality,
    ownFighter,
    isBookedOpponent,
    difficultyBonus: diff.scoutingBonus,
    revealAll: save.settings.revealRatings || save.player.mode === 'spectator',
  };
}

/**
 * Estimated confidence for a fighter, combining the data confidence stored on the record
 * with how much the player can actually see.
 */
export function estimatedConfidence(fighter: Fighter, ctx: ScoutingContext): Confidence {
  if (ctx.ownFighter || ctx.revealAll) return 'very-high';
  const ufcFights = fighter.ufcRecord.wins + fighter.ufcRecord.losses + fighter.ufcRecord.draws;
  let base: Confidence = ufcFights >= 8 ? 'high' : ufcFights >= 4 ? 'medium' : ufcFights >= 2 ? 'low' : 'very-low';
  // A fighter with a long professional record outside the promotion is still scoutable.
  const proFights = fighter.record.wins + fighter.record.losses + fighter.record.draws;
  if (proFights >= 20) base = shiftConfidence(base, 1);
  const scoutSteps = ctx.scoutQuality >= 80 ? 2 : ctx.scoutQuality >= 60 ? 1 : ctx.scoutQuality >= 35 ? 0 : -1;
  let c = shiftConfidence(base, scoutSteps + ctx.difficultyBonus);
  if (ctx.isBookedOpponent) c = shiftConfidence(c, 1);
  return c;
}

/**
 * Produces the displayed estimate. The offset is derived from a stable hash so the same
 * fighter always shows the same estimate for a given save, avoiding the illusion that
 * ratings are drifting when only the viewer changed.
 */
export function estimateRatings(save: SaveGame, fighter: Fighter, ctx?: ScoutingContext): FighterRatingEstimate {
  const context = ctx ?? scoutingContextFor(save, fighter);
  const exact = context.ownFighter || context.revealAll;
  const confidence = estimatedConfidence(fighter, context);

  if (exact) {
    return {
      ratings: { ...fighter.ratings },
      low: { ...fighter.ratings },
      high: { ...fighter.ratings },
      ovr: ovrDisplayed(fighter.ratings),
      ovrLow: ovrDisplayed(fighter.ratings),
      ovrHigh: ovrDisplayed(fighter.ratings),
      pot: fighter.pot,
      confidence: 'very-high',
      exact: true,
    };
  }

  const band = CONFIDENCE_BAND[confidence];
  const rng = new Rng((hashString(fighter.id) ^ save.seed) >>> 0);
  const shown = {} as Ratings;
  const low = {} as Ratings;
  const high = {} as Ratings;

  for (const k of RATING_KEYS) {
    const truth = fighter.ratings[k];
    const offset = rng.normal(0, band * 0.42);
    const est = clamp(Math.round(truth + offset), 5, 99);
    shown[k] = est;
    low[k] = clamp(Math.round(est - band / 2), 5, 99);
    high[k] = clamp(Math.round(est + band / 2), 5, 99);
  }

  const ovrEst = Math.round(ovrRaw(shown));
  const potOffset = rng.normal(0, band * 0.6);
  return {
    ratings: shown,
    low,
    high,
    ovr: ovrEst,
    ovrLow: clamp(Math.round(ovrEst - band / 2), 5, 99),
    ovrHigh: clamp(Math.round(ovrEst + band / 2), 5, 99),
    pot: clamp(Math.round(fighter.pot + potOffset), ovrEst, 99),
    confidence,
    exact: false,
  };
}

/** Short scouting report used on opponent pages and fight offers. */
export function scoutingReport(save: SaveGame, fighter: Fighter): { headline: string; bullets: string[] } {
  const est = estimateRatings(save, fighter);
  const bullets: string[] = [];
  const entries = RATING_KEYS.map((k) => ({ k, v: est.ratings[k] })).sort((a, b) => b.v - a.v);
  const best = entries[0];
  const worst = entries[entries.length - 1];

  const LABEL: Record<string, string> = {
    striking: 'striking',
    grappling: 'grappling',
    wrestling: 'wrestling',
    submissions: 'submissions',
    cardio: 'cardio',
    durability: 'durability',
  };

  bullets.push(`Strongest area appears to be ${LABEL[best.k]}.`);
  if (best.v - worst.v > 12) bullets.push(`Clear weakness in ${LABEL[worst.k]}.`);
  else bullets.push('No obvious hole in the game.');

  for (const s of fighter.styleLabels.slice(0, 2)) bullets.push(`Reads as a ${s.label.toLowerCase()}.`);

  if (fighter.winStreak >= 3) bullets.push(`On a ${fighter.winStreak} fight win streak.`);
  if (fighter.lossStreak >= 2) bullets.push(`Has lost ${fighter.lossStreak} in a row.`);
  if (fighter.longevity < 45) bullets.push('Looks to have a lot of mileage on the body.');

  const headline = est.exact
    ? `Exact ratings available.`
    : `Estimate only. Confidence ${est.confidence.replace('-', ' ')}. Ovr somewhere in the ${est.ovrLow} to ${est.ovrHigh} range.`;

  return { headline, bullets };
}
