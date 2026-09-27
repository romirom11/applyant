// Runs score_posting for real, once: the `claude` CLI (this machine's subscription) as the
// extractor and the matcher, EmbeddingGemma for the fact and query vectors, and the
// worker-thread read pool for hybrid retrieval. Facts are seeded from the fixture CV, so only
// the posting costs tokens.   APPLYANT_LIVE=1 pnpm test:live -t matcher
//
// The model (~300 MB) is downloaded into a temp dir unless APPLYANT_MODELS_DIR points at a cache.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReaderPool } from '../../src/browser/reader-pool.ts';
import { closeDb, openDb, openReadDb } from '../../src/db/client.ts';
import { ReadPool } from '../../src/db/read-pool.ts';
import { agentRuns, type FactKind, facts, postings } from '../../src/db/schema.ts';
import {
  embedFacts,
  ensureFactIndex,
  factsWithoutVectors,
} from '../../src/domain/knowledge/embed-index.ts';
import { createProject } from '../../src/domain/knowledge/projects.ts';
import { NodeTextExtractor } from '../../src/domain/knowledge/text/extract.ts';
import { scorePosting } from '../../src/domain/scoring/handlers.ts';
import { getPreferences, parsePreference, setPreference } from '../../src/domain/scoring/prefs.ts';
import { requestScoring, rescoreAll } from '../../src/domain/scoring/store.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { GemmaEmbedder } from '../../src/models/embeddings.ts';
import { ClaudeProvider } from '../../src/models/providers/claude.ts';
import { EventBus } from '../../src/queue/events.ts';
import { runInTx } from '../../src/queue/tx.ts';
import { Worker } from '../../src/queue/worker.ts';
import { FileSecrets } from '../../src/secrets/file-backend.ts';
import { fixedFx, handlers, quietLog } from '../helpers/deps.ts';

const POSTING = fileURLToPath(new URL('../fixtures/postings/ai-engineer.txt', import.meta.url));
const live = process.env.APPLYANT_LIVE === '1';

describe.skipIf(!live)('live matcher (real claude, real embeddings)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('matcher judges the fixture posting against facts from the fixture CV', async () => {
    const dbPath = join(dir, 'applyant.db');
    const db = openDb(dbPath);
    const read = openReadDb(dbPath);
    const bus = new EventBus();
    const now = new Date();
    const pool = new ReadPool({ path: dbPath, size: 2, log: quietLog });
    const embedder = new GemmaEmbedder({
      cacheDir: process.env.APPLYANT_MODELS_DIR || join(dir, 'models'),
      log: quietLog,
    });
    const models = new AgentRunner({
      providers: [new ClaudeProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => {
        db.insert(agentRuns).values(row).run();
      },
      log: quietLog,
    });
    const worker = new Worker({
      db,
      read,
      bus,
      deps: {
        reader: {} as ReaderPool,
        secrets: new FileSecrets(join(dir, 'secrets.json')),
        models,
        embedder,
        readPool: pool,
        mcp: null,
        fx: fixedFx(),
        text: new NodeTextExtractor(),
        dirs: { repos: join(dir, 'repos') },
        log: quietLog,
      },
      handlers: handlers({ score_posting: scorePosting, embed_facts: embedFacts }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 120_000,
      pollMs: 20,
      maxAttempts: 2,
    });

    try {
      // The fixture CV's facts, as a CV sync would have drafted them.
      const nightingale = createProject(db, { name: 'Nightingale', period: '2021–2024' }, now);
      const ledgerly = createProject(db, { name: 'Ledgerly', period: '2018–2021' }, now);
      const seed: Array<[string, FactKind, number | null]> = [
        [
          'Designed and built the asynchronous call-analysis pipeline in Python and FastAPI, processing about 20,000 calls a day',
          'personal_contribution',
          nightingale.id,
        ],
        [
          'Led a team of 4 engineers that shipped speech-to-text and LLM summarisation of sales calls',
          'role',
          nightingale.id,
        ],
        [
          'Cut transcription cost by 35% by moving batch jobs to spot instances',
          'impact',
          nightingale.id,
        ],
        [
          'Wrote the invoice reconciliation service in Go and PostgreSQL',
          'personal_contribution',
          ledgerly.id,
        ],
        [
          'Maintained the Kafka event bus shared by 6 product teams',
          'personal_contribution',
          ledgerly.id,
        ],
        [
          'Backend engineer with 8 years of experience building data-heavy Python services and LLM features in production',
          'role',
          null,
        ],
        [
          'Skills: Python, FastAPI, Go, PostgreSQL, Kafka, Docker, Kubernetes, LLM APIs (Claude, OpenAI)',
          'skill',
          null,
        ],
        ['Speaks English at C1 level', 'other', null],
        ['MSc Computer Science, National Technical University of Athens, 2017', 'education', null],
      ];
      const ids = new Map<string, number>();
      for (const [text, kind, projectId] of seed) {
        const row = db
          .insert(facts)
          .values({ text, kind, status: 'unconfirmed', origin: 'extracted', projectId })
          .returning({ id: facts.id })
          .get();
        ids.set(text, row.id);
      }
      const idOf = (s: string) => [...ids.entries()].find(([t]) => t.includes(s))?.[1];

      worker.start();
      ensureFactIndex(db, bus, embedder.id, now);
      await worker.idle();
      expect(factsWithoutVectors(db, 100)).toEqual([]);

      runInTx(db, bus, { now }, (tx) => {
        for (const [k, v] of [
          ['salary', '6000 EUR/month'],
          ['based_in', 'GR'],
          ['remote', 'required'],
          ['languages', 'en:C1,el:native'],
          ['roles', 'ai_ml,backend'],
          ['seniority', 'senior,staff'],
        ]) {
          const parsed = parsePreference(k as string, v as string, getPreferences(tx.db));
          setPreference(tx.db, parsed.key, parsed.value, tx.now);
        }
        rescoreAll(tx.db, tx.now);
      });

      const id = db
        .insert(postings)
        .values({
          stage: 'verified',
          canonicalUrl: 'https://jobs.example.com/helix/senior-ai-engineer',
          text: readFileSync(POSTING, 'utf8'),
          verifiedAt: now,
        })
        .returning()
        .get().id;
      requestScoring(db, bus, [id], now);
      await worker.idle();

      const runs = db.select().from(agentRuns).all();
      const posting = db.select().from(postings).where(eq(postings.id, id)).get();
      process.stdout.write(
        `\n${JSON.stringify(posting?.extraction, null, 1)}\n${(posting?.matches ?? [])
          .map(
            (m) =>
              `${m.verdict.padEnd(8)} ${m.must ? 'must' : 'nice'} ${m.text} ${JSON.stringify(m.factIds)} · ${m.note}`,
          )
          .join('\n')}\nscore ${posting?.score}\n${(posting?.breakdown ?? [])
          .map(
            (c) =>
              `${c.key.padEnd(11)} ${c.weight} ${c.value} ${c.note}${c.uncertain ? ' (uncertain)' : ''}`,
          )
          .join(
            '\n',
          )}\n${runs.map((r) => `${r.role} ${r.model} ${r.outcome} in ${r.inputTokens} out ${r.outputTokens} ${r.durationMs} ms`).join('\n')}\n`,
      );

      expect(runs.map((r) => [r.role, r.outcome])).toEqual([
        ['extractor', 'ok'],
        ['matcher', 'ok'],
      ]);
      for (const r of runs) {
        expect(String(r.model)).toMatch(/sonnet/);
        // A posting and a few dozen facts. Far more means something leaked into the context.
        expect(Number(r.inputTokens)).toBeLessThan(60_000);
      }

      expect(posting?.stage).toBe('scored');
      const ex = posting?.extraction;
      expect(ex?.salary).toMatchObject({
        min: 70000,
        max: 85000,
        currency: 'EUR',
        period: 'year',
        basis: 'gross',
      });
      expect(ex?.workplace).toBe('remote');
      expect(ex?.seniority).toBe('senior');
      expect(ex?.employment).toBe('full_time');

      const matches = posting?.matches ?? [];
      const find = (s: string) => matches.find((m) => m.text.toLowerCase().includes(s));
      expect(find('rust')).toMatchObject({ must: false, verdict: 'missing', factIds: [] });
      expect(find('elixir')).toMatchObject({ must: false, verdict: 'missing' });
      expect(find('kafka')?.verdict).toBe('strong');
      expect(find('kafka')?.factIds).toContain(idOf('Kafka event bus'));
      expect(find('python')?.must).toBe(true);
      expect(['strong', 'partial']).toContain(find('python')?.verdict);
      expect(find('llm')?.verdict).not.toBe('missing');
      const seeded = new Set(ids.values());
      for (const m of matches) for (const f of m.factIds) expect(seeded.has(f)).toBe(true);

      const salary = posting?.breakdown?.find((c) => c.key === 'salary');
      // 85,000 EUR/year = 7,083/month against a 6,000 target.
      expect(salary).toMatchObject({ value: 1, uncertain: false });
      expect(posting?.score).toBeGreaterThanOrEqual(60);

      // Stable: scoring again reuses the cached extraction and matches.
      requestScoring(db, bus, [id], now);
      await worker.idle();
      expect(db.select().from(agentRuns).all()).toHaveLength(2);
      expect(db.select().from(postings).where(eq(postings.id, id)).get()?.score).toBe(
        posting?.score,
      );
    } finally {
      await worker.stop();
      await pool.close();
      closeDb(read);
      closeDb(db);
    }
  });
});
