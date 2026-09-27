// score_posting through the queue with a scripted model: extraction and matching happen once
// and are cached; preference changes, feedback and re-runs re-score without model calls; only
// what changed is asked again; a limit mid-way doesn't throw away the extraction.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { facts, postings, providerPauses } from '../src/db/schema.ts';
import {
  embedFacts,
  enqueueEmbedFacts,
  ensureFactIndex,
} from '../src/domain/knowledge/embed-index.ts';
import { editFact } from '../src/domain/knowledge/facts.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import type { FactHit } from '../src/domain/knowledge/retrieve.ts';
import { scorePosting } from '../src/domain/scoring/handlers.ts';
import { type Candidates, matchKey, planMatches } from '../src/domain/scoring/match.ts';
import { getPreferences, parsePreference, setPreference } from '../src/domain/scoring/prefs.ts';
import { recordDecision, requestScoring, rescoreAll } from '../src/domain/scoring/store.ts';
import type { ProviderRequest, ProviderResult } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { fixedFx, handlers, quietLog, testDeps } from './helpers/deps.ts';

const EXTRACTION: PostingExtraction = {
  title: 'Senior AI Engineer',
  company: 'Acme AI',
  summary: 'Build LLM systems.',
  seniority: 'senior',
  roleFamilies: ['ai_ml'],
  requirements: [
    { text: 'Python in production', must: true, kind: 'skill' },
    { text: 'Kubernetes', must: true, kind: 'skill' },
    { text: 'Rust', must: false, kind: 'skill' },
  ],
  workplace: 'remote',
  remoteRegions: ['eu'],
  remoteCountries: [],
  offices: [],
  salary: {
    min: 2500,
    max: 2500,
    currency: 'EUR',
    period: 'month',
    basis: 'gross',
    text: '€2,500/month',
  },
  languages: [],
  postingLanguage: 'en',
  employment: 'full_time',
  outstaffing: false,
};

/** Answers like a sensible matcher: reads the requirement blocks and cites facts by keyword. */
function matcher(req: ProviderRequest): ProviderResult {
  const blocks = req.prompt.split(/\n\n(?=Requirement \d+ )/);
  const matches = blocks
    .map((block) => {
      const head = /^Requirement (\d+) \([^)]*\): (.+)$/m.exec(block);
      if (!head) return null;
      const n = Number(head[1]);
      const text = head[2] ?? '';
      const factLines = [...block.matchAll(/^ {2}#(\d+) \[[^\]]*\] (.+)$/gm)];
      const cite = (word: string) =>
        factLines.filter((m) => (m[2] ?? '').toLowerCase().includes(word)).map((m) => Number(m[1]));
      if (/rust/i.test(text))
        return { requirement: n, verdict: 'missing', factIds: [], note: 'no Rust' };
      if (/kubernetes/i.test(text)) {
        return {
          requirement: n,
          verdict: 'partial',
          factIds: cite('kubernetes'),
          note: 'used, not run',
        };
      }
      return { requirement: n, verdict: 'strong', factIds: cite('python'), note: 'built it' };
    })
    .filter(Boolean);
  return { kind: 'ok', output: { matches }, model: 'sonnet', usage: null };
}

describe('score_posting and re-scoring', () => {
  let t: TempDb;
  let bus: EventBus;
  let fake: FakeProvider;
  let worker: Worker;
  let fx: ReturnType<typeof fixedFx>;
  const now = new Date('2026-09-27T10:00:00Z');

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    fake = new FakeProvider('claude');
    fx = fixedFx();
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir, db: t.db, providers: [fake], read: t.read, fx }),
      handlers: handlers({ score_posting: scorePosting, embed_facts: embedFacts }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    t.cleanup();
  });

  const seedFacts = async () => {
    const p = createProject(t.db, { name: 'Solovei', period: '2021–2024' }, now);
    const add = (text: string) =>
      t.db
        .insert(facts)
        .values({
          text,
          kind: 'skill',
          status: 'unconfirmed',
          origin: 'extracted',
          projectId: p.id,
        })
        .returning({ id: facts.id })
        .get().id;
    const python = add('Built the call-analysis pipeline in Python and FastAPI');
    const k8s = add('Deployed the services with Kubernetes and Helm');
    add('Led a team of 4 engineers');
    ensureFactIndex(t.db, bus, 'hash-v1@256', now);
    await worker.idle();
    return { python, k8s };
  };

  const addPosting = () =>
    t.db
      .insert(postings)
      .values({
        stage: 'verified',
        canonicalUrl: 'https://jobs.example.com/acme/1',
        text: 'Senior AI Engineer at Acme AI. Python in production, Kubernetes; Rust a plus. €2,500/month.',
        verifiedAt: now,
      })
      .returning()
      .get().id;

  const row = (id: number) => t.db.select().from(postings).where(eq(postings.id, id)).get();
  const roles = () => fake.requests.map((r) => r.role);

  const setPref = (key: string, value: string) =>
    runInTx(t.db, bus, { now }, (tx) => {
      const parsed = parsePreference(key, value, getPreferences(tx.db));
      setPreference(tx.db, parsed.key, parsed.value, tx.now);
      return rescoreAll(tx.db, tx.now);
    });

  it('extracts and matches once; preferences, feedback and re-runs re-score with no model call', async () => {
    const { python, k8s } = await seedFacts();
    fake.push({ output: EXTRACTION }, matcher);
    const id = addPosting();
    requestScoring(t.db, bus, [id], now);
    await worker.idle();

    expect(roles()).toEqual(['extractor', 'matcher']);
    const scored = row(id);
    expect(scored?.stage).toBe('scored');
    expect(scored?.matches?.map((m) => [m.text, m.verdict, m.factIds])).toEqual([
      ['Python in production', 'strong', [python]],
      ['Kubernetes', 'partial', [k8s]],
      ['Rust', 'missing', []],
    ]);
    // No preferences yet: must (1 + ½)/2 at 35, nice 0 at 10.
    expect(scored?.score).toBe(Math.round((100 * 35 * 0.75) / 45));
    // The matcher saw each requirement with its facts, their status and project.
    const prompt = fake.requests[1]?.prompt ?? '';
    expect(prompt).toContain('Requirement 1 (must-have): Python in production');
    expect(prompt).toMatch(/#\d+ \[skill · Solovei, 2021–2024\] Built the call-analysis/);

    // A preference change re-runs only score().
    expect(setPref('salary', '2500 EUR/month')).toBe(1);
    expect(row(id)?.score).toBe(Math.round((100 * (35 * 0.75 + 10)) / 55));
    expect(setPref('salary', '5000 EUR/month')).toBe(1);
    const salary = row(id)?.breakdown?.find((c) => c.key === 'salary');
    expect(salary).toMatchObject({ value: 0, note: 'Salary €2,500/month · 50% below target' });
    expect(fake.requests).toHaveLength(2);

    // Running the task again with nothing changed: every result comes from the cache.
    const before = row(id)?.score;
    requestScoring(t.db, bus, [id], now);
    await worker.idle();
    expect(fake.requests).toHaveLength(2);
    expect(row(id)?.score).toBe(before);
    // Same-currency salaries never fetch rates.
    expect(fx.calls).toBe(0);

    // Skip feedback nudges the salary weight and re-scores, still without a model.
    const skipped = recordDecision(t.db, bus, {
      id,
      decision: 'skipped',
      reason: 'salary too low',
      now,
    });
    expect(skipped.posting).toMatchObject({ stage: 'skipped', decision: 'skipped' });
    expect(skipped.posting.breakdown?.find((c) => c.key === 'salary')?.weight).toBe(11);
    expect(skipped.posting.score).toBeLessThan(before ?? 0);
    expect(fake.requests).toHaveLength(2);

    // A corrected fact changes what the matcher saw, so it is asked again.
    runInTx(t.db, bus, { now }, (tx) => {
      editFact(tx.db, k8s, 'Ran production Kubernetes clusters with Helm', tx.now);
      enqueueEmbedFacts(tx);
    });
    await worker.idle();
    fake.push(matcher);
    requestScoring(t.db, bus, [id], now);
    await worker.idle();
    expect(roles()).toEqual(['extractor', 'matcher', 'matcher']);
    // A skipped posting stays skipped when it is re-scored.
    expect(row(id)?.stage).toBe('skipped');
  });

  it('keeps the extraction when the matcher hits a limit, and resumes without re-extracting', async () => {
    await seedFacts();
    fake.push(
      { output: EXTRACTION },
      {
        limit: "You've hit your session limit · resets 3:45pm",
        resetsAt: new Date(Date.now() + 300),
      },
    );
    const id = addPosting();
    requestScoring(t.db, bus, [id], now);
    await worker.idle();
    expect(roles()).toEqual(['extractor', 'matcher']);
    expect(row(id)).toMatchObject({ stage: 'verified', score: null });
    expect(row(id)?.extraction?.requirements).toHaveLength(3);
    expect(
      t.db
        .select()
        .from(providerPauses)
        .all()
        .map((p) => p.provider),
    ).toEqual(['claude']);

    fake.push(matcher);
    await new Promise((r) => setTimeout(r, 400));
    await worker.idle();
    expect(roles()).toEqual(['extractor', 'matcher', 'matcher']);
    expect(row(id)?.stage).toBe('scored');
  });

  it('needs no matcher call when the knowledge base has nothing on a requirement', async () => {
    fake.push({ output: EXTRACTION });
    const id = addPosting();
    requestScoring(t.db, bus, [id], now);
    await worker.idle();
    expect(roles()).toEqual(['extractor']);
    expect(row(id)?.matches?.map((m) => m.verdict)).toEqual(['missing', 'missing', 'missing']);
    expect(row(id)?.matches?.[0]?.note).toBe('no related facts in your knowledge base');
    expect(row(id)?.score).toBe(0);
  });

  it('fetches reference rates only when the salary must be converted', async () => {
    fake.push({ output: { ...EXTRACTION, salary: { ...EXTRACTION.salary, currency: 'USD' } } });
    setPref('salary', '2500 EUR/month');
    const id = addPosting();
    requestScoring(t.db, bus, [id], now);
    await worker.idle();
    expect(fx.calls).toBe(1);
    // 2500 USD at 1.1 USD per EUR.
    // (No facts, so core fit is 0 and the salary, a logistics component, doesn't count.)
    expect(row(id)?.breakdown?.find((c) => c.key === 'salary')?.note).toBe(
      'Salary €2,273/month ($2,500/month) · 9% below target · counts ×0: core fit 0%',
    );
  });
});

describe('planMatches', () => {
  const fact = (id: number, text: string): FactHit => ({
    id,
    text,
    status: 'confirmed',
    kind: 'skill',
    projectId: null,
    project: null,
    period: null,
    score: 1,
  });
  const cand = (text: string, fs: FactHit[]): Candidates => {
    const requirement = { text, must: true };
    return { requirement, facts: fs, key: matchKey(requirement, fs) };
  };

  it('asks only about requirements whose facts changed', () => {
    const python = fact(1, 'Built it in Python');
    const k8s = fact(2, 'Ran Kubernetes');
    const before = [cand('Python', [python]), cand('Kubernetes', [k8s])];
    const cached = before.map((c) => ({
      text: c.requirement.text,
      must: true,
      verdict: 'strong' as const,
      factIds: [c.facts[0]?.id ?? 0],
      note: null,
      key: c.key,
    }));
    const after = [
      cand('Python', [python]),
      cand('Kubernetes', [{ ...k8s, text: 'Ran Kubernetes in production' }]),
      cand('Rust', []),
    ];
    const plan = planMatches(after, cached);
    expect(plan.ask).toEqual([1]);
    expect(plan.settled.get(0)).toMatchObject({ verdict: 'strong', factIds: [1] });
    expect(plan.settled.get(2)).toMatchObject({ verdict: 'missing', factIds: [] });
    // Confirming a fact doesn't change what it shows: no new matcher run.
    const unconfirmed = cand('Python', [{ ...python, status: 'unconfirmed' }]);
    expect(planMatches([unconfirmed], cached).ask).toEqual([]);
    // A fact dropping out of the list (rejected, deleted) does.
    expect(planMatches([cand('Python', [])], cached).settled.get(0)?.verdict).toBe('missing');
    expect(planMatches([cand('Python', [python, k8s])], cached).ask).toEqual([0]);
  });
});
