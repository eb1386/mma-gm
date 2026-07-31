import { hashString, Rng } from '../rng';
import { addDays, daysBetween, type FighterId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { addHypeMoment, escalateRivalry, findRivalry, hypeStore } from './hype';
import { applyRelationship } from './relationships';
import { PROMOTION_MARKETING } from '../config/branding';
import { record } from './finance';

/**
 * Social and media items that arrive through the inbox.
 *
 * Content is composed rather than written out. A template supplies the shape of an item,
 * context tags decide which templates are eligible, and the fragments that fill it are
 * chosen from banks keyed on tone. A few dozen templates and a few hundred fragments cover
 * many thousands of distinct items, and a rolling signature history stops the same one
 * appearing twice in a row.
 */

export type SocialTone =
  | 'respectful'
  | 'confident'
  | 'aggressive'
  | 'funny'
  | 'dismissive'
  | 'technical'
  | 'emotional'
  | 'honest'
  | 'evasive'
  | 'promotional'
  | 'controversial'
  | 'silent';

export const TONE_LABEL: Record<SocialTone, string> = {
  respectful: 'Respectful',
  confident: 'Confident',
  aggressive: 'Aggressive',
  funny: 'Funny',
  dismissive: 'Dismissive',
  technical: 'Technical',
  emotional: 'Emotional',
  honest: 'Honest',
  evasive: 'Evasive',
  promotional: 'Promotional',
  controversial: 'Controversial',
  silent: 'Say nothing',
};

/** Where an item came from. */
export type SocialSource = 'opponent' | 'fans' | 'reporter' | 'teammate' | 'champion' | 'promotion' | 'sponsor' | 'rival' | 'former-opponent';

export type SocialContext =
  | 'fight-booked'
  | 'fight-week'
  | 'callout'
  | 'insult'
  | 'compliment'
  | 'training-footage'
  | 'weight-concern'
  | 'injury-rumor'
  | 'inactivity'
  | 'viral-clip'
  | 'judging-debate'
  | 'title-talk'
  | 'rematch-request'
  | 'promotion-request'
  | 'sponsor-request'
  | 'quote-out-of-context'
  | 'after-win'
  | 'after-loss';

export interface SocialReply {
  key: string;
  tone: SocialTone;
  label: string;
  /** What the player would be posting, composed for this exact item. */
  text: string;
  /** Short warning shown before selection when a choice carries real risk. */
  risk: string | null;
  effects: SocialEffects;
}

export interface SocialEffects {
  hype?: number;
  favorability?: number;
  controversy?: number;
  followers?: number;
  rivalry?: number;
  opponentFocus?: number;
  confidence?: number;
  mediaReputation?: number;
  promotionRelationship?: number;
  sponsorRisk?: number;
  fineRisk?: number;
}

export interface SocialItem {
  id: string;
  date: IsoDate;
  expiresOn: IsoDate;
  source: SocialSource;
  sourceName: string;
  sourceFighterId: FighterId | null;
  targetFighterId: FighterId;
  context: SocialContext;
  headline: string;
  body: string;
  replies: SocialReply[];
  selectedReplyKey: string | null;
  immediateReaction: string | null;
  resolvedOn: IsoDate | null;
  /** Stable identity so the same item is never generated twice. */
  idempotencyKey: string;
  /** Coarse signature used to avoid repeating the same shape of item. */
  signature: string;
  boutId: string | null;
}

// ---------------------------------------------------------------------------
// Fragment banks
// ---------------------------------------------------------------------------

const OPENERS: Record<SocialTone, string[]> = {
  respectful: ['Nothing but respect for {opp}.', 'A real test, and I am glad to have it.', '{opp} has earned every bit of this.'],
  confident: ['I have seen enough. {date} answers it.', 'The work is done. All that is left is the walk.', 'I like where I am at.'],
  aggressive: ['{opp} is going to find out what this level costs.', 'Talk all week. I only need fifteen minutes.', 'Somebody is getting carried out and it is not me.'],
  funny: ['Big words for someone who has to make weight too.', 'I have read the tweets. The grammar worries me more than the wrestling.', 'Sure. Bring a mouthguard.'],
  dismissive: ['Not thinking about it.', 'Next question.', 'He can say what he likes. It does not change the matchup.'],
  technical: ['The read is simple. He resets to his right every time he is pressured.', 'It comes down to whether he can hold the center. He cannot.', 'Watch the second round of his last fight and you have the whole plan.'],
  emotional: ['This one means more than people know.', 'I have given up a lot to be standing here.', 'My family has carried this with me.'],
  honest: ['Honestly, it is a hard fight. That is why I took it.', 'I have doubts like anyone. I just do the work anyway.', 'He is good. I think I am better.'],
  evasive: ['We will see on the night.', 'I do not want to get into that.', 'The fight is the answer.'],
  promotional: ['{event}. You do not want to miss this one.', 'Tell a friend. This is the one to watch.', 'Two fighters who came to finish. {date}.'],
  controversial: ['Half this division is protected and everyone knows it.', 'I said what I said. Somebody had to.', 'They gave him the ranking. I am taking it back.'],
  silent: [],
};

const CLOSERS: Record<SocialTone, string[]> = {
  respectful: ['See you in there.', 'Good luck to him on the scale.', 'Let the fight decide it.'],
  confident: ['That is all.', 'See you {date}.', 'Nothing changes.'],
  aggressive: ['Bring whatever you have.', 'I will be waiting.', 'Say it again on Saturday.'],
  funny: ['Anyway, back to training.', 'Love you all.', 'Somebody get him a coach.'],
  dismissive: ['Moving on.', 'That is it from me.', ''],
  technical: ['That is the fight.', 'It is not complicated.', 'Simple as that.'],
  emotional: ['Thank you to everyone who stayed.', 'This is for them.', 'I am ready.'],
  honest: ['That is where I am at.', 'No spin.', 'Take it how you want.'],
  evasive: ['That is all I will say.', '', 'We will talk after.'],
  promotional: ['Do not miss it.', 'Tickets are moving.', 'Tune in.'],
  controversial: ['Quote me.', 'Somebody had to say it.', 'I am not apologizing.'],
  silent: [],
};

const CROWD_REACTION = [
  'The clip does numbers by the evening.',
  'It gets picked up by two of the bigger accounts within the hour.',
  'The replies are split down the middle.',
  'Most of the responses are supportive.',
  'A few of the responses are not printable.',
  'It barely registers. The timeline moves on.',
  'The comment section turns into an argument about the last fight.',
];

// ---------------------------------------------------------------------------
// Item templates
// ---------------------------------------------------------------------------

interface Template {
  key: string;
  context: SocialContext;
  source: SocialSource;
  /** Which situations this template fits. */
  applies: (ctx: GenerationContext) => boolean;
  headline: (ctx: GenerationContext) => string;
  body: (ctx: GenerationContext) => string;
  /** Which tones make sense as a reply here. */
  tones: SocialTone[];
  baseEffects?: SocialEffects;
}

export interface GenerationContext {
  save: SaveGame;
  me: Fighter;
  opponent: Fighter | null;
  eventName: string | null;
  eventDate: IsoDate | null;
  boutId: string | null;
  daysToFight: number | null;
  isTitleFight: boolean;
  rivalryIntensity: number;
  lastResultWasWin: boolean | null;
  daysSinceLastFight: number | null;
  rng: Rng;
}

function fill(text: string, ctx: GenerationContext): string {
  return text
    .replace(/\{opp\}/g, ctx.opponent?.name ?? 'the opponent')
    .replace(/\{me\}/g, ctx.me.name)
    .replace(/\{event\}/g, ctx.eventName ?? 'the card')
    .replace(/\{date\}/g, ctx.eventDate ?? 'fight night');
}

const TEMPLATES: Template[] = [
  {
    key: 'opp-training-footage',
    context: 'training-footage',
    source: 'opponent',
    applies: (c) => Boolean(c.opponent) && (c.daysToFight ?? 99) < 60,
    headline: (c) => `${c.opponent!.name} posts training footage`,
    body: (c) =>
      `${c.opponent!.name} put out a clip from camp. ${c.rng.pick([
        'Hard rounds, and the timing looks sharp.',
        'It is mostly pad work, edited well.',
        'The wrestling looks noticeably better than last time out.',
        'It is a highlight reel of one good round.',
      ])} The caption mentions you by name.`,
    tones: ['respectful', 'confident', 'dismissive', 'funny', 'technical'],
  },
  {
    key: 'opp-callout',
    context: 'callout',
    source: 'opponent',
    applies: (c) => Boolean(c.opponent),
    headline: (c) => `${c.opponent!.name} calls you out`,
    body: (c) =>
      `${c.opponent!.name} says ${c.rng.pick([
        'you have been ducking the fight for a year',
        'the promotion had to talk you into this',
        'he has your number and everyone can see it',
        'you are the easiest name on the list',
      ])}. It is already being written up.`,
    tones: ['aggressive', 'dismissive', 'funny', 'confident', 'silent'],
    baseEffects: { rivalry: 6 },
  },
  {
    key: 'opp-insult',
    context: 'insult',
    source: 'opponent',
    applies: (c) => Boolean(c.opponent) && c.rivalryIntensity > 20,
    headline: (c) => `${c.opponent!.name} takes a shot at you`,
    body: (c) =>
      `${c.opponent!.name} posted something ${c.rng.pick(['personal', 'about your last performance', 'about your team', 'about your chin'])}. ${c.rng.pick(
        ['It is getting traction.', 'Your teammates are already replying.', 'The promotion has not commented.']
      )}`,
    tones: ['aggressive', 'controversial', 'dismissive', 'funny', 'silent'],
    baseEffects: { rivalry: 10 },
  },
  {
    key: 'opp-compliment',
    context: 'compliment',
    source: 'opponent',
    applies: (c) => Boolean(c.opponent) && c.rivalryIntensity < 25,
    headline: (c) => `${c.opponent!.name} speaks well of you`,
    body: (c) => `${c.opponent!.name} called you ${c.rng.pick(['the toughest out in the division', 'a problem for anyone', 'the fight he wanted'])}. No edge to it.`,
    tones: ['respectful', 'confident', 'honest', 'funny'],
  },
  {
    key: 'fans-inactivity',
    context: 'inactivity',
    source: 'fans',
    applies: (c) => (c.daysSinceLastFight ?? 0) > 240 && !c.opponent,
    headline: () => 'Fans are asking where you have been',
    body: (c) => `A thread about the division has turned into an argument about your last ${Math.round((c.daysSinceLastFight ?? 300) / 30)} months out of the cage.`,
    tones: ['honest', 'promotional', 'dismissive', 'emotional'],
  },
  {
    key: 'fans-matchup-criticism',
    context: 'fight-booked',
    source: 'fans',
    applies: (c) => Boolean(c.opponent) && (c.daysToFight ?? 99) < 70,
    headline: () => 'Fans are picking the matchup apart',
    body: (c) =>
      `The booking is getting ${c.rng.pick(['a lukewarm reception', 'more attention than expected', 'compared unfavourably to another fight in the division'])}. ${c.rng.pick(
        ['Plenty of people think it is a mismatch.', 'The consensus has you as the underdog.', 'Most people expect a finish.']
      )}`,
    tones: ['promotional', 'confident', 'dismissive', 'funny', 'technical'],
  },
  {
    key: 'reporter-rumor',
    context: 'injury-rumor',
    source: 'reporter',
    applies: (c) => Boolean(c.opponent) && (c.daysToFight ?? 99) < 45,
    headline: () => 'A reporter is chasing an injury rumor',
    body: (c) =>
      `A reporter has asked whether camp has been interrupted. ${c.rng.pick([
        'Nothing has been published yet.',
        'They say two sources mentioned it.',
        'It is already half a story on social media.',
      ])}`,
    tones: ['honest', 'evasive', 'dismissive', 'confident'],
    baseEffects: { mediaReputation: 1 },
  },
  {
    key: 'weight-concern',
    context: 'weight-concern',
    source: 'fans',
    applies: (c) => Boolean(c.opponent) && (c.daysToFight ?? 99) < 21,
    headline: () => 'A weight cut clip is worrying people',
    body: () => 'A short clip from the gym has people speculating about how much is left to come off. It has been reposted with some unkind commentary.',
    tones: ['confident', 'honest', 'dismissive', 'funny'],
  },
  {
    key: 'viral-clip',
    context: 'viral-clip',
    source: 'fans',
    applies: () => true,
    headline: () => 'A clip of yours is going around',
    body: (c) =>
      `An old clip of you ${c.rng.pick(['finishing a sparring round', 'answering a question badly', 'warming up', 'in a scramble'])} has resurfaced and is being shared widely.`,
    tones: ['funny', 'promotional', 'dismissive', 'honest'],
  },
  {
    key: 'promotion-promote',
    context: 'promotion-request',
    source: 'promotion',
    applies: (c) => Boolean(c.opponent) && (c.daysToFight ?? 99) < 35,
    headline: (c) => `The promotion wants you promoting ${c.eventName ?? 'the card'}`,
    body: (c) => `Marketing has asked for a post about ${c.eventName ?? 'the event'} on ${c.eventDate ?? 'fight night'}. It is a request, not an obligation.`,
    tones: ['promotional', 'confident', 'funny', 'silent'],
    baseEffects: { promotionRelationship: 2 },
  },
  {
    key: 'champion-dismissal',
    context: 'title-talk',
    source: 'champion',
    applies: (c) => {
      const table = c.save.rankings[c.me.divisionId];
      return Boolean(table?.championId) && table.championId !== c.me.id && (c.me.ranking ?? 99) <= 6;
    },
    headline: (c) => {
      const table = c.save.rankings[c.me.divisionId];
      const champ = table.championId ? c.save.fighters[table.championId] : null;
      return `${champ?.name ?? 'The champion'} does not rate you`;
    },
    body: (c) => {
      const table = c.save.rankings[c.me.divisionId];
      const champ = table.championId ? c.save.fighters[table.championId] : null;
      return `${champ?.name ?? 'The champion'} was asked about you and said ${c.rng.pick([
        'the division has more interesting names',
        'you need another win first',
        'he does not think about you at all',
      ])}.`;
    },
    tones: ['aggressive', 'confident', 'respectful', 'controversial'],
    baseEffects: { rivalry: 5 },
  },
  {
    key: 'former-opponent-rematch',
    context: 'rematch-request',
    source: 'former-opponent',
    applies: (c) => c.me.record.wins + c.me.record.losses > 4 && !c.opponent,
    headline: () => 'A former opponent wants it again',
    body: (c) => `Somebody you have already beaten is publicly asking for a rematch, saying ${c.rng.pick(['the first one was close', 'he was hurt going in', 'he has changed camps'])}.`,
    tones: ['dismissive', 'respectful', 'confident', 'funny'],
  },
  {
    key: 'teammate-defense',
    context: 'compliment',
    source: 'teammate',
    applies: (c) => Boolean(c.me.gymId) && c.rivalryIntensity > 15,
    headline: () => 'A teammate has stepped in for you',
    body: () => 'One of your training partners has replied to the noise on your behalf. It is well meant and slightly heated.',
    tones: ['respectful', 'funny', 'honest', 'silent'],
  },
  {
    key: 'judging-debate',
    context: 'judging-debate',
    source: 'fans',
    applies: (c) => c.lastResultWasWin !== null,
    headline: () => 'A scorecard argument has your name in it',
    body: (c) => `An argument about judging in the division keeps circling back to your last fight. ${c.rng.pick(['Opinion is divided.', 'Most people agree with the decision.', 'A former judge weighed in.'])}`,
    tones: ['honest', 'technical', 'dismissive', 'controversial'],
  },
  {
    key: 'quote-out-of-context',
    context: 'quote-out-of-context',
    source: 'reporter',
    applies: (c) => (c.daysToFight ?? 99) < 30,
    headline: () => 'A quote of yours has been cut short',
    body: () => 'Something you said in an interview has been clipped so it reads far worse than you meant it. It is spreading faster than the full version.',
    tones: ['honest', 'funny', 'dismissive', 'emotional', 'silent'],
    baseEffects: { controversy: 3 },
  },
  {
    key: 'after-win-praise',
    context: 'after-win',
    source: 'fans',
    applies: (c) => c.lastResultWasWin === true && (c.daysSinceLastFight ?? 99) < 12,
    headline: () => 'The win is getting attention',
    body: (c) => `The performance is being replayed and picked apart. ${c.rng.pick(['People want to know who is next.', 'The finish is doing the rounds.', 'A few of the bigger names have commented.'])}`,
    tones: ['confident', 'respectful', 'promotional', 'emotional', 'aggressive'],
  },
  {
    key: 'after-loss-criticism',
    context: 'after-loss',
    source: 'fans',
    applies: (c) => c.lastResultWasWin === false && (c.daysSinceLastFight ?? 99) < 12,
    headline: () => 'The loss is being dissected',
    body: (c) => `The result has people questioning ${c.rng.pick(['your gas tank', 'the game plan', 'the corner', 'whether the ranking was ever right'])}.`,
    tones: ['honest', 'emotional', 'dismissive', 'confident', 'silent'],
  },
  {
    key: 'sponsor-post',
    context: 'sponsor-request',
    source: 'sponsor',
    applies: (c) => c.me.popularity > 25,
    headline: () => 'A sponsor wants a post',
    body: () => 'A brand you work with has asked for one post before the fight. It is straightforward and it pays.',
    tones: ['promotional', 'funny', 'honest', 'silent'],
    baseEffects: { sponsorRisk: -2 },
  },
];

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const EFFECT_BY_TONE: Record<SocialTone, SocialEffects> = {
  respectful: { favorability: 3, hype: 1, mediaReputation: 2, rivalry: -3 },
  confident: { favorability: 2, hype: 3, confidence: 2 },
  aggressive: { hype: 6, controversy: 4, rivalry: 8, favorability: -1, opponentFocus: 3 },
  funny: { favorability: 4, followers: 400, hype: 2 },
  dismissive: { hype: -1, rivalry: 2, favorability: -1, opponentFocus: 2 },
  technical: { mediaReputation: 3, favorability: 1, hype: 1 },
  emotional: { favorability: 5, followers: 300, confidence: -1 },
  honest: { favorability: 4, mediaReputation: 3 },
  evasive: { mediaReputation: -2, hype: -1 },
  promotional: { hype: 5, promotionRelationship: 4, followers: 200 },
  controversial: { hype: 8, controversy: 9, favorability: -4, fineRisk: 6, sponsorRisk: 5, rivalry: 6 },
  silent: { hype: -2, mediaReputation: -1, followers: -50 },
};

const RISK_TEXT: Partial<Record<SocialTone, string>> = {
  controversial: 'Likely to draw a fine or a sponsor complaint.',
  aggressive: 'Raises the temperature. The opponent will respond.',
  dismissive: 'Reads as disrespect to some of the audience.',
  silent: 'Saying nothing costs a little attention.',
  evasive: 'Reporters notice when a question is dodged.',
};

function composeReply(tone: SocialTone, ctx: GenerationContext, template: Template): SocialReply {
  const opener = OPENERS[tone].length > 0 ? fill(ctx.rng.pick(OPENERS[tone]), ctx) : '';
  const closer = CLOSERS[tone].length > 0 ? fill(ctx.rng.pick(CLOSERS[tone]), ctx) : '';
  const text = tone === 'silent' ? 'No reply.' : [opener, closer].filter(Boolean).join(' ');
  const base = template.baseEffects ?? {};
  const toneEffects = EFFECT_BY_TONE[tone];
  const effects: SocialEffects = { ...toneEffects };
  for (const [k, v] of Object.entries(base)) {
    const key = k as keyof SocialEffects;
    effects[key] = (effects[key] ?? 0) + (v ?? 0);
  }
  return {
    key: `${template.key}-${tone}`,
    tone,
    label: TONE_LABEL[tone],
    text,
    risk: RISK_TEXT[tone] ?? null,
    effects,
  };
}

/** How many meaningful social items this week is allowed to produce. */
export function weeklySocialBudget(ctx: GenerationContext): number {
  // A promoted camp should produce two to five meaningful social interactions across six
  // to eight weeks, so roughly one every week or two while a fight is booked.
  const days = ctx.daysToFight;
  let budget = 0;
  if (days !== null && days <= 7) budget = 2;
  else if (days !== null && days <= 60) budget = 1;
  else if (days !== null) budget = 1;
  else budget = ctx.rng.chance(0.35) ? 1 : 0;
  if (ctx.rivalryIntensity > 55) budget += 1;
  const openness = ctx.me.personality?.mediaComfort ?? 0.5;
  if (openness < 0.3) budget = Math.max(0, budget - 1);
  if (ctx.me.popularity > 65) budget += 1;
  return Math.min(3, budget);
}

export function buildContext(save: SaveGame, me: Fighter, rng: Rng): GenerationContext {
  const bout = me.nextBoutId ? save.bouts[me.nextBoutId] : null;
  const live = bout && bout.status === 'scheduled' ? bout : null;
  const opponent = live ? save.fighters[live.fighterAId === me.id ? live.fighterBId : live.fighterAId] ?? null : null;
  const event = live ? save.events[live.eventId] ?? null : null;
  const lastResultId = me.boutIds.filter((id) => save.history.results[id]).pop();
  const lastResult = lastResultId ? save.history.results[lastResultId] : null;
  const rivalry = opponent ? findRivalry(save, me.id, opponent.id)?.intensity ?? 0 : 0;
  return {
    save,
    me,
    opponent,
    eventName: event?.name ?? null,
    eventDate: live?.date ?? null,
    boutId: live?.id ?? null,
    daysToFight: live ? daysBetween(save.date, live.date) : null,
    isTitleFight: Boolean(live?.isTitleFight || live?.isInterimTitleFight),
    rivalryIntensity: rivalry,
    lastResultWasWin: lastResult ? lastResult.winnerId === me.id : null,
    daysSinceLastFight: me.lastFightDate ? daysBetween(me.lastFightDate, save.date) : null,
    rng,
  };
}

/**
 * Generates this week's social items for the player, respecting the budget and the
 * anti-repetition history. Returns only newly created items.
 */
export function generateSocialItems(save: SaveGame, me: Fighter, rng: Rng): SocialItem[] {
  if (!save.socialFeed) save.socialFeed = {};
  const ctx = buildContext(save, me, rng);
  const budget = weeklySocialBudget(ctx);
  if (budget === 0) return [];

  // The same archetype from the same source is blocked for three weeks.
  const recentSignatures = new Set(
    Object.values(save.socialFeed)
      .filter((i) => daysBetween(i.date, save.date) < 21)
      .map((i) => `${i.signature}|${i.sourceFighterId ?? 'none'}`)
  );
  const openCount = Object.values(save.socialFeed).filter((i) => i.resolvedOn === null && i.expiresOn >= save.date).length;
  if (openCount >= 4) return [];

  const eligible = TEMPLATES.filter((t) => {
    const sourceId = t.source === 'opponent' ? ctx.opponent?.id ?? 'none' : 'none';
    if (recentSignatures.has(`${t.key}|${sourceId}`)) return false;
    try {
      return t.applies(ctx);
    } catch {
      return false;
    }
  });
  if (eligible.length === 0) return [];

  const created: SocialItem[] = [];
  const want = Math.min(budget - openCount, eligible.length);
  for (let i = 0; i < want; i++) {
    const template = rng.weighted(eligible, () => 1);
    if (created.some((c) => c.signature === template.key)) continue;
    const key = `social-${me.id}-${template.key}-${save.date}`;
    if (save.socialFeed[key]) continue;
    const item: SocialItem = {
      id: key,
      date: save.date,
      expiresOn: addDays(save.date, 10),
      source: template.source,
      sourceName: sourceNameFor(template, ctx),
      sourceFighterId: template.source === 'opponent' ? ctx.opponent?.id ?? null : null,
      targetFighterId: me.id,
      context: template.context,
      headline: fill(template.headline(ctx), ctx),
      body: fill(template.body(ctx), ctx),
      replies: template.tones.map((tone) => composeReply(tone, ctx, template)),
      selectedReplyKey: null,
      immediateReaction: null,
      resolvedOn: null,
      idempotencyKey: key,
      signature: template.key,
      boutId: ctx.boutId,
    };
    save.socialFeed[key] = item;
    created.push(item);
  }
  return created;
}

function sourceNameFor(template: Template, ctx: GenerationContext): string {
  switch (template.source) {
    case 'opponent':
      return ctx.opponent?.name ?? 'Your opponent';
    case 'fans':
      return 'Fan reaction';
    case 'reporter':
      return 'Media';
    case 'teammate':
      return 'Teammate';
    case 'champion': {
      const table = ctx.save.rankings[ctx.me.divisionId];
      return table.championId ? ctx.save.fighters[table.championId]?.name ?? 'The champion' : 'The champion';
    }
    case 'promotion':
      return PROMOTION_MARKETING;
    case 'sponsor':
      return 'Sponsor';
    case 'rival':
      return 'Rival';
    case 'former-opponent':
      return 'Former opponent';
  }
}

/**
 * Applies a reply, exactly once. Returns the immediate reaction text, or null when the
 * item was already answered or does not exist.
 */
export function replyToSocialItem(save: SaveGame, itemId: string, replyKey: string, rng: Rng): string | null {
  const item = save.socialFeed?.[itemId];
  if (!item) return null;
  if (item.resolvedOn) return item.immediateReaction;
  const reply = item.replies.find((r) => r.key === replyKey);
  if (!reply) return null;

  const me = save.fighters[item.targetFighterId];
  if (me) applySocialEffects(save, me, item, reply, rng);

  item.selectedReplyKey = replyKey;
  item.resolvedOn = save.date;
  const reaction = rng.pick(CROWD_REACTION);
  const opponentLine =
    item.sourceFighterId && reply.tone !== 'silent'
      ? ` ${save.fighters[item.sourceFighterId]?.name ?? 'The other camp'} ${
          reply.tone === 'aggressive' || reply.tone === 'controversial' ? 'replies within the hour.' : 'does not respond.'
        }`
      : '';
  item.immediateReaction = `${reaction}${opponentLine}`;
  return item.immediateReaction;
}

/**
 * The follower effect a reply's declared figure is measured against.
 *
 * The effect tables express follower change as a rough count. This converts that into a rate, so
 * the numbers written in the tables are actually read rather than being decoration.
 */
export const SOCIAL_FOLLOWER_REFERENCE = 4000;
/** What ignoring a public question costs in media standing. */
export const IGNORED_ITEM_MEDIA_COST = 1;
/** Maximum proportional gain from one reply. */
export const SOCIAL_FOLLOWER_GAIN = 0.006;
/** Maximum proportional loss from one reply. Smaller, because reach is stickier than it looks. */
export const SOCIAL_FOLLOWER_LOSS = 0.003;

function applySocialEffects(save: SaveGame, me: Fighter, item: SocialItem, reply: SocialReply, rng: Rng): void {
  const e = reply.effects;
  if (me.fame) {
    me.fame.favorability = clampPct(me.fame.favorability + (e.favorability ?? 0));
    me.fame.controversy = clampPct(me.fame.controversy + (e.controversy ?? 0));
    // Recognition follows attention, and attention is what a reply generates whether the reaction
    // is good or bad, so the absolute value is right for a reply that lands. A reply that damages
    // the fight's hype does not make the fighter better known, so a negative effect is worth much
    // less than a positive one rather than the same.
    const hype = e.hype ?? 0;
    me.fame.recognition = clampPct(me.fame.recognition + (hype > 0 ? hype * 0.2 : hype * -0.05));
    me.fame.promotionalTrust = clampPct(me.fame.promotionalTrust + (e.promotionRelationship ?? 0));
    me.fame.mediaFriendliness = clampPct(me.fame.mediaFriendliness + (e.mediaReputation ?? 0));
  }
  if (me.social && e.followers) {
    // The per tone figures were written for every reply and then discarded: only the sign was
    // read, so a reply worth ten times another moved followers by exactly the same amount. The
    // magnitude now scales the rate, bounded so a single reply cannot transform an account.
    const magnitude = Math.min(1, Math.abs(e.followers) / SOCIAL_FOLLOWER_REFERENCE);
    const rate = e.followers > 0 ? SOCIAL_FOLLOWER_GAIN * magnitude : -SOCIAL_FOLLOWER_LOSS * magnitude;
    for (const key of Object.keys(me.social.followers) as (keyof typeof me.social.followers)[]) {
      me.social.followers[key] = Math.max(0, Math.round(me.social.followers[key] * (1 + rate)));
    }
  }
  if (e.confidence) me.momentum = clampPct(me.momentum + e.confidence);
  if (e.promotionRelationship) me.relationships.matchmaker = clampPct(me.relationships.matchmaker + e.promotionRelationship);

  if (item.sourceFighterId) {
    // Social exchanges move the full relationship, not just a rivalry counter. A respectful
    // or funny reply builds friendship; an aggressive one builds hostility.
    const friendly = reply.tone === 'respectful' || reply.tone === 'funny' || reply.tone === 'emotional' || reply.tone === 'honest';
    const hostile = reply.tone === 'aggressive' || reply.tone === 'controversial' || reply.tone === 'dismissive';
    applyRelationship(
      save,
      me.id,
      item.sourceFighterId,
      {
        friendship: friendly ? 7 : hostile ? -6 : 0,
        respect: reply.tone === 'respectful' ? 8 : reply.tone === 'technical' ? 5 : hostile ? -3 : 1,
        rivalry: e.rivalry ?? 0,
        publicHostility: hostile ? 8 : friendly ? -4 : 0,
        privateHostility: reply.tone === 'controversial' ? 6 : 0,
        trust: friendly ? 4 : hostile ? -3 : 0,
      },
      friendly ? 'social-friendly' : hostile ? 'social-hostile' : 'compliment',
      `${me.name} replied ${reply.label.toLowerCase()} to ${save.fighters[item.sourceFighterId]?.name ?? 'them'}.`
    );
    if (e.rivalry && e.rivalry > 0) {
      escalateRivalry(save, me.id, item.sourceFighterId, 'personal', e.rivalry, 'an exchange on social media');
    }
  }

  if (item.boutId && e.hype) {
    const store = hypeStore(save);
    const h = store[item.boutId];
    if (h) {
      h.total = clampPct(h.total + e.hype);
      h.hardcore = clampPct(h.hardcore + e.hype * 0.6);
      h.casual = clampPct(h.casual + e.hype * 1.1);
      h.media = clampPct(h.media + e.hype * 0.9);
      addHypeMoment(save, item.boutId, `${me.name}: ${reply.text.slice(0, 80)}`, e.hype);
    }
  }

  // Risk is realized here rather than being a label with no consequence.
  if (e.fineRisk && rng.chance(e.fineRisk / 100)) {
    const fine = Math.round(2000 + rng.range(0, 8000));
    record(save, me.id, 'out', 'fine', fine, 'Fine for a social media post');
  }
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Items awaiting a reply that have not expired. */
export function openSocialItems(save: SaveGame): SocialItem[] {
  if (!save.socialFeed) return [];
  return Object.values(save.socialFeed)
    .filter((i) => i.resolvedOn === null && i.expiresOn >= save.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Expires unanswered items and drops old resolved ones. */
export function pruneSocial(save: SaveGame, keepDays = 200): number {
  if (!save.socialFeed) return 0;
  let removed = 0;
  for (const id of Object.keys(save.socialFeed)) {
    const item = save.socialFeed[id];
    if (item.resolvedOn === null && item.expiresOn < save.date) {
      item.resolvedOn = save.date;
      item.immediateReaction = 'The moment passed without a reply.';
      // Ignoring an item was strictly cheaper than answering it with the silent reply, so the
      // dominant strategy was to never open the inbox. Letting a question go unanswered in public
      // costs a little media standing, which is what the silent reply also costs.
      const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
      if (me?.fame && item.sourceFighterId !== me.id) {
        me.fame.mediaFriendliness = clampPct(me.fame.mediaFriendliness - IGNORED_ITEM_MEDIA_COST);
      }
    }
    if (item.resolvedOn && daysBetween(item.resolvedOn, save.date) > keepDays) {
      delete save.socialFeed[id];
      removed++;
    }
  }
  return removed;
}

/** Deterministic per fighter seed so social generation never touches the shared stream. */
export function socialRng(save: SaveGame, fighterId: FighterId): Rng {
  return new Rng(hashString(`social-${fighterId}-${save.date}-${save.seed}`));
}
