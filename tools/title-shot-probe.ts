import { newCareer } from '../src/core/testing/fixtures';
import { respondToOffer } from '../src/core/world/offers';
import { Rng } from '../src/core/rng';
import { advance, simulatePlayerBout } from '../src/core/world/tick';
import { messageNeedsAction } from '../src/core/world/inbox';
import { createCamp, CAMP_PRESETS } from '../src/core/world/camp';
import { addDays } from '../src/core/types/common';
import { titleShotEligibility } from '../src/core/world/title-eligibility';
import { canCompete } from '../src/core/world/health';
import { willingToFight } from '../src/core/world/identity';
import { offerBlockReason } from '../src/core/world/availability';
import { respondToCounter, signContractOffer } from '../src/core/world/economy';
import { daysBetween } from '../src/core/types/common';
import type { SaveGame } from '../src/core/types/save';
import type { Fighter } from '../src/core/types/fighter';

/**
 * Does a deserving player ever actually get offered a title fight?
 *
 * The eligibility rules were tested in isolation and the world invariants were tested over a
 * simulated year, but neither answers the only question that matters to a player: they are
 * the number one contender, they are healthy, and nothing arrives. This walks a career
 * forward and reports every reason a title offer did not happen on each weekly pass.
 */

const YEARS = Number(process.argv[2] ?? 6);
const RUNS = Number(process.argv[3] ?? 6);

interface Probe {
  titleOffers: number;
  titleBouts: number;
  ordinaryOffers: number;
  weeksRankedTopFive: number;
  weeksEligible: number;
  weeksChampionDefendable: number;
  blockers: Map<string, number>;
  missedWhileEligible: number;
  freeWeeks: number;
  contractsSigned: number;
  notWillingWeeks: number;
  blockedWeeks: Map<string, number>;
  bestRank: number;
  endRank: number | null;
  wasChampion: boolean;
}

function playerOf(save: SaveGame): Fighter {
  return save.fighters[save.player.fighterId!];
}

/**
 * Why a title fight did not get made for the player this week.
 *
 * Deliberately checks the same conditions the booking pass checks, in the same order, so a
 * count here points at one line of production code.
 */
function diagnose(save: SaveGame, me: Fighter): string[] {
  const reasons: string[] = [];
  const table = save.rankings[me.divisionId];
  const champion = table.championId ? save.fighters[table.championId] : null;

  const eligibility = titleShotEligibility(save, me, me.divisionId);
  for (const b of eligibility.blockers) reasons.push(`challenger:${b}`);

  if (!champion) {
    reasons.push('division:vacant');
  } else {
    if (champion.nextBoutId) reasons.push('champion:booked');
    const idle = champion.lastFightDate ? daysBetween(champion.lastFightDate, save.date) : 400;
    if (idle < 180) reasons.push('champion:inside-turnaround');
    if (champion.retired) reasons.push('champion:retired');
  }

  // The player holding any open offer stops another one being created.
  const openOffers = Object.values(save.fightOffers).filter((o) => o.status === 'open' && o.fighterId === me.id);
  if (openOffers.length > 0) reasons.push('player:already-holding-an-offer');
  if (me.offerCooldownUntil && me.offerCooldownUntil > save.date) reasons.push('player:offer-cooldown');

  // Is there a card far enough out for the title pass to use.
  const usable = Object.values(save.events).filter((e) => {
    if (e.status !== 'announced') return false;
    const days = daysBetween(save.date, e.date);
    return days >= 40 && days <= 160 && (e.tier === 'numbered-ppv' || e.tier === 'international');
  });
  if (usable.length === 0) reasons.push('calendar:no-big-card-in-window');

  return reasons;
}

function runOne(seed: number): Probe {
  const f = newCareer(seed);
  const save = f.save;
  const me = playerOf(save);

  // A player who deserves a title shot. The question is not whether they earn it; it is
  // whether the system ever offers it once they have.
  me.popularity = 72;
  me.relationships.matchmaker = 70;

  const probe: Probe = {
    titleOffers: 0,
    titleBouts: 0,
    ordinaryOffers: 0,
    weeksRankedTopFive: 0,
    weeksEligible: 0,
    weeksChampionDefendable: 0,
    blockers: new Map(),
    missedWhileEligible: 0,
    freeWeeks: 0,
    contractsSigned: 0,
    notWillingWeeks: 0,
    blockedWeeks: new Map(),
    bestRank: 99,
    endRank: null,
    wasChampion: false,
  };

  const seenOffers = new Set<string>();
  const seenBouts = new Set<string>();

  for (let week = 0; week < YEARS * 52; week++) {
    const player = playerOf(save);
    if (player.retired) break;

    const rank = player.isChampion ? 0 : (player.ranking ?? 99);
    if (rank < probe.bestRank) probe.bestRank = rank;
    if (player.isChampion) probe.wasChampion = true;
    if (rank <= 5) probe.weeksRankedTopFive++;

    // Accept every offer that arrives. A player who never fights never climbs, so counting
    // offers without answering them measures nothing.
    for (const offer of Object.values(save.fightOffers)) {
      if (offer.fighterId !== player.id) continue;
      if (offer.status !== 'open') continue;
      if (!seenOffers.has(offer.id)) {
        seenOffers.add(offer.id);
        if (offer.isTitleFight || offer.isInterimTitleFight) probe.titleOffers++;
        else probe.ordinaryOffers++;
      }
      const rng = new Rng(save.rng);
      const res = respondToOffer(save, offer.id, { kind: 'accept' }, rng);
      save.rng = rng.getState();
      if (res.accepted && res.boutId) {
        const preset = CAMP_PRESETS[0];
        const camp = createCamp(save, player, {
          boutId: res.boutId,
          startDate: save.date,
          endDate: addDays(offer.date, -7),
          focus: preset.focus,
          intensity: preset.intensity,
          gymId: player.gymId,
          campType: 'home',
          specialistHired: null,
          gamePlan: preset.plans,
          arriveEarlyDays: 0,
        });
        save.camps[camp.id] = camp;
      }
    }
    // Sign any contract offer. A player who never re-signs is unbookable forever, so a probe
    // that ignores this measures nothing about matchmaking.
    for (const co of Object.values(save.contractOffers)) {
      if (co.fighterId !== player.id || co.status !== 'open') continue;
      const crng = new Rng(save.rng);
      const response = respondToCounter(co, { kind: 'accept' }, save, crng);
      save.rng = crng.getState();
      if (response.outcome === 'accepted') {
        signContractOffer(save, player, co, response.round);
        probe.contractsSigned++;
      }
    }

    // Anything else that would block the calendar is answered, so the career keeps moving.
    for (const m of save.inbox) {
      if (messageNeedsAction(save, m) && !m.linkedOfferId) {
        m.status = 'resolved';
        m.resolution = 'answered by the probe';
      }
    }
    for (const bout of Object.values(save.bouts)) {
      if (bout.fighterAId !== player.id && bout.fighterBId !== player.id) continue;
      if (seenBouts.has(bout.id)) continue;
      seenBouts.add(bout.id);
      if (bout.isTitleFight || bout.isInterimTitleFight) probe.titleBouts++;
    }

    // Only diagnose while the player is a plausible challenger and not already fighting.
    const contender = !player.isChampion && !player.nextBoutId && rank <= 5;

    const report = advance(save, { mode: 'week', stopOnDecision: false });
    if (report.playerBoutPending) simulatePlayerBout(save, report.playerBoutPending, ['pressure']);

    // Was the player bookable at all this week, regardless of the title picture.
    if (!player.nextBoutId && !player.retired) {
      const holdsOffer = Object.values(save.fightOffers).some((o) => o.status === 'open' && o.fighterId === player.id);
      const healthy = canCompete(player, save.date).ok;
      const nextCard = Object.values(save.events)
        .filter((e) => e.status === 'announced' && daysBetween(save.date, e.date) >= 42)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      const willing = nextCard ? willingToFight(save, player, daysBetween(save.date, nextCard.date), nextCard.date) : false;
      const blocked = nextCard
        ? offerBlockReason(save, player, { eventDate: nextCard.date })
        : 'no-card';
      if (!holdsOffer && healthy) {
        probe.freeWeeks++;
        if (!willing) probe.notWillingWeeks++;
        if (blocked) probe.blockedWeeks.set(String(blocked), (probe.blockedWeeks.get(String(blocked)) ?? 0) + 1);
      }
    }

    if (!contender) continue;

    const eligibility = titleShotEligibility(save, player, player.divisionId);
    if (eligibility.eligible) probe.weeksEligible++;

    const reasons = diagnose(save, player);
    if (reasons.length === 0) {
      probe.missedWhileEligible++;
      probe.blockers.set('nothing:should-have-happened', (probe.blockers.get('nothing:should-have-happened') ?? 0) + 1);
    }
    for (const r of reasons) probe.blockers.set(r, (probe.blockers.get(r) ?? 0) + 1);
  }

  const player = playerOf(save);
  probe.endRank = player.isChampion ? 0 : player.ranking;
  console.log(
    `    seed ${seed}: start ${f.save.startDate} end ${save.date} fights ${player.boutIds.length} record ${player.record.wins}-${player.record.losses} rank ${probe.endRank} booked ${player.nextBoutId ?? 'no'} pending ${save.pendingDecision?.kind ?? 'none'}`
  );
  return probe;
}

const probes: Probe[] = [];
for (let i = 0; i < RUNS; i++) probes.push(runOne(7000 + i * 37));

const totalTitleOffers = probes.reduce((s, p) => s + p.titleOffers, 0);
const totalTitleBouts = probes.reduce((s, p) => s + p.titleBouts, 0);
const totalOrdinary = probes.reduce((s, p) => s + p.ordinaryOffers, 0);
const runsWithAShot = probes.filter((p) => p.titleOffers > 0).length;
const runsTopFive = probes.filter((p) => p.bestRank <= 5).length;

console.log(`\nTitle shot probe: ${RUNS} careers of ${YEARS} years each\n`);
console.log(`  careers that reached the top five      ${runsTopFive} of ${RUNS}`);
console.log(`  careers offered a title fight          ${runsWithAShot} of ${RUNS}`);
console.log(`  title offers in total                  ${totalTitleOffers}`);
console.log(`  title bouts appearing in total         ${totalTitleBouts}`);
console.log(`  ordinary offers in total               ${totalOrdinary}`);
console.log(`  best rank reached per career           ${probes.map((p) => p.bestRank).join(', ')}`);
console.log(`  title offers per career                ${probes.map((p) => p.titleOffers).join(', ')}`);
const reachedOne = probes.filter((p) => p.bestRank <= 1);
const reachedThree = probes.filter((p) => p.bestRank <= 3);
console.log(
  `  of careers that reached rank 1         ${reachedOne.filter((p) => p.titleOffers > 0).length} of ${reachedOne.length} got a title shot`
);
console.log(
  `  of careers that reached rank 3         ${reachedThree.filter((p) => p.titleOffers > 0).length} of ${reachedThree.length} got a title shot`
);
console.log(`  weeks ranked top five per career       ${probes.map((p) => p.weeksRankedTopFive).join(', ')}`);
console.log(`  weeks eligible per career              ${probes.map((p) => p.weeksEligible).join(', ')}`);
console.log(`  weeks free and healthy, no offer held  ${probes.map((p) => p.freeWeeks).join(', ')}`);
console.log(`  contracts signed per career           ${probes.map((p) => p.contractsSigned).join(', ')}`);
console.log(`  of those, unwilling to fight           ${probes.map((p) => p.notWillingWeeks).join(', ')}`);
const blockedAll = new Map<string, number>();
for (const p of probes) for (const [k, v] of p.blockedWeeks) blockedAll.set(k, (blockedAll.get(k) ?? 0) + v);
console.log(`\n  Why the player could not be approached at all, per free week:\n`);
for (const [k, v] of [...blockedAll.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(42)} ${v}`);

const combined = new Map<string, number>();
for (const p of probes) {
  for (const [k, v] of p.blockers) combined.set(k, (combined.get(k) ?? 0) + v);
}
console.log(`\n  Why no title fight, counted per contender week:\n`);
for (const [reason, count] of [...combined.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(42)} ${count}`);
}
console.log('');
