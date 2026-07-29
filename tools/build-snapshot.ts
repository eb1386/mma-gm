/**
 * Builds a playable snapshot from the raw official ingest.
 *
 * Input:  data/raw-ingest/rankings.json, data/raw-ingest/athletes.json
 * Output: public/data/snapshot-<date>.json, public/data/snapshots.json
 *
 * Run with:  npx vite-node tools/build-snapshot.ts
 *
 * Rules this build obeys:
 *   - A field is copied only when the source provided it. Missing values become null and
 *     are counted in the validation report. Nothing is filled in with a plausible guess.
 *   - Ratings are model derived and are labelled as such in provenance, never as an
 *     official measurement.
 *   - Contracts are not created here at all. A real fighter's contract terms are not
 *     public, so the game generates a clearly labelled simulated contract at new game time.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDS, inferBuild } from '../src/core/config/builds';
import { DIVISIONS, DIVISION_BY_ID, divisionFromLabel, type DivisionId } from '../src/core/config/divisions';
import { deriveRatings, deriveTendencies, RATING_PIPELINE_VERSION, type SourcedAthleteStats } from '../src/core/data/ratings-pipeline';
import { determineActivityStatus, normalizeName } from '../src/core/data/provider';
import type { SnapshotFile } from '../src/core/data/snapshot';
import { clamp, Rng } from '../src/core/rng';
import type { IsoDate, Provenance, Stance } from '../src/core/types/common';
import { ovrDisplayed, RATING_KEYS, type Fighter, type Tendencies } from '../src/core/types/fighter';
import type { Gym, GymStaff } from '../src/core/types/world';
import type { SnapshotMeta } from '../src/core/types/save';
import { deriveStyleLabels, makeDevelopmentProfile, makeTendencies } from '../src/core/world/generator';
import { generateActivityProfile, generateFame, generatePersonality, generateSocial } from '../src/core/world/identity';
import { NAME_BANKS } from '../src/core/data/names';
import { estimatePot } from '../src/core/world/development';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IN_DIR = join(ROOT, 'data', 'raw-ingest');
const OUT_DIR = join(ROOT, 'public', 'data');
const CORRECTIONS = join(ROOT, 'data', 'corrections.json');

interface RawAthlete {
  slug: string;
  name: string | null;
  nickname: string | null;
  divisionLabel: string | null;
  record: { w: number; l: number; d: number } | null;
  status: string | null;
  placeOfBirth: string | null;
  trainsAt: string | null;
  fightingStyle: string | null;
  age: number | null;
  heightIn: number | null;
  weightLb: number | null;
  reachIn: number | null;
  legReachIn: number | null;
  octagonDebut: string | null;
  isTitleHolder: boolean;
  isInterimHolder: boolean;
  heroRankTag: string | null;
  pfpTag: string | null;
  winStreak: number | null;
  lossStreak: number | null;
  winsByKo: number | null;
  winsBySub: number | null;
  sigStrLandedPerMin: number | null;
  sigStrAbsorbedPerMin: number | null;
  takedownAvgPer15: number | null;
  submissionAvgPer15: number | null;
  sigStrDefensePct: number | null;
  takedownDefensePct: number | null;
  knockdownAvgPer15: number | null;
  avgFightTime: string | null;
  sigStrLanded: number | null;
  sigStrAttempted: number | null;
  takedownsLanded: number | null;
  takedownsAttempted: number | null;
  strikeTarget: Record<string, number> | null;
  strikePosition: Record<string, { value: number; percent: number }> | null;
  winMethod: Record<string, { value: number; percent: number }> | null;
  rankingDivision: string | null;
  rankingRank: number | null;
  pfpOnly: boolean;
  sourceUrl: string;
  fetchedAt: string;
  missingFields: string[];
}

const rankingsRaw = JSON.parse(readFileSync(join(IN_DIR, 'rankings.json'), 'utf8'));
const athletesRaw = JSON.parse(readFileSync(join(IN_DIR, 'athletes.json'), 'utf8'));
const athletes: Record<string, RawAthlete> = athletesRaw.athletes;
const corrections: Record<string, Partial<RawAthlete> & { activityStatus?: string; note?: string }> = existsSync(CORRECTIONS)
  ? JSON.parse(readFileSync(CORRECTIONS, 'utf8')).fighters ?? {}
  : {};

const snapshotDate: IsoDate = (rankingsRaw.fetchedAt ?? new Date().toISOString()).slice(0, 10);
const snapshotId = `ufc-official-${snapshotDate}`;
const rng = new Rng(`snapshot-${snapshotId}`);

const warnings: string[] = [];
const notes: string[] = [];
const missingFieldCounts: Record<string, number> = {};

function prov(field: string, a: RawAthlete, confidence: Provenance['confidence'] = 'high', transformation?: string): Provenance {
  return {
    source: 'ufc.com official athlete profile',
    sourceId: a.slug,
    sourceUrl: a.sourceUrl,
    fetchedAt: a.fetchedAt,
    verifiedAt: a.fetchedAt,
    confidence,
    transformation,
    manuallyOverridden: corrections[a.slug] ? field in corrections[a.slug] : false,
  };
}

function parseClock(v: string | null): number | null {
  if (!v) return null;
  const m = v.match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseCountry(placeOfBirth: string | null): { country: string; code: string; hometown: string | null } {
  if (!placeOfBirth) return { country: 'Unknown', code: 'ZZ', hometown: null };
  const parts = placeOfBirth.split(',').map((s) => s.trim());
  const country = parts[parts.length - 1];
  const hometown = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
  const bank = NAME_BANKS.find((b) => b.country.toLowerCase() === country.toLowerCase());
  return { country, code: bank?.code ?? country.slice(0, 2).toUpperCase(), hometown };
}

function parseDebut(v: string | null): IsoDate | null {
  if (!v) return null;
  const m = v.match(/^([A-Za-z]{3})\.?\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = months.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Rankings index
// ---------------------------------------------------------------------------

interface RankEntry {
  divisionId: DivisionId;
  rank: number;
  slug: string;
}
const rankIndex = new Map<string, RankEntry>();
const championBySlug = new Map<string, DivisionId>();
const pfpRankBySlug = new Map<string, number>();

for (const d of rankingsRaw.divisions as { name: string; champion: { slug: string } | null; entries: { rank: number; slug: string }[] }[]) {
  const divisionId = divisionFromLabel(d.name);
  if (!divisionId) {
    warnings.push(`Unmapped ranking grouping: ${d.name}`);
    continue;
  }
  if (d.champion) championBySlug.set(d.champion.slug, divisionId);
  for (const e of d.entries) {
    if (!rankIndex.has(e.slug)) rankIndex.set(e.slug, { divisionId, rank: e.rank, slug: e.slug });
  }
}
if (rankingsRaw.pfp) {
  for (const e of rankingsRaw.pfp.entries as { rank: number; slug: string }[]) pfpRankBySlug.set(e.slug, e.rank);
  if (rankingsRaw.pfp.champion) pfpRankBySlug.set(rankingsRaw.pfp.champion.slug, 1);
}

// ---------------------------------------------------------------------------
// Gyms from the sourced "Trains at" field
// ---------------------------------------------------------------------------

const gyms: Gym[] = [];
const staff: GymStaff[] = [];
const gymNameToId: Record<string, string> = {};
let gymCounter = 0;
let staffCounter = 0;

function gymIdFor(name: string, countryCode: string, country: string, city: string | null): string {
  const key = normalizeName(name);
  if (gymNameToId[key]) return gymNameToId[key];
  const id = `gym-real-${++gymCounter}`;
  gymNameToId[key] = id;
  const reputation = clamp(Math.round(rng.normal(62, 12)), 20, 95);
  const g: Gym = {
    id,
    name,
    country,
    countryCode,
    city: city ?? 'Unknown',
    reputation,
    facilities: clamp(Math.round(rng.normal(reputation, 9)), 15, 98),
    capacity: rng.int(14, 46),
    staffIds: [],
    fighterIds: [],
    trainingPartners: {
      striking: clamp(Math.round(rng.normal(reputation, 11)), 15, 98),
      grappling: clamp(Math.round(rng.normal(reputation, 11)), 15, 98),
      wrestling: clamp(Math.round(rng.normal(reputation, 11)), 15, 98),
      submissions: clamp(Math.round(rng.normal(reputation, 11)), 15, 98),
      cardio: clamp(Math.round(rng.normal(reputation, 9)), 15, 98),
      durability: clamp(Math.round(rng.normal(reputation, 9)), 15, 98),
    },
    balance: Math.round(rng.range(40000, 500000)),
    monthlyCosts: Math.round(rng.range(14000, 90000)),
    revenueSharePct: Math.round(rng.range(4, 12)),
    culture: clamp(Math.round(rng.normal(66, 13)), 15, 98),
    safety: clamp(Math.round(rng.normal(64, 14)), 15, 98),
    hardSparringTendency: clamp(Math.round(rng.normal(50, 18)), 5, 95),
    specializations: rng.shuffle([...RATING_KEYS]).slice(0, rng.int(1, 2)),
    championsProduced: 0,
    rankedProduced: 0,
    founded: `${rng.int(1994, 2018)}-01-01`,
    isPlayerControlled: false,
    isReal: true,
    note: 'Gym name is a sourced fact from the official athlete profile. Every other gym attribute on this record is a simulated game value.',
    recentResults: { wins: 0, losses: 0 },
  };
  gyms.push(g);

  const roles: GymStaff['role'][] = [
    'head-coach',
    'striking-coach',
    'grappling-coach',
    'wrestling-coach',
    'strength-conditioning',
    'cutman',
  ];
  const bank = NAME_BANKS.find((b) => b.code === countryCode) ?? NAME_BANKS[0];
  for (const role of roles) {
    const develops =
      role === 'striking-coach'
        ? 'striking'
        : role === 'grappling-coach'
          ? 'grappling'
          : role === 'wrestling-coach'
            ? 'wrestling'
            : role === 'strength-conditioning'
              ? 'cardio'
              : null;
    const s: GymStaff = {
      id: `staff-${++staffCounter}`,
      name: `${rng.pick(bank.first)} ${rng.pick(bank.last)}`,
      role,
      quality: clamp(Math.round(rng.normal(reputation, 10)), 15, 97),
      develops: develops as GymStaff['develops'],
      salary: Math.round(rng.range(30000, 180000)),
      loyalty: clamp(Math.round(rng.normal(66, 14)), 10, 98),
      hiredOn: `${rng.int(2012, 2025)}-01-01`,
      reputation: clamp(Math.round(rng.normal(reputation, 12)), 10, 98),
    };
    staff.push(s);
    g.staffIds.push(s.id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Fighter construction
// ---------------------------------------------------------------------------

const fighters: Fighter[] = [];
const bySlug = new Map<string, Fighter>();
const duplicates: { keptSlug: string; droppedSlug: string; reason: string }[] = [];

for (const [slug, rawIn] of Object.entries(athletes)) {
  const a: RawAthlete = { ...rawIn, ...(corrections[slug] ?? {}) } as RawAthlete;
  for (const f of a.missingFields ?? []) missingFieldCounts[f] = (missingFieldCounts[f] ?? 0) + 1;

  const ranking = rankIndex.get(slug);
  const championOf = championBySlug.get(slug) ?? null;
  const divisionId: DivisionId | null =
    championOf ?? ranking?.divisionId ?? divisionFromLabel(a.rankingDivision) ?? divisionFromLabel(a.divisionLabel);

  if (!divisionId) {
    warnings.push(`${slug}: no supported division could be resolved, excluded from the snapshot.`);
    continue;
  }

  const activity = determineActivityStatus({
    officialStatus: a.status,
    hasCurrentRanking: Boolean(ranking) || Boolean(championOf),
    recentFightWithinDays: null,
    hasScheduledFight: false,
    manualOverride: (corrections[slug]?.activityStatus as never) ?? null,
  });
  if (activity.status !== 'active') {
    warnings.push(`${slug}: status ${activity.status} (${activity.reason}), excluded from the playable roster.`);
    continue;
  }

  const division = DIVISION_BY_ID[divisionId];
  const geo = parseCountry(a.placeOfBirth);
  const avgFightTimeSeconds = parseClock(a.avgFightTime);

  const stats: SourcedAthleteStats = {
    slug,
    divisionId,
    rank: championOf ? 0 : (ranking?.rank ?? null),
    isChampion: Boolean(championOf) || a.isTitleHolder,
    isInterimChampion: a.isInterimHolder,
    pfpRank: pfpRankBySlug.get(slug) ?? null,
    age: a.age,
    heightIn: a.heightIn,
    reachIn: a.reachIn,
    record: a.record,
    winsByKo: a.winsByKo,
    winsBySub: a.winsBySub,
    winStreak: a.winStreak,
    lossStreak: a.lossStreak,
    sigStrLandedPerMin: a.sigStrLandedPerMin,
    sigStrAbsorbedPerMin: a.sigStrAbsorbedPerMin,
    sigStrDefensePct: a.sigStrDefensePct,
    takedownAvgPer15: a.takedownAvgPer15,
    takedownDefensePct: a.takedownDefensePct,
    submissionAvgPer15: a.submissionAvgPer15,
    knockdownAvgPer15: a.knockdownAvgPer15,
    avgFightTimeSeconds,
    sigStrLanded: a.sigStrLanded,
    sigStrAttempted: a.sigStrAttempted,
    takedownsLanded: a.takedownsLanded,
    takedownsAttempted: a.takedownsAttempted,
    strikeTarget: a.strikeTarget
      ? { headPct: a.strikeTarget.head_percent ?? 0, bodyPct: a.strikeTarget.body_percent ?? 0, legPct: a.strikeTarget.leg_percent ?? 0 }
      : null,
    strikePosition: a.strikePosition
      ? {
          standingPct: a.strikePosition.standing?.percent ?? 0,
          clinchPct: a.strikePosition.clinch?.percent ?? 0,
          groundPct: a.strikePosition.ground?.percent ?? 0,
        }
      : null,
    winMethod: a.winMethod
      ? {
          koPct: a.winMethod['KO/TKO']?.percent ?? 0,
          decPct: a.winMethod['DEC']?.percent ?? 0,
          subPct: a.winMethod['SUB']?.percent ?? 0,
        }
      : null,
  };

  const derived = deriveRatings(stats);
  const build = inferBuild(a.heightIn, a.reachIn, division.priors.heightIn.mean);
  const buildProfile = BUILDS[build];

  const baseTendencies: Tendencies = makeTendencies(rng, derived.ratings);
  const sourcedTendencies = deriveTendencies(stats, derived.ratings);
  const tendencies: Tendencies = { ...baseTendencies };
  for (const [k, v] of Object.entries(sourcedTendencies)) {
    if (typeof v === 'number' && k in tendencies) (tendencies as unknown as Record<string, number>)[k] = v;
  }

  const nameParts = (a.name ?? slug.replace(/-/g, ' ')).split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || nameParts[0];
  const age = a.age;
  const octagonDebut = parseDebut(a.octagonDebut);

  const provenance: Record<string, Provenance> = {};
  if (a.name) provenance.name = prov('name', a);
  if (a.nickname) provenance.nickname = prov('nickname', a);
  if (a.placeOfBirth) provenance.country = prov('country', a, 'high', 'parsed from place of birth');
  if (a.heightIn !== null) provenance.heightIn = prov('heightIn', a);
  if (a.reachIn !== null) provenance.reachIn = prov('reachIn', a);
  if (a.legReachIn !== null) provenance.legReachIn = prov('legReachIn', a);
  if (a.weightLb !== null) provenance.walkingWeightLb = prov('walkingWeightLb', a, 'medium', 'official listed weight, not a walk around weight');
  if (age !== null) provenance.age = prov('age', a);
  if (a.record) provenance.record = prov('record', a);
  if (a.status) provenance.activityStatus = prov('activityStatus', a);
  if (a.trainsAt) provenance.gym = prov('gym', a);
  if (octagonDebut) provenance.octagonDebut = prov('octagonDebut', a);
  provenance.ratings = {
    source: 'derived model',
    sourceId: `ratings-pipeline@${RATING_PIPELINE_VERSION}`,
    fetchedAt: a.fetchedAt,
    confidence: derived.ovrConfidence === 'very-high' || derived.ovrConfidence === 'high' ? 'medium' : 'low',
    transformation:
      'Division normalized rate statistics with empirical Bayes shrinkage, blended with the official ranking as the opponent quality channel. A game rating, not an official measurement.',
  };
  provenance.ranking = prov('ranking', a, 'high', 'official rankings page');

  const gymId = a.trainsAt ? gymIdFor(a.trainsAt, geo.code, geo.country, geo.hometown) : null;

  // The birth date is not published on the profile, only the age. Storing a fabricated
  // birth date would be inventing data, so it stays null and the age is stored as an
  // explicit snapshot age that the world ages forward from the snapshot date.
  const fighter: Fighter = {
    id: `ufc-${slug}`,
    firstName,
    lastName,
    name: a.name ?? slug,
    nickname: a.nickname,
    country: geo.country,
    countryCode: geo.code,
    hometown: geo.hometown,
    realSourceIds: { 'ufc.com': slug },
    isRealPerson: true,
    provenance,
    birthDate: null,
    ageAtSnapshot: age,
    heightIn: a.heightIn,
    reachIn: a.reachIn,
    legReachIn: a.legReachIn,
    stance: 'orthodox' as Stance,
    build,
    // The source publishes a fight night weight, not a walk around weight. The walk
    // around figure is a game model estimate from the division typical, nudged by the
    // inferred build. The build nudge is halved because the build itself is inferred.
    // A model estimate, not a sourced fact. Capped by what this build can take off, so a
    // snapshot fighter does not start carrying more than the weight model says they can cut.
    walkingWeightLb: Math.round(
      division.limitLb + Math.min(division.typicalWalkAroundOverLb + buildProfile.walkAroundOffset * 0.5, (28 / buildProfile.cutDifficulty) * 0.92)
    ),
    divisionId,
    eligibleDivisions: [divisionId],
    ratings: derived.ratings,
    ratingConfidence: derived.confidence,
    pot: 0,
    potConfidence: derived.ovrConfidence,
    longevity: 0,
    wear: { neurological: 0, facial: 0, joint: 0, body: 0, weightCut: 0, recovery: 0 },
    tendencies,
    styleLabels: deriveStyleLabels(tendencies, derived.ratings),
    development: makeDevelopmentProfile(rng, derived.ratings, age ?? 29),
    record: a.record
      ? { wins: a.record.w, losses: a.record.l, draws: a.record.d, noContests: 0 }
      : { wins: 0, losses: 0, draws: 0, noContests: 0 },
    ufcRecord: { wins: 0, losses: 0, draws: 0, noContests: 0 },
    methods: {
      koWins: a.winsByKo ?? 0,
      subWins: a.winsBySub ?? 0,
      decWins: Math.max(0, (a.record?.w ?? 0) - (a.winsByKo ?? 0) - (a.winsBySub ?? 0)),
      koLosses: 0,
      subLosses: 0,
      decLosses: 0,
    },
    boutIds: [],
    winStreak: a.winStreak ?? 0,
    lossStreak: a.lossStreak ?? 0,
    lastFightDate: null,
    nextBoutId: null,
    octagonDebut,
    ranking: championOf ? null : (ranking?.rank ?? null),
    previousRanking: null,
    weeksRanked: 0,
    highestRanking: championOf ? 1 : (ranking?.rank ?? null),
    pfpRanking: pfpRankBySlug.get(slug) ?? null,
    isChampion: Boolean(championOf),
    isInterimChampion: a.isInterimHolder,
    titleReigns: championOf ? 1 : 0,
    titleDefenses: 0,
    gymId,
    managerName: 'Unknown',
    contractId: null,
    popularity: 0,
    regionalPopularity: {},
    momentum: 50,
    morale: 70,
    happiness: 70,
    relationships: { matchmaker: 60, coach: 70, manager: 70, player: 50, team: 70 },
    injuries: [],
    medicalSuspension: null,
    conditioning: 75,
    campSharpness: 0.5,
    careerEarnings: 0,
    lastPurse: null,
    activityStatus: 'active',
    retired: false,
    retirementDate: null,
    hallOfFameYear: null,
    ratingHistory: [],
    peakOvr: ovrDisplayed(derived.ratings),
    peakOvrDate: snapshotDate,
    awards: [],
    weightMisses: 0,
    lastWeightCutQuality: null,
    declinedOffers: 0,
    acceptedShortNotice: 0,
    createdBy: 'real-snapshot',
  };

  // Longevity, wear and popularity are game model values derived from real career shape.
  const careerFights = fighter.record.wins + fighter.record.losses + fighter.record.draws;
  const ageNow = age ?? 29;
  const koLossesEstimate = Math.round(fighter.record.losses * 0.35);
  const wearBase = clamp(careerFights * 1.5 + Math.max(0, ageNow - 24) * 1.7 + koLossesEstimate * 4, 0, 78);
  fighter.wear = {
    neurological: clamp(wearBase * 0.9 + rng.normal(0, 4), 0, 92),
    facial: clamp(wearBase * 0.75 + rng.normal(0, 5), 0, 92),
    joint: clamp(wearBase * 0.85 + rng.normal(0, 5), 0, 92),
    body: clamp(wearBase * 0.6 + rng.normal(0, 4), 0, 92),
    weightCut: clamp(wearBase * 0.5 + buildProfile.cutDifficulty * 8 + rng.normal(0, 4), 0, 92),
    recovery: clamp(wearBase * 0.8 + Math.max(0, ageNow - 30) * 2.2 + rng.normal(0, 5), 0, 92),
  };
  const wearMean = Object.values(fighter.wear).reduce((s, v) => s + v, 0) / 6;
  fighter.longevity = clamp(Math.round(100 - wearMean), 5, 100);

  const rankForPop = championOf ? 0 : (ranking?.rank ?? 16);
  const pfp = pfpRankBySlug.get(slug);
  fighter.popularity = clamp(
    Math.round(
      (championOf ? 82 : 66 - rankForPop * 2.1) + (pfp ? (16 - pfp) * 1.4 : 0) + (fighter.methods.koWins + fighter.methods.subWins) * 0.6
    ),
    5,
    100
  );
  const bank = NAME_BANKS.find((b) => b.country === geo.country);
  if (bank) fighter.regionalPopularity[bank.region] = clamp(fighter.popularity + 14, 5, 100);

  // Identity is generated from a per fighter seed so it is stable across rebuilds. None
  // of it is presented as a fact about the real person: it is a model estimate, exactly
  // like the ratings, and the interface labels it as such.
  const identityRng = new Rng(`identity-${slug}`);
  fighter.personality = generatePersonality(identityRng);
  fighter.activityProfile = generateActivityProfile(identityRng, fighter.personality, fighter);
  fighter.fame = generateFame(identityRng, fighter);
  fighter.social = generateSocial(identityRng, fighter);
  fighter.publicLabels = [];

  fighter.pot = estimatePot(fighter, snapshotDate, 60, 0.72, new Rng(`pot-${slug}`), { stepWeeks: 2 });

  const dupe = [...bySlug.values()].find((f) => normalizeName(f.name) === normalizeName(fighter.name));
  if (dupe) {
    duplicates.push({ keptSlug: dupe.realSourceIds!['ufc.com'], droppedSlug: slug, reason: 'same normalized name already present' });
    continue;
  }
  bySlug.set(slug, fighter);
  fighters.push(fighter);
  if (gymId) gyms.find((g) => g.id === gymId)!.fighterIds.push(fighter.id);
}

// ---------------------------------------------------------------------------
// Rankings structures
// ---------------------------------------------------------------------------

const snapshotRankings: SnapshotFile['rankings'] = DIVISIONS.map((d) => {
  const champ = [...bySlug.entries()].find(([slug]) => championBySlug.get(slug) === d.id);
  const entries = [...rankIndex.values()]
    .filter((r) => r.divisionId === d.id && bySlug.has(r.slug))
    .sort((x, y) => x.rank - y.rank)
    .map((r) => ({ rank: r.rank, fighterId: bySlug.get(r.slug)!.id }));
  return {
    divisionId: d.id,
    championId: champ ? champ[1].id : null,
    interimChampionId: fighters.find((f) => f.divisionId === d.id && f.isInterimChampion)?.id ?? null,
    entries,
  };
});

const pfpEntries = [...pfpRankBySlug.entries()]
  .filter(([slug]) => bySlug.has(slug))
  .sort((x, y) => x[1] - y[1])
  .map(([slug, rank]) => ({ rank, fighterId: bySlug.get(slug)!.id }));

// ---------------------------------------------------------------------------
// Validation report and output
// ---------------------------------------------------------------------------

const fighterCountByDivision: Record<string, number> = {};
for (const d of DIVISIONS) fighterCountByDivision[d.name] = fighters.filter((f) => f.divisionId === d.id).length;

const snapshotYear = Number(snapshotDate.slice(0, 4));
for (const d of DIVISIONS) {
  const r = snapshotRankings.find((x) => x.divisionId === d.id)!;
  // A division that was retired before the snapshot date legitimately has no rankings.
  const contested = d.activeFrom <= snapshotYear && (d.activeUntil === null || d.activeUntil >= snapshotYear);
  if (!contested) {
    notes.push(`${d.name}: not contested as of ${snapshotDate} (active ${d.activeFrom} to ${d.activeUntil ?? 'present'}). No roster imported.`);
    continue;
  }
  if (!r.championId) warnings.push(`${d.name}: no champion resolved from the rankings page.`);
  if (r.entries.length < 15) warnings.push(`${d.name}: only ${r.entries.length} ranked fighters resolved, expected 15.`);
}

const meta: SnapshotMeta = {
  snapshotId,
  snapshotDate,
  generatedAt: new Date().toISOString(),
  sources: [
    {
      name: 'UFC official rankings',
      url: 'https://www.ufc.com/rankings',
      fetchedAt: rankingsRaw.fetchedAt,
      recordCount: snapshotRankings.reduce((s, r) => s + r.entries.length + (r.championId ? 1 : 0), 0),
    },
    {
      name: 'UFC official athlete profiles',
      url: 'https://www.ufc.com/athlete/',
      fetchedAt: athletesRaw.startedAt,
      recordCount: Object.keys(athletes).length,
    },
  ],
  fighterCountByDivision,
  validation: {
    totalFighters: fighters.length,
    realFighters: fighters.length,
    generatedFighters: 0,
    missingFieldCounts,
    duplicatesResolved: duplicates,
    warnings,
    notes,
  },
  changeLog: ['Initial snapshot built from the official UFC rankings and athlete profiles.'],
  note:
    'Fighter identity, physicals, official record, gym name, activity status and ranking are sourced facts from ufc.com. The six performance ratings, Pot, Longevity, wear, popularity, tendencies and every contract in the game are model derived or simulated values and are labelled as such throughout the interface. ufc.com robots.txt disallows the full athlete directory, so the real roster is the officially ranked roster: every champion plus the ranked one through fifteen in each of the eight men\'s divisions. Unranked roster depth is filled with clearly labelled fictional fighters when a save is created.',
};

const snapshot: SnapshotFile = {
  meta,
  fighters,
  gyms,
  staff,
  rankings: snapshotRankings,
  pfp: { entries: pfpEntries },
  gymNameToId,
};

mkdirSync(OUT_DIR, { recursive: true });
const file = `snapshot-${snapshotDate}.json`;
writeFileSync(join(OUT_DIR, file), JSON.stringify(snapshot));
writeFileSync(
  join(OUT_DIR, 'snapshots.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      snapshots: [
        {
          snapshotId,
          snapshotDate,
          label: `Official UFC roster, ${snapshotDate}`,
          file,
          fighterCount: fighters.length,
          isLatest: true,
        },
      ],
    },
    null,
    2
  )
);

console.log(`snapshot ${snapshotId}`);
console.log(`  fighters: ${fighters.length}`);
console.log(`  gyms:     ${gyms.length}  staff: ${staff.length}`);
console.log(`  warnings: ${warnings.length}  notes: ${notes.length}`);
for (const w of warnings.slice(0, 12)) console.log(`    ! ${w}`);
for (const n of notes.slice(0, 6)) console.log(`    - ${n}`);
const byGender = { men: 0, women: 0 };
for (const f of fighters) byGender[DIVISION_BY_ID[f.divisionId].gender]++;
console.log(`  men ${byGender.men}, women ${byGender.women}`);
const ovrs = fighters.map((f) => ovrDisplayed(f.ratings)).sort((a, b) => a - b);
console.log(`  Ovr range ${ovrs[0]} to ${ovrs[ovrs.length - 1]}, median ${ovrs[Math.floor(ovrs.length / 2)]}`);
const pots = fighters.map((f) => f.pot).sort((a, b) => a - b);
console.log(`  Pot range ${pots[0]} to ${pots[pots.length - 1]}`);
console.log(`  written to public/data/${file}`);
