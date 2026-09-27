// One URL per posting: the same page reached with tracking parameters, a fragment or a
// trailing slash must dedupe to the same row.

const TRACKING = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'referrer',
  'source',
  'src',
  'trk',
  'trackingid',
  'refid',
]);

export class InvalidUrlError extends Error {}

export function canonicalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidUrlError(`not a URL: "${input}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(`only http(s) URLs can be postings: "${input}"`);
  }
  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => {
      const k = key.toLowerCase();
      return !k.startsWith('utm_') && !TRACKING.has(k);
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}
