// The real interviewer (claude:sonnet) on a synthetic candidate: it opens with one question
// about the project's gaps and saves no facts; then it turns an answer into facts that keep the
// candidate's hedges ("helped"), don't credit a colleague's work to the candidate, and asks
// something it hasn't asked yet.
//   APPLYANT_LIVE=1 pnpm test:live -t interviewer
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alreadyAsked } from '../../src/domain/knowledge/interview.ts';
import {
  INTERVIEW_SYSTEM,
  type InterviewContext,
  interviewPrompt,
  validateInterview,
} from '../../src/domain/knowledge/interview-agent.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { ClaudeProvider } from '../../src/models/providers/claude.ts';
import { interviewSchema } from '../../src/models/schemas/interview.ts';
import { quietLog } from '../helpers/deps.ts';

const live = process.env.APPLYANT_LIVE === '1';

const QUESTION = 'How big was the team on Harbor, and which parts did you build yourself?';
const ANSWER =
  'There were four of us. I helped build the transcription step with Dana, and I wrote the scoring API on my own. The dashboards were all Maria’s work.';

describe.skipIf(!live)('live interviewer (real claude:sonnet)', () => {
  let dir: string;
  let runner: AgentRunner;
  const runs: Array<Record<string, unknown>> = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-interview-'));
    runner = new AgentRunner({
      providers: [new ClaudeProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => runs.push(row),
      log: quietLog,
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const base: Omit<InterviewContext, 'transcript' | 'latest'> = {
    projects: [
      {
        id: 1,
        slug: 'harbor',
        name: 'Harbor',
        period: '2021–2024',
        role: null,
        summary: 'Call analytics for support teams',
      },
      { id: 2, slug: 'lantern', name: 'Lantern', period: '2019', role: null, summary: null },
    ],
    project: {
      id: 1,
      slug: 'harbor',
      name: 'Harbor',
      period: '2021–2024',
      role: null,
      summary: 'Call analytics for support teams',
    },
    facts: [
      {
        id: 11,
        kind: 'skill',
        status: 'unconfirmed',
        project: 'harbor',
        text: 'Used Python and PostgreSQL',
      },
      {
        id: 12,
        kind: 'team_context',
        status: 'unconfirmed',
        project: 'harbor',
        text: 'The repository has a call transcription step, a scoring API and dashboards',
      },
    ],
    gaps: [
      {
        key: 'personal_contribution',
        status: 'missing',
        label: 'what the candidate personally built or did',
      },
      { key: 'role', status: 'missing', label: "the candidate's own role and responsibilities" },
      {
        key: 'team',
        status: 'missing',
        label: 'the team: its size, who did what, working alone or with others',
      },
      {
        key: 'impact',
        status: 'missing',
        label: 'the results: users, revenue, time saved, what changed',
      },
    ],
    application: null,
    mayAsk: true,
  };

  it('interviewer opens with one question and no facts', async () => {
    const c: InterviewContext = { ...base, transcript: [], latest: null };
    const res = await runner.run('interviewer', {
      schema: interviewSchema,
      system: INTERVIEW_SYSTEM,
      prompt: interviewPrompt(c),
      taskId: null,
      signal: new AbortController().signal,
      validate: (out) => validateInterview(out, c),
    });
    process.stdout.write(`\n${JSON.stringify(res, null, 1)}\n`);
    if (res.kind !== 'ok') throw new Error(`interviewer did not run: ${JSON.stringify(res)}`);
    expect(res.output.facts).toEqual([]);
    expect(res.output.question).toBeTruthy();
    expect(String(runs.at(-1)?.model)).toMatch(/sonnet/);
  });

  it('interviewer saves what the answer says, no more, and asks something new', async () => {
    const c: InterviewContext = {
      ...base,
      transcript: [{ question: QUESTION, answer: ANSWER }],
      latest: { question: QUESTION, answer: ANSWER },
    };
    const res = await runner.run('interviewer', {
      schema: interviewSchema,
      system: INTERVIEW_SYSTEM,
      prompt: interviewPrompt(c),
      taskId: null,
      signal: new AbortController().signal,
      validate: (out) => validateInterview(out, c),
    });
    process.stdout.write(`\n${JSON.stringify(res, null, 1)}\n`);
    if (res.kind !== 'ok') throw new Error(`interviewer did not run: ${JSON.stringify(res)}`);
    const { facts, question } = res.output;
    expect(facts.length).toBeGreaterThanOrEqual(3);
    for (const f of facts) expect(['harbor', null]).toContain(f.project);
    // The team's size, as said.
    expect(facts.some((f) => /\b(4|four)\b/i.test(f.text))).toBe(true);
    // The scoring API is the candidate's own.
    expect(
      facts.some((f) => f.kind === 'personal_contribution' && /scoring API/i.test(f.text)),
    ).toBe(true);
    // "Helped build" stays a hedge: no claim about the candidate takes the transcription step
    // outright (a team_context fact about Dana's part is fine).
    for (const f of facts.filter(
      (x) => /transcription/i.test(x.text) && x.kind !== 'team_context',
    )) {
      expect(f.text).toMatch(/help|with dana|contribut|part of|together/i);
    }
    // Maria's dashboards are never the candidate's.
    for (const f of facts.filter((x) => /dashboard/i.test(x.text))) {
      expect(f.kind).not.toBe('personal_contribution');
      expect(f.text).toMatch(/maria/i);
    }
    if (question) expect(alreadyAsked([{ text: QUESTION }], question)).toBe(false);
  });
});
