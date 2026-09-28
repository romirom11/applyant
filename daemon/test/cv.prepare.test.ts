// Tailored CVs through the real queue: preparation writes the plan from confirmed facts, checks
// every line, renders the PDF and points the Resume field at it; use-base / use-tailored swap
// it; an edit becomes a confirmed fact and a new PDF; without confirmed facts the base CV
// stands in; a fact rejected afterwards blocks approve.
import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cvJson, cvLines, previewLines } from '../src/cli/applications.ts';
import { cvs, facts } from '../src/db/schema.ts';
import { CV_SYSTEM } from '../src/domain/applications/cv/select.ts';
import { editCvLine, setCvMode } from '../src/domain/applications/cv/store.ts';
import { ApprovalBlocked, approveApplication } from '../src/domain/applications/review.ts';
import {
  applicationView,
  ensureApplication,
  requestPrepare,
} from '../src/domain/applications/store.ts';
import { getStandardProfile } from '../src/domain/knowledge/profile.ts';
import { pdfToText } from '../src/domain/knowledge/text/pdf.ts';
import { runInTx } from '../src/queue/tx.ts';
import { applicationToPb } from '../src/rpc/mapping.ts';
import {
  cvFile,
  defaultCvPlan,
  form,
  type PrepareHarness,
  prepareHarness,
  type Script,
  type SeededFacts,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
  spec,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-28T10:00:00Z');

describe('tailored CV in preparation', () => {
  let t: TempDb;
  let h: PrepareHarness | null = null;
  let base: string;

  beforeEach(() => {
    t = tempDb();
    base = cvFile(t.dir);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: base }, now);
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  const cvForm = () =>
    form([
      spec('Full name', 'text', { meaning: 'full_name', required: true }),
      spec('Email', 'text', { meaning: 'email', required: true }),
      spec('Resume', 'file', { meaning: 'resume', required: true }),
    ]);
  const start = async (script: Script = {}) => {
    h = await prepareHarness(t, script);
    return h;
  };
  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) =>
    runInTx(t.db, (h as PrepareHarness).bus, { now }, fn);
  const settle = () => (h as PrepareHarness).worker.idle();
  const view = (id: number) => applicationView(t.db, id);
  const resume = (id: number) => {
    const f = view(id).fields.find((x) => x.label === 'Resume');
    if (!f) throw new Error('no Resume field');
    return f;
  };
  const cvRuns = () =>
    (h as PrepareHarness).claude.requests.filter(
      (r) => r.role === 'application_writer' && r.system === CV_SYSTEM,
    );
  const prepared = async (f: SeededFacts | null, script: Script = {}) => {
    const pid = seedPosting(t.db, cvForm(), {
      now,
      matches: f ? [{ text: 'Production Python', factIds: [f.pipeline] }] : [],
    });
    await start(script);
    const id = tx((x) => ensureApplication(x, pid, 'test').app.id);
    await settle();
    return id;
  };

  it('writes the CV from confirmed facts only, checks each line, renders it and sends that exact PDF', async () => {
    const f = seedFacts(t.db, now);
    const id = await prepared(f, {
      cv: (seen) => {
        const plan = defaultCvPlan(seen);
        plan.projects[0]?.bullets.push({
          text: 'Built a pipeline for 10 million calls a day',
          factIds: [f.pipeline],
        });
        return plan;
      },
      verdict: (s) =>
        /10 million/.test(s)
          ? { supported: false, issue: 'quantity', note: 'no fact gives 10 million' }
          : { supported: true, issue: 'none', note: 'ok' },
    });

    // The writer saw the confirmed facts, not the unconfirmed "team of 4" one.
    const [run] = cvRuns();
    expect(cvRuns()).toHaveLength(1);
    expect(run?.prompt).toContain(`#${f.pipeline} [`);
    expect(run?.prompt).toContain(`#${f.oss} [`);
    expect(run?.prompt).not.toContain(`#${f.team} [`);
    expect(run?.prompt).not.toContain('Led a team of 4');

    const v = view(id);
    expect(v.app.stage).toBe('ready_for_review');
    expect(v.blockers).toEqual([]);
    const cv = v.cv;
    if (!cv?.pdfPath) throw new Error('no tailored CV');
    expect(cv).toMatchObject({ mode: 'tailored', status: 'ready' });
    expect(cv.projects.map((p) => p.name)).toEqual(['Harbor']);
    expect(cv.projects[0]?.bullets.map((b) => b.text)).not.toContain(
      'Built a pipeline for 10 million calls a day',
    );
    expect(cv.dropped).toEqual([
      expect.objectContaining({
        handle: 'd1',
        section: 'harbor',
        text: 'Built a pipeline for 10 million calls a day',
        reason: expect.stringMatching(/overstates a quantity/),
      }),
    ]);
    expect(
      cv.projects
        .flatMap((p) => p.bullets)
        .flatMap((b) => b.facts)
        .every((x) => x.status === 'confirmed'),
    ).toBe(true);

    // The Resume field is the tailored PDF, and the PDF says what the plan says.
    expect(resume(id)).toMatchObject({
      value: cv.pdfPath,
      source: 'file',
      note: 'your tailored CV',
    });
    expect(existsSync(cv.pdfPath)).toBe(true);
    const text = (await pdfToText(readFileSync(cv.pdfPath))).pages.join(' ');
    expect(text.replace(/\s+/g, ' ')).toContain('Built the Python call-analysis pipeline');
    expect(text).toContain('Jordan Testperson');
    expect(text).not.toContain('10 million');
  });

  it('use-base sends the base CV; use-tailored brings the tailored one back without writing it again', async () => {
    seedFacts(t.db, now);
    const id = await prepared(null);
    const tailored = view(id).cv?.pdfPath;
    expect(tailored).toBeTruthy();

    tx((x) => setCvMode(x, id, 'base', getStandardProfile(x.db)));
    expect(view(id).cv?.mode).toBe('base');
    expect(resume(id)).toMatchObject({ value: base, source: 'file', note: 'your base CV' });
    expect(view(id).app.stage).toBe('ready_for_review');

    // A re-prepare keeps the choice.
    tx((x) => requestPrepare(x, view(id).app, { rewrite: false, why: 'again' }));
    await settle();
    expect(resume(id).value).toBe(base);

    tx((x) => setCvMode(x, id, 'tailored', getStandardProfile(x.db)));
    await settle();
    expect(resume(id).value).toMatch(/\.pdf$/);
    expect(resume(id).value).not.toBe(base);
    expect(cvRuns()).toHaveLength(1);
  });

  it('an edited line becomes a confirmed fact and a new PDF; a left-out line can come back in your words', async () => {
    const f = seedFacts(t.db, now);
    const id = await prepared(f, {
      verdict: (s) =>
        /open-source/.test(s)
          ? { supported: false, issue: 'scope', note: 'test' }
          : { supported: true, issue: 'none', note: 'ok' },
    });
    const before = view(id).cv;
    if (!before?.pdfPath) throw new Error('no CV');
    expect(before.dropped.map((d) => d.handle)).toEqual(['d1']);

    const res = tx((x) =>
      editCvLine(x, id, 'p1.1', 'Built and ran the Python pipeline that scores support calls'),
    );
    const fact = t.db
      .select()
      .from(facts)
      .where(eq(facts.id, res.factId ?? 0))
      .get();
    expect(fact).toMatchObject({
      status: 'confirmed',
      origin: 'review_edit',
      projectId: f.projectId,
    });
    expect(view(id).app.stage).toBe('preparing');
    await settle();

    const after = view(id).cv;
    expect(after?.status).toBe('ready');
    expect(after?.pdfPath).not.toBe(before.pdfPath);
    expect(after?.projects[0]?.bullets[0]).toMatchObject({
      text: 'Built and ran the Python pipeline that scores support calls',
      factIds: [res.factId],
    });
    expect(resume(id).value).toBe(after?.pdfPath);
    expect(view(id).app.stage).toBe('ready_for_review');

    // The dropped line, in the candidate's words, goes back under its project.
    tx((x) => editCvLine(x, id, 'd1', 'Maintain an open-source audio chunking library'));
    await settle();
    const back = view(id).cv;
    expect(back?.dropped).toEqual([]);
    expect(back?.projects[0]?.bullets.at(-1)?.text).toBe(
      'Maintain an open-source audio chunking library',
    );

    tx((x) => editCvLine(x, id, 'p1.1', null));
    await settle();
    expect(view(id).cv?.projects[0]?.bullets.map((b) => b.text)).not.toContain(
      'Built and ran the Python pipeline that scores support calls',
    );
    expect(() => tx((x) => editCvLine(x, id, 'x9', 'nope'))).toThrow(/not a CV line/);
    // Nothing was drafted again for any of it: only the first CV run happened.
    expect(cvRuns()).toHaveLength(1);
  });

  it('without confirmed facts the base CV stands in, with the reason', async () => {
    const id = await prepared(null);
    expect(cvRuns()).toHaveLength(0);
    expect(view(id).cv).toMatchObject({
      mode: 'tailored',
      status: 'skipped',
      note: 'no confirmed facts yet',
    });
    expect(resume(id)).toMatchObject({
      value: base,
      source: 'file',
      note: 'your base CV (no confirmed facts yet)',
    });
    expect(view(id).app.stage).toBe('ready_for_review');

    // Facts confirmed later: a re-prepare tries the tailored CV again.
    seedFacts(t.db, now);
    tx((x) => requestPrepare(x, view(id).app, { rewrite: false, why: 'facts confirmed' }));
    await settle();
    expect(view(id).cv?.status).toBe('ready');
    expect(cvRuns()).toHaveLength(1);
  });

  it('a fact rejected after the CV was made blocks approve until the line is dealt with', async () => {
    const f = seedFacts(t.db, now);
    const id = await prepared(f);
    const line = view(id).cv?.projects[0]?.bullets.find((b) => b.factIds.includes(f.oss));
    if (!line) throw new Error('no line citing the library fact');

    t.db.update(facts).set({ status: 'rejected' }).where(eq(facts.id, f.oss)).run();
    expect(view(id).cv?.stale).toEqual([line.handle]);
    expect(() => tx((x) => approveApplication(x, id))).toThrow(ApprovalBlocked);
    expect(view(id).blockers.join('\n')).toMatch(/no longer confirmed/);

    tx((x) => editCvLine(x, id, line.handle, null));
    await settle();
    expect(view(id).cv?.stale).toEqual([]);
    expect(view(id).blockers).toEqual([]);
  });

  it('a form without a CV slot gets no CV', async () => {
    seedFacts(t.db, now);
    const pid = seedPosting(
      t.db,
      form([spec('Email', 'text', { meaning: 'email', required: true })]),
      { now },
    );
    await start();
    const id = tx((x) => ensureApplication(x, pid, 'test').app.id);
    await settle();
    expect(view(id).cv).toBeNull();
    expect(t.db.select().from(cvs).all()).toEqual([]);
    expect(cvRuns()).toHaveLength(0);
  });

  it('preview shows the CV card: what leads, each line with its facts, and what was left out', async () => {
    const f = seedFacts(t.db, now);
    const id = await prepared(f, {
      verdict: (s) =>
        /open-source/.test(s)
          ? { supported: false, issue: 'scope', note: 'one library, not a platform' }
          : { supported: true, issue: 'none', note: 'ok' },
    });
    const pb = applicationToPb(view(id));
    if (!pb.cv) throw new Error('no CV in the proto');
    const card = cvLines(pb.cv, id).join('\n');
    expect(card).toMatch(/^CV · tailored · .*\.pdf$/m);
    expect(card).toContain('leads with Harbor · 2 bullet(s) · 1 skill(s)');
    expect(card).toMatch(
      new RegExp(`p1\\.1 +Built the Python call-analysis pipeline.*✓#${f.pipeline}`),
    );
    expect(card).toMatch(
      /Left out \(1\):\n +d1 +"Maintains an open-source .*" \(harbor\): the verifier: overstates the scope/,
    );
    expect(card).toContain('Skills: Python');
    expect(previewLines(pb).join('\n')).toContain(card);
    expect(cvJson(pb.cv)).toMatchObject({ mode: 'tailored', status: 'ready', skills: ['Python'] });

    tx((x) => setCvMode(x, id, 'base', getStandardProfile(x.db)));
    const basePb = applicationToPb(view(id));
    if (!basePb.cv) throw new Error('no CV in the proto');
    expect(cvLines(basePb.cv, id)).toEqual([
      `CV · your base CV (\`applyant applications cv use-tailored ${id}\` for a tailored one)`,
    ]);
  });
});
