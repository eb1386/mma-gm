import { DIVISIONS, DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { BUILDS } from '../config/builds';
import type { SnapshotFile } from '../data/snapshot';
import { NAME_BANKS } from '../data/names';
import { clamp, Rng } from '../rng';
import { addDays, type GameMode, type IsoDate } from '../types/common';
import { ovrDisplayed, RATING_KEYS, type Fighter, type Ratings, historyRatings } from '../types/fighter';
import { DEFAULT_SETTINGS, SAVE_SCHEMA_VERSION, type SaveGame, type SaveSettings } from '../types/save';
import type { Gym } from '../types/world';
import { generateContract } from './economy';
import { potConfidenceFor } from './development';
import { updatePot } from './pot';
import { createGym, hireStaff, moveFighterToGym, seedRankedProduced } from './gyms';
import { allDivisionRankings } from './rankings';
import { clampWalkingWeight, longevityFromWear } from './health';
import { cleanNickname, estimatedBirthDate } from '../data/real-fighter';
import { CREATION_PRESETS, generateFighter, makeDevelopmentProfile, uniformConfidence, type CreationPreset } from './generator';
import { scheduleEvents } from './matchmaking';
import { pushNews } from './history';
import { ensureOfficials } from './officials';
import { startRegionalCareer } from './regional';
import { seedManagers, seedOpeningBalance } from './finance';
import { MIN_REGIONAL_START_AGE } from '../config/regional';

/**
 * New game construction.
 *
 * The selected snapshot is copied into the save. From that moment the save's world is
 * fictional and simulation driven, and nothing that happens inside it is ever written back
 * to the snapshot.
 */

/** Phases reported during career creation so the interface can show progress. */
export const CREATION_PHASES = [
  'Loading snapshot',
  'Copying real fighters',
  'Generating roster depth',
  'Building gyms',
  'Creating contracts',
  'Creating rankings',
  'Scheduling events',
  'Calculating development projections',
  'Finalizing save',
] as const;

export type CreationPhase = (typeof CREATION_PHASES)[number];

export interface CreationProgress {
  phase: CreationPhase;
  index: number;
  total: number;
  detail?: string;
}

export interface NewGameOptions {
  saveName: string;
  seed: number;
  mode: GameMode;
  settings?: Partial<SaveSettings>;
  startDate?: IsoDate;
  /** Real fighter to control in fighter mode. */
  playerFighterId?: string;
  /** Fighter created by the player, already built by the creation screen. */
  createdFighter?: Fighter;
  /**
   * Start the created fighter on a regional promotion rather than signed to the main roster. A
   * fighter under eighteen starts as an amateur.
   */
  regionalPromotionId?: string;
  /** Coach mode setup. */
  coach?: { name: string; gymId?: string; newGym?: { name: string; country: string; city: string } };
  /** Called as each phase begins. Lets the interface report progress and stay responsive. */
  onProgress?: (progress: CreationProgress) => void;
  /** Returning true cancels creation before the save becomes active. */
  shouldCancel?: () => boolean;
}

export class CareerCreationCanceled extends Error {
  constructor() {
    super('Career creation was canceled.');
    this.name = 'CareerCreationCanceled';
  }
}

const GENERIC_GYM_NAMES = [
  'Ironworks MMA',
  'Northside Combat',
  'Apex Fight Lab',
  'Riverbend Martial Arts',
  'Sentinel MMA',
  'Foundry Fight Team',
  'Halcyon Combat Academy',
  'Redline Fight Club',
  'Stonebridge MMA',
  'Vanguard Martial Arts',
  'Crosscut Fight Team',
  'Longshore MMA',
  'Fieldhouse Combat',
  'Anvil Athletics',
  'Meridian Fight Academy',
  'Bracken MMA',
  'Coastline Combat',
  'Summit Line MMA',
  'Groundwork Academy',
  'Trueline Fight Team',
];

function emptySave(opts: NewGameOptions, snapshot: SnapshotFile): SaveGame {
  const startDate = opts.startDate ?? snapshot.meta.snapshotDate;
  const rng = new Rng(opts.seed);
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    saveId: `save-${opts.seed}-${Date.now().toString(36)}`,
    saveName: opts.saveName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seed: opts.seed,
    rng: rng.getState(),
    date: startDate,
    startDate,
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    player: {
      mode: opts.mode,
      fighterId: null,
      gymId: null,
      coachStaffId: null,
      coachName: opts.coach?.name ?? null,
      achievements: [],
      balance: opts.mode === 'coach' ? 75000 : 0,
    },
    snapshot: snapshot.meta,
    // Built from this snapshot, so there is nothing for the older career repair to bring across.
    snapshotRepairedFrom: snapshot.meta.snapshotId,
    fighters: {},
    gyms: {},
    staff: {},
    contracts: {},
    events: {},
    bouts: {},
    camps: {},
    rankings: allDivisionRankings(startDate),
    pfp: { entries: [], updatedOn: startDate, fromOfficialSnapshot: true },
    inbox: [],
    fightOffers: {},
    contractOffers: {},
    history: {
      results: {},
      reigns: [],
      news: [],
      awards: [],
      hallOfFame: [],
      rankingHistory: [],
      retirements: [],
    },
    // These start empty rather than absent so a new save and a migrated save have exactly
    // the same shape. Without that a fresh career and the same career reloaded serialize
    // differently, which the round trip test correctly refuses to accept.
    fightWeek: {},
    socialFeed: {},
    pressers: {},
    weighIns: {},
    careerState: { state: 'available', reason: 'A new career.', since: startDate, actionKey: null },
    ledger: [],
    finance: { cash: opts.mode === 'coach' ? 75000 : 0, careerEarnings: 0, careerExpenses: 0, debt: 0, monthlyExpenses: 0, lastMonthlyOn: null },
    sponsors: {},
    managers: {},
    doping: {},
    gamePlans: { lastGeneral: null, lastGeneralOn: null, byBout: {} },
    relationships: {},
    callouts: {},
    weightClassPlans: {},
    injuryTreatments: {},
    counters: { fighter: 0, gym: 0, staff: 0, event: 0, bout: 0, camp: 0, news: 0, message: 0, offer: 0, ppvNumber: 299, fightNightNumber: 83, ledger: 0 },
    pendingDecision: null,
  };
}

/**
 * Fills each division out to its target roster size with clearly labelled fictional
 * fighters. Real roster depth below the rankings is not available from the compliant
 * source, so the alternative would be inventing people and presenting them as real. These
 * fighters carry isRealPerson false and are marked as fictional throughout the interface.
 */
function fillRoster(save: SaveGame, rng: Rng): number {
  let created = 0;
  for (const division of DIVISIONS) {
    const current = Object.values(save.fighters).filter((f) => f.divisionId === division.id).length;
    const needed = Math.max(0, division.targetRosterSize - current);
    for (let i = 0; i < needed; i++) {
      // Unranked roster depth sits below the ranked fighters by design, with a long tail.
      const tier = rng.next();
      const targetOvr =
        tier < 0.06
          ? rng.normalClamped(76, 3, 70, 82)
          : tier < 0.3
            ? rng.normalClamped(70, 3.5, 62, 78)
            : tier < 0.7
              ? rng.normalClamped(65, 4, 55, 73)
              : rng.normalClamped(60, 4.5, 48, 68);

      const age =
        tier < 0.3 ? rng.int(26, 34) : tier < 0.7 ? rng.int(23, 32) : rng.int(21, 29);

      const f = generateFighter(rng, {
        divisionId: division.id,
        targetOvr,
        spread: rng.range(4, 12),
        age,
        today: save.date,
        idPrefix: 'gen',
        idNumber: ++save.counters.fighter,
      });
      f.ufcRecord = {
        wins: Math.max(0, Math.round(rng.normal(2.2, 2))),
        losses: Math.max(0, Math.round(rng.normal(1.4, 1.3))),
        draws: 0,
        noContests: 0,
      };
      f.record.wins = Math.max(f.record.wins, f.ufcRecord.wins);
      f.record.losses = Math.max(f.record.losses, f.ufcRecord.losses);
      save.fighters[f.id] = f;
      created++;
    }
  }
  return created;
}

/** Creates fictional gyms so generated fighters have somewhere to train. */
function fillGyms(save: SaveGame, rng: Rng): void {
  const needed = 26;
  const used = new Set(Object.values(save.gyms).map((g) => g.name));
  for (let i = 0; i < needed; i++) {
    const bank = rng.weighted(NAME_BANKS, (b) => b.weight);
    let name = rng.pick(GENERIC_GYM_NAMES);
    let guard = 0;
    while (used.has(name) && guard++ < 40) name = `${rng.pick(GENERIC_GYM_NAMES)} ${rng.pick(bank.cities)}`;
    used.add(name);
    const gym = createGym(save, rng, {
      name,
      country: bank.country,
      countryCode: bank.code,
      city: rng.pick(bank.cities),
    });
    const roles: Parameters<typeof hireStaff>[2][] = ['head-coach', 'striking-coach', 'wrestling-coach', 'grappling-coach', 'strength-conditioning'];
    for (const role of roles) hireStaff(save, gym, role, rng);
    if (rng.chance(0.4)) hireStaff(save, gym, 'scout', rng);
    if (rng.chance(0.35)) hireStaff(save, gym, 'nutrition', rng);
  }

  // Assign every unaffiliated fighter to a gym with space.
  for (const f of Object.values(save.fighters)) {
    if (f.gymId) continue;
    const candidates = Object.values(save.gyms).filter((g) => g.fighterIds.length < g.capacity);
    if (candidates.length === 0) continue;
    const sameCountry = candidates.filter((g) => g.country === f.country);
    const pool = sameCountry.length > 0 && rng.chance(0.65) ? sameCountry : candidates;
    const gym = rng.weighted(pool, (g) => g.reputation + 12);
    moveFighterToGym(save, f.id, gym.id);
  }
}

/** Seeds every roster fighter with a simulated contract. */
function seedContracts(save: SaveGame, rng: Rng): void {
  for (const f of Object.values(save.fighters)) {
    const contract = generateContract(f, save, rng, { isPlayerFighter: false });
    // Existing roster members are partway through their deals.
    contract.fightsRemaining = rng.int(1, contract.terms.fights);
    save.contracts[contract.id] = contract;
    f.contractId = contract.id;
  }
}

/** Gives roster fighters a plausible recent activity date so matchmaking has spacing. */
function seedActivity(save: SaveGame, rng: Rng): void {
  for (const f of Object.values(save.fighters)) {
    if (f.lastFightDate) continue;
    const daysBack = f.ranking !== null || f.isChampion ? rng.int(60, 260) : rng.int(45, 340);
    f.lastFightDate = addDays(save.date, -daysBack);
  }
}

export interface NewGameResult {
  save: SaveGame;
  summary: {
    realFighters: number;
    generatedFighters: number;
    gyms: number;
    events: number;
  };
}

export function createNewGame(snapshot: SnapshotFile, opts: NewGameOptions): NewGameResult {
  let phaseIndex = 0;
  const phase = (name: CreationPhase, detail?: string) => {
    opts.onProgress?.({ phase: name, index: phaseIndex++, total: CREATION_PHASES.length, detail });
    if (opts.shouldCancel?.()) throw new CareerCreationCanceled();
  };

  phase('Loading snapshot', snapshot.meta.snapshotId);
  const save = emptySave(opts, snapshot);
  const rng = new Rng(opts.seed);

  // 1. Copy the snapshot's real fighters, gyms and staff into the save.
  phase('Copying real fighters', `${snapshot.fighters.length} athletes`);
  for (const f of snapshot.fighters) {
    const copy = JSON.parse(JSON.stringify(f)) as Fighter;
    // A snapshot built before the builder stripped them carries the profile's quotes.
    copy.nickname = cleanNickname(copy.nickname);
    // Longevity follows wear by the health model's weighting, which older snapshots did not use.
    copy.longevity = longevityFromWear(copy.wear);
    // The source publishes an age, not a date of birth. Without a birth date the fighter would
    // stay that age for the whole save, so one is estimated from the snapshot date (not the
    // career start date, which can differ) and flagged as an estimate.
    if (!copy.birthDate && copy.ageAtSnapshot !== null) {
      copy.birthDate = estimatedBirthDate(copy.id, copy.ageAtSnapshot, snapshot.meta.snapshotDate);
      copy.birthDateEstimated = true;
    }
    // Walking weight is a model estimate, never a sourced fact, and the snapshot builder
    // sets it from the divisional norm alone. Holding it to what this fighter can actually
    // cut is the same rule the weekly pass applies.
    clampWalkingWeight(copy, save.date);
    save.fighters[f.id] = copy;
  }
  for (const g of snapshot.gyms) {
    save.gyms[g.id] = JSON.parse(JSON.stringify(g)) as Gym;
    save.counters.gym = Math.max(save.counters.gym, Number(g.id.split('-').pop()) || 0);
  }
  for (const s of snapshot.staff) {
    save.staff[s.id] = { ...s };
    save.counters.staff = Math.max(save.counters.staff, Number(s.id.split('-').pop()) || 0);
  }

  // 2. Copy the official rankings as the starting standings.
  phase('Creating rankings');
  for (const r of snapshot.rankings) {
    const table = save.rankings[r.divisionId];
    table.championId = r.championId;
    table.interimChampionId = r.interimChampionId;
    table.fromOfficialSnapshot = true;
    table.updatedOn = snapshot.meta.snapshotDate;
    table.entries = r.entries.map((e) => ({
      fighterId: e.fighterId,
      rank: e.rank,
      // Starting points are seeded from the rank so early recalculations are stable.
      points: (16 - e.rank) * 3.2,
      previousRank: e.rank,
      weeksRanked: 0,
      movementReason: 'imported from the official rankings snapshot',
    }));
    if (r.championId) {
      save.history.reigns.push({
        id: `reign-import-${r.divisionId}`,
        divisionId: r.divisionId,
        fighterId: r.championId,
        isInterim: false,
        wonOn: snapshot.meta.snapshotDate,
        wonBoutId: null,
        lostOn: null,
        lostBoutId: null,
        defenses: 0,
        endReason: null,
      });
    }
  }
  save.pfp = {
    entries: snapshot.pfp.entries.map((e) => ({
      fighterId: e.fighterId,
      rank: e.rank,
      points: (16 - e.rank) * 3,
      previousRank: e.rank,
      weeksRanked: 0,
      movementReason: 'imported from the official rankings snapshot',
    })),
    updatedOn: snapshot.meta.snapshotDate,
    fromOfficialSnapshot: true,
  };

  // 3. Fill out roster depth and gym coverage.
  const realCount = Object.keys(save.fighters).length;
  phase('Generating roster depth');
  const generated = save.settings.fillRosterWithGenerated ? fillRoster(save, rng) : 0;
  phase('Building gyms');
  fillGyms(save, rng);
  phase('Creating contracts');
  seedContracts(save, rng);
  seedActivity(save, rng);

  // 4. Recompute Pot for every fighter with the save's own settings.
  phase('Calculating development projections', `${Object.keys(save.fighters).length} fighters`);
  for (const f of Object.values(save.fighters)) {
    if (f.pot === 0) updatePot(save, f);
    f.potConfidence = potConfidenceFor(f, save.date);
    f.ratingHistory = [
      {
        date: save.date,
        ratings: historyRatings(f.ratings),
        ovr: ovrDisplayed(historyRatings(f.ratings)),
        pot: f.pot,
        longevity: f.longevity,
        reason: 'save created',
      },
    ];
  }

  // 5. Player setup.
  if (opts.mode === 'fighter') {
    if (opts.createdFighter) {
      const created = opts.createdFighter;
      save.fighters[created.id] = created;
      save.player.fighterId = created.id;
      save.player.startRanking = null;
      if (!opts.regionalPromotionId) {
        const contract = generateContract(created, save, rng, {
          isPlayerFighter: true,
          fights: 4,
          note: 'Simulated game contract issued on signing. Real contract terms are not public and are never used here.',
        });
        save.contracts[contract.id] = contract;
        created.contractId = contract.id;
      }
      if (!created.gymId) {
        const open = Object.values(save.gyms).filter((g) => g.fighterIds.length < g.capacity);
        // A created fighter trains near home: a gym in their own country when there is one. This
        // used to apply to regional starts only, so a main roster start from Brazil was placed by a
        // pick across every gym in the world and often landed on another continent.
        const local = open.filter((g) => g.country === created.country);
        const gym = rng.weighted(local.length > 0 ? local : open, (g) => g.reputation);
        moveFighterToGym(save, created.id, gym.id);
      }
      if (opts.regionalPromotionId) startRegionalCareer(save, created, opts.regionalPromotionId, rng);
      // The projection pass above ran before the created fighter existed, so their Pot read zero
      // until the year end refresh.
      updatePot(save, created);
      created.potConfidence = potConfidenceFor(created, save.date);
      created.ratingHistory = [
        { date: save.date, ratings: historyRatings(created.ratings), ovr: ovrDisplayed(historyRatings(created.ratings)), pot: created.pot, longevity: created.longevity, reason: 'career created' },
      ];
    } else if (opts.playerFighterId) {
      save.player.fighterId = opts.playerFighterId;
      const f = save.fighters[opts.playerFighterId];
      if (f) {
        const table = save.rankings[f.divisionId];
        // Where the career starts, so the ranking milestones count only what this career climbs.
        save.player.startRanking =
          table?.championId === f.id ? 0 : table?.interimChampionId === f.id ? 1 : table?.entries.find((e) => e.fighterId === f.id)?.rank ?? f.ranking ?? null;
        const existing = f.contractId ? save.contracts[f.contractId] : null;
        if (existing) {
          existing.note =
            'Simulated game contract. Real UFC contract terms are not public, so every figure on this deal is generated by the game rather than reported.';
        }
      }
    }
  } else if (opts.mode === 'coach') {
    let gym: Gym | undefined;
    if (opts.coach?.gymId) {
      gym = save.gyms[opts.coach.gymId];
    } else if (opts.coach?.newGym) {
      const bank = NAME_BANKS.find((b) => b.country === opts.coach!.newGym!.country) ?? NAME_BANKS[0];
      gym = createGym(save, rng, {
        name: opts.coach.newGym.name,
        country: opts.coach.newGym.country,
        countryCode: bank.code,
        city: opts.coach.newGym.city,
        // A gym founded this morning is not as well regarded as one that has been running for
        // years. Without this it draws the roster average and starts out as reputable as anywhere.
        reputation: 18,
        isPlayerControlled: true,
      });
      hireStaff(save, gym, 'head-coach', rng, 45);
    }
    if (gym) {
      gym.isPlayerControlled = true;
      save.player.gymId = gym.id;
      const head = gym.staffIds.map((id) => save.staff[id]).find((s) => s && s.role === 'head-coach');
      save.player.coachStaffId = head?.id ?? null;
      if (head && opts.coach?.name) head.name = opts.coach.name;
      for (const fid of gym.fighterIds) {
        const f = save.fighters[fid];
        if (f) f.relationships.player = 55;
      }
    }
  }

  // The money a fighter career opens with, and the managers there are to choose from. Both are
  // set once the player fighter, gym and circuit exist, because the opening balance is sized from
  // how that fighter lives. Neither draws from the world rng.
  if (opts.mode === 'fighter' && save.player.fighterId) {
    const me = save.fighters[save.player.fighterId];
    if (me) seedOpeningBalance(save, me);
    seedManagers(save, opts.seed);
  }

  // 6. Schedule the opening months of the calendar.
  phase('Scheduling events');
  scheduleEvents(save, rng, 200);

  phase('Finalizing save');

  pushNews(save, {
    date: save.date,
    headline: 'A new save begins',
    body: `World created from the ${snapshot.meta.snapshotId} snapshot. ${realCount} real fighters carry sourced identity, physicals, records and rankings. ${generated} fictional fighters fill out unranked roster depth. Everything that happens from here is simulated.`,
    tags: ['system'],
    fighterIds: [],
    importance: 2,
  });

  // The imported roster arrives already ranked, so the live first time ranked counter would never
  // see any of them and every real gym would read zero for the life of the save. Done here rather
  // than at the copy, because gym affiliation is still being assigned until this point.
  seedRankedProduced(save);

  // The officials roster is part of the world, so it exists from the first day rather than
  // appearing the first time a fight happens to need judges.
  ensureOfficials(save);

  save.rng = rng.getState();
  return {
    save,
    summary: {
      realFighters: realCount,
      generatedFighters: generated,
      gyms: Object.keys(save.gyms).length,
      events: Object.keys(save.events).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Fighter creation
// ---------------------------------------------------------------------------

export interface CreateFighterInput {
  firstName: string;
  lastName: string;
  nickname: string | null;
  country: string;
  hometown: string | null;
  age: number;
  heightIn: number;
  walkingWeightLb: number;
  divisionId: DivisionId;
  build: keyof typeof BUILDS;
  reachIn: number;
  stance: 'orthodox' | 'southpaw' | 'switch';
  gymId: string | null;
  presetKey: string;
  allocation: Ratings;
  startingRecord: { wins: number; losses: number };
}

/**
 * Builds a player created fighter. Country never confers a biological or skill bonus: it
 * only determines naming, home market popularity, travel distance and which regional gyms
 * are nearby.
 */
function createdDevelopment(rng: Rng, ratings: Ratings, age: number, preset: CreationPreset | undefined) {
  const profile = makeDevelopmentProfile(rng, ratings, age);
  const ovr = RATING_KEYS.reduce((s, k) => s + ratings[k], 0) / 6;
  if (preset?.ceilingMean !== undefined) {
    // An absolute ceiling for the preset, with a year's more room for every year a fighter starts
    // younger than twenty three, so starting at sixteen still pays off. Only created fighters take
    // this path: the generated world keeps the profile it was balanced around.
    const mean = preset.ceilingMean + Math.max(0, 23 - age);
    profile.hiddenCeiling = clamp(rng.normal(mean, 4), ovr + 3, 95);
  } else {
    profile.hiddenCeiling = clamp(profile.hiddenCeiling + (preset?.potBias ?? 0), ovr - 3, 99);
  }
  return profile;
}

/**
 * The ages a preset can be created at.
 *
 * The age field took anything from sixteen to forty five whatever the preset, so a late career
 * veteran's full budget and 24-8 record could be put on a sixteen year old, who then started far
 * above the local circuit with a whole career of Longevity ahead. A few years either side of the
 * preset's own range is allowed. The raw prospect reaches down to the youngest regional start,
 * because starting at sixteen and earning the call up is the path that preset is for. The sandbox
 * is free by design.
 */
export function presetAgeBounds(preset: CreationPreset | undefined): [number, number] {
  if (!preset || preset.key === 'sandbox') return [MIN_REGIONAL_START_AGE, 45];
  const lo = preset.key === 'raw-prospect' ? MIN_REGIONAL_START_AGE : Math.max(MIN_REGIONAL_START_AGE, preset.ageRange[0] - 3);
  return [lo, Math.min(45, preset.ageRange[1] + 4)];
}

/**
 * Wear that gives a created fighter the Longevity their age and record imply. The deficit is the
 * career already lived, so it goes into the head and the joints, the two kinds of wear rest barely
 * recovers; spread over the fast healing kinds it melted back a point every few weeks. Past 60 on
 * those two, the remainder is spread over the other four. The longevityFromWear weights sum to one:
 * head and joints carry 0.52 of it and the rest 0.48.
 */
function createdWear(longevity: number): Pick<Fighter, 'wear' | 'longevity'> {
  const deficit = 100 - longevity;
  const lasting = Math.min(60, deficit / 0.52);
  const rest = Math.max(0, (deficit - lasting * 0.52) / 0.48);
  const wear = { neurological: lasting, joint: lasting, facial: rest, body: rest, weightCut: rest, recovery: rest };
  return { wear, longevity: longevityFromWear(wear) };
}

export function buildCreatedFighter(input: CreateFighterInput, seed: number, today: IsoDate): Fighter {
  const preset = CREATION_PRESETS.find((p) => p.key === input.presetKey);
  // Reassigned once the form values are sanitised below.
  const rng = new Rng(seed ^ 0xc0ffee);
  const bank = NAME_BANKS.find((b) => b.country === input.country) ?? NAME_BANKS[0];
  const division = DIVISION_BY_ID[input.divisionId];
  const ratings = {} as Ratings;
  for (const k of RATING_KEYS) ratings[k] = clamp(Math.round(Number.isFinite(input.allocation[k]) ? input.allocation[k] : 15), 15, 90);
  // Number fields arrive straight from the form. An emptied field is NaN and a typed one can be
  // anything, and both used to reach the fighter as they were: a NaN height, an age of four.
  const num = (v: number, fallback: number, lo: number, hi: number) => clamp(Math.round(Number.isFinite(v) ? v : fallback), lo, hi);
  input = {
    ...input,
    age: num(input.age, preset ? Math.round((preset.ageRange[0] + preset.ageRange[1]) / 2) : 24, ...presetAgeBounds(preset)),
    heightIn: num(input.heightIn, division.priors.heightIn.mean, 58, 86),
    reachIn: num(input.reachIn, division.priors.reachIn.mean, 56, 92),
    walkingWeightLb: num(input.walkingWeightLb, division.limitLb + division.typicalWalkAroundOverLb, division.floorLb, division.limitLb + 45),
    startingRecord: {
      wins: num(input.startingRecord.wins, 0, 0, 60),
      losses: num(input.startingRecord.losses, 0, 0, 40),
    },
  };
  const { wins, losses } = input.startingRecord;

  const birthYear = Number(today.slice(0, 4)) - input.age;
  const base = generateFighter(rng, {
    divisionId: input.divisionId,
    targetOvr: 60,
    today,
    idNumber: 0,
    idPrefix: 'player',
    countryBank: bank,
    build: input.build,
    age: input.age,
  });

  return {
    ...base,
    id: 'player-fighter',
    firstName: input.firstName,
    lastName: input.lastName,
    name: `${input.firstName} ${input.lastName}`.trim(),
    nickname: cleanNickname(input.nickname?.trim()),
    country: input.country,
    countryCode: bank.code,
    hometown: input.hometown,
    // The birthday falls in the year before today's date, so the fighter is exactly the age the
    // player chose. A random month used to leave half of them a year younger than they were made.
    birthDate: addDays(`${birthYear}${today.slice(4, 8)}${today.slice(8, 10) === '29' && today.slice(5, 7) === '02' ? '28' : today.slice(8, 10)}`, -rng.int(0, 360)),
    ageAtSnapshot: input.age,
    heightIn: input.heightIn,
    reachIn: input.reachIn,
    legReachIn: Math.round(input.heightIn * 0.56 * 2) / 2,
    stance: input.stance,
    build: input.build,
    walkingWeightLb: input.walkingWeightLb,
    divisionId: input.divisionId,
    eligibleDivisions: [input.divisionId],
    ratings,
    ratingConfidence: uniformConfidence('very-high'),
    record: { wins, losses, draws: 0, noContests: 0 },
    ufcRecord: { wins: 0, losses: 0, draws: 0, noContests: 0 },
    // The method totals and the streak describe the record the player chose. They were inherited
    // from a random record the generator rolled and then discarded, so a 4-0 fighter could show
    // seven knockout wins and a streak longer than their win count.
    methods: {
      koWins: Math.round(wins * 0.4),
      subWins: Math.round(wins * 0.25),
      decWins: wins - Math.round(wins * 0.4) - Math.round(wins * 0.25),
      koLosses: Math.round(losses * 0.35),
      subLosses: Math.round(losses * 0.25),
      decLosses: losses - Math.round(losses * 0.35) - Math.round(losses * 0.25),
    },
    winStreak: losses === 0 ? wins : Math.min(wins, base.winStreak),
    lossStreak: 0,
    careerEarnings: wins * 9000 + losses * 6000,
    gymId: input.gymId,
    isRealPerson: false,
    realSourceIds: null,
    provenance: {},
    createdBy: 'user',
    peakOvr: ovrDisplayed(ratings),
    peakOvrDate: today,
    popularity: clamp(6 + input.startingRecord.wins * 1.2, 1, 40),
    // Wear is the source of truth for Longevity: every health pass recomputes Longevity from it. The
    // chosen Longevity used to be set alone over the generator's light wear, so the first rest week
    // raised it from 93 to 98.
    ...createdWear(clamp(Math.round(98 - Math.max(0, input.age - 23) * 1.6 - input.startingRecord.losses * 1.4), 30, 100)),
    lastFightDate: null,
    walkingWeightNote: undefined,
    // The development profile belongs to the fighter the player actually built. It used to be the
    // one drawn for a throwaway Ovr 60 base, and the preset's ceiling bias was never applied, so a
    // raw prospect did not have the higher ceiling its description promises.
    development: createdDevelopment(rng, ratings, input.age, preset),
  } as Fighter & { walkingWeightNote?: undefined };
  void division;
}

/** Points available and validation for the creation screen. */
export function validateAllocation(allocation: Ratings, pointBudget: number): { ok: boolean; used: number; remaining: number; message: string } {
  const used = RATING_KEYS.reduce((s, k) => s + allocation[k], 0);
  const remaining = pointBudget - used;
  if (RATING_KEYS.some((k) => allocation[k] < 15 || allocation[k] > 90)) {
    return { ok: false, used, remaining, message: 'Every rating must be between 15 and 90.' };
  }
  if (remaining < 0) return { ok: false, used, remaining, message: `Over budget by ${-remaining} points.` };
  return { ok: true, used, remaining, message: remaining > 0 ? `${remaining} points unspent.` : 'Allocation complete.' };
}
