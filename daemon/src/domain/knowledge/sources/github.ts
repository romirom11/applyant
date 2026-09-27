// github sources: a partial clone (`--filter=blob:none`, trees and history but file contents
// on demand) plus the GitHub API through `gh` for PRs, the login → commit mapping and repo
// metadata. The digest splits history into the candidate's commits (by their logins and
// commit emails) and everyone else's, and the SHAs travel with it, so "built X" can be
// checked against who actually wrote the commits (see authorship.ts).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecError, run } from '../../../util/exec.ts';
import { ensurePrivateDir } from '../../../util/fs.ts';
import type { Logger } from '../../../util/log.ts';
import { AgentMatcher, noreplyLogin } from '../ai-agents.ts';
import type { Identities } from '../profile.ts';
import {
  type Authorship,
  clip,
  type RefDetail,
  type SourceMaterial,
  SourceReadError,
} from './material.ts';

export interface RepoRef {
  /** "github.com/acme/api" or the local path. */
  display: string;
  cloneUrl: string;
  /** Directory name under repos/. */
  dirName: string;
  github: { owner: string; repo: string } | null;
}

const GITHUB_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i;
const OWNER_REPO = /^([\w.-]+)\/([\w.-]+)$/;

export function parseRepoLocator(locator: string): RepoRef {
  const l = locator.trim();
  const m =
    GITHUB_URL.exec(l) ?? GITHUB_SSH.exec(l) ?? (l.includes('://') ? null : OWNER_REPO.exec(l));
  if (m?.[1] && m[2] && !(OWNER_REPO.test(l) && existsSync(l))) {
    const owner = m[1];
    const repo = m[2];
    return {
      display: `github.com/${owner}/${repo}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      dirName: `github.com__${owner.toLowerCase()}__${repo.toLowerCase()}`,
      github: { owner, repo },
    };
  }
  // Local repositories (and file:// URLs) work too: used by tests, and for private work
  // that never went to GitHub.
  const path = l.startsWith('file://') ? fileURLToPath(l) : isAbsolute(l) ? l : null;
  if (path) {
    const abs = resolve(path);
    return {
      display: abs,
      cloneUrl: abs,
      dirName: `local__${createHash('sha256').update(abs).digest('hex').slice(0, 16)}`,
      github: null,
    };
  }
  throw new SourceReadError(
    `"${locator}" is not a GitHub repository (use https://github.com/<owner>/<repo>)`,
    true,
  );
}

/** The form a github source's locator is stored in. */
export function canonicalRepoLocator(locator: string): string {
  const ref = parseRepoLocator(locator);
  return ref.github ? `https://github.com/${ref.github.owner}/${ref.github.repo}` : ref.cloneUrl;
}

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  /** The message body, whitespace-collapsed and cut to MAX_BODY. */
  body: string;
  files: string[];
}

export interface PullRequestCommit {
  oid: string;
  headline: string;
  authors: Array<{ email: string; login: string | null }>;
}

export interface PullRequest {
  number: number;
  state: string;
  merged: boolean;
  title: string;
  commits: PullRequestCommit[];
}

/** What the reader needs from the GitHub API (`gh` in production, a stub in tests). */
export interface GithubApi {
  /** Full SHAs of the repository's commits GitHub attributes to this login. */
  commitsBy(login: string): Promise<string[]>;
  /** PRs this login opened, with each commit's authors. */
  pullRequestsBy(login: string): Promise<PullRequest[]>;
  /** For each commit SHA, the PRs it was part of, with who opened and who merged them. */
  associatedPullRequests(shas: string[]): Promise<Map<string, AssociatedPullRequest[]>>;
  meta(): Promise<string | null>;
}

export interface AssociatedPullRequest {
  number: number;
  author: string | null;
  mergedBy: string | null;
}

export interface GithubReadOptions {
  reposDir: string;
  identities: Identities;
  signal: AbortSignal;
  log: Logger;
  /** Set false to never call `gh` (tests; offline use). */
  useGh?: boolean;
  /** Overrides the GitHub API client (tests); null = none. */
  gh?: GithubApi | null;
  /**
   * Login of the repository's owner. Default: the owner in the GitHub URL; a local
   * repository (no GitHub URL) counts as the candidate's own.
   */
  owner?: string | null;
}

const GIT_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});

const MAX_COMMITS = 5000;
/** Commit bodies are kept for the claim check, not sent to the extractor. */
const MAX_BODY = 400;
const MAX_CANDIDATE_LINES = 400;
/** Agent commits looked up for "a PR the candidate merged" in repos they don't own. */
const MAX_AGENT_LOOKUPS = 1000;
const REV = 'origin/HEAD';

export async function readGithubSource(
  locator: string,
  o: GithubReadOptions,
): Promise<SourceMaterial> {
  const ref = parseRepoLocator(locator);
  const dir = join(o.reposDir, ref.dirName);
  await syncClone(ref, dir, o.signal);
  const git = (...args: string[]) =>
    run('git', ['-C', dir, ...args], { env: GIT_ENV(), signal: o.signal });

  let commits: Commit[];
  try {
    commits = parseLog(
      await git(
        'log',
        REV,
        '--no-merges',
        '--no-renames',
        `-n${MAX_COMMITS}`,
        '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1d',
        '--name-only',
      ),
    );
  } catch (err) {
    o.signal.throwIfAborted();
    throw new SourceReadError(
      `${ref.display} has no readable history: ${(err as Error).message}`,
      true,
    );
  }
  if (commits.length === 0) throw new SourceReadError(`${ref.display} has no commits`, true);

  const gh =
    o.gh !== undefined
      ? o.gh
      : ref.github && o.useGh !== false
        ? new Gh(ref.github, o.signal, o.log)
        : null;
  const loginShas = new Set<string>();
  const opened = new Map<number, PullRequest>();
  if (gh) {
    for (const login of o.identities.logins) {
      for (const sha of await gh.commitsBy(login)) loginShas.add(sha);
      for (const pr of await gh.pullRequestsBy(login)) opened.set(pr.number, pr);
    }
  }

  const emails = new Set(o.identities.emails);
  const logins = new Set(o.identities.logins);
  const agents = new AgentMatcher(o.identities.agents);
  const isCandidateAuthor = (email: string, login: string | null) => {
    const e = email.toLowerCase();
    if (emails.has(e)) return true;
    if (login && logins.has(login.toLowerCase())) return true;
    const fromEmail = noreplyLogin(e);
    return !!fromEmail && logins.has(fromEmail);
  };

  // AI coding agents the candidate works through (Claude Code, Codex, Cursor, …): their
  // commits are the candidate's in a repository the candidate owns, or in a PR the candidate
  // opened or merged. Elsewhere they are other contributors' work, like anyone's.
  const owner = o.owner !== undefined ? o.owner : (ref.github?.owner ?? null);
  const repoOwned = owner === null ? true : logins.has(owner.toLowerCase());
  const agentShasInCandidatePrs = new Set<string>();
  for (const pr of opened.values()) {
    for (const c of pr.commits) {
      if (c.authors.some((a) => agents.matches(a.email, a.login)))
        agentShasInCandidatePrs.add(c.oid);
    }
  }
  const agentCommit = (c: Commit) => agents.matches(c.authorEmail);
  let agentShasMerged = new Set<string>();
  if (!repoOwned && gh) {
    // Agent commits outside the candidate's own PRs: were they in a PR the candidate merged?
    const unknown = commits
      .filter((c) => agentCommit(c) && !agentShasInCandidatePrs.has(c.sha))
      .map((c) => c.sha)
      .slice(0, MAX_AGENT_LOOKUPS);
    if (unknown.length) {
      const found = await gh.associatedPullRequests(unknown);
      agentShasMerged = new Set(
        [...found.entries()]
          .filter(([, prs]) =>
            prs.some(
              (p) =>
                (p.author && logins.has(p.author.toLowerCase())) ||
                (p.mergedBy && logins.has(p.mergedBy.toLowerCase())),
            ),
          )
          .map(([sha]) => sha),
      );
    }
  }
  const agentCounts = (sha: string) =>
    repoOwned || agentShasInCandidatePrs.has(sha) || agentShasMerged.has(sha);

  const isCandidate = (c: Commit) =>
    isCandidateAuthor(c.authorEmail, null) ||
    loginShas.has(c.sha) ||
    (agentCommit(c) && agentCounts(c.sha));
  const mine = commits.filter(isCandidate);
  const others = commits.filter((c) => !isCandidate(c));
  const candidateShas = new Set(mine.map((c) => c.sha));

  // Opening a PR doesn't make its commits yours: a PR is the candidate's evidence only
  // through the commits in it that the candidate (or their coding agent) wrote. Squash-merged
  // branches included, so this goes by the PR's own commit authors, not only the default
  // branch's history. Every PR here was opened by the candidate, so agent commits count.
  const prCommitIsCandidate = (c: PullRequestCommit) =>
    candidateShas.has(c.oid) ||
    c.authors.some((a) => isCandidateAuthor(a.email, a.login) || agents.matches(a.email, a.login));
  const prs = [...opened.values()].sort((a, b) => b.number - a.number);
  const candidatePrs = prs.filter((p) => p.commits.some(prCommitIsCandidate));
  const othersPrs = prs.filter((p) => !p.commits.some(prCommitIsCandidate));

  const refs = new Map<string, RefDetail>();
  for (const c of mine) {
    refs.set(c.sha, {
      ref: `commit:${c.sha.slice(0, 12)}`,
      title: c.subject,
      body: c.body,
      paths: c.files,
    });
  }
  for (const p of candidatePrs) {
    const own = p.commits.filter(prCommitIsCandidate);
    refs.set(`pr:${p.number}`, {
      ref: `pr:#${p.number}`,
      // The PR title may also describe other contributors' commits, so the support check
      // reads only the candidate's own commits in it.
      title: `PR "${p.title}" — the candidate's commits in it: ${own
        .map((c) => c.headline)
        .join(' | ')}`,
      body: '',
      paths: [],
    });
  }
  const authorship: Authorship = {
    candidateShas,
    otherShas: new Set(others.map((c) => c.sha)),
    candidatePrs: new Set(candidatePrs.map((p) => p.number)),
    otherPrs: new Set(othersPrs.map((p) => p.number)),
    refs,
  };

  const files = (await git('ls-tree', '-r', '--name-only', REV)).split('\n').filter(Boolean);
  const show = async (path: string, max: number) => {
    try {
      const text = await git('show', `${REV}:${path}`);
      return text.includes('\u0000') ? null : text.slice(0, max);
    } catch {
      return null;
    }
  };

  const sections: string[] = [];
  sections.push(`# Repository ${ref.display}`);
  const meta = gh ? await gh.meta() : null;
  if (meta) sections.push(meta);
  sections.push(`Languages by file count: ${languageMix(files)}`);

  sections.push(identityNote(o.identities, mine.length, commits.length));

  sections.push(
    `## Commits by the candidate (${mine.length} of ${commits.length}) — cite as commit:<sha>`,
  );
  if (mine.length) {
    sections.push(`Areas the candidate's commits touched: ${areas(mine)}`);
    sections.push(
      mine
        .slice(0, MAX_CANDIDATE_LINES)
        .map(
          (c) =>
            `- ${c.sha.slice(0, 10)} ${c.date.slice(0, 10)} ${c.subject.slice(0, 140)}${fileList(c)}`,
        )
        .join('\n'),
    );
    if (mine.length > MAX_CANDIDATE_LINES) {
      sections.push(
        `(${mine.length - MAX_CANDIDATE_LINES} older commits by the candidate not listed)`,
      );
    }
  } else {
    sections.push('(none)');
  }

  if (candidatePrs.length) {
    sections.push(
      "## Pull requests with the candidate's own commits — cite as pr:#<number> only for what those commits did",
    );
    sections.push(
      candidatePrs
        .slice(0, 150)
        .map((p) => {
          const own = p.commits.filter(prCommitIsCandidate).length;
          const share =
            own === p.commits.length
              ? ''
              : ` (${own} of ${p.commits.length} commits by the candidate)`;
          return `- #${p.number} ${p.merged ? 'merged' : p.state.toLowerCase()}: ${p.title.slice(0, 160)}${share}`;
        })
        .join('\n'),
    );
  }

  sections.push(
    `## Commits by other contributors (${others.length}) — team context only, never the candidate's own work`,
  );
  sections.push(others.length ? otherAuthors(others) : '(none)');
  if (othersPrs.length) {
    sections.push(
      `## Pull requests the candidate opened but other contributors wrote (${othersPrs.length}) — team context only; do not cite them for the candidate`,
    );
    sections.push(
      othersPrs
        .slice(0, 150)
        .map((p) => `- #${p.number} (cite as pr:#${p.number}): ${p.title.slice(0, 160)}`)
        .join('\n'),
    );
  }

  sections.push('## Directory overview (files per top-level entry)');
  sections.push(tree(files));

  const readme = files.find((f) => /^readme(\.[a-z]+)?$/i.test(f));
  if (readme) {
    const text = await show(readme, 15_000);
    if (text) sections.push(`## ${readme} — cite as path:${readme}\n${text}`);
  }
  for (const doc of docFiles(files)) {
    const text = await show(doc, 6_000);
    if (text) sections.push(`## ${doc} — cite as path:${doc}\n${text}`);
  }
  for (const manifest of manifestFiles(files)) {
    const text = await show(manifest, 3_000);
    if (text) sections.push(`## ${manifest}\n${text}`);
  }

  return {
    label: `${ref.display} · ${commits.length} commits (${mine.length} by the candidate)`,
    title: ref.display,
    text: clip(sections.join('\n\n')),
    locatorRules:
      '"commit:<sha>" (a SHA listed above, at least 7 characters), "pr:#<number>" (a PR listed above) or "path:<file path>". A fact about what the candidate did must cite the candidate\'s own commits or PRs that show exactly that work',
    authorship,
  };
}

async function syncClone(ref: RepoRef, dir: string, signal: AbortSignal): Promise<void> {
  const env = GIT_ENV();
  const permanent = (err: unknown) =>
    /not found|does not exist|authentication failed|could not read username|terminal prompts disabled|access denied|not a git repository/i.test(
      err instanceof ExecError ? err.stderr : String(err),
    );
  try {
    if (existsSync(join(dir, 'HEAD')) || existsSync(join(dir, '.git'))) {
      await run('git', ['-C', dir, 'remote', 'set-url', 'origin', ref.cloneUrl], { env, signal });
      await run('git', ['-C', dir, 'fetch', '--quiet', '--prune', '--filter=blob:none', 'origin'], {
        env,
        signal,
      });
      await run('git', ['-C', dir, 'remote', 'set-head', 'origin', '--auto'], { env, signal });
      return;
    }
    ensurePrivateDir(join(dir, '..'));
    await run(
      'git',
      ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--', ref.cloneUrl, dir],
      { env, signal, timeoutMs: 900_000 },
    );
  } catch (err) {
    signal.throwIfAborted();
    throw new SourceReadError(
      `can't clone ${ref.display}: ${(err as Error).message}`,
      permanent(err),
    );
  }
}

/** Parses `git log --format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1d --name-only`. */
export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of out.split('\x1e')) {
    const end = record.indexOf('\x1d');
    const head = end === -1 ? record : record.slice(0, end);
    const tail = end === -1 ? '' : record.slice(end + 1);
    const header = head.split('\x1f');
    if (header.length < 5 || !header[0]) continue;
    const [sha, authorName, authorEmail, date, subject, ...body] = header as [
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    commits.push({
      sha: sha.trim(),
      authorName,
      authorEmail,
      date,
      subject: subject.trim(),
      body: body.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY),
      files: tail
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

function identityNote(ids: Identities, mine: number, total: number): string {
  if (ids.logins.length === 0 && ids.emails.length === 0) {
    return "## Candidate identities\nNone are configured, so no commit can be attributed to the candidate: treat every commit as other contributors' work.";
  }
  return [
    '## Candidate identities',
    `GitHub logins: ${ids.logins.join(', ') || '(none)'} · commit emails: ${ids.emails.join(', ') || '(none)'}`,
    `${mine} of ${total} commits are the candidate's.`,
  ].join('\n');
}

function fileList(c: Commit): string {
  if (c.files.length === 0) return '';
  const shown = c.files.slice(0, 4).join(', ');
  return ` [${shown}${c.files.length > 4 ? `, +${c.files.length - 4}` : ''}]`;
}

function topDir(path: string, depth: number): string {
  const parts = path.split('/');
  return parts.length > depth ? `${parts.slice(0, depth).join('/')}/` : path;
}

function areas(commits: Commit[]): string {
  const counts = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.files) {
      const key = topDir(f, 2);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([d, n]) => `${d} (${n})`)
      .join(', ') || '(no file changes)'
  );
}

function otherAuthors(commits: Commit[]): string {
  const byAuthor = new Map<string, Commit[]>();
  for (const c of commits) {
    const key = c.authorEmail.toLowerCase();
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), c]);
  }
  const lines: string[] = [];
  const authors = [...byAuthor.values()].sort((a, b) => b.length - a.length);
  for (const list of authors.slice(0, 12)) {
    const first = list[list.length - 1]?.date.slice(0, 10);
    const last = list[0]?.date.slice(0, 10);
    lines.push(
      `- ${list[0]?.authorName} — ${list.length} commits, ${first}..${last}; areas: ${areas(list)}`,
    );
    for (const c of list.slice(0, 6)) {
      lines.push(`  - ${c.sha.slice(0, 10)} ${c.subject.slice(0, 120)}`);
    }
  }
  if (authors.length > 12) lines.push(`- … and ${authors.length - 12} more contributors`);
  return lines.join('\n');
}

function tree(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const key = topDir(f, 1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([d, n]) => (d.endsWith('/') ? `${d} (${n} files)` : d))
    .join('\n');
}

function languageMix(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(f)?.[1]?.toLowerCase();
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([e, n]) => `.${e} ${n}`)
      .join(', ') || '(unknown)'
  );
}

function docFiles(files: string[]): string[] {
  const skip = /^(changelog|license|licence|contributing|code_of_conduct|security|readme)(\.|$)/i;
  const docs = files.filter(
    (f) =>
      (/^(docs?|documentation|adr)\/[^/]+\.(md|mdx|rst|txt)$/i.test(f) ||
        /^[^/]+\.(md|mdx|rst)$/i.test(f)) &&
      !skip.test(f.split('/').pop() ?? ''),
  );
  const priority = (f: string) => (/architect|design|overview|adr/i.test(f) ? 0 : 1);
  return docs.sort((a, b) => priority(a) - priority(b)).slice(0, 4);
}

function manifestFiles(files: string[]): string[] {
  const names =
    /^(package\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i;
  return files.filter((f) => !f.includes('/') && names.test(f)).slice(0, 6);
}

const PR_QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title state merged
      commits(first: 100) { nodes { commit {
        oid messageHeadline
        authors(first: 5) { nodes { email user { login } } }
      } } }
    } }
  }
}`;

/** Thin `gh api` wrapper. Every failure is logged and treated as "no data". */
class Gh implements GithubApi {
  private readonly repo: { owner: string; repo: string };
  private readonly signal: AbortSignal;
  private readonly log: Logger;

  constructor(repo: { owner: string; repo: string }, signal: AbortSignal, log: Logger) {
    this.repo = repo;
    this.signal = signal;
    this.log = log;
  }

  private async api(args: string[]): Promise<string | null> {
    try {
      return await run('gh', ['api', ...args], { signal: this.signal, timeoutMs: 120_000 });
    } catch (err) {
      this.signal.throwIfAborted();
      this.log.warn('gh api failed', { args: args.join(' '), err: (err as Error).message });
      return null;
    }
  }

  private get path(): string {
    return `repos/${this.repo.owner}/${this.repo.repo}`;
  }

  async commitsBy(login: string): Promise<string[]> {
    const out = await this.api([
      '-X',
      'GET',
      `${this.path}/commits`,
      '-f',
      `author=${login}`,
      '-f',
      'per_page=100',
      '--paginate',
      '--jq',
      '.[].sha',
    ]);
    return out ? out.split('\n').filter((s) => /^[0-9a-f]{40}$/.test(s)) : [];
  }

  /** One paginated GraphQL search: PRs with their commits and commit authors. */
  async pullRequestsBy(login: string): Promise<PullRequest[]> {
    const out = await this.api([
      'graphql',
      '--paginate',
      '-f',
      `q=repo:${this.repo.owner}/${this.repo.repo} is:pr author:${login}`,
      '-f',
      `query=${PR_QUERY}`,
      '--jq',
      '.data.search.nodes[] | select(.number != null) | @json',
    ]);
    if (!out) return [];
    const prs: PullRequest[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const n = JSON.parse(line) as {
          number: number;
          title: string;
          state: string;
          merged: boolean;
          commits: {
            nodes: Array<{
              commit: {
                oid: string;
                messageHeadline: string;
                authors: { nodes: Array<{ email: string | null; user: { login: string } | null }> };
              };
            }>;
          };
        };
        prs.push({
          number: n.number,
          title: n.title,
          state: n.state,
          merged: n.merged,
          commits: n.commits.nodes.map(({ commit }) => ({
            oid: commit.oid,
            headline: commit.messageHeadline,
            authors: commit.authors.nodes.map((a) => ({
              email: a.email ?? '',
              login: a.user?.login ?? null,
            })),
          })),
        });
      } catch {
        // A malformed line only loses that PR.
      }
    }
    return prs;
  }

  /** Batched GraphQL (50 commits a query): each commit's PRs, their author and merger. */
  async associatedPullRequests(shas: string[]): Promise<Map<string, AssociatedPullRequest[]>> {
    const out = new Map<string, AssociatedPullRequest[]>();
    for (let i = 0; i < shas.length; i += 50) {
      const batch = shas.slice(i, i + 50).filter((s) => /^[0-9a-f]{40}$/.test(s));
      if (!batch.length) continue;
      const fields = batch
        .map(
          (sha, j) =>
            `c${j}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: 5) { nodes { number author { login } mergedBy { login } } } } }`,
        )
        .join('\n');
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`;
      const res = await this.api([
        'graphql',
        '-f',
        `owner=${this.repo.owner}`,
        '-f',
        `name=${this.repo.repo}`,
        '-f',
        `query=${query}`,
      ]);
      if (!res) continue;
      try {
        const repo = (JSON.parse(res) as { data?: { repository?: Record<string, unknown> } }).data
          ?.repository;
        batch.forEach((sha, j) => {
          const node = repo?.[`c${j}`] as
            | {
                associatedPullRequests?: {
                  nodes: Array<{
                    number: number;
                    author: { login: string } | null;
                    mergedBy: { login: string } | null;
                  }>;
                };
              }
            | null
            | undefined;
          out.set(
            sha,
            (node?.associatedPullRequests?.nodes ?? []).map((p) => ({
              number: p.number,
              author: p.author?.login ?? null,
              mergedBy: p.mergedBy?.login ?? null,
            })),
          );
        });
      } catch {
        // A malformed reply only loses this batch.
      }
    }
    return out;
  }

  async meta(): Promise<string | null> {
    const out = await this.api([this.path]);
    if (!out) return null;
    try {
      const r = JSON.parse(out) as Record<string, unknown>;
      const lines = [
        r.description ? `Description: ${r.description}` : null,
        Array.isArray(r.topics) && r.topics.length ? `Topics: ${r.topics.join(', ')}` : null,
        r.homepage ? `Homepage: ${r.homepage}` : null,
        `Created ${String(r.created_at ?? '').slice(0, 10)} · last push ${String(r.pushed_at ?? '').slice(0, 10)} · ${r.private ? 'private' : 'public'} · ${r.stargazers_count ?? 0} stars`,
      ];
      const langs = await this.api([`${this.path}/languages`]);
      if (langs) {
        const bytes = JSON.parse(langs) as Record<string, number>;
        const total = Object.values(bytes).reduce((a, b) => a + b, 0) || 1;
        if (Object.keys(bytes).length)
          lines.push(
            `Languages by bytes: ${Object.entries(bytes)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([l, b]) => `${l} ${Math.round((b / total) * 100)}%`)
              .join(', ')}`,
          );
      }
      return lines.filter(Boolean).join('\n');
    } catch {
      return null;
    }
  }
}
