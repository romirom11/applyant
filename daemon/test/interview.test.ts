// The agent interview through the real queue, with a scripted interviewer: a project's gaps,
// the first question, answers → confirmed interview facts with the answer as evidence, the next
// question, and a question never asked twice.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EventRow, evidence, facts, projects } from '../src/db/schema.ts';
import {
  alreadyAsked,
  answerQuestion,
  dismissQuestion,
  InterviewError,
  listQuestions,
  MAX_QUESTIONS_PER_SESSION,
  projectGaps,
  projectInterviews,
  projectThread,
  questionView,
  startInterview,
} from '../src/domain/knowledge/interview.ts';
import {
  INTERVIEW_ATTEMPTS,
  interviewTurn,
  mayFollowUp,
  validateInterview,
} from '../src/domain/knowledge/interview-agent.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import type { ProviderRequest } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { InterviewOutput } from '../src/models/schemas/interview.ts';
import { runInTx } from '../src/queue/tx.ts';
import { type PrepareHarness, prepareHarness, seedFacts } from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog, testDeps } from './helpers/deps.ts';

const now = new Date('2026-09-28T10:00:00Z');

describe('the agent interview', () => {
  let t: TempDb;
  let h: PrepareHarness | null = null;
  let seen: EventRow[] = [];

  beforeEach(() => {
    t = tempDb();
    seen = [];
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  const start = async (interview: (req: ProviderRequest) => InterviewOutput) => {
    h = await prepareHarness(t, { interview });
    h.bus.subscribe((e) => seen.push(e));
    return h;
  };
  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) =>
    runInTx(t.db, (h as PrepareHarness).bus, { now }, fn);
  const settle = () => (h as PrepareHarness).worker.idle();
  const interviewerPrompts = () =>
    (h as PrepareHarness).claude.requests.filter((r) => r.role === 'interviewer');

  it('finds what a project’s facts don’t show', () => {
    const seeded = seedFacts(t.db, now);
    const harbor = t.db.select().from(projects).where(eq(projects.id, seeded.projectId)).get();
    if (!harbor) throw new Error('no project');
    // Personal contribution is confirmed; the team shows only in an unconfirmed fact; no
    // role line, no impact.
    expect(projectGaps(t.db, harbor)).toEqual([
      { key: 'role', status: 'unconfirmed', label: expect.any(String) },
      { key: 'team', status: 'unconfirmed', label: expect.any(String) },
      { key: 'impact', status: 'missing', label: expect.any(String) },
    ]);
    // A role stated on the project (a CV's position line) counts.
    t.db.update(projects).set({ role: 'Tech lead' }).where(eq(projects.id, harbor.id)).run();
    const again = t.db.select().from(projects).where(eq(projects.id, harbor.id)).get();
    if (!again) throw new Error('no project');
    expect(projectGaps(t.db, again).map((g) => g.key)).toEqual(['team', 'impact']);
  });

  it('asks about a project, saves the answer as confirmed facts, and asks the next question', async () => {
    const seeded = seedFacts(t.db, now);
    let turn = 0;
    await start((req) => {
      turn++;
      if (turn === 1) {
        expect(req.prompt).toContain('This interview is about [harbor] Harbor.');
        expect(req.prompt).toContain('Gaps');
        expect(req.prompt).toContain('The interview starts now');
        return {
          facts: [],
          question: 'The facts show a call-analysis pipeline. How big was the team?',
          about: 'team size',
        };
      }
      expect(req.prompt).toContain('How big was the team?');
      expect(req.prompt).toContain('Three of us: I built the scoring service.');
      return {
        facts: [
          { text: 'Worked in a team of 3 engineers', kind: 'team_context', project: 'harbor' },
          { text: 'Built the scoring service', kind: 'personal_contribution', project: 'harbor' },
        ],
        question: 'What changed for the support team once scoring shipped?',
        about: 'impact',
      };
    });

    const res = tx((x) => startInterview(x, 'harbor'));
    expect(res.kind).toBe('pending');
    await settle();
    const [first] = listQuestions(t.db);
    expect(first).toMatchObject({
      text: 'The facts show a call-analysis pipeline. How big was the team?',
      status: 'open',
      origin: 'project',
      projectId: seeded.projectId,
      context: 'team size',
    });
    if (!first) throw new Error('no question');
    // Starting again returns the open question instead of asking another.
    expect(tx((x) => startInterview(x, 'harbor'))).toMatchObject({ kind: 'question' });

    tx((x) => answerQuestion(x, first.id, 'Three of us: I built the scoring service.'));
    expect(questionView(t.db, first.id).status).toBe('processing');
    await settle();

    const answered = questionView(t.db, first.id);
    expect(answered.status).toBe('answered');
    expect(answered.answer).toBe('Three of us: I built the scoring service.');
    expect(answered.facts.map((f) => [f.text, f.kind, f.status])).toEqual([
      ['Worked in a team of 3 engineers', 'team_context', 'confirmed'],
      ['Built the scoring service', 'personal_contribution', 'confirmed'],
    ]);
    const saved = t.db
      .select()
      .from(facts)
      .where(eq(facts.origin, 'interview'))
      .all()
      .map((f) => f.projectId);
    expect(saved).toEqual([seeded.projectId, seeded.projectId]);
    const ev = t.db
      .select()
      .from(evidence)
      .where(eq(evidence.locator, `interview:${first.id}`))
      .all();
    expect(ev).toHaveLength(2);
    expect(ev[0]?.excerpt).toBe('Three of us: I built the scoring service.');

    const thread = projectThread(t.db, seeded.projectId);
    expect(thread.map((q) => [q.origin, q.status])).toEqual([
      ['project', 'answered'],
      ['follow_up', 'open'],
    ]);
    expect(seen.filter((e) => e.kind === 'interview').map((e) => e.stage)).toEqual([
      'open',
      'processing',
      'answered',
      'open',
    ]);
    // Each turn is a fresh run of its own, seeded from SQLite.
    expect(interviewerPrompts()).toHaveLength(2);
  });

  it('never asks the same question twice', async () => {
    seedFacts(t.db, now);
    await start((req) =>
      req.prompt.includes('The interview starts now')
        ? { facts: [], question: 'How big was the team?', about: null }
        : // The same question again, in other case and punctuation.
          { facts: [], question: 'how big was the team', about: null },
    );
    tx((x) => startInterview(x, 'harbor'));
    await settle();
    const [q] = listQuestions(t.db);
    if (!q) throw new Error('no question');
    tx((x) => answerQuestion(x, q.id, 'I would rather not say.'));
    await settle();
    expect(listQuestions(t.db)).toEqual([]);
    expect(questionView(t.db, q.id)).toMatchObject({
      status: 'answered',
      note: 'nothing saved from this answer',
    });
    expect(seen.filter((e) => e.kind === 'interview').at(-1)).toMatchObject({
      stage: 'done',
      message: 'nothing more to ask about Harbor for now',
    });
    expect(alreadyAsked([{ text: 'How big was the team?' }], 'HOW BIG was the team')).toBe(true);
  });

  it('confirms a fact the candidate restates instead of adding it twice', async () => {
    const seeded = seedFacts(t.db, now);
    await start((req) =>
      req.prompt.includes('The interview starts now')
        ? { facts: [], question: 'Did you lead the team?', about: null }
        : {
            facts: [
              {
                text: 'Led a team of 4 engineers on the call-analysis platform.',
                kind: 'role',
                project: 'harbor',
              },
            ],
            question: null,
            about: null,
          },
    );
    tx((x) => startInterview(x, 'harbor'));
    await settle();
    const [q] = listQuestions(t.db);
    if (!q) throw new Error('no question');
    tx((x) => answerQuestion(x, q.id, 'Yes, four engineers.'));
    await settle();
    const team = t.db.select().from(facts).where(eq(facts.id, seeded.team)).get();
    expect(team).toMatchObject({ status: 'confirmed', origin: 'extracted' });
    expect(t.db.select().from(facts).where(eq(facts.origin, 'interview')).all()).toEqual([]);
    expect(questionView(t.db, q.id).facts.map((f) => f.id)).toEqual([seeded.team]);
  });

  it('with no project: open questions first, then the project with the most to ask', async () => {
    seedFacts(t.db, now);
    // Lantern (seeded, no facts) has all four gaps; Harbor has three.
    await start(() => ({ facts: [], question: 'What did you build?', about: null }));
    const first = tx((x) => startInterview(x, null));
    expect(first).toMatchObject({ kind: 'pending', message: expect.stringContaining('Lantern') });
    await settle();
    const next = tx((x) => startInterview(x, null));
    expect(next).toMatchObject({ kind: 'question', question: { project: { slug: 'lantern' } } });
    if (next.kind !== 'question') throw new Error('no question');
    tx((x) => dismissQuestion(x, next.question.id));
    // Lantern was asked about: Harbor is next.
    expect(tx((x) => startInterview(x, null))).toMatchObject({
      kind: 'pending',
      message: expect.stringContaining('Harbor'),
    });
    await settle();
    expect(projectInterviews(t.db).map((p) => [p.project.slug, p.open, p.asked])).toEqual([
      ['harbor', 1, 1],
      ['lantern', 0, 1],
    ]);
    expect(() => tx((x) => dismissQuestion(x, next.question.id))).toThrow(InterviewError);
    expect(() => tx((x) => answerQuestion(x, next.question.id, 'late'))).toThrow(/dismissed/);
  });

  it('puts the question back to the candidate when the answer can’t be read', async () => {
    const p = createProject(t.db, { name: 'Harbor' }, now);
    await start(() => ({ facts: [], question: 'What did you build?', about: null }));
    tx((x) => startInterview(x, 'harbor'));
    await settle();
    const [q] = listQuestions(t.db);
    if (!q) throw new Error('no question');
    tx((x) => answerQuestion(x, q.id, 'The ingest service.'));
    // The last attempt fails: run the handler as the worker would on it.
    const deps = testDeps({
      dir: t.dir,
      providers: [new FakeProvider('claude', [{ error: 'boom' }])],
    });
    const out = await interviewTurn(
      {
        id: 99,
        kind: 'interview_turn',
        entityId: q.id,
        runId: null,
        provider: 'claude',
        attempts: INTERVIEW_ATTEMPTS - 1,
      },
      {
        deps: { ...deps, log: quietLog },
        read: t.read,
        signal: new AbortController().signal,
        progress: () => {},
        now: () => now,
      },
    );
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    tx((x) => out.commit(x));
    expect(questionView(t.db, q.id)).toMatchObject({
      status: 'open',
      note: expect.stringContaining("couldn't read your answer (boom)"),
      answer: 'The ingest service.',
    });
    expect(p.id).toBeGreaterThan(0);
  });

  it('caps follow-ups and checks what the schema can’t', () => {
    const row = (
      id: number,
      origin: 'project' | 'follow_up' | 'application',
      app: number | null = null,
    ) => ({
      id,
      origin,
      applicationId: app,
      projectId: app ? null : 1,
      fieldRef: app ? '1:x' : null,
      text: `q${id}`,
      context: null,
      status: 'answered' as const,
      note: null,
      createdAt: now,
      answeredAt: now,
    });
    const session = [row(1, 'project')];
    for (let i = 2; i <= MAX_QUESTIONS_PER_SESSION; i++) session.push(row(i, 'follow_up'));
    expect(
      mayFollowUp(session, session[MAX_QUESTIONS_PER_SESSION - 2] as (typeof session)[0]),
    ).toBe(true);
    expect(mayFollowUp(session, session.at(-1) as (typeof session)[0])).toBe(false);
    const app = [row(10, 'application', 7), row(11, 'follow_up', 7)];
    expect(mayFollowUp(app, app[0] as (typeof app)[0])).toBe(true);
    expect(mayFollowUp(app, app[1] as (typeof app)[0])).toBe(false);

    const projectsList = [
      { id: 1, slug: 'harbor', name: 'Harbor', period: null, role: null, summary: null },
    ];
    const answer = { question: 'q', answer: 'a' };
    const fact = (project: string | null) => ({
      text: 'Built it',
      kind: 'personal_contribution' as const,
      project,
    });
    expect(
      validateInterview(
        { facts: [fact('nope')], question: null, about: null },
        { projects: projectsList, latest: answer },
      ),
    ).toMatch(/unknown project "nope"/);
    expect(
      validateInterview(
        { facts: [fact(null)], question: null, about: null },
        { projects: projectsList, latest: null },
      ),
    ).toMatch(/before the candidate answered/);
    expect(
      validateInterview(
        { facts: [fact('harbor'), fact(null)], question: null, about: null },
        { projects: projectsList, latest: answer },
      ),
    ).toBeNull();
  });
});
