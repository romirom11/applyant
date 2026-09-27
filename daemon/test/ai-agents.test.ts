// Owner decision (phase 2): commits by the candidate's AI coding agents (Claude Code, Codex,
// Cursor, Copilot) are the candidate's own work in a repo the candidate owns, or in a PR the
// candidate opened or merged. Elsewhere, and for automation bots always, they are not.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentMatcher,
  DEFAULT_AI_AGENTS,
  defaultAgentIds,
} from '../src/domain/knowledge/ai-agents.ts';
import { listFacts } from '../src/domain/knowledge/facts.ts';
import {
  getIdentities,
  parseProfileValue,
  setProfileValue,
} from '../src/domain/knowledge/profile.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import { readGithubSource } from '../src/domain/knowledge/sources/github.ts';
import { addSource } from '../src/domain/knowledge/sources/registry.ts';
import { syncSource } from '../src/domain/knowledge/sync.ts';
import type { ProviderRequest } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { SourceExtraction } from '../src/models/schemas/index.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';
import {
  buildLaunderingRepo,
  CANDIDATE_IDS,
  CLAUDE,
  FEATURE_CLAIM,
  type LaunderingOptions,
} from './helpers/laundering-repo.ts';

describe('agent identities', () => {
  const m = new AgentMatcher(defaultAgentIds());

  it('know Claude Code, Cursor, the Copilot agent and Codex by their real identities', () => {
    expect(DEFAULT_AI_AGENTS.map((a) => a.agent)).toEqual([
      'Claude Code',
      'Cursor',
      'GitHub Copilot coding agent',
      'OpenAI Codex',
    ]);
    expect(m.matches('noreply@anthropic.com')).toBe(true);
    expect(m.matches('NoReply@Anthropic.com')).toBe(true);
    expect(m.matches('cursoragent@cursor.com')).toBe(true);
    expect(m.matches('198982749+Copilot@users.noreply.github.com')).toBe(true);
    expect(m.matches('', 'chatgpt-codex-connector[bot]')).toBe(true);
    expect(m.matches('codex@openai.com')).toBe(true);
    expect(m.matches('199175422+chatgpt-codex-connector[bot]@users.noreply.github.com')).toBe(true);
    expect(m.matches('someone@example.com', 'claude')).toBe(true);
    expect(m.matches('dana@other.dev', 'danaother')).toBe(false);
  });

  it('never treat automation bots as agents, even if listed', () => {
    const listed = new AgentMatcher([
      ...defaultAgentIds(),
      'github-actions[bot]',
      'dependabot[bot]',
    ]);
    expect(listed.matches('41898282+github-actions[bot]@users.noreply.github.com')).toBe(false);
    expect(listed.matches('49699333+dependabot[bot]@users.noreply.github.com')).toBe(false);
    expect(listed.matches('', 'dependabot[bot]')).toBe(false);
  });

  it('extend through the ai_agent_identities profile key', () => {
    expect(parseProfileValue('ai_agent_identities', 'aider@example.dev, my-agent[bot]')).toEqual([
      'aider@example.dev',
      'my-agent[bot]',
    ]);
    expect(() => parseProfileValue('ai_agent_identities', 'github-actions[bot]')).toThrow(
      /automation bot/,
    );
    expect(() => parseProfileValue('ai_agent_identities', 'dependabot')).toThrow(/automation bot/);
    expect(() => parseProfileValue('ai_agent_identities', 'not valid!')).toThrow(
      /neither a commit email nor a GitHub login/,
    );
    const t = tempDb();
    try {
      setProfileValue(t.db, 'ai_agent_identities', ['Aider@Example.dev'], new Date());
      const ids = getIdentities(t.db);
      expect(ids.agents).toEqual(
        expect.arrayContaining(['noreply@anthropic.com', 'aider@example.dev']),
      );
    } finally {
      t.cleanup();
    }
  });
});

describe("the candidate's AI agent commits", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-agents-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let n = 0;
  const read = async (o: LaunderingOptions, owner?: string) => {
    const repo = buildLaunderingRepo(join(dir, `r${++n}`), { other: CLAUDE, ...o });
    const m = await readGithubSource(repo.path, {
      reposDir: join(dir, 'repos'),
      identities: CANDIDATE_IDS,
      signal: new AbortController().signal,
      log: quietLog,
      gh: repo.gh,
      ...(owner !== undefined ? { owner } : {}),
    });
    const a = m.authorship;
    if (!a) throw new Error('no authorship');
    return { repo, m, a };
  };

  it("count as the candidate's in a repository the candidate owns", async () => {
    const { repo, m, a } = await read({}, 'RomanEx');
    const [dashboard, embeddings, caching, silence, ringostat, release] = repo.shas;
    expect(a.candidateShas).toEqual(new Set([dashboard, embeddings, caching, silence, ringostat]));
    // Automation stays other contributors' work.
    expect(a.otherShas).toEqual(new Set([release]));
    expect(a.candidatePrs).toEqual(new Set([165, 131]));
    // The claim check sees the agent's commits like any of the candidate's.
    expect(a.refs.get(embeddings ?? '')?.title).toBe(
      'feat(embeddings): reuse stored vectors for repeated texts, skip unchanged ones',
    );
    expect(a.refs.get('pr:165')?.title).toContain('cross-call prompt caching');

    // No AI label reaches the extractor: they're listed as the candidate's commits.
    const mine = m.text.slice(
      m.text.indexOf('## Commits by the candidate'),
      m.text.indexOf('## Commits by other'),
    );
    expect(mine).toContain('(5 of 6)');
    expect(mine).toContain('reuse stored vectors');
    expect(mine).not.toMatch(/claude|\bAI\b|agent/i);
    expect(m.text).toContain('github-actions[bot] — 1 commits');
  });

  it('count in a repository the candidate does not own only through their PRs', async () => {
    // Opened by the candidate: its agent commits are the candidate's.
    const opened = await read({}, 'acme');
    expect(opened.a.candidateShas).toEqual(
      new Set([
        opened.repo.shas[0],
        opened.repo.shas[1],
        opened.repo.shas[2],
        opened.repo.shas[3],
        opened.repo.shas[4],
      ]),
    );

    // Merged by the candidate (someone else opened it): that commit counts, the rest don't.
    const merged = await read(
      {
        candidateOpened165: false,
        // Only the embeddings commit was in a PR the candidate merged.
        associated: (shas, repoShas) =>
          new Map(
            shas.map((sha) => [
              sha,
              [
                {
                  number: 170,
                  author: 'someone',
                  mergedBy: sha === repoShas[1] ? 'RomanEx' : 'someone',
                },
              ],
            ]),
          ),
      },
      'acme',
    );
    expect(merged.a.candidateShas.has(merged.repo.shas[1] ?? '')).toBe(true);
    expect(merged.a.otherShas.has(merged.repo.shas[2] ?? '')).toBe(true);
    expect(merged.a.otherShas.has(merged.repo.shas[3] ?? '')).toBe(true);
  });

  it("stay other contributors' work in someone else's repo the candidate neither opened nor merged", async () => {
    const { repo, m, a } = await read(
      {
        candidateOpened165: false,
        associated: (shas) =>
          new Map(
            shas.map((sha) => [sha, [{ number: 165, author: 'someone', mergedBy: 'someone' }]]),
          ),
      },
      'acme',
    );
    const [dashboard, embeddings, caching, silence, ringostat, release] = repo.shas;
    expect(a.candidateShas).toEqual(new Set([dashboard, ringostat]));
    expect(a.otherShas).toEqual(new Set([embeddings, caching, silence, release]));
    expect(a.candidatePrs).toEqual(new Set([131]));
    expect(m.text).toContain('Claude — 3 commits');
  });

  it('stay other contributors’ work when the candidate lists no agents', async () => {
    const repo = buildLaunderingRepo(join(dir, 'no-agents'), { other: CLAUDE });
    const m = await readGithubSource(repo.path, {
      reposDir: join(dir, 'repos'),
      identities: { ...CANDIDATE_IDS, agents: [] },
      signal: new AbortController().signal,
      log: quietLog,
      gh: repo.gh,
    });
    expect(m.authorship?.candidateShas.size).toBe(2);
  });
});

describe('sync_source with the candidate’s agent commits', () => {
  it('stores their work as ordinary personal_contribution facts, bots as team context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'applyant-agents-sync-'));
    const repo = buildLaunderingRepo(dir, { other: CLAUDE });
    const t = tempDb();
    const bus = new EventBus();
    const now = new Date('2026-09-27T10:00:00Z');
    const sha = (i: number) => repo.shas[i]?.slice(0, 10) ?? '';
    const extraction: SourceExtraction = {
      projects: [{ name: 'Callcenter', summary: null, role: null, period: null, stack: [] }],
      facts: [
        {
          text: FEATURE_CLAIM,
          kind: 'personal_contribution',
          project: 'Callcenter',
          evidence: [1, 2, 3].map((i) => ({ locator: `commit:${sha(i)}`, quote: null })),
        },
        {
          text: 'Automated version bumps on release',
          kind: 'personal_contribution',
          project: 'Callcenter',
          evidence: [{ locator: `commit:${sha(5)}`, quote: 'chore(release): bump version' }],
        },
      ],
    };
    const verifier: string[] = [];
    const fake = new FakeProvider('claude', [
      { output: extraction },
      (req: ProviderRequest) => {
        verifier.push(req.prompt);
        return {
          kind: 'ok',
          model: req.model,
          usage: null,
          output: {
            verdicts: [{ claim: 1, supported: true, issue: 'none', note: 'all three shown' }],
          },
        };
      },
    ]);
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir, db: t.db, providers: [fake], github: repo.gh }),
      handlers: handlers({ sync_source: syncSource }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
    });
    try {
      setProfileValue(t.db, 'github_logins', CANDIDATE_IDS.logins, now);
      setProfileValue(t.db, 'commit_emails', CANDIDATE_IDS.emails, now);
      const project = createProject(t.db, { name: 'Callcenter' }, now);
      // A local repository counts as the candidate's own.
      addSource(t.db, bus, { project: project.slug, kind: 'github', locator: repo.path, now });
      worker.start();
      await worker.idle();

      expect(verifier[0]).toContain(`Claim 1 (personal_contribution): ${FEATURE_CLAIM}`);
      expect(verifier[0]).toContain('feat(embeddings): reuse stored vectors for repeated texts');
      expect(verifier[0]).toContain('files: backend/stt/trim.py');
      expect(verifier[0]).not.toContain('Automated version bumps');

      const stored = listFacts(t.db, { projectId: project.id });
      expect(stored.find((f) => f.text === FEATURE_CLAIM)).toMatchObject({
        kind: 'personal_contribution',
        status: 'unconfirmed',
      });
      expect(stored.find((f) => f.text.includes('version bumps'))?.kind).toBe('team_context');
      expect(stored.some((f) => /claude|\bAI\b/i.test(f.text))).toBe(false);
    } finally {
      await worker.stop();
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
