// prepare_application through the queue with a scripted model and a synthetic candidate:
// profile values are defaults, overrides are per application and survive re-preparation,
// nothing missing is invented, branches follow the values, group entries are filled by their
// group, and loose classifications don't put a profile value in the wrong field.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postings } from '../src/db/schema.ts';
import { setFieldValue } from '../src/domain/applications/review.ts';
import {
  applicationView,
  catchUpApplications,
  ensureApplication,
  getApplicationRow,
  listApplications,
  requestPrepare,
} from '../src/domain/applications/store.ts';
import { getStandardProfile } from '../src/domain/knowledge/profile.ts';
import { recordDecision } from '../src/domain/scoring/store.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  cvFile,
  form,
  type PrepareHarness,
  prepareHarness,
  type Script,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
  spec,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-27T10:00:00Z');

describe('prepare_application', () => {
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

  const start = async (script: Script = {}) => {
    h = await prepareHarness(t, script);
    return h;
  };
  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) =>
    runInTx(t.db, (h as PrepareHarness).bus, { now }, fn);
  const create = (postingId: number) => tx((x) => ensureApplication(x, postingId, 'test').app.id);
  const settle = () => (h as PrepareHarness).worker.idle();
  const view = (id: number) => applicationView(t.db, id);
  const field = (id: number, label: string) => {
    const f = view(id).fields.find((x) => x.label === label);
    if (!f) throw new Error(`no field ${label}`);
    return f;
  };

  it('fills standard fields from the profile and never invents what the profile lacks', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('First name', 'text', { meaning: 'first_name', required: true }),
        spec('Last name', 'text', { meaning: 'last_name', required: true }),
        spec('Email', 'text', { meaning: 'email', required: true }),
        spec('Country code', 'combobox', {
          meaning: 'phone',
          options: ['United States +1', 'Greece +30', 'Cyprus +357'],
        }),
        spec('Current company', 'text', { meaning: 'current_company', required: true }),
        spec('Will you need visa sponsorship?', 'select', {
          meaning: 'visa_sponsorship',
          required: true,
          options: ['Yes', 'No'],
        }),
        spec('Video link URL', 'text', { meaning: 'website' }),
        spec('Resume', 'file', { meaning: 'resume', required: true }),
        spec('Education', 'group', { meaning: 'education' }),
        spec('School', 'text', {
          meaning: 'education',
          required: true,
          revealedBy: { label: 'Education', kind: 'group', value: 'add' },
        }),
        spec('Start date', 'text', {
          meaning: 'notice_period',
          revealedBy: { label: 'Education', kind: 'group', value: 'add' },
        }),
        spec('Gender', 'select', {
          meaning: 'eeo',
          options: ['Male', 'Female', 'Decline to self-identify'],
        }),
        spec('I accept the privacy notice', 'checkbox', { meaning: 'consent', required: true }),
      ]),
      { now },
    );
    const s = await start();
    const id = create(pid);
    await settle();

    const v = view(id);
    expect(v.app.stage).toBe('needs_candidate');
    expect(field(id, 'First name')).toMatchObject({ value: 'Jordan', source: 'profile' });
    expect(field(id, 'Last name')).toMatchObject({ value: 'Testperson', source: 'profile' });
    expect(field(id, 'Email')).toMatchObject({
      value: 'jordan.testperson@example.test',
      source: 'profile',
    });
    // The dialling-code list is decided by the phone's own code.
    expect(field(id, 'Country code')).toMatchObject({ value: 'Greece +30', source: 'profile' });
    // Missing from the profile: left empty and required of the candidate, never guessed.
    expect(field(id, 'Current company')).toMatchObject({ value: null, missing: true });
    // Sponsorship is its own answer: work_authorization isn't borrowed for it.
    expect(field(id, 'Will you need visa sponsorship?')).toMatchObject({
      value: null,
      missing: true,
    });
    expect(field(id, 'Resume')).toMatchObject({ value: null, missing: true });
    // A loose "website" classification on a video link gets nothing.
    expect(field(id, 'Video link URL')).toMatchObject({ value: null, missing: false });
    // Group entries are the group's: no entry, so "Start date" isn't a notice period anywhere.
    expect(field(id, 'Start date')).toMatchObject({ value: null, active: false, role: 'entry' });
    expect(field(id, 'School')).toMatchObject({ active: false, missing: false });
    expect(field(id, 'Gender')).toMatchObject({ value: null, missing: false });
    expect(field(id, 'I accept the privacy notice')).toMatchObject({
      value: 'checked',
      source: 'rule',
    });
    expect(v.missing.map((m) => m.replace(/ \(.*$/, ''))).toEqual([
      '#5 Current company',
      '#6 Will you need visa sponsorship?',
      '#8 Resume',
    ]);
    // No question on this form and nothing to match: no model was asked anything.
    expect(s.claude.requests.map((r) => r.role)).toEqual([]);

    // Per-application values: the profile stays as it was.
    tx((x) => setFieldValue(x, id, 'current_company', 'Globex'));
    tx((x) => setFieldValue(x, id, '#6', 'no'));
    tx((x) => setFieldValue(x, id, 'Resume', cvFile(t.dir)));
    expect(field(id, 'Current company')).toMatchObject({ value: 'Globex', source: 'override' });
    expect(field(id, 'Will you need visa sponsorship?')).toMatchObject({
      value: 'No',
      source: 'override',
    });
    expect(getStandardProfile(t.db).current_company).toBeNull();
    expect(view(id).app.stage).toBe('ready_for_review');
    expect(view(id).blockers).toEqual([]);

    // A group takes its entries as a whole, and its entry fields then apply.
    tx((x) => setFieldValue(x, id, 'Education', '[{"School": "Example University"}]'));
    expect(field(id, 'School')).toMatchObject({ active: true });
    expect(() => tx((x) => setFieldValue(x, id, 'Education', '[{"Hobby": "x"}]'))).toThrow(
      /not a field of a Education entry/,
    );
    expect(() => tx((x) => setFieldValue(x, id, 'School', 'X'))).toThrow(
      /entry of a repeatable group/,
    );
    expect(() => tx((x) => setFieldValue(x, id, '#6', 'Maybe'))).toThrow(/not an option/);
  });

  it('an override survives re-preparation; clearing it restores the (updated) profile value', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('Expected salary', 'text', { meaning: 'salary', required: true }),
        spec('Where are you based?', 'text', { meaning: 'location', required: true }),
      ]),
      { now },
    );
    await start();
    const id = create(pid);
    await settle();
    expect(field(id, 'Expected salary')).toMatchObject({
      value: '60000 EUR per year',
      source: 'profile',
    });

    tx((x) => setFieldValue(x, id, 'salary', '75000 EUR per year'));
    setProfile(
      t.db,
      { location: 'Nicosia, Cyprus', salary_expectation: '65000 EUR per year' },
      now,
    );
    tx((x) => requestPrepare(x, getApplicationRow(x.db, id), { rewrite: false, why: 'again' }));
    await settle();

    expect(view(id).app.stage).toBe('ready_for_review');
    expect(field(id, 'Expected salary')).toMatchObject({
      value: '75000 EUR per year',
      source: 'override',
      defaultValue: '65000 EUR per year',
      defaultSource: 'profile',
    });
    expect(field(id, 'Where are you based?')).toMatchObject({
      value: 'Nicosia, Cyprus',
      source: 'profile',
    });

    tx((x) => setFieldValue(x, id, 'salary', null));
    expect(field(id, 'Expected salary')).toMatchObject({
      value: '65000 EUR per year',
      source: 'profile',
    });
  });

  it('prepares only the branch the values take; an override that changes it changes what is asked', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    seedFacts(t.db, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('Are you eligible to work in the EU?', 'radio', {
          meaning: 'work_authorization',
          required: true,
          options: ['Yes', 'No'],
        }),
        spec('Please explain your work permit situation', 'textarea', {
          meaning: 'question',
          required: true,
          revealedBy: { label: 'Are you eligible to work in the EU?', kind: 'radio', value: 'No' },
        }),
      ]),
      { now },
    );
    const s = await start({
      option: (label, answer, options) =>
        /\bEU\b/.test(label) && /EU citizen/.test(answer)
          ? (options.find((o) => o === 'Yes') ?? null)
          : null,
    });
    const id = create(pid);
    await settle();

    expect(field(id, 'Are you eligible to work in the EU?')).toMatchObject({
      value: 'Yes',
      source: 'profile',
    });
    expect(field(id, 'Please explain your work permit situation')).toMatchObject({
      active: false,
      missing: false,
    });
    expect(s.claude.requests.some((r) => r.role === 'application_writer')).toBe(false);
    expect(view(id).app.stage).toBe('ready_for_review');

    tx((x) => setFieldValue(x, id, '#1', 'No'));
    expect(field(id, 'Please explain your work permit situation')).toMatchObject({
      active: true,
      missing: true,
    });
    expect(view(id).app.stage).toBe('needs_candidate');
  });

  it('a US-only authorisation question is not settled by an EU answer on file', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('Are you legally authorized to work in the United States?', 'radio', {
          meaning: 'work_authorization',
          required: true,
          options: ['Yes', 'No'],
        }),
      ]),
      { now },
    );
    // The scripted option_match only answers when the region matches.
    await start({
      option: (label, answer, options) =>
        /\bEU\b/.test(label) && /EU citizen/.test(answer) ? (options[0] ?? null) : null,
    });
    const id = create(pid);
    await settle();
    const f = field(id, 'Are you legally authorized to work in the United States?');
    expect(f).toMatchObject({ value: null, missing: true });
    expect(f.note).toMatch(/doesn't settle this question/);
  });

  it('a question pointing back at the posting gets the posting text; the writer drafts it', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const f = seedFacts(t.db, now);
    const pid = seedPosting(
      t.db,
      form([
        spec(
          'Did you start your first written answer below with the exact phrase we asked for in the job description?',
          'radio',
          {
            meaning: 'question',
            required: true,
            options: ['YES', 'NO'],
          },
        ),
        spec('Why Acme AI?', 'textarea', { meaning: 'question', required: true }),
      ]),
      { now, matches: [{ text: 'Python in production', factIds: [f.pipeline] }] },
    );
    const s = await start({
      drafts: (qs) => [
        {
          question: qs[0]?.id ?? 'q1',
          status: 'answered',
          choice: 'YES',
          sentences: [],
          missing: null,
          adaptedFrom: null,
        },
        {
          question: qs[1]?.id ?? 'q2',
          status: 'answered',
          choice: null,
          sentences: [
            { text: 'Harbor lights ahead.', factIds: [] },
            { text: 'I built a Python call-analysis pipeline.', factIds: [1] },
          ],
          missing: null,
          adaptedFrom: null,
        },
      ],
    });
    const id = create(pid);
    await settle();

    const writer = s.claude.requests.find((r) => r.role === 'application_writer');
    expect(writer?.prompt).toContain(
      'Start your first written answer with the phrase "Harbor lights ahead"',
    );
    expect(writer?.prompt).toContain('(refers back to the job posting');
    // Every project is listed, not just the retrieved ones.
    expect(writer?.prompt).toMatch(/Harbor \[harbor\][\s\S]*Lantern \[lantern\]/);
    expect(writer?.tools?.allowed).toEqual([
      'mcp__applyant__search_facts',
      'mcp__applyant__get_project',
    ]);
    const v = view(id);
    expect(v.app.stage).toBe('ready_for_review');
    expect(v.answers.map((a) => [a.kind, a.choice, a.sentences.map((x) => x.flag)])).toEqual([
      ['choice', 'YES', []],
      ['text', null, ['none', 'none']],
    ]);
    expect(field(id, 'Why Acme AI?')).toMatchObject({
      value: 'Harbor lights ahead. I built a Python call-analysis pipeline.',
      source: 'answer',
    });
  });

  it('starts for postings at or above the threshold (no dealbreaker) and for interested ones', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const read = form([spec('Email', 'text', { meaning: 'email', required: true })]);
    const high = seedPosting(t.db, read, { now });
    const low = seedPosting(t.db, read, { now });
    const blocked = seedPosting(t.db, read, { now });
    t.db.update(postings).set({ score: 55 }).where(eq(postings.id, low)).run();
    t.db
      .update(postings)
      .set({ dealbreakers: ['outstaffing'] })
      .where(eq(postings.id, blocked))
      .run();
    await start();
    expect(tx((x) => catchUpApplications(x, 80))).toBe(1);
    expect(listApplications(t.db).map((a) => a.postingId)).toEqual([high]);
    // Marking a posting interested starts it whatever its score.
    recordDecision(t.db, (h as PrepareHarness).bus, {
      id: low,
      decision: 'interested',
      reason: null,
      now,
    });
    await settle();
    const apps = listApplications(t.db);
    expect(apps.map((a) => [a.postingId, a.stage])).toEqual([
      [low, 'ready_for_review'],
      [high, 'ready_for_review'],
    ]);
    expect(tx((x) => catchUpApplications(x, 80))).toBe(0);
  });

  it('a question the facts can’t answer waits for the candidate', async () => {
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    seedFacts(t.db, now);
    const pid = seedPosting(
      t.db,
      form([
        spec('Have you previously worked at Acme AI?', 'radio', {
          meaning: 'question',
          required: true,
          options: ['Yes', 'No'],
        }),
      ]),
      { now },
    );
    await start({
      drafts: (qs) => [
        {
          question: qs[0]?.id ?? 'q1',
          status: 'needs_candidate',
          choice: null,
          sentences: [],
          missing: 'Whether you worked at Acme AI before',
          adaptedFrom: null,
        },
      ],
    });
    const id = create(pid);
    await settle();
    const v = view(id);
    expect(v.app.stage).toBe('needs_candidate');
    expect(v.answers[0]).toMatchObject({
      status: 'needs_candidate',
      missing: 'Whether you worked at Acme AI before',
    });
    expect(v.missing[0]).toMatch(/#1 Have you previously worked at Acme AI\?/);
    tx((x) => setFieldValue(x, id, '#1', 'No'));
    expect(view(id).app.stage).toBe('ready_for_review');
    expect(view(id).answers[0]?.overridden).toBe(true);
  });
});
