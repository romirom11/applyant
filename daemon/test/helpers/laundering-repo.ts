// Reproduces the solovei sync bug: other contributors' work credited to the candidate.
//   - the candidate's only nearby commit is an unrelated dashboard fix;
//   - the features (embedding reuse, prompt caching layout, silence trimming) were written by
//     another author, in a PR the candidate opened (#165).
// With a genuine other human as that author, a citation of either the dashboard commit or
// PR #165 must not make the features the candidate's. With the candidate's AI coding agent
// (Claude) as the author, the features are the candidate's in a repo they own or in a PR
// they opened or merged, and nowhere else.
import { join } from 'node:path';
import { defaultAgentIds } from '../../src/domain/knowledge/ai-agents.ts';
import type {
  AssociatedPullRequest,
  GithubApi,
  PullRequest,
} from '../../src/domain/knowledge/sources/github.ts';
import { buildRepo } from './git-repo.ts';

export const CANDIDATE = { author: 'Roman Example', email: 'roman@example.com' };
export const OTHER_HUMAN = { author: 'Dana Other', email: 'dana@other.dev', login: 'danaother' };
export const CLAUDE = { author: 'Claude', email: 'noreply@anthropic.com', login: 'claude' };
export const ACTIONS_BOT = {
  author: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
  login: 'github-actions[bot]',
};
export const CANDIDATE_IDS = {
  logins: ['romanex'],
  emails: ['roman@example.com'],
  agents: defaultAgentIds(),
};

export const FEATURE_CLAIM =
  'Built embedding deduplication, prompt caching layout, and STT silence trimming';
export const CONTROL_CLAIM = 'Built the Ringostat webhook router and awaiting-recording poller';

export interface LaunderingRepo {
  path: string;
  /**
   * 0 dashboard fix (candidate) · 1 embeddings · 2 prompt caching · 3 silence trimming
   * (the other author) · 4 ringostat (candidate) · 5 release bump (github-actions)
   */
  shas: string[];
  gh: GithubApi;
}

export interface LaunderingOptions {
  other?: { author: string; email: string; login: string };
  /** Whether PR #165 appears among the PRs the candidate opened. */
  candidateOpened165?: boolean;
  /** What GitHub says about the PRs of each commit (for "merged by the candidate"). */
  associated?: (shas: string[], repoShas: string[]) => Map<string, AssociatedPullRequest[]>;
}

export function buildLaunderingRepo(dir: string, o: LaunderingOptions = {}): LaunderingRepo {
  const other = o.other ?? OTHER_HUMAN;
  const path = join(dir, `callcenter-${other.login}`);
  const shas = buildRepo(path, [
    {
      ...CANDIDATE,
      message: "fix(dashboard): don't store widget functions in layout (white screen)",
      files: { 'frontend/dashboard/layout.ts': 'export const layout = {};\n' },
    },
    {
      ...other,
      message: 'feat(embeddings): reuse stored vectors for repeated texts, skip unchanged ones',
      files: { 'backend/embeddings/cache.py': 'CACHE = {}\n' },
    },
    {
      ...other,
      message: 'feat(analysis): cross-call prompt caching via static-prefix request layout',
      files: { 'backend/analysis/prompt.py': 'PREFIX = ""\n' },
    },
    {
      ...other,
      message: 'feat(stt): optional long-silence trimming before transcription',
      files: { 'backend/stt/trim.py': 'def trim(): ...\n' },
    },
    {
      ...CANDIDATE,
      message: 'feat(ringostat): webhook router, rotation endpoints, awaiting-recording poller',
      files: {
        'backend/ringostat/router.py': 'router = None\n',
        'backend/ringostat/poller.py': 'def poll(): ...\n',
      },
    },
    {
      ...ACTIONS_BOT,
      message: 'chore(release): bump version to 1.4.0',
      files: { VERSION: '1.4.0\n' },
    },
  ]);
  const commit = (i: number, headline: string, by: { email: string; login: string }) => ({
    oid: shas[i] ?? '',
    headline,
    authors: [{ email: by.email, login: by.login }],
  });
  const pr165: PullRequest = {
    number: 165,
    title: 'Embedding dedup, prompt caching layout, and STT silence trimming',
    state: 'MERGED',
    merged: true,
    commits: [
      commit(1, 'feat(embeddings): reuse stored vectors for repeated texts', other),
      commit(
        2,
        'feat(analysis): cross-call prompt caching via static-prefix request layout',
        other,
      ),
      commit(3, 'feat(stt): optional long-silence trimming before transcription', other),
    ],
  };
  const pr131: PullRequest = {
    number: 131,
    title: "fix(dashboard): don't store widget functions in layout (white screen)",
    state: 'MERGED',
    merged: true,
    commits: [
      commit(0, "fix(dashboard): don't store widget functions in layout", {
        ...CANDIDATE,
        login: 'romanex',
      }),
    ],
  };
  const opened = o.candidateOpened165 === false ? [pr131] : [pr165, pr131];
  const gh: GithubApi = {
    commitsBy: async () => [],
    pullRequestsBy: async () => opened,
    associatedPullRequests: async (list) => o.associated?.(list, shas) ?? new Map(),
    meta: async () => null,
  };
  return { path, shas, gh };
}
