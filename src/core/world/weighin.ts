import { DIVISION_BY_ID } from '../config/divisions';
import { clamp, hashString, Rng } from '../rng';
import { addDays, daysBetween, type BoutId, type FighterId, type IsoDate } from '../types/common';
import { isChampionshipBout } from '../types/fight';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { healthyCutFor, simulateWeightCut } from './health';
import { addHypeMoment, hypeStore } from './hype';
import { completeStage, openSecondAttempt } from './fightweek';
import { cancelBout } from './matchmaking';

/**
 * The weigh in as a playable sequence.
 *
 * The scale reading itself stays deterministic: it is drawn once from the same weight cut
 * model the rest of the game uses, stored, and then revealed a step at a time. What is new
 * is that the player sees it happen and decides what to do about a miss, rather than the
 * whole thing resolving invisibly inside a calendar advance.
 */

export type WeighInStage =
  | 'not-started'
  | 'player-approaching'
  | 'player-revealed'
  | 'opponent-approaching'
  | 'opponent-revealed'
  | 'second-attempt-decision'
  | 'catchweight-negotiation'
  | 'opponent-decision'
  | 'ruling'
  | 'complete';

export const WEIGH_IN_STAGE_LABEL: Record<WeighInStage, string> = {
  'not-started': 'Waiting to begin',
  'player-approaching': 'Approaching the scale',
  'player-revealed': 'Your official weight',
  'opponent-approaching': 'The opponent steps up',
  'opponent-revealed': 'The opponent official weight',
  'second-attempt-decision': 'Second attempt decision',
  'catchweight-negotiation': 'Catchweight negotiation',
  'opponent-decision': 'The other camp decides',
  ruling: 'Commission ruling',
  complete: 'Weigh in complete',
};

export interface WeighInReading {
  fighterId: FighterId;
  weightLb: number;
  madeWeight: boolean;
  overBy: number;
  cutQuality: number;
  attempt: number;
}

export interface WeighInState {
  boutId: BoutId;
  date: IsoDate;
  stage: WeighInStage;
  limitLb: number;
  /** The strict divisional limit, before any non title allowance. */
  divisionLimitLb: number;
  allowanceLb: number;
  isChampionship: boolean;
  player: WeighInReading | null;
  opponent: WeighInReading | null;
  secondAttemptOffered: boolean;
  secondAttemptTaken: boolean;
  purseForfeitPct: number;
  forfeitAmount: number;
  /** Fighters who forfeited their claim on the belt. */
  ineligible: FighterId[];
  catchweightLb: number | null;
  boutStatus: 'scheduled' | 'catchweight' | 'canceled';
  rulingText: string | null;
  mediaLine: string | null;
  log: string[];
}

/** What the player should know before fight week, shown on the camp and fight week pages. */
export interface WeighInForecast {
  currentWeightLb: number;
  targetLb: number;
  remainingLb: number;
  difficulty: 'routine' | 'manageable' | 'hard' | 'severe' | 'not realistic';
  hydrationRisk: string;
  nutritionSupport: string;
  previousMisses: number;
  allowanceLb: number;
  titleEligible: boolean;
  opponentTargetLb: number;
  expectedArrivalLb: number;
}

export function forecast(save: SaveGame, boutId: BoutId): WeighInForecast | null {
  const bout = save.bouts[boutId];
  const meId = save.player.fighterId;
  if (!bout || !meId) return null;
  const me = save.fighters[meId];
  if (!me) return null;
  const division = DIVISION_BY_ID[bout.divisionId];
  const championship = isChampionshipBout(bout);
  const target = bout.contractedWeightLb;
  const remaining = Math.max(0, me.walkingWeightLb - target);
  const age = me.ageAtSnapshot ?? 28;
  const healthy = healthyCutFor(me, age);
  const ratio = remaining / Math.max(6, healthy);
  const gym = me.gymId ? save.gyms[me.gymId] : null;
  const hasNutrition = Boolean(gym?.staffIds.some((id) => save.staff[id]?.role === 'nutrition'));

  return {
    currentWeightLb: Math.round(me.walkingWeightLb * 10) / 10,
    targetLb: target,
    remainingLb: Math.round(remaining * 10) / 10,
    difficulty: ratio < 0.65 ? 'routine' : ratio < 0.85 ? 'manageable' : ratio < 1.0 ? 'hard' : ratio < 1.2 ? 'severe' : 'not realistic',
    hydrationRisk:
      ratio < 0.7
        ? 'Low. This is a normal week.'
        : ratio < 0.95
          ? 'Moderate. Expect to feel it on the day.'
          : 'High. The team is concerned about how you will rehydrate.',
    nutritionSupport: hasNutrition ? 'A nutritionist is working with the camp.' : 'No dedicated nutrition support in this camp.',
    previousMisses: me.weightMisses,
    allowanceLb: championship ? 0 : division.nonTitleAllowanceLb,
    titleEligible: championship,
    opponentTargetLb: target,
    expectedArrivalLb: Math.round((target + Math.max(0, remaining * 0.12)) * 10) / 10,
  };
}

function readingFor(save: SaveGame, bout: { id: BoutId; divisionId: string; contractedWeightLb: number; isTitleFight: boolean; isInterimTitleFight: boolean }, fighter: Fighter, attempt: number, rng: Rng): WeighInReading {
  const camp = Object.values(save.camps).find((c) => c.fighterId === fighter.id && c.boutId === bout.id);
  const gym = fighter.gymId ? save.gyms[fighter.gymId] : null;
  const cut = simulateWeightCut(
    fighter,
    {
      divisionId: bout.divisionId as never,
      isTitleFight: isChampionshipBout(bout),
      campWeeks: camp?.weeksCompleted ?? 7,
      nutritionSupport: gym?.staffIds.some((id) => save.staff[id]?.role === 'nutrition') ? 0.9 : 0.5,
      shortNotice: false,
      // A second attempt is a harder, more aggressive push in the last hour.
      aggressiveness: attempt > 1 ? 0.95 : 0.5,
    },
    save.date,
    rng
  );
  const over = Math.max(0, Math.round((cut.weightLb - bout.contractedWeightLb) * 2) / 2);
  return {
    fighterId: fighter.id,
    weightLb: cut.weightLb,
    madeWeight: cut.madeWeight,
    overBy: over,
    cutQuality: cut.cutQuality,
    attempt,
  };
}

/** Deterministic seed so the same weigh in reproduces exactly. */
export function weighInRng(save: SaveGame, boutId: BoutId, attempt: number): Rng {
  return new Rng(hashString(`weighin-${boutId}-${attempt}-${save.seed}`));
}

/** Creates the state, or returns the existing one. Never regenerates a resolved weigh in. */
export function beginWeighIn(save: SaveGame, boutId: BoutId): WeighInState | null {
  if (!save.weighIns) save.weighIns = {};
  const existing = save.weighIns[boutId];
  if (existing) return existing;
  const bout = save.bouts[boutId];
  if (!bout || bout.status !== 'scheduled') return null;
  const meId = save.player.fighterId;
  if (!meId) return null;
  const division = DIVISION_BY_ID[bout.divisionId];
  const championship = isChampionshipBout(bout);

  const state: WeighInState = {
    boutId,
    date: save.date,
    stage: 'player-approaching',
    limitLb: bout.contractedWeightLb,
    divisionLimitLb: division.limitLb,
    allowanceLb: championship ? 0 : division.nonTitleAllowanceLb,
    isChampionship: championship,
    player: null,
    opponent: null,
    secondAttemptOffered: false,
    secondAttemptTaken: false,
    purseForfeitPct: 0,
    forfeitAmount: 0,
    ineligible: [],
    catchweightLb: null,
    boutStatus: 'scheduled',
    rulingText: null,
    mediaLine: null,
    log: [`Official weigh in for ${bout.contractedWeightLb} lb.`],
  };
  save.weighIns[boutId] = state;
  return state;
}

/** Advances one visible step. Each call moves exactly one stage. */
export function stepWeighIn(save: SaveGame, boutId: BoutId): WeighInState | null {
  const state = save.weighIns?.[boutId];
  const bout = save.bouts[boutId];
  const meId = save.player.fighterId;
  if (!state || !bout || !meId) return state ?? null;
  const me = save.fighters[meId];
  const opponent = save.fighters[bout.fighterAId === meId ? bout.fighterBId : bout.fighterAId];
  if (!me || !opponent) return state;

  switch (state.stage) {
    case 'player-approaching': {
      const reading = readingFor(save, bout, me, 1, weighInRng(save, boutId, 1));
      state.player = reading;
      state.stage = 'player-revealed';
      state.log.push(
        reading.madeWeight
          ? `${me.name} weighs in at ${reading.weightLb} lb. On the limit.`
          : `${me.name} weighs in at ${reading.weightLb} lb, ${reading.overBy} over.`
      );
      // Applying the miss to the fighter record happens once, here.
      if (!reading.madeWeight) me.weightMisses++;
      return state;
    }
    case 'player-revealed': {
      state.stage = 'opponent-approaching';
      return state;
    }
    case 'opponent-approaching': {
      const reading = readingFor(save, bout, opponent, 1, weighInRng(save, boutId, 2));
      state.opponent = reading;
      state.stage = 'opponent-revealed';
      state.log.push(
        reading.madeWeight
          ? `${opponent.name} weighs in at ${reading.weightLb} lb. On the limit.`
          : `${opponent.name} weighs in at ${reading.weightLb} lb, ${reading.overBy} over.`
      );
      if (!reading.madeWeight) opponent.weightMisses++;
      return state;
    }
    case 'opponent-revealed': {
      const playerMissed = state.player && !state.player.madeWeight;
      const opponentMissed = state.opponent && !state.opponent.madeWeight;
      if (playerMissed && !state.secondAttemptOffered && (state.player?.overBy ?? 0) <= 2) {
        state.secondAttemptOffered = true;
        state.stage = 'second-attempt-decision';
        openSecondAttempt(save, boutId);
        state.log.push('The commission offers one more hour to make the weight.');
        return state;
      }
      if (opponentMissed && !playerMissed) {
        state.stage = 'opponent-decision';
        return state;
      }
      state.stage = 'ruling';
      return state;
    }
    case 'ruling': {
      applyRuling(save, state, me, opponent);
      state.stage = 'complete';
      return state;
    }
    default:
      return state;
  }
}

export type SecondAttemptChoice = 'try-again' | 'stop-cutting' | 'accept-miss' | 'request-catchweight' | 'offer-larger-forfeit' | 'withdraw-medical';

export interface SecondAttemptOption {
  key: SecondAttemptChoice;
  label: string;
  detail: string;
  risk: string | null;
}

export function secondAttemptOptions(state: WeighInState): SecondAttemptOption[] {
  const over = state.player?.overBy ?? 0;
  const options: SecondAttemptOption[] = [
    {
      key: 'try-again',
      label: 'Go back and try again',
      detail: `One more hour to lose ${over} lb. If you make it, everything is normal.`,
      risk: 'Arriving badly depleted has a real cost on fight night.',
    },
    {
      key: 'accept-miss',
      label: 'Accept the miss',
      detail: 'Take the forfeit and fight at catchweight if the other side agrees.',
      risk: 'You cannot win the title in this bout.',
    },
    {
      key: 'stop-cutting',
      label: 'Stop cutting entirely',
      detail: 'Rehydrate now and take whatever ruling comes.',
      risk: 'The commission and the promotion will both take a view.',
    },
  ];
  if (state.isChampionship) {
    options.push({
      key: 'offer-larger-forfeit',
      label: 'Offer a larger purse forfeit',
      detail: 'Give up more of the purse to keep the other camp on board.',
      risk: 'It costs real money and does not restore title eligibility.',
    });
  }
  options.push({
    key: 'request-catchweight',
    label: 'Ask for a catchweight',
    detail: 'Formally request the bout be rewritten at the weight you can make.',
    risk: 'The other camp can refuse and the bout is off.',
  });
  options.push({
    key: 'withdraw-medical',
    label: 'Withdraw on medical advice',
    detail: 'Pull out rather than push the cut any further.',
    risk: 'The bout is canceled and the relationship suffers.',
  });
  return options;
}

/** Applies the second attempt decision. */
export function applySecondAttempt(save: SaveGame, boutId: BoutId, choice: SecondAttemptChoice): WeighInState | null {
  const state = save.weighIns?.[boutId];
  const bout = save.bouts[boutId];
  const meId = save.player.fighterId;
  if (!state || !bout || !meId) return state ?? null;
  const me = save.fighters[meId];
  const opponent = save.fighters[bout.fighterAId === meId ? bout.fighterBId : bout.fighterAId];
  if (!me || !opponent) return state;
  state.secondAttemptTaken = true;

  switch (choice) {
    case 'try-again': {
      const reading = readingFor(save, bout, me, 2, weighInRng(save, boutId, 3));
      state.player = reading;
      state.log.push(
        reading.madeWeight
          ? `${me.name} comes back and makes ${reading.weightLb} lb on the second attempt.`
          : `${me.name} comes back at ${reading.weightLb} lb and is still ${reading.overBy} over.`
      );
      if (reading.madeWeight) {
        // The earlier miss is undone: they made the weight in the end.
        me.weightMisses = Math.max(0, me.weightMisses - 1);
      } else {
        // A hard second cut leaves a mark whatever the number says.
        me.wear.weightCut = clamp(me.wear.weightCut + 4, 0, 100);
      }
      break;
    }
    case 'stop-cutting':
      state.log.push(`${me.name} stops cutting and takes the miss.`);
      me.wear.weightCut = clamp(me.wear.weightCut - 2, 0, 100);
      break;
    case 'accept-miss':
      state.log.push(`${me.name} accepts the miss.`);
      break;
    case 'offer-larger-forfeit':
      // The offer is made to the other camp, which is the only thing that can keep the bout
      // together. It used to set the higher forfeit and fall straight through to the ruling, so
      // the other camp was never asked, nothing about the bout changed, and the extra ten percent
      // of the show purse bought the player precisely nothing.
      state.purseForfeitPct = 30;
      state.log.push(`${me.name} offers a larger share of the purse to keep the bout together.`);
      state.stage = 'catchweight-negotiation';
      state.catchweightLb = Math.ceil(state.player?.weightLb ?? state.limitLb);
      return state;
    case 'request-catchweight':
      state.stage = 'catchweight-negotiation';
      state.catchweightLb = Math.ceil(state.player?.weightLb ?? state.limitLb);
      return state;
    case 'withdraw-medical': {
      state.boutStatus = 'canceled';
      state.rulingText = `${me.name} withdrew on medical advice rather than continue the cut. The bout is off.`;
      state.stage = 'complete';
      state.log.push(state.rulingText);
      // This returns before the finalisation that cancels the bout, so it has to cancel it here.
      // Setting only the local status told the player the fight was off and then left it
      // scheduled, and they fought on the night anyway.
      const record = save.bouts[boutId];
      if (record && record.status === 'scheduled') cancelBout(save, record, state.rulingText);
      return state;
    }
  }
  state.stage = 'ruling';
  return state;
}

/** The other camp's answer to a catchweight request or to their own opponent missing. */
export function resolveOpponentDecision(save: SaveGame, boutId: BoutId, rng: Rng): WeighInState | null {
  const state = save.weighIns?.[boutId];
  const bout = save.bouts[boutId];
  const meId = save.player.fighterId;
  if (!state || !bout || !meId) return state ?? null;
  const me = save.fighters[meId];
  const opponent = save.fighters[bout.fighterAId === meId ? bout.fighterBId : bout.fighterAId];
  if (!me || !opponent) return state;

  const over = state.player?.overBy ?? 0;
  // A small miss with a forfeit is usually accepted. A large one often is not.
  const acceptChance = clamp(0.92 - over * 0.14 + state.purseForfeitPct / 120, 0.05, 0.97);
  const accepts = rng.chance(acceptChance);
  if (accepts) {
    state.boutStatus = 'catchweight';
    state.catchweightLb = Math.ceil(state.player?.weightLb ?? state.limitLb);
    state.log.push(`${opponent.name} agrees to the catchweight at ${state.catchweightLb} lb.`);
  } else {
    state.boutStatus = 'canceled';
    state.log.push(`${opponent.name} refuses the catchweight. The bout is off.`);
  }
  state.stage = 'ruling';
  return state;
}

/** The player's answer when the opponent is the one who missed. */
export function acceptOpponentMiss(save: SaveGame, boutId: BoutId, accept: boolean): WeighInState | null {
  const state = save.weighIns?.[boutId];
  const bout = save.bouts[boutId];
  const meId = save.player.fighterId;
  if (!state || !bout || !meId) return state ?? null;
  const opponent = save.fighters[bout.fighterAId === meId ? bout.fighterBId : bout.fighterAId];
  if (accept) {
    state.boutStatus = 'catchweight';
    state.catchweightLb = Math.ceil(state.opponent?.weightLb ?? state.limitLb);
    // The fighter who missed forfeits a share of their purse to the one who made weight.
    state.purseForfeitPct = Math.min(30, 10 + (state.opponent?.overBy ?? 0) * 5);
    state.log.push(`The bout goes ahead at ${state.catchweightLb} lb with a purse forfeit.`);
  } else {
    state.boutStatus = 'canceled';
    state.log.push(`${opponent?.name ?? 'The opponent'} missed weight and the bout was declined. It is off.`);
  }
  state.stage = 'ruling';
  return state;
}

function applyRuling(save: SaveGame, state: WeighInState, me: Fighter, opponent: Fighter): void {
  const boutRecord = save.bouts[state.boutId];
  if (!boutRecord) return;

  // Record both readings on the bout so the fight engine and the fight page agree.
  const playerIsA = boutRecord.fighterAId === me.id;
  if (state.player) {
    const w = { madeWeight: state.player.madeWeight, weightLb: state.player.weightLb, cutQuality: state.player.cutQuality };
    if (playerIsA) boutRecord.weighInA = w;
    else boutRecord.weighInB = w;
  }
  if (state.opponent) {
    const w = { madeWeight: state.opponent.madeWeight, weightLb: state.opponent.weightLb, cutQuality: state.opponent.cutQuality };
    if (playerIsA) boutRecord.weighInB = w;
    else boutRecord.weighInA = w;
  }
  me.lastWeightCutQuality = state.player?.cutQuality ?? me.lastWeightCutQuality;
  opponent.lastWeightCutQuality = state.opponent?.cutQuality ?? opponent.lastWeightCutQuality;

  const ineligible: FighterId[] = [];
  if (state.player && !state.player.madeWeight) ineligible.push(me.id);
  if (state.opponent && !state.opponent.madeWeight) ineligible.push(opponent.id);
  state.ineligible = ineligible;

  if (state.boutStatus === 'canceled') {
    state.rulingText = state.rulingText ?? 'The bout has been canceled.';
    // The ruling has to actually cancel the bout. Setting only the local status told the player
    // the fight was off and then left it scheduled, so it went ahead on fight night anyway.
    // cancelBout owns the booking pointers, the event card, the camps and the inbox messages.
    if (boutRecord.status === 'scheduled') {
      cancelBout(save, boutRecord, state.rulingText);
    }
    return;
  }

  if (ineligible.length > 0) {
    boutRecord.isCatchweight = true;
    boutRecord.titleIneligibleFighterIds = ineligible;
    if (state.catchweightLb) boutRecord.contractedWeightLb = state.catchweightLb;
    // The forfeit is applied once, to the fighter who missed.
    const pct = state.purseForfeitPct > 0 ? state.purseForfeitPct : 20;
    if (ineligible.includes(me.id)) {
      const purse = playerIsA ? boutRecord.purseA : boutRecord.purseB;
      state.forfeitAmount = Math.round((purse.show * pct) / 100);
      const reduced = { ...purse, show: purse.show - state.forfeitAmount };
      if (playerIsA) boutRecord.purseA = reduced;
      else boutRecord.purseB = reduced;
    }
    if (ineligible.includes(opponent.id)) {
      const purse = playerIsA ? boutRecord.purseB : boutRecord.purseA;
      const amount = Math.round((purse.show * pct) / 100);
      const reduced = { ...purse, show: purse.show - amount };
      if (playerIsA) boutRecord.purseB = reduced;
      else boutRecord.purseA = reduced;
      // The forfeit goes to the fighter who made weight. It was deducted from the fighter who
      // missed and then went nowhere, so accepting the bout cost the player the inconvenience and
      // paid them nothing for it.
      if (!ineligible.includes(me.id)) {
        const mine = playerIsA ? boutRecord.purseA : boutRecord.purseB;
        const paid = { ...mine, show: mine.show + amount };
        if (playerIsA) boutRecord.purseA = paid;
        else boutRecord.purseB = paid;
        state.log.push(`The forfeited purse share of ${amount} is added to ${me.name}'s show money.`);
      }
    }
  }

  state.boutStatus = ineligible.length > 0 ? 'catchweight' : 'scheduled';
  const belt = state.isChampionship ? (boutRecord.isTitleFight ? 'title' : 'interim title') : null;
  state.rulingText = !belt
    ? ineligible.length === 0
      ? 'Both fighters made weight. The bout is confirmed.'
      : `The bout goes ahead at catchweight. ${ineligible.map((id) => save.fighters[id]?.name ?? 'A fighter').join(' and ')} forfeited part of the purse.`
    : ineligible.length === 0
      ? `Both fighters made weight. The ${belt} is on the line for both.`
      : ineligible.length === 2
        ? `Both fighters missed weight. The ${belt} is not on the line for either of them.`
        : `The ${belt} is on the line only for ${save.fighters[ineligible.includes(me.id) ? opponent.id : me.id]?.name ?? 'the fighter who made weight'}.`;

  // Media and hype react to what happened on the scale.
  const hype = hypeStore(save)[state.boutId];
  if (hype) {
    const delta = ineligible.length > 0 ? -4 : 2;
    hype.total = clamp(hype.total + delta, 0, 100);
    addHypeMoment(save, state.boutId, ineligible.length > 0 ? 'A missed weight at the official weigh in' : 'Both fighters made weight cleanly', delta);
  }
  state.mediaLine =
    ineligible.length === 0
      ? 'The weigh in passes without incident and the build moves to fight night.'
      : 'The missed weight leads the coverage and the reaction online is unkind.';

  // The fight week task is closed once, here.
  completeStage(save, `fw-${state.boutId}-official-weigh-in`, state.rulingText);
}

/** True when the weigh in still needs the player before the calendar may move. */
export function weighInBlocks(save: SaveGame, boutId: BoutId): boolean {
  const state = save.weighIns?.[boutId];
  if (!state) return false;
  return state.stage !== 'complete';
}

/** Drops weigh in records for bouts long finished. */
export function pruneWeighIns(save: SaveGame, keepDays = 400): number {
  if (!save.weighIns) return 0;
  let removed = 0;
  for (const id of Object.keys(save.weighIns)) {
    const bout = save.bouts[id];
    if (!bout || (bout.status !== 'scheduled' && daysBetween(bout.date, save.date) > keepDays)) {
      delete save.weighIns[id];
      removed++;
    }
  }
  return removed;
}

/** Ceremonial weigh in and faceoff happen the same day; this is the date they fall on. */
export function ceremonialDate(bout: { date: IsoDate }): IsoDate {
  return addDays(bout.date, -1);
}
