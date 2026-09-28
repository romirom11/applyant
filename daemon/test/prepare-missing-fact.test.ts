// A fact preparation finds missing becomes an interview question: the application waits on it,
// the answer becomes facts, and preparation resumes, now citing them, to ready_for_review. The
// same form question isn't asked twice.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import {
  answerQuestion,
  dismissQuestion,
  listQuestions,
  questionView,
} from '../src/domain/knowledge/interview.ts';
import type { Draft } from '../src/models/schemas/application.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  form,
  type PrepareHarness,
  prepareHarness,
  type Script,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
  spec,
  type WriterQuestionSeen,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-28T10:00:00Z');
const LEADERSHIP = 'Describe a time you led a team through a hard deadline.';
const KUBERNETES = 'Have you run Kubernetes in production?';
const TOLD = 'Led 4 engineers to ship the scoring service in six weeks';

const needsYou = (q: WriterQuestionSeen, missing: string): Draft => ({
  question: q.id,
  status: 'needs_candidate',
  choice: null,
  sentences: [],
  missing,
  adaptedFrom: null,
});

/** The facts the writer was given for one question (its "Facts found" block): id → text. */
function factsGiven(prompt: string, id: string): Map<number, string> {
  const at = prompt.indexOf(`[${id}] `);
  const end = prompt.indexOf('\n[q', at + 1);
  const block = prompt.slice(at, end === -1 ? undefined : end);
  return new Map(
    [...block.matchAll(/^ {4}#(\d+) \[[^\]]*\] (.+)$/gm)].map((m) => [Number(m[1]), m[2] ?? '']),
  );
}

/** Answers a question from the interview fact given for it; needs the candidate otherwise. */
const writer: Script['drafts'] = (qs, req) =>
  qs.map((q) => {
    // Retrieval may hand the leadership fact to other questions too; it answers only this one.
    const told = [...factsGiven(req.prompt, q.id)].find(([, text]) => text === TOLD);
    if (!told || q.label !== LEADERSHIP) return needsYou(q, 'Whether you have led a team, and how');
    return {
      question: q.id,
      status: 'answered' as const,
      choice: null,
      sentences: [
        {
          text: 'I led four engineers to ship the scoring service in six weeks.',
          factIds: [told[0]],
        },
      ],
      missing: null,
      adaptedFrom: null,
    };
  });

describe('a missing fact goes to the interview', () => {
  let t: TempDb;
  let h: PrepareHarness | null = null;

  beforeEach(() => {
    t = tempDb();
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    seedFacts(t.db, now);
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  const start = async (script: Script) => {
    h = await prepareHarness(t, script);
    return h;
  };
  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) =>
    runInTx(t.db, (h as PrepareHarness).bus, { now }, fn);
  const settle = () => (h as PrepareHarness).worker.idle();
  const writerRuns = () =>
    (h as PrepareHarness).claude.requests.filter(
      (r) => r.role === 'application_writer' && r.prompt.includes('Questions, in the order'),
    ).length;
  const apply = (labels: string[]) => {
    const pid = seedPosting(
      t.db,
      form([
        spec('Email', 'text', { meaning: 'email', required: true }),
        ...labels.map((l) => spec(l, 'textarea', { meaning: 'question', required: true })),
      ]),
      { now },
    );
    return tx((x) => ensureApplication(x, pid, 'test').app.id);
  };

  it('pauses on the question and resumes to ready_for_review once it is answered', async () => {
    await start({
      drafts: writer,
      interview: (req) => {
        expect(req.prompt).toContain(`asks the candidate: "${LEADERSHIP}"`);
        expect(req.prompt).toContain("what's missing: Whether you have led a team, and how");
        expect(req.prompt).toContain('I led four engineers');
        return {
          facts: [{ text: TOLD, kind: 'role', project: 'harbor' }],
          question: null,
          about: null,
        };
      },
    });
    const id = apply([LEADERSHIP]);
    await settle();

    const waiting = applicationView(t.db, id);
    expect(waiting.app.stage).toBe('needs_candidate');
    const [q] = listQuestions(t.db);
    expect(q).toMatchObject({
      applicationId: id,
      origin: 'application',
      status: 'open',
      text: LEADERSHIP,
      application: 'Acme AI · Senior AI Engineer',
      context: 'Whether you have led a team, and how',
    });
    if (!q) throw new Error('no question');
    expect(waiting.answers[0]).toMatchObject({
      status: 'needs_candidate',
      missing: 'Whether you have led a team, and how',
      interviewQuestionId: q.id,
    });
    expect(waiting.missing[0]).toContain(`asked in the interview (question ${q.id})`);
    expect(writerRuns()).toBe(1);

    tx((x) =>
      answerQuestion(
        x,
        q.id,
        'Yes: I led four engineers to ship the scoring service in six weeks.',
      ),
    );
    await settle();

    const told = questionView(t.db, q.id).facts;
    expect(told.map((f) => [f.text, f.status, f.projectSlug])).toEqual([
      [TOLD, 'confirmed', 'harbor'],
    ]);
    const ready = applicationView(t.db, id);
    expect(ready.app.stage).toBe('ready_for_review');
    expect(ready.blockers).toEqual([]);
    expect(ready.answers[0]).toMatchObject({ status: 'answered', interviewQuestionId: null });
    expect(ready.answers[0]?.sentences[0]?.facts.map((f) => [f.id, f.origin, f.status])).toEqual([
      [told[0]?.id, 'interview', 'confirmed'],
    ]);
    // One question asked, one writer run for each preparation.
    expect(listQuestions(t.db, { all: true })).toHaveLength(1);
    expect(writerRuns()).toBe(2);
  });

  it('asks a form question once: an answer that didn’t settle it is left to the candidate', async () => {
    await start({
      // The writer never finds enough.
      drafts: (qs) => qs.map((q) => needsYou(q, 'Whether you have led a team, and how')),
      interview: () => ({ facts: [], question: null, about: null }),
    });
    const id = apply([LEADERSHIP]);
    await settle();
    const [q] = listQuestions(t.db);
    if (!q) throw new Error('no question');
    tx((x) => answerQuestion(x, q.id, 'Not really.'));
    await settle();

    const v = applicationView(t.db, id);
    expect(v.app.stage).toBe('needs_candidate');
    expect(listQuestions(t.db)).toEqual([]);
    expect(listQuestions(t.db, { all: true })).toHaveLength(1);
    expect(v.missing[0]).toContain(
      `your interview answer (question ${q.id}) didn't settle it: write the answer yourself`,
    );
    expect(writerRuns()).toBe(2);
  });

  it('waits for every question of the application before preparing it again', async () => {
    await start({
      drafts: writer,
      interview: (req) => ({
        facts: req.prompt.includes(LEADERSHIP)
          ? [{ text: TOLD, kind: 'role', project: 'harbor' }]
          : [],
        question: null,
        about: null,
      }),
    });
    const id = apply([LEADERSHIP, KUBERNETES]);
    await settle();
    const questions = listQuestions(t.db);
    expect(questions.map((q) => q.text)).toEqual([LEADERSHIP, KUBERNETES]);
    const [lead, k8s] = questions;
    if (!lead || !k8s) throw new Error('no questions');

    tx((x) => answerQuestion(x, lead.id, 'I led four engineers on the scoring service.'));
    await settle();
    // The Kubernetes question still waits: no new writer run yet.
    expect(writerRuns()).toBe(1);
    expect(applicationView(t.db, id).app.stage).toBe('needs_candidate');

    // "Later": the answer it did get is used now; the skipped one is the candidate's to write.
    tx((x) => dismissQuestion(x, k8s.id));
    await settle();
    expect(writerRuns()).toBe(2);
    const v = applicationView(t.db, id);
    expect(v.answers.map((a) => a.status)).toEqual(['answered', 'needs_candidate']);
    expect(v.missing).toHaveLength(1);
    expect(v.missing[0]).toContain(`you skipped it in the interview (question ${k8s.id})`);
    expect(listQuestions(t.db, { all: true })).toHaveLength(2);
  });

  it('doesn’t ask the interview for instructions the posting holds', async () => {
    await start({
      drafts: (qs) => qs.map((q) => needsYou(q, 'The phrase the posting asks for')),
    });
    const id = apply(['Start your answer with the exact phrase from the job description.']);
    await settle();
    expect(applicationView(t.db, id).app.stage).toBe('needs_candidate');
    expect(listQuestions(t.db, { all: true })).toEqual([]);
  });
});
