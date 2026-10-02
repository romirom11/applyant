// Which of the candidate's repositories is a project's code: names close in spelling, a name
// contained in the other, a word of the project's name, or a description naming the project
// or its stack. Repositories already a source of some project are never offered.
import { describe, expect, it } from 'vitest';
import {
  matchRepository,
  parseRepos,
  type Repository,
  RepositoryList,
  suggestRepositories,
} from '../src/domain/knowledge/repo-suggest.ts';

const repo = (name: string, description: string | null = null, owner = 'me'): Repository => ({
  url: `https://github.com/${owner}/${name}`,
  fullName: `${owner}/${name}`,
  name,
  description,
  pushedAt: new Date('2026-09-01T00:00:00Z'),
  private: false,
});

describe('matching a repository to a project', () => {
  const solovei = {
    name: 'Solovei',
    summary: 'AI speech analytics for sales teams: transcribes calls and analyses them with LLMs.',
    stack: ['Python', 'FastAPI', 'Speechmatics'],
  };

  it('by name: the same, drifted, containing, or sharing a word', () => {
    expect(matchRepository(solovei, repo('solovei'))).toMatchObject({
      score: 1,
      reason: 'the same name',
    });
    expect(matchRepository(solovei, repo('soloveim'))?.reason).toBe('its name contains Solovei');
    expect(matchRepository(solovei, repo('solovey'))?.reason).toBe('its name is close to Solovei');
    expect(matchRepository(solovei, repo('solovei-website'))?.reason).toBe(
      'its name contains Solovei',
    );
    expect(
      matchRepository(
        { name: 'Tech Lead at Acme Voice', summary: null, stack: [] },
        repo('acme-voice-api'),
      )?.reason,
    ).toBe('its name has "acme" in it');
    expect(matchRepository(solovei, repo('ua-tv-playlist'))).toBeNull();
  });

  it('by description: the project or its stack named', () => {
    const m = matchRepository(
      solovei,
      repo('call-analytics', 'Speechmatics STT pipeline for Solovei'),
    );
    expect(m?.score).toBeGreaterThanOrEqual(0.5);
    expect(m?.reason).toContain('its description names solovei');
    expect(m?.reason).toContain('speechmatics');
    // Stack alone is a hint, not a match.
    expect(matchRepository(solovei, repo('other', 'A FastAPI service'))?.score).toBeLessThan(0.5);
  });

  it('offers the likely ones first, leaves out what is already a source, keeps the rest', () => {
    const repos = [
      repo('ua-tv-playlist'),
      repo('solovei-website'),
      repo('solovei'),
      repo('soloveim', null, 'acme'),
    ];
    const { matches, others } = suggestRepositories(solovei, repos, [
      'https://github.com/acme/soloveim',
    ]);
    expect(matches.map((m) => m.fullName)).toEqual(['me/solovei', 'me/solovei-website']);
    expect(others.map((o) => o.fullName)).toEqual(['me/ua-tv-playlist']);
  });

  it("reads gh's listing, skipping forks and archived repositories", () => {
    const rows = parseRepos(
      JSON.stringify([
        {
          name: 'solovei',
          url: 'https://github.com/me/solovei',
          pushedAt: '2026-09-01T00:00:00Z',
          isPrivate: true,
          owner: { login: 'me' },
        },
        { name: 'fork', url: 'https://github.com/me/fork', isFork: true },
        { name: 'old', url: 'https://github.com/me/old', isArchived: true },
        { name: 'x', url: 'https://github.com/org/x', description: '  ' },
      ]),
    );
    expect(rows.map((r) => [r.fullName, r.private, r.description])).toEqual([
      ['me/solovei', true, null],
      ['org/x', false, null],
    ]);
    expect(parseRepos('not json')).toEqual([]);
  });

  it('lists the account and its organisations once, then from the cache', async () => {
    const calls: string[] = [];
    const list = new RepositoryList({
      fetch: async (args) => {
        calls.push(args.join(' '));
        if (args[1] === 'user') return 'me\n';
        if (args[1] === 'user/orgs') return 'acme\n';
        return JSON.stringify([
          {
            name: `${args[2]}-repo`,
            url: `https://github.com/${args[2]}/${args[2]}-repo`,
            owner: { login: args[2] },
          },
        ]);
      },
    });
    const first = await list.list();
    expect(first.accounts).toEqual(['me', 'acme']);
    expect(first.repos.map((r) => r.fullName)).toEqual(['me/me-repo', 'acme/acme-repo']);
    await list.list();
    expect(calls.filter((c) => c.startsWith('repo list'))).toHaveLength(2);
  });
});
