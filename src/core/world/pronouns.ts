import { DIVISION_BY_ID } from '../config/divisions';
import type { Fighter } from '../types/fighter';

/**
 * Pronouns for media, inbox and camp text about another fighter.
 *
 * Text used to be written with he and him throughout, so a women's strawweight read about
 * what "he" would do to her. The game records no gender on a fighter, but a division does,
 * and every fighter competes in one, so the division is the source. A teammate in a mixed
 * gym takes their own division, not the player's.
 *
 * Templates write {he}, {He}, {him}, {his}, {His}, {himself} and {man}, and fillPronouns
 * substitutes them. 'his' always comes before a noun in these templates ('his hands'), so
 * it maps to 'her'. The neutral set is for text with nobody named, such as a press question
 * asked before an opponent is known; templates that can reach it read with 'they' too.
 */
export interface Pronouns {
  he: string;
  He: string;
  him: string;
  his: string;
  His: string;
  himself: string;
  man: string;
}

const MEN: Pronouns = { he: 'he', He: 'He', him: 'him', his: 'his', His: 'His', himself: 'himself', man: 'man' };
const WOMEN: Pronouns = { he: 'she', He: 'She', him: 'her', his: 'her', His: 'Her', himself: 'herself', man: 'woman' };
const NEUTRAL: Pronouns = { he: 'they', He: 'They', him: 'them', his: 'their', His: 'Their', himself: 'themselves', man: 'person' };

export function pronouns(f: Pick<Fighter, 'divisionId'> | null | undefined): Pronouns {
  if (!f) return NEUTRAL;
  return DIVISION_BY_ID[f.divisionId]?.gender === 'women' ? WOMEN : MEN;
}

export function isWomensFighter(f: Pick<Fighter, 'divisionId'> | null | undefined): boolean {
  return Boolean(f && DIVISION_BY_ID[f.divisionId]?.gender === 'women');
}

/** Replaces the pronoun tokens in a template with the given set. */
export function fillPronouns(text: string, p: Pronouns): string {
  return text.replace(/\{(he|He|him|his|His|himself|man)\}/g, (_, k: keyof Pronouns) => p[k]);
}
