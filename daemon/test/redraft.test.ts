// Review quick actions: "Shorter" and "Use another project…" redraft one written answer through
// the same writer (same citation rules, checked again), steered by the candidate's ask; the
// answer says which earlier answer it was adapted from.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answers, applications, facts, postings, projects } from '../src/db/schema.ts';
import { redraftAnswer } from '../src/domain/applications/review.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  form,
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
  spec,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-27T10:00:00Z');

describe('review quick actions', () => {
  let t: TempDb;
  let h: PrepareHarness | null = null;

  beforeEach(() => {
    t = tempDb();
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  it('Shorter and Use another project… redraft one answer with the ask and the project’s facts', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const f = seedFacts(t.db, now);
    const lantern = t.db.select().from(projects).where(eq(projects.name, 'Lantern')).get();
    const lanternFact = t.db
      .insert(facts)
      .values({
        projectId: lantern?.id ?? 0,
        text: 'Wrote a Rust CLI that syncs lighthouse logs',
        kind: 'personal_contribution',
        status: 'confirmed',
        origin: 'extracted',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: facts.id })
      .get().id;
    const pid = seedPosting(
      t.db,
      form([
        spec('Tell us about a project you are proud of', 'textarea', {
          meaning: 'question',
          required: true,
        }),
        spec('Why Acme AI?', 'textarea', { meaning: 'question', required: true }),
      ]),
      { now, matches: [{ text: 'Python in production', factIds: [f.pipeline] }] },
    );
    let round = 0;
    h = await prepareHarness(t, {
      drafts: (qs) => {
        round++;
        return qs.map((q) => ({
          question: q.id,
          status: 'answered' as const,
          choice: null,
          sentences:
            round === 1
              ? [
                  { text: 'I built a Python call-analysis pipeline.', factIds: [f.pipeline] },
                  { text: 'It scores support calls.', factIds: [f.pipeline] },
                ]
              : [{ text: 'I wrote a Rust CLI for lighthouse logs.', factIds: [lanternFact] }],
          missing: null,
          adaptedFrom: null,
        }));
      },
    });
    const harness = h;
    const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) => runInTx(t.db, harness.bus, { now }, fn);
    const id = tx((x) => ensureApplication(x, pid, 'test').app.id);
    await harness.worker.idle();
    expect(applicationView(t.db, id).app.stage).toBe('ready_for_review');

    tx((x) => redraftAnswer(x, id, { answer: 'q1', shorter: true, project: 'lantern' }));
    const waiting = applicationView(t.db, id).answers[0];
    expect(waiting?.redraft).toEqual({
      shorter: true,
      project: { id: lantern?.id, name: 'Lantern' },
    });
    await harness.worker.idle();

    const writers = harness.claude.requests.filter((r) => r.role === 'application_writer');
    expect(writers).toHaveLength(2);
    const second = writers[1]?.prompt ?? '';
    // Only the asked answer is drafted again, with the ask and the project's facts to cite.
    expect(second).toContain('Tell us about a project you are proud of');
    expect(second).not.toContain('Why Acme AI?');
    expect(second).toContain('make it clearly shorter');
    expect(second).toContain('answer it from the project "Lantern"');
    expect(second).toContain('Wrote a Rust CLI that syncs lighthouse logs');

    const v = applicationView(t.db, id);
    expect(v.answers.map((a) => a.sentences.map((s) => s.text))).toEqual([
      ['I wrote a Rust CLI for lighthouse logs.'],
      ['I built a Python call-analysis pipeline.', 'It scores support calls.'],
    ]);
    expect(v.answers[0]?.redraft).toBeNull();
    expect(
      t.db
        .select()
        .from(answers)
        .all()
        .every((a) => a.redraft === null),
    ).toBe(true);

    // Refused: a choice, no ask, an unknown project.
    expect(() =>
      tx((x) => redraftAnswer(x, id, { answer: 'q1', shorter: false, project: null })),
    ).toThrow(/shorter, or from another project/);
    expect(() =>
      tx((x) => redraftAnswer(x, id, { answer: 'q1', shorter: false, project: 'nope' })),
    ).toThrow(/no project "nope"/);
  });

  it('an adapted answer says which application and question, and when', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const f = seedFacts(t.db, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('Why do you want to work with us?', 'textarea', {
          meaning: 'question',
          required: true,
        }),
        spec('Why Acme AI?', 'textarea', { meaning: 'question', required: true }),
      ]),
      { now, matches: [{ text: 'Python in production', factIds: [f.pipeline] }] },
    );
    h = await prepareHarness(t, {
      drafts: (qs) =>
        qs.map((q) => ({
          question: q.id,
          status: 'answered' as const,
          choice: null,
          sentences: [{ text: 'I built a Python call-analysis pipeline.', factIds: [f.pipeline] }],
          missing: null,
          adaptedFrom: null,
        })),
    });
    const harness = h;
    const id = runInTx(t.db, harness.bus, { now }, (x) => ensureApplication(x, pid, 'test').app.id);
    await harness.worker.idle();
    const [earlier, later] = applicationView(t.db, id).answers;
    const sent = new Date('2026-09-12T09:00:00Z');
    t.db.update(applications).set({ appliedAt: sent }).where(eq(applications.id, id)).run();
    t.db.update(postings).set({ company: 'Orbit' }).where(eq(postings.id, pid)).run();
    t.db
      .update(answers)
      .set({ adaptedFrom: `answer:${earlier?.id}` })
      .where(eq(answers.id, later?.id ?? 0))
      .run();

    const v = applicationView(t.db, id);
    expect(v.answers[1]?.adapted).toEqual({
      answerId: earlier?.id,
      applicationId: id,
      company: 'Orbit',
      title: v.posting.title,
      question: 'Why do you want to work with us?',
      stage: v.app.stage,
      at: sent,
    });
    expect(v.answers[0]?.adapted).toBeNull();
  });
});
