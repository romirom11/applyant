// The known-ATS detector, for listings only: a career page that embeds a Greenhouse, Ashby,
// Lever or Workable board is read through that ATS's public list API, with no recipe. The
// board's token (or slug, site, account) comes from the embed's script or iframe src, or from
// links to the board. Application forms stay generic; this is only about finding the list.

export type Ats = 'greenhouse' | 'ashby' | 'lever' | 'workable';
export const ATS_KINDS: readonly Ats[] = ['greenhouse', 'ashby', 'lever', 'workable'];

export interface AtsBoard {
  ats: Ats;
  token: string;
}

// Paths on ATS hosts that are never a board name.
const NOT_A_BOARD = new Set([
  'embed',
  'api',
  'v0',
  'v1',
  'posting-api',
  'j',
  'jobs',
  'js',
  'assets',
  'static',
  'favicon.ico',
  'robots.txt',
  'careers',
]);

function clean(token: string | undefined): string | null {
  if (!token) return null;
  const t = decodeURIComponent(token)
    .trim()
    .replace(/[/?#].*$/, '');
  if (!t || NOT_A_BOARD.has(t.toLowerCase()) || !/^[a-z0-9][a-z0-9._-]*$/i.test(t)) return null;
  return t;
}

/** The board a URL belongs to: an embed script, a board page, a job page or its list API. */
export function boardFromUrl(raw: string): AtsBoard | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  if (host.endsWith('greenhouse.io')) {
    // boards.greenhouse.io/embed/job_board/js?for=<token> · …/embed/job_board?for=<token>
    const forToken = clean(url.searchParams.get('for') ?? undefined);
    if (forToken) return { ats: 'greenhouse', token: forToken };
    // boards-api.greenhouse.io/v1/boards/<token>/jobs
    if (host.startsWith('boards-api.') && path[0] === 'v1' && path[1] === 'boards') {
      const token = clean(path[2]);
      return token ? { ats: 'greenhouse', token } : null;
    }
    // boards.greenhouse.io/<token>[/jobs/<id>] · job-boards(.eu).greenhouse.io/<token>
    const token = clean(path[0]);
    return token ? { ats: 'greenhouse', token } : null;
  }
  if (host === 'jobs.ashbyhq.com') {
    const token = clean(path[0]);
    return token ? { ats: 'ashby', token } : null;
  }
  if (host === 'api.ashbyhq.com' && path[0] === 'posting-api' && path[1] === 'job-board') {
    const token = clean(path[2]);
    return token ? { ats: 'ashby', token } : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const token = clean(path[0]);
    return token ? { ats: 'lever', token } : null;
  }
  if ((host === 'api.lever.co' || host === 'api.eu.lever.co') && path[0] === 'v0') {
    const token = clean(path[2]);
    return token ? { ats: 'lever', token } : null;
  }
  if (host === 'apply.workable.com') {
    // apply.workable.com/<account>[/j/<code>] · …/api/v1/widget/accounts/<account>
    if (path[0] === 'api') {
      const i = path.indexOf('accounts');
      const token = i >= 0 ? clean(path[i + 1]) : null;
      return token ? { ats: 'workable', token } : null;
    }
    const token = clean(path[0]);
    return token ? { ats: 'workable', token } : null;
  }
  if (host.endsWith('.workable.com')) {
    const sub = host.slice(0, -'.workable.com'.length);
    const token = clean(sub);
    return token && sub !== 'www' && sub !== 'apply' ? { ats: 'workable', token } : null;
  }
  return null;
}

const URL_IN_HTML =
  /https?:\/\/[^\s"'<>()\\]+|\/\/(?:[a-z0-9-]+\.)*(?:greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com)[^\s"'<>()\\]*/gi;

/**
 * The ATS board a page embeds or links to. Embed scripts and iframes count most, then links;
 * with several boards, the one the page points at most often wins.
 */
export function detectAtsBoard(html: string, extraUrls: string[] = []): AtsBoard | null {
  const votes = new Map<string, { board: AtsBoard; weight: number }>();
  const add = (raw: string, weight: number) => {
    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    const board = boardFromUrl(url.replace(/&amp;/g, '&'));
    if (!board) return;
    const key = `${board.ats}:${board.token.toLowerCase()}`;
    const v = votes.get(key);
    if (v) v.weight += weight;
    else votes.set(key, { board, weight });
  };
  for (const url of extraUrls) add(url, 5);
  for (const match of html.matchAll(URL_IN_HTML)) {
    const raw = match[0];
    const embed = /\/embed\b|job_board|mode=iframe|widget|posting-api|boards-api/i.test(raw);
    add(raw, embed ? 5 : 1);
  }
  // Ashby's script embed names the board in a data attribute or a variable.
  for (const m of html.matchAll(
    /ashby_embed[^>]*?(?:data-org|organization(?:HostedJobsPageName)?)["'\s:=]+["']?([a-z0-9._-]+)/gi,
  )) {
    const token = clean(m[1]);
    if (token) add(`https://jobs.ashbyhq.com/${token}`, 5);
  }
  let best: { board: AtsBoard; weight: number } | null = null;
  for (const v of votes.values()) if (!best || v.weight > best.weight) best = v;
  return best?.board ?? null;
}

/**
 * The job's id on its ATS, from any URL that shows it: an ATS job page, its apply page, or a
 * career page that carries the ATS's job parameter (gh_jid, ashby_jid, lever-…).
 */
export function atsJobKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  const gh = url.searchParams.get('gh_jid');
  if (gh && /^\d+$/.test(gh)) return `greenhouse:${gh}`;
  const ashby = url.searchParams.get('ashby_jid');
  if (ashby && /^[0-9a-f-]{36}$/i.test(ashby)) return `ashby:${ashby.toLowerCase()}`;
  if (host.endsWith('greenhouse.io')) {
    const i = path.indexOf('jobs');
    const id = i >= 0 ? path[i + 1] : undefined;
    if (id && /^\d+$/.test(id)) return `greenhouse:${id}`;
    const tokenJob = url.searchParams.get('token');
    if (tokenJob && /^\d+$/.test(tokenJob)) return `greenhouse:${tokenJob}`;
    return null;
  }
  const uuid = (s: string | undefined) =>
    s && /^[0-9a-f-]{36}$/i.test(s) ? s.toLowerCase() : null;
  if (host === 'jobs.ashbyhq.com') {
    const id = uuid(path[1]);
    return id ? `ashby:${id}` : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const id = uuid(path[1]);
    return id ? `lever:${id}` : null;
  }
  if (host === 'apply.workable.com' || host.endsWith('.workable.com')) {
    const i = path.indexOf('j');
    const code = i >= 0 ? path[i + 1] : undefined;
    return code && /^[0-9a-z]{6,12}$/i.test(code) ? `workable:${code.toUpperCase()}` : null;
  }
  return null;
}

/**
 * A job page on an ATS (not its apply step), or null. Boards that link to the ATS get the job
 * page as the posting's URL: the same URL the ATS's own list gives, and a real form to verify.
 */
export function atsJobPage(raw: string | null | undefined): string | null {
  if (!raw || !atsJobKey(raw)) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const onAts = /(^|\.)(greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com)$/.test(host);
    if (!onAts) return null;
    url.pathname = url.pathname.replace(/\/(apply|application)\/?$/, '');
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
