import { CALIBRATION as C } from '../config/calibration';
import { BUILDS } from '../config/builds';
import { DIVISION_BY_ID, type DivisionId } from '../config/divisions';
import { clamp, Rng } from '../rng';
import type { FighterId, IsoDate } from '../types/common';
import type { Fighter, Ratings } from '../types/fighter';
import { ageOn } from '../types/common';
import {
  addStatLines,
  emptyStatLine,
  type FightEvent,
  type FightResult,
  type FinishMethod,
  type RoundResult,
  type StrikeAction,
  type SubmissionName,
} from '../types/fight';
import type { SaveSettings } from '../types/save';
import { chooseAction, chooseInitiative, updateTactics, type Decision } from './ai';
import { effective, recoverStamina } from './effective';
import { drawJudges, resolveDecision, scoreRoundForJudge, trueRoundScore, type JudgePersona } from './judging';
import { buildPlanProfile, planCoherence } from './plan';
import {
  resolveClinchEntry,
  resolveDefensiveAction,
  resolveGrapple,
  resolveMovement,
  resolveStandUp,
  resolveStrike,
  resolveSubmission,
  resolveTakedown,
  type ResolveCtx,
  type ResolveOutcome,
} from './resolve';
import {
  freshStats,
  isGroundControlPosition,
  publicPosition,
  resetToStanding,
  startingPosition,
  totalLegDamage,
  zeroDamage,
  type FightSetupSide,
  type FightState,
  type SideState,
} from './state';

export interface FightSimOptions {
  boutId: string;
  eventId: string;
  date: IsoDate;
  divisionId: DivisionId;
  scheduledRounds: 3 | 5;
  isTitleFight: boolean;
  isInterimTitleFight: boolean;
  /** Fighters who forfeited the belt at the weigh in. The engine only records it. */
  titleIneligibleFighterIds: FighterId[];
  contractedWeightLb: number;
  a: FightSetupSide;
  b: FightSetupSide;
  settings: SaveSettings;
  seed: number;
  /**
   * The judges assigned to this bout.
   *
   * Omitted in a bare simulation, in which case three are drawn from the engine's own pool so
   * the simulator stays usable without a save. A real bout always passes the persistent
   * officials, which is what lets a judge accumulate a record.
   */
  judges?: JudgePersona[];
  /** The assigned referee's stoppage tendency. Omitted falls back to a drawn value. */
  refereeTendency?: number;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function experienceBonus(f: Fighter): number {
  const fights = f.record.wins + f.record.losses + f.record.draws;
  const ufc = f.ufcRecord.wins + f.ufcRecord.losses + f.ufcRecord.draws;
  const weighted = fights * 0.4 + ufc * 1.0;
  return C.fight.experienceMax * (1 - Math.exp(-weighted / C.fight.experienceHalfLife));
}

function composureOf(f: Fighter, date: IsoDate): number {
  const age = ageOn(f.birthDate, date) ?? f.ageAtSnapshot ?? 28;
  const distance = Math.abs(age - C.fight.composurePeakAge);
  return clamp(1.6 - distance * 0.18, -1.4, 1.6);
}

function buildSide(
  idx: 0 | 1,
  setup: FightSetupSide,
  opponent: FightSetupSide,
  divisionId: DivisionId,
  date: IsoDate,
  rng: Rng
): SideState {
  const f = setup.fighter;
  const division = DIVISION_BY_ID[divisionId];
  const build = BUILDS[f.build] ?? BUILDS.balanced;

  // Injuries carried into the fight degrade specific capacities.
  const injuryEffects = f.injuries
    .filter((i) => !i.actualReturn)
    .map((i) => ({
      area: i.area,
      penalty: i.severity * 1.9,
      blocksKicks: i.area === 'knee' || i.area === 'ankle' || i.area === 'foot' || i.area === 'hip',
      blocksTakedowns: i.area === 'knee' || i.area === 'back' || i.area === 'shoulder' || i.area === 'hip',
    }));

  // A poor cut costs conditioning and durability on the night. It is applied as a flat
  // effective ability penalty rather than by editing the stored ratings.
  const cutPenalty = setup.cutQuality < 0.5 ? (0.5 - setup.cutQuality) * 2 * C.fight.badCutPenalty : 0;
  const campPenalty = setup.shortNotice ? C.fight.noCampPenalty * (1 - setup.campQuality) : (1 - setup.campQuality) * 2.4;

  const base: Ratings = { ...f.ratings };
  const coherence = planCoherence(setup.gamePlan);

  const heightMe = f.heightIn ?? division.priors.heightIn.mean;
  const heightOpp = opponent.fighter.heightIn ?? division.priors.heightIn.mean;
  const reachMe = f.reachIn ?? heightMe + 1.8;
  const reachOpp = opponent.fighter.reachIn ?? heightOpp + 1.8;

  const plan = buildPlanProfile(f.tendencies, setup.gamePlan);

  return {
    idx,
    id: f.id,
    fighter: f,
    base,
    tendencies: f.tendencies,
    gamePlan: setup.gamePlan,
    division,
    stamina: C.stamina.max * clamp(0.9 + setup.campQuality * 0.1 - (setup.shortNotice ? 0.08 : 0), 0.7, 1),
    damage: zeroDamage(),
    stunSecondsRemaining: 0,
    knockdownsTaken: 0,
    knockdownsScored: 0,
    unansweredAgainst: 0,
    vulnerableSecondsRemaining: 0,
    reachAdvantage: reachMe - reachOpp,
    heightAdvantage: heightMe - heightOpp,
    sharpness: clamp(setup.sharpness, 0, 1),
    tacticalFamiliarity: clamp(setup.tacticalFamiliarity * coherence, 0, 1),
    experienceBonus: experienceBonus(f),
    // Form on the night. A wide gap in ability should still leave room for an upset,
    // because in this sport it always does.
    nightForm: rng.normalClamped(0, 4.2, -12, 12),
    cutPenalty,
    campPenalty,
    injuryEffects,
    composure: composureOf(f, date),
    powerFactor: division.powerFactor * build.leverage,
    fatigueFactor: division.fatigueFactor * build.fatigue * plan.staminaMult,
    plan,
    aggression: plan.pressure,
    paceTarget: plan.pace,
    wantsGround: plan.takedown > 0.5,
    wantsDistance: plan.distance > plan.pressure,
    protectingLead: false,
    desperate: false,
    roundStats: freshStats(),
    fightStats: freshStats(),
    pointDeductions: 0,
    fouls: 0,
    finishedBy: null,
  };
}

/** The single damage figure used for scoring: head, then body, then legs, weighted. */
export function damageScalar(d: Parameters<typeof totalLegDamage>[0]): number {
  return d.head + d.body * 0.5 + totalLegDamage(d) * 0.4;
}

export function setupFight(opts: FightSimOptions): { state: FightState; rng: Rng; judges: JudgePersona[] } {
  const rng = new Rng(opts.seed);
  const a = buildSide(0, opts.a, opts.b, opts.divisionId, opts.date, rng);
  const b = buildSide(1, opts.b, opts.a, opts.divisionId, opts.date, rng);
  // The pool draw always happens, even when officials are supplied, so that assigning real
  // judges consumes exactly the same rng as drawing anonymous ones. Skipping it shifted every
  // subsequent draw and changed fight outcomes across the whole world.
  const drawn = drawJudges(rng);
  const judges = opts.judges && opts.judges.length === 3 ? opts.judges : drawn;
  const state: FightState = {
    a,
    b,
    position: startingPosition(),
    round: 1,
    clock: C.round.seconds,
    scheduledRounds: opts.scheduledRounds,
    seq: 0,
    over: false,
    // The drawn value is still consumed even when a referee is assigned, so passing officials
    // in cannot shift the rest of the simulation off its seeded path.
    refereeTendency: (() => {
      const drawn = rng.normalClamped(1, C.stoppage.refereeTendencySd, 0.65, 1.4);
      return opts.refereeTendency ?? drawn;
    })(),
    totalSeconds: 0,
  };
  updateTactics(state, a, rng);
  updateTactics(state, b, rng);
  return { state, rng, judges };
}

// ---------------------------------------------------------------------------
// Stoppage evaluation
// ---------------------------------------------------------------------------

interface StoppageVerdict {
  method: FinishMethod;
  winnerIdx: 0 | 1;
  finishingStrike?: StrikeAction;
}

/**
 * Referee judgement after a damaging sequence. Considers accumulated damage, unanswered
 * clean strikes, whether the fighter is intelligently defending, position and the
 * referee's own tendency. It is not a single dice roll on a knockdown.
 */
function checkStoppage(st: FightState, rng: Rng, lastEvent: FightEvent | undefined): StoppageVerdict | null {
  for (const side of [st.a, st.b] as SideState[]) {
    const attacker = side.idx === 0 ? st.b : st.a;
    const hurt = side.stunSecondsRemaining > 0 || side.vulnerableSecondsRemaining > 0;

    // Immediate knockout from a single devastating shot on an already compromised head.
    if (lastEvent && lastEvent.tags.includes('knockdown') && lastEvent.defenderId === side.id) {
      const severity = lastEvent.damage.head;
      const durability = effective(st, side, 'strike-defense', { bonus: side.base.durability - side.base.striking });
      const koChance = clamp(
        (severity / 34) * 0.085 * st.refereeTendency * (1 + side.damage.head / 150) * clamp(1 - (durability - 65) * 0.012, 0.4, 1.8),
        0,
        0.7
      );
      if (rng.chance(koChance)) {
        return {
          method: 'ko',
          winnerIdx: attacker.idx,
          finishingStrike: lastEvent.action.kind === 'strike' ? lastEvent.action.name : undefined,
        };
      }
    }

    if (!hurt) continue;
    if (side.unansweredAgainst < C.stoppage.unansweredThreshold) continue;

    const extra = side.unansweredAgainst - C.stoppage.unansweredThreshold;
    const damageFactor = clamp(side.damage.head / C.damage.headStoppageThreshold, 0, 1.6);
    const defenseFactor = clamp((effective(st, side, 'strike-defense') - 55) / 60, -0.4, 0.5);
    const onGround = st.position.zone === 'ground' && st.position.controller === attacker.idx;

    let p =
      (C.stoppage.baseCheck + extra * C.stoppage.perExtraStrike) *
      st.refereeTendency *
      (0.45 + damageFactor) *
      (1 - defenseFactor) *
      (onGround ? 1.25 : 1);
    if (side.stamina < 25) p *= 1.25;
    p = clamp(p, 0, 0.95);

    if (rng.chance(p)) {
      return {
        method: onGround ? 'tko-ground-strikes' : 'tko-strikes',
        winnerIdx: attacker.idx,
        finishingStrike: lastEvent && lastEvent.action.kind === 'strike' ? lastEvent.action.name : undefined,
      };
    }
  }
  return null;
}

/** Between round medical and corner decisions. */
function checkBetweenRounds(st: FightState, rng: Rng): StoppageVerdict | null {
  for (const side of [st.a, st.b] as SideState[]) {
    const attacker = side.idx === 0 ? st.b : st.a;
    if (side.damage.cut >= C.damage.cutStoppageThreshold) {
      const p = clamp(C.stoppage.doctorBase * (side.damage.cut / C.damage.cutStoppageThreshold) * st.refereeTendency, 0, 0.85);
      if (rng.chance(p)) return { method: 'doctor-stoppage', winnerIdx: attacker.idx };
    }
    const beaten = side.damage.head > 85 && side.stamina < 40;
    if (beaten) {
      const p = clamp(C.stoppage.cornerBase * (side.damage.head / 100), 0, 0.6);
      if (rng.chance(p)) return { method: 'corner-stoppage', winnerIdx: attacker.idx };
    }
    const legs = totalLegDamage(side.damage);
    if (legs > 62 || side.damage.joint > 30 || side.damage.body > 78) {
      const p = clamp(C.stoppage.retirementBase * (Math.max(legs / 70, side.damage.joint / 34, side.damage.body / 80)), 0, 0.5);
      if (rng.chance(p)) return { method: 'retirement', winnerIdx: attacker.idx };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fouls
// ---------------------------------------------------------------------------

type FoulKind = 'eye-poke' | 'groin-strike' | 'illegal-knee' | 'fence-grab' | 'back-of-head';

function maybeFoul(st: FightState, rng: Rng, actor: SideState): { kind: FoulKind; deduct: boolean } | null {
  const base = 0.0035 * (1 + actor.plan.pace * 0.4);
  if (!rng.chance(base)) return null;
  const kinds: FoulKind[] =
    st.position.zone === 'ground'
      ? ['back-of-head', 'illegal-knee', 'fence-grab', 'eye-poke']
      : ['eye-poke', 'groin-strike', 'fence-grab', 'back-of-head'];
  const kind = rng.pick(kinds);
  actor.fouls++;
  const deduct = actor.fouls >= 2 && rng.chance(0.5);
  return { kind, deduct };
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export interface RoundEndInfo {
  round: number;
  result: RoundResult;
  fightOver: boolean;
}

export class FightSimulator {
  readonly opts: FightSimOptions;
  readonly state: FightState;
  readonly rng: Rng;
  readonly judges: JudgePersona[];
  readonly events: FightEvent[] = [];
  readonly rounds: RoundResult[] = [];
  private judgeCards: { a: number; b: number }[][] = [[], [], []];
  private finish: StoppageVerdict | null = null;
  private submissionName: SubmissionName | null = null;
  private finishingStrike: StrikeAction | null = null;
  /** Damage already on each fighter when the current round opened, so a round can be scored on
   * the damage inflicted inside it rather than on the whole fight so far. */
  private roundOpenDamageOnA = 0;
  private roundOpenDamageOnB = 0;
  private roundAggressionA = 0;
  private roundAggressionB = 0;
  private roundCageA = 0;
  private roundCageB = 0;
  private endTimeSeconds = 0;
  private endRound = 1;
  private result: FightResult | null = null;

  constructor(opts: FightSimOptions) {
    this.opts = opts;
    const { state, rng, judges } = setupFight(opts);
    this.state = state;
    this.rng = rng;
    this.judges = judges;
  }

  get isOver(): boolean {
    return this.state.over;
  }

  private ctx(): ResolveCtx {
    return {
      st: this.state,
      rng: this.rng,
      push: (e) => {
        const full: FightEvent = { ...e, seq: this.state.seq++ };
        this.events.push(full);
      },
    };
  }

  /** Advances the fight by exactly one action. Returns the events produced. */
  step(): FightEvent[] {
    if (this.state.over) return [];
    const before = this.events.length;
    const st = this.state;
    const actor = chooseInitiative(st, this.rng);
    const decision = chooseAction(st, actor, this.rng);
    const outcome = this.dispatch(actor, decision);
    this.advanceClock(actor, outcome.timeUsed);

    // Fouls are emitted after the clock advances so the event stream stays in strict
    // descending clock order for the live text view.
    const foul = maybeFoul(st, this.rng, actor);
    if (foul) {
      const opponent = actor.idx === 0 ? st.b : st.a;
      if (foul.deduct) {
        actor.pointDeductions++;
        opponent.roundStats.fouls++;
      }
      this.ctx().push({
        round: st.round,
        clockSecondsRemaining: Math.max(0, Math.round(st.clock)),
        actorId: actor.id,
        defenderId: opponent.id,
        stateBefore: publicPosition(st.position, actor.idx),
        action: { kind: 'referee', name: foul.deduct ? 'point-deduction' : 'warning' },
        result: 'no-effect',
        stateAfter: publicPosition(st.position, actor.idx),
        damage: zeroDamage(),
        staminaCost: 0,
        scoreImpact: 0,
        importance: foul.deduct ? 'major' : 'notable',
        tags: ['foul', foul.kind],
      });
      st.clock -= C.timeCost.refereeAction;
      st.totalSeconds += C.timeCost.refereeAction;
    }

    if (outcome.finish) {
      this.finish = { method: outcome.finish.method, winnerIdx: outcome.finish.winnerIdx };
      if (outcome.finish.submissionName) this.submissionName = outcome.finish.submissionName;
      if (outcome.finish.finishingStrike) this.finishingStrike = outcome.finish.finishingStrike;
      this.endFight();
      return this.events.slice(before);
    }

    const stoppage = checkStoppage(st, this.rng, this.events[this.events.length - 1]);
    if (stoppage) {
      this.finish = stoppage;
      if (stoppage.finishingStrike) this.finishingStrike = stoppage.finishingStrike;
      this.emitFinishEvent(stoppage);
      this.endFight();
      return this.events.slice(before);
    }

    this.refereeMaintenance();

    if (st.clock <= 0) {
      this.closeRound();
    }
    return this.events.slice(before);
  }

  private dispatch(actor: SideState, dec: Decision): ResolveOutcome {
    const ctx = this.ctx();
    switch (dec.action.kind) {
      case 'strike':
        return resolveStrike(ctx, actor, dec);
      case 'wrestle': {
        const name = dec.action.name;
        if (name === 'stand-up' || name === 'wall-walk') return resolveStandUp(ctx, actor, dec);
        if (name === 'underhook-defense' || name === 'sprawl' || name === 'whizzer') {
          return resolveDefensiveAction(ctx, actor, { ...dec, action: { kind: 'defense', name: 'block' } });
        }
        if (this.state.position.zone === 'standing' && name === 'body-lock' && dec.rangeIntent === -1) {
          return resolveClinchEntry(ctx, actor);
        }
        return resolveTakedown(ctx, actor, dec);
      }
      case 'grapple':
        return resolveGrapple(ctx, actor, dec);
      case 'submission':
        return resolveSubmission(ctx, actor, dec);
      case 'movement':
        return resolveMovement(ctx, actor, dec);
      case 'defense':
        return resolveDefensiveAction(ctx, actor, dec);
      case 'referee':
        return { timeUsed: C.timeCost.refereeAction, finish: null };
    }
  }

  private advanceClock(actor: SideState, seconds: number): void {
    const st = this.state;
    const used = Math.max(0.5, seconds);
    st.clock -= used;
    st.totalSeconds += used;
    st.position.heldSeconds += used;

    const opponent = actor.idx === 0 ? st.b : st.a;

    // Control time accounting follows the position, not who acted.
    if (isGroundControlPosition(st.position)) {
      const controller = st.position.controller === 0 ? st.a : st.b;
      controller.roundStats.controlSeconds += used;
      controller.fightStats.controlSeconds += used;
      controller.roundStats.groundControlSeconds += used;
      controller.fightStats.groundControlSeconds += used;
    } else if (st.position.zone === 'clinch') {
      const controller = st.position.controller === 0 ? st.a : st.b;
      controller.roundStats.controlSeconds += used * 0.7;
      controller.fightStats.controlSeconds += used * 0.7;
      controller.roundStats.clinchControlSeconds += used;
      controller.fightStats.clinchControlSeconds += used;
    }

    // Aggression and cage control tracking for the third judging criterion.
    if (actor.idx === 0) this.roundAggressionA += actor.aggression * used * 0.02;
    else this.roundAggressionB += actor.aggression * used * 0.02;
    if (st.position.zone === 'standing' && st.position.range !== 'long') {
      if (actor.plan.pressure > opponent.plan.pressure) {
        if (actor.idx === 0) this.roundCageA += used * 0.02;
        else this.roundCageB += used * 0.02;
      }
    }

    const intensity = st.position.zone === 'ground' ? 0.55 : st.position.zone === 'clinch' ? 0.7 : 0.45;
    recoverStamina(st.a, used, st.a === actor ? intensity + 0.2 : intensity);
    recoverStamina(st.b, used, st.b === actor ? intensity + 0.2 : intensity);

    for (const side of [st.a, st.b]) {
      side.stunSecondsRemaining = Math.max(0, side.stunSecondsRemaining - used);
      side.vulnerableSecondsRemaining = Math.max(0, side.vulnerableSecondsRemaining - used);
      side.damage.balance = Math.max(0, side.damage.balance - used * 0.7);
      // Unanswered strikes only count while the sequence is continuous. A fighter who
      // survives a flurry and gets moving again is no longer one shot from a stoppage.
      if (side.stunSecondsRemaining <= 0 && side.vulnerableSecondsRemaining <= 0) {
        side.unansweredAgainst = Math.max(0, side.unansweredAgainst - used * 0.6);
      }
    }
  }

  /** Referee stand ups and letting a downed fighter back up. */
  private refereeMaintenance(): void {
    const st = this.state;
    const pos = st.position;
    if (pos.downedIdx !== null) {
      const downed = pos.downedIdx === 0 ? st.a : st.b;
      if (downed.stunSecondsRemaining <= 0 && downed.vulnerableSecondsRemaining <= 0) {
        pos.downedIdx = null;
        // Whoever scored the knockdown decides whether to follow or let them up.
        const attacker = downed.idx === 0 ? st.b : st.a;
        if (!attacker.wantsGround && this.rng.chance(0.6)) {
          resetToStanding(pos, 'boxing');
        }
      }
      return;
    }
    if (pos.inactivitySeconds >= C.grappling.inactivityStandUpSeconds && pos.zone !== 'standing') {
      const controller = pos.controller === 0 ? st.a : st.b;
      const other = controller.idx === 0 ? st.b : st.a;
      this.ctx().push({
        round: st.round,
        clockSecondsRemaining: Math.max(0, Math.round(st.clock)),
        actorId: controller.id,
        defenderId: other.id,
        stateBefore: publicPosition(pos, controller.idx),
        action: { kind: 'referee', name: 'stand-up' },
        result: 'completed',
        stateAfter: 'standing-reset',
        damage: zeroDamage(),
        staminaCost: 0,
        scoreImpact: 0,
        importance: 'notable',
        tags: ['referee', 'stand-up'],
      });
      resetToStanding(pos, 'boxing');
      st.clock -= C.timeCost.refereeAction;
      st.totalSeconds += C.timeCost.refereeAction;
    }
  }

  private emitFinishEvent(v: StoppageVerdict): void {
    const st = this.state;
    const winner = v.winnerIdx === 0 ? st.a : st.b;
    const loser = v.winnerIdx === 0 ? st.b : st.a;
    this.ctx().push({
      round: st.round,
      clockSecondsRemaining: Math.max(0, Math.round(st.clock)),
      actorId: winner.id,
      defenderId: loser.id,
      stateBefore: publicPosition(st.position, winner.idx),
      action: { kind: 'referee', name: 'timeout' },
      result: 'completed',
      stateAfter: publicPosition(st.position, winner.idx),
      damage: zeroDamage(),
      staminaCost: 0,
      scoreImpact: 0,
      importance: 'decisive',
      tags: ['finish', v.method],
    });
  }

  private endFight(): void {
    const st = this.state;
    st.over = true;
    this.endRound = st.round;
    this.endTimeSeconds = Math.max(1, Math.round(C.round.seconds - Math.max(0, st.clock)));
    this.closeRound(true);
  }

  private closeRound(finished = false): void {
    const st = this.state;
    // Damage dealt in THIS round. The stat lines are reset every round, but the damage pools are
    // not, so passing the raw pools mixed a per round measure with a whole fight measure and let
    // damage from round one keep scoring rounds three, four and five.
    const damageOnBNow = damageScalar(st.b.damage);
    const damageOnANow = damageScalar(st.a.damage);
    const input = {
      statsA: st.a.roundStats,
      statsB: st.b.roundStats,
      // By the shared convention, damageA is the damage A inflicted.
      damageA: Math.max(0, damageOnBNow - this.roundOpenDamageOnB),
      damageB: Math.max(0, damageOnANow - this.roundOpenDamageOnA),
      aggressionA: this.roundAggressionA,
      aggressionB: this.roundAggressionB,
      cageControlA: this.roundCageA,
      cageControlB: this.roundCageB,
    };
    const trueScore = trueRoundScore(input);

    // A round cut short by a finish is not scored by the judges.
    if (!finished) {
      this.judges.forEach((judge, i) => {
        this.judgeCards[i].push(scoreRoundForJudge(judge, input, trueScore, this.rng, this.opts.settings));
      });
    }

    let keyMoment: number | null = null;
    let bestImportance = -1;
    const rank = { trivial: 0, minor: 1, notable: 2, major: 3, decisive: 4 } as const;
    for (const e of this.events) {
      if (e.round !== st.round) continue;
      if (rank[e.importance] > bestImportance) {
        bestImportance = rank[e.importance];
        keyMoment = e.seq;
      }
    }

    this.rounds.push({
      round: st.round,
      statsA: { ...st.a.roundStats },
      statsB: { ...st.b.roundStats },
      trueScoreA: trueScore,
      trueScoreB: -trueScore,
      damageEndA: { ...st.a.damage },
      damageEndB: { ...st.b.damage },
      staminaEndA: st.a.stamina,
      staminaEndB: st.b.stamina,
      summary: '',
      keyMomentSeq: keyMoment,
      endedFight: finished,
    });

    if (finished) return;

    // Between round recovery and medical checks.
    const between = checkBetweenRounds(st, this.rng);
    if (between) {
      this.finish = between;
      this.emitFinishEvent(between);
      st.over = true;
      this.endRound = st.round;
      this.endTimeSeconds = C.round.seconds;
      return;
    }

    if (st.round >= st.scheduledRounds) {
      st.over = true;
      this.endRound = st.round;
      this.endTimeSeconds = C.round.seconds;
      return;
    }

    for (const side of [st.a, st.b]) {
      const missing = C.stamina.max - side.stamina;
      const cardioScale = 0.6 + (side.base.cardio / 100) * 0.8;
      const damagePenalty = 1 - clamp(side.damage.body * C.stamina.bodyDamageRecoveryPenalty, 0, 0.6);
      side.stamina = clamp(side.stamina + missing * C.stamina.betweenRoundRecovery * cardioScale * damagePenalty, 0, C.stamina.max);
      side.damage.head *= 1 - C.damage.recovery.head;
      side.damage.body *= 1 - C.damage.recovery.body;
      side.damage.legLeft *= 1 - C.damage.recovery.leg;
      side.damage.legRight *= 1 - C.damage.recovery.leg;
      side.damage.balance *= 1 - C.damage.recovery.balance;
      side.stunSecondsRemaining = 0;
      side.vulnerableSecondsRemaining = 0;
      side.unansweredAgainst = 0;
      side.roundStats = emptyStatLine();
    }

    st.round++;
    st.clock = C.round.seconds;
    // The damage window reopens after between round recovery has been applied.
    this.roundOpenDamageOnA = damageScalar(st.a.damage);
    this.roundOpenDamageOnB = damageScalar(st.b.damage);
    resetToStanding(st.position, 'long');
    this.roundAggressionA = 0;
    this.roundAggressionB = 0;
    this.roundCageA = 0;
    this.roundCageB = 0;
    updateTactics(st, st.a, this.rng);
    updateTactics(st, st.b, this.rng);
  }

  /** Runs the current round to its end. */
  simulateRound(): RoundEndInfo {
    const target = this.state.round;
    let guard = 0;
    while (!this.state.over && this.state.round === target && guard++ < 4000) {
      this.step();
    }
    return {
      round: target,
      result: this.rounds[this.rounds.length - 1],
      fightOver: this.state.over,
    };
  }

  /** Runs to the end of the fight and returns the finished result. */
  run(): FightResult {
    let guard = 0;
    while (!this.state.over && guard++ < 40000) this.step();
    return this.buildResult();
  }

  buildResult(): FightResult {
    if (this.result) return this.result;
    const st = this.state;
    const opts = this.opts;
    let method: FinishMethod;
    let winnerId: string | null = null;
    let loserId: string | null = null;
    let scorecards: FightResult['scorecards'] = [];

    if (this.finish) {
      method = this.finish.method;
      winnerId = this.finish.winnerIdx === 0 ? st.a.id : st.b.id;
      loserId = this.finish.winnerIdx === 0 ? st.b.id : st.a.id;
    } else {
      const decision = resolveDecision(this.judges, this.judgeCards, st.a.pointDeductions, st.b.pointDeductions);
      method = decision.method;
      scorecards = decision.scorecards;
      if (decision.winner === 'a') {
        winnerId = st.a.id;
        loserId = st.b.id;
      } else if (decision.winner === 'b') {
        winnerId = st.b.id;
        loserId = st.a.id;
      }
      this.endRound = st.scheduledRounds;
      this.endTimeSeconds = C.round.seconds;
    }

    const totalsA = this.rounds.reduce((acc, r) => addStatLines(acc, r.statsA ?? emptyStatLine()), emptyStatLine());
    const totalsB = this.rounds.reduce((acc, r) => addStatLines(acc, r.statsB ?? emptyStatLine()), emptyStatLine());

    const longevityCostA = computeLongevityCost(st.a, st.b, method, winnerId === st.a.id, opts);
    const longevityCostB = computeLongevityCost(st.b, st.a, method, winnerId === st.b.id, opts);

    const quality = computeFightQuality(totalsA, totalsB, this.rounds.length, method);

    this.result = {
      boutId: opts.boutId,
      eventId: opts.eventId,
      date: opts.date,
      fighterAId: st.a.id,
      fighterBId: st.b.id,
      winnerId,
      loserId,
      method,
      submissionName: this.submissionName,
      finishingStrike: this.finishingStrike,
      endRound: this.endRound,
      endTimeSeconds: this.endTimeSeconds,
      scheduledRounds: opts.scheduledRounds,
      divisionId: opts.divisionId,
      isTitleFight: opts.isTitleFight,
      isInterimTitleFight: opts.isInterimTitleFight,
      titleIneligibleFighterIds: opts.titleIneligibleFighterIds,
      contractedWeightLb: opts.contractedWeightLb,
      rounds: this.rounds,
      totalsA,
      totalsB,
      scorecards,
      pointDeductionsA: st.a.pointDeductions,
      pointDeductionsB: st.b.pointDeductions,
      events: this.events,
      finalDamageA: { ...st.a.damage },
      finalDamageB: { ...st.b.damage },
      finalStaminaA: st.a.stamina,
      finalStaminaB: st.b.stamina,
      longevityCostA,
      longevityCostB,
      injuriesA: [],
      injuriesB: [],
      performanceBonusIds: [],
      fightOfTheNight: false,
      fightQuality: quality,
      narrativeSummary: '',
      seed: opts.seed,
    };
    return this.result;
  }
}

function computeLongevityCost(
  side: SideState,
  opponent: SideState,
  method: FinishMethod,
  won: boolean,
  opts: FightSimOptions
): number {
  const L = C.longevity;
  let cost = 0;
  cost += side.damage.head * L.perHeadDamage;
  cost += side.knockdownsTaken * L.perKnockdown;
  cost += side.damage.body * L.perBodyDamage;
  cost += totalLegDamage(side.damage) * L.perLegDamage;
  cost += side.damage.joint * L.perJointDamage;
  cost += side.damage.cut * L.perCut * 0.1;
  if (!won && (method === 'ko' || method === 'tko-strikes' || method === 'tko-ground-strikes')) {
    cost += L.perKoLoss;
  }
  if (opts.scheduledRounds === 5) {
    cost += L.perChampionshipRound * 2;
  }
  // A resilient fighter absorbs the same damage at a lower long term price.
  cost /= clamp(side.fighter.development.resilience, 0.6, 1.4);
  void opponent;
  return Math.max(0, cost);
}

function computeFightQuality(
  a: ReturnType<typeof emptyStatLine>,
  b: ReturnType<typeof emptyStatLine>,
  rounds: number,
  method: FinishMethod
): number {
  const minutes = Math.max(1, rounds * 5);
  const pace = (a.sigStrikesLanded + b.sigStrikesLanded) / minutes;
  const drama = (a.knockdowns + b.knockdowns) * 12 + (a.submissionAttempts + b.submissionAttempts) * 7;
  const balance = 1 - Math.abs(a.sigStrikesLanded - b.sigStrikesLanded) / Math.max(12, a.sigStrikesLanded + b.sigStrikesLanded);
  const finishBonus = method === 'ko' ? 22 : method === 'tko-strikes' || method === 'tko-ground-strikes' ? 16 : method === 'submission' ? 18 : 0;
  return clamp(pace * 3.1 + drama + balance * 22 + finishBonus, 0, 100);
}

/** One shot instant simulation. */
export function simulateFight(opts: FightSimOptions): FightResult {
  return new FightSimulator(opts).run();
}
