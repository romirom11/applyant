// Feeds: JSON (JSON Feed, schema.org JobPosting JSON), RSS, Atom, and JSON-LD JobPosting nodes
// in a career page's HTML. A feed is the source's whole list (complete), unless it says there
// is a next page.
import { DOMParser, parseHTML } from 'linkedom';
import { get } from './http.ts';
import {
  decodeEntities,
  type Listing,
  plainText,
  type ReaderContext,
  type ReaderRun,
  str,
} from './types.ts';

export type FeedFormat = 'json-feed' | 'json-ld' | 'rss' | 'atom';

export interface ParsedFeed {
  format: FeedFormat;
  listings: Listing[];
  complete: boolean;
  /** The feed's own title (a company name, a board's name). */
  title: string | null;
}

type Node = Record<string, unknown>;

function abs(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function listing(p: Partial<Listing> & { url: string; title: string }): Listing {
  return {
    sourceUrl: p.url,
    externalId: null,
    company: null,
    location: null,
    remote: null,
    team: null,
    description: null,
    applyUrl: null,
    postedAt: null,
    ...p,
  };
}

// ---- JSON-LD JobPosting ----------------------------------------------------------------

function types(node: Node): string[] {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
}

/** Every JobPosting node in a JSON-LD value: arrays, @graph and ItemList included. */
export function jobPostingNodes(value: unknown): Node[] {
  const out: Node[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = node as Node;
    if (types(obj).includes('JobPosting')) {
      out.push(obj);
      return;
    }
    visit(obj['@graph'], depth + 1);
    visit(obj.itemListElement, depth + 1);
    if (types(obj).includes('ListItem')) visit(obj.item, depth + 1);
  };
  visit(value, 0);
  return out;
}

function orgName(org: unknown): string | null {
  if (typeof org === 'string') return str(org);
  if (org && typeof org === 'object') return str((org as Node).name);
  return null;
}

function places(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const node = item as Node;
    const address = (node.address ?? node) as Node | string;
    if (typeof address === 'string') {
      out.push(address);
      continue;
    }
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((p) => (p && typeof p === 'object' ? str((p as Node).name) : str(p)))
      .filter((p): p is string => !!p);
    const name = str(node.name);
    if (parts.length) out.push([...new Set(parts)].join(', '));
    else if (name) out.push(name);
  }
  return out;
}

/** A JobPosting node → a listing; null when it has no title or has expired. */
export function jobPostingListing(node: Node, pageUrl: string, now: Date): Listing | null {
  const title = str(node.title) ?? str(node.name);
  if (!title) return null;
  const validThrough = str(node.validThrough);
  if (validThrough) {
    const until = new Date(validThrough);
    if (!Number.isNaN(until.getTime()) && until.getTime() < now.getTime()) return null;
  }
  const url = abs(str(node.url) ?? str(node.sameAs) ?? str(node['@id']), pageUrl) ?? pageUrl;
  const identifier = node.identifier;
  const externalId =
    (identifier && typeof identifier === 'object'
      ? str((identifier as Node).value)
      : str(identifier)) ?? null;
  const remote = (
    Array.isArray(node.jobLocationType) ? node.jobLocationType : [node.jobLocationType]
  )
    .map((t) => String(t ?? '').toUpperCase())
    .includes('TELECOMMUTE');
  const location = [...places(node.jobLocation), ...places(node.applicantLocationRequirements)];
  return listing({
    url,
    title: decodeEntities(title),
    externalId: externalId ?? (url !== pageUrl ? url : null),
    company: orgName(node.hiringOrganization),
    location: location.length ? [...new Set(location)].join('; ') : remote ? 'Remote' : null,
    remote: remote ? true : null,
    description: plainText(str(node.description)),
    postedAt: str(node.datePosted),
    team: str(node.occupationalCategory) ?? str(node.industry),
  });
}

function jsonLdBlocks(html: string): string[] {
  const { document } = parseHTML(html);
  return [...document.querySelectorAll('script[type="application/ld+json"]')].map(
    (s) => s.textContent ?? '',
  );
}

/** JobPosting listings from a page's JSON-LD blocks (a career page listing its jobs). */
export function jsonLdListings(html: string, pageUrl: string, now: Date): Listing[] {
  const nodes: Node[] = [];
  for (const block of jsonLdBlocks(html)) {
    try {
      nodes.push(...jobPostingNodes(JSON.parse(block)));
    } catch {
      // Malformed JSON-LD is common; skip the block.
    }
  }
  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const node of nodes) {
    const l = jobPostingListing(node, pageUrl, now);
    if (!l) continue;
    const key = l.externalId ?? `${l.url}#${l.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

// ---- RSS / Atom / JSON Feed -----------------------------------------------------------

interface ElementLike {
  querySelector(sel: string): ElementLike | null;
  querySelectorAll(sel: string): ArrayLike<ElementLike>;
  getAttribute(name: string): string | null;
  textContent: string | null;
  tagName: string;
}

function child(el: ElementLike, ...names: string[]): string | null {
  for (const name of names) {
    // Namespaced tags (job:location) can't be written as CSS selectors: match by tag name.
    for (const c of Array.from(el.querySelectorAll('*'))) {
      if (c.tagName.toLowerCase() === name.toLowerCase()) {
        const text = str(c.textContent);
        if (text) return text;
      }
    }
  }
  return null;
}

function parseXmlFeed(text: string, url: string): ParsedFeed | null {
  const doc = new DOMParser().parseFromString(text, 'text/xml') as unknown as ElementLike;
  const rss = Array.from(doc.querySelectorAll('item'));
  const atom = Array.from(doc.querySelectorAll('entry'));
  if (!rss.length && !atom.length) {
    const isFeed =
      doc.querySelector('rss') ?? doc.querySelector('feed') ?? doc.querySelector('channel');
    return isFeed ? { format: 'rss', listings: [], complete: true, title: null } : null;
  }
  const hasNext = Array.from(doc.querySelectorAll('link')).some(
    (l) => l.getAttribute('rel') === 'next',
  );
  if (rss.length) {
    const channel = doc.querySelector('channel');
    return {
      format: 'rss',
      complete: !hasNext,
      title: channel ? child(channel, 'title') : null,
      listings: rss.flatMap((item) => {
        const title = child(item, 'title');
        const link = abs(child(item, 'link') ?? child(item, 'guid'), url);
        if (!title || !link) return [];
        return [
          listing({
            url: link,
            title: decodeEntities(title),
            externalId: child(item, 'guid') ?? link,
            location: child(item, 'region', 'location', 'job:location', 'country'),
            description: plainText(child(item, 'description', 'content:encoded')),
            postedAt: child(item, 'pubDate', 'dc:date'),
            team: child(item, 'category'),
          }),
        ];
      }),
    };
  }
  const feed = doc.querySelector('feed');
  return {
    format: 'atom',
    complete: !hasNext,
    title: feed ? child(feed, 'title') : null,
    listings: atom.flatMap((entry) => {
      const title = child(entry, 'title');
      const links = Array.from(entry.querySelectorAll('link'));
      const alt =
        links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? links[0];
      const link = abs(alt?.getAttribute('href') ?? null, url);
      if (!title || !link) return [];
      return [
        listing({
          url: link,
          title: decodeEntities(title),
          externalId: child(entry, 'id') ?? link,
          description: plainText(child(entry, 'content', 'summary')),
          postedAt: child(entry, 'published', 'updated'),
          location: child(entry, 'location'),
        }),
      ];
    }),
  };
}

function parseJsonFeed(data: unknown, url: string, now: Date): ParsedFeed | null {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Node;
    if (typeof obj.version === 'string' && obj.version.includes('jsonfeed.org')) {
      const items = Array.isArray(obj.items) ? (obj.items as Node[]) : [];
      return {
        format: 'json-feed',
        complete: !obj.next_url,
        title: str(obj.title),
        listings: items.flatMap((item) => {
          const title = str(item.title);
          const link = abs(str(item.url) ?? str(item.external_url), url);
          if (!title || !link) return [];
          return [
            listing({
              url: link,
              title,
              externalId: str(item.id) ?? link,
              description: str(item.content_text) ?? plainText(str(item.content_html)),
              postedAt: str(item.date_published),
            }),
          ];
        }),
      };
    }
  }
  const nodes = jobPostingNodes(data);
  if (nodes.length === 0) return null;
  return {
    format: 'json-ld',
    complete: true,
    title: null,
    listings: nodes
      .map((n) => jobPostingListing(n, url, now))
      .filter((l): l is Listing => l !== null),
  };
}

/**
 * Reads a feed of any kind from its text. HTML counts as a feed when it carries JobPosting
 * JSON-LD. Null: not a feed.
 */
export function parseFeed(
  text: string,
  contentType: string,
  url: string,
  now: Date,
): ParsedFeed | null {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (/json/.test(contentType) || head.startsWith('{') || head.startsWith('[')) {
    try {
      return parseJsonFeed(JSON.parse(text), url, now);
    } catch {
      return null;
    }
  }
  if (/xml|rss|atom/.test(contentType) || head.startsWith('<?xml') || /^<(rss|feed)\b/.test(head)) {
    const parsed = parseXmlFeed(text, url);
    if (parsed) return parsed;
  }
  if (/html/.test(contentType) || head.includes('<html') || head.startsWith('<!doctype')) {
    const listings = jsonLdListings(text, url, now);
    if (listings.length === 0) return null;
    // A paginated career page lists only part of its jobs.
    const paged = /<link[^>]+rel=["']?next\b/i.test(text);
    return { format: 'json-ld', listings, complete: !paged, title: null };
  }
  return null;
}

/** Feed links a page advertises (`<link rel="alternate" type="application/rss+xml">`). */
export function feedLinks(html: string, pageUrl: string): string[] {
  const { document } = parseHTML(html);
  return [...document.querySelectorAll('link[rel~="alternate"]')]
    .filter((l) => /rss|atom|feed\+json|application\/json/i.test(l.getAttribute('type') ?? ''))
    .map((l) => abs(l.getAttribute('href'), pageUrl))
    .filter((u): u is string => u !== null);
}

export interface FeedRun extends ReaderRun {
  format: FeedFormat;
  title: string | null;
}

/** Reads a feed URL; throws when it isn't one. */
export async function readFeed(url: string, ctx: ReaderContext): Promise<FeedRun> {
  const res = await get(ctx.fetch, url, ctx.signal);
  const feed = parseFeed(res.text, res.contentType, res.url, ctx.now);
  if (!feed) throw new Error(`${url} is not a feed (no RSS, Atom, JSON Feed or JobPosting data)`);
  return {
    ...feed,
    note: `${feed.format}: ${feed.listings.length} jobs${feed.complete ? '' : ' (one page of several)'}`,
  };
}
