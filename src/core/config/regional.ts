import type { VenueCity } from '../world/venues';

/**
 * The regional circuit.
 *
 * Every promotion here is fictional, for the same reason the main promotion is: the simulation
 * invents everything that happens inside it, so nothing it invents carries a real company's name.
 * They are modelled on the real shape of the sport below the top level: small local shows that
 * pay a few thousand dollars, national promotions with television and a real title picture, and a
 * handful of major international promotions that pay well and that the main promotion watches
 * closely.
 */

export type RegionalLevel = 1 | 2 | 3;

export interface RegionalPromotionConfig {
  id: string;
  name: string;
  abbreviation: string;
  level: RegionalLevel;
  country: string;
  countryCode: string;
  region: VenueCity['region'];
  cities: string[];
  /** A descriptive venue string per card. Never the trademarked name of a real building. */
  venueLabel: string;
  blurb: string;
}

export interface RegionalLevelConfig {
  label: string;
  /** Mean and spread of a rostered fighter's Ovr at this level. */
  rosterOvr: number;
  rosterOvrSd: number;
  /** Show money for a fighter starting out at this level. The win bonus matches it. */
  baseShowPay: number;
  /** Days between cards. */
  intervalDays: [number, number];
  /** How closely the main promotion watches this level, 0 to 1. */
  scoutWeight: number;
  attendance: [number, number];
  /** How much a result here moves popularity, against a main promotion result. */
  popularityScale: number;
  /** Fighters kept on the roster of each division the circuit runs. */
  rosterSize: number;
}

export const REGIONAL_LEVELS: Record<RegionalLevel, RegionalLevelConfig> = {
  1: {
    label: 'Local circuit',
    rosterOvr: 47,
    rosterOvrSd: 5.5,
    baseShowPay: 1500,
    intervalDays: [35, 49],
    scoutWeight: 0.6,
    attendance: [500, 2200],
    popularityScale: 0.22,
    rosterSize: 14,
  },
  2: {
    label: 'National promotion',
    rosterOvr: 53,
    rosterOvrSd: 5,
    baseShowPay: 4000,
    intervalDays: [42, 56],
    scoutWeight: 0.82,
    attendance: [1500, 5500],
    popularityScale: 0.32,
    rosterSize: 14,
  },
  3: {
    label: 'Major international promotion',
    rosterOvr: 58,
    rosterOvrSd: 4.5,
    baseShowPay: 11000,
    intervalDays: [49, 63],
    scoutWeight: 1,
    attendance: [5000, 16000],
    popularityScale: 0.5,
    rosterSize: 14,
  },
};

export const REGIONAL_PROMOTIONS: RegionalPromotionConfig[] = [
  {
    id: 'rp-rust-belt',
    name: 'Rust Belt Combat League',
    abbreviation: 'RBCL',
    level: 1,
    country: 'United States',
    countryCode: 'US',
    region: 'north-america',
    cities: ['Cleveland', 'Pittsburgh', 'Detroit', 'Toledo', 'Akron'],
    venueLabel: 'Convention Hall',
    blurb: 'Smoky halls, short notice and two thousand dollar purses. Where most careers start.',
  },
  {
    id: 'rp-pacific-coast',
    name: 'Pacific Coast Cage Series',
    abbreviation: 'PCCS',
    level: 1,
    country: 'United States',
    countryCode: 'US',
    region: 'north-america',
    cities: ['San Diego', 'Sacramento', 'Fresno', 'Portland', 'Reno'],
    venueLabel: 'Casino Ballroom',
    blurb: 'A West Coast casino circuit with a deep pool of wrestlers and kickboxers.',
  },
  {
    id: 'rp-lone-star',
    name: 'Lone Star Fighting Alliance',
    abbreviation: 'LSFA',
    level: 2,
    country: 'United States',
    countryCode: 'US',
    region: 'north-america',
    cities: ['Houston', 'Dallas', 'San Antonio', 'Austin', 'El Paso'],
    venueLabel: 'Events Center',
    blurb: 'A televised national promotion. Its champions are on every scout list.',
  },
  {
    id: 'rp-crown-arena',
    name: 'Crown Arena Fighting',
    abbreviation: 'CAF',
    level: 3,
    country: 'United States',
    countryCode: 'US',
    region: 'north-america',
    cities: ['Atlantic City', 'Orlando', 'Phoenix', 'Hollywood, Florida'],
    venueLabel: 'Arena',
    blurb: 'The biggest promotion outside the main one. Real money, real opponents and arena crowds.',
  },
  {
    id: 'rp-maple-leaf',
    name: 'Maple Leaf Fight League',
    abbreviation: 'MLFL',
    level: 1,
    country: 'Canada',
    countryCode: 'CA',
    region: 'north-america',
    cities: ['Calgary', 'Winnipeg', 'Halifax', 'Ottawa', 'Edmonton'],
    venueLabel: 'Community Arena',
    blurb: 'A Canadian circuit that runs through the winter in hockey rinks.',
  },
  {
    id: 'rp-norte',
    name: 'Liga de Combate del Norte',
    abbreviation: 'LCN',
    level: 1,
    country: 'Mexico',
    countryCode: 'MX',
    region: 'north-america',
    cities: ['Monterrey', 'Tijuana', 'Guadalajara', 'Hermosillo', 'Chihuahua'],
    venueLabel: 'Arena',
    blurb: 'Packed northern Mexico shows with loud crowds and willing opponents.',
  },
  {
    id: 'rp-tropicalia',
    name: 'Tropicália Fight Series',
    abbreviation: 'TFS',
    level: 2,
    country: 'Brazil',
    countryCode: 'BR',
    region: 'south-america',
    cities: ['Recife', 'Salvador', 'Curitiba', 'Belo Horizonte', 'Manaus'],
    venueLabel: 'Ginásio',
    blurb: 'Brazil\'s national stage. Jiu jitsu everywhere and judges who reward pressure.',
  },
  {
    id: 'rp-andes',
    name: 'Andes Fighting Championship',
    abbreviation: 'AndFC',
    level: 1,
    country: 'Peru',
    countryCode: 'PE',
    region: 'south-america',
    cities: ['Lima', 'Arequipa', 'Quito', 'Santiago', 'Bogota'],
    venueLabel: 'Coliseo',
    blurb: 'A travelling South American circuit, rough edges and real talent.',
  },
  {
    id: 'rp-northern-cage',
    name: 'Northern Cage Series',
    abbreviation: 'NCS',
    level: 2,
    country: 'England',
    countryCode: 'GB',
    region: 'europe',
    cities: ['Newcastle', 'Leeds', 'Liverpool', 'Birmingham', 'Sheffield'],
    venueLabel: 'Arena',
    blurb: 'The proving ground of British MMA, with a streaming deal and a loyal following.',
  },
  {
    id: 'rp-emerald-isle',
    name: 'Emerald Isle Fight Series',
    abbreviation: 'EIFS',
    level: 1,
    country: 'Ireland',
    countryCode: 'IE',
    region: 'europe',
    cities: ['Dublin', 'Cork', 'Galway', 'Limerick', 'Belfast'],
    venueLabel: 'National Stadium Hall',
    blurb: 'Small rooms, enormous noise. Irish crowds turn local shows into events.',
  },
  {
    id: 'rp-vistula',
    name: 'Vistula Fight Series',
    abbreviation: 'VFS',
    level: 2,
    country: 'Poland',
    countryCode: 'PL',
    region: 'europe',
    cities: ['Warsaw', 'Gdansk', 'Krakow', 'Lodz', 'Wroclaw'],
    venueLabel: 'Hala Sportowa',
    blurb: 'A big Central European television product with stacked cards.',
  },
  {
    id: 'rp-rhine',
    name: 'Rhine Valley Combat',
    abbreviation: 'RVC',
    level: 1,
    country: 'Germany',
    countryCode: 'DE',
    region: 'europe',
    cities: ['Cologne', 'Dusseldorf', 'Frankfurt', 'Rotterdam', 'Strasbourg'],
    venueLabel: 'Messehalle',
    blurb: 'A cross border circuit for German, Dutch and French fighters.',
  },
  {
    id: 'rp-volga',
    name: 'Volga Fighting Championship',
    abbreviation: 'VFC',
    level: 3,
    country: 'Russia',
    countryCode: 'RU',
    region: 'europe',
    cities: ['Kazan', 'Samara', 'Moscow', 'Sochi', 'Grozny'],
    venueLabel: 'Arena',
    blurb: 'A major promotion built on wrestlers and sambo players. Hard to win, harder to leave.',
  },
  {
    id: 'rp-caucasus',
    name: 'Caucasus Fight Series',
    abbreviation: 'CFS',
    level: 2,
    country: 'Georgia',
    countryCode: 'GE',
    region: 'europe',
    cities: ['Tbilisi', 'Batumi', 'Yerevan', 'Baku', 'Makhachkala'],
    venueLabel: 'Sports Palace',
    blurb: 'Grappling heavy and relentless. A wrestler\'s promotion.',
  },
  {
    id: 'rp-great-steppe',
    name: 'Great Steppe Championship',
    abbreviation: 'GSC',
    level: 2,
    country: 'Kazakhstan',
    countryCode: 'KZ',
    region: 'asia',
    cities: ['Almaty', 'Astana', 'Shymkent', 'Bishkek', 'Tashkent'],
    venueLabel: 'Arena',
    blurb: 'Central Asia\'s fastest growing promotion, with real money behind it.',
  },
  {
    id: 'rp-hinode',
    name: 'Hinode Fighting Federation',
    abbreviation: 'HFF',
    level: 3,
    country: 'Japan',
    countryCode: 'JP',
    region: 'asia',
    cities: ['Saitama', 'Osaka', 'Yokohama', 'Nagoya', 'Fukuoka'],
    venueLabel: 'Super Arena',
    blurb: 'Spectacle, grand prix brackets and enormous New Year\'s Eve crowds.',
  },
  {
    id: 'rp-archipelago',
    name: 'Archipelago Fighting Championship',
    abbreviation: 'ArcFC',
    level: 1,
    country: 'Philippines',
    countryCode: 'PH',
    region: 'asia',
    cities: ['Manila', 'Cebu', 'Davao', 'Baguio', 'Singapore'],
    venueLabel: 'Coliseum',
    blurb: 'A Southeast Asian circuit full of wushu and muay thai stylists.',
  },
  {
    id: 'rp-southern-cross',
    name: 'Southern Cross Fighting',
    abbreviation: 'SCF',
    level: 2,
    country: 'Australia',
    countryCode: 'AU',
    region: 'oceania',
    cities: ['Brisbane', 'Perth', 'Melbourne', 'Adelaide', 'Auckland'],
    venueLabel: 'Entertainment Centre',
    blurb: 'The best of Australia and New Zealand, with a television slot every month.',
  },
  {
    id: 'rp-highveld',
    name: 'Highveld Fight Series',
    abbreviation: 'HFS',
    level: 1,
    country: 'South Africa',
    countryCode: 'ZA',
    region: 'africa',
    cities: ['Johannesburg', 'Cape Town', 'Durban', 'Lagos', 'Nairobi'],
    venueLabel: 'Indoor Arena',
    blurb: 'The continent\'s biggest regular show, and a scouting stop for everyone.',
  },
];

export const REGIONAL_PROMOTION_BY_ID: Record<string, RegionalPromotionConfig> = Object.fromEntries(
  REGIONAL_PROMOTIONS.map((p) => [p.id, p])
);

/**
 * The main promotion's tryout series. It is not a regional promotion; it borrows the regional
 * card machinery because a tryout is a single bout on a small card in front of the matchmakers.
 */
export const PROVING_GROUND_ID = 'rp-proving-ground';

/** The youngest age the game will start a career at. Bouts before eighteen are amateur. */
export const MIN_REGIONAL_START_AGE = 16;
export const PRO_AGE = 18;

/**
 * Promotions offered first for a fighter from this country: home country, then the same region,
 * then everything else, each tier ordered by level so the bigger stage is visible.
 */
export function promotionsForCountry(country: string, region: string | null): RegionalPromotionConfig[] {
  const score = (p: RegionalPromotionConfig) => (p.country === country ? 0 : p.region === region ? 1 : 2);
  return [...REGIONAL_PROMOTIONS].sort((a, b) => score(a) - score(b) || a.level - b.level || a.name.localeCompare(b.name));
}
