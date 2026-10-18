// Role-first job search: every company on the ATSs that is hiring for a strategy's titles, not
// only the boards Applyant knows. The strategy's queries are the search terms. Each listing
// carries its company board, and the search commit adds the boards behind matched listings to
// the ATS index (watchlist.ts), so later runs search those companies in full.
//
//   workable-search         jobs.workable.com/api/v1/jobs?query="…" with workplace=remote or a
//                           location (Workable's own job search over every account; 20 a page)
//                           → for the jobs the strategy wants, the company's Workable account
//                           (the one its job form's GDPR link names, else its name), read
//                           through the widget API one at a time; a job whose account isn't
//                           found stays a jobs.workable.com page
//   smartrecruiters-search  jobs.smartrecruiters.com/sr-jobs/search?keyword="…" (every company,
//                           100 a page: the postings each company's API lists)
//   ats-web-search          site: queries (web-search.ts) for Greenhouse, Ashby and Lever job
//                           pages, which have no search of their own → each hit's board, read
//                           through its list API
//
// None is a complete list. Requests are capped per read; a strategy with more queries than one
// read takes gets the next slice on its next run (`ctx.turn`).
import { type AtsRun, readAtsBoardShared, smartRecruitersListing } from './ats-api.ts';
import { type Ats, type AtsBoard, atsJobKey, boardFromUrl } from './ats-embed.ts';
import { get, getJson, HttpError } from './http.ts';
import { type Listing, plainText, type ReaderContext, type ReaderRun, str } from './types.ts';
import { NoSearchNow, type SearchHit } from './web-search.ts';

type Node = Record<string, unknown>;

function arr(value: unknown): Node[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Node[]) : [];
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
}

const companies = (n: number) => `${n} compan${n === 1 ? 'y' : 'ies'}`;

/** The words of each query a search can take; the "-word" exclusions apply afterwards. */
export function searchPhrases(queries: string[]): string[] {
  const phrases = queries.map((q) =>
    q
      .replace(/(^|\s)-\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  );
  return [...new Set(phrases.filter(Boolean))];
}

/** `n` items from the run's turn on, wrapping round: each run takes the next slice. */
export function sliceFor<T>(items: T[], turn: number, n: number): T[] {
  if (items.length <= n) return items;
  const start = (turn * n) % items.length;
  return [...items.slice(start), ...items.slice(0, start)].slice(0, n);
}

/** Pages per query: what the read's request cap leaves, between one and three. */
function pagesEach(cap: number, asks: number): number {
  return Math.min(3, Math.max(1, Math.floor(cap / Math.max(asks, 1))));
}

// A phrase, so both searches match the words together (unquoted, they match any of them).
const quoted = (p: string) => (p.includes(' ') ? `"${p}"` : p);

const REMOTE = /^(remote|anywhere|worldwide|remote[ -]?only)$/i;
const REGION =
  /^(europe|eu|eea|emea|dach|nordics|cee|apac|latam|americas|north america|global|international)$/i;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A board's listings, each knowing its board and company (Ashby and Lever don't name it). */
function boardListings(run: AtsRun, board: AtsBoard, company: string | null): Listing[] {
  return run.listings.map((l) => ({
    ...l,
    company: l.company ?? run.company ?? company ?? board.token,
    board,
  }));
}

// ---- Workable: its job search over every account ------------------------------------------

export const WORKABLE_REQUESTS = 12;
/** Companies whose account one read looks up (most are known after the first runs). */
export const WORKABLE_COMPANIES = 20;
/** A company's Workable account doesn't move: it's looked up again after a week. */
const ACCOUNT_MS = 7 * 24 * 3_600_000;

/** What Workable's search is asked for: remote jobs, and each named place (not regions). */
export function workableWhere(locations: string[]): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const places = locations.map((l) => l.trim()).filter(Boolean);
  if (places.some((l) => REMOTE.test(l))) out.push({ workplace: 'remote' });
  for (const l of places) if (!REMOTE.test(l) && !REGION.test(l)) out.push({ location: l });
  return out.length ? out : [{}];
}

function workableJob(j: Node): Listing | null {
  const url = str(j.url);
  const title = str(j.title);
  if (!url || !title) return null;
  const all = Array.isArray(j.locations) ? j.locations.map(String) : [];
  const where = all.filter((l) => l !== 'TELECOMMUTE').join('; ') || null;
  const remote = j.workplace === 'remote' || all.includes('TELECOMMUTE');
  return {
    url,
    sourceUrl: url,
    externalId: str(j.id),
    title,
    company: str((j.company as Node | undefined)?.title),
    location: remote ? `Remote${where ? ` (${where})` : ''}` : where,
    remote: remote ? true : j.workplace === 'on_site' || j.workplace === 'hybrid' ? false : null,
    team: str(j.department),
    description: plainText([str(j.description), str(j.requirementsSection)].join('\n')),
    applyUrl: null,
    postedAt: str(j.created),
  };
}

// "Acme Inc." is usually the account acme.
const LEGAL =
  /[\s,]+(inc|llc|ltd|limited|gmbh|ag|sa|s\.a|corp|corporation|plc|bv|b\.v|srl|oy|ab|sas)\.?$/;

const dashed = (s: string) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Account names a company is likely under on apply.workable.com: "Tiger Analytics Inc." →
 * tiger-analytics, "Arabic.AI" → arabicai, its website's name, and the "-1" a second account gets.
 */
export function accountGuesses(name: string | null, website: string | null): string[] {
  const plain = dashed(
    (name ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(LEGAL, ''),
  );
  let label: string | null = null;
  try {
    label = website
      ? (new URL(website).hostname.replace(/^www\./, '').split('.')[0] ?? null)
      : null;
  } catch {
    // Not a URL: the name's guesses only.
  }
  const out = new Set(
    [plain, plain.replace(/-/g, ''), label?.toLowerCase(), plain && `${plain}-1`].filter(
      (g): g is string => !!g && /^[a-z0-9][a-z0-9_-]*$/.test(g),
    ),
  );
  return [...out].slice(0, 4);
}

const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

interface WorkableCompany {
  id: string;
  name: string | null;
  website: string | null;
  jobs: Listing[];
}

/**
 * The company's account: the one its job form's GDPR link names, else the first guess whose
 * board lists its jobs; null when there's none. Throws when Workable couldn't be asked (it
 * answers bursts with 429), so that isn't remembered as "no account".
 */
async function workableAccount(c: WorkableCompany, ctx: ReaderContext): Promise<string | null> {
  const titles = new Set(c.jobs.map((l) => titleKey(l.title)));
  const lists = async (token: string) => {
    try {
      const run = await readAtsBoardShared('workable', token, ctx);
      return run.listings.some((l) => titles.has(titleKey(l.title)));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return false;
      throw err;
    }
  };
  const job = c.jobs[0]?.externalId;
  const form = job
    ? await get(
        ctx.fetch,
        `https://jobs.workable.com/api/v1/jobs/${encodeURIComponent(job)}/form?includeAccountMetadata=true`,
        ctx.signal,
        { accept: 'application/json', allow: [404] },
      )
    : null;
  const named =
    form && form.status < 400
      ? (form.text.match(/apply\.workable\.com\/([a-z0-9][a-z0-9_-]*)\//i)?.[1]?.toLowerCase() ??
        null)
      : null;
  const tokens = [...new Set([named, ...accountGuesses(c.name, c.website)])];
  for (const token of tokens) if (token && (await lists(token))) return token;
  return null;
}

export async function readWorkableSearch(ctx: ReaderContext): Promise<ReaderRun> {
  const phrases = searchPhrases(ctx.queries);
  if (phrases.length === 0) {
    return {
      listings: [],
      complete: false,
      note: 'Workable job search: the strategy has no queries',
    };
  }
  const wheres = workableWhere(ctx.locations ?? []);
  const asks = sliceFor(
    phrases.flatMap((p) => wheres.map((w) => ({ p, w }))),
    ctx.turn ?? 0,
    WORKABLE_REQUESTS,
  );
  const pages = pagesEach(WORKABLE_REQUESTS, asks.length);
  const seen = new Set<string>();
  const byCompany = new Map<string, WorkableCompany>();
  let jobs = 0;
  let wanted = 0;
  let failed = 0;
  let lastError: unknown = null;
  for (const { p, w } of asks) {
    let token: string | null = null;
    for (let page = 0; page < pages; page++) {
      ctx.signal.throwIfAborted();
      const url = new URL('https://jobs.workable.com/api/v1/jobs');
      url.searchParams.set('query', quoted(p));
      for (const [k, v] of Object.entries(w)) url.searchParams.set(k, v);
      if (token) url.searchParams.set('pageToken', token);
      let data: Node | null;
      try {
        ({ data } = await getJson<Node>(ctx.fetch, url.toString(), ctx.signal));
      } catch (err) {
        ctx.signal.throwIfAborted();
        failed++;
        lastError = err;
        break;
      }
      for (const j of arr(data?.jobs)) {
        const l = workableJob(j);
        if (!l?.externalId || seen.has(l.externalId)) continue;
        seen.add(l.externalId);
        jobs++;
        if (ctx.wants && !ctx.wants(l)) continue;
        wanted++;
        const co = (j.company ?? {}) as Node;
        const id = str(co.id) ?? l.company ?? l.externalId;
        const known = byCompany.get(id);
        if (known) known.jobs.push(l);
        else if (byCompany.size < WORKABLE_COMPANIES)
          byCompany.set(id, { id, name: l.company, website: str(co.website), jobs: [l] });
      }
      token = str(data?.nextPageToken);
      if (!token) break;
    }
  }
  if (failed > 0 && jobs === 0) throw lastError;

  // One company at a time: Workable's board API answers bursts with 429.
  const listings: Listing[] = [];
  let boards = 0;
  let later = 0;
  let slowDown: unknown = null;
  for (const c of byCompany.values()) {
    if (slowDown) {
      later++;
      continue;
    }
    try {
      const look = () => workableAccount(c, ctx);
      const account = ctx.shared
        ? await ctx.shared.memo(`workable-account:${c.id}`, ACCOUNT_MS, ctx.now, look)
        : await look();
      if (!account) {
        // No account to read: the jobs' own pages on Workable's job board.
        listings.push(...c.jobs);
        continue;
      }
      const run = await readAtsBoardShared('workable', account, ctx);
      boards++;
      listings.push(...boardListings(run, { ats: 'workable', token: account }, c.name));
    } catch (err) {
      ctx.signal.throwIfAborted();
      // Couldn't ask: the company's jobs come with a later run, under their board's URLs.
      later++;
      if (err instanceof HttpError && err.status === 429) slowDown = err;
    }
  }
  const note = [
    `Workable job search: ${wanted} of ${jobs} jobs fit, at ${companies(byCompany.size)}`,
    `${boards} of their boards read (${listings.length} jobs)`,
    ...(later
      ? [
          `${companies(later)} left for a later run${slowDown ? ' (Workable asked to slow down)' : ''}`,
        ]
      : []),
    ...(failed ? [`${failed} of ${asks.length} searches failed: ${message(lastError)}`] : []),
  ].join(' · ');
  return { listings, complete: false, note };
}

// ---- SmartRecruiters: its job search over every company ------------------------------------

export const SR_REQUESTS = 8;
const SR_SEARCH_PAGE = 100;

export async function readSmartRecruitersSearch(ctx: ReaderContext): Promise<ReaderRun> {
  const phrases = sliceFor(searchPhrases(ctx.queries), ctx.turn ?? 0, SR_REQUESTS);
  if (phrases.length === 0) {
    return {
      listings: [],
      complete: false,
      note: 'SmartRecruiters job search: the strategy has no queries',
    };
  }
  const locations = (ctx.locations ?? []).map((l) => l.trim()).filter(Boolean);
  const remoteOnly = locations.length > 0 && locations.every((l) => REMOTE.test(l));
  const pages = pagesEach(SR_REQUESTS, phrases.length);
  const listings: Listing[] = [];
  const seen = new Set<string>();
  let failed = 0;
  let lastError: unknown = null;
  for (const p of phrases) {
    for (let page = 0; page < pages; page++) {
      ctx.signal.throwIfAborted();
      const url = new URL('https://jobs.smartrecruiters.com/sr-jobs/search');
      url.searchParams.set('keyword', quoted(p));
      url.searchParams.set('limit', String(SR_SEARCH_PAGE));
      url.searchParams.set('offset', String(page * SR_SEARCH_PAGE));
      if (remoteOnly) url.searchParams.set('locationType', 'REMOTE');
      let data: Node | null;
      try {
        ({ data } = await getJson<Node>(ctx.fetch, url.toString(), ctx.signal));
      } catch (err) {
        ctx.signal.throwIfAborted();
        failed++;
        lastError = err;
        break;
      }
      const content = arr(data?.content);
      for (const j of content) {
        const company = str((j.company as Node | undefined)?.identifier);
        if (!company) continue;
        const l = smartRecruitersListing(j, company);
        if (!l?.externalId || seen.has(l.externalId)) continue;
        seen.add(l.externalId);
        listings.push({ ...l, board: { ats: 'smartrecruiters', token: company } });
      }
      const total = Number(data?.totalFound ?? 0);
      if (content.length < SR_SEARCH_PAGE / 2 || (page + 1) * SR_SEARCH_PAGE >= total) break;
    }
  }
  if (failed > 0 && listings.length === 0) throw lastError;
  const at = new Set(listings.map((l) => l.board?.token)).size;
  return {
    listings,
    complete: false,
    note: [
      `SmartRecruiters job search: ${listings.length} jobs at ${companies(at)} for ${phrases.length} quer${phrases.length === 1 ? 'y' : 'ies'}`,
      ...(failed ? [`${failed} of ${phrases.length} searches failed: ${message(lastError)}`] : []),
    ].join(' · '),
  };
}

// ---- Greenhouse, Ashby, Lever: web search for their job pages ------------------------------

export const WEB_QUERIES = 3;
/** Boards one read looks up from its hits. */
export const WEB_BOARDS = 10;
/** A query's results are kept a day: the next runs take other queries. */
const WEB_MS = 20 * 3_600_000;

export const WEB_SITES: ReadonlyArray<{ ats: Ats; site: string }> = [
  { ats: 'greenhouse', site: 'greenhouse.io' },
  { ats: 'ashby', site: 'jobs.ashbyhq.com' },
  { ats: 'lever', site: 'jobs.lever.co' },
];

/** The company a result's title names: "AI Engineer @ Acme" (Ashby), "Acme - AI Engineer" (Lever). */
export function hitCompany(ats: Ats, title: string | null): string | null {
  if (!title) return null;
  const m =
    ats === 'ashby'
      ? title.match(/\s@\s+(.+?)(?:\s+-\s+jobs\.ashbyhq\.com)?$/i)
      : ats === 'lever'
        ? title.match(/^(.+?)\s+-\s+/)
        : ats === 'greenhouse'
          ? title.match(/\sat\s+(.+)$/)
          : null;
  return m?.[1]?.trim() || null;
}

function hitListing(h: SearchHit): Listing {
  return {
    url: h.url,
    sourceUrl: h.url,
    externalId: null,
    title: h.title ?? '',
    company: null,
    location: null,
    remote: null,
    team: null,
    description: null,
    applyUrl: null,
    postedAt: null,
  };
}

export async function readAtsWebSearch(ctx: ReaderContext): Promise<ReaderRun> {
  const web = ctx.web;
  if (!web) throw new Error('web search is not available to this read');
  const asks = sliceFor(
    searchPhrases(ctx.queries).flatMap((p) => WEB_SITES.map((s) => `site:${s.site} ${quoted(p)}`)),
    ctx.turn ?? 0,
    WEB_QUERIES,
  );
  if (asks.length === 0) {
    return { listings: [], complete: false, note: 'Web search: the strategy has no queries' };
  }
  const hits: SearchHit[] = [];
  const problems: string[] = [];
  let searched = 0;
  let resting = false;
  for (const q of asks) {
    try {
      const search = () => web.search(q, ctx);
      const res = ctx.shared
        ? await ctx.shared.memo(`web:${q}`, WEB_MS, ctx.now, search)
        : await search();
      hits.push(...res.hits);
      searched++;
    } catch (err) {
      ctx.signal.throwIfAborted();
      problems.push(message(err));
      // Every engine is resting or the day's searches are used: later runs search again.
      if (err instanceof NoSearchNow) {
        resting = true;
        break;
      }
    }
  }
  if (searched === 0 && !resting && problems.length) throw new Error(problems[0]);

  // Job pages only (a board's front page or a blog post says nothing), the titles that fit.
  const boards = new Map<string, { board: AtsBoard; company: string | null }>();
  let jobHits = 0;
  for (const h of hits) {
    const board = atsJobKey(h.url) ? boardFromUrl(h.url) : null;
    if (!board) continue;
    jobHits++;
    if (h.title && ctx.wants && !ctx.wants(hitListing(h))) continue;
    const key = `${board.ats}:${board.token.toLowerCase()}`;
    if (!boards.has(key) && boards.size < WEB_BOARDS)
      boards.set(key, { board, company: hitCompany(board.ats, h.title) });
  }
  let read = 0;
  const each = await mapLimit([...boards.values()], 3, async ({ board, company }) => {
    const run = await readAtsBoardShared(board.ats, board.token, ctx).catch(() => null);
    if (!run) return [];
    read++;
    return boardListings(run, board, company);
  });
  ctx.signal.throwIfAborted();
  const listings = each.flat();
  return {
    listings,
    complete: false,
    note: [
      `Web search: ${searched} of ${asks.length} queries, ${jobHits} job pages, ${boards.size} boards that fit`,
      `${read} read (${listings.length} jobs)`,
      ...(problems.length ? [problems.join('; ')] : []),
    ].join(' · '),
  };
}
