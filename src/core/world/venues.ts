/**
 * Event locations.
 *
 * City and country are real place names. Venue names are generated descriptive strings
 * rather than the trademarked names of actual buildings, so the game ships nothing that
 * requires a licence.
 */

export interface VenueCity {
  city: string;
  country: string;
  countryCode: string;
  region: 'north-america' | 'south-america' | 'europe' | 'asia' | 'africa' | 'oceania';
  /** Relative frequency of hosting an event. */
  weight: number;
  /** Typical capacity band, used for attendance and draw. */
  capacity: number;
  /** True for the promotion's home market, which hosts many smaller cards. */
  isHomeMarket?: boolean;
  venueLabel: string;
}

export const VENUE_CITIES: VenueCity[] = [
  { city: 'Las Vegas', country: 'United States', countryCode: 'US', region: 'north-america', weight: 26, capacity: 20000, isHomeMarket: true, venueLabel: 'Las Vegas Arena' },
  { city: 'Las Vegas', country: 'United States', countryCode: 'US', region: 'north-america', weight: 22, capacity: 3500, isHomeMarket: true, venueLabel: 'Las Vegas Training Facility' },
  { city: 'New York', country: 'United States', countryCode: 'US', region: 'north-america', weight: 6, capacity: 20000, venueLabel: 'New York Arena' },
  { city: 'Miami', country: 'United States', countryCode: 'US', region: 'north-america', weight: 4, capacity: 19000, venueLabel: 'Miami Arena' },
  { city: 'Los Angeles', country: 'United States', countryCode: 'US', region: 'north-america', weight: 4, capacity: 18000, venueLabel: 'Los Angeles Arena' },
  { city: 'Chicago', country: 'United States', countryCode: 'US', region: 'north-america', weight: 3, capacity: 18500, venueLabel: 'Chicago Arena' },
  { city: 'Houston', country: 'United States', countryCode: 'US', region: 'north-america', weight: 3, capacity: 17000, venueLabel: 'Houston Arena' },
  { city: 'Denver', country: 'United States', countryCode: 'US', region: 'north-america', weight: 2, capacity: 17500, venueLabel: 'Denver Arena' },
  { city: 'Seattle', country: 'United States', countryCode: 'US', region: 'north-america', weight: 2, capacity: 17000, venueLabel: 'Seattle Arena' },
  { city: 'Nashville', country: 'United States', countryCode: 'US', region: 'north-america', weight: 2, capacity: 17000, venueLabel: 'Nashville Arena' },
  { city: 'Toronto', country: 'Canada', countryCode: 'CA', region: 'north-america', weight: 4, capacity: 19000, venueLabel: 'Toronto Arena' },
  { city: 'Vancouver', country: 'Canada', countryCode: 'CA', region: 'north-america', weight: 2, capacity: 18000, venueLabel: 'Vancouver Arena' },
  { city: 'Montreal', country: 'Canada', countryCode: 'CA', region: 'north-america', weight: 2, capacity: 21000, venueLabel: 'Montreal Arena' },
  { city: 'Mexico City', country: 'Mexico', countryCode: 'MX', region: 'north-america', weight: 4, capacity: 22000, venueLabel: 'Mexico City Arena' },
  { city: 'Rio de Janeiro', country: 'Brazil', countryCode: 'BR', region: 'south-america', weight: 5, capacity: 15000, venueLabel: 'Rio de Janeiro Arena' },
  { city: 'Sao Paulo', country: 'Brazil', countryCode: 'BR', region: 'south-america', weight: 4, capacity: 15000, venueLabel: 'Sao Paulo Arena' },
  { city: 'Buenos Aires', country: 'Argentina', countryCode: 'AR', region: 'south-america', weight: 2, capacity: 14000, venueLabel: 'Buenos Aires Arena' },
  { city: 'London', country: 'England', countryCode: 'GB', region: 'europe', weight: 6, capacity: 18000, venueLabel: 'London Arena' },
  { city: 'Manchester', country: 'England', countryCode: 'GB', region: 'europe', weight: 3, capacity: 21000, venueLabel: 'Manchester Arena' },
  { city: 'Paris', country: 'France', countryCode: 'FR', region: 'europe', weight: 4, capacity: 16000, venueLabel: 'Paris Arena' },
  { city: 'Madrid', country: 'Spain', countryCode: 'ES', region: 'europe', weight: 2, capacity: 15000, venueLabel: 'Madrid Arena' },
  { city: 'Berlin', country: 'Germany', countryCode: 'DE', region: 'europe', weight: 2, capacity: 14000, venueLabel: 'Berlin Arena' },
  { city: 'Stockholm', country: 'Sweden', countryCode: 'SE', region: 'europe', weight: 2, capacity: 13000, venueLabel: 'Stockholm Arena' },
  { city: 'Dublin', country: 'Ireland', countryCode: 'IE', region: 'europe', weight: 2, capacity: 9000, venueLabel: 'Dublin Arena' },
  { city: 'Warsaw', country: 'Poland', countryCode: 'PL', region: 'europe', weight: 2, capacity: 15000, venueLabel: 'Warsaw Arena' },
  { city: 'Abu Dhabi', country: 'United Arab Emirates', countryCode: 'AE', region: 'asia', weight: 5, capacity: 12000, venueLabel: 'Abu Dhabi Arena' },
  { city: 'Shanghai', country: 'China', countryCode: 'CN', region: 'asia', weight: 3, capacity: 15000, venueLabel: 'Shanghai Arena' },
  { city: 'Singapore', country: 'Singapore', countryCode: 'SG', region: 'asia', weight: 3, capacity: 12000, venueLabel: 'Singapore Arena' },
  { city: 'Tokyo', country: 'Japan', countryCode: 'JP', region: 'asia', weight: 3, capacity: 17000, venueLabel: 'Tokyo Arena' },
  { city: 'Seoul', country: 'South Korea', countryCode: 'KR', region: 'asia', weight: 2, capacity: 14000, venueLabel: 'Seoul Arena' },
  { city: 'Sydney', country: 'Australia', countryCode: 'AU', region: 'oceania', weight: 3, capacity: 18000, venueLabel: 'Sydney Arena' },
  { city: 'Perth', country: 'Australia', countryCode: 'AU', region: 'oceania', weight: 2, capacity: 15000, venueLabel: 'Perth Arena' },
  { city: 'Auckland', country: 'New Zealand', countryCode: 'NZ', region: 'oceania', weight: 1, capacity: 12000, venueLabel: 'Auckland Arena' },
  { city: 'Johannesburg', country: 'South Africa', countryCode: 'ZA', region: 'africa', weight: 1, capacity: 12000, venueLabel: 'Johannesburg Arena' },
];

/** Very rough great circle distance band by region pair, used for travel effects. */
const REGION_DISTANCE: Record<string, Record<string, number>> = {
  'north-america': { 'north-america': 2000, 'south-america': 7000, europe: 7500, asia: 11000, africa: 12000, oceania: 13000 },
  'south-america': { 'north-america': 7000, 'south-america': 2000, europe: 9500, asia: 16000, africa: 8000, oceania: 13000 },
  europe: { 'north-america': 7500, 'south-america': 9500, europe: 1500, asia: 8000, africa: 5000, oceania: 16000 },
  asia: { 'north-america': 11000, 'south-america': 16000, europe: 8000, asia: 3000, africa: 9000, oceania: 7500 },
  africa: { 'north-america': 12000, 'south-america': 8000, europe: 5000, asia: 9000, africa: 3000, oceania: 11000 },
  oceania: { 'north-america': 13000, 'south-america': 13000, europe: 16000, asia: 7500, africa: 11000, oceania: 2500 },
};

export function travelDistanceKm(fromRegion: string | null, toRegion: string): number {
  if (!fromRegion) return 8000;
  return REGION_DISTANCE[fromRegion]?.[toRegion] ?? 9000;
}
