// Builds a small git repository with commits by several authors (for github source tests).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FixtureCommit {
  author: string;
  email: string;
  message: string;
  files: Record<string, string>;
}

export function buildRepo(dir: string, commits: FixtureCommit[]): string[] {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env },
      encoding: 'utf8',
    }).trim();
  git(['init', '--quiet']);
  const shas: string[] = [];
  commits.forEach((c, i) => {
    for (const [path, content] of Object.entries(c.files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(['add', '-A']);
    const date = `2024-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`;
    git(['commit', '--quiet', '-m', c.message], {
      GIT_AUTHOR_NAME: c.author,
      GIT_AUTHOR_EMAIL: c.email,
      GIT_COMMITTER_NAME: c.author,
      GIT_COMMITTER_EMAIL: c.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    shas.push(git(['rev-parse', 'HEAD']));
  });
  return shas;
}
