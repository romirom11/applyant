// The per-application switch between the platform's form (LinkedIn Easy Apply, Xing apply) and
// the company's own form: which one Read and Deliver use, the switch itself (the old form's
// read goes, the application is prepared again for the new one), and when it's refused.
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { applications, postingSources, postings, tasks } from '../src/db/schema.ts';
import { applyTarget, setApplyForm } from '../src/domain/applications/deliver.ts';
import {
  ApplicationError,
  applicationView,
  ensureApplication,
  getApplicationRow,
} from '../src/domain/applications/store.ts';
import { ApplyForm } from '../src/gen/applyant/v1/applyant_pb.js';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { applicationToPb } from '../src/rpc/mapping.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-29T10:00:00Z');
const LINKEDIN = 'https://www.linkedin.com/jobs/view/4001/';
const GREENHOUSE = 'https://boards.greenhouse.io/acme/jobs/4001234';

describe("the platform's form or the company's own", () => {
  let t: TempDb;
  afterEach(() => t?.cleanup());

  function seed(o: { company: boolean }): { postingId: number; appId: number; bus: EventBus } {
    const postingId = t.db
      .insert(postings)
      .values({
        stage: 'verified',
        canonicalUrl: LINKEDIN,
        applyUrl: LINKEDIN,
        formStatus: 'no_form',
        formNote: 'read from the company form',
        formReadAt: now,
      })
      .returning({ id: postings.id })
      .get().id;
    t.db.insert(postingSources).values({ postingId, kind: 'linkedin', url: LINKEDIN }).run();
    if (o.company) {
      t.db.insert(postingSources).values({ postingId, kind: 'greenhouse', url: GREENHOUSE }).run();
    }
    const bus = new EventBus();
    const appId = runInTx(t.db, bus, { now }, (tx) => ensureApplication(tx, postingId, 't').app.id);
    t.db.update(applications).set({ stage: 'ready_for_review' }).run();
    t.db.delete(tasks).run();
    return { postingId, appId, bus };
  }

  const posting = (id: number) => {
    const row = t.db.select().from(postings).where(eq(postings.id, id)).get();
    if (!row) throw new Error('no posting');
    return row;
  };

  it('defaults to the company form; switching re-reads the form and prepares again', () => {
    t = tempDb();
    const { postingId, appId, bus } = seed({ company: true });
    expect(applyTarget(t.read, posting(postingId))).toBe(GREENHOUSE);
    const before = applicationView(t.db, appId);
    expect(before.applyForm).toEqual({ form: 'company', switchable: true });
    expect(applicationToPb(before).applyForm).toBe(ApplyForm.COMPANY);
    expect(applicationToPb(before).applyFormSwitchable).toBe(true);

    runInTx(t.db, bus, { now }, (tx) =>
      setApplyForm(tx, getApplicationRow(tx.db, appId), 'platform'),
    );
    // Read and Deliver both follow the choice now.
    expect(applyTarget(t.read, posting(postingId))).toBe(LINKEDIN);
    const after = applicationView(t.db, appId);
    expect(after.applyForm).toEqual({ form: 'platform', switchable: true });
    expect(after.app.stage).toBe('preparing');
    expect(after.app.note).toMatch(/LinkedIn form/);
    // The company form's read is gone, so nothing prepared for it is shown or sent; preparing
    // waits for the new read (it enqueues read_form itself).
    const p = posting(postingId);
    expect([p.form, p.formStatus, p.formReadAt]).toEqual([null, null, null]);
    const queued = t.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.kind, 'prepare_application'), eq(tasks.entityId, appId)))
      .all();
    expect(queued).toHaveLength(1);

    // The same choice again changes nothing (no second read).
    t.db.update(postings).set({ formStatus: 'no_form', formReadAt: now }).run();
    runInTx(t.db, bus, { now }, (tx) =>
      setApplyForm(tx, getApplicationRow(tx.db, appId), 'platform'),
    );
    expect(posting(postingId).formStatus).toBe('no_form');

    // And back to the company's own form.
    runInTx(t.db, bus, { now }, (tx) =>
      setApplyForm(tx, getApplicationRow(tx.db, appId), 'company'),
    );
    expect(applyTarget(t.read, posting(postingId))).toBe(GREENHOUSE);
    expect(posting(postingId).formStatus).toBeNull();
  });

  it('refuses a form the posting lacks, and any switch once approved', () => {
    t = tempDb();
    const { postingId, appId, bus } = seed({ company: false });
    // Only the platform's form is known: that's the target, and there's nothing to switch to.
    expect(applyTarget(t.read, posting(postingId))).toBe(LINKEDIN);
    expect(applicationView(t.db, appId).applyForm).toEqual({ form: 'platform', switchable: false });
    expect(() =>
      runInTx(t.db, bus, { now }, (tx) =>
        setApplyForm(tx, getApplicationRow(tx.db, appId), 'company'),
      ),
    ).toThrow(ApplicationError);

    t.db.insert(postingSources).values({ postingId, kind: 'greenhouse', url: GREENHOUSE }).run();
    t.db.update(applications).set({ stage: 'approved' }).run();
    expect(() =>
      runInTx(t.db, bus, { now }, (tx) =>
        setApplyForm(tx, getApplicationRow(tx.db, appId), 'platform'),
      ),
    ).toThrow(/only change before approval/);
    expect(applyTarget(t.read, posting(postingId))).toBe(GREENHOUSE);
  });
});
