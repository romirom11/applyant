// The approve gate: blocked by an unconfirmed fact, by a hard flag (a contradicted number),
// by a confirmable one (a number the facts don't have); unblocked by confirming and by the
// candidate's own words, which become confirmed review_edit facts.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { facts } from '../src/db/schema.ts';
import {
  ApprovalBlocked,
  approveApplication,
  confirmApplicationFacts,
  editAnswer,
} from '../src/domain/applications/review.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  form,
  type PrepareHarness,
  prepareHarness,
  type SeededFacts,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
  spec,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-27T10:00:00Z');

describe('approve gate', () => {
  let t: TempDb;
  let h: PrepareHarness;
  let f: SeededFacts;
  let id: number;

  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) => runInTx(t.db, h.bus, { now }, fn);
  const blockers = () => applicationView(t.db, id).blockers.join('\n');

  beforeEach(async () => {
    t = tempDb();
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    f = seedFacts(t.db, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('Full name', 'text', { meaning: 'full_name', required: true }),
        spec('Tell us about a system you built in production.', 'textarea', {
          meaning: 'question',
          required: true,
        }),
      ]),
      {
        now,
        matches: [
          { text: 'Python in production', factIds: [f.pipeline] },
          { text: 'Leadership', factIds: [f.team] },
        ],
      },
    );
    h = await prepareHarness(t, {
      drafts: (qs) => [
        {
          question: qs[0]?.id ?? 'q1',
          status: 'answered',
          choice: null,
          sentences: [
            { text: 'At Harbor I built the Python call-analysis pipeline.', factIds: [f.pipeline] },
            // The seeded exaggeration: the fact says a team of 4.
            { text: 'I led a team of 10 engineers on it.', factIds: [f.team] },
            { text: 'I led the call-analysis platform work.', factIds: [f.team] },
            { text: 'That was 5+ years of Python work.', factIds: [f.pipeline] },
          ],
          missing: null,
          adaptedFrom: null,
        },
      ],
    });
    id = tx((x) => ensureApplication(x, pid, 'test').app.id);
    await h.worker.idle();
  });

  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  it('is blocked by unconfirmed facts and flags, and opens once the candidate settles them', () => {
    const v = applicationView(t.db, id);
    expect(v.app.stage).toBe('ready_for_review');
    expect(v.answers[0]?.sentences.map((s) => s.flag)).toEqual([
      'none',
      'contradiction',
      'unconfirmed',
      'absent_number',
    ]);
    expect(v.answers[0]?.sentences[1]?.note).toMatch(/team of 4.*team of 10/);
    expect(v.unconfirmedFactIds).toEqual([f.team]);
    expect(() => tx((x) => approveApplication(x, id))).toThrow(ApprovalBlocked);
    expect(blockers()).toMatch(/unconfirmed fact\(s\): #2/);
    expect(blockers()).toMatch(/q1\.2 contradicts a cited fact/);

    // Confirming the fact clears "unconfirmed", not the hard flag.
    tx((x) => confirmApplicationFacts(x, id));
    expect(applicationView(t.db, id).answers[0]?.sentences[2]?.flag).toBe('none');
    expect(() => tx((x) => approveApplication(x, id))).toThrow(/contradicts a cited fact/);

    // A contradiction can't be confirmed as written: only an edit clears it.
    expect(() => tx((x) => editAnswer(x, id, { answer: 'q1', sentence: 1, text: null }))).toThrow(
      /rewrite it/,
    );
    const edit = tx((x) =>
      editAnswer(x, id, { answer: 'q1', sentence: 1, text: 'I led a team of 4 engineers on it.' }),
    );
    expect(edit.factIds).toHaveLength(1);
    const saved = t.db
      .select()
      .from(facts)
      .where(eq(facts.id, edit.factIds[0] ?? 0))
      .get();
    expect(saved).toMatchObject({
      text: 'I led a team of 4 engineers on it.',
      status: 'confirmed',
      origin: 'review_edit',
      projectId: f.projectId,
    });
    expect(() => tx((x) => approveApplication(x, id))).toThrow(/a number not in the cited facts/);

    // A derived number is confirmable in one step: it's true, it just wasn't in the facts.
    tx((x) => editAnswer(x, id, { answer: 'q1', sentence: 3, text: null }));
    expect(applicationView(t.db, id).answers[0]?.sentences.map((s) => s.flag)).toEqual([
      'none',
      'none',
      'none',
      'none',
    ]);
    expect(blockers()).toBe('');
    const approved = tx((x) => approveApplication(x, id));
    expect(approved).toMatchObject({ stage: 'approved' });
    expect(approved.approvedAt).toEqual(now);
    // Approved means frozen.
    expect(() =>
      tx((x) => editAnswer(x, id, { answer: 'q1', sentence: 0, text: 'Something else.' })),
    ).toThrow(/already approved/);
  });

  it('a rejected fact blocks the sentences that cite it', () => {
    tx((x) => confirmApplicationFacts(x, id));
    t.db.update(facts).set({ status: 'rejected' }).where(eq(facts.id, f.pipeline)).run();
    const v = applicationView(t.db, id);
    expect(v.answers[0]?.sentences[0]?.flag).toBe('rejected_fact');
    expect(blockers()).toMatch(/cites a fact you rejected/);
  });

  it('rewriting a whole answer keeps unchanged sentences and saves the new ones as facts', () => {
    const before = applicationView(t.db, id).answers[0];
    const first = before?.sentences[0]?.text ?? '';
    const res = tx((x) =>
      editAnswer(x, id, {
        answer: 'q1',
        sentence: null,
        text: `${first} I led a team of 4 engineers. I enjoy this kind of work!`,
      }),
    );
    expect(res.factIds).toHaveLength(2);
    const a = applicationView(t.db, id).answers[0];
    expect(a?.edited).toBe(true);
    expect(a?.sentences.map((s) => [s.text, s.flag])).toEqual([
      [first, 'none'],
      ['I led a team of 4 engineers.', 'none'],
      ['I enjoy this kind of work!', 'none'],
    ]);
    expect(blockers()).toBe('');
    const field = applicationView(t.db, id).fields.find((x) => x.role === 'question');
    expect(field?.value).toBe(`${first} I led a team of 4 engineers. I enjoy this kind of work!`);
  });
});
