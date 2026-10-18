// The public ATS lists. Each returns a board's whole published list, so a finished read is
// complete: a job missing from it has been unpublished.
//
//   greenhouse  boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true   (meta.total;
//               the ATS index reads it without content: titles and places, a tenth the size)
//   ashby       api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true
//   lever       api.lever.co/v0/postings/<site>?mode=json, else api.eu.lever.co (EU boards
//               answer 404 or [] on the global host)
//   workable    apply.workable.com/api/v1/widget/accounts/<account>?details=true
//   smartrecruiters  api.smartrecruiters.com/v1/companies/<company>/postings (pages of 100,
//               totalFound; no descriptions: verification reads the job page)
//   personio    <company>.jobs.personio.de/xml (XML; descriptions in the board's default
//               language, ?language=en for the positions written only in English)
//   recruitee   <company>.recruitee.com/api/offers/
//   teamtailor  <company>.teamtailor.com/jobs.json (a JSON Feed, pages of 100 via next_url)
//   join        join.com/companies/<slug> names the company's id, then
//               join.com/api/public/companies/<id>/jobs (pages of 5, the most it gives;
//               no descriptions)
//   breezy      <company>.breezy.hr/json?verbose=true
import { DOMParser } from 'linkedom';
import type { Ats } from './ats-embed.ts';
import { jobPostingListing } from './feed.ts';
import { get, getJson, HttpError } from './http.ts';
import { BOARD_READ_MS } from './shared.ts';
import { type Listing, plainText, type ReaderContext, type ReaderRun, str } from './types.ts';

type Node = Record<string, unknown>;

export interface AtsRun extends ReaderRun {
  /** The company the board belongs to, when the API names it. */
  company: string | null;
  /** Lever: which API host answered (the EU one for EU boards). */
  apiHost?: string;
}

const LEVER_HOSTS = ['api.lever.co', 'api.eu.lever.co'];

function arr(value: unknown): Node[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Node[]) : [];
}

function base(p: Partial<Listing> & { url: string; title: string }): Listing {
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

async function greenhouse(token: string, ctx: ReaderContext, light = false): Promise<AtsRun> {
  const t = encodeURIComponent(token);
  const { data } = await getJson<Node>(
    ctx.fetch,
    `https://boards-api.greenhouse.io/v1/boards/${t}/jobs${light ? '' : '?content=true'}`,
    ctx.signal,
  );
  const jobs = arr(data?.jobs);
  const total = Number((data?.meta as Node | undefined)?.total ?? jobs.length);
  let company = str(jobs[0]?.company_name);
  if (!company) {
    const board = await getJson<Node>(
      ctx.fetch,
      `https://boards-api.greenhouse.io/v1/boards/${t}`,
      ctx.signal,
      { allow: [404] },
    ).catch(() => ({ data: null }));
    company = str(board.data?.name);
  }
  const listings = jobs.flatMap((j) => {
    const url = str(j.absolute_url);
    const title = str(j.title);
    if (!url || !title) return [];
    const location = str((j.location as Node | undefined)?.name);
    return [
      base({
        url,
        title,
        externalId: str(j.id),
        company: str(j.company_name) ?? company,
        location,
        remote: location && /remote/i.test(location) ? true : null,
        team: str(arr(j.departments)[0]?.name),
        // content is HTML with its entities escaped once more (plainText handles both).
        description: plainText(str(j.content)),
        postedAt: str(j.first_published) ?? str(j.updated_at),
      }),
    ];
  });
  const complete = listings.length === total;
  return {
    listings,
    complete,
    company,
    note: `${company ?? token} on Greenhouse: ${listings.length} jobs${complete ? '' : ` of ${total} (partial)`}`,
  };
}

async function ashby(slug: string, ctx: ReaderContext): Promise<AtsRun> {
  const { data } = await getJson<Node>(
    ctx.fetch,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    ctx.signal,
  );
  if (!data || !Array.isArray(data.jobs)) throw new Error(`Ashby board ${slug}: no job list`);
  const listings = arr(data.jobs).flatMap((j) => {
    const url = str(j.jobUrl);
    const title = str(j.title);
    if (!url || !title || j.isListed === false) return [];
    const secondary = arr(j.secondaryLocations)
      .map((l) => str(l.location))
      .filter((l): l is string => !!l);
    const location = [str(j.location), ...secondary].filter(Boolean).join('; ') || null;
    const workplace = str(j.workplaceType);
    return [
      base({
        url,
        title,
        externalId: str(j.id),
        location,
        remote: j.isRemote === true || workplace === 'Remote' ? true : workplace ? false : null,
        team: str(j.team) ?? str(j.department),
        description: str(j.descriptionPlain)?.slice(0, 6000) ?? plainText(str(j.descriptionHtml)),
        applyUrl: str(j.applyUrl),
        postedAt: str(j.publishedAt),
      }),
    ];
  });
  return {
    listings,
    complete: true,
    company: null,
    note: `${slug} on Ashby: ${listings.length} jobs`,
  };
}

async function lever(site: string, ctx: ReaderContext, preferHost?: string): Promise<AtsRun> {
  const hosts = preferHost
    ? [preferHost, ...LEVER_HOSTS.filter((h) => h !== preferHost)]
    : LEVER_HOSTS;
  let lastEmpty: string | null = null;
  for (const host of hosts) {
    const { status, data } = await getJson<unknown>(
      ctx.fetch,
      `https://${host}/v0/postings/${encodeURIComponent(site)}?mode=json`,
      ctx.signal,
      { allow: [404] },
    );
    if (status === 404 || !Array.isArray(data)) continue;
    if (data.length === 0) {
      // An EU board is empty on the global host (and the other way round): try the other.
      lastEmpty = host;
      continue;
    }
    const listings = arr(data).flatMap((j) => {
      const url = str(j.hostedUrl);
      const title = str(j.text);
      if (!url || !title) return [];
      const cat = (j.categories ?? {}) as Node;
      const all = Array.isArray(cat.allLocations) ? cat.allLocations.map(String) : [];
      const workplace = str(j.workplaceType);
      return [
        base({
          url,
          title,
          externalId: str(j.id),
          location: (all.length ? all.join('; ') : str(cat.location)) ?? null,
          remote:
            workplace === 'remote' ? true : workplace && workplace !== 'unspecified' ? false : null,
          team: str(cat.team) ?? str(cat.department),
          description: str(j.descriptionPlain)?.slice(0, 6000) ?? plainText(str(j.description)),
          applyUrl: str(j.applyUrl),
          postedAt: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : null,
        }),
      ];
    });
    return {
      listings,
      complete: true,
      company: null,
      apiHost: host,
      note: `${site} on Lever (${host}): ${listings.length} jobs`,
    };
  }
  if (lastEmpty) {
    return {
      listings: [],
      complete: true,
      company: null,
      apiHost: lastEmpty,
      note: `${site} on Lever: no published jobs`,
    };
  }
  throw new HttpError(404, `https://api.lever.co/v0/postings/${site} (and api.eu.lever.co)`);
}

async function workable(account: string, ctx: ReaderContext): Promise<AtsRun> {
  const { data } = await getJson<Node>(
    ctx.fetch,
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`,
    ctx.signal,
  );
  if (!data || !Array.isArray(data.jobs))
    throw new Error(`Workable account ${account}: no job list`);
  const company = str(data.name);
  const listings = arr(data.jobs).flatMap((j) => {
    const url = str(j.url) ?? str(j.shortlink);
    const title = str(j.title);
    if (!url || !title) return [];
    const where = arr(j.locations)
      .map((l) => [str(l.city), str(l.region), str(l.country)].filter(Boolean).join(', '))
      .filter(Boolean);
    const single = [str(j.city), str(j.state), str(j.country)].filter(Boolean).join(', ');
    const location = where.length ? [...new Set(where)].join('; ') : single || null;
    return [
      base({
        url,
        title,
        externalId: str(j.shortcode),
        company,
        location: j.telecommuting === true ? `Remote${location ? ` (${location})` : ''}` : location,
        remote: j.telecommuting === true ? true : null,
        team: str(j.department),
        description: plainText(str(j.description)),
        applyUrl: str(j.application_url),
        postedAt: str(j.published_on) ?? str(j.created_at),
      }),
    ];
  });
  return {
    listings,
    complete: true,
    company,
    note: `${company ?? account} on Workable: ${listings.length} jobs`,
  };
}

/**
 * One SmartRecruiters posting as a listing: the company API and the job search across every
 * company (ats-search.ts) list postings alike. `company` is the board's identifier when the
 * posting doesn't name it.
 */
export function smartRecruitersListing(j: Node, company: string): Listing | null {
  const id = str(j.id);
  const title = str(j.name);
  if (!id || !title) return null;
  const co = (j.company ?? {}) as Node;
  const loc = (j.location ?? {}) as Node;
  const where =
    str(loc.fullLocation) ??
    ([str(loc.city), str(loc.region), str(loc.country)].filter(Boolean).join(', ') || null);
  const remote = loc.remote === true;
  return base({
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(str(co.identifier) ?? company)}/${id}`,
    title,
    externalId: id,
    company: str(co.name),
    location: remote ? `Remote${where ? ` (${where})` : ''}` : where,
    remote: remote ? true : loc.hybrid === true ? false : null,
    team: str((j.department as Node | undefined)?.label),
    postedAt: str(j.releasedDate),
  });
}

const SR_PAGE = 100;
/** Big employers list thousands of jobs: past this many the list is read as partial. */
const SR_MAX = 1000;

async function smartrecruiters(company: string, ctx: ReaderContext): Promise<AtsRun> {
  const c = encodeURIComponent(company);
  const jobs: Node[] = [];
  let total = 0;
  for (let offset = 0; offset < SR_MAX; offset += SR_PAGE) {
    const { data } = await getJson<Node>(
      ctx.fetch,
      `https://api.smartrecruiters.com/v1/companies/${c}/postings?limit=${SR_PAGE}&offset=${offset}`,
      ctx.signal,
    );
    if (!data || !Array.isArray(data.content))
      throw new Error(`SmartRecruiters company ${company}: no job list`);
    total = Number(data.totalFound ?? 0);
    const page = arr(data.content);
    jobs.push(...page);
    if (page.length < SR_PAGE || jobs.length >= total) break;
  }
  if (total === 0) {
    // The API answers an unknown company with an empty list; its careers page tells them apart
    // (an unknown company redirects to the SmartRecruiters home page).
    const page = await get(ctx.fetch, `https://careers.smartrecruiters.com/${c}`, ctx.signal, {
      allow: [404],
    });
    const known = page.status < 400 && new URL(page.url).pathname.replace(/\/$/, '') !== '';
    if (!known) throw new HttpError(404, `https://careers.smartrecruiters.com/${company}`);
  }
  const listings = jobs.flatMap((j) => {
    const l = smartRecruitersListing(j, company);
    return l ? [l] : [];
  });
  const boardCompany = listings.find((l) => l.company)?.company ?? null;
  const complete = listings.length === total;
  return {
    listings,
    complete,
    company: boardCompany,
    note: `${boardCompany ?? company} on SmartRecruiters: ${listings.length} jobs${complete ? '' : ` of ${total} (partial)`}`,
  };
}

// ---- Personio ------------------------------------------------------------------------------

interface XmlNode {
  children: ArrayLike<XmlNode>;
  tagName: string;
  textContent: string | null;
}

/** The element's direct children named `name` (<name> is a position's and a description's). */
function kids(el: XmlNode | undefined, name: string): XmlNode[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => c.tagName.toLowerCase() === name.toLowerCase());
}

const kid = (el: XmlNode | undefined, name: string) => str(kids(el, name)[0]?.textContent);

interface PersonioPosition {
  id: string;
  name: string | null;
  subcompany: string | null;
  offices: string[];
  department: string | null;
  /** The descriptions' sections as HTML (heading, then text); null when it has none. */
  html: string | null;
  createdAt: string | null;
}

function personioPositions(xml: string, url: string): PersonioPosition[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlNode;
  const root = kids(doc, 'workzag-jobs')[0];
  if (!root) throw new Error(`${url} is not a Personio job list`);
  return kids(root, 'position').flatMap((p) => {
    const id = kid(p, 'id');
    if (!id) return [];
    const sections = kids(kids(p, 'jobDescriptions')[0], 'jobDescription').map(
      (d) => `<h3>${kid(d, 'name') ?? ''}</h3>${kid(d, 'value') ?? ''}`,
    );
    const offices = [
      kid(p, 'office'),
      ...kids(kids(p, 'additionalOffices')[0], 'office').map((o) => str(o.textContent)),
    ].filter((o): o is string => !!o);
    return [
      {
        id,
        name: kid(p, 'name'),
        // "Acme GmbH - 9680": the legal entity, with Personio's number for it.
        subcompany: kid(p, 'subcompany')?.replace(/\s+-\s+\d+$/, '') ?? null,
        offices: [...new Set(offices)],
        department: kid(p, 'department'),
        html: sections.length ? sections.join('') : null,
        createdAt: kid(p, 'createdAt'),
      },
    ];
  });
}

async function personio(company: string, ctx: ReaderContext): Promise<AtsRun> {
  const c = encodeURIComponent(company);
  const xml = `https://${c}.jobs.personio.de/xml`;
  const accept = 'application/xml,text/xml';
  const res = await get(ctx.fetch, xml, ctx.signal, { accept });
  const positions = personioPositions(res.text, xml);
  // The list carries descriptions in the board's default language only: a position written in
  // English alone comes without one (and often without its title), so those are read again.
  if (positions.some((p) => !p.html || !p.name)) {
    try {
      const en = await get(ctx.fetch, `${xml}?language=en`, ctx.signal, { accept });
      const byId = new Map(personioPositions(en.text, xml).map((p) => [p.id, p]));
      for (const p of positions) {
        const other = byId.get(p.id);
        p.name ??= other?.name ?? null;
        p.html ??= other?.html ?? null;
      }
    } catch {
      ctx.signal.throwIfAborted();
    }
  }
  const counts = new Map<string, number>();
  for (const p of positions)
    if (p.subcompany) counts.set(p.subcompany, (counts.get(p.subcompany) ?? 0) + 1);
  const boardCompany = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const listings = positions.flatMap((p) => {
    if (!p.name) return [];
    // Personio has no remote flag: a remote job is listed at an office named so.
    const remote = p.offices.some((o) => /remote|home.?office/i.test(o));
    return [
      base({
        url: `https://${c}.jobs.personio.de/job/${p.id}`,
        title: p.name,
        externalId: p.id,
        company: p.subcompany ?? boardCompany,
        location: p.offices.join('; ') || null,
        remote: remote ? true : null,
        team: p.department,
        description: plainText(p.html),
        postedAt: p.createdAt,
      }),
    ];
  });
  return {
    listings,
    complete: true,
    company: boardCompany,
    note: `${boardCompany ?? company} on Personio: ${listings.length} jobs`,
  };
}

// ---- Recruitee -----------------------------------------------------------------------------

/** "2026-10-15 09:31:36 UTC" → ISO. */
function utcStamp(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const iso = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, '$1T$2Z');
  return Number.isNaN(Date.parse(iso)) ? s : iso;
}

async function recruitee(company: string, ctx: ReaderContext): Promise<AtsRun> {
  const c = encodeURIComponent(company);
  const { data } = await getJson<Node>(
    ctx.fetch,
    `https://${c}.recruitee.com/api/offers/`,
    ctx.signal,
  );
  if (!data || !Array.isArray(data.offers))
    throw new Error(`Recruitee company ${company}: no job list`);
  const listings = arr(data.offers).flatMap((j) => {
    const slug = str(j.slug);
    const title = str(j.title);
    if (!slug || !title) return [];
    // careers_url is the company's own career site when it has one (careers.acme.com/o/…);
    // the Recruitee address beside it is what names the board and the job.
    const own = `https://${c}.recruitee.com/o/${encodeURIComponent(slug)}`;
    const remote = j.remote === true;
    const places = arr(j.locations);
    const where = remote
      ? places.map((l) => str(l.country) ?? str(l.name))
      : places.map((l) => [str(l.city), str(l.country)].filter(Boolean).join(', '));
    const listed = [...new Set(where.filter((w): w is string => !!w))].join('; ');
    const location = remote ? `Remote${listed ? ` (${listed})` : ''}` : listed || str(j.location);
    const description = [str(j.description), str(j.requirements)].filter(Boolean).join('\n');
    return [
      base({
        url: str(j.careers_url) ?? own,
        sourceUrl: own,
        title,
        externalId: str(j.id),
        company: str(j.company_name),
        location,
        remote: remote ? true : j.hybrid === true || j.on_site === true ? false : null,
        team: str(j.department),
        description: plainText(description),
        applyUrl: str(j.careers_apply_url),
        postedAt: utcStamp(j.published_at) ?? utcStamp(j.created_at),
      }),
    ];
  });
  const boardCompany = listings.find((l) => l.company)?.company ?? null;
  return {
    listings,
    complete: true,
    company: boardCompany,
    note: `${boardCompany ?? company} on Recruitee: ${listings.length} jobs`,
  };
}

// ---- Teamtailor ----------------------------------------------------------------------------

/** Pages of 100: past this many the list is read as partial. */
const TT_MAX_PAGES = 20;

async function teamtailor(company: string, ctx: ReaderContext): Promise<AtsRun> {
  const host = `${encodeURIComponent(company)}.teamtailor.com`.toLowerCase();
  const items: Node[] = [];
  let title: string | null = null;
  let next: string | null = `https://${host}/jobs.json`;
  let cut = false;
  for (let page = 0; next && page < TT_MAX_PAGES; page++) {
    const { data }: { data: Node | null } = await getJson<Node>(ctx.fetch, next, ctx.signal);
    if (!data || !Array.isArray(data.items))
      throw new Error(`Teamtailor company ${company}: no job list`);
    title ??= str(data.title);
    items.push(...arr(data.items));
    next = str(data.next_url);
    // Only the board's own next page is followed (never another host).
    if (next && (!URL.canParse(next) || new URL(next).hostname !== host)) {
      next = null;
      cut = true;
    }
  }
  const listings = items.flatMap((item) => {
    const url = str(item.url);
    const name = str(item.title);
    if (!url || !name) return [];
    // Each item carries the job's schema.org JobPosting: its place, remote, organisation.
    const posting = item._jobposting;
    const fromLd =
      posting && typeof posting === 'object'
        ? jobPostingListing(posting as Node, url, ctx.now)
        : null;
    return [
      base({
        ...fromLd,
        url,
        sourceUrl: url,
        title: name,
        externalId: url.match(/\/jobs\/(\d+)/)?.[1] ?? fromLd?.externalId ?? str(item.id),
        company: fromLd?.company ?? title,
        description: fromLd?.description ?? plainText(str(item.content_html)),
        postedAt: str(item.date_published) ?? fromLd?.postedAt ?? null,
      }),
    ];
  });
  const complete = next === null && !cut;
  return {
    listings,
    complete,
    company: title,
    note: `${title ?? company} on Teamtailor: ${listings.length} jobs${complete ? '' : ' (partial)'}`,
  };
}

// ---- JOIN ----------------------------------------------------------------------------------

/** The API gives at most 5 jobs a page; past this many pages the list is read as partial. */
const JOIN_PAGE = 5;
const JOIN_MAX_PAGES = 60;

async function join(slug: string, ctx: ReaderContext): Promise<AtsRun> {
  const s = encodeURIComponent(slug);
  // The company page (404 for an unknown slug) carries the company's numeric id in its
  // Next.js data; the list API takes only that id.
  const page = await get(ctx.fetch, `https://join.com/companies/${s}`, ctx.signal, {
    accept: 'text/html',
  });
  const nextData = page.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  let co: Node | null = null;
  try {
    const parsed = nextData ? (JSON.parse(nextData) as Node) : null;
    const props = (parsed?.props as Node | undefined)?.pageProps as Node | undefined;
    co = ((props?.initialState as Node | undefined)?.company as Node | undefined) ?? null;
  } catch {}
  const id = co ? str(co.id) : null;
  if (!co || !id || !/^\d+$/.test(id)) throw new Error(`JOIN company ${slug}: no company data`);
  const company = str(co.name);
  const jobs: Node[] = [];
  let total = 0;
  let pages = 1;
  for (let n = 1; n <= pages && n <= JOIN_MAX_PAGES; n++) {
    const { data } = await getJson<Node>(
      ctx.fetch,
      `https://join.com/api/public/companies/${id}/jobs?page=${n}&pageSize=${JOIN_PAGE}`,
      ctx.signal,
    );
    if (!data || !Array.isArray(data.items)) throw new Error(`JOIN company ${slug}: no job list`);
    const p = (data.pagination ?? {}) as Node;
    total = Number(p.rowCount ?? 0);
    pages = Number(p.pageCount ?? 0);
    jobs.push(...arr(data.items));
  }
  const listings = jobs.flatMap((j) => {
    const jobId = str(j.id);
    const title = str(j.title);
    if (!jobId || !title) return [];
    // The page's own address (<n>-<title>) takes a new number each time the ad is republished;
    // the job's id in its place redirects to the current one, and stays.
    const tail = str(j.idParam)?.replace(/^\d+-?/, '');
    const city = (j.city ?? {}) as Node;
    const where = [str(city.cityName), str(city.countryName)].filter(Boolean).join(', ') || null;
    const workplace = str(j.workplaceType);
    const remote = workplace === 'REMOTE';
    return [
      base({
        url: `https://join.com/companies/${s}/${jobId}${tail ? `-${tail}` : ''}`,
        title,
        externalId: jobId,
        company,
        location: remote ? `Remote${where ? ` (${where})` : ''}` : where,
        remote: remote ? true : workplace ? false : null,
        team: str((j.category as Node | undefined)?.name),
        postedAt: str(j.createdAt),
      }),
    ];
  });
  const complete = listings.length === total;
  return {
    listings,
    complete,
    company,
    note: `${company ?? slug} on JOIN: ${listings.length} jobs${complete ? '' : ` of ${total} (partial)`}`,
  };
}

// ---- Breezy HR -----------------------------------------------------------------------------

async function breezy(company: string, ctx: ReaderContext): Promise<AtsRun> {
  // An unknown company is a 404 page ("Career portal not found").
  const { data } = await getJson<unknown>(
    ctx.fetch,
    `https://${encodeURIComponent(company)}.breezy.hr/json?verbose=true`,
    ctx.signal,
  );
  if (!Array.isArray(data)) throw new Error(`Breezy company ${company}: no job list`);
  const listings = arr(data).flatMap((j) => {
    const url = str(j.url);
    const title = str(j.name);
    if (!url || !title) return [];
    const places = arr(j.locations).length ? arr(j.locations) : arr([j.location]);
    const remote = places.some((l) => l.is_remote === true);
    const listed = [...new Set(places.map((l) => str(l.name)).filter(Boolean))].join('; ');
    return [
      base({
        url,
        title,
        externalId: str(j.id),
        company: str((j.company as Node | undefined)?.name),
        location: remote ? `Remote${listed ? ` (${listed})` : ''}` : listed || null,
        remote: remote ? true : null,
        team: str(j.department),
        description: plainText(str(j.description)),
        postedAt: str(j.published_date),
      }),
    ];
  });
  const boardCompany = listings.find((l) => l.company)?.company ?? null;
  return {
    listings,
    complete: true,
    company: boardCompany,
    note: `${boardCompany ?? company} on Breezy: ${listings.length} jobs`,
  };
}

/**
 * A board's list, shared with the other runs that read it within BOARD_READ_MS (`ctx.shared`):
 * several strategies read the same watched boards, and job searches look up boards too.
 * Workable's are read in its lane, paced (see shared.ts).
 */
export function readAtsBoardShared(
  ats: Ats,
  token: string,
  ctx: ReaderContext,
  o: { apiHost?: string | undefined } = {},
): Promise<AtsRun> {
  const read = async () => {
    if (ats === 'workable') await ctx.shared?.turn('workable', ctx.signal);
    return readAtsBoard(ats, token, ctx, o);
  };
  return ctx.shared
    ? ctx.shared.memo(`ats:${ats}:${token.toLowerCase()}`, BOARD_READ_MS, ctx.now, read)
    : read();
}

/**
 * Reads one ATS board's public list. `apiHost` is Lever's host that answered last time; `light`
 * asks for the list without descriptions where that's a separate, lighter request (Greenhouse).
 */
export function readAtsBoard(
  ats: Ats,
  token: string,
  ctx: ReaderContext,
  o: { apiHost?: string | undefined; light?: boolean } = {},
): Promise<AtsRun> {
  switch (ats) {
    case 'greenhouse':
      return greenhouse(token, ctx, o.light);
    case 'ashby':
      return ashby(token, ctx);
    case 'lever':
      return lever(token, ctx, o.apiHost);
    case 'workable':
      return workable(token, ctx);
    case 'smartrecruiters':
      return smartrecruiters(token, ctx);
    case 'personio':
      return personio(token, ctx);
    case 'recruitee':
      return recruitee(token, ctx);
    case 'teamtailor':
      return teamtailor(token, ctx);
    case 'join':
      return join(token, ctx);
    case 'breezy':
      return breezy(token, ctx);
  }
}
