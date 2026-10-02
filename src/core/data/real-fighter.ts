/**
 * Normalisation for values that come from the real roster source.
 *
 * The snapshot builder, new game creation and the save loader all apply these, so a fix to how a
 * sourced value is read reaches a fresh snapshot, a new career and a career already in progress the
 * same way.
 */
import { hashString } from '../rng';
import { addDays, type IsoDate } from '../types/common';

/**
 * Strips the quotes the source wraps a nickname in. The interface adds its own quotes around every
 * nickname, generated ones included, so a stored nickname must never carry them. Only double quotes,
 * straight and curly, come off the ends: an apostrophe can be part of the nickname itself, as in
 * Ragin' or Lil' Heathen.
 */
export function cleanNickname(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.replace(/^[\s"“”]+|[\s"“”]+$/g, '') || null;
}

/**
 * An estimated birth date for a fighter whose source publishes an age but no date of birth. Without
 * one the fighter never ages: every age read is the birth date first and the snapshot age only as a
 * fallback, and nothing moves the snapshot age forward. The date is anchored on the snapshot date,
 * so the age on that day is exactly the published one, and the birthday is spread across the year by
 * a hash of the fighter id, so the roster does not all turn a year older on the same morning. The
 * fighter carries birthDateEstimated so the interface never presents the date as a sourced fact.
 */
export function estimatedBirthDate(fighterId: string, ageAtSnapshot: number, snapshotDate: IsoDate): IsoDate {
  const [y, m, d] = snapshotDate.split('-').map(Number);
  // The same calendar day ageAtSnapshot years earlier. A 29 February snapshot rolls to 1 March.
  const anchor = new Date(Date.UTC(y - ageAtSnapshot, m - 1, d)).toISOString().slice(0, 10);
  // Anywhere from that day back to 364 days before it keeps the age on the snapshot date unchanged.
  return addDays(anchor, -(hashString(`birthday-${fighterId}`) % 365));
}

/**
 * ISO 3166 codes for the countries the source names. The source text is kept as the fighter's
 * country; the code is looked up here rather than guessed from the first two letters of the name,
 * which gave United Kingdom the code UN. The home nations share the United Kingdom's code.
 */
export const COUNTRY_ISO: Record<string, string> = {
  Afghanistan: 'AF',
  Albania: 'AL',
  Algeria: 'DZ',
  Angola: 'AO',
  Argentina: 'AR',
  Armenia: 'AM',
  Australia: 'AU',
  Austria: 'AT',
  Azerbaijan: 'AZ',
  Bahrain: 'BH',
  Belarus: 'BY',
  Belgium: 'BE',
  Bolivia: 'BO',
  'Bosnia and Herzegovina': 'BA',
  Brazil: 'BR',
  Bulgaria: 'BG',
  Cameroon: 'CM',
  Canada: 'CA',
  'Canary Islands': 'ES',
  Chile: 'CL',
  China: 'CN',
  Colombia: 'CO',
  'Costa Rica': 'CR',
  Croatia: 'HR',
  Cuba: 'CU',
  Cyprus: 'CY',
  Czechia: 'CZ',
  'Czech Republic': 'CZ',
  'Democratic Republic of the Congo': 'CD',
  Denmark: 'DK',
  'Dominican Republic': 'DO',
  Ecuador: 'EC',
  Egypt: 'EG',
  England: 'GB',
  Estonia: 'EE',
  Finland: 'FI',
  France: 'FR',
  Georgia: 'GE',
  Germany: 'DE',
  Ghana: 'GH',
  Greece: 'GR',
  Guam: 'GU',
  Guatemala: 'GT',
  Guinea: 'GN',
  Guyana: 'GY',
  Honduras: 'HN',
  'Hong Kong': 'HK',
  Hungary: 'HU',
  Iceland: 'IS',
  India: 'IN',
  Indonesia: 'ID',
  Iran: 'IR',
  Iraq: 'IQ',
  Ireland: 'IE',
  Israel: 'IL',
  Italy: 'IT',
  Jamaica: 'JM',
  Japan: 'JP',
  Jordan: 'JO',
  Kazakhstan: 'KZ',
  Kenya: 'KE',
  Kyrgyzstan: 'KG',
  Latvia: 'LV',
  Lebanon: 'LB',
  Lithuania: 'LT',
  Mexico: 'MX',
  Moldova: 'MD',
  Mongolia: 'MN',
  Montenegro: 'ME',
  Morocco: 'MA',
  Myanmar: 'MM',
  Netherlands: 'NL',
  'New Zealand': 'NZ',
  Nigeria: 'NG',
  'Northern Ireland': 'GB',
  'North Macedonia': 'MK',
  Norway: 'NO',
  Panama: 'PA',
  Paraguay: 'PY',
  Peru: 'PE',
  Philippines: 'PH',
  Poland: 'PL',
  Portugal: 'PT',
  'Puerto Rico': 'PR',
  Romania: 'RO',
  Russia: 'RU',
  Scotland: 'GB',
  Senegal: 'SN',
  Serbia: 'RS',
  Singapore: 'SG',
  Slovakia: 'SK',
  Slovenia: 'SI',
  'Solomon Islands': 'SB',
  'South Africa': 'ZA',
  'South Korea': 'KR',
  Spain: 'ES',
  Suriname: 'SR',
  Sweden: 'SE',
  Switzerland: 'CH',
  Syria: 'SY',
  Taiwan: 'TW',
  Tajikistan: 'TJ',
  Thailand: 'TH',
  Tunisia: 'TN',
  Turkey: 'TR',
  'Türkiye': 'TR',
  Turkmenistan: 'TM',
  Uganda: 'UG',
  Ukraine: 'UA',
  'United Arab Emirates': 'AE',
  'United Kingdom': 'GB',
  'United States': 'US',
  Uruguay: 'UY',
  Uzbekistan: 'UZ',
  Venezuela: 'VE',
  Vietnam: 'VN',
  Wales: 'GB',
  Zimbabwe: 'ZW',
};

/** Spellings the source uses for a country the rest of the game names differently. */
const COUNTRY_SPELLING: Record<string, string> = {
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina',
  'Bosnia &amp; Herzegovina': 'Bosnia and Herzegovina',
  USA: 'United States',
  UK: 'United Kingdom',
};

export function canonicalCountry(name: string): string {
  const t = name.trim();
  return COUNTRY_SPELLING[t] ?? t;
}

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ')
);

/**
 * The location a gym's own name gives, as in "Xtreme Couture - Las Vegas, NV" or "MMA Factory -
 * Paris, France". The source publishes no gym address, and the builder used to take the home town of
 * the first member it met, which put Xtreme Couture in Batumi. Only a city after a spaced dash or a comma
 * that ends in a US state or a known country is read, because many gym fields are lists of several
 * gyms separated by commas. Anything else is null and the gym's city stays unknown.
 */
export function parseGymLocation(name: string): { city: string; country: string; countryCode: string } | null {
  const m = name.match(/(?:\s+-\s*|-\s+|,\s+)([^,\-]+?),\s*([^,]+?)\s*$/);
  if (!m) return null;
  const city = m[1].trim();
  const tail = m[2].trim();
  if (!city || /\d/.test(city)) return null;
  if (US_STATES.has(tail)) return { city, country: 'United States', countryCode: 'US' };
  const country = canonicalCountry(tail);
  const code = COUNTRY_ISO[country];
  return code ? { city, country, countryCode: code } : null;
}
