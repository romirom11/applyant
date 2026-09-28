// The routing table in SQLite: `applyant config roles set matcher codex` sends the next matcher
// run to codex with no restart, a reset sends it back, and routes that can't work are refused.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, facts, postings } from '../src/db/schema.ts';
import { embedFacts, ensureFactIndex } from '../src/domain/knowledge/embed-index.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import { scorePosting } from '../src/domain/scoring/handlers.ts';
import { requestScoring } from '../src/domain/scoring/store.ts';
import type { ProviderRequest, ProviderResult } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import {
  DEFAULT_ROUTING,
  listRoles,
  loadRouting,
  RoleRoutingError,
  resetRoleRoutes,
  setRoleRoute,
} from '../src/models/roles.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

const EXTRACTION: PostingExtraction = {
  title: 'Senior AI Engineer',
  company: 'Acme AI',
  summary: 'Build LLM systems.',
  seniority: 'senior',
  roleFamilies: ['ai_ml'],
  requirements: [{ text: 'Python in production', must: true, kind: 'skill' }],
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

/** Every requirement strong, citing the Python fact. */
function matcher(req: ProviderRequest): ProviderResult {
  const reqs = [...req.prompt.matchAll(/^Requirement (\d+) /gm)].map((m) => Number(m[1]));
  const fact = /^ {2}#(\d+) /m.exec(req.prompt);
  return {
    kind: 'ok',
    output: {
      matches: reqs.map((n) => ({
        requirement: n,
        verdict: 'strong',
        factIds: fact ? [Number(fact[1])] : [],
        note: 'built it',
      })),
    },
    model: req.model,
    usage: null,
  };
}

describe('role routing in SQLite', () => {
  let t: TempDb;
  let bus: EventBus;
  let claude: FakeProvider;
  let codex: FakeProvider;
  let worker: Worker;
  const now = new Date('2026-09-28T10:00:00Z');

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    claude = new FakeProvider('claude');
    codex = new FakeProvider('codex');
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({
        dir: t.dir,
        db: t.db,
        read: t.read,
        providers: [claude, codex],
        // As the daemon does: the candidate's routing, read for every run.
        routing: () => loadRouting(t.read),
      }),
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

  const seed = async () => {
    const p = createProject(t.db, { name: 'Solovei', period: '2021–2024' }, now);
    t.db
      .insert(facts)
      .values({
        text: 'Built the call-analysis pipeline in Python',
        kind: 'skill',
        status: 'confirmed',
        origin: 'extracted',
        projectId: p.id,
      })
      .run();
    ensureFactIndex(t.db, bus, 'hash-v1@256', now);
    await worker.idle();
  };

  const addPosting = (n: number) =>
    t.db
      .insert(postings)
      .values({
        stage: 'verified',
        canonicalUrl: `https://jobs.example.com/acme/${n}`,
        text: `Senior AI Engineer ${n} at Acme AI. Python in production.`,
        verifiedAt: now,
      })
      .returning()
      .get().id;

  const runs = () =>
    t.db
      .select({ role: agentRuns.role, provider: agentRuns.provider, model: agentRuns.model })
      .from(agentRuns)
      .all();

  it('set matcher → codex: the next score_posting matches on codex; reset brings it back', async () => {
    await seed();
    setRoleRoute(t.db, 'matcher', 'codex', now);
    expect(listRoles(t.db).find((r) => r.role === 'matcher')).toMatchObject({
      route: { provider: 'codex', model: null },
      default: { provider: 'claude', model: 'sonnet' },
      overridden: true,
    });

    claude.push({ output: EXTRACTION });
    codex.push(matcher);
    const first = addPosting(1);
    requestScoring(t.db, bus, [first], now);
    await worker.idle();
    expect(t.db.select().from(postings).where(eq(postings.id, first)).get()?.stage).toBe('scored');
    expect(runs()).toEqual([
      { role: 'extractor', provider: 'claude', model: 'sonnet' },
      { role: 'matcher', provider: 'codex', model: null },
    ]);
    expect(codex.requests.map((r) => r.role)).toEqual(['matcher']);

    // Back to the default: the next posting's matcher runs on claude:sonnet again.
    expect(resetRoleRoutes(t.db, 'matcher')).toEqual(['matcher']);
    claude.push({ output: EXTRACTION }, matcher);
    const second = addPosting(2);
    requestScoring(t.db, bus, [second], now);
    await worker.idle();
    expect(runs().slice(2)).toEqual([
      { role: 'extractor', provider: 'claude', model: 'sonnet' },
      { role: 'matcher', provider: 'claude', model: 'sonnet' },
    ]);
    expect(codex.requests).toHaveLength(1);
  });

  it('keeps a model with the provider, and a route equal to the default is no override', () => {
    expect(setRoleRoute(t.db, 'extractor', 'claude:opus', now).route).toEqual({
      provider: 'claude',
      model: 'opus',
    });
    expect(loadRouting(t.db).roles.extractor.route).toEqual({ provider: 'claude', model: 'opus' });
    // Only the route changes; the role's timeout and threshold stay.
    expect(loadRouting(t.db).roles.extractor.timeoutMs).toBe(
      DEFAULT_ROUTING.roles.extractor.timeoutMs,
    );
    expect(setRoleRoute(t.db, 'extractor', 'claude:sonnet', now).overridden).toBe(false);
    expect(loadRouting(t.db)).toBe(DEFAULT_ROUTING);
  });

  it('refuses routes that cannot work', () => {
    const bad = (role: string, route: string) => () => setRoleRoute(t.db, role, route, now);
    expect(bad('matcher', 'jev')).toThrow(RoleRoutingError);
    expect(bad('matcher', 'jev')).toThrow(/jev only answers bounded decisions/);
    expect(bad('writer', 'codex')).toThrow(/unknown role "writer"/);
    expect(bad('matcher', 'gemini')).toThrow(/unknown provider "gemini"/);
    expect(bad('extractor', 'apple')).toThrow(/only reads email/);
    expect(bad('option_match', 'jev:big')).toThrow(/jev has one model/);
    // Decisions can move to a generative model, and mail to the cloud (an explicit opt-in).
    expect(setRoleRoute(t.db, 'option_match', 'codex', now).route.provider).toBe('codex');
    expect(setRoleRoute(t.db, 'email_classify', 'claude:haiku', now).route.provider).toBe('claude');
    expect(resetRoleRoutes(t.db, null).sort()).toEqual(['email_classify', 'option_match']);
    expect(resetRoleRoutes(t.db, null)).toEqual([]);
  });
});
