// Cross-checks recorded reads against what the ATS itself says about the form. The reader
// stays generic (TDD: no per-ATS form adapters); the ATS definitions are used only here, as
// ground truth, to catch fields and required flags the generic scan gets wrong.
//
//   Workable  apply.workable.com/api/v1/jobs/81B46579FE/form, saved as ats-form.json next to
//             the recording: every field, its required flag, and the repeatable groups
//   Lever     the apply page's own `required` attributes (name, email, phone, org), and its
//             disability signature, which the page requires only once that question is answered
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FieldSpec, FormRead } from '../src/browser/form-types.ts';
import { refKey } from '../src/browser/form-types.ts';
import { listFixtures, replayDecide, replayFixture } from './helpers/form-fixtures.ts';
import { allFields, runRead } from './helpers/form-read.ts';

vi.setConfig({ testTimeout: 180_000 });

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

function fixture(name: string) {
  const f = listFixtures().find((x) => x.fixture.name === name);
  if (!f) throw new Error(`no recorded fixture ${name}`);
  return f;
}

const norm = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .toLowerCase()
    .slice(0, 60);

interface AtsField {
  id: string;
  label: string | null;
  type: string;
  required: boolean;
  fields?: AtsField[];
}

describe('Workable: the read agrees with the form API', () => {
  const { dir, fixture: fx } = fixture('workable-huggingface');
  const api = (
    JSON.parse(readFileSync(join(dir, 'ats-form.json'), 'utf8')) as Array<{ fields: AtsField[] }>
  ).flatMap((section) => section.fields);
  let read: FormRead;
  beforeAll(async () => {
    const replay = await replayFixture(browser, dir, fx);
    expect(replay.misses).toEqual([]);
    read = replay.read;
  });

  const top = (): FieldSpec[] => allFields(read).filter((f) => f.revealedBy?.value !== 'add');
  const find = (a: AtsField, among: FieldSpec[]): FieldSpec[] => {
    // The GDPR consent has no label in the API; on the page it's the privacy-notice checkbox.
    if (a.id === 'gdpr') return among.filter((f) => /privacy notice/i.test(f.label));
    return among.filter((f) => norm(f.label) === norm(a.label ?? ''));
  };

  it("every API field is read, with the API's required flag", () => {
    for (const a of api) {
      const found = find(a, top());
      expect(found.length, `${a.id} "${a.label}"`).toBeGreaterThan(0);
      for (const f of found) expect(f.required, `${a.id} "${a.label}" required`).toBe(a.required);
    }
  });

  it('the required consent is a required checkbox (its * is drawn by CSS on a custom control)', () => {
    const [consent] = find({ id: 'gdpr', label: null, type: 'boolean', required: true }, top());
    expect(consent).toMatchObject({ kind: 'checkbox', required: true, meaning: 'consent' });
    expect(consent?.ref).toMatchObject({ role: 'checkbox', css: null });
  });

  it('repeatable groups are read with the fields of one entry', () => {
    for (const a of api.filter((x) => x.type === 'group')) {
      const [group] = find(a, top());
      expect(group).toMatchObject({ kind: 'group', required: a.required, revealedBy: null });
      if (!group) continue;
      const entry = allFields(read).filter(
        (f) => f.revealedBy?.value === 'add' && refKey(f.revealedBy.ref) === refKey(group.ref),
      );
      expect(entry.map((f) => [norm(f.label), f.required])).toEqual(
        (a.fields ?? []).map((s) => [norm(s.label ?? ''), s.required]),
      );
    }
  });

  it('flags the question that points back at the job description', () => {
    expect(read.notes).toContainEqual(
      expect.stringMatching(
        /^refers back to the job description: "Did you start your first written answer/,
      ),
    );
  });
});

describe('Lever: required only where the page requires it', () => {
  it('always-required fields match the page, and the signature is required only on its branch', async () => {
    const { dir, fixture: fx } = fixture('lever-leverdemo');
    const misses: string[] = [];
    const run = await runRead(browser, fx.url, {
      profile: fx.profile,
      decide: replayDecide(fx.decisions, misses),
      prepare: async (context) => {
        await context.routeFromHAR(join(dir, 'page.har.zip'), { notFound: 'abort' });
      },
    });
    try {
      expect(misses).toEqual([]);
      const fields = allFields(run.read);
      // The page's `required` attributes: name, email, phone, org.
      expect(fields.filter((f) => f.required && !f.revealedBy).map((f) => f.label)).toEqual([
        'Full name',
        'Email',
        'Phone',
        'Current company',
      ]);
      const disability = fields.find((f) => f.label === 'Disability status');
      expect(disability).toMatchObject({ required: false, revealedBy: null });
      for (const label of ['Name', 'Date']) {
        expect(fields.find((f) => f.label === label)).toMatchObject({
          required: true,
          revealedBy: { ref: disability?.ref, value: '*' },
        });
      }
      // …which is what the page itself says once Disability status is answered.
      const required = await run.page
        .locator('#disabilitySignatureSection input')
        .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).required));
      expect(required).toEqual([true, true]);
    } finally {
      await run.close();
    }
  });
});
