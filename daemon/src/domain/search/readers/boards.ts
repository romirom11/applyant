// Job boards with key-free lists: Hacker News "Who is hiring" (Algolia), RemoteOK, We Work
// Remotely (RSS), Remotive, Himalayas, Arbeitnow and Jobicy. A board shows its latest jobs, or
// the results of a search, never a company's whole list: its runs are never complete, so a
// job missing from one is re-verified, not closed.
//
// Boards that search server-side (Remotive, Himalayas, Jobicy) get the strategy's queries;
// the others are read once and the queries are applied afterwards like everywhere else.
// Terms: RemoteOK and Himalayas ask for a link back, which the posting's source URL keeps;
// Jobicy asks for at most hourly polls, Himalayas for daily refreshes (strategies run every
// few hours at most).
import { atsJobPage } from './ats-embed.ts';
import { parseFeed } from './feed.ts';
import { get, getJson } from './http.ts';
import {
  decodeEntities,
  type Listing,
  plainText,
  type ReaderContext,
  type ReaderRun,
  str,
} from './types.ts';

/**
 * Boards that start switched off, and why (the candidate can switch them on). Himalayas' job
 * pages answer the headless reader with HTTP 403, so none of its postings can be verified.
 * Jobicy's "Apply Now" asks to sign in before it shows the employer's link, and its API
 * doesn't give that link either, so its postings fail verification too.
 */
export const BOARDS_OFF: Partial<Record<BoardId, string>> = {
  himalayas:
    'off by default: its job pages refuse the headless reader (HTTP 403), so its postings fail verification',
  jobicy:
    "off by default: its Apply asks to sign in before showing the employer's link, so its postings fail verification",
};

export const BOARDS = {
  hn: 'Hacker News · Who is hiring',
  remoteok: 'RemoteOK',
  wwr: 'We Work Remotely',
  remotive: 'Remotive',
  himalayas: 'Himalayas',
  arbeitnow: 'Arbeitnow',
  jobicy: 'Jobicy',
} as const;
export type BoardId = keyof typeof BOARDS;

export function isBoardId(id: string): id is BoardId {
  return Object.hasOwn(BOARDS, id);
}

type Node = Record<string, unknown>;

function arr(value: unknown): Node[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Node[]) : [];
}

/** A board's listing: the posting is the ATS job page when the board links one. */
function boardListing(p: Partial<Listing> & { boardUrl: string; title: string }): Listing {
  const { boardUrl, ...rest } = p;
  const ats = atsJobPage(p.applyUrl);
  return {
    externalId: null,
    company: null,
    location: null,
    remote: null,
    team: null,
    description: null,
    applyUrl: null,
    postedAt: null,
    ...rest,
    url: ats ?? boardUrl,
    sourceUrl: boardUrl,
  };
}

/** Each query once (at most 5), or one unfiltered request when there are none. */
function searchTerms(queries: string[]): Array<string | null> {
  const terms = [
    ...new Set(queries.map((q) => q.replace(/(^|\s)-\S+/g, ' ').trim()).filter(Boolean)),
  ];
  return terms.length ? terms.slice(0, 5) : [null];
}

function dedupeById(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  return listings.filter((l) => {
    const key = l.externalId ?? l.sourceUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Hacker News: the latest "Ask HN: Who is hiring?" thread ------------------------------

const HN_ROLE =
  /\b(engineer|developer|programmer|scientist|designer|manager|lead|architect|cto|founding|head of|devops|sre|analyst|researcher|swe|full[- ]?stack|backend|frontend|intern)\b/i;
const HN_WHERE = /\b(remote|onsite|on-site|hybrid|in[- ]office|relocation)\b/i;

/** A header part longer than this is prose, not a company, role or place. */
const HN_PART = 90;

/** Splits a "Company | Role | Location | …" first line into its parts. */
export function hnFirstLine(html: string): {
  company: string | null;
  title: string;
  location: string | null;
  first: string;
} {
  const firstHtml = html.split(/<p>/i)[0] ?? html;
  const first = (plainText(firstHtml, 1000) ?? '').replace(/\s+/g, ' ').trim();
  const parts = first
    .split(/\s[|•·]\s|\s\|\s?|\|/)
    .map((p) => p.trim())
    .filter(Boolean);
  const head = parts[0]?.replace(/\s*\(?https?:\/\/\S+\)?/g, '').trim() ?? '';
  const company = head && head.length <= 60 ? head : null;
  const rest = parts.slice(1).filter((p) => !/^https?:\/\//.test(p) && p.length <= HN_PART);
  const clipped = first.length > HN_PART ? `${first.slice(0, HN_PART - 1).trimEnd()}…` : first;
  // A header without a role in it (a post that starts with prose) is titled by its opening.
  const title = rest.find((p) => HN_ROLE.test(p)) ?? clipped;
  const location = rest.find((p) => p !== title && HN_WHERE.test(p)) ?? null;
  return { company, title, location, first };
}

/** The comment's best job link: an ATS job page, then a careers/jobs page, then any link. */
export function hnJobLink(html: string): string | null {
  const links = [...html.matchAll(/href="([^"]+)"/gi)]
    .map((m) => decodeEntities(m[1] ?? ''))
    .filter((u) => /^https?:\/\//.test(u) && !/news\.ycombinator\.com/.test(u));
  return (
    links.find((u) => atsJobPage(u)) ??
    links.find((u) => /job|career|hiring|apply|position|opening|work-with-us|join/i.test(u)) ??
    links[0] ??
    null
  );
}

async function hn(ctx: ReaderContext): Promise<ReaderRun> {
  const { data: stories } = await getJson<Node>(
    ctx.fetch,
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10',
    ctx.signal,
  );
  const thread = arr(stories?.hits).find((h) => /who is hiring/i.test(String(h.title ?? '')));
  const id = str(thread?.objectID);
  if (!id) throw new Error('no "Who is hiring?" thread found');
  const { data: item } = await getJson<Node>(
    ctx.fetch,
    `https://hn.algolia.com/api/v1/items/${id}`,
    ctx.signal,
  );
  const listings = arr(item?.children).flatMap((c) => {
    const html = str(c.text);
    if (!html) return [];
    const line = hnFirstLine(html);
    const commentUrl = `https://news.ycombinator.com/item?id=${c.id}`;
    const link = hnJobLink(html);
    // A post that links no page ("email us") has nothing to verify or apply through; its
    // comment page would pass for one (HN's footer has an "Apply to YC" link).
    if (!link) return [];
    return [
      {
        url: atsJobPage(link) ?? link,
        sourceUrl: commentUrl,
        externalId: String(c.id),
        title: line.title,
        company: line.company,
        location: line.location,
        remote: line.location && /remote/i.test(line.location) ? true : null,
        team: null,
        description: plainText(html),
        applyUrl: link,
        postedAt: str(c.created_at),
        matchText: line.first,
      } satisfies Listing,
    ];
  });
  const comments = arr(item?.children).length;
  return {
    listings,
    complete: false,
    note: `${String(item?.title ?? 'Who is hiring')}: ${listings.length} of ${comments} posts link a job page`,
  };
}

// ---- RemoteOK ---------------------------------------------------------------------------

async function remoteok(ctx: ReaderContext): Promise<ReaderRun> {
  const { data } = await getJson<unknown[]>(ctx.fetch, 'https://remoteok.com/api', ctx.signal);
  // The first element is RemoteOK's legal notice.
  const listings = arr(data).flatMap((j) => {
    const url = str(j.url);
    const title = str(j.position);
    if (!url || !title) return [];
    return [
      boardListing({
        boardUrl: url,
        title,
        externalId: str(j.id),
        company: str(j.company),
        location: str(j.location) ?? 'Remote',
        remote: true,
        team: Array.isArray(j.tags) ? j.tags.slice(0, 5).join(', ') : null,
        description: plainText(str(j.description)),
        applyUrl: str(j.apply_url),
        postedAt: str(j.date),
      }),
    ];
  });
  return { listings, complete: false, note: `RemoteOK: ${listings.length} latest jobs` };
}

// ---- We Work Remotely (RSS: "Company: Role") --------------------------------------------

async function wwr(ctx: ReaderContext): Promise<ReaderRun> {
  const res = await get(ctx.fetch, 'https://weworkremotely.com/remote-jobs.rss', ctx.signal);
  const feed = parseFeed(res.text, res.contentType, res.url, ctx.now);
  if (!feed) throw new Error('We Work Remotely: the RSS feed did not parse');
  const listings = feed.listings.map((l) => {
    const i = l.title.indexOf(': ');
    const company = i > 0 ? l.title.slice(0, i).trim() : null;
    const title = i > 0 ? l.title.slice(i + 2).trim() : l.title;
    return boardListing({
      ...l,
      boardUrl: l.url,
      title,
      company,
      location: l.location ?? 'Remote',
      remote: true,
    });
  });
  return { listings, complete: false, note: `We Work Remotely: ${listings.length} latest jobs` };
}

// ---- Remotive (searches server-side) -----------------------------------------------------

async function remotive(ctx: ReaderContext): Promise<ReaderRun> {
  const listings: Listing[] = [];
  for (const term of searchTerms(ctx.queries)) {
    const q = term ? `&search=${encodeURIComponent(term)}` : '';
    const { data } = await getJson<Node>(
      ctx.fetch,
      `https://remotive.com/api/remote-jobs?limit=100${q}`,
      ctx.signal,
    );
    for (const j of arr(data?.jobs)) {
      const url = str(j.url);
      const title = str(j.title);
      if (!url || !title) continue;
      listings.push(
        boardListing({
          boardUrl: url,
          title,
          externalId: str(j.id),
          company: str(j.company_name),
          location: str(j.candidate_required_location) ?? 'Remote',
          remote: true,
          team: str(j.category),
          description: plainText(str(j.description)),
          postedAt: str(j.publication_date),
        }),
      );
    }
  }
  const out = dedupeById(listings);
  return { listings: out, complete: false, note: `Remotive: ${out.length} jobs` };
}

// ---- Himalayas (searches server-side) ----------------------------------------------------

async function himalayas(ctx: ReaderContext): Promise<ReaderRun> {
  const listings: Listing[] = [];
  for (const term of searchTerms(ctx.queries)) {
    const url = term
      ? `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(term)}`
      : 'https://himalayas.app/jobs/api?limit=20';
    const { data } = await getJson<Node>(ctx.fetch, url, ctx.signal);
    for (const j of arr(data?.jobs)) {
      const link = str(j.applicationLink) ?? str(j.guid);
      const title = str(j.title);
      if (!link || !title) continue;
      const where = Array.isArray(j.locationRestrictions)
        ? j.locationRestrictions
            .map((l) => (typeof l === 'string' ? l : str((l as Node)?.name)))
            .filter(Boolean)
        : [];
      listings.push(
        boardListing({
          boardUrl: str(j.guid) ?? link,
          title,
          externalId: str(j.guid) ?? link,
          company: str(j.companyName),
          location: where.length ? `Remote (${where.join(', ')})` : 'Remote',
          remote: true,
          description: plainText(str(j.description)) ?? str(j.excerpt),
          applyUrl: link,
          postedAt: typeof j.pubDate === 'number' ? new Date(j.pubDate * 1000).toISOString() : null,
        }),
      );
    }
  }
  const out = dedupeById(listings);
  return { listings: out, complete: false, note: `Himalayas: ${out.length} jobs` };
}

// ---- Arbeitnow (EU-heavy; first page) ----------------------------------------------------

async function arbeitnow(ctx: ReaderContext): Promise<ReaderRun> {
  const { data } = await getJson<Node>(
    ctx.fetch,
    'https://www.arbeitnow.com/api/job-board-api',
    ctx.signal,
  );
  const listings = arr(data?.data).flatMap((j) => {
    const title = str(j.title);
    const url = str(j.url);
    if (!title || !url) return [];
    return [
      boardListing({
        boardUrl: url,
        title,
        externalId: str(j.slug) ?? url,
        company: str(j.company_name),
        location:
          j.remote === true
            ? `Remote${str(j.location) ? ` (${j.location})` : ''}`
            : str(j.location),
        remote: j.remote === true ? true : j.remote === false ? false : null,
        team: Array.isArray(j.tags) ? j.tags.slice(0, 5).join(', ') : null,
        description: plainText(str(j.description)),
        postedAt:
          typeof j.created_at === 'number' ? new Date(j.created_at * 1000).toISOString() : null,
      }),
    ];
  });
  return { listings, complete: false, note: `Arbeitnow: ${listings.length} latest jobs` };
}

// ---- Jobicy (searches server-side by tag) ------------------------------------------------

async function jobicy(ctx: ReaderContext): Promise<ReaderRun> {
  const listings: Listing[] = [];
  for (const term of searchTerms(ctx.queries)) {
    const q = term ? `&tag=${encodeURIComponent(term)}` : '';
    const { data } = await getJson<Node>(
      ctx.fetch,
      `https://jobicy.com/api/v2/remote-jobs?count=50${q}`,
      ctx.signal,
    );
    for (const j of arr(data?.jobs)) {
      const url = str(j.url);
      const title = str(j.jobTitle);
      if (!url || !title) continue;
      listings.push(
        boardListing({
          boardUrl: url,
          title: decodeEntities(title),
          externalId: str(j.id),
          company: str(j.companyName),
          location: str(j.jobGeo) ? `Remote (${j.jobGeo})` : 'Remote',
          remote: true,
          team: Array.isArray(j.jobIndustry) ? j.jobIndustry.join(', ') : null,
          description: plainText(str(j.jobDescription)) ?? str(j.jobExcerpt),
          postedAt: str(j.pubDate),
        }),
      );
    }
  }
  const out = dedupeById(listings);
  return { listings: out, complete: false, note: `Jobicy: ${out.length} jobs` };
}

const READERS: Record<BoardId, (ctx: ReaderContext) => Promise<ReaderRun>> = {
  hn,
  remoteok,
  wwr,
  remotive,
  himalayas,
  arbeitnow,
  jobicy,
};

export function readBoard(board: BoardId, ctx: ReaderContext): Promise<ReaderRun> {
  return READERS[board](ctx);
}
