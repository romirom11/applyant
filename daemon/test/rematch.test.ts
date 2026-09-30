// rematch_postings through the queue with a scripted matcher: a burst of knowledge changes is
// one sweep, after the vectors are in; only open postings whose match keys changed are scored
// again (never skipped ones or ones already sent); a posting that now crosses the threshold
// prepares on its own; a sweep with nothing changed asks no model.
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applications, facts, postings, tasks } from '../src/db/schema.ts';
import {
  embedFacts,
  enqueueEmbedFacts,
  ensureFactIndex,
} from '../src/domain/knowledge/embed-index.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import { scorePosting } from '../src/domain/scoring/handlers.ts';
import {
  REMATCH_DELAY_MS,
  rematchCandidates,
  rematchPostings,
  requestRematch,
} from '../src/domain/scoring/rematch.ts';
import { recordDecision, requestScoring } from '../src/domain/scoring/store.ts';
import type { ProviderRequest, ProviderResult } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { Worker } from '../src/queue/worker.ts';
import { candidateRpcs } from '../src/rpc/candidate.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

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
  salary: null,
  languages: [],
  postingLanguage: 'en',
  employment: 'full_time',
  outstaffing: false,
};

/** Cites facts by keyword: strong when a fact names the requirement, else missing. */
function matcher(req: ProviderRequest): ProviderResult {
  const blocks = req.prompt.split(/\n\n(?=Requirement \d+ )/);
  const matches = blocks
    .map((block) => {
      const head = /^Requirement (\d+) \([^)]*\): (.+)$/m.exec(block);
      if (!head) return null;
      const word = (head[2] ?? '').split(' ')[0]?.toLowerCase() ?? '';
      const cited = [...block.matchAll(/^ {2}#(\d+) \[[^\]]*\] (.+)$/gm)]
        .filter((m) => (m[2] ?? '').toLowerCase().includes(word))
        .map((m) => Number(m[1]));
      return cited.length
        ? { requirement: Number(head[1]), verdict: 'strong', factIds: cited, note: 'shown' }
        : { requirement: Number(head[1]), verdict: 'missing', factIds: [], note: 'not shown' };
    })
    .filter(Boolean);
  return { kind: 'ok', output: { matches }, model: 'sonnet', usage: null };
}

describe('re-scoring when knowledge changes', () => {
  let t: TempDb;
  let bus: EventBus;
  let fake: FakeProvider;
  let worker: Worker;
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);

  beforeEach(() => {
    offset = 0;
    t = tempDb();
    bus = new EventBus();
    fake = new FakeProvider('claude');
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir, db: t.db, providers: [fake], read: t.read }),
      handlers: handlers({
        score_posting: scorePosting,
        embed_facts: embedFacts,
        rematch_postings: rematchPostings,
      }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
      now: clock,
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    t.cleanup();
  });

  const addFact = (text: string, projectId: number | null = null) =>
    t.db
      .insert(facts)
      .values({ text, kind: 'skill', status: 'unconfirmed', origin: 'extracted', projectId })
      .returning({ id: facts.id })
      .get().id;

  const addPosting = (n: number) =>
    t.db
      .insert(postings)
      .values({
        stage: 'verified',
        canonicalUrl: `https://jobs.example.com/acme/${n}`,
        text: `Senior AI Engineer at Acme AI (${n}). Python in production, Kubernetes; Rust a plus.`,
        verifiedAt: clock(),
      })
      .returning()
      .get().id;

  const row = (id: number) => t.db.select().from(postings).where(eq(postings.id, id)).get();
  const roles = () => fake.requests.map((r) => r.role);
  const queued = (kind: 'score_posting' | 'rematch_postings') =>
    t.db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, kind))
      .all()
      .map((x) => x.entityId);

  /** Three scored postings sharing one extraction: open, skipped, and one already sent. */
  const seed = async () => {
    const p = createProject(t.db, { name: 'Solovei', period: '2021–2024' }, clock());
    addFact('Built the call-analysis pipeline in Python and FastAPI', p.id);
    addFact('Deployed the services with Kubernetes and Helm', p.id);
    ensureFactIndex(t.db, bus, 'hash-v1@256', clock());
    await worker.idle();
    fake.push({ output: EXTRACTION }, matcher);
    const open = addPosting(1);
    requestScoring(t.db, bus, [open], clock());
    await worker.idle();
    const scored = row(open);
    const copy = (n: number) => {
      const id = addPosting(n);
      t.db
        .update(postings)
        .set({
          stage: 'scored',
          extraction: scored?.extraction,
          extractionKey: scored?.extractionKey,
          matches: scored?.matches,
          score: scored?.score,
        })
        .where(eq(postings.id, id))
        .run();
      return id;
    };
    const skipped = copy(2);
    recordDecision(t.db, bus, { id: skipped, decision: 'skipped', reason: 'no', now: clock() });
    const sent = copy(3);
    t.db.insert(applications).values({ postingId: sent, stage: 'applied' }).run();
    return { open, skipped, sent };
  };

  it('coalesces a burst into one sweep that re-scores only open postings whose keys changed', async () => {
    const { open, skipped, sent } = await seed();
    expect(roles()).toEqual(['extractor', 'matcher']);
    expect(row(open)?.score).toBe(78);
    expect(rematchCandidates(t.db).map((p) => p.id)).toEqual([open]);
    const scoreTasksBefore = queued('score_posting').length;

    // Two changes in a burst: one sweep, waiting REMATCH_DELAY_MS.
    const at = clock();
    runInTx(t.db, bus, { now: at }, (tx) => {
      addFact('Wrote a Rust ingestion service');
      enqueueEmbedFacts(tx);
      requestRematch(tx);
    });
    runInTx(t.db, bus, { now: at }, (tx) => requestRematch(tx));
    const sweeps = t.db.select().from(tasks).where(eq(tasks.kind, 'rematch_postings')).all();
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]?.runAfter?.getTime()).toBe(at.getTime() + REMATCH_DELAY_MS);

    // Not before the delay: only the vectors are made.
    await worker.idle();
    expect(roles()).toEqual(['extractor', 'matcher']);

    fake.push(matcher);
    offset = REMATCH_DELAY_MS + 1000;
    await worker.idle();
    // One matcher run, with the new fact, for the open posting only.
    expect(roles()).toEqual(['extractor', 'matcher', 'matcher']);
    expect(fake.requests[2]?.prompt).toContain('Wrote a Rust ingestion service');
    const rescored = queued('score_posting').slice(scoreTasksBefore);
    expect(rescored).toEqual([open]);
    expect(rescored).not.toContain(skipped);
    expect(rescored).not.toContain(sent);
    // It now crosses the threshold (80) and prepares on its own.
    expect(row(open)?.score).toBe(100);
    expect(
      t.db.select().from(applications).where(eq(applications.postingId, open)).get()?.stage,
    ).toBe('preparing');
  });

  it('asks no model when nothing a posting matched on changed (a confirmed fact)', async () => {
    await seed();
    const scoreTasksBefore = queued('score_posting').length;
    const rpc = candidateRpcs({ db: t.db, bus, now: clock }) as Required<
      ReturnType<typeof candidateRpcs>
    >;
    // An unrelated fact rejected: a sweep runs, finds no changed key, queues nothing.
    const other = addFact('Organised a meetup about gardening');
    await worker.idle();
    rpc.rejectFact({ ids: [BigInt(other)] } as never, {} as never);
    expect(queued('rematch_postings')).toHaveLength(1);
    offset = REMATCH_DELAY_MS + 1000;
    await worker.idle();
    expect(queued('score_posting')).toHaveLength(scoreTasksBefore);
    expect(roles()).toEqual(['extractor', 'matcher']);
    const sweep = t.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.kind, 'rematch_postings'), eq(tasks.status, 'done')))
      .all();
    expect(sweep).toHaveLength(1);
  });

  it('an edited fact the posting cited re-queues it (through EditFact)', async () => {
    const { open } = await seed();
    const k8s = t.db
      .select()
      .from(facts)
      .all()
      .find((f) => f.text.includes('Kubernetes'));
    const rpc = candidateRpcs({ db: t.db, bus, now: clock }) as Required<
      ReturnType<typeof candidateRpcs>
    >;
    rpc.editFact(
      { id: BigInt(k8s?.id ?? 0), text: 'Ran production Kubernetes clusters' } as never,
      {} as never,
    );
    fake.push(matcher);
    offset = REMATCH_DELAY_MS + 1000;
    await worker.idle();
    expect(roles()).toEqual(['extractor', 'matcher', 'matcher']);
    expect(fake.requests[2]?.prompt).toContain('Ran production Kubernetes clusters');
    expect(row(open)?.stage).toBe('scored');
  });
});
