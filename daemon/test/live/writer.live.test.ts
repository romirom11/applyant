// The real application_writer (claude:opus, with Applyant's MCP knowledge tools) and the real
// claim_verifier (claude:haiku) on a synthetic candidate. A seeded exaggeration must be flagged.
//   APPLYANT_LIVE=1 pnpm test:live -t "writer|verifier"
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb, openReadDb, type ReadDb } from '../../src/db/client.ts';
import { directExec } from '../../src/db/read-pool.ts';
import { facts, postings } from '../../src/db/schema.ts';
import { checkSentences } from '../../src/domain/applications/checks/verify.ts';
import { runWriter } from '../../src/domain/applications/writer.ts';
import { buildWriterContext } from '../../src/domain/applications/writer-context.ts';
import { createProject } from '../../src/domain/knowledge/projects.ts';
import { McpHub } from '../../src/mcp/server.ts';
import { knowledgeTools } from '../../src/mcp/tools/knowledge.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { HashEmbedder } from '../../src/models/embeddings.ts';
import { ClaudeProvider } from '../../src/models/providers/claude.ts';
import { quietLog } from '../helpers/deps.ts';

const live = process.env.APPLYANT_LIVE === '1';

describe.skipIf(!live)('live application_writer and claim_verifier (real claude)', () => {
  let dir: string;
  let db: Db;
  let read: ReadDb;
  let hub: McpHub;
  let runner: AgentRunner;
  const runs: Array<Record<string, unknown>> = [];
  const ids: Record<string, number> = {};
  const embedder = new HashEmbedder();
  const now = new Date();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-writer-'));
    db = openDb(join(dir, 'applyant.db'));
    read = openReadDb(join(dir, 'applyant.db'));
    // A synthetic candidate: nobody's real experience.
    const harbor = createProject(
      db,
      {
        name: 'Harbor',
        period: '2021–2024',
        role: 'Backend engineer',
        summary: 'Call analytics for customer-support teams',
        stack: ['Python', 'PostgreSQL', 'Kubernetes'],
      },
      now,
    );
    const lantern = createProject(
      db,
      {
        name: 'Lantern',
        period: '2019–2020',
        summary: 'An open-source audio toolkit',
        stack: ['Python'],
      },
      now,
    );
    const add = (key: string, projectId: number, text: string, kind: string) => {
      ids[key] = db
        .insert(facts)
        .values({
          projectId,
          text,
          kind: kind as 'personal_contribution',
          status: 'confirmed',
          origin: 'extracted',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: facts.id })
        .get().id;
    };
    add(
      'pipeline',
      harbor.id,
      'Built the Python call-analysis pipeline that transcribes and scores support calls',
      'personal_contribution',
    );
    add('team', harbor.id, 'Was one of 4 engineers on the call-analysis platform team', 'role');
    add(
      'billing',
      harbor.id,
      "Fixed bugs in the call-analysis platform's billing module",
      'personal_contribution',
    );
    add('k8s', harbor.id, 'The platform team ran the services on Kubernetes', 'team_context');
    add(
      'oss',
      lantern.id,
      'Maintains Lantern, an open-source Python library for splitting audio into chunks',
      'personal_contribution',
    );
    add(
      'prs',
      lantern.id,
      'Lantern has merged pull requests from 6 outside contributors',
      'impact',
    );

    hub = new McpHub({
      tools: knowledgeTools({ read, readPool: directExec(read), embedder }),
      log: quietLog,
    });
    await hub.start();
    runner = new AgentRunner({
      providers: [new ClaudeProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => runs.push(row),
      log: quietLog,
    });
  });

  afterAll(async () => {
    await hub?.close();
    if (read) closeDb(read);
    if (db) closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('claim_verifier flags a seeded exaggeration (and passes what the facts say)', async () => {
    const f = (key: string, text: string) => ({ id: ids[key] ?? 0, text, period: '2021–2024' });
    const res = await checkSentences(
      [
        // Seeded exaggeration: the fact is a bug fix in one module.
        {
          key: 'scope',
          text: 'I designed and built the entire call-analysis platform on my own.',
          facts: [f('billing', "Fixed bugs in the call-analysis platform's billing module")],
        },
        // Seeded exaggeration with a number: caught before the model sees it.
        {
          key: 'team',
          text: 'I led a team of 10 engineers on the call-analysis platform.',
          facts: [f('team', 'Was one of 4 engineers on the call-analysis platform team')],
        },
        // Team work presented as the candidate's.
        {
          key: 'k8s',
          text: 'I ran our production services on Kubernetes.',
          facts: [f('k8s', 'The platform team ran the services on Kubernetes')],
        },
        {
          key: 'true',
          text: 'I built the Python pipeline that transcribes support calls.',
          facts: [
            f(
              'pipeline',
              'Built the Python call-analysis pipeline that transcribes and scores support calls',
            ),
          ],
        },
        {
          key: 'motivation',
          text: "I'm excited by the idea of making support calls easier to learn from.",
          facts: [],
        },
        { key: 'uncited', text: 'I have years of Rust experience.', facts: [] },
      ],
      runner,
      { taskId: null, signal: new AbortController().signal },
    );
    process.stdout.write(
      `\n${JSON.stringify(res.kind === 'ok' ? Object.fromEntries(res.results) : res, null, 1)}\n`,
    );
    if (res.kind !== 'ok') throw new Error(`verifier did not run: ${JSON.stringify(res)}`);
    const flag = (k: string) => res.results.get(k)?.flag;
    expect(flag('scope')).toMatch(/^verifier:(scope|role|unsupported)$/);
    expect(flag('team')).toBe('contradiction');
    expect(flag('k8s')).toMatch(/^verifier:/);
    expect(flag('true')).toBe('none');
    expect(flag('motivation')).toBe('none');
    expect(flag('uncited')).toMatch(/^verifier:/);
    const verifierRun = runs.find((r) => r.role === 'claim_verifier');
    expect(verifierRun).toMatchObject({ provider: 'claude', outcome: 'ok' });
    expect(String(verifierRun?.model)).toMatch(/haiku/);
  });

  it('application_writer drafts from given facts only and leaves unknowns to the candidate', async () => {
    const posting = db
      .insert(postings)
      .values({
        stage: 'scored',
        canonicalUrl: 'https://jobs.example.test/acme/ai-engineer',
        title: 'AI Engineer',
        company: 'Acme Voice',
        text:
          'Acme Voice builds speech analytics for contact centres. You will build Python services that process call audio at scale. ' +
          'When you answer our first written question, please begin your answer with the words "Signal over noise".',
        matches: [
          {
            text: 'Python services in production',
            must: true,
            verdict: 'strong',
            factIds: [ids.pipeline ?? 0],
            note: null,
            key: 'k1',
          },
        ],
      })
      .returning()
      .get();
    const ctx = await buildWriterContext(
      read,
      { readPool: directExec(read), embedder },
      {
        applicationId: 1,
        posting,
        questions: [
          {
            id: 'q1',
            fieldRef: '1:a',
            label:
              'Did you begin your first written answer with the phrase we asked for in the job description?',
            kind: 'choice',
            options: ['Yes', 'No'],
            required: true,
            condition: null,
          },
          {
            id: 'q2',
            fieldRef: '1:b',
            label: 'Tell us about a system you built that processes audio or speech.',
            kind: 'text',
            options: null,
            required: true,
            condition: null,
          },
          {
            id: 'q3',
            fieldRef: '1:c',
            label: 'Do you have a public open-source track record?',
            kind: 'choice',
            options: ['Yes', 'No'],
            required: true,
            condition: null,
          },
          {
            id: 'q4',
            fieldRef: '1:d',
            label: 'Are you currently bound by a non-compete agreement with your employer?',
            kind: 'choice',
            options: ['Yes', 'No'],
            required: true,
            condition: null,
          },
        ],
        profile: { location: 'Thessaloniki, Greece' },
        signal: new AbortController().signal,
      },
    );
    const res = await runWriter(
      ctx,
      { models: runner, mcp: hub },
      { taskId: null, signal: new AbortController().signal },
    );
    process.stdout.write(`\n${JSON.stringify(res, null, 1)}\n`);
    if (res.kind !== 'ok') throw new Error(`writer did not run: ${JSON.stringify(res)}`);
    const d = (q: string) => res.output.drafts.find((x) => x.question === q);
    // runWriter validated every cited id against the context (tool results included).
    const q2 = d('q2');
    expect(q2?.status).toBe('answered');
    expect(q2?.sentences[0]?.text).toMatch(/^Signal over noise/i);
    expect(q2?.sentences.some((s) => s.factIds.includes(ids.pipeline ?? -1))).toBe(true);
    expect(d('q1')).toMatchObject({ status: 'answered', choice: 'Yes' });
    expect(d('q3')).toMatchObject({ status: 'answered', choice: 'Yes' });
    // Nothing in the facts says anything about a non-compete: only the candidate can answer.
    expect(d('q4')?.status).toBe('needs_candidate');
    const writerRun = runs.find((r) => r.role === 'application_writer');
    expect(writerRun).toMatchObject({ provider: 'claude', outcome: 'ok' });
    expect(String(writerRun?.model)).toMatch(/opus/);

    // Its sentences then go through the same checks as in preparation.
    const cited = new Map([...ctx.citable.values()].map((x) => [x.id, x]));
    const checked = await checkSentences(
      res.output.drafts.flatMap((dr) =>
        dr.sentences.map((s, i) => ({
          key: `${dr.question}.${i + 1}`,
          text: s.text,
          facts: s.factIds.map((id) => ({
            id,
            text: cited.get(id)?.text ?? '',
            period: cited.get(id)?.period ?? null,
          })),
        })),
      ),
      runner,
      { taskId: null, signal: new AbortController().signal },
    );
    process.stdout.write(
      `\n${JSON.stringify(checked.kind === 'ok' ? Object.fromEntries(checked.results) : checked, null, 1)}\n`,
    );
    if (checked.kind !== 'ok') throw new Error('checks did not run');
    // The writer must not contradict its own facts.
    expect([...checked.results.values()].some((r) => r.flag === 'contradiction')).toBe(false);
  });
});
