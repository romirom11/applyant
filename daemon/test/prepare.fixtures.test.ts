// Preparation over the recorded public forms (phase 4 fixtures), with a synthetic candidate:
// the loose spots Read found must not turn into wrong values. Group entries are filled by
// their group, a dialling-code list follows the phone, a "video link" isn't the website,
// fields behind unanswered demographic questions aren't asked, and the question that points
// back at the job description reaches the writer with the posting text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FormRead } from '../src/browser/form-types.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { FORMS_DIR } from './helpers/form-fixtures.ts';

const now = new Date('2026-09-27T10:00:00Z');

function recorded(name: string): FormRead {
  const fixture = JSON.parse(readFileSync(join(FORMS_DIR, name, 'fixture.json'), 'utf8')) as {
    expected: FormRead;
  };
  return fixture.expected;
}

describe('preparing the recorded public forms', () => {
  let t: TempDb;
  let h: PrepareHarness;

  beforeEach(async () => {
    t = tempDb();
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    seedFacts(t.db, now);
    h = await prepareHarness(t, {
      // Every question is left to the candidate: this test is about the standard fields.
      drafts: (qs) =>
        qs.map((q) => ({
          question: q.id,
          status: 'needs_candidate' as const,
          choice: null,
          sentences: [],
          missing: 'test',
          adaptedFrom: null,
        })),
      option: (label, answer, options) => {
        if (/notice|availab/i.test(label)) return options.find((o) => o === answer) ?? null;
        if (/eligible to work in the country you are applying/i.test(label)) {
          return /EU citizen/.test(answer) ? (options.find((o) => /^yes$/i.test(o)) ?? null) : null;
        }
        return null;
      },
    });
  });
  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  const prepare = async (name: string, text?: string) => {
    const pid = seedPosting(t.db, recorded(name), { now, ...(text ? { text } : {}) });
    const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, pid, 'test').app.id);
    await h.worker.idle();
    return applicationView(t.db, id);
  };

  it('Workable: entry fields belong to their group; the "exact phrase" question reaches the writer', async () => {
    const v = await prepare(
      'workable-huggingface',
      'We are hiring. Please start your first written answer with the words "open models forever".',
    );
    const entries = v.fields.filter((f) => f.role === 'entry');
    expect(entries.map((f) => f.label)).toEqual([
      'School',
      'Field of study',
      'Degree',
      'Start date',
      'End date',
      'Title',
      'Company',
      'Industry',
      'Summary',
      'Start date',
      'End date',
      'I currently work here',
    ]);
    // "Start date" was classified as a notice period and "Title" as the current title, but
    // entry fields are never filled one by one from the profile.
    expect(entries.every((f) => f.value === null && !f.active)).toBe(true);
    const byLabel = (label: string) => v.fields.find((f) => f.label === label);
    expect(byLabel('Education')).toMatchObject({ kind: 'group', value: null, missing: false });
    expect(byLabel('Github profile')).toMatchObject({
      value: 'https://github.com/jordan-testperson',
      source: 'profile',
    });
    expect(byLabel('Expected salary')).toMatchObject({
      value: '60000 EUR per year',
      source: 'profile',
    });
    expect(byLabel('Notice period / availability')).toMatchObject({
      value: '1 month',
      source: 'profile',
    });
    // Two fields say "Phone": the dialling-code list follows the phone's code, the text gets it.
    expect(v.fields.find((f) => f.kind === 'combobox' && f.label === 'Phone')?.value).toBe(
      'Greece +30',
    );
    expect(v.fields.find((f) => f.kind === 'text' && f.label === 'Phone')?.value).toBe(
      '+30 210 555 0100',
    );
    expect(byLabel('Resume')).toMatchObject({ value: null, missing: true });
    const writer = h.claude.requests.find((r) => r.role === 'application_writer');
    expect(writer?.prompt).toContain('open models forever');
    expect(writer?.prompt).toMatch(
      /\[q1\] \(choice: "YES" \| "NO", required\) Did you start your first written answer below with the exact phrase[^\n]*\n {2}\(refers back to the job posting/,
    );
    // Required consent radios answer "YES" by approving; the application waits for the rest.
    expect(v.app.stage).toBe('needs_candidate');
  });

  it('Greenhouse: the phone-country list follows the phone code; sponsorship is never borrowed', async () => {
    const v = await prepare('greenhouse-gitlab');
    const byLabel = (label: string) => v.fields.find((f) => f.label === label);
    expect(byLabel('Country')).toMatchObject({ value: 'Greece +30', source: 'profile' });
    expect(byLabel('What is your current country of residence?')).toMatchObject({
      value: 'Greece',
      source: 'profile',
    });
    expect(
      byLabel(
        'Will you now or in the future require sponsorship for a visa to remain in your current location?',
      ),
    ).toMatchObject({ value: null, missing: true });
    // Optional demographic questions stay the candidate's; what they'd reveal isn't asked.
    expect(byLabel('Gender')).toMatchObject({ value: null, missing: false });
    expect(byLabel('Please identify your race')).toMatchObject({ active: false });
  });

  it('Lever: a "video link" is not the website, and fields behind demographic answers are not asked', async () => {
    const v = await prepare('lever-leverdemo');
    const byLabel = (label: string) => v.fields.filter((f) => f.label === label);
    expect(byLabel('Other Website URL')[0]).toMatchObject({ value: 'https://jordan.example.test' });
    expect(byLabel('Video Link URL')[0]).toMatchObject({ value: null, missing: false });
    // Disability "Name"/"Date" appear only once that (optional) question is answered.
    const signature = v.fields.filter((f) => f.condition?.includes('Disability status'));
    expect(signature.map((f) => [f.label, f.active, f.missing])).toEqual([
      ['Name', false, false],
      ['Date', false, false],
    ]);
    expect(byLabel('Current company')[0]).toMatchObject({ value: null, missing: true });
  });

  it('Ashby: nothing from a profile lands in a question', async () => {
    const v = await prepare('ashby-ashby');
    for (const f of v.fields.filter((x) => x.role === 'question')) {
      expect(f.source === 'profile').toBe(false);
    }
    expect(v.fields.find((f) => f.label === 'Name')).toMatchObject({ value: 'Jordan Testperson' });
    expect(
      v.fields.find((f) => f.label === 'Which country do you intend to work from?'),
    ).toMatchObject({
      value: 'Greece',
    });
  });
});
