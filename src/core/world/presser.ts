import { hashString, Rng } from '../rng';
import { daysBetween, type BoutId, type IsoDate } from '../types/common';
import type { Fighter } from '../types/fighter';
import type { SaveGame } from '../types/save';
import { findRivalry, hypeStore, addHypeMoment } from './hype';
import { TONE_LABEL, type SocialEffects, type SocialTone } from './social';

/**
 * Press conferences and media obligations.
 *
 * Questions are composed from templates selected by context tags rather than written out,
 * and answers are composed from tone keyed fragment banks. A press conference is several
 * questions with genuinely different replies, not one button, and the same question does
 * not come round again while it is still in the recent history.
 */

export type PresserContextTag =
  | 'title-fight'
  | 'interim-title'
  | 'main-event'
  | 'short-notice'
  | 'coming-off-loss'
  | 'win-streak'
  | 'rivalry'
  | 'trash-talk'
  | 'weight-questions'
  | 'injury-rumor'
  | 'camp-change'
  | 'gym-conflict'
  | 'contract-dispute'
  | 'judging-controversy'
  | 'callout'
  | 'social-post'
  | 'fan-criticism'
  | 'retirement-rumor'
  | 'division-change'
  | 'champion-inactivity'
  | 'missed-weight'
  | 'teammate-history'
  | 'debut'
  | 'ranked-opponent'
  | 'unranked-opponent'
  | 'age-questions'
  | 'home-crowd';

export interface PresserQuestion {
  id: string;
  askedBy: string;
  text: string;
  tags: PresserContextTag[];
  answers: PresserAnswer[];
  selectedKey: string | null;
  reaction: string | null;
}

export interface PresserAnswer {
  key: string;
  tone: SocialTone;
  label: string;
  text: string;
  risk: string | null;
  effects: SocialEffects;
}

export interface PresserSession {
  id: string;
  boutId: BoutId;
  date: IsoDate;
  kind: 'press-conference' | 'media-day' | 'post-fight-interview' | 'post-fight-press';
  questions: PresserQuestion[];
  status: 'open' | 'complete';
  summary: string | null;
}

const REPORTERS = [
  'a reporter from the front row',
  'a broadcast analyst',
  'a writer from a combat sports site',
  'a podcast host',
  'a wire service reporter',
  'a local television reporter',
  'a fan with a microphone',
  'a magazine columnist',
];

interface QuestionTemplate {
  key: string;
  tags: PresserContextTag[];
  applies: (c: PresserContext) => boolean;
  text: (c: PresserContext) => string;
  tones: SocialTone[];
  weight?: number;
}

export interface PresserContext {
  save: SaveGame;
  me: Fighter;
  opponent: Fighter | null;
  eventName: string;
  eventDate: IsoDate;
  boutId: BoutId;
  isTitle: boolean;
  isInterim: boolean;
  isMainEvent: boolean;
  shortNotice: boolean;
  rivalry: number;
  streak: number;
  lossStreak: number;
  weightMisses: number;
  daysSinceLastFight: number | null;
  opponentRanked: boolean;
  homeCrowd: boolean;
  rng: Rng;
}

function fill(text: string, c: PresserContext): string {
  return text
    .replace(/\{opp\}/g, c.opponent?.name ?? 'your opponent')
    .replace(/\{oppLast\}/g, c.opponent?.lastName ?? 'him')
    .replace(/\{me\}/g, c.me.name)
    .replace(/\{event\}/g, c.eventName)
    .replace(/\{date\}/g, c.eventDate);
}

const QUESTIONS: QuestionTemplate[] = [
  {
    key: 'q-title-meaning',
    tags: ['title-fight'],
    applies: (c) => c.isTitle,
    text: () => 'You have talked about this belt for years. What does it actually change if you win it on Saturday?',
    tones: ['emotional', 'confident', 'honest', 'promotional'],
    weight: 3,
  },
  {
    key: 'q-interim-legitimacy',
    tags: ['interim-title'],
    applies: (c) => c.isInterim,
    text: () => 'Some people say an interim belt is not a real belt. What do you say to them?',
    tones: ['confident', 'aggressive', 'honest', 'dismissive'],
    weight: 3,
  },
  {
    key: 'q-short-notice',
    tags: ['short-notice'],
    applies: (c) => c.shortNotice,
    text: () => 'You took this on short notice. Realistically, how much of a camp did you actually get?',
    tones: ['honest', 'confident', 'funny', 'dismissive'],
    weight: 3,
  },
  {
    key: 'q-after-loss',
    tags: ['coming-off-loss'],
    applies: (c) => c.lossStreak > 0,
    text: (c) => `You are coming off a loss${c.lossStreak > 1 ? ', two in a row now' : ''}. How much pressure is on you here?`,
    tones: ['honest', 'confident', 'emotional', 'dismissive', 'evasive'],
    weight: 3,
  },
  {
    key: 'q-streak',
    tags: ['win-streak'],
    applies: (c) => c.streak >= 3,
    text: (c) => `${c.streak} in a row. Do you feel like the division is taking you seriously yet?`,
    tones: ['confident', 'respectful', 'aggressive', 'honest'],
    weight: 2,
  },
  {
    key: 'q-rivalry-origin',
    tags: ['rivalry'],
    applies: (c) => c.rivalry > 35,
    text: (c) => `This has clearly become personal with ${c.opponent?.name ?? 'your opponent'}. When did it stop being just a fight?`,
    tones: ['aggressive', 'honest', 'dismissive', 'emotional', 'controversial'],
    weight: 3,
  },
  {
    key: 'q-trash-talk-response',
    tags: ['trash-talk'],
    applies: (c) => c.rivalry > 20,
    text: (c) => `${c.opponent?.name ?? 'Your opponent'} has said some things this week. Any of it get to you?`,
    tones: ['dismissive', 'aggressive', 'funny', 'respectful', 'silent'],
    weight: 2,
  },
  {
    key: 'q-weight',
    tags: ['weight-questions'],
    applies: (c) => c.weightMisses > 0 || c.rng.chance(0.35),
    text: (c) =>
      c.weightMisses > 0
        ? 'You have missed weight before. Where are you at right now?'
        : 'How is the weight looking with a day to go?',
    tones: ['confident', 'honest', 'technical', 'evasive'],
    weight: 2,
  },
  {
    key: 'q-injury-rumor',
    tags: ['injury-rumor'],
    applies: (c) => c.me.injuries.some((i) => i.actualReturn === null),
    text: () => 'There have been rumors about camp being interrupted. Is there anything to that?',
    tones: ['dismissive', 'honest', 'evasive', 'confident'],
    weight: 2,
  },
  {
    key: 'q-camp-change',
    tags: ['camp-change'],
    applies: (c) => Boolean(c.me.gymId) && c.rng.chance(0.25),
    text: () => 'You made changes in camp for this one. What was not working before?',
    tones: ['technical', 'honest', 'evasive', 'confident'],
  },
  {
    key: 'q-judging',
    tags: ['judging-controversy'],
    applies: (c) => c.rng.chance(0.3),
    text: () => 'There has been a lot of noise about judging in this division. Does that affect how you fight?',
    tones: ['technical', 'honest', 'controversial', 'dismissive'],
  },
  {
    key: 'q-callout',
    tags: ['callout'],
    applies: () => true,
    text: () => 'Assume you win. Who do you want next, and why that name?',
    tones: ['confident', 'respectful', 'aggressive', 'promotional', 'evasive'],
    weight: 2,
  },
  {
    key: 'q-social-post',
    tags: ['social-post'],
    applies: (c) => c.rng.chance(0.4),
    text: () => 'You posted something this week that got a reaction. Do you stand by it?',
    tones: ['confident', 'honest', 'funny', 'controversial', 'evasive'],
  },
  {
    key: 'q-fan-criticism',
    tags: ['fan-criticism'],
    applies: (c) => (c.me.fame?.favorability ?? 50) < 45,
    text: () => 'A section of the fanbase has been hard on you lately. Does that register at all?',
    tones: ['honest', 'dismissive', 'emotional', 'funny'],
  },
  {
    key: 'q-retirement',
    tags: ['retirement-rumor'],
    applies: (c) => (c.me.longevity ?? 100) < 45 || (c.me.ageAtSnapshot ?? 30) > 37,
    text: () => 'How many of these do you have left in you?',
    tones: ['honest', 'confident', 'emotional', 'dismissive'],
  },
  {
    key: 'q-division-change',
    tags: ['division-change'],
    applies: (c) => c.me.eligibleDivisions.length > 1,
    text: () => 'There has been talk of you moving weight class. Is that on the table?',
    tones: ['honest', 'evasive', 'confident', 'technical'],
  },
  {
    key: 'q-champion-inactive',
    tags: ['champion-inactivity'],
    applies: (c) => {
      const table = c.save.rankings[c.me.divisionId];
      const champ = table?.championId ? c.save.fighters[table.championId] : null;
      return Boolean(champ) && champ!.id !== c.me.id && (champ!.lastFightDate ? daysBetween(champ!.lastFightDate, c.save.date) > 300 : false);
    },
    text: () => 'The champion has not fought in a long time. Is that a problem for the division?',
    tones: ['honest', 'aggressive', 'respectful', 'controversial'],
  },
  {
    key: 'q-teammate',
    tags: ['teammate-history'],
    applies: (c) => Boolean(c.opponent?.gymId) && c.opponent?.gymId === c.me.gymId,
    text: (c) => `You and ${c.opponent?.name ?? 'your opponent'} have trained together. How strange is this week?`,
    tones: ['respectful', 'honest', 'emotional', 'technical'],
    weight: 3,
  },
  {
    key: 'q-ranked-opponent',
    tags: ['ranked-opponent'],
    applies: (c) => c.opponentRanked && !c.isTitle,
    text: (c) => `A win over ${c.opponent?.name ?? 'him'} puts you right in the picture. Are you looking past this one?`,
    tones: ['respectful', 'confident', 'dismissive', 'honest'],
  },
  {
    key: 'q-unranked-opponent',
    tags: ['unranked-opponent'],
    applies: (c) => !c.opponentRanked && !c.isTitle,
    text: (c) => `Some people are saying this is a step down for you. Is ${c.opponent?.name ?? 'he'} being underrated?`,
    tones: ['respectful', 'confident', 'dismissive', 'technical'],
  },
  {
    key: 'q-age',
    tags: ['age-questions'],
    applies: (c) => (c.me.ageAtSnapshot ?? 30) > 34,
    text: () => 'You have a lot of miles on you. Do you feel any different than you did five years ago?',
    tones: ['honest', 'confident', 'funny', 'emotional'],
  },
  {
    key: 'q-home-crowd',
    tags: ['home-crowd'],
    applies: (c) => c.homeCrowd,
    text: () => 'Fighting close to home. Does the crowd help or does it add weight?',
    tones: ['emotional', 'confident', 'honest', 'promotional'],
    weight: 2,
  },
  {
    key: 'q-game-plan',
    tags: [],
    applies: () => true,
    text: (c) => `Where do you think this fight is won? Where does ${c.opponent?.name ?? 'he'} break?`,
    tones: ['technical', 'confident', 'evasive', 'aggressive'],
    weight: 2,
  },
  {
    key: 'q-main-event-pressure',
    tags: ['main-event'],
    applies: (c) => c.isMainEvent,
    text: () => 'You are carrying the card. Does headlining feel different?',
    tones: ['confident', 'honest', 'promotional', 'emotional'],
  },
  {
    key: 'q-missed-weight-opponent',
    tags: ['missed-weight'],
    applies: (c) => (c.opponent?.weightMisses ?? 0) > 0,
    text: (c) => `${c.opponent?.name ?? 'Your opponent'} has missed weight before. Does that change how you prepare?`,
    tones: ['technical', 'dismissive', 'aggressive', 'honest'],
  },
  {
    key: 'q-contract',
    tags: ['contract-dispute'],
    applies: (c) => {
      const contract = c.me.contractId ? c.save.contracts[c.me.contractId] : null;
      return Boolean(contract && contract.fightsRemaining <= 1);
    },
    text: () => 'This is the last fight on your deal. Where does that leave you?',
    tones: ['honest', 'evasive', 'confident', 'controversial'],
    weight: 2,
  },
];

/**
 * Answers are keyed on the question, not only on the tone.
 *
 * Drawing every answer from one generic bank produced sessions where a question about the
 * rankings was answered with a line about an injury. Each question archetype now supplies
 * its own answers per tone, and a semantic test asserts every question has a compatible
 * answer for every tone it offers.
 */
const QUESTION_ANSWERS: Record<string, Partial<Record<SocialTone, string[]>>> = {
  'q-title-meaning': {
    emotional: ['Everything. I have thought about holding that belt since I was a kid, and it is one night away now.', 'It changes what my family has been through for ten years. That is what it changes.'],
    confident: ['It changes nothing about how I fight. It changes what the division has to deal with afterwards.', 'It puts the belt where it should have been two years ago.'],
    honest: ['Honestly, it will not fix anything in my life. I still want it more than anything.', 'It is validation. I am not going to pretend it is not.'],
    promotional: ['It gives this division a champion who will actually defend it. Tune in and see.', 'Buy the card. You are going to see a new champion.'],
  },
  'q-interim-legitimacy': {
    confident: ['It is the belt they put in front of me. I will unify it and then it stops being a question.', 'Call it what you like. I am beating whoever they put there next.'],
    aggressive: ['Say that to me when I am wearing it and the champion is still on the shelf.', 'The champion is not fighting. I am. That is the difference between us.'],
    honest: ['It is not the same and I know that. It is still the fight in front of me.', 'I would rather have the real one. This is the road to it.'],
    dismissive: ['Not something I am going to argue about at a table.', 'People say a lot of things.'],
  },
  'q-short-notice': {
    honest: ['Three weeks. I was in the gym anyway, but three weeks is three weeks.', 'Not much of one. I stayed ready and that is the only reason I could take it.'],
    confident: ['Enough. I do not need twelve weeks to beat him.', 'I have been in camp all year. This is just the last stretch.'],
    funny: ['I got a camp. It was very short. Almost theoretical.', 'My nutritionist has aged five years this month.'],
    dismissive: ['It does not matter. Next question.', 'Short notice is part of the job.'],
  },
  'q-after-loss': {
    honest: ['A lot. I lost, and there is no way to talk around that. I have looked at why.', 'The pressure is real and I would rather have it than not be here at all.'],
    confident: ['None. I know what went wrong and it does not happen twice.', 'Pressure is for people who are not sure.'],
    emotional: ['It was the hardest few months of my career. I am still here.', 'I had to sit with that one for a long time.'],
    dismissive: ['I am not carrying it into Saturday. It is done.', 'Everybody loses. Next question.'],
    evasive: ['I would rather talk about this fight.', 'That is behind me.'],
  },
  'q-streak': {
    confident: ['They will take me seriously on Saturday night whether they want to or not.', 'The results speak. I do not need to be taken seriously, I need the next fight.'],
    respectful: ['Every one of those was a hard night against a good fighter. I am proud of it.', 'The division is deep. That run means something to me.'],
    aggressive: ['They can take me seriously or they can get moved out of the way.', 'I have run out of patience waiting to be taken seriously.'],
    honest: ['Some of them were closer than the record makes them look.', 'I think I am ranked about where I should be. I want more.'],
  },
  'q-rivalry-origin': {
    aggressive: ['It stopped being just a fight the moment he brought my family into it.', 'He knows exactly when. So do I.'],
    honest: ['It got personal and I let it. That is on both of us.', 'There is history there that has nothing to do with fighting.'],
    dismissive: ['It is not personal for me. He can carry it if he wants.', 'I do not think about him outside of work.'],
    emotional: ['Some things you cannot let go of. This is one of them.', 'It has cost me sleep. I will settle it Saturday.'],
    controversial: ['Ask him why he stopped answering his phone after the first one.', 'Everyone in this room knows what he did and nobody will print it.'],
  },
  'q-trash-talk-response': {
    dismissive: ['I have not read any of it.', 'He can say what he likes. It does not change the matchup.'],
    aggressive: ['He will say it all week and then say nothing for fifteen minutes on Saturday.', 'Every word he says is another reason to hurt him.'],
    funny: ['Some of it was actually funny. Most of it needed an editor.', 'I gave it a six out of ten.'],
    respectful: ['It is part of selling a fight. I have no problem with him.', 'He is doing his job. I will do mine.'],
    silent: ['No comment.'],
  },
  'q-weight': {
    confident: ['On track. I will be on the number tomorrow.', 'The weight has been the easiest part of this camp.'],
    honest: ['It has been harder than last time. I will make it, but it has been work.', 'A few pounds to go and it is under control.'],
    technical: ['We started the descent earlier this camp and it has been steadier for it.', 'The plan has me arriving with less to take off in the last day.'],
    evasive: ['It is handled.', 'You will see the number tomorrow like everyone else.'],
  },
  'q-injury-rumor': {
    dismissive: ['There is nothing to it.', 'Somebody made that up. Camp was fine.'],
    honest: ['There was a week where we pulled back. It was managed and it is behind us.', 'Every camp has something. Nothing that changes Saturday.'],
    evasive: ['I am not going to get into camp details.', 'I am here and I am fighting.'],
    confident: ['If I was hurt I would not be sitting here.', 'I am the healthiest I have been in two years.'],
  },
  'q-camp-change': {
    technical: ['We changed the sparring schedule and brought in different looks. The old plan had gone stale.', 'More positional work, fewer hard rounds. The last camp cost me too much before I got there.'],
    honest: ['I was not getting what I needed. It was time.', 'Some hard conversations happened and the camp is better for it.'],
    evasive: ['Internal stuff. I would rather leave it there.', 'Nothing worth talking about publicly.'],
    confident: ['You will see the difference on Saturday.', 'It was the right call and I am sharper for it.'],
  },
  'q-judging': {
    technical: ['You fight to leave no doubt. That is the only answer to judging.', 'I score rounds on damage. If I do damage the cards look after themselves.'],
    honest: ['It is in the back of your mind late in a close round. I would rather finish.', 'Yes, it affects how I fight the third round. Anyone who says otherwise is lying.'],
    controversial: ['The judging in this division has cost people their careers and nobody has answered for it.', 'Half these cards are a lottery and we all pretend otherwise.'],
    dismissive: ['Not my problem. I finish fights.', 'I do not think about the judges.'],
  },
  'q-callout': {
    confident: ['The winner of the title fight. That is the only name I am interested in.', 'Whoever is holding the belt when I am done here.'],
    respectful: ['Anyone in the top five. They have all earned it, I am not calling anybody out by name.', 'I will take whoever the matchmaker thinks deserves it.'],
    aggressive: ['I want the one who has been avoiding me. He knows his name.', 'Give me the champion. If he says no, give me anyone who will actually show up.'],
    promotional: ['Give the fans the fight they have been asking for. They know the one.', 'The biggest name available. That is what sells.'],
    evasive: ['One at a time. Ask me on Sunday.', 'I have not thought past Saturday.'],
  },
  'q-social-post': {
    confident: ['Every word.', 'I said it because it is true. I am not walking it back.'],
    honest: ['It came out sharper than I meant it. The point behind it stands.', 'I posted it angry. I would word it differently now.'],
    funny: ['I stand by the typo as well.', 'My manager has taken my phone off me. It is a whole situation.'],
    controversial: ['I stand by it and I will say it again on Saturday with the microphone in my hand.', 'Somebody had to say it. Nobody else in this room will.'],
    evasive: ['It speaks for itself.', 'I am not going to relitigate a post at a press conference.'],
  },
  'q-fan-criticism': {
    honest: ['Some of it is fair. I have had performances I would not pay to watch either.', 'It registers. I would be lying if I said it did not.'],
    dismissive: ['I do not fight for people typing at midnight.', 'No. Not even slightly.'],
    emotional: ['It hurts more than people think. You give your whole life to this.', 'I read it and I use it.'],
    funny: ['I have read worse about myself from my own coach.', 'They should hear my mother after a decision loss.'],
  },
  'q-retirement': {
    honest: ['I do not know. A few good ones. I will know when I know.', 'Less than there were. That is why every one of these matters now.'],
    confident: ['Plenty. I feel better than I did at thirty.', 'As many as I want. I am not close to done.'],
    emotional: ['I think about it more than I used to. Then I get in the gym and forget about it.', 'One day it will be the last one. Not this one.'],
    dismissive: ['Not a question for tonight.', 'Ask me when I lose.'],
  },
  'q-division-change': {
    honest: ['It is on the table. The cut has been getting harder every year.', 'We have talked about it seriously. Nothing is decided.'],
    evasive: ['One fight at a time.', 'I am at this weight on Saturday. That is all I know.'],
    confident: ['If I move it will be to take a second belt, not to escape anything.', 'I could make this weight for another three years if I wanted to.'],
    technical: ['The numbers say I have two or three more camps at this limit before it stops being sensible.', 'It is a conversation about recovery, not about size.'],
  },
  'q-champion-inactive': {
    honest: ['It holds everybody up. That is just true.', 'It is frustrating for the whole division, him included probably.'],
    aggressive: ['Defend it or give it up. Those are the options.', 'He is holding a belt hostage and everyone is being polite about it.'],
    respectful: ['He has earned the right to take his time. I would still like the fight.', 'I am not going to criticise a champion for looking after himself.'],
    controversial: ['They will not strip him because he sells. Say the quiet part.', 'There is one set of rules for him and another for the rest of us.'],
  },
  'q-teammate': {
    respectful: ['Strange is the word. He is a good man and Saturday does not change that.', 'We have shared too many hard rounds for me to say anything bad about him.'],
    honest: ['It is uncomfortable. We both knew it might happen one day.', 'Neither of us wanted this fight. Here we are.'],
    emotional: ['He carried me through a camp when I had nothing left. Now I have to fight him.', 'This is the hardest week of my career and the fight has not started.'],
    technical: ['He knows my habits and I know his. That cancels out and it comes down to the night.', 'Familiarity helps both of us. It is a clean slate once it starts.'],
  },
  'q-ranked-opponent': {
    respectful: ['Not for a second. He beats me if I look past him and we both know it.', 'He is ranked there for a reason.'],
    confident: ['I am looking at Saturday. What comes after takes care of itself.', 'I am aware of what a win does. It does not change the plan.'],
    dismissive: ['I have already seen everything he does.', 'He is a name on a poster.'],
    honest: ['Of course I know what it does for me. I am still worried about him.', 'You cannot help thinking about it. You just cannot let it in.'],
  },
  'q-unranked-opponent': {
    respectful: ['He is dangerous and the ranking does not say that. I have prepared like it is a title fight.', 'Everybody in this promotion can end your night.'],
    confident: ['It is the fight in front of me. I take it seriously and I win it.', 'Step down or not, I am fighting on Saturday.'],
    dismissive: ['I do not pick the opponents.', 'That is a question for the matchmaker.'],
    technical: ['He is better than his ranking on the feet. The record does not tell you that.', 'He has beaten two people he had no business beating. That is enough for me.'],
  },
  'q-age': {
    honest: ['I recover slower. Everything else is better. That is the honest answer.', 'The body knows. You just train around it.'],
    confident: ['I feel better than I did at twenty five and I know a lot more.', 'Age is a number that other people worry about.'],
    funny: ['My knees have opinions now that they never used to have.', 'I take longer to warm up than the undercard takes to finish.'],
    emotional: ['I know what this costs now. That makes it mean more.', 'Every one of these is precious at this stage.'],
  },
  'q-home-crowd': {
    emotional: ['I have wanted this my whole career. Fighting at home is everything.', 'My family will be in that building. It is hard to describe.'],
    confident: ['It helps. They will be loud and he will hear it.', 'I like the weight of it. It sharpens you.'],
    honest: ['Both. There is more pressure and there is more behind you.', 'It is not all upside. You feel like you owe people something.'],
    promotional: ['Come out. It is going to be a night this city remembers.', 'Fill the building. I will do the rest.'],
  },
  'q-game-plan': {
    technical: ['He resets on a straight line every time he is pressured. That is where the fight is won.', 'His hands drop after the first hard body shot. That is the tell and that is the plan.'],
    confident: ['Wherever it goes I am better. That is the plan.', 'It is won in the second round when he realises the pace is real.'],
    evasive: ['I am not going to give away the game plan at a table.', 'We have a plan. He will find out about it.'],
    aggressive: ['It is won by hurting him early and not letting him recover.', 'He breaks. Everyone who has pressured him has found that.'],
  },
  'q-main-event-pressure': {
    confident: ['It is where I should have been for two years.', 'The lights do not change the fight.'],
    honest: ['It feels different walking last. Anyone who says otherwise has not done it.', 'There is more on it and I like that.'],
    promotional: ['We are closing the show. Stay up for it.', 'They gave us the main event. We will pay them back for it.'],
    emotional: ['I used to watch main events and wonder if I would ever be in one.', 'This is what all of it was for.'],
  },
  'q-missed-weight-opponent': {
    technical: ['We prepare for the version of him that rehydrates ten pounds heavier. That is the real opponent.', 'It changes the grappling exchanges more than the striking. We have planned for it.'],
    dismissive: ['That is his problem, not mine.', 'I make weight. What he does is his business.'],
    aggressive: ['If he misses again he is stealing from me and I will take it out of him.', 'Miss weight and still lose. That would be the whole story.'],
    honest: ['It is a concern. You cannot plan properly around someone who might be a division bigger.', 'I would rather he made it. It is a cleaner fight.'],
  },
  'q-contract': {
    honest: ['It is the last one, and yes, that is on my mind.', 'I would like to stay. It has to be the right deal.'],
    evasive: ['My manager handles that. I fight.', 'Not something for tonight.'],
    confident: ['I win on Saturday and the deal takes care of itself.', 'They know what I am worth. So do I.'],
    controversial: ['They have known for a year and they have not called. Make of that what you like.', 'I am not going to be the last one to find out what I am worth.'],
  },
};

const ANSWER_BANK: Record<SocialTone, string[]> = {
  respectful: [
    'He has been in there with good people and come through. I am not going to pretend otherwise.',
    'I take every one of these seriously. This one especially.',
    'Credit where it is due. He earned this fight.',
  ],
  confident: [
    'I have done everything I said I would do in camp. That is the whole answer.',
    'I know what happens when we are both in there. I have known for months.',
    'There is nothing he does that I have not already seen and fixed.',
  ],
  aggressive: [
    'He is going to feel the difference in the first two minutes.',
    'Talk is cheap and he has spent all of it. Saturday is the bill.',
    'I am not here to trade rounds. I am here to end it.',
  ],
  funny: [
    'I have been asked that four times today and my answer keeps getting better.',
    'Look, if I knew the future I would be doing something easier for a living.',
    'My coach says I should not answer that, so obviously here I go.',
  ],
  dismissive: [
    'It does not factor into anything I am doing.',
    'I have not thought about it once.',
    'That is a question for people who are not fighting on Saturday.',
  ],
  technical: [
    'It is the second exchange in every sequence. He resets on a straight line and that is where the shot is.',
    'His defense holds up for one round. The tell is the level of his hands after the first hard body shot.',
    'Everything runs through the center. Take that and there is nothing left to run.',
  ],
  emotional: [
    'People have no idea what it took to be sitting at this table.',
    'There are people at home who gave up a lot for me to be here. This is for them.',
    'I have thought about this moment for a long time. I am not letting it go past me.',
  ],
  honest: [
    'It is a hard fight. That is why I wanted it.',
    'I am not going to sit here and tell you it is easy. It is not.',
    'Some of the criticism is fair. I have looked at it and worked on it.',
  ],
  evasive: [
    'We will find out on Saturday.',
    'I would rather let the fight answer it.',
    'That is not something I want to get into here.',
  ],
  promotional: [
    'This is the one you want to watch. Two people who came to finish.',
    'Buy the card. You are not going to see a boring one.',
    'Tell everyone you know. This is the fight of the weekend.',
  ],
  controversial: [
    'Half of the people in this room already know the answer and will not print it.',
    'The rankings are political and everyone at this table knows it.',
    'I said it, I meant it, and I will say it again after I win.',
  ],
  silent: ['No comment.'],
};

const CROWD_RESPONSE: Record<SocialTone, string[]> = {
  respectful: ['A few nods around the room.', 'The opponent gives a short nod back.'],
  confident: ['A ripple of approval from the crowd.', 'The room takes it seriously.'],
  aggressive: ['The room gets loud. The opponent leans into his microphone.', 'A few boos, plenty of noise.'],
  funny: ['Genuine laughter from the back of the room.', 'Even the opponent cracks slightly.'],
  dismissive: ['A short silence, then the next question.', 'Somebody at the back mutters something.'],
  technical: ['The analysts start writing.', 'A couple of reporters look up from their phones.'],
  emotional: ['The room goes quiet for a second.', 'Somebody in the crowd shouts your name.'],
  honest: ['It lands well. Several follow ups.', 'The room respects the answer.'],
  evasive: ['The reporter tries again from another angle.', 'It is noted and moved past.'],
  promotional: ['The promotion is visibly pleased.', 'The camera cuts to the poster.'],
  controversial: ['The room erupts. Somebody from the promotion shifts in their seat.', 'That is the clip that will run tonight.'],
  silent: ['The silence hangs there for a moment.', 'The moderator moves on quickly.'],
};

const EFFECTS: Record<SocialTone, SocialEffects> = {
  respectful: { favorability: 4, mediaReputation: 3, rivalry: -4, hype: 1 },
  confident: { favorability: 2, hype: 4, confidence: 3 },
  aggressive: { hype: 8, controversy: 5, rivalry: 10, opponentFocus: 4, favorability: -2 },
  funny: { favorability: 6, followers: 500, hype: 3, mediaReputation: 2 },
  dismissive: { rivalry: 3, favorability: -2, opponentFocus: 3, hype: -1 },
  technical: { mediaReputation: 5, favorability: 2, hype: 1 },
  emotional: { favorability: 7, followers: 400, hype: 2, confidence: -1 },
  honest: { favorability: 5, mediaReputation: 5 },
  evasive: { mediaReputation: -3, hype: -2 },
  promotional: { hype: 6, promotionRelationship: 6, followers: 250 },
  controversial: { hype: 11, controversy: 12, favorability: -5, fineRisk: 9, sponsorRisk: 8, rivalry: 9 },
  silent: { hype: -3, mediaReputation: -3, favorability: -1 },
};

const RISK: Partial<Record<SocialTone, string>> = {
  controversial: 'High chance of a fine and a sponsor complaint.',
  aggressive: 'Escalates the rivalry. Expect a response at the faceoff.',
  dismissive: 'Reads badly to a section of the audience.',
  silent: 'The promotion notices when you give them nothing.',
  evasive: 'Reporters will keep pushing the same point.',
};

export function buildPresserContext(save: SaveGame, boutId: BoutId, rng: Rng): PresserContext | null {
  const bout = save.bouts[boutId];
  if (!bout) return null;
  const meId = save.player.fighterId;
  if (!meId) return null;
  const me = save.fighters[meId];
  if (!me) return null;
  const opponent = save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] ?? null;
  const event = save.events[bout.eventId];
  const rivalry = opponent ? findRivalry(save, me.id, opponent.id)?.intensity ?? 0 : 0;
  return {
    save,
    me,
    opponent,
    eventName: event?.name ?? 'the card',
    eventDate: bout.date,
    boutId,
    isTitle: bout.isTitleFight,
    isInterim: bout.isInterimTitleFight,
    isMainEvent: bout.isMainEvent,
    shortNotice: daysBetween(bout.bookedOn, bout.date) < 24,
    rivalry,
    streak: me.winStreak,
    lossStreak: me.lossStreak,
    weightMisses: me.weightMisses,
    daysSinceLastFight: me.lastFightDate ? daysBetween(me.lastFightDate, save.date) : null,
    opponentRanked: opponent?.ranking !== null && opponent?.ranking !== undefined,
    homeCrowd: Boolean(event && opponent && event.country === me.country),
    rng,
  };
}

function composeAnswer(tone: SocialTone, c: PresserContext, questionKey: string): PresserAnswer {
  // A question specific answer is always preferred. The generic bank is a fallback only.
  const specific = QUESTION_ANSWERS[questionKey]?.[tone];
  const text = fill(c.rng.pick(specific && specific.length > 0 ? specific : ANSWER_BANK[tone]), c);
  return {
    key: `${questionKey}-${tone}`,
    tone,
    label: TONE_LABEL[tone],
    text,
    risk: RISK[tone] ?? null,
    effects: EFFECTS[tone],
  };
}

/**
 * Builds a session, exactly once per bout and kind.
 *
 * Question selection avoids anything used in a recent session for this fighter, so a
 * career does not hear the same three questions at every press conference.
 */
export function createSession(
  save: SaveGame,
  boutId: BoutId,
  kind: PresserSession['kind'],
  rng: Rng
): PresserSession | null {
  if (!save.pressers) save.pressers = {};
  const id = `presser-${boutId}-${kind}`;
  if (save.pressers[id]) return save.pressers[id];
  const c = buildPresserContext(save, boutId, rng);
  if (!c) return null;

  // Career level history. A question archetype is blocked for ninety days or for the last
  // twenty questions asked, whichever is longer.
  const sessions = Object.values(save.pressers).sort((x, y) => (x.date < y.date ? 1 : -1));
  const recentByDate = sessions.filter((s) => daysBetween(s.date, save.date) < 90).flatMap((s) => s.questions.map((q) => q.id.split('|')[0]));
  const recentByCount = sessions.flatMap((s) => s.questions.map((q) => q.id.split('|')[0])).slice(0, 20);
  const recent = new Set([...recentByDate, ...recentByCount]);

  const eligible = QUESTIONS.filter((q) => {
    try {
      return q.applies(c);
    } catch {
      return false;
    }
  });
  // Fresh questions are always used first. The recently asked pool is only drawn on when
  // there are genuinely not enough fresh ones left to fill the session.
  const fresh = eligible.filter((q) => !recent.has(q.key));
  const stale = eligible.filter((q) => recent.has(q.key));

  const bout = save.bouts[boutId];
  const headline = Boolean(bout?.isMainEvent || bout?.isTitleFight || bout?.isInterimTitleFight);
  const prelim = bout?.cardSegment === 'prelim' || bout?.cardSegment === 'early-prelim';
  const count =
    kind === 'post-fight-interview' ? 2 : kind === 'media-day' ? 3 : headline ? 6 : prelim ? 3 : 4;
  const chosen: QuestionTemplate[] = [];
  const drawFrom = (source: QuestionTemplate[]) => {
    const remaining = [...source];
    while (chosen.length < count && remaining.length > 0) {
      const pick = rng.weighted(remaining, (q) => q.weight ?? 1);
      chosen.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }
  };
  drawFrom(fresh);
  if (chosen.length < count) drawFrom(stale);

  const session: PresserSession = {
    id,
    boutId,
    date: save.date,
    kind,
    questions: chosen.map((q, i) => ({
      id: `${q.key}|${i}`,
      askedBy: rng.pick(REPORTERS),
      text: fill(q.text(c), c),
      tags: q.tags,
      answers: q.tones.map((tone) => composeAnswer(tone, c, q.key)),
      selectedKey: null,
      reaction: null,
    })),
    status: 'open',
    summary: null,
  };
  save.pressers[id] = session;
  return session;
}

/** Applies one answer, exactly once. Returns the reaction text. */
export function answerQuestion(save: SaveGame, sessionId: string, questionId: string, answerKey: string, rng: Rng): string | null {
  const session = save.pressers?.[sessionId];
  if (!session) return null;
  const question = session.questions.find((q) => q.id === questionId);
  if (!question || question.selectedKey) return question?.reaction ?? null;
  const answer = question.answers.find((x) => x.key === answerKey);
  if (!answer) return null;

  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  if (me) applyPresserEffects(save, me, session, answer, rng);

  question.selectedKey = answerKey;
  const crowd = rng.pick(CROWD_RESPONSE[answer.tone]);
  const bout = save.bouts[session.boutId];
  const opponent = bout && me ? save.fighters[bout.fighterAId === me.id ? bout.fighterBId : bout.fighterAId] : null;
  const opponentLine =
    opponent && (answer.tone === 'aggressive' || answer.tone === 'controversial')
      ? ` ${opponent.name} answers straight back.`
      : opponent && answer.tone === 'respectful'
        ? ` ${opponent.name} returns the courtesy.`
        : '';
  question.reaction = `${crowd}${opponentLine}`;

  if (session.questions.every((q) => q.selectedKey)) {
    session.status = 'complete';
    session.summary = summarize(session);
  }
  return question.reaction;
}

function summarize(session: PresserSession): string {
  const tones = session.questions
    .map((q) => q.answers.find((a) => a.key === q.selectedKey)?.tone)
    .filter((t): t is SocialTone => Boolean(t));
  const counts = new Map<SocialTone, number>();
  for (const t of tones) counts.set(t, (counts.get(t) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return 'The session passed without much of note.';
  switch (dominant) {
    case 'aggressive':
    case 'controversial':
      return 'That is the press conference that will lead every write up tonight.';
    case 'funny':
      return 'The room enjoyed it. Two clips are already circulating.';
    case 'respectful':
      return 'A measured session. The build stays about the fight.';
    case 'technical':
      return 'The analysts got what they came for.';
    case 'emotional':
      return 'A more personal session than most.';
    case 'silent':
    case 'evasive':
      return 'The media leave with less than they wanted.';
    default:
      return 'A straightforward session ahead of fight night.';
  }
}

function applyPresserEffects(save: SaveGame, me: Fighter, session: PresserSession, answer: PresserAnswer, rng: Rng): void {
  const e = answer.effects;
  if (me.fame) {
    me.fame.favorability = clampPct(me.fame.favorability + (e.favorability ?? 0));
    me.fame.controversy = clampPct(me.fame.controversy + (e.controversy ?? 0));
    me.fame.mediaFriendliness = clampPct(me.fame.mediaFriendliness + (e.mediaReputation ?? 0));
    me.fame.promotionalTrust = clampPct(me.fame.promotionalTrust + (e.promotionRelationship ?? 0));
    me.fame.recognition = clampPct(me.fame.recognition + Math.abs(e.hype ?? 0) * 0.25);
  }
  if (e.confidence) me.momentum = clampPct(me.momentum + e.confidence);
  if (e.promotionRelationship) me.relationships.matchmaker = clampPct(me.relationships.matchmaker + e.promotionRelationship);
  if (me.social && e.followers) {
    const rate = e.followers > 0 ? 0.005 : -0.001;
    for (const key of Object.keys(me.social.followers) as (keyof typeof me.social.followers)[]) {
      me.social.followers[key] = Math.max(0, Math.round(me.social.followers[key] * (1 + rate)));
    }
  }
  const hype = hypeStore(save)[session.boutId];
  if (hype && e.hype) {
    hype.total = clampPct(hype.total + e.hype);
    hype.hardcore = clampPct(hype.hardcore + e.hype * 0.7);
    hype.casual = clampPct(hype.casual + e.hype * 1.15);
    hype.media = clampPct(hype.media + e.hype);
    addHypeMoment(save, session.boutId, `Press conference: ${answer.text.slice(0, 70)}`, e.hype);
  }
  if (e.fineRisk && rng.chance(e.fineRisk / 100)) {
    const fine = Math.round(3000 + rng.range(0, 12000));
    save.player.balance -= fine;
    me.careerEarnings -= fine;
  }
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Deterministic seed so a session is identical when reloaded. */
export function presserRng(save: SaveGame, boutId: BoutId, kind: string): Rng {
  return new Rng(hashString(`presser-${boutId}-${kind}-${save.seed}`));
}

/** Faceoff choices at the ceremonial weigh in. */
export interface FaceoffChoice {
  key: string;
  label: string;
  detail: string;
  effects: SocialEffects;
  risk: string | null;
}

export function faceoffChoices(rivalry: number): FaceoffChoice[] {
  const base: FaceoffChoice[] = [
    { key: 'stare', label: 'Hold the stare', detail: 'Say nothing and do not blink first.', effects: { hype: 4, confidence: 2 }, risk: null },
    { key: 'handshake', label: 'Offer a handshake', detail: 'End the build on good terms.', effects: { favorability: 5, rivalry: -8, hype: -1 }, risk: null },
    { key: 'smile', label: 'Smile and step back', detail: 'Refuse to give them the moment.', effects: { favorability: 3, hype: -2, opponentFocus: 2 }, risk: null },
    { key: 'talk', label: 'Say something to him', detail: 'A few words nobody else hears.', effects: { hype: 6, rivalry: 6, opponentFocus: 4 }, risk: 'The other camp will respond.' },
  ];
  if (rivalry > 45) {
    base.push({
      key: 'shove',
      label: 'Push him back',
      detail: 'Put hands on him in front of the cameras.',
      effects: { hype: 14, controversy: 12, rivalry: 15, fineRisk: 45, favorability: -4 },
      risk: 'Near certain fine and possible commission action.',
    });
  }
  return base;
}
