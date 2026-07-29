// HTML extraction for the official UFC source pages.
//
// Every extractor returns null for a field it cannot find. Nothing is guessed and
// nothing is defaulted to a plausible looking number. A null here becomes an explicit
// "unknown" in the snapshot, and the validation report counts it.

function decode(s) {
  if (s == null) return null;
  return s
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function strip(s) {
  if (s == null) return null;
  return decode(s.replace(/<[^>]+>/g, ' '));
}

function num(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parses https://www.ufc.com/rankings
 * Returns { capturedAt, divisions: [{ name, champion, entries: [{rank, slug, name, change}] }] }
 */
export function parseRankings(html) {
  const divisions = [];
  // Each ranking group is a <div class="view-grouping"> with a header and a table.
  const groups = html.split('view-grouping"').slice(1);
  for (const raw of groups) {
    const nameMatch = raw.match(/view-grouping-header">\s*([^<]+?)\s*</);
    if (!nameMatch) continue;
    const divisionName = decode(nameMatch[1]);

    // Champion block appears above the table for weight divisions.
    let champion = null;
    const champBlock = raw.match(/rankings--athlete--champion(.*?)(?:<tbody|<\/div>\s*<\/div>\s*<\/div>)/s);
    if (champBlock) {
      const cSlug = champBlock[1].match(/href="\/athlete\/([a-z0-9\-]+)"/);
      const cName = champBlock[1].match(/views-field-title[^>]*>\s*(?:<[^>]*>\s*)*<a[^>]*>\s*([^<]+)/);
      if (cSlug) {
        champion = { slug: cSlug[1], name: cName ? decode(cName[1]) : null };
      }
    }

    const entries = [];
    const rowRe =
      /views-field-weight-class-rank">\s*(\d+)\s*<\/td>\s*<td[^>]*views-field-title[^>]*>\s*(?:<[^>]*>\s*)*<a href="\/athlete\/([a-z0-9\-]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g;
    let m;
    while ((m = rowRe.exec(raw)) !== null) {
      entries.push({ rank: Number(m[1]), slug: m[2], name: decode(m[3]) });
    }

    if (entries.length === 0 && !champion) continue;
    divisions.push({ name: divisionName, champion, entries });
  }
  return { divisions };
}

/**
 * Parses https://www.ufc.com/athlete/<slug>
 * Every returned field is either a sourced value or null.
 */
export function parseAthlete(html, slug) {
  const bio = {};
  const bioRe = /c-bio__label">\s*([^<]+?)\s*<\/div>\s*<div class="c-bio__text">(.*?)<\/div>/gs;
  let m;
  while ((m = bioRe.exec(html)) !== null) {
    bio[decode(m[1])] = strip(m[2]);
  }

  const heroTags = [...html.matchAll(/hero-profile__tag">\s*([^<]*?)\s*</g)].map((x) => decode(x[1])).filter(Boolean);

  const nameM = html.match(/hero-profile__name">\s*([^<]+?)\s*</);
  const nickM = html.match(/hero-profile__nickname">\s*"?([^"<]*?)"?\s*</);
  const divM = html.match(/hero-profile__division-title">\s*([^<]+?)\s*</);
  const recM = html.match(/hero-profile__division-body">\s*([0-9]+)-([0-9]+)-([0-9]+)/);

  const heroStats = {};
  const hsRe = /hero-profile__stat-numb">\s*([^<]*?)\s*<\/p>\s*<p class="hero-profile__stat-text">\s*([^<]+?)\s*</gs;
  while ((m = hsRe.exec(html)) !== null) {
    heroStats[decode(m[2])] = num(m[1]);
  }

  // Rate style comparison stats. Percentage entries carry a separate percent node.
  const compare = {};
  const cmpRe =
    /c-stat-compare__number">\s*([^<]*?)\s*(?:<div class="c-stat-compare__percent">\s*([^<]*?)\s*<\/div>\s*)?<\/div>\s*<div class="c-stat-compare__label">\s*([^<]+?)\s*</gs;
  while ((m = cmpRe.exec(html)) !== null) {
    const label = decode(m[3]);
    const isPct = m[2] != null && m[2].includes('%');
    compare[label] = { value: label === 'Average fight time' ? decode(m[1]) : num(m[1]), isPercent: isPct };
  }

  const overlap = {};
  const ovRe = /c-overlap__stats-text">\s*([^<]+?)\s*<\/dt>\s*<dd class="c-overlap__stats-value">\s*([^<]*?)\s*</gs;
  while ((m = ovRe.exec(html)) !== null) {
    overlap[decode(m[1])] = num(m[2]);
  }

  const target = {};
  const tgRe = /id="e-stat-body_x5F__x5F_(head|body|leg)_(value|percent)"[^>]*>\s*([0-9]+)/g;
  while ((m = tgRe.exec(html)) !== null) {
    target[`${m[1]}_${m[2]}`] = Number(m[3]);
  }

  // Strike position and win method breakdowns share the 3bar component.
  const bars = [...html.matchAll(/c-stat-3bar__label">\s*([^<]+?)\s*<\/div>\s*<div class="c-stat-3bar__value">\s*([0-9]+)\s*\(([0-9]+)%\)/gs)].map(
    (x) => ({ label: decode(x[1]), value: Number(x[2]), percent: Number(x[3]) })
  );
  const position = {};
  const method = {};
  for (const b of bars) {
    if (['Standing', 'Clinch', 'Ground'].includes(b.label)) position[b.label.toLowerCase()] = b;
    if (['KO/TKO', 'DEC', 'SUB'].includes(b.label)) method[b.label] = b;
  }

  const rankTag = heroTags.find((t) => /^#\d+/.test(t));
  const pfpTag = heroTags.find((t) => /PFP/i.test(t));

  const avgFightTime = compare['Average fight time'] ? compare['Average fight time'].value : null;

  return {
    slug,
    name: nameM ? decode(nameM[1]) : null,
    nickname: nickM ? decode(nickM[1]) || null : null,
    divisionLabel: divM ? decode(divM[1]) : null,
    record: recM ? { w: Number(recM[1]), l: Number(recM[2]), d: Number(recM[3]) } : null,
    status: bio['Status'] || null,
    placeOfBirth: bio['Place of Birth'] || null,
    trainsAt: bio['Trains at'] || null,
    fightingStyle: bio['Fighting style'] || null,
    age: num(bio['Age']),
    heightIn: num(bio['Height']),
    weightLb: num(bio['Weight']),
    reachIn: num(bio['Reach']),
    legReachIn: num(bio['Leg reach']),
    octagonDebut: bio['Octagon Debut'] || null,
    isTitleHolder: heroTags.some((t) => /Title Holder/i.test(t)),
    isInterimHolder: heroTags.some((t) => /Interim/i.test(t)),
    heroRankTag: rankTag || null,
    pfpTag: pfpTag || null,
    winStreak: heroStats['Fight Win Streak'] ?? null,
    lossStreak: heroStats['Fight Loss Streak'] ?? null,
    winsByKo: heroStats['Wins by Knockout'] ?? null,
    winsBySub: heroStats['Wins by Submission'] ?? null,
    firstRoundFinishes: heroStats['First Round Finishes'] ?? null,
    sigStrLandedPerMin: compare['Sig. Str. Landed'] ? compare['Sig. Str. Landed'].value : null,
    sigStrAbsorbedPerMin: compare['Sig. Str. Absorbed'] ? compare['Sig. Str. Absorbed'].value : null,
    takedownAvgPer15: compare['Takedown avg'] ? compare['Takedown avg'].value : null,
    submissionAvgPer15: compare['Submission avg'] ? compare['Submission avg'].value : null,
    sigStrDefensePct: compare['Sig. Str. Defense'] ? compare['Sig. Str. Defense'].value : null,
    takedownDefensePct: compare['Takedown Defense'] ? compare['Takedown Defense'].value : null,
    knockdownAvgPer15: compare['Knockdown Avg'] ? compare['Knockdown Avg'].value : null,
    avgFightTime: typeof avgFightTime === 'string' ? avgFightTime : null,
    sigStrLanded: overlap['Sig. Strikes Landed'] ?? null,
    sigStrAttempted: overlap['Sig. Strikes Attempted'] ?? null,
    takedownsLanded: overlap['Takedowns Landed'] ?? null,
    takedownsAttempted: overlap['Takedowns Attempted'] ?? null,
    strikeTarget: Object.keys(target).length ? target : null,
    strikePosition: Object.keys(position).length ? position : null,
    winMethod: Object.keys(method).length ? method : null,
  };
}

export const _internal = { decode, strip, num };
