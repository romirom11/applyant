// One posting per role, however many places list it. No model decides this:
//
//   1 exact keys   canonical URL · the job's ATS id (from any of its URLs) · normalised
//                  company + title
//   2 MinHash      over description shingles, within the same company and a similar title:
//                  catches the same role reposted under another URL (a board linking the
//                  company's own page, a career page re-listing its ATS job)
//   3 embeddings   a tie-breaker for MinHash's grey zone only
//
// Guards keep distinct postings apart: two different ATS ids are two jobs, and so are two ids
// from the same source (a board listing "Sales Specialist" in Munich and in Hesse).
//
// One exception to the guards: a company's own board (an ATS list, a career page) listing the
// same role once per country ("Senior Backend Engineer | UK | Remote", "… | Germany | Remote")
// with essentially the same description is one posting with several locations. Same source,
// same title once its location parts are taken off, a different location, MinHash ≥ 0.8.
import { isNotNull } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { postingSources, postings } from '../../db/schema.ts';
import type { Embedder } from '../../models/embeddings.ts';
import { countryCode } from '../scoring/structured.ts';
import { canonicalUrl } from './canonical-url.ts';
import { atsJobKey } from './readers/ats-embed.ts';
import type { Listing } from './readers/types.ts';

// ---- Keys -------------------------------------------------------------------------------

const COMPANY_SUFFIX =
  /\b(inc|incorporated|ltd|limited|llc|gmbh|ag|sa|sas|sarl|srl|sl|bv|nv|plc|oy|ab|as|aps|corp|corporation|co|company|group|holdings?)\b/g;

function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** "Acme, Inc." · "ACME GmbH" · "acme.io" → "acme". */
export function companyKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = fold(name)
    .replace(/\.(io|ai|com|co|dev|app|tech)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(COMPANY_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key || null;
}

function words(text: string): string[] {
  return fold(text)
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Case, accents and punctuation removed; the words themselves (and their order) kept. */
export function titleKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const key = words(title).join(' ');
  return key || null;
}

const PLACE_WORDS =
  /^(remote|hybrid|on-?site|in-?office|office|anywhere|worldwide|global|europe|emea|eu|apac|latam|americas|north america|us|usa|uk|and|or|only|based|first|friendly|fully|100%|remote first|timezones?|time zones?)$/;

/** Two-letter country codes common enough in titles; others read as words ("AI", "ML", "Go"). */
const TITLE_CODES = new Set(
  'us uk gb eu ca de fr es nl ie pl pt gr se au sg nz br mx ch dk fi jp il'.split(' '),
);

function placeWord(w: string): boolean {
  if (PLACE_WORDS.test(w)) return true;
  if (w.length === 2) return TITLE_CODES.has(w);
  return countryCode(w) !== null;
}

/** A title piece that only says where ("UK", "Remote", "Remote - Germany", "Berlin, Germany"). */
function placePiece(piece: string, location: string | null): boolean {
  const p = fold(piece)
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .trim();
  if (!p) return true;
  const loc = location ? ` ${fold(location).replace(/[^\p{L}\p{N}%]+/gu, ' ')} ` : '';
  if (loc.includes(` ${p} `)) return true;
  if (p.length > 2 && countryCode(p) !== null) return true;
  return p.split(' ').every((w) => placeWord(w) || loc.includes(` ${w} `));
}

/**
 * The title with the pieces that only say where taken off: "Backend Engineer | UK | Remote"
 * and "Backend Engineer (Remote, Germany)" → "backend engineer". Null when nothing is left.
 */
export function roleTitleKey(
  title: string | null | undefined,
  location?: string | null,
): string | null {
  if (!title) return null;
  let t = title.replace(/\(([^()]*)\)/g, (m, inner: string) =>
    placePiece(inner, location ?? null) ? ' ' : m,
  );
  const pieces = t.split(/\s+[|–—-]\s+|\s*\|\s*|,\s+/);
  while (pieces.length > 1 && placePiece(pieces[pieces.length - 1] ?? '', location ?? null))
    pieces.pop();
  t = pieces.join(' ');
  return titleKey(t);
}

/** A listing's place, folded, for "is this another location of the same role?". */
function placeKey(l: Pick<Listing, 'title' | 'location'>): string {
  return `${fold(l.location ?? '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}\n${titleKey(l.title) ?? ''}`;
}

/** Word-set Jaccard of two titles, 0–1. */
export function titleSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const x = new Set(words(a));
  const y = new Set(words(b));
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const union = x.size + y.size - both;
  return union ? both / union : 0;
}

/** The job's ATS id from whichever of the listing's URLs shows it. */
export function listingAtsKey(l: Pick<Listing, 'url' | 'applyUrl' | 'sourceUrl'>): string | null {
  return atsJobKey(l.url) ?? atsJobKey(l.applyUrl) ?? atsJobKey(l.sourceUrl);
}

// ---- MinHash ------------------------------------------------------------------------------

export const MINHASH_SIZE = 64;
const SHINGLE = 4;
/** Fewer shingles than this: too little text to compare. */
const MIN_SHINGLES = 8;
/** Estimated Jaccard at or above which two descriptions are the same posting. */
export const MINHASH_SAME = 0.8;
/** Below MINHASH_SAME but at least this: the embeddings decide. */
export const MINHASH_MAYBE = 0.5;
/** Cosine at or above which the tie-breaker calls them the same. */
export const EMBEDDING_SAME = 0.9;
/** Titles at least this similar (word Jaccard) before descriptions are compared at all. */
const TITLE_NEAR = 0.5;

const SEEDS = (() => {
  const out = new Uint32Array(MINHASH_SIZE);
  let x = 0x2545f491;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x >>> 0;
  }
  return out;
})();

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** MinHash signature of a text's word 4-shingles; null when the text is too short. */
export function minhash(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const w = words(text).slice(0, 3000);
  const shingles = new Set<number>();
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    shingles.add(fnv1a(w.slice(i, i + SHINGLE).join(' ')));
  }
  if (shingles.size < MIN_SHINGLES) return null;
  const sig = new Array<number>(MINHASH_SIZE).fill(0xffffffff);
  for (const h of shingles) {
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const v = mix(h ^ (SEEDS[i] ?? 0));
      if (v < (sig[i] ?? 0xffffffff)) sig[i] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two signatures, 0–1. */
export function minhashSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---- The index ---------------------------------------------------------------------------

interface Entry {
  /** A posting id, or a negative placeholder for a posting this run will create. */
  id: number;
  url: string;
  atsKey: string | null;
  companyKey: string | null;
  title: string | null;
  titleKey: string | null;
  /** The title without its location pieces (location variants share it). */
  roleKey: string | null;
  /** Where the listings it was made from are ("title\nlocation" per variant). */
  places: Set<string>;
  minhash: number[] | null;
  /** Description for the embedding tie-break (loaded when needed for known postings). */
  text: string | null;
  /** search source id → the ids it lists this posting under. */
  links: Map<number, Set<string>>;
}

export interface Candidate {
  listing: Listing;
  /** The search source that listed it. */
  sourceId: number;
  /**
   * The source is the company's own board (an ATS list or a career page): its per-country
   * copies of one role are one posting (see the header).
   */
  companyBoard?: boolean;
}

/** How a cluster was matched to a posting (for the run's notes and tests). */
export type MatchedBy =
  | 'url'
  | 'ats'
  | 'company_title'
  | 'location_variant'
  | 'minhash'
  | 'embedding'
  | 'new';

export interface Cluster {
  /** The known posting these listings are, or null: a new posting. */
  postingId: number | null;
  /** For a new posting: the URL it gets (the first listing's canonical URL). */
  canonicalUrl: string;
  atsKey: string | null;
  minhash: number[] | null;
  matchedBy: MatchedBy;
  candidates: Candidate[];
  /** Every location its listings give, in order, without repeats. */
  locations: string[];
  /** Set when the cluster joins a role's per-country copies: the title without the place. */
  roleTitle: string | null;
}

export class DedupeIndex {
  private readonly entries = new Map<number, Entry>();
  private readonly byUrl = new Map<string, number>();
  private readonly byAts = new Map<string, number>();
  private readonly byCompanyTitle = new Map<string, number[]>();
  private readonly byCompany = new Map<string, number[]>();
  private nextTemp = -1;

  /** Every posting's keys, with the search sources that list it. */
  static load(conn: Conn): DedupeIndex {
    const index = new DedupeIndex();
    const rows = conn
      .select({
        id: postings.id,
        canonicalUrl: postings.canonicalUrl,
        applyUrl: postings.applyUrl,
        atsKey: postings.atsKey,
        company: postings.company,
        title: postings.title,
        minhash: postings.minhash,
      })
      .from(postings)
      .all();
    const links = conn
      .select({
        postingId: postingSources.postingId,
        sourceId: postingSources.searchSourceId,
        externalId: postingSources.externalId,
        url: postingSources.url,
      })
      .from(postingSources)
      .where(isNotNull(postingSources.searchSourceId))
      .all();
    const linkMap = new Map<number, Map<number, Set<string>>>();
    const extraUrls: Array<{ id: number; url: string }> = [];
    for (const l of links) {
      if (l.url) extraUrls.push({ id: l.postingId, url: l.url });
      if (l.sourceId === null || l.externalId === null) continue;
      const m = linkMap.get(l.postingId) ?? new Map<number, Set<string>>();
      const set = m.get(l.sourceId) ?? new Set<string>();
      set.add(l.externalId);
      m.set(l.sourceId, set);
      linkMap.set(l.postingId, m);
    }
    for (const r of rows) {
      index.put({
        id: r.id,
        url: r.canonicalUrl,
        atsKey: r.atsKey ?? atsJobKey(r.canonicalUrl) ?? atsJobKey(r.applyUrl),
        companyKey: companyKey(r.company),
        title: r.title,
        titleKey: titleKey(r.title),
        roleKey: roleTitleKey(r.title),
        places: new Set(),
        minhash: r.minhash ?? null,
        text: null,
        links: linkMap.get(r.id) ?? new Map(),
      });
    }
    // A posting's other listings (a role's per-country copies) lead to it by their URL and
    // ATS id too, so the next run finds them by the exact keys.
    for (const { id, url } of extraUrls) {
      if (!index.entries.has(id)) continue;
      let canon: string | null = null;
      try {
        canon = canonicalUrl(url);
      } catch {}
      if (canon && !index.byUrl.has(canon)) index.byUrl.set(canon, id);
      const ats = atsJobKey(url);
      if (ats && !index.byAts.has(ats)) index.byAts.set(ats, id);
    }
    return index;
  }

  get size(): number {
    return this.entries.size;
  }

  private put(e: Entry): void {
    this.entries.set(e.id, e);
    this.byUrl.set(e.url, e.id);
    if (e.atsKey && !this.byAts.has(e.atsKey)) this.byAts.set(e.atsKey, e.id);
    if (e.companyKey) {
      this.byCompany.set(e.companyKey, [...(this.byCompany.get(e.companyKey) ?? []), e.id]);
      if (e.titleKey) {
        const k = `${e.companyKey}\n${e.titleKey}`;
        this.byCompanyTitle.set(k, [...(this.byCompanyTitle.get(k) ?? []), e.id]);
      }
    }
  }

  /** Records that `sourceId` lists entry `id` under `externalId` (so the guard sees it). */
  private link(id: number, c: Candidate): void {
    const e = this.entries.get(id);
    if (!e || !c.listing.externalId) return;
    const set = e.links.get(c.sourceId) ?? new Set<string>();
    set.add(c.listing.externalId);
    e.links.set(c.sourceId, set);
  }

  /** Two different ATS ids, or two ids from the same source: different postings. */
  private conflicts(e: Entry, c: Candidate, atsKey: string | null): boolean {
    if (atsKey && e.atsKey && atsKey !== e.atsKey) return true;
    const ext = c.listing.externalId;
    const ids = e.links.get(c.sourceId);
    return !!(ext && ids && ids.size > 0 && !ids.has(ext));
  }

  /**
   * Groups the run's listings into postings: known ones (by key or by similarity) and new
   * ones. `textOf` loads a known posting's description for the embedding tie-break.
   */
  async plan(
    items: Candidate[],
    o: {
      embedder?: Embedder | null;
      signal?: AbortSignal;
      textOf?: (postingId: number) => string | null;
    } = {},
  ): Promise<Cluster[]> {
    const clusters = new Map<number, Cluster>();
    const order: number[] = [];
    for (const c of items) {
      o.signal?.throwIfAborted();
      let url: string;
      try {
        url = canonicalUrl(c.listing.url);
      } catch {
        continue;
      }
      const atsKey = listingAtsKey(c.listing);
      const sig = minhash(c.listing.description);
      const match = await this.match(c, url, atsKey, sig, o);
      let id: number;
      let matchedBy: MatchedBy;
      if (match) {
        ({ id, by: matchedBy } = match);
      } else {
        id = this.nextTemp--;
        matchedBy = 'new';
        this.put({
          id,
          url,
          atsKey,
          companyKey: companyKey(c.listing.company),
          title: c.listing.title,
          titleKey: titleKey(c.listing.title),
          roleKey: roleTitleKey(c.listing.title, c.listing.location),
          places: new Set(),
          minhash: sig,
          text: c.listing.description,
          links: new Map(),
        });
      }
      // Other URLs of this listing lead to the same posting from now on.
      if (!this.byUrl.has(url)) this.byUrl.set(url, id);
      if (atsKey && !this.byAts.has(atsKey)) this.byAts.set(atsKey, id);
      this.link(id, c);
      this.entries.get(id)?.places.add(placeKey(c.listing));
      let cluster = clusters.get(id);
      if (!cluster) {
        cluster = {
          postingId: id > 0 ? id : null,
          canonicalUrl: this.entries.get(id)?.url ?? url,
          atsKey,
          minhash: sig,
          matchedBy,
          candidates: [],
          locations: [],
          roleTitle: null,
        };
        clusters.set(id, cluster);
        order.push(id);
      }
      cluster.atsKey ??= atsKey;
      cluster.minhash ??= sig;
      cluster.candidates.push(c);
      const loc = c.listing.location?.trim();
      if (loc && !cluster.locations.includes(loc)) cluster.locations.push(loc);
      if (matchedBy === 'location_variant' && cluster.roleTitle === null) {
        const first = cluster.candidates[0]?.listing;
        cluster.roleTitle = first ? roleTitle(first.title, first.location) : null;
      }
    }
    return order.map((id) => clusters.get(id)).filter((c): c is Cluster => c !== undefined);
  }

  /**
   * The same role, listed again by the same company board for another location: the same
   * title once its place pieces are off, another place, and the same description.
   */
  private locationVariant(c: Candidate, company: string, sig: number[]): number | null {
    if (!c.companyBoard) return null;
    const role = roleTitleKey(c.listing.title, c.listing.location);
    if (!role) return null;
    const place = placeKey(c.listing);
    for (const id of this.byCompany.get(company) ?? []) {
      const e = this.entries.get(id);
      if (!e?.minhash || e.roleKey !== role || !e.links.has(c.sourceId)) continue;
      if (e.places.has(place) || (e.places.size === 0 && e.titleKey === titleKey(c.listing.title)))
        continue;
      if (minhashSimilarity(sig, e.minhash) >= MINHASH_SAME) return id;
    }
    return null;
  }

  private async match(
    c: Candidate,
    url: string,
    atsKey: string | null,
    sig: number[] | null,
    o: {
      embedder?: Embedder | null;
      signal?: AbortSignal;
      textOf?: (postingId: number) => string | null;
    },
  ): Promise<{ id: number; by: MatchedBy } | null> {
    const byUrl = this.byUrl.get(url);
    if (byUrl !== undefined) return { id: byUrl, by: 'url' };
    if (atsKey) {
      const byAts = this.byAts.get(atsKey);
      if (byAts !== undefined) return { id: byAts, by: 'ats' };
    }
    const company = companyKey(c.listing.company);
    const title = titleKey(c.listing.title);
    if (!company) return null;
    if (title) {
      for (const id of this.byCompanyTitle.get(`${company}\n${title}`) ?? []) {
        const e = this.entries.get(id);
        if (e && !this.conflicts(e, c, atsKey)) return { id, by: 'company_title' };
      }
    }
    if (!sig) return null;
    const variant = this.locationVariant(c, company, sig);
    if (variant !== null) return { id: variant, by: 'location_variant' };
    let best: { e: Entry; sim: number } | null = null;
    for (const id of this.byCompany.get(company) ?? []) {
      const e = this.entries.get(id);
      if (!e?.minhash || this.conflicts(e, c, atsKey)) continue;
      if (titleSimilarity(e.title, c.listing.title) < TITLE_NEAR) continue;
      const sim = minhashSimilarity(sig, e.minhash);
      if (!best || sim > best.sim) best = { e, sim };
    }
    if (!best || best.sim < MINHASH_MAYBE) return null;
    if (best.sim >= MINHASH_SAME) return { id: best.e.id, by: 'minhash' };
    // The grey zone: similar enough to ask the embeddings, not enough to be sure.
    if (!o.embedder || !c.listing.description) return null;
    const other = best.e.text ?? (best.e.id > 0 ? (o.textOf?.(best.e.id) ?? null) : null);
    if (!other) return null;
    const [a, b] = await o.embedder.embed([c.listing.description, other], 'document', o.signal);
    if (a && b && cosine(a, b) >= EMBEDDING_SAME) return { id: best.e.id, by: 'embedding' };
    return null;
  }
}

/** The title without its place pieces, as written ("Backend Engineer | UK | Remote" → "Backend Engineer"). */
export function roleTitle(title: string, location: string | null): string {
  let t = title.replace(/\s*\(([^()]*)\)/g, (m, inner: string) =>
    placePiece(inner, location) ? '' : m,
  );
  const pieces = t.split(/(\s+[|–—-]\s+|\s*\|\s*|,\s+)/);
  while (pieces.length > 2 && placePiece(pieces[pieces.length - 1] ?? '', location)) {
    pieces.splice(-2, 2);
  }
  t = pieces.join('').trim();
  return t || title;
}
