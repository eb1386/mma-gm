import { clamp, Rng } from '../rng';
import { ageOn, daysBetween, type IsoDate } from '../types/common';
import { isChampionshipBout, isFinish, type FightResult } from '../types/fight';
import type { Fighter } from '../types/fighter';
import {
  PERSONALITY_TRAITS,
  PUBLIC_LABEL_TEXT,
  TRAIT_CONFLICTS,
  totalFollowers,
  type ActivityProfile,
  type ActivityProfileKey,
  type FameProfile,
  type Personality,
  type PersonalityTrait,
  type PublicLabel,
  type SocialActionKey,
  type SocialActionOutcome,
  type SocialPlatform,
  type SocialProfile,
} from '../types/identity';
import type { SaveGame } from '../types/save';

/**
 * Personality, activity, fame and social media.
 *
 * Everything here is separate from ability. A fighter's six ratings are untouched by how
 * popular, how liked, how loud or how active they are.
 */

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generatePersonality(rng: Rng): Personality {
  const p: Personality = {
    traits: [],
    charisma: clamp(rng.normal(50, 18), 2, 98),
    mediaComfort: clamp(rng.normal(50, 18), 2, 98),
    ego: clamp(rng.normal(50, 17), 2, 98),
    loyalty: clamp(rng.normal(58, 17), 2, 98),
    moneyMotivation: clamp(rng.normal(52, 18), 2, 98),
    legacyMotivation: clamp(rng.normal(52, 18), 2, 98),
    riskTolerance: clamp(rng.normal(50, 18), 2, 98),
    discipline: clamp(rng.normal(58, 16), 2, 98),
    temper: clamp(rng.normal(45, 18), 2, 98),
    identityDrift: 0,
  };

  // Traits are drawn to be consistent with the dials, then de-conflicted.
  const candidates: [PersonalityTrait, number][] = [
    ['charismatic', p.charisma / 100],
    ['media-savvy', p.mediaComfort / 100],
    ['reserved', 1 - p.charisma / 100],
    ['private', 1 - p.mediaComfort / 100],
    ['arrogant', p.ego / 100],
    ['humble', 1 - p.ego / 100],
    ['confident', (p.ego + p.charisma) / 200],
    ['insecure', 1 - (p.ego + p.charisma) / 200],
    ['loyal', p.loyalty / 100],
    ['mercenary', 1 - p.loyalty / 100],
    ['money-motivated', p.moneyMotivation / 100],
    ['legacy-focused', p.legacyMotivation / 100],
    ['reckless', p.riskTolerance / 100],
    ['risk-averse', 1 - p.riskTolerance / 100],
    ['disciplined', p.discipline / 100],
    ['hot-tempered', p.temper / 100],
    ['emotional', p.temper / 110],
    ['aggressive', (p.temper + p.riskTolerance) / 200],
    ['respectful', (100 - p.temper) / 100],
    ['controversial', (p.temper + p.ego) / 220],
    ['fan-friendly', p.charisma / 110],
    ['funny', p.charisma / 130],
    ['awkward', 1 - p.mediaComfort / 90],
    ['honest', 0.4],
    ['calculating', 0.35],
    ['fame-seeking', p.ego / 120],
    ['family-oriented', 0.35],
    ['team-oriented', p.loyalty / 120],
    ['independent', 1 - p.loyalty / 110],
  ];

  const picked: PersonalityTrait[] = [];
  const shuffled = rng.shuffle([...candidates]);
  for (const [trait, weight] of shuffled) {
    if (picked.length >= 4) break;
    if (!rng.chance(clamp(weight, 0.02, 0.95))) continue;
    const conflicts = TRAIT_CONFLICTS.some(([x, y]) => (x === trait && picked.includes(y)) || (y === trait && picked.includes(x)));
    if (conflicts) continue;
    picked.push(trait);
  }
  if (picked.length === 0) picked.push(rng.pick(PERSONALITY_TRAITS));
  p.traits = picked;
  return p;
}

const ACTIVITY_TEMPLATES: Record<ActivityProfileKey, Omit<ActivityProfile, 'key'>> = {
  'very-active': { targetFightsPerYear: 3.4, preferredTurnaroundDays: 90, shortNoticeWillingness: 0.7, selectivity: 0.12 },
  'normally-active': { targetFightsPerYear: 2.5, preferredTurnaroundDays: 130, shortNoticeWillingness: 0.4, selectivity: 0.22 },
  selective: { targetFightsPerYear: 1.7, preferredTurnaroundDays: 190, shortNoticeWillingness: 0.15, selectivity: 0.48 },
  inactive: { targetFightsPerYear: 1.1, preferredTurnaroundDays: 260, shortNoticeWillingness: 0.1, selectivity: 0.6 },
  'injury-prone': { targetFightsPerYear: 1.6, preferredTurnaroundDays: 200, shortNoticeWillingness: 0.2, selectivity: 0.34 },
  'short-notice-specialist': { targetFightsPerYear: 3.1, preferredTurnaroundDays: 95, shortNoticeWillingness: 0.95, selectivity: 0.08 },
  'frequent-replacement': { targetFightsPerYear: 2.9, preferredTurnaroundDays: 105, shortNoticeWillingness: 0.85, selectivity: 0.1 },
  'difficult-negotiator': { targetFightsPerYear: 1.5, preferredTurnaroundDays: 210, shortNoticeWillingness: 0.12, selectivity: 0.62 },
  'frequent-defender': { targetFightsPerYear: 2.4, preferredTurnaroundDays: 140, shortNoticeWillingness: 0.3, selectivity: 0.2 },
  'waits-for-big-events': { targetFightsPerYear: 1.6, preferredTurnaroundDays: 200, shortNoticeWillingness: 0.12, selectivity: 0.55 },
  'regional-preference': { targetFightsPerYear: 2.2, preferredTurnaroundDays: 150, shortNoticeWillingness: 0.3, selectivity: 0.34 },
  'long-recovery': { targetFightsPerYear: 1.6, preferredTurnaroundDays: 230, shortNoticeWillingness: 0.15, selectivity: 0.36 },
};

export const ACTIVITY_LABEL: Record<ActivityProfileKey, string> = {
  'very-active': 'Very active',
  'normally-active': 'Normally active',
  selective: 'Selective',
  inactive: 'Inactive',
  'injury-prone': 'Injury prone',
  'short-notice-specialist': 'Short notice specialist',
  'frequent-replacement': 'Frequent replacement',
  'difficult-negotiator': 'Difficult negotiator',
  'frequent-defender': 'Defends frequently',
  'waits-for-big-events': 'Waits for big events',
  'regional-preference': 'Prefers regional events',
  'long-recovery': 'Long recovery preference',
};

export function generateActivityProfile(rng: Rng, personality: Personality, fighter: Fighter): ActivityProfile {
  const weights: [ActivityProfileKey, number][] = [
    ['very-active', 0.9 + personality.discipline / 120],
    ['normally-active', 3.2],
    ['selective', 1.1 + personality.ego / 120],
    ['inactive', 0.35],
    ['injury-prone', 0.7 + (100 - fighter.longevity) / 90],
    ['short-notice-specialist', 0.45 + personality.riskTolerance / 150],
    ['frequent-replacement', 0.4],
    ['difficult-negotiator', 0.5 + personality.moneyMotivation / 130],
    ['frequent-defender', fighter.isChampion ? 1.4 : 0.15],
    ['waits-for-big-events', fighter.isChampion ? 1.0 : 0.35],
    ['regional-preference', 0.5],
    ['long-recovery', 0.5 + Math.max(0, (fighter.ageAtSnapshot ?? 29) - 32) / 12],
  ];
  const key = rng.weighted(weights, (w) => w[1])[0];
  return { key, ...ACTIVITY_TEMPLATES[key] };
}

export function generateFame(rng: Rng, fighter: Fighter): FameProfile {
  const base = fighter.popularity;
  return {
    recognition: clamp(base + rng.normal(0, 6), 1, 100),
    favorability: clamp(rng.normal(58, 14), 1, 100),
    controversy: clamp(rng.normal(18, 12), 0, 100),
    hardcoreRespect: clamp(base * 0.7 + rng.normal(18, 12), 1, 100),
    casualInterest: clamp(base * 0.9 + rng.normal(0, 10), 1, 100),
    sponsorAppeal: clamp(base * 0.6 + rng.normal(22, 12), 1, 100),
    mediaFriendliness: clamp(rng.normal(52, 18), 1, 100),
    promotionalTrust: clamp(rng.normal(58, 14), 1, 100),
    drawingPower: base,
  };
}

export function generateSocial(rng: Rng, fighter: Fighter): SocialProfile {
  // Follower counts scale steeply with recognition, which is why the top of the roster is
  // an order of magnitude ahead of the middle.
  const scale = Math.pow(clamp(fighter.popularity, 1, 100) / 100, 2.4);
  const base = 2000 + scale * 2_400_000 * clamp(rng.normal(1, 0.45), 0.15, 2.4);
  const split = (share: number) => Math.round(base * share * clamp(rng.normal(1, 0.3), 0.2, 2));
  return {
    followers: {
      photo: split(0.45),
      text: split(0.22),
      video: split(0.24),
      longform: split(0.09),
    },
    engagement: clamp(rng.normal(50, 16), 3, 98),
    activity: clamp(rng.normal(0.5, 0.2), 0.02, 1),
    lastPostOn: null,
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Fame reactions
// ---------------------------------------------------------------------------

export interface FameChange {
  recognition: number;
  favorability: number;
  controversy: number;
  hardcore: number;
  casual: number;
  reasons: string[];
}

/**
 * How the public reacts to a completed fight. Attention and approval move separately: a
 * dull win raises recognition slightly while lowering favorability.
 */
export function fameFromResult(fighter: Fighter, result: FightResult, isMainEvent: boolean): FameChange {
  const won = result.winnerId === fighter.id;
  const change: FameChange = { recognition: 0, favorability: 0, controversy: 0, hardcore: 0, casual: 0, reasons: [] };

  change.recognition += isMainEvent ? 2.6 : 1.1;
  if (isChampionshipBout(result)) {
    change.recognition += result.isTitleFight ? 5 : 3.5;
    change.reasons.push(result.isTitleFight ? 'title fight exposure' : 'interim title fight exposure');
  }

  if (won) {
    change.favorability += 2;
    change.hardcore += 1.6;
    change.casual += 1.4;
    if (isFinish(result.method)) {
      change.recognition += 3;
      change.favorability += 3.4;
      change.casual += 3.2;
      change.hardcore += 2.2;
      change.reasons.push('finished the fight');
    }
  } else if (result.winnerId !== null) {
    change.favorability -= 1.4;
    change.casual -= 1.6;
    change.reasons.push('lost');
  }

  if (result.fightQuality > 75) {
    change.favorability += 4;
    change.hardcore += 4.5;
    change.casual += 3;
    change.reasons.push('exciting fight');
  } else if (result.fightQuality < 32) {
    change.favorability -= 3.2;
    change.hardcore -= 2.4;
    change.casual -= 2.6;
    change.reasons.push('dull fight');
  }

  if (result.fightOfTheNight) {
    change.favorability += 3;
    change.hardcore += 4;
    change.reasons.push('fight of the night');
  }

  // A controversial decision annoys the audience regardless of who won.
  if (result.method === 'decision-split') {
    change.controversy += 2.2;
    change.reasons.push('split decision');
  }

  return change;
}

export function applyFameChange(fighter: Fighter, change: FameChange): void {
  const f = fighter.fame;
  if (!f) return;
  // Attention is easier to gain than approval, and approval is easier to lose.
  f.recognition = clamp(f.recognition + change.recognition * (1 - f.recognition / 140), 1, 100);
  f.favorability = clamp(f.favorability + change.favorability, 1, 100);
  f.controversy = clamp(f.controversy + change.controversy, 0, 100);
  f.hardcoreRespect = clamp(f.hardcoreRespect + change.hardcore, 1, 100);
  f.casualInterest = clamp(f.casualInterest + change.casual, 1, 100);
  f.drawingPower = computeDrawingPower(fighter);
}

/** Drawing power blends attention, approval and reach. It is never part of Ovr. */
export function computeDrawingPower(fighter: Fighter): number {
  const f = fighter.fame;
  if (!f) return fighter.popularity;
  const reach = fighter.social ? clamp(Math.log10(Math.max(1, totalFollowers(fighter.social))) / 7.5, 0, 1) * 100 : 0;
  const approval = f.favorability * 0.55 + f.controversy * 0.25;
  return clamp(f.recognition * 0.4 + f.casualInterest * 0.22 + reach * 0.18 + approval * 0.2, 1, 100);
}

/** Weekly drift. Attention fades without activity; approval drifts back to neutral. */
export function decayFame(fighter: Fighter, save: SaveGame): void {
  const f = fighter.fame;
  if (!f) return;
  const idle = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, save.date) : 400;
  const fade = idle > 240 ? 0.35 : idle > 120 ? 0.12 : 0.03;
  f.recognition = clamp(f.recognition - fade, 1, 100);
  f.casualInterest = clamp(f.casualInterest - fade * 1.3, 1, 100);
  f.controversy = clamp(f.controversy * 0.985, 0, 100);
  f.favorability = clamp(f.favorability + (58 - f.favorability) * 0.01, 1, 100);
  f.drawingPower = computeDrawingPower(fighter);
}

/** Public labels are derived, never stored as an independent truth. */
export function derivePublicLabels(save: SaveGame, fighter: Fighter): PublicLabel[] {
  const f = fighter.fame;
  if (!f) return [];
  const out: PublicLabel[] = [];
  const finishes = fighter.methods.koWins + fighter.methods.subWins;
  const wins = Math.max(1, fighter.record.wins);
  const finishRate = finishes / wins;
  const age = ageOn(fighter.birthDate, save.date) ?? fighter.ageAtSnapshot ?? 29;
  const promoFights = fighter.ufcRecord.wins + fighter.ufcRecord.losses + fighter.ufcRecord.draws;

  if (fighter.isChampion && fighter.titleDefenses >= 3) out.push('dominant-champion');
  if (f.favorability >= 74 && f.recognition >= 55) out.push('fan-favorite');
  if (f.favorability >= 78 && f.recognition >= 80) out.push('peoples-champion');
  if (f.hardcoreRespect >= 72 && f.casualInterest < 45) out.push('hardcore-favorite');
  if (f.controversy >= 55 && f.recognition >= 55) out.push('polarizing-star');
  if (f.controversy >= 68 && f.favorability < 40) out.push('villain');
  if (finishRate > 0.65 && fighter.methods.koWins > fighter.methods.subWins) out.push('knockout-artist');
  if (finishRate > 0.6 && fighter.methods.subWins >= fighter.methods.koWins) out.push('submission-hunter');
  if (fighter.record.wins >= 6 && finishRate < 0.2 && f.favorability < 50) out.push('boring-winner');
  if (age <= 26 && promoFights <= 6 && fighter.winStreak >= 2) out.push('rising-prospect');
  if (age >= 34 && f.favorability >= 62 && promoFights >= 10) out.push('respected-veteran');
  if (f.mediaFriendliness >= 74 && f.recognition >= 50) out.push('media-darling');
  if (f.recognition >= 88 && f.casualInterest >= 78) out.push('crossover-celebrity');
  if (fighter.ranking !== null && fighter.ranking <= 8 && f.recognition < 30) out.push('unmarketable-elite');
  if (fighter.ranking !== null && f.favorability < 38) out.push('unpopular-contender');
  if (fighter.lastFightDate && daysBetween(fighter.lastFightDate, save.date) > 500 && f.recognition >= 45) {
    out.push('former-star-in-decline');
  }
  const region = fighter.regionalPopularity;
  const best = Object.entries(region).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 70 && f.recognition < 60) out.push('regional-superstar');
  if (fighter.social && totalFollowers(fighter.social) > 900_000 && f.casualInterest < 55) out.push('internet-favorite');

  return out.slice(0, 4);
}

export function publicLabelText(label: PublicLabel): string {
  return PUBLIC_LABEL_TEXT[label];
}

// ---------------------------------------------------------------------------
// Social media
// ---------------------------------------------------------------------------

const PLATFORMS: SocialPlatform[] = ['photo', 'text', 'video', 'longform'];

function zeroFollowers(): Record<SocialPlatform, number> {
  return { photo: 0, text: 0, video: 0, longform: 0 };
}

/** Passive follower movement from results, exposure and inactivity. */
export function socialFromResult(fighter: Fighter, result: FightResult, isMainEvent: boolean): Record<SocialPlatform, number> {
  const social = fighter.social;
  if (!social) return zeroFollowers();
  const won = result.winnerId === fighter.id;
  const total = Math.max(1000, totalFollowers(social));

  let rate = won ? 0.02 : -0.004;
  if (isFinish(result.method) && won) rate += 0.05;
  if (isChampionshipBout(result) && won) rate += result.isTitleFight ? 0.16 : 0.11;
  if (isMainEvent) rate += 0.02;
  if (result.fightQuality > 75) rate += 0.035;
  if (result.fightQuality < 30) rate -= 0.012;
  if (result.fightOfTheNight) rate += 0.03;
  rate *= 0.6 + (social.engagement / 100) * 0.8;

  const delta = Math.round(total * rate);
  const out = zeroFollowers();
  // Video platforms react hardest to a highlight, long form the least.
  const weights: Record<SocialPlatform, number> = { photo: 0.42, text: 0.2, video: 0.3, longform: 0.08 };
  for (const p of PLATFORMS) out[p] = Math.round(delta * weights[p]);
  return out;
}

export function applyFollowerChange(fighter: Fighter, change: Record<SocialPlatform, number>): void {
  const s = fighter.social;
  if (!s) return;
  for (const p of PLATFORMS) s.followers[p] = Math.max(0, Math.round(s.followers[p] + change[p]));
}

/** Weekly drift. Silence costs reach. */
export function decaySocial(fighter: Fighter, save: SaveGame): void {
  const s = fighter.social;
  if (!s) return;
  const idle = s.lastPostOn ? daysBetween(s.lastPostOn, save.date) : 999;
  const fightIdle = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, save.date) : 400;
  let rate = 0;
  if (fightIdle > 300) rate += 0.0025;
  if (idle > 60) rate += 0.0015;
  if (fighter.lossStreak >= 2) rate += 0.0015;
  if (rate <= 0) return;
  for (const p of PLATFORMS) s.followers[p] = Math.max(0, Math.round(s.followers[p] * (1 - rate)));
  if (Number(save.date.slice(8, 10)) <= 7) {
    s.history.push({ date: save.date, total: totalFollowers(s) });
    if (s.history.length > 240) s.history.shift();
  }
}

export interface SocialActionDefinition {
  key: SocialActionKey;
  label: string;
  description: string;
  /** Base chance the post lands well, before personality. */
  baseSuccess: number;
  /** Which personality dial makes this action work. */
  driver: keyof Personality;
}

export const SOCIAL_ACTIONS: SocialActionDefinition[] = [
  { key: 'training-footage', label: 'Post training footage', description: 'Safe and steady. Small gain, almost no risk.', baseSuccess: 0.88, driver: 'discipline' },
  { key: 'callout', label: 'Call out an opponent', description: 'Raises hype and attention. Looks desperate if the results are not there.', baseSuccess: 0.55, driver: 'charisma' },
  { key: 'compliment-opponent', label: 'Compliment an opponent', description: 'Builds goodwill and respect, and lowers the temperature of a rivalry.', baseSuccess: 0.86, driver: 'mediaComfort' },
  { key: 'respond-to-criticism', label: 'Respond to criticism', description: 'Can land well or look thin skinned.', baseSuccess: 0.5, driver: 'mediaComfort' },
  { key: 'promote-sponsor', label: 'Promote a sponsor', description: 'Pays, and costs a little credibility with hardcore fans.', baseSuccess: 0.78, driver: 'mediaComfort' },
  { key: 'make-a-joke', label: 'Make a joke', description: 'Big upside with charisma. Awkward without it.', baseSuccess: 0.5, driver: 'charisma' },
  { key: 'start-an-argument', label: 'Start an argument', description: 'Attention at the cost of approval. Sponsors notice.', baseSuccess: 0.42, driver: 'ego' },
  { key: 'announce-injury', label: 'Announce an injury', description: 'Honest and sympathetic, but signals unavailability.', baseSuccess: 0.8, driver: 'mediaComfort' },
  { key: 'tease-division-move', label: 'Tease a division move', description: 'Generates speculation and interest.', baseSuccess: 0.66, driver: 'charisma' },
  { key: 'demand-title-shot', label: 'Demand a title shot', description: 'Works with results behind it. Without them it grates.', baseSuccess: 0.48, driver: 'ego' },
  { key: 'defend-teammate', label: 'Defend a teammate', description: 'Builds loyalty and team standing.', baseSuccess: 0.8, driver: 'loyalty' },
  { key: 'go-silent', label: 'Go silent', description: 'No risk and no reward. Reach slowly fades.', baseSuccess: 1, driver: 'discipline' },
  { key: 'hire-social-manager', label: 'Hire a social media manager', description: 'Costs money, raises engagement and reduces the chance of an embarrassing post.', baseSuccess: 0.95, driver: 'moneyMotivation' },
];

/**
 * Resolves a social action. Every action that can succeed can also fail, and a failed
 * post reads as desperate, forced, or embarrassing rather than simply doing nothing.
 */
/**
 * How many deliberate social actions a fighter can take in a week.
 *
 * Without a limit the interface offered an unlimited button that only ever added followers, so
 * reach and engagement could be maximised without a single day passing. Posting more than a few
 * times a week is also the behaviour that makes an account look desperate.
 */
export const SOCIAL_ACTIONS_PER_WEEK = 3;

/** Whether the fighter has any social actions left this week, and why not. */
export function socialActionAllowance(save: SaveGame, fighter: Fighter): { remaining: number; reason: string | null } {
  const s = fighter.social;
  if (!s) return { remaining: SOCIAL_ACTIONS_PER_WEEK, reason: null };
  const used = s.actionsThisWeek ?? 0;
  const weekOf = s.actionWeekOf ?? null;
  const currentWeek = save.date.slice(0, 10);
  // The counter is keyed to a week, so a stale counter from a previous week does not carry over.
  const sameWeek = weekOf !== null && daysBetween(weekOf, currentWeek) < 7;
  const spent = sameWeek ? used : 0;
  const remaining = Math.max(0, SOCIAL_ACTIONS_PER_WEEK - spent);
  return {
    remaining,
    reason: remaining > 0 ? null : 'You have posted enough this week. Posting again now would look desperate.',
  };
}

export function performSocialAction(save: SaveGame, fighter: Fighter, key: SocialActionKey, rng: Rng): SocialActionOutcome {
  const def = SOCIAL_ACTIONS.find((a) => a.key === key)!;
  const personality = fighter.personality;
  const social = fighter.social;
  const fame = fighter.fame;

  // Record the action against this week's allowance. Going quiet does not consume one, because
  // it is the absence of an action.
  if (key !== 'go-silent' && social) {
    const currentWeek = save.date.slice(0, 10);
    const previous = social.actionWeekOf ?? null;
    const sameWeek = previous !== null ? daysBetween(previous, currentWeek) < 7 : false;
    social.actionsThisWeek = (sameWeek ? (social.actionsThisWeek ?? 0) : 0) + 1;
    social.actionWeekOf = sameWeek ? previous : currentWeek;
  }
  const out: SocialActionOutcome = {
    key,
    headline: def.label,
    detail: '',
    followerChange: zeroFollowers(),
    favorabilityChange: 0,
    controversyChange: 0,
    recognitionChange: 0,
    hypeChange: 0,
    matchmakerChange: 0,
    succeeded: true,
  };
  if (!social || !fame || !personality) return out;

  const driver = personality[def.driver] as number;
  const credibility = clamp((fighter.winStreak * 8 + (fighter.ranking !== null ? 16 - fighter.ranking : 0)) / 30, 0, 1);
  const successChance = clamp(def.baseSuccess * (0.55 + (driver / 100) * 0.7) * (0.7 + credibility * 0.5), 0.05, 0.97);
  const success = rng.chance(successChance);
  out.succeeded = success;

  const reach = Math.max(2000, totalFollowers(social));
  const applyFollowers = (rate: number) => {
    const delta = Math.round(reach * rate);
    out.followerChange = { photo: Math.round(delta * 0.42), text: Math.round(delta * 0.24), video: Math.round(delta * 0.26), longform: Math.round(delta * 0.08) };
  };

  switch (key) {
    case 'training-footage':
      applyFollowers(success ? 0.006 : 0.001);
      out.detail = success ? 'Clean footage, good reaction from the usual audience.' : 'It went out to almost nobody.';
      break;
    case 'callout':
      if (success) {
        applyFollowers(0.03);
        out.recognitionChange = 3;
        out.hypeChange = 9;
        out.detail = 'The callout landed and got picked up widely.';
      } else {
        applyFollowers(-0.004);
        out.favorabilityChange = -3;
        out.controversyChange = 2;
        out.detail = 'It read as desperate. The fighter called out did not even respond.';
      }
      break;
    case 'compliment-opponent':
      out.favorabilityChange = success ? 3 : 0.5;
      applyFollowers(success ? 0.004 : 0);
      out.detail = success ? 'Well received, and it cooled the temperature.' : 'Barely noticed.';
      break;
    case 'respond-to-criticism':
      if (success) {
        out.favorabilityChange = 2.5;
        out.recognitionChange = 1.5;
        applyFollowers(0.008);
        out.detail = 'A sharp reply that won the exchange.';
      } else {
        out.favorabilityChange = -4;
        out.controversyChange = 4;
        out.detail = 'It came across as thin skinned and gave the story another day.';
      }
      break;
    case 'promote-sponsor':
      out.favorabilityChange = success ? -0.5 : -2.5;
      applyFollowers(success ? 0.001 : -0.003);
      out.detail = success ? 'The sponsor is happy with the reach.' : 'It read as a paid post and the audience said so.';
      break;
    case 'make-a-joke':
      if (success) {
        applyFollowers(0.022);
        out.favorabilityChange = 4;
        out.recognitionChange = 2;
        out.detail = 'It went well beyond the usual audience.';
      } else {
        out.favorabilityChange = -3.5;
        out.controversyChange = 3;
        out.detail = 'It did not land, and it was quoted back all week.';
      }
      break;
    case 'start-an-argument':
      out.recognitionChange = success ? 5 : 2;
      out.controversyChange = success ? 6 : 9;
      out.favorabilityChange = success ? -2 : -7;
      applyFollowers(success ? 0.035 : 0.012);
      out.matchmakerChange = -2;
      out.detail = success
        ? 'Plenty of attention, and not all of it friendly.'
        : 'It got ugly and the sponsors noticed before the fans did.';
      break;
    case 'announce-injury':
      out.favorabilityChange = 1.5;
      out.matchmakerChange = -1;
      out.detail = 'The news was taken sympathetically, but availability is now a question.';
      break;
    case 'tease-division-move':
      out.recognitionChange = success ? 2.5 : 0.5;
      out.hypeChange = success ? 4 : 0;
      applyFollowers(success ? 0.012 : 0.001);
      out.detail = success ? 'Speculation took off immediately.' : 'Nobody took the hint seriously.';
      break;
    case 'demand-title-shot':
      if (success) {
        out.recognitionChange = 3;
        out.hypeChange = 6;
        out.matchmakerChange = 1;
        applyFollowers(0.016);
        out.detail = 'The case was made well and the matchmaker heard it.';
      } else {
        out.favorabilityChange = -3;
        out.matchmakerChange = -4;
        out.detail = 'The results do not support the demand, and it was pointed out.';
      }
      break;
    case 'defend-teammate':
      out.favorabilityChange = success ? 2.5 : -1;
      applyFollowers(success ? 0.006 : 0);
      out.detail = success ? 'The gym appreciated it publicly.' : 'It dragged the gym into a story it did not want.';
      break;
    case 'go-silent':
      out.detail = 'Nothing posted. Reach will fade a little.';
      break;
    case 'hire-social-manager':
      social.engagement = clamp(social.engagement + 14, 0, 100);
      out.detail = 'A manager is now handling the accounts. Posts will land better.';
      break;
  }

  applyFollowerChange(fighter, out.followerChange);
  fame.favorability = clamp(fame.favorability + out.favorabilityChange, 1, 100);
  fame.controversy = clamp(fame.controversy + out.controversyChange, 0, 100);
  fame.recognition = clamp(fame.recognition + out.recognitionChange, 1, 100);
  fame.drawingPower = computeDrawingPower(fighter);
  fighter.relationships.matchmaker = clamp(fighter.relationships.matchmaker + out.matchmakerChange, 0, 100);
  // Going quiet is not posting. Recording it as a post was self defeating: the one action whose
  // entire purpose is to let attention fade was also the action that reset the idle clock, so the
  // decay it is supposed to cause could never begin. Hiring a manager is not a post either.
  if (key !== 'go-silent' && key !== 'hire-social-manager') social.lastPostOn = save.date;
  // Repeated choices gradually shape identity rather than switching it instantly.
  personality.identityDrift = clamp(personality.identityDrift + 0.02, 0, 1);
  return out;
}

// ---------------------------------------------------------------------------
// Activity reporting
// ---------------------------------------------------------------------------

export interface ActivityReport {
  fightsPerYear: number;
  daysSinceLastFight: number | null;
  averageTurnaroundDays: number | null;
  shortestTurnaroundDays: number | null;
  longestLayoffDays: number | null;
  shortNoticeFights: number;
  offersAccepted: number;
  offersDeclined: number;
  label: string;
  estimatedReturn: IsoDate | null;
  inactivityReason: string | null;
}

export function activityReport(save: SaveGame, fighter: Fighter): ActivityReport {
  const dates = fighter.boutIds
    .map((id) => save.history.results[id]?.date)
    .filter((d): d is IsoDate => Boolean(d))
    .sort();
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));

  const careerDays = dates.length > 0 ? Math.max(365, daysBetween(dates[0], save.date)) : 365;
  const fightsPerYear = (dates.length / careerDays) * 365;
  const daysSince = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, save.date) : null;

  let reason: string | null = null;
  let estimatedReturn: IsoDate | null = null;
  const activeInjury = fighter.injuries.find((i) => i.actualReturn === null && i.expectedReturn >= save.date);
  if (fighter.retired) reason = 'Retired.';
  else if (activeInjury) {
    reason = `Recovering from ${activeInjury.type.toLowerCase()}.`;
    estimatedReturn = activeInjury.expectedReturn;
  } else if (fighter.medicalSuspension && fighter.medicalSuspension.until > save.date) {
    reason = fighter.medicalSuspension.reason;
    estimatedReturn = fighter.medicalSuspension.until;
  } else if (fighter.nextBoutId) {
    reason = null;
    estimatedReturn = save.bouts[fighter.nextBoutId]?.date ?? null;
  } else {
    const contract = fighter.contractId ? save.contracts[fighter.contractId] : null;
    if (!contract || contract.status !== 'active') reason = 'No active contract.';
    else if (daysSince !== null && daysSince < (fighter.activityProfile?.preferredTurnaroundDays ?? 120)) {
      reason = 'Still inside a normal turnaround.';
    } else reason = 'Waiting on a suitable offer.';
  }

  return {
    fightsPerYear,
    daysSinceLastFight: daysSince,
    averageTurnaroundDays: gaps.length > 0 ? gaps.reduce((s, v) => s + v, 0) / gaps.length : null,
    shortestTurnaroundDays: gaps.length > 0 ? Math.min(...gaps) : null,
    longestLayoffDays: gaps.length > 0 ? Math.max(...gaps) : null,
    shortNoticeFights: fighter.acceptedShortNotice,
    offersAccepted: fighter.boutIds.length,
    offersDeclined: fighter.declinedOffers,
    label: fighter.activityProfile ? ACTIVITY_LABEL[fighter.activityProfile.key] : 'Unknown',
    estimatedReturn,
    inactivityReason: reason,
  };
}

/**
 * Whether an AI fighter is willing to take a bout right now, given their profile and
 * circumstances. This is what stops every fighter competing at the same rate.
 */
export function willingToFight(save: SaveGame, fighter: Fighter, noticeDays: number, on: IsoDate): boolean {
  const profile = fighter.activityProfile;
  if (!profile) return true;

  const since = fighter.lastFightDate ? daysBetween(fighter.lastFightDate, on) : 999;
  // A fighter inside their preferred turnaround usually says no, but not always.
  if (since < profile.preferredTurnaroundDays) {
    const shortfall = 1 - since / profile.preferredTurnaroundDays;
    if (shortfall > 0.55) return false;
  }
  if (noticeDays < 24 && profile.shortNoticeWillingness < 0.3) return false;

  // Someone already at their yearly target becomes harder to book.
  const report = activityReport(save, fighter);
  if (report.fightsPerYear > profile.targetFightsPerYear * 1.35) return false;

  return true;
}
