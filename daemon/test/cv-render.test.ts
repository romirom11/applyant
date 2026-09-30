// The tailored CV prints to a real PDF (headless shell, like production) whose text holds the
// plan's lines in order, escaped; the candidate's own template replaces the bundled one.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import type { CvPlan } from '../src/db/schema.ts';
import {
  cvBody,
  cvHeader,
  cvHtml,
  loadTemplate,
  renderPdf,
  storePdf,
} from '../src/domain/applications/cv/render.ts';
import type { StandardProfile } from '../src/domain/knowledge/profile.ts';
import { pdfToText } from '../src/domain/knowledge/text/pdf.ts';
import { SYNTHETIC_PROFILE } from './helpers/applications.ts';
import { quietLog } from './helpers/deps.ts';

const profile = {
  ...Object.fromEntries(Object.keys(SYNTHETIC_PROFILE).map((k) => [k, null])),
  ...SYNTHETIC_PROFILE,
  current_title: 'Backend & AI Engineer',
  base_cv_file: null,
} as StandardProfile;

const plan: CvPlan = {
  summary: [
    { text: 'Engineer who builds Python call-analysis pipelines.', factIds: [1] },
    { text: 'Maintains an open-source audio library.', factIds: [2] },
  ],
  projects: [
    {
      slug: 'harbor',
      name: 'Harbor',
      period: '2021–2024',
      bullets: [
        { text: 'Built the Python call-analysis pipeline that scores support calls', factIds: [1] },
        { text: 'Cut review time with <automatic> transcripts & summaries', factIds: [3] },
      ],
    },
    {
      slug: 'lantern',
      name: 'Lantern',
      period: null,
      bullets: [{ text: 'Wrote a $5 price tracker', factIds: [4] }],
    },
  ],
  education: [{ text: 'BSc in Computer Science, Example University', factIds: [5] }],
  skills: ['Python', 'PostgreSQL'],
  dropped: [{ section: 'harbor', text: 'Led a team of 10', factIds: [6], reason: 'overstated' }],
};

describe('tailored CV rendering', () => {
  let reader: ReaderPool;
  let dir: string;
  beforeAll(() => {
    reader = new ReaderPool({ maxContexts: 1, navigationTimeoutMs: 15_000, log: quietLog });
    dir = mkdtempSync(join(tmpdir(), 'applyant-cv-'));
  });
  afterAll(async () => {
    await reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the header is only the profile’s own values, and needs a name', () => {
    const h = cvHeader(profile);
    expect(h?.name).toBe('Jordan Testperson');
    expect(h?.headline).toBe('Backend & AI Engineer');
    expect(h?.contact.map((c) => c.text)).toEqual([
      'jordan.testperson@example.test',
      '+30 210 555 0100',
      'Thessaloniki, Greece',
      'github.com/jordan-testperson',
      'linkedin.com/in/jordan-testperson',
      'jordan.example.test',
    ]);
    expect(cvHeader({ ...profile, full_name: null })).toBeNull();
  });

  it('escapes the text, keeps dropped lines out, and leaves no placeholder behind', () => {
    const header = cvHeader(profile);
    if (!header) throw new Error('no header');
    const body = cvBody(plan, header);
    expect(body).toContain('&lt;automatic&gt; transcripts &amp; summaries');
    expect(body).not.toContain('Led a team of 10');
    const html = cvHtml(plan, header, loadTemplate(null));
    expect(html).toContain('Wrote a $5 price tracker');
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  it('prints an A4 PDF whose text has every line of the plan, in order', async () => {
    const header = cvHeader(profile);
    if (!header) throw new Error('no header');
    const pdf = await renderPdf(reader, cvHtml(plan, header, loadTemplate(null)));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = (await pdfToText(pdf)).pages.join('\n').replace(/\s+/g, ' ');
    const order = [
      'Jordan Testperson',
      'Engineer who builds Python call-analysis pipelines.',
      'Harbor',
      'Built the Python call-analysis pipeline that scores support calls',
      'Cut review time with <automatic> transcripts & summaries',
      'Lantern',
      'Wrote a $5 price tracker',
      'BSc in Computer Science, Example University',
      'Python · PostgreSQL',
    ];
    let at = -1;
    for (const want of order) {
      const i = text.indexOf(want);
      expect(i, `"${want}" in the PDF text`).toBeGreaterThan(at);
      at = i;
    }
    expect(text).not.toContain('Led a team of 10');

    // Stored by hash: the same PDF is the same file; a new render is a new one.
    const a = storePdf(join(dir, 'cv'), 7, pdf);
    expect(a.path).toBe(join(dir, 'cv', `7-${a.hash.slice(0, 12)}.pdf`));
    expect(readFileSync(a.path).equals(pdf)).toBe(true);
    expect(storePdf(join(dir, 'cv'), 7, pdf).path).toBe(a.path);
    expect(storePdf(join(dir, 'cv'), 7, Buffer.concat([pdf, Buffer.from('\n')])).path).not.toBe(
      a.path,
    );
  });

  it("uses the candidate's template when there is one", async () => {
    const mine = join(dir, 'cv-template');
    mkdirSync(mine, { recursive: true });
    writeFileSync(
      join(mine, 'index.html'),
      '<!doctype html><html><head><style>{{style}}</style></head><body><p>MY TEMPLATE</p>{{cv}}</body></html>',
    );
    writeFileSync(join(mine, 'style.css'), 'body { font-family: serif; }');
    const t = loadTemplate(mine);
    expect(t.css).toContain('serif');
    const header = cvHeader(profile);
    if (!header) throw new Error('no header');
    const text = (await pdfToText(await renderPdf(reader, cvHtml(plan, header, t)))).pages.join(
      ' ',
    );
    expect(text).toContain('MY TEMPLATE');
    expect(text).toContain('Jordan Testperson');
    // No template there: the bundled one.
    expect(loadTemplate(join(dir, 'nothing-here')).html).toContain('{{cv}}');
    writeFileSync(join(mine, 'index.html'), '<html><body>no slot</body></html>');
    // A custom one without {{cv}} falls back to the bundled one (Settings → CV template says why).
    expect(loadTemplate(mine).html).toContain('{{cv}}');
    expect(loadTemplate(mine).html).not.toContain('no slot');
  });
});
