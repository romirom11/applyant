// Regression (phase 2 manual check, solovei): other contributors' work was credited to the
// candidate through a citation that belonged to the candidate but didn't show the work.
//   A. an unrelated commit of the candidate's cited for another author's features
//      → the claim check leaves the fact out;
//   B. a PR the candidate opened, but whose commits are all another author's
//      → the authorship rule makes the fact team context.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sources } from '../src/db/schema.ts';
import { TEAM_PREFIX } from '../src/domain/knowledge/authorship.ts';
import { claimCheckPrompt } from '../src/domain/knowledge/claim-check.ts';
import { listFacts } from '../src/domain/knowledge/facts.ts';
import { setProfileValue } from '../src/domain/knowledge/profile.ts';
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
  CONTROL_CLAIM,
  FEATURE_CLAIM,
  type LaunderingRepo,
} from './helpers/laundering-repo.ts';

let dir: string;
let repo: LaunderingRepo;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'applyant-claims-'));
  repo = buildLaunderingRepo(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = () =>
  readGithubSource(repo.path, {
    reposDir: join(dir, 'repos'),
    identities: CANDIDATE_IDS,
    signal: new AbortController().signal,
    log: quietLog,
    gh: repo.gh,
  });

describe('pull requests the candidate opened', () => {
  it('count as the candidate’s only through the commits the candidate wrote', async () => {
    const m = await read();
    const a = m.authorship;
    expect(a?.candidateShas).toEqual(new Set([repo.shas[0], repo.shas[4]]));
    expect(a?.candidatePrs).toEqual(new Set([131]));
    expect(a?.otherPrs).toEqual(new Set([165]));

    // The extractor is told which PRs are really the candidate's.
    const own = m.text.slice(m.text.indexOf("## Pull requests with the candidate's own commits"));
    expect(own).toContain("- #131 merged: fix(dashboard): don't store widget functions");
    expect(own.slice(0, own.indexOf('## Commits by other'))).not.toContain('#165');
    expect(m.text).toContain(
      '## Pull requests the candidate opened but other contributors wrote (1) — team context only',
    );
    expect(m.text).toContain('- #165 (cite as pr:#165): Embedding dedup, prompt caching layout');

    // A PR's detail for the claim check lists only the candidate's own commits in it.
    expect(a?.refs.get('pr:131')?.title).toContain(
      "the candidate's commits in it: fix(dashboard): don't store widget functions in layout",
    );
    expect(a?.refs.get(repo.shas[0] ?? '')).toMatchObject({
      ref: `commit:${repo.shas[0]?.slice(0, 12)}`,
      paths: ['frontend/dashboard/layout.ts'],
    });
  });
});

describe('sync_source on the laundering fixture', () => {
  it('keeps neither citation route from crediting another author’s features', async () => {
    const t = tempDb();
    const bus = new EventBus();
    const now = new Date('2026-09-27T10:00:00Z');
    const cite = (locator: string, quote: string | null = null) => [{ locator, quote }];
    const extraction: SourceExtraction = {
      projects: [
        {
          kind: 'project',
          name: 'Callcenter',
          summary: null,
          role: null,
          period: null,
          stack: ['Python'],
        },
      ],
      facts: [
        {
          // A: the candidate's unrelated dashboard commit cited for Claude's features.
          text: FEATURE_CLAIM,
          kind: 'personal_contribution',
          project: 'Callcenter',
          evidence: cite(`commit:${repo.shas[0]?.slice(0, 10)}`),
        },
        {
          // B: the PR the candidate opened, whose commits are all Claude's.
          text: 'Added cross-call prompt caching with a static-prefix request layout',
          kind: 'personal_contribution',
          project: 'Callcenter',
          evidence: cite(
            'pr:#165',
            'Embedding dedup, prompt caching layout, and STT silence trimming',
          ),
        },
        {
          // Control: a claim the candidate's commit does show.
          text: CONTROL_CLAIM,
          kind: 'personal_contribution',
          project: 'Callcenter',
          evidence: cite(`commit:${repo.shas[4]?.slice(0, 10)}`),
        },
      ],
    };
    const verifierPrompts: string[] = [];
    const fake = new FakeProvider('claude', [
      { output: extraction },
      (req: ProviderRequest) => {
        verifierPrompts.push(req.prompt);
        return {
          kind: 'ok',
          model: req.model,
          usage: null,
          output: {
            verdicts: [
              {
                claim: 1,
                supported: false,
                issue: 'unrelated',
                note: 'The commit fixes the dashboard layout.',
              },
              {
                claim: 2,
                supported: true,
                issue: 'none',
                note: 'Router and poller are in the commit.',
              },
            ],
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
      const { source } = addSource(t.db, bus, {
        project: project.slug,
        kind: 'github',
        locator: repo.path,
        now,
      });
      worker.start();
      await worker.idle();

      // The claim check saw A with the dashboard commit it cites, and the control; B never
      // reached it (the authorship rule already made it team context).
      expect(fake.requests.map((r) => r.role)).toEqual(['extractor', 'claim_verifier']);
      const prompt = verifierPrompts[0] ?? '';
      expect(prompt).toContain(
        `Claim 1 (personal_contribution): ${FEATURE_CLAIM}\nCited:\n- commit:${repo.shas[0]?.slice(0, 12)}: fix(dashboard): don't store widget functions in layout (white screen)\n  files: frontend/dashboard/layout.ts`,
      );
      expect(prompt).toContain(`Claim 2 (personal_contribution): ${CONTROL_CLAIM}`);
      expect(prompt).not.toContain('Added cross-call prompt caching');
      // Other contributors' commits are never shown to the verifier as support.
      expect(prompt).not.toContain('reuse stored vectors');

      const stored = listFacts(t.db, { projectId: project.id });
      const mine = stored.filter((f) => f.kind === 'personal_contribution').map((f) => f.text);
      expect(mine).toEqual([CONTROL_CLAIM]);
      expect(stored.some((f) => f.text.includes('embedding deduplication'))).toBe(false);
      expect(stored.find((f) => f.text.includes('prompt caching'))).toMatchObject({
        kind: 'team_context',
        text: `${TEAM_PREFIX}Added cross-call prompt caching with a static-prefix request layout`,
      });
      const note = t.db.select().from(sources).where(eq(sources.id, source.id)).get()?.syncNote;
      expect(note).toMatch(
        /^2 new facts.* · 1 attributed to other contributors · 1 left out: the cited commits don't show them/,
      );
    } finally {
      await worker.stop();
      t.cleanup();
    }
  });

  it('counts a claim the verifier gave no verdict for as unsupported', async () => {
    const t = tempDb();
    const bus = new EventBus();
    const now = new Date('2026-09-27T10:00:00Z');
    const fake = new FakeProvider('claude', [
      {
        output: {
          projects: [],
          facts: [
            {
              text: CONTROL_CLAIM,
              kind: 'personal_contribution',
              project: null,
              evidence: [{ locator: `commit:${repo.shas[4]}`, quote: null }],
            },
          ],
        },
      },
      { output: { verdicts: [] } },
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
      setProfileValue(t.db, 'commit_emails', CANDIDATE_IDS.emails, now);
      const project = createProject(t.db, { name: 'Callcenter' }, now);
      addSource(t.db, bus, { project: project.slug, kind: 'github', locator: repo.path, now });
      worker.start();
      await worker.idle();
      expect(listFacts(t.db)).toEqual([]);
    } finally {
      await worker.stop();
      t.cleanup();
    }
  });
});

describe('the claim check prompt', () => {
  it('numbers claims across batches and caps long path lists', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const p = claimCheckPrompt(
      [
        {
          text: 'Refactored the API',
          kind: 'personal_contribution',
          refs: [{ ref: 'commit:abc', title: 'refactor api', body: 'split handlers', paths }],
        },
      ],
      60,
    );
    expect(p).toContain('Claim 61 (personal_contribution): Refactored the API');
    expect(p).toContain('  message: split handlers');
    expect(p).toContain('src/f11.ts, +8 more');
    expect(p).toContain('(numbers 61–61)');
  });
});
