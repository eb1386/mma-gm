/**
 * Name search that forgives accents and apostrophes.
 *
 * Real names carry marks nobody types on a phone keyboard: Julianna Peña, Jiří Procházka,
 * Jan Błachowicz, Lone’er Kavanagh. A plain lowercase substring match found none of them for
 * 'pena', 'prochazka', 'blachowicz' or 'loneer'. Both sides are folded the same way, so a query
 * typed with the accents still matches too.
 */
export function foldName(s: string): string {
  return (
    s
      .normalize('NFD')
      // The combining diacritical marks block, left behind once NFD splits a letter from its accent.
      .replace(/[\u0300-\u036f]/g, '')
      // NFD does not decompose the stroked letters, so they are mapped by hand.
      .replace(/[\u0141\u0142]/g, 'l')
      .replace(/[\u0110\u0111]/g, 'd')
      // Apostrophes (straight and curly), backticks and dots vanish, so "lone'er" and "loneer" both
      // find Lone’er and "jr" finds "Jr.". Spaces and hyphens stay, so word boundaries still mean something.
      .replace(/[\u2018\u2019'`.]/g, '')
      .toLowerCase()
  );
}

/** True when the folded query is a substring of the folded name. An empty query matches everything. */
export function nameMatches(name: string, query: string): boolean {
  const q = foldName(query.trim());
  if (!q) return true;
  return foldName(name).includes(q);
}
