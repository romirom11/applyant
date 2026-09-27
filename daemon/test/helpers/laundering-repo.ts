// Reproduces the solovei sync bug: other contributors' work credited to the candidate.
//   - the candidate's only nearby commit is an unrelated dashboard fix;
//   - the features (embedding reuse, prompt caching layout, silence trimming) were written by
//     another author (Claude), in a PR the candidate opened (#165).
// A citation of either the dashboard commit or PR #165 must not make the features the
// candidate's work.
import { join } from 'node:path';
import type { GithubApi, PullRequest } from '../../src/domain/knowledge/sources/github.ts';
import { buildRepo } from './git-repo.ts';

export const CANDIDATE = { author: 'Roman Example', email: 'roman@example.com' };
export const CLAUDE = { author: 'Claude', email: 'noreply@anthropic.com' };
export const CANDIDATE_IDS = { logins: ['romanex'], emails: ['roman@example.com'] };

export const FEATURE_CLAIM =
  'Built embedding deduplication, prompt caching layout, and STT silence trimming';
export const CONTROL_CLAIM = 'Built the Ringostat webhook router and awaiting-recording poller';

export interface LaunderingRepo {
  path: string;
  /** dashboard fix (candidate) · embeddings · prompt caching · silence trimming (Claude) · ringostat (candidate) */
  shas: string[];
  gh: GithubApi;
}

export function buildLaunderingRepo(dir: string): LaunderingRepo {
  const path = join(dir, 'callcenter');
  const shas = buildRepo(path, [
    {
      ...CANDIDATE,
      message: "fix(dashboard): don't store widget functions in layout (white screen)",
      files: { 'frontend/dashboard/layout.ts': 'export const layout = {};\n' },
    },
    {
      ...CLAUDE,
      message: 'feat(embeddings): reuse stored vectors for repeated texts, skip unchanged ones',
      files: { 'backend/embeddings/cache.py': 'CACHE = {}\n' },
    },
    {
      ...CLAUDE,
      message: 'feat(analysis): cross-call prompt caching via static-prefix request layout',
      files: { 'backend/analysis/prompt.py': 'PREFIX = ""\n' },
    },
    {
      ...CLAUDE,
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
  ]);
  const commit = (i: number, headline: string, by: { email: string }, login: string | null) => ({
    oid: shas[i] ?? '',
    headline,
    authors: [{ email: by.email, login }],
  });
  const prs: PullRequest[] = [
    {
      number: 165,
      title: 'Embedding dedup, prompt caching layout, and STT silence trimming',
      state: 'MERGED',
      merged: true,
      commits: [
        commit(1, 'feat(embeddings): reuse stored vectors for repeated texts', CLAUDE, 'claude'),
        commit(
          2,
          'feat(analysis): cross-call prompt caching via static-prefix request layout',
          CLAUDE,
          'claude',
        ),
        commit(
          3,
          'feat(stt): optional long-silence trimming before transcription',
          CLAUDE,
          'claude',
        ),
      ],
    },
    {
      number: 131,
      title: "fix(dashboard): don't store widget functions in layout (white screen)",
      state: 'MERGED',
      merged: true,
      commits: [
        commit(0, "fix(dashboard): don't store widget functions in layout", CANDIDATE, 'romanex'),
      ],
    },
  ];
  const gh: GithubApi = {
    commitsBy: async () => [],
    pullRequestsBy: async () => prs,
    meta: async () => null,
  };
  return { path, shas, gh };
}
