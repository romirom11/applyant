// The tailored CV as a PDF: the plan and the profile header become semantic HTML (stable class
// names), the candidate's template wraps it, and Chrome prints it. Printing goes through the
// reader pool's headless shell: the headed Patchright submission profile can't print to PDF.
//
// A template is a directory with `index.html` (holding {{title}}, {{style}} and {{cv}}) and
// `style.css`. `$APPLYANT_HOME/cv-template/` replaces the bundled "Clean" one when it exists.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReaderPool } from '../../../browser/reader-pool.ts';
import type { CvPlan } from '../../../db/schema.ts';
import type { StandardProfile } from '../../knowledge/profile.ts';
import { periodEnd, projectKind } from '../../knowledge/project-kind.ts';

export const BUNDLED_TEMPLATE = fileURLToPath(new URL('./templates/clean/', import.meta.url));

export interface CvTemplate {
  html: string;
  css: string;
}

/** The candidate's template when `dir` has one, else the bundled "Clean". */
export function loadTemplate(dir: string | null): CvTemplate {
  // A custom folder without a usable index.html falls back to "Clean" (Settings says why).
  const usable =
    dir &&
    existsSync(join(dir, 'index.html')) &&
    readFileSync(join(dir, 'index.html'), 'utf8').includes('{{cv}}');
  const root = usable ? dir : BUNDLED_TEMPLATE;
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  if (!html.includes('{{cv}}')) throw new Error(`${join(root, 'index.html')} has no {{cv}}`);
  const cssPath = join(root, 'style.css');
  return { html, css: existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '' };
}

/** What the header shows: the candidate's own profile values, nothing else. */
export interface CvHeader {
  name: string;
  headline: string | null;
  contact: Array<{ text: string; href: string | null }>;
}

export function cvHeader(p: StandardProfile): CvHeader | null {
  if (!p.full_name) return null;
  const contact: CvHeader['contact'] = [];
  if (p.email) contact.push({ text: p.email, href: `mailto:${p.email}` });
  if (p.phone) contact.push({ text: p.phone, href: null });
  if (p.location) contact.push({ text: p.location, href: null });
  for (const key of ['links.github', 'links.linkedin', 'links.website'] as const) {
    const url = p[key];
    if (url)
      contact.push({ text: url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), href: url });
  }
  return { name: p.full_name, headline: p.current_title, contact };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "Head of IT · KILOGRAMM LLC" for a job whose name is only the employer. */
function heading(p: CvPlan['projects'][number], kind: 'position' | 'project'): string {
  const role = p.role?.trim();
  if (kind !== 'position' || !role || p.name.toLowerCase().includes(role.toLowerCase())) {
    return p.name;
  }
  return `${role} · ${p.name}`;
}

export function cvBody(plan: CvPlan, header: CvHeader): string {
  const out: string[] = [];
  const contact = header.contact
    .map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.text)}</a>` : esc(c.text)))
    .join(' · ');
  out.push(
    '<header class="cv-header">',
    `<h1 class="cv-name">${esc(header.name)}</h1>`,
    header.headline ? `<p class="cv-headline">${esc(header.headline)}</p>` : '',
    contact ? `<p class="cv-contact">${contact}</p>` : '',
    '</header>',
  );
  if (plan.summary.length) {
    out.push(
      '<section class="cv-section cv-summary">',
      `<p>${plan.summary.map((l) => esc(l.text)).join(' ')}</p>`,
      '</section>',
    );
  }
  const shown = plan.projects.filter((p) => p.bullets.length);
  const kindOf = (p: CvPlan['projects'][number]) =>
    p.kind ?? projectKind({ name: p.name, role: null, period: p.period });
  // Jobs newest first (a CV reads backwards in time); built projects in the writer's order.
  const jobs = shown
    .filter((p) => kindOf(p) === 'position')
    .map((p, i) => ({ p, i, end: periodEnd(p.period) }))
    .sort((a, b) => (b.end ?? -1) - (a.end ?? -1) || a.i - b.i)
    .map((x) => x.p);
  const built = shown.filter((p) => kindOf(p) === 'project');
  const section = (cls: string, title: string, list: typeof shown) => {
    if (!list.length) return;
    out.push(`<section class="cv-section ${cls}">`, `<h2>${title}</h2>`);
    for (const p of list) {
      out.push(
        '<article class="cv-project">',
        '<div class="cv-project-head">',
        `<h3>${esc(heading(p, kindOf(p)))}</h3>`,
        p.period ? `<span class="cv-period">${esc(p.period)}</span>` : '',
        '</div>',
        '<ul class="cv-bullets">',
        ...p.bullets.map((b) => `<li>${esc(b.text)}</li>`),
        '</ul>',
        '</article>',
      );
    }
    out.push('</section>');
  };
  section('cv-experience', 'Experience', jobs);
  section('cv-projects', 'Projects', built);
  if (plan.education.length) {
    out.push(
      '<section class="cv-section cv-education">',
      '<h2>Education</h2>',
      '<ul>',
      ...plan.education.map((l) => `<li>${esc(l.text)}</li>`),
      '</ul>',
      '</section>',
    );
  }
  if (plan.skills.length) {
    out.push(
      '<section class="cv-section cv-skills">',
      '<h2>Skills</h2>',
      `<p>${plan.skills.map(esc).join(' · ')}</p>`,
      '</section>',
    );
  }
  return out.filter(Boolean).join('\n');
}

export function cvHtml(plan: CvPlan, header: CvHeader, template: CvTemplate): string {
  // Function replacements: a `$` in the candidate's text is never a replacement pattern.
  return template.html
    .replace('{{title}}', () => esc(`${header.name}: CV`))
    .replace('{{style}}', () => template.css)
    .replace('{{cv}}', () => cvBody(plan, header));
}

/** Prints the HTML to an A4 PDF in a throwaway headless context (no network: it's inline). */
export async function renderPdf(
  reader: Pick<ReaderPool, 'withPage'>,
  html: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return reader.withPage(
    async (page) => {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      return page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    },
    signal ? { signal } : {},
  );
}

/**
 * Stores the PDF under `dir` as `<application>-<hash>.pdf`: a new render never overwrites the
 * file an earlier review (or a receipt) pointed at.
 */
export function storePdf(
  dir: string,
  applicationId: number,
  pdf: Buffer,
): { path: string; hash: string } {
  const hash = createHash('sha256').update(pdf).digest('hex');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${applicationId}-${hash.slice(0, 12)}.pdf`);
  if (!existsSync(path)) writeFileSync(path, pdf);
  return { path, hash };
}
