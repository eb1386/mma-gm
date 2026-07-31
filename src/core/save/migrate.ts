import { SAVE_SCHEMA_VERSION, DEFAULT_SETTINGS, type SaveGame } from '../types/save';
import { DIVISIONS } from '../config/divisions';
import { allDivisionRankings } from '../world/rankings';
import { Rng } from '../rng';
import { generateActivityProfile, generateFame, generatePersonality, generateSocial } from '../world/identity';
import { repairInbox } from '../world/decisions';
import { evaluateInterest } from '../world/matchup-interest';
import { assignOfficials, ensureOfficials } from '../world/officials';
import { addDays, daysBetween } from '../types/common';
import { fightNightName, numberedEventName, PROMOTION_CONTRACTS, PROMOTION_MARKETING, PROMOTION_MATCHMAKING, PROMOTION_NAME } from '../config/branding';

/**
 * Save migrations.
 *
 * A career is meant to last for years of real time, so an old save must keep loading
 * after the game changes. Each step upgrades one schema version and is written to be
 * safe to run on a save that is already partly upgraded.
 */

type Migration = { to: number; describe: string; apply: (save: SaveGame) => void };

const MIGRATIONS: Migration[] = [
  {
    to: 2,
    describe: 'Adds the pound for pound table and the counters map.',
    apply: (save) => {
      if (!save.pfp) save.pfp = { entries: [], updatedOn: save.date, fromOfficialSnapshot: false };
      if (!save.counters) {
        save.counters = { fighter: 0, gym: 0, staff: 0, event: 0, bout: 0, camp: 0, news: 0, message: 0, offer: 0, ppvNumber: 320 };
      }
    },
  },
  {
    to: 3,
    describe: 'Adds camps, contract offers and the pending decision marker.',
    apply: (save) => {
      if (!save.camps) save.camps = {};
      if (!save.contractOffers) save.contractOffers = {};
      if (save.pendingDecision === undefined) save.pendingDecision = null;
      if (!save.history.retirements) save.history.retirements = [];
      if (!save.history.rankingHistory) save.history.rankingHistory = [];
    },
  },
];

const MIGRATION_4: Migration = {
  to: 4,
  describe: 'Adds card shape planning and the announced, weigh in, contested and canceled card views.',
  apply: (save) => {
    for (const ev of Object.values(save.events ?? {})) {
      const e = ev as unknown as Record<string, unknown>;
      if (e.plannedBouts === undefined) {
        const isPpv = ev.tier === 'numbered-ppv';
        e.plannedBouts = isPpv ? 12 : 12;
        e.plannedMain = isPpv ? 5 : 6;
        e.plannedPrelim = isPpv ? 4 : 6;
        e.plannedEarly = isPpv ? 3 : 0;
      }
      if (!e.announcedBoutIds) e.announcedBoutIds = [...ev.boutIds];
      if (!e.weighInBoutIds) e.weighInBoutIds = [];
      if (!e.contestedBoutIds) e.contestedBoutIds = [];
      if (!e.canceledBoutIds) e.canceledBoutIds = [];
    }
  },
};
MIGRATIONS.push(MIGRATION_4);

const MIGRATION_5: Migration = {
  to: 5,
  describe: 'Adds personality, activity profiles, fame, social reach and public labels.',
  apply: (save) => {
    for (const f of Object.values(save.fighters ?? {})) {
      const rng = new Rng(`identity-${f.id}-${save.seed ?? 0}`);
      if (!f.personality) f.personality = generatePersonality(rng);
      if (!f.activityProfile) f.activityProfile = generateActivityProfile(rng, f.personality, f);
      if (!f.fame) f.fame = generateFame(rng, f);
      if (!f.social) f.social = generateSocial(rng, f);
      if (!f.publicLabels) f.publicLabels = [];
    }
  },
};
MIGRATIONS.push(MIGRATION_5);

const MIGRATION_6: Migration = {
  to: 6,
  describe: 'Records which fighters forfeited a championship by missing weight, so a title bout keeps its stakes for the fighter who made weight.',
  apply: (save) => {
    for (const b of Object.values(save.bouts ?? {})) {
      if (!b.titleIneligibleFighterIds) b.titleIneligibleFighterIds = [];
    }
    for (const r of Object.values(save.history?.results ?? {})) {
      if (!r.titleIneligibleFighterIds) r.titleIneligibleFighterIds = [];
    }
  },
};
MIGRATIONS.push(MIGRATION_6);

const MIGRATION_7: Migration = {
  to: 7,
  describe: 'Adds fight week stages, the career state machine, the social feed, offer identity keys and the extra suspension and return date fields.',
  apply: (save) => {
    if (!save.fightWeek) save.fightWeek = {};
    if (!save.socialFeed) save.socialFeed = {};
    if (!save.pressers) save.pressers = {};
    if (!save.weighIns) save.weighIns = {};
    if (!save.careerState) {
      save.careerState = { state: 'available', reason: 'Restored from an older save.', since: save.date, actionKey: null };
    }
    for (const f of Object.values(save.fighters ?? {})) {
      if (f.commissionSuspension === undefined) f.commissionSuspension = null;
      if (f.antiDopingSuspension === undefined) f.antiDopingSuspension = null;
      if (f.expectedReturnDate === undefined) f.expectedReturnDate = null;
      if (f.offerCooldownUntil === undefined) f.offerCooldownUntil = null;
    }
    // Older offers have no identity key. One is derived so the duplicate check works on
    // them too, rather than treating every legacy offer as unique.
    for (const o of Object.values(save.fightOffers ?? {})) {
      if (o.idempotencyKey === undefined) {
        o.idempotencyKey = [
          o.fighterId,
          o.opponentId,
          o.eventId,
          o.isMainEvent ? 'main' : 'card',
          o.isTitleFight ? 'title' : o.isInterimTitleFight ? 'interim-title' : o.isReplacementSlot ? 'replacement' : 'ordinary',
          o.isReplacementSlot ? 'r' : 'n',
        ].join('|');
      }
      if (o.medicallyContingent === undefined) o.medicallyContingent = false;
    }
  },
};
MIGRATIONS.push(MIGRATION_7);

const MIGRATION_8: Migration = {
  to: 8,
  describe: 'Adds the money ledger, sponsors, managers and abstract anti-doping compliance.',
  apply: (save) => {
    if (!save.ledger) save.ledger = [];
    if (!save.sponsors) save.sponsors = {};
    if (!save.managers) save.managers = {};
    if (!save.doping) save.doping = {};
    if (!save.finance) {
      // The opening balance becomes the ledger's starting cash. Career earnings already
      // recorded on the fighter are carried across so the summary is not blank.
      const me = save.player?.fighterId ? save.fighters?.[save.player.fighterId] : null;
      save.finance = {
        cash: save.player?.balance ?? 0,
        careerEarnings: me?.careerEarnings ?? 0,
        careerExpenses: 0,
        debt: 0,
        monthlyExpenses: 0,
        lastMonthlyOn: null,
      };
    }
  },
};
MIGRATIONS.push(MIGRATION_8);

const MIGRATION_9: Migration = {
  to: 9,
  describe: 'Adds remembered game plans, fighter relationships, callouts, weight class plans and per injury treatment records.',
  apply: (save) => {
    if (!save.gamePlans) save.gamePlans = { lastGeneral: null, lastGeneralOn: null, byBout: {} };
    if (!save.relationships) save.relationships = {};
    if (!save.callouts) save.callouts = {};
    if (!save.weightClassPlans) save.weightClassPlans = {};
    if (!save.injuryTreatments) save.injuryTreatments = {};
    // Older injury decisions carried their identity inside the resolution text. Lift it
    // into the real fields so they are recognised rather than being asked again.
    for (const m of save.inbox ?? []) {
      if (m.decisionKey) continue;
      if (typeof m.resolution === 'string' && m.resolution.startsWith('injury-decision-')) {
        m.decisionKey = m.resolution;
        m.linkedInjuryId = m.resolution.replace('injury-decision-', '');
        m.resolution = null;
        m.decisionCreatedOn = m.date;
      }
    }
  },
};
MIGRATIONS.push(MIGRATION_9);

const MIGRATION_10: Migration = {
  to: 10,
  describe: 'Adds the decision lifecycle fields, repairs stuck and duplicated inbox items, removes the mandatory travel stage, and enforces the division invariant on open offers.',
  apply: (save) => {
    // Every message declares whether it blocks the calendar. Anything written before this
    // existed was mandatory by definition, except the categories that never should be.
    for (const m of save.inbox ?? []) {
      if (m.mandatory === undefined) {
        m.mandatory = m.category !== 'news' && m.category !== 'ranking';
      }
      if (m.selectedChoiceKey && !m.effectsAppliedOn) m.effectsAppliedOn = m.decisionResolvedOn ?? m.date;
    }
    // The travel stage is no longer a decision. Close any that are sitting open.
    for (const task of Object.values(save.fightWeek ?? {})) {
      if (task.stage !== 'travel' && task.stage !== 'arrival' && task.stage !== 'medical-exam') continue;
      if (task.status === 'complete' || task.status === 'skipped') continue;
      task.status = 'complete';
      task.resolvedOn = task.dueOn;
      task.outcome = task.outcome ?? 'Handled by the promotion.';
    }
  },
};
MIGRATIONS.push(MIGRATION_10);

/** Events whose name uses the real promotion as the simulated one. */
const LEGACY_EVENT_NAME = /^UFC\s+(\d+)$|^UFC\s+Fight\s+Night:\s*(.+)$/;

const MIGRATION_11: Migration = {
  to: 11,
  describe: 'Renames the simulated promotion to the Unified World Fight Series. Generated events keep their number and change only their prefix. Real historical references are left untouched.',
  apply: (save) => {
    // Only future, generated events are renamed. A completed event is a record of something
    // that happened in this save's history and its name is part of that record, so it is
    // left alone unless it is still in the future.
    let fightNightSeen = 0;
    const events = Object.values(save.events ?? {}).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const ev of events) {
      const match = LEGACY_EVENT_NAME.exec(ev.name);
      if (!match) continue;
      if (ev.date < save.date) continue;
      if (match[1]) {
        ev.name = numberedEventName(Number(match[1]));
      } else {
        fightNightSeen++;
        ev.name = fightNightName((save.counters?.fightNightNumber ?? 83) + fightNightSeen);
      }
    }
    if (save.counters) {
      save.counters.fightNightNumber = (save.counters.fightNightNumber ?? 83) + fightNightSeen;
    }
    // Contracts name the promotion. This is a simulated value, never a reported one.
    for (const contract of Object.values(save.contracts ?? {})) {
      if (contract.promotion === 'UFC') contract.promotion = PROMOTION_NAME;
    }
    // Inbox senders that named the real promotion as the simulated one.
    for (const m of save.inbox ?? []) {
      if (m.senderName === 'UFC matchmaking') m.senderName = PROMOTION_MATCHMAKING;
      else if (m.senderName === 'UFC contracts') m.senderName = PROMOTION_CONTRACTS;
      else if (m.senderName === 'UFC marketing') m.senderName = PROMOTION_MARKETING;
    }
  },
};
MIGRATIONS.push(MIGRATION_11);

/**
 * Schema 12: matchmaking interest, division history and the champion move fields.
 *
 * Everything added here is derived from state the save already holds, so an existing career
 * keeps its championships, rankings, rivalries and results untouched. A callout that was
 * answered before this build gets the matchmaking record it should always have had, which
 * means an in progress save benefits from the fix rather than only new careers.
 */
const MIGRATION_12: Migration = {
  to: 12,
  describe:
    'Adds persistent matchmaking interest, division history and champion move fields. Answered callouts in an existing save are converted into live matchmaking records, and no championship, ranking, rivalry or result is altered.',
  apply: (save) => {
    save.matchupInterests = save.matchupInterests ?? {};
    save.divisionHistory = save.divisionHistory ?? {};

    // Every fighter gets an open spell in whatever division they are currently in, so the
    // history is complete from this point forward without inventing a past that was never
    // recorded.
    for (const f of Object.values(save.fighters ?? {})) {
      if (f.heldTitleDivisionId === undefined) f.heldTitleDivisionId = null;
      if (f.titleHoldDeadline === undefined) f.titleHoldDeadline = null;
      const existing = save.divisionHistory![f.id];
      if (existing && existing.length > 0) continue;
      save.divisionHistory![f.id] = [
        {
          divisionId: f.divisionId,
          startedOn: f.lastFightDate ?? save.date,
          endedOn: null,
          fights: 0,
          wins: 0,
          bestRanking: f.ranking ?? null,
          heldTitle: Boolean(f.isChampion),
          titleDefenses: f.titleDefenses ?? 0,
          endReason: null,
        },
      ];
    }

    // Weight class plans written before this build have no move kind or title decision. The
    // conservative reading of an old plan is a permanent move that vacates, which is exactly
    // what the old code did unconditionally.
    for (const plan of Object.values(save.weightClassPlans ?? {})) {
      const p = plan as typeof plan & { kind?: unknown; titleDecision?: unknown; championPath?: unknown; championPathExplanation?: unknown };
      if (p.kind === undefined) p.kind = 'permanent';
      if (p.titleDecision === undefined) p.titleDecision = 'vacate-now';
      if (p.championPath === undefined) p.championPath = null;
      if (p.championPathExplanation === undefined) p.championPathExplanation = null;
    }

    // Answered callouts become matchmaking records. Without this, a player mid save who had
    // already called somebody out would see the callout sitting answered forever with no way
    // for it to become a fight.
    for (const callout of Object.values(save.callouts ?? {})) {
      const c = callout as typeof callout & { fanResponse?: unknown; matchupInterestId?: unknown };
      if (c.fanResponse === undefined) c.fanResponse = null;
      if (c.matchupInterestId === undefined) c.matchupInterestId = null;
      if (callout.status !== 'answered') continue;
      const positive =
        callout.response === 'accept' ||
        callout.response === 'counter-callout' ||
        callout.response === 'respectful-answer' ||
        callout.response === 'future-promise' ||
        callout.response === 'insult';
      if (!positive) continue;
      const caller = save.fighters?.[callout.fromId];
      const target = save.fighters?.[callout.toId];
      if (!caller || !target) continue;
      // Only a callout that is still recent enough to matter is revived.
      if (daysBetween(callout.madeOn, save.date) > 150) continue;
      const id = `matchup-${callout.fromId}-${callout.toId}-${callout.madeOn}`;
      if (save.matchupInterests![id]) continue;
      save.matchupInterests![id] = {
        id,
        source: 'callout',
        callerId: callout.fromId,
        targetId: callout.toId,
        divisionId: target.divisionId,
        createdOn: callout.madeOn,
        expiresOn: addDays(callout.madeOn, callout.response === 'accept' ? 180 : 120),
        requestedConditions: callout.text,
        opponentResponse: callout.response === 'accept' ? 'accepted' : 'open to it',
        fanResponse: null,
        promotionResponse: null,
        interestScore: Math.round(callout.promotionInterest * 0.5 + (callout.response === 'accept' ? 25 : 8)),
        priority: 0,
        rivalryEffect: 0,
        eligibility: 'eligible',
        blockers: [],
        linkedOfferId: null,
        linkedBoutId: null,
        resolution: null,
        lastReportedState: null,
      };
      c.matchupInterestId = id;
    }

    // Every live interest is evaluated once so a migrated save starts with correct blockers
    // rather than claiming everything is eligible.
    for (const interest of Object.values(save.matchupInterests ?? {})) {
      evaluateInterest(save, interest);
    }

    // A championship in a division whose champion has left is either restored to a held title
    // arrangement or released, never left pointing at somebody who is not there.
    for (const [divisionId, table] of Object.entries(save.rankings ?? {})) {
      if (!table.championId) continue;
      const champ = save.fighters?.[table.championId];
      if (!champ) {
        table.championId = null;
        continue;
      }
      if (champ.divisionId !== divisionId) {
        champ.heldTitleDivisionId = divisionId as typeof champ.divisionId;
        champ.titleHoldDeadline = addDays(save.date, 270);
      }
    }
  },
};
MIGRATIONS.push(MIGRATION_12);

/**
 * Schema 13: persistent officials and feature flags.
 *
 * The officials roster is generated deterministically from the save seed, so an existing
 * career gets the same judges it would have had if the roster had always been there. Bouts
 * already completed keep the judge names recorded on their scorecards; only future bouts get
 * an assignment, because reassigning a fight that has already happened would rewrite history.
 */
const MIGRATION_13: Migration = {
  to: 13,
  describe:
    'Adds persistent judges and referees with accumulating records, and feature flags for the optional systems. Completed fights keep the judge names already recorded on their scorecards.',
  apply: (save) => {
    ensureOfficials(save);
    const flags = (save.settings as unknown as Record<string, unknown>) ?? {};
    // Defensive defaults. Every flag is on except the ones the specification says default off.
    if (flags.featureFlags === undefined) {
      (save.settings as unknown as Record<string, unknown>).featureFlags = {
        historicalWorlds: false,
        womensDivisions: true,
        mediaDepth: true,
        businessDepth: true,
        antiDoping: false,
        detailedCommissions: true,
        persistentOfficials: true,
      };
    }
    // Only future bouts are assigned. A completed bout already has judge names on its
    // scorecards and those are the record of what happened.
    for (const bout of Object.values(save.bouts ?? {})) {
      if (bout.status !== 'scheduled') continue;
      if (bout.officials) continue;
      assignOfficials(save, bout);
    }
  },
};
MIGRATIONS.push(MIGRATION_13);

/**
 * Schema 14: the number one contender position.
 *
 * Existing saves have no contender record because the concept did not exist. Rather than inventing
 * a claim nobody earned, the migration looks for evidence already in the save: a completed title
 * eliminator whose winner is still in the division, unbeaten since, and not the champion. That is
 * a claim the fighter demonstrably earned under the old rules, so honouring it is restoring a
 * promise rather than fabricating one. Divisions with no such evidence simply start with no
 * standing contender, which is a valid state.
 */
const MIGRATION_14: Migration = {
  to: 14,
  describe:
    'Adds the number one contender position. An existing save recovers a claim only where a completed title eliminator provides evidence for it; no claim is invented.',
  apply: (save) => {
    save.contenders = save.contenders ?? {};
    const results = Object.values(save.history?.results ?? {}).sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const result of results) {
      const bout = save.bouts?.[result.boutId];
      if (!bout) continue;
      if (bout.bookingKind !== 'eliminator' && bout.bookingKind !== 'title-eliminator') continue;
      if (result.isTitleFight || result.isInterimTitleFight) continue;
      const divisionId = bout.divisionId;
      if (save.contenders[divisionId]) continue;
      const winnerId = result.winnerId;
      if (!winnerId) continue;
      const winner = save.fighters?.[winnerId];
      if (!winner || winner.retired || winner.activityStatus !== 'active') continue;
      if (winner.divisionId !== divisionId) continue;
      if (save.rankings?.[divisionId]?.championId === winner.id) continue;
      // Only if they have not lost since, because a later loss would have ended the claim.
      if (winner.lossStreak > 0) continue;
      save.contenders[divisionId] = {
        fighterId: winner.id,
        divisionId,
        source: 'eliminator-win',
        earnedOn: result.date,
        earnedBoutId: bout.id,
        expiresOn: addDays(result.date, 550),
        fulfilledOn: null,
        fulfilledBoutId: null,
        forfeitedOn: null,
        forfeitReason: null,
        note: `${winner.name} won a number one contender bout.`,
      };
    }
  },
};
MIGRATIONS.push(MIGRATION_14);

/**
 * Schema 15: the ranking points ledger.
 *
 * Points previously lived only on the fifteen ranked entries, so a fighter who dropped out lost
 * their entire accumulated record. The ledger is seeded from whatever the table currently holds,
 * which preserves every existing standing exactly while giving unranked fighters somewhere to
 * accumulate from now on.
 */
const MIGRATION_15: Migration = {
  to: 15,
  describe:
    'Moves ranking points into a per division ledger so a fighter who leaves the top fifteen keeps their record. Existing standings are preserved exactly.',
  apply: (save) => {
    save.rankingPoints = save.rankingPoints ?? {};
    for (const [divisionId, table] of Object.entries(save.rankings ?? {})) {
      const ledger = save.rankingPoints[divisionId] ?? {};
      for (const entry of table.entries ?? []) {
        if (ledger[entry.fighterId] === undefined) ledger[entry.fighterId] = entry.points;
      }
      save.rankingPoints[divisionId] = ledger;
    }
  },
};
MIGRATIONS.push(MIGRATION_15);

export function migrateSave(save: SaveGame): SaveGame {
  const from = save.schemaVersion ?? 1;
  if (from > SAVE_SCHEMA_VERSION) {
    throw new Error(
      `This save was written by a newer version of the game (schema ${from}, this build reads ${SAVE_SCHEMA_VERSION}).`
    );
  }

  for (const migration of MIGRATIONS) {
    if (from < migration.to) migration.apply(save);
  }

  // Defensive repairs that apply at any version. A save that survives decades of play
  // should never fail to open because one optional structure is missing.
  save.settings = { ...DEFAULT_SETTINGS, ...save.settings };
  if (!save.rankings) save.rankings = allDivisionRankings(save.date);
  for (const d of DIVISIONS) {
    if (!save.rankings[d.id]) {
      save.rankings[d.id] = { divisionId: d.id, championId: null, interimChampionId: null, entries: [], updatedOn: save.date, fromOfficialSnapshot: false };
    }
  }
  if (!save.inbox) save.inbox = [];
  if (!save.fightOffers) save.fightOffers = {};
  if (!save.contractOffers) save.contractOffers = {};
  if (!save.camps) save.camps = {};
  if (!save.fightWeek) save.fightWeek = {};
  if (!save.socialFeed) save.socialFeed = {};
  if (!save.pressers) save.pressers = {};
  if (!save.weighIns) save.weighIns = {};
  if (!save.ledger) save.ledger = [];
  if (!save.sponsors) save.sponsors = {};
  if (!save.managers) save.managers = {};
  if (!save.doping) save.doping = {};
  if (!save.gamePlans) save.gamePlans = { lastGeneral: null, lastGeneralOn: null, byBout: {} };
  if (!save.relationships) save.relationships = {};
  if (!save.callouts) save.callouts = {};
  if (!save.weightClassPlans) save.weightClassPlans = {};
  if (!save.injuryTreatments) save.injuryTreatments = {};
  // Camp records repaired defensively: a camp pointing at a bout that is gone, or running
  // past its own end date, would otherwise leave the career stuck in camp forever.
  const activeByFighter = new Map<string, string>();
  for (const camp of Object.values(save.camps ?? {})) {
    if (camp.status !== 'planned' && camp.status !== 'running') continue;
    const bout = camp.boutId ? save.bouts?.[camp.boutId] : null;
    if (camp.boutId && (!bout || bout.status !== 'scheduled')) {
      camp.status = 'abandoned';
      continue;
    }
    if (camp.endDate < save.date) {
      camp.status = 'complete';
      continue;
    }
    if (camp.weeks > 0 && camp.weeksCompleted > camp.weeks) camp.weeksCompleted = camp.weeks;
    if (camp.weeksCompleted < 0) camp.weeksCompleted = 0;
    // Only one camp may be active per fighter.
    const existing = activeByFighter.get(camp.fighterId);
    if (existing) camp.status = 'abandoned';
    else activeByFighter.set(camp.fighterId, camp.id);
  }
  // Inbox repair: stuck decisions, duplicates and items whose linked object is gone.
  repairInbox(save);
  // Every open offer must be in the division its fighter is actually in. A fighter who
  // changed division in an older build could still be holding offers in the old one.
  for (const offer of Object.values(save.fightOffers ?? {})) {
    if (offer.status !== 'open') continue;
    if (offer.isCatchweight) continue;
    const fighter = save.fighters?.[offer.fighterId];
    const opponent = save.fighters?.[offer.opponentId];
    if (!fighter || !opponent) continue;
    if (offer.divisionId === fighter.divisionId && opponent.divisionId === fighter.divisionId) continue;
    offer.status = 'withdrawn';
  }
  // A fighter must not still be listed in a division they have left.
  for (const [divisionId, table] of Object.entries(save.rankings ?? {})) {
    table.entries = table.entries.filter((e) => {
      const f = save.fighters?.[e.fighterId];
      return Boolean(f) && f.divisionId === divisionId;
    });
    if (table.championId) {
      const champ = save.fighters?.[table.championId];
      // A champion campaigning in another division while keeping this belt is a legitimate,
      // deliberate state with its own deadline. Stripping on a division mismatch alone undid
      // that arrangement on every load and quietly vacated the title.
      const holdsUnderArrangement = Boolean(champ && champ.heldTitleDivisionId === divisionId);
      if (!champ || (champ.divisionId !== divisionId && !holdsUnderArrangement)) table.championId = null;
    }
  }

  // A booking pointer that no longer resolves is repaired rather than left to confuse the
  // availability service. Partially written saves are the usual source of these.
  for (const f of Object.values(save.fighters ?? {})) {
    if (!f.nextBoutId) continue;
    const bout = save.bouts?.[f.nextBoutId];
    if (!bout || bout.status !== 'scheduled' || (bout.fighterAId !== f.id && bout.fighterBId !== f.id)) {
      f.nextBoutId = null;
    }
  }

  save.schemaVersion = SAVE_SCHEMA_VERSION;
  return save;
}

export function migrationNotes(fromVersion: number): string[] {
  return MIGRATIONS.filter((m) => m.to > fromVersion).map((m) => `Schema ${m.to}: ${m.describe}`);
}
