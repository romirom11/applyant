// Which countries a posting's stated remote region covers, for "can I work this from where
// I live?". Coarse on purpose: a region not listed here counts as not covering a country.
import type { RemoteRegion } from '../../models/schemas/posting.ts';
import { countryCode } from './structured.ts';

// biome-ignore format: a data table reads better packed
const EU = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];
// biome-ignore format: a data table reads better packed
const EUROPE = [
  ...EU,
  'GB', 'CH', 'NO', 'IS', 'LI', 'UA', 'MD', 'RS', 'BA', 'ME', 'MK', 'AL', 'XK', 'GE', 'AM',
  'AZ', 'TR', 'AD', 'MC', 'SM', 'VA',
];
// biome-ignore format: a data table reads better packed
const MIDDLE_EAST = ['AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IL', 'JO', 'LB', 'EG', 'IQ', 'IR', 'YE'];
// biome-ignore format: a data table reads better packed
const AFRICA = [
  'ZA', 'NG', 'KE', 'GH', 'MA', 'TN', 'DZ', 'EG', 'ET', 'UG', 'TZ', 'RW', 'SN', 'CI', 'CM',
];
const NORTH_AMERICA = ['US', 'CA'];
// biome-ignore format: a data table reads better packed
const LATAM = [
  'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'PY', 'BO', 'EC', 'VE', 'CR', 'PA', 'GT', 'DO',
];
// biome-ignore format: a data table reads better packed
const APAC = [
  'AU', 'NZ', 'JP', 'KR', 'CN', 'HK', 'TW', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'IN', 'PK',
  'BD', 'LK',
];

const REGION_COUNTRIES: Record<Exclude<RemoteRegion, 'worldwide'>, readonly string[]> = {
  eu: EU,
  europe: EUROPE,
  emea: [...EUROPE, ...MIDDLE_EAST, ...AFRICA],
  uk: ['GB'],
  north_america: NORTH_AMERICA,
  us: ['US'],
  americas: [...NORTH_AMERICA, ...LATAM],
  latam: LATAM,
  apac: APAC,
  middle_east: MIDDLE_EAST,
  africa: AFRICA,
};

export function regionCovers(region: RemoteRegion, country: string): boolean {
  if (region === 'worldwide') return true;
  return REGION_COUNTRIES[region].includes(country);
}

const REGION_WORDS: Array<[RegExp, RemoteRegion]> = [
  [/\b(worldwide|anywhere|global|globally)\b/, 'worldwide'],
  [/\bemea\b/, 'emea'],
  [/\b(eu|european union)\b/, 'eu'],
  [/\beurope\b/, 'europe'],
  [/\bnorth america\b/, 'north_america'],
  [/\b(latam|latin america|south america)\b/, 'latam'],
  [/\bamericas\b/, 'americas'],
  [/\b(apac|asia pacific)\b/, 'apac'],
  [/\bmiddle east\b/, 'middle_east'],
  [/\bafrica\b/, 'africa'],
];

/**
 * The countries and regions a listing's location names ("Remote - Germany", "Berlin, DE",
 * "US / Canada", "Remote (Europe)"). Coarse: a city alone names nothing.
 */
export function listedPlace(text: string): { countries: string[]; regions: RemoteRegion[] } {
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const regions = REGION_WORDS.filter(([re]) => re.test(folded)).map(([, r]) => r);
  const countries = new Set<string>();
  const pieces = text.split(/[,;|/()·•]+|\s+[-–—]\s+|\s+or\s+|\s+and\s+|\s*&\s*/);
  for (const raw of pieces) {
    const piece = raw.replace(/^\s*(remote|hybrid|on-?site|office)\s*[:-]?\s*/i, '').trim();
    if (!piece) continue;
    // Two-letter pieces only as written codes ("DE", "US"), not words.
    const code =
      piece.length === 2
        ? /^[A-Z]{2}$/.test(piece)
          ? countryCode(piece)
          : null
        : countryCode(piece);
    if (code) countries.add(code);
    else if (/^(usa|u\.s\.a?\.?)$/i.test(piece)) countries.add('US');
  }
  return { countries: [...countries], regions };
}
