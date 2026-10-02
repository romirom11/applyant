// Which of the candidate's GitHub repositories is a project's code? Their repositories (the
// signed-in account and its organisations, through `gh`) are listed once in a while and each
// is compared with the project by name and by what it describes, so the project's page can
// offer "on your GitHub: romirom11/soloveim" instead of asking for a URL. No model decides
// this: names close in spelling, or a description naming the project or its stack, are enough
// to suggest; the candidate adds the one they mean.
import { defaultCliPaths } from '../../models/cli-paths.ts';
import { run } from '../../util/exec.ts';

export interface Repository {
  /** https://github.com/<owner>/<name> */
  url: string;
  /** "<owner>/<name>" */
  fullName: string;
  name: string;
  description: string | null;
  pushedAt: Date | null;
  private: boolean;
}

export interface RepositorySuggestion extends Repository {
  /** Why it looks like the project; empty for the rest of the list. */
  reason: string;
}

export interface ProjectLike {
  name: string;
  summary: string | null;
  stack: string[];
}

export class GhUnavailable extends Error {}

/** How long a listing is reused before `gh` is asked again. */
const CACHE_MS = 10 * 60_000;
const PER_ACCOUNT = 300;

type Fetch = (args: string[]) => Promise<string>;

/** The candidate's repositories, with the accounts they came from. */
export class RepositoryList {
  private readonly fetch: Fetch;
  private readonly now: () => Date;
  private cached: { at: number; accounts: string[]; repos: Repository[] } | null = null;

  constructor(o: { fetch?: Fetch; now?: () => Date } = {}) {
    this.fetch = o.fetch ?? ghFetch;
    this.now = o.now ?? (() => new Date());
  }

  async list(refresh = false): Promise<{ accounts: string[]; repos: Repository[] }> {
    const at = this.now().getTime();
    if (!refresh && this.cached && at - this.cached.at < CACHE_MS) return this.cached;
    const me = (await this.fetch(['api', 'user', '--jq', '.login'])).trim();
    if (!me) throw new GhUnavailable('`gh` is signed in but gave no account');
    const orgs = (await this.fetch(['api', 'user/orgs', '--jq', '.[].login']).catch(() => ''))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const accounts = [me, ...orgs];
    const repos: Repository[] = [];
    for (const account of accounts) {
      const out = await this.fetch([
        'repo',
        'list',
        account,
        '--limit',
        String(PER_ACCOUNT),
        '--json',
        'name,description,url,pushedAt,isPrivate,isFork,isArchived,owner',
      ]).catch(() => '[]');
      for (const r of parseRepos(out)) repos.push(r);
    }
    repos.sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0));
    this.cached = { at, accounts, repos };
    return this.cached;
  }
}

/** `gh` by the path the daemon found it at; a missing or signed-out `gh` is said plainly. */
async function ghFetch(args: string[]): Promise<string> {
  const found = await defaultCliPaths().resolve('gh');
  if (!found.path) {
    throw new GhUnavailable(
      'The GitHub CLI (gh) is not installed: install it and run `gh auth login`, then try again',
    );
  }
  try {
    return await run(found.path, args, { timeoutMs: 60_000 });
  } catch (err) {
    const text = (err as Error).message;
    if (/auth|login|logged|token|401/i.test(text)) {
      throw new GhUnavailable(
        'The GitHub CLI is not signed in: run `gh auth login`, then try again',
      );
    }
    throw err;
  }
}

interface GhRepo {
  name?: string;
  description?: string | null;
  url?: string;
  pushedAt?: string | null;
  isPrivate?: boolean;
  isFork?: boolean;
  isArchived?: boolean;
  owner?: { login?: string } | null;
}

/** Forks and archived repositories aren't the candidate's projects. */
export function parseRepos(json: string): Repository[] {
  let rows: GhRepo[];
  try {
    rows = JSON.parse(json) as GhRepo[];
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: Repository[] = [];
  for (const r of rows) {
    if (!r.name || !r.url || r.isFork || r.isArchived) continue;
    const owner = r.owner?.login ?? /github\.com\/([^/]+)\//.exec(r.url)?.[1] ?? '';
    out.push({
      url: r.url,
      fullName: owner ? `${owner}/${r.name}` : r.name,
      name: r.name,
      description: r.description?.trim() || null,
      pushedAt: r.pushedAt ? new Date(r.pushedAt) : null,
      private: !!r.isPrivate,
    });
  }
  return out;
}

// ---- matching ----------------------------------------------------------------------------

/** Words that say nothing about which project it is. */
const NOISE = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'at',
  'in',
  'on',
  'to',
  'with',
  'app',
  'api',
  'web',
  'website',
  'site',
  'service',
  'backend',
  'frontend',
  'server',
  'client',
  'project',
  'repo',
  'main',
  'new',
  'old',
  'v1',
  'v2',
  'test',
  'demo',
  'developer',
  'engineer',
  'lead',
  'tech',
  'senior',
  'junior',
  'full',
  'stack',
  'self',
  'employed',
  'freelance',
  'llc',
  'gmbh',
  'inc',
  'ltd',
  'co',
  'kg',
]);

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** "solovei-website" → "soloveiwebsite": letters and digits only. */
function squash(text: string): string {
  return fold(text).replace(/[^a-z0-9]+/g, '');
}

function words(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NOISE.has(w));
}

/** Edit distance, for spelling that drifted ("solovei" · "soloveim"). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** 1 for the same string, 0 for nothing in common. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

export interface Match {
  score: number;
  reason: string;
}

/**
 * How much a repository looks like the project: the names (the whole name, or any word of the
 * project's, close to the repository's), then the description naming the project or its stack.
 * Null when there's nothing to go on.
 */
export function matchRepository(project: ProjectLike, repo: Repository): Match | null {
  const projectName = squash(project.name);
  const repoName = squash(repo.name);
  const nameWords = words(project.name);
  const reasons: string[] = [];
  let score = 0;

  // Names.
  if (projectName && repoName) {
    if (projectName === repoName) {
      score = 1;
      reasons.push('the same name');
    } else if (
      (projectName.length >= 4 && repoName.includes(projectName)) ||
      (repoName.length >= 4 && projectName.includes(repoName))
    ) {
      score = 0.8;
      reasons.push(`its name contains ${project.name}`);
    } else if (projectName.length >= 4 && similarity(projectName, repoName) >= 0.75) {
      score = 0.7;
      reasons.push(`its name is close to ${project.name}`);
    } else {
      const repoWords = words(repo.name);
      const hit = nameWords.find((w) =>
        repoWords.some((r) => r === w || (w.length >= 4 && similarity(w, r) >= 0.8)),
      );
      if (hit) {
        score = 0.6;
        reasons.push(`its name has "${hit}" in it`);
      }
    }
  }

  // The description: the project's name, or something from its stack.
  const description = repo.description ? fold(repo.description) : '';
  if (description) {
    const named = nameWords.find((w) => new RegExp(`\\b${w}\\b`).test(description));
    if (named) {
      score += 0.5;
      reasons.push(`its description names ${named}`);
    }
    const tech = project.stack.map(fold).filter((t) => t.length >= 4 && description.includes(t));
    if (tech.length) {
      score += Math.min(0.3, 0.15 * tech.length);
      reasons.push(`its description names ${tech.slice(0, 2).join(' and ')}`);
    }
    if (project.summary) {
      const shared = words(project.summary).filter((w) =>
        new RegExp(`\\b${w}\\b`).test(description),
      );
      if (shared.length >= 2) {
        score += 0.2;
        reasons.push(`its description reads like the project's (${shared.slice(0, 2).join(', ')})`);
      }
    }
  }
  if (score <= 0) return null;
  return { score: Math.min(1, score), reason: reasons.join('; ') };
}

/** What counts as a suggestion. */
export const SUGGEST_AT = 0.5;

/**
 * The project's likely repositories (best first, at most 5) and the rest (newest push first).
 * Repositories already a source of some project are left out of both.
 */
export function suggestRepositories(
  project: ProjectLike,
  repos: Repository[],
  takenUrls: Iterable<string>,
): { matches: RepositorySuggestion[]; others: RepositorySuggestion[] } {
  const taken = new Set([...takenUrls].map((u) => u.toLowerCase().replace(/\.git$/, '')));
  const free = repos.filter((r) => !taken.has(r.url.toLowerCase()));
  const scored = free.map((r) => ({ repo: r, match: matchRepository(project, r) }));
  const matches = scored
    .filter(
      (s): s is { repo: Repository; match: Match } => !!s.match && s.match.score >= SUGGEST_AT,
    )
    .sort(
      (a, b) =>
        b.match.score - a.match.score ||
        (b.repo.pushedAt?.getTime() ?? 0) - (a.repo.pushedAt?.getTime() ?? 0),
    )
    .slice(0, 5)
    .map((s) => ({ ...s.repo, reason: s.match.reason }));
  const chosen = new Set(matches.map((m) => m.url));
  const others = free.filter((r) => !chosen.has(r.url)).map((r) => ({ ...r, reason: '' }));
  return { matches, others };
}
