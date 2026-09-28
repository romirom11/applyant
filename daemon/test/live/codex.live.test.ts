// The real codex CLI through the Codex SDK: a structured answer from a plain run, then the real
// search_planner with live web search on a synthetic candidate, whose boards the watch list takes.
//   APPLYANT_LIVE=1 pnpm test:live -t codex
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NewAgentRunRow } from '../../src/db/schema.ts';
import {
  PLANNER_SYSTEM,
  type PlannerContext,
  plannerPrompt,
  validatePlan,
} from '../../src/domain/search/planner.ts';
import { watchBoards } from '../../src/domain/search/watchlist.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { CodexProvider } from '../../src/models/providers/codex.ts';
import { plannerSchema } from '../../src/models/schemas/search.ts';
import { EventBus } from '../../src/queue/events.ts';
import { runInTx } from '../../src/queue/tx.ts';
import { tempDb } from '../helpers/db.ts';
import { quietLog } from '../helpers/deps.ts';

const live = process.env.APPLYANT_LIVE === '1';

/** A synthetic candidate (never anyone's real data). */
const CANDIDATE: PlannerContext = {
  preferences: {
    roles: ['ai_ml', 'backend'],
    seniority: ['senior'],
    basedIn: 'GR',
    locations: ['GR', 'CY'],
    remote: 'preferred',
    salary: { amount: 5000, currency: 'EUR', period: 'month' },
    languages: { en: 'C1' },
    employment: ['full_time'],
    dealbreakers: [],
  },
  profile: { location: 'Athens, Greece', current_title: 'Senior Backend Engineer' },
  projects: [
    {
      name: 'Harbor',
      role: 'Tech lead',
      period: '2021–2024',
      stack: ['Python', 'FastAPI', 'PostgreSQL', 'pgvector', 'Whisper'],
      summary: 'Call analytics with speech-to-text and LLM scoring',
    },
  ],
  skills: ['Python', 'FastAPI', 'RAG pipelines', 'PostgreSQL', 'Kubernetes'],
  strategies: [
    {
      name: 'AI Engineer · Remote',
      origin: 'candidate',
      state: 'active',
      queries: ['ai engineer'],
      locations: ['remote'],
      sources: ['all'],
      results: '12 found · 9 verified · 3 interested · 4 skipped',
    },
  ],
  sources: [
    { key: 'greenhouse:gitlab', label: 'GitLab', origin: 'candidate', results: '15 found' },
  ],
};

describe.skipIf(!live)('live codex provider (real codex CLI)', () => {
  let dir: string;
  let runner: AgentRunner;
  const runs: NewAgentRunRow[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-codex-'));
    runner = new AgentRunner({
      providers: [new CodexProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => runs.push(row),
      log: quietLog,
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('answers with structured output', async () => {
    const res = await runner.run('search_planner', {
      schema: z.object({ sum: z.number(), words: z.string() }).strict(),
      system: 'You answer arithmetic questions exactly.',
      prompt: 'What is 17 + 25? Give the number and the number in English words.',
      taskId: null,
      signal: new AbortController().signal,
    });
    expect(res.kind, res.kind === 'failed' ? res.reason : '').toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.output.sum).toBe(42);
    expect(res.output.words.toLowerCase()).toContain('forty');
    expect(runs.at(-1)).toMatchObject({ role: 'search_planner', provider: 'codex', outcome: 'ok' });
    expect(runs.at(-1)?.inputTokens).toBeGreaterThan(0);
  });

  it('search_planner searches the web and finds company boards for the watch list', async () => {
    const res = await runner.run('search_planner', {
      schema: plannerSchema,
      system: PLANNER_SYSTEM,
      prompt: plannerPrompt(CANDIDATE),
      taskId: null,
      signal: new AbortController().signal,
      validate: validatePlan,
      webSearch: true,
    });
    expect(res.kind, res.kind === 'failed' ? res.reason : '').toBe('ok');
    if (res.kind !== 'ok') return;
    const plan = res.output;
    expect(plan.searches.length).toBeGreaterThan(0);
    expect(plan.boards.length).toBeGreaterThan(0);
    expect(plan.strategies.length).toBeLessThanOrEqual(5);
    for (const s of plan.strategies) expect(s.queries.every((q) => q.trim().length > 0)).toBe(true);
    const t = tempDb();
    try {
      const watched = runInTx(t.db, new EventBus(), { now: new Date() }, (tx) =>
        watchBoards(tx, plan.boards),
      );
      expect(watched.added.length).toBeGreaterThan(0);
      process.stdout.write(
        `planner: ${plan.searches.length} searches · boards ${watched.added.map((s) => s.key).join(', ')} · rejected ${watched.rejected.length} · strategies ${plan.strategies.map((s) => s.name).join(' | ')}\n`,
      );
    } finally {
      t.cleanup();
    }
  });
});
