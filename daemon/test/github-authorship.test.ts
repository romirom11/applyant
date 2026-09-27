// GitHub facts about personal contribution come only from commits by the candidate's
// identities. Everyone else's work becomes team_context, however the model labels it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { facts, sources } from '../src/db/schema.ts';
import { applyAuthorship, TEAM_PREFIX } from '../src/domain/knowledge/authorship.ts';
import { listFacts } from '../src/domain/knowledge/facts.ts';
import { setProfileValue } from '../src/domain/knowledge/profile.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import { readGithubSource } from '../src/domain/knowledge/sources/github.ts';
import type { Authorship } from '../src/domain/knowledge/sources/material.ts';
import { addSource } from '../src/domain/knowledge/sources/registry.ts';
import { syncSource } from '../src/domain/knowledge/sync.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { SourceExtraction } from '../src/models/schemas/index.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';
import { buildRepo } from './helpers/git-repo.ts';

const ALEX = { author: 'Alex Example', email: 'alex@example.com' };
const ALEX_NOREPLY = { author: 'Alex Example', email: '1234+alexgh@users.noreply.github.com' };
const JANE = { author: 'Jane Other', email: 'jane@other.dev' };

let dir: string;
let repo: string;
let shas: string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'applyant-gh-'));
  repo = join(dir, 'nightingale');
  shas = buildRepo(repo, [
    {
      ...ALEX,
      message: 'Add call-analysis pipeline',
      files: { 'src/pipeline/run.py': 'print(1)\n' },
    },
    { ...JANE, message: 'Add iOS client', files: { 'ios/App.swift': 'import SwiftUI\n' } },
    {
      ...ALEX_NOREPLY,
      message: 'Tune batch size to 500',
      files: { 'src/pipeline/batch.py': 'N = 500\n' },
    },
    {
      ...JANE,
      message: 'Write README',
      files: { 'README.md': '# Nightingale\n\nCall analytics for sales teams.\n' },
    },
  ]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const identities = { logins: ['alexgh'], emails: ['alex@example.com'] };

describe('the repository digest', () => {
  it("splits history into the candidate's commits and everyone else's", async () => {
    const m = await readGithubSource(repo, {
      reposDir: join(dir, 'repos'),
      identities,
      signal: new AbortController().signal,
      log: quietLog,
      useGh: false,
    });
    expect(m.authorship?.candidateShas).toEqual(new Set([shas[0], shas[2]]));
    expect(m.authorship?.otherShas).toEqual(new Set([shas[1], shas[3]]));
    expect(m.label).toBe(`${repo} · 4 commits (2 by the candidate)`);

    const mine = m.text.slice(
      m.text.indexOf('## Commits by the candidate'),
      m.text.indexOf('## Commits by other'),
    );
    const theirs = m.text.slice(
      m.text.indexOf('## Commits by other'),
      m.text.indexOf('## Directory'),
    );
    expect(mine).toContain('(2 of 4)');
    expect(mine).toContain(
      `${shas[0]?.slice(0, 10)} 2024-01-01 Add call-analysis pipeline [src/pipeline/run.py]`,
    );
    expect(mine).toContain('Tune batch size to 500');
    expect(mine).not.toContain('iOS');
    expect(theirs).toContain('Jane Other — 2 commits');
    expect(theirs).toContain('Add iOS client');
    expect(m.text).toContain('## README.md — cite as path:README.md\n# Nightingale');

    // A second read reuses (and fetches into) the existing clone.
    const again = await readGithubSource(repo, {
      reposDir: join(dir, 'repos'),
      identities,
      signal: new AbortController().signal,
      log: quietLog,
      useGh: false,
    });
    expect(again.text).toBe(m.text);
  });

  it('attributes nothing to the candidate when no identities are configured', async () => {
    const m = await readGithubSource(repo, {
      reposDir: join(dir, 'repos'),
      identities: { logins: [], emails: [] },
      signal: new AbortController().signal,
      log: quietLog,
      useGh: false,
    });
    expect(m.authorship?.candidateShas.size).toBe(0);
    expect(m.text).toContain('None are configured');
  });
});

describe('the authorship rule', () => {
  const a = (): Authorship => ({
    candidateShas: new Set([shas[0] ?? '', shas[2] ?? '']),
    otherShas: new Set([shas[1] ?? '', shas[3] ?? '']),
    candidatePrs: new Set([12]),
    otherPrs: new Set([13]),
    refs: new Map(),
  });
  const cite = (...locators: string[]) => locators.map((locator) => ({ locator, excerpt: null }));

  it("keeps a contribution backed by the candidate's own commit or PR", () => {
    const own = applyAuthorship(
      {
        text: 'Built the call-analysis pipeline',
        kind: 'personal_contribution',
        evidence: cite(`commit:${shas[0]?.slice(0, 7)}`),
      },
      a(),
    );
    expect(own.downgraded).toBe(false);
    expect(own.fact.kind).toBe('personal_contribution');
    expect(own.fact.evidence[0]?.locator).toBe(`commit:${shas[0]?.slice(0, 12)}`);
    expect(own.candidateRefs).toEqual([shas[0]]);
    const pr = applyAuthorship(
      { text: 'Added retries', kind: 'personal_contribution', evidence: cite('pr:#12') },
      a(),
    );
    expect(pr).toMatchObject({ downgraded: false, candidateRefs: ['pr:12'] });
  });

  it('treats a PR the candidate opened but others wrote as team evidence only', () => {
    const res = applyAuthorship(
      { text: 'Added caching', kind: 'personal_contribution', evidence: cite('pr:#13') },
      a(),
    );
    expect(res).toMatchObject({
      downgraded: true,
      candidateRefs: [],
      fact: { kind: 'team_context' },
    });
    expect(res.fact.evidence.map((e) => e.locator)).toEqual(['pr:#13']);
  });

  it("turns a claim backed only by someone else's commit into team context", () => {
    const res = applyAuthorship(
      {
        text: 'Built the iOS client',
        kind: 'personal_contribution',
        evidence: cite(`commit:${shas[1]}`),
      },
      a(),
    );
    expect(res).toMatchObject({
      downgraded: true,
      fact: { kind: 'team_context', text: `${TEAM_PREFIX}Built the iOS client` },
    });
  });

  it('drops invented commits and PRs, and then the claim has no support', () => {
    const res = applyAuthorship(
      {
        text: 'Designed the data model',
        kind: 'personal_contribution',
        evidence: cite('commit:deadbeefcafe', 'pr:#99', 'path:README.md'),
      },
      a(),
    );
    expect(res.downgraded).toBe(true);
    expect(res.fact.evidence.map((e) => e.locator)).toEqual(['path:README.md']);
  });

  it('applies to skills, roles and impact too, but leaves team context alone', () => {
    for (const kind of ['skill', 'role', 'impact'] as const) {
      const res = applyAuthorship(
        { text: 'Swift', kind, evidence: cite('path:ios/App.swift') },
        a(),
      );
      expect(res.fact.kind).toBe('team_context');
    }
    const team = applyAuthorship(
      {
        text: 'Jane Other wrote the iOS client',
        kind: 'team_context',
        evidence: cite(`commit:${shas[1]}`),
      },
      a(),
    );
    expect(team).toMatchObject({
      downgraded: false,
      fact: { text: 'Jane Other wrote the iOS client' },
    });
  });
});

describe('sync_source on a repository', () => {
  it("stores others' work as team_context and never as the candidate's", async () => {
    const t = tempDb();
    const bus = new EventBus();
    const now = new Date('2026-09-27T10:00:00Z');
    const extraction: SourceExtraction = {
      projects: [
        {
          name: 'Nightingale',
          summary: 'Call analytics for sales teams',
          role: null,
          period: null,
          stack: ['Python', 'Swift'],
        },
      ],
      facts: [
        {
          text: 'Built the call-analysis pipeline in Python',
          kind: 'personal_contribution',
          project: 'Nightingale',
          evidence: [
            { locator: `commit:${shas[0]?.slice(0, 10)}`, quote: 'Add call-analysis pipeline' },
          ],
        },
        {
          // The model got this wrong: Jane wrote the iOS client.
          text: 'Built the iOS client in SwiftUI',
          kind: 'personal_contribution',
          project: 'Nightingale',
          evidence: [{ locator: `commit:${shas[1]?.slice(0, 10)}`, quote: 'Add iOS client' }],
        },
        {
          text: 'Nightingale does call analytics for sales teams',
          kind: 'team_context',
          project: 'Nightingale',
          evidence: [{ locator: 'path:README.md', quote: 'Call analytics for sales teams.' }],
        },
      ],
    };
    const fake = new FakeProvider('claude', [
      { output: extraction },
      // The claim check sees only the one fact still credited to the candidate.
      { output: { verdicts: [{ claim: 1, supported: true, issue: 'none', note: 'matches' }] } },
    ]);
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir, db: t.db, providers: [fake] }),
      handlers: handlers({ sync_source: syncSource }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
    });
    try {
      setProfileValue(t.db, 'github_logins', ['alexgh'], now);
      setProfileValue(t.db, 'commit_emails', ['alex@example.com'], now);
      const project = createProject(t.db, { name: 'Nightingale' }, now);
      const { source } = addSource(t.db, bus, {
        project: project.slug,
        kind: 'github',
        locator: repo,
        now,
      });
      worker.start();
      await worker.idle();

      const prompt = fake.requests[0]?.prompt ?? '';
      expect(prompt).toContain('## Commits by the candidate (2 of 4)');
      expect(prompt).toContain("must cite the candidate's own commits");
      expect(fake.requests[1]?.role).toBe('claim_verifier');
      expect(fake.requests[1]?.model).toBe('haiku');
      expect(fake.requests[1]?.prompt).toMatch(
        /^Claim 1 \(personal_contribution\): Built the call-analysis pipeline in Python\nCited:\n- commit:[0-9a-f]{12}: Add call-analysis pipeline\n {2}files: src\/pipeline\/run\.py/,
      );

      const stored = listFacts(t.db, { projectId: project.id });
      const byText = (s: string) => stored.find((f) => f.text.includes(s));
      expect(byText('call-analysis pipeline')).toMatchObject({
        kind: 'personal_contribution',
        status: 'unconfirmed',
        origin: 'extracted',
      });
      expect(byText('call-analysis pipeline')?.evidence[0]).toMatchObject({
        sourceKind: 'github',
        locator: `commit:${shas[0]?.slice(0, 12)}`,
        excerpt: 'Add call-analysis pipeline',
      });
      expect(byText('iOS client')).toMatchObject({
        kind: 'team_context',
        text: `${TEAM_PREFIX}Built the iOS client in SwiftUI`,
      });
      // Nothing in personal_contribution cites anyone else's commit.
      const others = new Set([shas[1], shas[3]].map((s) => s?.slice(0, 12)));
      for (const f of stored.filter((x) => x.kind === 'personal_contribution')) {
        for (const e of f.evidence)
          expect(others.has(e.locator?.replace('commit:', ''))).toBe(false);
      }
      const row = t.db.select().from(sources).where(eq(sources.id, source.id)).get();
      expect(row?.syncNote).toMatch(/^3 new facts.*1 attributed to other contributors/);
      expect(t.db.select().from(facts).all()).toHaveLength(3);
    } finally {
      await worker.stop();
      t.cleanup();
    }
  });
});
