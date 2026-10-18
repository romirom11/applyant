// The five public ATS list APIs. Each returns a board's whole published list, so a finished
// read is complete: a job missing from it has been unpublished.
//
//   greenhouse  boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true   (meta.total;
//               the ATS index reads it without content: titles and places, a tenth the size)
//   ashby       api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true
//   lever       api.lever.co/v0/postings/<site>?mode=json, else api.eu.lever.co (EU boards
//               answer 404 or [] on the global host)
//   workable    apply.workable.com/api/v1/widget/accounts/<account>?details=true
//   smartrecruiters  api.smartrecruiters.com/v1/companies/<company>/postings (pages of 100,
//               totalFound; no descriptions: verification reads the job page)
import type { Ats } from './ats-embed.ts';
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
  }
}
