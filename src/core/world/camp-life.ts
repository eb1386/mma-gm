import { clamp, hashString, Rng } from '../rng';
import { addDays, daysBetween, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { addInboxMessage } from './inbox';
import { hasLiveBooking } from './availability';
import { applyRelationship, ensureRelationship, relationshipState } from './relationships';
import { sponsorsFor } from './finance';
import { managerFor } from './finance';
import { dopingState } from './antidoping';
import { COOLDOWNS, mayNotify } from './decisions';
import { PROMOTION_MARKETING } from '../config/branding';
import { record } from './finance';

/**
 * Career life between the fights.
 *
 * Camp used to be a blank stretch where only dates and ratings moved. Every system the
 * game has now reaches the player here, through the inbox, at a controlled rate: teammates,
 * coaches, the gym, sponsors, the manager, the media, opponents, and the compliance
 * questions that would otherwise sit on a page nobody visits.
 *
 * Only genuinely mandatory items block advancement. Everything else is an opportunity or a
 * passive update, which is what keeps a camp moving without becoming a click marathon.
 */

export type CampEventKind =
  | 'teammate-encouragement'
  | 'teammate-conflict'
  | 'teammate-injury'
  | 'coach-concern'
  | 'coach-praise'
  | 'specialist-offer'
  | 'gym-visitor'
  | 'gym-politics'
  | 'gym-financial'
  | 'poaching-attempt'
  | 'mentorship-request'
  | 'sponsor-obligation'
  | 'sponsor-appearance'
  | 'manager-advice'
  | 'manager-conflict'
  | 'promotion-marketing'
  | 'documentary-request'
  | 'interview-request'
  | 'charity-request'
  | 'local-appearance'
  | 'fan-challenge'
  | 'nutrition-update'
  | 'medical-update'
  | 'ranking-news'
  | 'supplement-question'
  | 'compliance-reminder'
  | 'weight-check';

export interface CampEventDefinition {
  kind: CampEventKind;
  /** Mandatory items stop the calendar. Opportunities do not. */
  mandatory: boolean;
  weight: number;
  applies: (c: CampLifeContext) => boolean;
  build: (c: CampLifeContext) => {
    sender: Parameters<typeof addInboxMessage>[1]['sender'];
    senderName: string;
    subject: string;
    body: string;
    category: Parameters<typeof addInboxMessage>[1]['category'];
    choices: { key: string; label: string; hint?: string }[];
    linkedFighterId?: string | null;
    /** Overrides the default anti repetition signature. */
    signature?: string;
  };
}

export interface CampLifeContext {
  save: SaveGame;
  me: Fighter;
  opponent: Fighter | null;
  daysToFight: number | null;
  inCamp: boolean;
  /** Stable identity for the current camp, so a once per camp event stays once per camp. */
  campId: string | null;
  campWeek: number;
  teammates: Fighter[];
  gymName: string | null;
  rng: Rng;
}

function pickTeammate(c: CampLifeContext): Fighter | null {
  if (c.teammates.length === 0) return null;
  return c.rng.pick(c.teammates);
}

const EVENTS: CampEventDefinition[] = [
  {
    kind: 'teammate-encouragement',
    mandatory: false,
    weight: 3,
    applies: (c) => c.teammates.length > 0,
    build: (c) => {
      const mate = pickTeammate(c)!;
      return {
        sender: 'fighter',
        senderName: mate.name,
        subject: `${mate.name} has been watching your rounds`,
        category: 'gym',
        body: `${mate.name} pulled you aside after training. ${c.rng.pick([
          'He says the timing looks better than it has in a year.',
          'He thinks you are being too polite in sparring and should let go more.',
          'He wants to know if you need extra rounds this week.',
        ])}`,
        choices: [
          { key: 'camp-thank', label: 'Thank him', hint: 'Strengthens the friendship.' },
          { key: 'camp-ask-rounds', label: 'Ask him for extra rounds', hint: 'Better preparation, a little more wear.' },
          { key: 'camp-brush-off', label: 'Brush it off', hint: 'Costs some goodwill in the room.' },
        ],
        linkedFighterId: mate.id,
      };
    },
  },
  {
    kind: 'teammate-conflict',
    mandatory: false,
    weight: 1.4,
    applies: (c) => c.teammates.length > 1 && c.inCamp,
    build: (c) => {
      const mate = pickTeammate(c)!;
      return {
        sender: 'fighter',
        senderName: mate.name,
        subject: `Friction with ${mate.name}`,
        category: 'gym',
        body: `Sparring got heated and ${mate.name} did not take it well. ${c.rng.pick([
          'He thinks you went too hard for a Tuesday.',
          'He says you have been taking the best rounds and leaving him the scraps.',
          'He accused you of showing him up in front of the coaches.',
        ])} The room noticed.`,
        choices: [
          { key: 'camp-apologize', label: 'Apologize', hint: 'Repairs the relationship, costs a little standing.' },
          { key: 'camp-stand-ground', label: 'Stand your ground', hint: 'Keeps your standing, damages the relationship.' },
          { key: 'camp-let-coaches', label: 'Let the coaches handle it', hint: 'Neutral, but it lingers.' },
        ],
        linkedFighterId: mate.id,
      };
    },
  },
  {
    kind: 'coach-concern',
    mandatory: false,
    weight: 2,
    applies: (c) => c.inCamp && Boolean(c.gymName),
    build: (c) => ({
      sender: 'head-coach',
      senderName: 'Head coach',
      subject: c.rng.pick(['A word about the game plan', 'Concerns about the workload', 'The read on this opponent']),
      category: 'gym',
      body: c.rng.pick([
        `The staff think the plan is too rigid for ${c.opponent?.name ?? 'this opponent'}. They want a second option ready.`,
        'The coaches think you are overtraining. They want to pull the intensity back for a week.',
        `They have found something in ${c.opponent?.name ?? 'the opponent'}: he resets the same way every time he is pressured.`,
      ]),
      choices: [
        { key: 'camp-follow-coach', label: 'Follow their advice', hint: 'Better preparation.' },
        { key: 'camp-own-way', label: 'Do it your way', hint: 'Costs a little coach goodwill.' },
      ],
    }),
  },
  {
    // Sponsor obligations are settled automatically by the sponsor system. What reaches the
    // player is rare and meaningful: a real campaign, a renewal, or a warning. Asking them
    // to click "Post it" every few weeks was the single worst thing in the inbox.
    kind: 'sponsor-appearance',
    mandatory: false,
    weight: 0.8,
    applies: (c) =>
      sponsorsFor(c.save, c.me.id).some((s) => s.status === 'active' && s.appearancesPerYear > 0) &&
      mayNotify(c.save, { signature: `sponsor-request|${c.me.id}`, cooldownDays: COOLDOWNS.sponsorRequest }),
    build: (c) => {
      const sponsor = c.rng.pick(sponsorsFor(c.save, c.me.id).filter((s) => s.status === 'active'));
      return {
        sender: 'manager',
        senderName: sponsor.name,
        subject: `${sponsor.name} wants you for a campaign`,
        category: 'career',
        body: `${sponsor.name} are shooting a national campaign and want you in it. It is a day out of camp and it pays well.${
          sponsor.moralityClause ? ' Their deal carries a morality clause, so conduct matters.' : ''
        }`,
        choices: [
          { key: 'camp-sponsor-campaign', label: 'Do the campaign', hint: 'Pays well, costs a day of camp.' },
          { key: 'camp-sponsor-decline-campaign', label: 'Stay in camp', hint: 'Protects preparation, slight goodwill cost.' },
        ],
      };
    },
  },
  {
    kind: 'manager-advice',
    mandatory: false,
    weight: 2,
    applies: (c) => Boolean(managerFor(c.save, c.me.id)),
    build: (c) => {
      const manager = managerFor(c.save, c.me.id)!;
      return {
        sender: 'manager',
        senderName: manager.name,
        subject: c.rng.pick(['A thought about what comes next', 'About the money', 'About your positioning']),
        category: 'career',
        body: c.rng.pick([
          `${manager.name} thinks you are underpaid for where you are ranked and wants to open the contract early.`,
          `${manager.name} has a sponsor interested but wants you more visible first.`,
          `${manager.name} thinks the division is stacked and you should be looking at a move.`,
        ]),
        choices: [
          { key: 'camp-manager-agree', label: 'Agree with the plan', hint: 'Builds trust.' },
          { key: 'camp-manager-decline', label: 'Tell them to leave it', hint: 'Costs a little trust.' },
        ],
      };
    },
  },
  {
    // Once per camp at most, keyed on the camp itself. It used to reappear every few weeks.
    kind: 'supplement-question',
    mandatory: true,
    weight: 1.2,
    applies: (c) =>
      c.inCamp &&
      Boolean(c.campId) &&
      dopingState(c.save, c.me.id).posture !== 'strict' &&
      mayNotify(c.save, { signature: `supplement|${c.me.id}|${c.campId}`, cooldownDays: COOLDOWNS.supplement }),
    build: (c) => ({
      sender: 'specialist-coach',
      senderName: 'Strength and conditioning',
      subject: 'A new supplement in the gym',
      category: 'medical',
      body: `Somebody has brought a recovery product into the gym that nobody has had checked. Your current compliance posture is ${
        dopingState(c.save, c.me.id).posture
      }. It is your call whether anything unverified goes anywhere near you.`,
      choices: [
        { key: 'camp-supplement-check', label: 'Have it checked first', hint: 'The safe answer. Costs a little money and time.' },
        { key: 'camp-supplement-refuse', label: 'Refuse it outright', hint: 'No risk at all.' },
        { key: 'camp-supplement-take', label: 'Take it without checking', hint: 'Real risk of an adverse finding later.' },
      ],
      signature: `supplement|${c.me.id}|${c.campId}`,
    }),
  },
  {
    kind: 'compliance-reminder',
    mandatory: false,
    weight: 1,
    applies: (c) => (c.me.ranking ?? 99) <= 10 || c.me.isChampion,
    build: () => ({
      sender: 'commission',
      senderName: 'Anti-doping programme',
      subject: 'Whereabouts filing due',
      category: 'medical',
      body: 'Your testing pool filing is due. Keeping it current is routine, and missing it repeatedly is treated the same way as a failed test.',
      choices: [
        { key: 'camp-file-whereabouts', label: 'File it now', hint: 'Removes the risk.' },
        { key: 'camp-ignore-whereabouts', label: 'Deal with it later', hint: 'A small chance of a missed test.' },
      ],
    }),
  },
  {
    kind: 'gym-politics',
    mandatory: false,
    weight: 1.2,
    applies: (c) => Boolean(c.gymName) && c.teammates.length > 0,
    build: (c) => ({
      sender: 'gym-owner',
      senderName: c.gymName ?? 'The gym',
      subject: c.rng.pick(['A change in the room', 'A difficult conversation', 'Something you should know']),
      category: 'gym',
      body: c.rng.pick([
        'A rival gym has been calling your coaches. One of them is listening.',
        'The gym is losing money and the owner is talking about raising fighter percentages.',
        'A well known fighter has asked to join the team, and not everyone wants them here.',
        'One of the younger fighters has asked you to mentor them.',
      ]),
      choices: [
        { key: 'camp-gym-support', label: 'Back the gym', hint: 'Strengthens your standing there.' },
        { key: 'camp-gym-stay-out', label: 'Stay out of it', hint: 'Neutral.' },
        { key: 'camp-gym-look-around', label: 'Start looking elsewhere', hint: 'Opens the door to a move.' },
      ],
    }),
  },
  {
    kind: 'mentorship-request',
    mandatory: false,
    weight: 1,
    applies: (c) => c.teammates.some((f) => (f.ranking ?? 99) > 12) && (c.me.ranking ?? 99) <= 12,
    build: (c) => {
      const junior = c.rng.pick(c.teammates.filter((f) => (f.ranking ?? 99) > 12));
      return {
        sender: 'fighter',
        senderName: junior.name,
        subject: `${junior.name} wants to learn from you`,
        category: 'gym',
        body: `${junior.name} has asked whether you would work with him properly, not just share rounds. It would cost you time in your own camp.`,
        choices: [
          { key: 'camp-mentor-accept', label: 'Take him under your wing', hint: 'A lasting bond, at some cost to your own preparation.' },
          { key: 'camp-mentor-decline', label: 'Tell him to find someone else', hint: 'Keeps your camp focused.' },
        ],
        linkedFighterId: junior.id,
      };
    },
  },
  {
    kind: 'promotion-marketing',
    mandatory: false,
    weight: 1.6,
    applies: (c) => c.daysToFight !== null && c.daysToFight < 45,
    build: (c) => ({
      sender: 'matchmaker',
      senderName: PROMOTION_MARKETING,
      subject: 'A promotional request',
      category: 'career',
      body: c.rng.pick([
        'Marketing want a day of filming for the pre fight package.',
        'They want you on a podcast that runs the week before the card.',
        'They have asked for an open workout appearance in the host city.',
      ]),
      choices: [
        { key: 'camp-promo-accept', label: 'Do it', hint: 'Builds hype and promotional goodwill.' },
        { key: 'camp-promo-decline', label: 'Decline', hint: 'Protects camp, costs goodwill.' },
      ],
    }),
  },
  {
    kind: 'documentary-request',
    mandatory: false,
    weight: 0.8,
    applies: (c) => c.me.popularity > 45,
    build: () => ({
      sender: 'media',
      senderName: 'Documentary crew',
      subject: 'A crew wants access to your camp',
      category: 'career',
      body: 'A production company wants to film inside camp for a week. It pays, it raises your profile, and it puts cameras in the room during your hardest sessions.',
      choices: [
        { key: 'camp-doc-accept', label: 'Let them in', hint: 'Money and profile, a small distraction cost.' },
        { key: 'camp-doc-decline', label: 'Keep camp closed', hint: 'No distraction.' },
      ],
    }),
  },
  {
    kind: 'nutrition-update',
    mandatory: false,
    weight: 1.4,
    applies: (c) => c.inCamp && c.daysToFight !== null && c.daysToFight < 40,
    build: (c) => ({
      sender: 'specialist-coach',
      senderName: 'Nutritionist',
      subject: 'Where the weight is',
      category: 'medical',
      body: `You are ${Math.round(c.me.walkingWeightLb)} lb with ${c.daysToFight} days to go.${
        c.me.weightMisses > 0 ? ' Given your history, the team wants to be conservative.' : ''
      } The plan is on track, but there is a decision about how aggressive the last stretch should be.`,
      choices: [
        { key: 'camp-cut-conservative', label: 'Be conservative', hint: 'Safer, slightly less sharp.' },
        { key: 'camp-cut-standard', label: 'Stick to the plan', hint: 'Balanced.' },
        { key: 'camp-cut-aggressive', label: 'Push it harder', hint: 'Sharper on the night, higher risk on the scale.' },
      ],
    }),
  },
  {
    kind: 'fan-challenge',
    mandatory: false,
    weight: 0.7,
    applies: (c) => c.me.popularity > 20,
    build: (c) => ({
      sender: 'media',
      senderName: 'Fan mail',
      subject: c.rng.pick(['A fan has a request', 'Someone wants to meet you', 'A message from a supporter']),
      category: 'career',
      body: c.rng.pick([
        'A young fan recovering from surgery has asked whether you would send them a message.',
        'A local club has asked you to drop in for an hour with their juniors.',
        'A fan has challenged you to a friendly bet on the fight.',
      ]),
      choices: [
        { key: 'camp-fan-yes', label: 'Say yes', hint: 'Fans notice this kind of thing.' },
        { key: 'camp-fan-no', label: 'Not this camp', hint: 'No effect either way.' },
      ],
    }),
  },
  {
    kind: 'ranking-news',
    mandatory: false,
    weight: 1,
    applies: (c) => c.me.ranking !== null,
    build: (c) => ({
      sender: 'media',
      senderName: 'Rankings update',
      subject: 'Movement in the division',
      category: 'ranking',
      body: `The rankings have shifted around you. You are currently number ${c.me.ranking}. A win over ${
        c.opponent?.name ?? 'your next opponent'
      } should move that.`,
      choices: [],
    }),
  },
];

/** How many meaningful items this week may produce. */
export function campLifeBudget(c: CampLifeContext): number {
  if (c.daysToFight !== null && c.daysToFight <= 7) return 3;
  if (c.inCamp) {
    const major = (c.me.ranking ?? 99) <= 5 || c.me.isChampion;
    return major ? 3 : 2;
  }
  return c.rng.chance(0.5) ? 1 : 0;
}

export function buildCampContext(save: SaveGame, me: Fighter, rng: Rng): CampLifeContext {
  const bout = hasLiveBooking(save, me);
  const opponent = bout ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] ?? null : null;
  const camp = Object.values(save.camps).find((x) => x.fighterId === me.id && (x.status === 'planned' || x.status === 'running'));
  const gym = me.gymId ? save.gyms[me.gymId] : null;
  const teammates = gym
    ? gym.fighterIds
        .filter((id) => id !== me.id)
        .map((id) => save.fighters[id])
        .filter((f): f is Fighter => Boolean(f) && !f.retired)
    : [];
  return {
    save,
    me,
    opponent,
    daysToFight: bout ? daysBetween(save.date, bout.date) : null,
    inCamp: Boolean(camp),
    campId: camp?.id ?? null,
    campWeek: camp?.weeksCompleted ?? 0,
    teammates,
    gymName: gym?.name ?? null,
    rng,
  };
}

/**
 * Generates this week's career life items.
 *
 * Returns what was created. Only items marked mandatory require an answer, so a camp keeps
 * moving unless something genuinely needs the player.
 */
export function generateCampLife(save: SaveGame, me: Fighter, rng: Rng): string[] {
  const c = buildCampContext(save, me, rng);
  const budget = campLifeBudget(c);
  if (budget === 0) return [];

  // Anti repetition: nothing from the last five weeks comes round again.
  const recent = new Set(
    save.inbox
      .filter((m) => m.decisionKey?.startsWith('camp-life-') && daysBetween(m.date, save.date) < 35)
      .map((m) => m.decisionKey!.split('|')[1])
  );
  const openMandatory = save.inbox.filter(
    (m) => m.requiresAction && m.status !== 'resolved' && m.status !== 'expired' && m.decisionKey?.startsWith('camp-life-')
  ).length;
  if (openMandatory >= 2) return [];

  const eligible = EVENTS.filter((e) => {
    if (recent.has(e.kind)) return false;
    try {
      return e.applies(c);
    } catch {
      return false;
    }
  });
  if (eligible.length === 0) return [];

  const created: string[] = [];
  const used = new Set<CampEventKind>();
  for (let i = 0; i < budget && eligible.length > 0; i++) {
    const pool = eligible.filter((e) => !used.has(e.kind));
    if (pool.length === 0) break;
    const chosen = rng.weighted(pool, (e) => e.weight);
    used.add(chosen.kind);
    const key = `camp-life-${save.date}|${chosen.kind}`;
    if (save.inbox.some((m) => m.decisionKey === key)) continue;
    const built = chosen.build(c);
    const message = addInboxMessage(save, {
      sender: built.sender,
      senderName: built.senderName,
      subject: built.subject,
      body: built.body,
      category: built.category,
      requiresAction: built.choices.length > 0,
      deadline: addDays(save.date, chosen.mandatory ? 14 : 21),
      choices: built.choices,
      linkedFighterId: built.linkedFighterId ?? null,
    });
    message.decisionKey = built.signature ?? key;
    message.notificationSignature = built.signature ?? key;
    message.decisionCreatedOn = save.date;
    // Explicit: only a genuinely mandatory item stops the calendar.
    message.mandatory = chosen.mandatory;
    created.push(chosen.kind);
  }
  return created;
}

/** Applies the consequence of a camp life choice, exactly once. */
export function applyCampChoice(save: SaveGame, messageId: string, choiceKey: string, rng: Rng): string {
  const message = save.inbox.find((m) => m.id === messageId);
  if (!message) return 'That message no longer exists.';
  if (message.selectedChoiceKey) return message.resolution ?? 'Already handled.';
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (!me) return 'No fighter is being managed.';
  const other = message.linkedFighterId ? save.fighters[message.linkedFighterId] : null;
  message.selectedChoiceKey = choiceKey;
  message.decisionResolvedOn = save.date;

  const gym = me.gymId ? save.gyms[me.gymId] : null;
  let text = 'Noted.';

  switch (choiceKey) {
    case 'camp-thank':
      if (other) applyRelationship(save, me.id, other.id, { friendship: 6, trust: 4, respect: 3 }, 'support', 'A word of thanks in the gym.');
      text = other ? `${other.name} appreciated it.` : 'Noted.';
      break;
    case 'camp-ask-rounds':
      if (other) applyRelationship(save, me.id, other.id, { friendship: 8, familiarity: 8, teammateBond: 5 }, 'training', 'Extra rounds together.');
      me.campSharpness = clamp(me.campSharpness + 3, 0, 100);
      me.wear.recovery = clamp(me.wear.recovery + 2, 0, 100);
      text = other ? `${other.name} put in the extra rounds with you.` : 'You put in extra rounds.';
      break;
    case 'camp-brush-off':
      if (other) applyRelationship(save, me.id, other.id, { friendship: -8, respect: -3, resentment: 5 }, 'social-hostile', 'Brushed off in the gym.');
      text = 'The room noticed.';
      break;
    case 'camp-apologize':
      if (other) applyRelationship(save, me.id, other.id, { friendship: 10, resentment: -12, trust: 6 }, 'support', 'An apology after a heated session.');
      text = other ? `${other.name} let it go.` : 'It blew over.';
      break;
    case 'camp-stand-ground':
      if (other) applyRelationship(save, me.id, other.id, { resentment: 14, friendship: -12, privateHostility: 10, respect: 4 }, 'social-hostile', 'Neither of them backed down.');
      text = 'It is not settled.';
      break;
    case 'camp-let-coaches':
      if (other) applyRelationship(save, me.id, other.id, { resentment: 4, familiarity: 2 }, 'social-hostile', 'The coaches stepped in.');
      text = 'The coaches dealt with it.';
      break;
    case 'camp-follow-coach':
      me.campSharpness = clamp(me.campSharpness + 4, 0, 100);
      if (gym) gym.culture = clamp(gym.culture + 3, 0, 100);
      text = 'The plan has been adjusted.';
      break;
    case 'camp-own-way':
      me.relationships.coach = clamp(me.relationships.coach - 6, 0, 100);
      text = 'You are doing it your way.';
      break;
    case 'camp-sponsor-post':
    case 'camp-sponsor-own-words': {
      const sponsor = sponsorsFor(save, me.id).find((s) => s.status === 'active');
      if (sponsor) sponsor.satisfaction = clamp(sponsor.satisfaction + (choiceKey === 'camp-sponsor-post' ? 12 : 6), 0, 100);
      if (me.fame) me.fame.sponsorAppeal = clamp(me.fame.sponsorAppeal + 2, 0, 100);
      text = 'The post is up.';
      break;
    }
    case 'camp-sponsor-refuse': {
      const sponsor = sponsorsFor(save, me.id).find((s) => s.status === 'active');
      if (sponsor) {
        sponsor.satisfaction = clamp(sponsor.satisfaction - 25, 0, 100);
        if (sponsor.satisfaction < 20 && rng.chance(0.5)) {
          sponsor.status = 'terminated';
          text = `${sponsor.name} has ended the deal.`;
          break;
        }
      }
      text = 'The sponsor is not pleased.';
      break;
    }
    case 'camp-manager-agree':
      me.relationships.manager = clamp(me.relationships.manager + 8, 0, 100);
      text = 'Your manager is getting on with it.';
      break;
    case 'camp-manager-decline':
      me.relationships.manager = clamp(me.relationships.manager - 6, 0, 100);
      text = 'You told them to leave it.';
      break;
    case 'camp-supplement-check':
      record(save, me.id, 'out', 'nutrition', 400, 'Camp supplies');
      text = 'It came back clean. That is money well spent.';
      break;
    case 'camp-supplement-refuse':
      text = 'Nothing unverified goes near you.';
      break;
    case 'camp-supplement-take': {
      const state = dopingState(save, me.id);
      state.posture = state.posture === 'questionable' ? 'questionable' : 'loose';
      text = 'You took it. Nobody knows what was in it.';
      break;
    }
    case 'camp-file-whereabouts':
      text = 'Filed. Nothing to worry about.';
      break;
    case 'camp-ignore-whereabouts': {
      const state = dopingState(save, me.id);
      if (rng.chance(0.25)) {
        state.findings.push({ on: save.date, kind: 'whereabouts-failure', resolved: false, outcome: null });
        text = 'A test was attempted and you were not where you said you would be. That is on record.';
      } else {
        text = 'Nothing came of it this time.';
      }
      break;
    }
    case 'camp-gym-support':
      if (gym) gym.culture = clamp(gym.culture + 6, 0, 100);
      me.relationships.team = clamp(me.relationships.team + 8, 0, 100);
      text = 'The gym noticed you backing them.';
      break;
    case 'camp-gym-stay-out':
      // Neutrality is noticed. Smaller than taking a side, but not free.
      me.relationships.team = clamp(me.relationships.team - 3, 0, 100);
      text = 'You stayed out of it. Nobody thanks you for that, but nobody blames you either.';
      break;
    case 'camp-gym-look-around':
      me.relationships.team = clamp(me.relationships.team - 12, 0, 100);
      text = 'Word gets around that you have been asking questions.';
      break;
    case 'camp-mentor-accept':
      if (other) applyRelationship(save, me.id, other.id, { mentorBond: 30, friendship: 12, trust: 10, teammateBond: 10 }, 'mentorship', 'You took him on.');
      me.campSharpness = clamp(me.campSharpness - 2, 0, 100);
      text = other ? `You are working with ${other.name} now.` : 'You took on a student.';
      break;
    case 'camp-mentor-decline':
      if (other) applyRelationship(save, me.id, other.id, { friendship: -4 }, 'social-hostile', 'Turned down a request to mentor.');
      text = 'You kept your camp to yourself.';
      break;
    case 'camp-promo-accept':
      me.relationships.matchmaker = clamp(me.relationships.matchmaker + 6, 0, 100);
      if (me.fame) me.fame.recognition = clamp(me.fame.recognition + 3, 0, 100);
      me.campSharpness = clamp(me.campSharpness - 1, 0, 100);
      text = 'Marketing got what they wanted.';
      break;
    case 'camp-promo-decline':
      me.relationships.matchmaker = clamp(me.relationships.matchmaker - 7, 0, 100);
      text = 'You kept the day for training.';
      break;
    case 'camp-doc-accept':
      record(save, me.id, 'in', 'sponsorship', 15000, 'Sponsor appearance');
      if (me.fame) me.fame.recognition = clamp(me.fame.recognition + 7, 0, 100);
      me.campSharpness = clamp(me.campSharpness - 3, 0, 100);
      text = 'The crew are in the gym all week.';
      break;
    case 'camp-doc-decline':
      text = 'Camp stays closed.';
      break;
    case 'camp-cut-conservative':
      me.walkingWeightLb = Math.max(me.walkingWeightLb - 0.5, 0);
      text = 'The last stretch will be gentle.';
      break;
    case 'camp-cut-standard':
      text = 'The plan is unchanged.';
      break;
    case 'camp-cut-aggressive':
      me.wear.weightCut = clamp(me.wear.weightCut + 4, 0, 100);
      me.campSharpness = clamp(me.campSharpness + 3, 0, 100);
      text = 'You are pushing the cut harder than the team would like.';
      break;
    case 'camp-sponsor-campaign': {
      const sponsor = sponsorsFor(save, me.id).find((s) => s.status === 'active');
      if (sponsor) sponsor.satisfaction = clamp(sponsor.satisfaction + 15, 0, 100);
      record(save, me.id, 'in', 'sponsorship', 12000, 'Sponsor appearance');
      me.campSharpness = clamp(me.campSharpness - 2, 0, 100);
      text = 'The shoot went well and the cheque cleared.';
      break;
    }
    case 'camp-sponsor-decline-campaign': {
      const sponsor = sponsorsFor(save, me.id).find((s) => s.status === 'active');
      if (sponsor) sponsor.satisfaction = clamp(sponsor.satisfaction - 8, 0, 100);
      text = 'You stayed in camp.';
      break;
    }
    case 'camp-fan-yes':
      if (me.fame) me.fame.favorability = clamp(me.fame.favorability + 4, 0, 100);
      text = 'It meant more to them than it cost you.';
      break;
    case 'camp-fan-no':
      text = 'Not this camp.';
      break;
    default:
      text = 'Noted.';
  }

  message.status = 'resolved';
  message.resolution = text;
  // Set here rather than at the top, so it means what it says: the consequences ran. If anything
  // above throws, the message is left answerable instead of being marked handled with the effects
  // only half applied.
  message.effectsAppliedOn = save.date;
  return text;
}

/** Deterministic per fighter seed. */
export function campLifeRng(save: SaveGame, fighterId: string): Rng {
  return new Rng(hashString(`camplife-${fighterId}-${save.date}-${save.seed}`));
}

/** Seeds relationships with gym teammates so the room is not full of strangers. */
export function seedGymRelationships(save: SaveGame, me: Fighter): number {
  const gym = me.gymId ? save.gyms[me.gymId] : null;
  if (!gym) return 0;
  let created = 0;
  for (const id of gym.fighterIds) {
    if (id === me.id) continue;
    const existing = save.relationships?.[[me.id, id].sort().join('|')];
    if (existing) continue;
    ensureRelationship(save, me.id, id);
    created++;
  }
  return created;
}

/** A short description of where the player stands with someone. */
export function describeRelationship(save: SaveGame, aId: string, bId: string): string {
  const r = save.relationships?.[[aId, bId].sort().join('|')] ?? null;
  return relationshipState(r);
}

export type { IsoDate };
