// verify_posting: open the posting in the headless reader and decide, without any model,
// whether it is live and has a real way to apply.
//
//   HTTP status          404/410/other 4xx → dead · 429/5xx/network → retry
//   redirect             job page → site root → dead
//   JSON-LD JobPosting   validThrough in the past → dead
//   page text            "no longer accepting applications" and similar → dead
//   apply path           application form (any frame) · mailto · apply link/button
//                        apply link that lands on the homepage → dead
import { eq } from 'drizzle-orm';
import type { Frame, Page } from 'playwright';
import type { ReaderPool } from '../../browser/reader-pool.ts';
import { postings } from '../../db/schema.ts';
import type { Handler, Outcome } from '../../queue/types.ts';

export type Verdict =
  | { kind: 'live'; note: string; title: string | null; company: string | null }
  | { kind: 'dead'; note: string; title: string | null; company: string | null }
  | { kind: 'transient'; note: string };

/** Network-level failures are retried this many times before the posting is failed. */
export const VERIFY_NETWORK_ATTEMPTS = 3;

export const verifyPosting: Handler<'verify_posting'> = async (task, ctx) => {
  const posting = ctx.read.select().from(postings).where(eq(postings.id, task.entityId)).get();
  if (!posting) return { kind: 'done', commit: () => {} };

  ctx.progress({ message: `opening ${posting.canonicalUrl}` });
  let verdict: Verdict;
  try {
    verdict = await checkPosting(ctx.deps.reader, posting.canonicalUrl, {
      signal: ctx.signal,
      now: ctx.now(),
    });
  } catch (err) {
    ctx.signal.throwIfAborted();
    verdict = { kind: 'transient', note: navigationError(err) };
  }

  if (verdict.kind === 'transient') {
    if (task.attempts + 1 < VERIFY_NETWORK_ATTEMPTS) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason: verdict.note,
      };
    }
    verdict = {
      kind: 'dead',
      note: `unreachable after ${task.attempts + 1} attempts: ${verdict.note}`,
      title: null,
      company: null,
    };
  }

  const result = verdict;
  const stage = result.kind === 'live' ? 'verified' : 'failed_verification';
  const outcome: Outcome = {
    kind: 'done',
    commit: (tx) => {
      tx.db
        .update(postings)
        .set({
          stage,
          verifiedAt: tx.now,
          verifyNote: result.note,
          title: posting.title ?? result.title,
          company: posting.company ?? result.company,
        })
        .where(eq(postings.id, posting.id))
        .run();
      tx.emit({ kind: 'posting.stage', postingId: posting.id, stage, message: result.note });
    },
  };
  return outcome;
};

export interface CheckOptions {
  signal?: AbortSignal;
  now?: Date;
}

export async function checkPosting(
  reader: ReaderPool,
  url: string,
  opts: CheckOptions = {},
): Promise<Verdict> {
  const now = opts.now ?? new Date();
  return reader.withPage(
    async (page) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = response?.status() ?? 200;
      if (status === 429 || status >= 500) return { kind: 'transient', note: `HTTP ${status}` };
      if (status >= 400)
        return { kind: 'dead', note: `HTTP ${status}`, title: null, company: null };
      await settle(page);

      const finalUrl = page.url();
      if (redirectedUp(url, finalUrl)) {
        const where = isRoot(finalUrl) ? 'the homepage ' : '';
        return {
          kind: 'dead',
          note: `redirected to ${where}${finalUrl}`,
          title: null,
          company: null,
        };
      }

      const meta = await readMeta(page);
      const job = findJobPosting(meta.jsonLd);
      const title = job?.title ?? meta.ogTitle ?? meta.title;
      const company = job?.company ?? meta.siteName;

      if (job?.validThrough) {
        const until = new Date(job.validThrough);
        if (!Number.isNaN(until.getTime()) && until.getTime() < now.getTime()) {
          return {
            kind: 'dead',
            note: `JobPosting validThrough ${job.validThrough} has passed`,
            title,
            company,
          };
        }
      }

      const closed = closedMarker(meta.text);
      if (closed) return { kind: 'dead', note: `page says "${closed}"`, title, company };

      const apply = await findApplyPath(page, opts.signal);
      return apply.ok
        ? { kind: 'live', note: apply.note, title, company }
        : { kind: 'dead', note: apply.note, title, company };
    },
    { signal: opts.signal },
  );
}

/** Give client-rendered pages (Ashby, React career sites) a moment to render. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * True when a page redirected to one of its ancestors (a job page to its board or the
 * site root), which is how most boards say a posting is gone.
 */
export function redirectedUp(requested: string, landed: string): boolean {
  const from = pathSegments(requested);
  const to = pathSegments(landed);
  if (!from || !to || to.length >= from.length) return false;
  return to.every((segment, i) => segment === from[i]);
}

function isRoot(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === '/' || u.pathname === '') && u.search === '';
  } catch {
    return false;
  }
}

interface PageMeta {
  jsonLd: string[];
  title: string | null;
  ogTitle: string | null;
  siteName: string | null;
  text: string;
}

async function readMeta(page: Page): Promise<PageMeta> {
  return page.evaluate(() => {
    const attr = (sel: string) =>
      document.querySelector(sel)?.getAttribute('content')?.trim() || null;
    return {
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
        (s) => s.textContent ?? '',
      ),
      title: document.title.trim() || null,
      ogTitle: attr('meta[property="og:title"]'),
      siteName: attr('meta[property="og:site_name"]'),
      text: (document.body?.innerText ?? '').slice(0, 50_000),
    };
  });
}

export interface JobPostingLd {
  title: string | null;
  company: string | null;
  validThrough: string | null;
}

/** Finds the first schema.org JobPosting in a page's JSON-LD blocks (arrays and @graph included). */
export function findJobPosting(blocks: string[]): JobPostingLd | null {
  const visit = (node: unknown): JobPostingLd | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('JobPosting')) {
      const org = obj.hiringOrganization;
      const company =
        typeof org === 'string'
          ? org
          : org && typeof org === 'object' && typeof (org as { name?: unknown }).name === 'string'
            ? (org as { name: string }).name
            : null;
      return {
        title: typeof obj.title === 'string' ? obj.title.trim() : null,
        company: company?.trim() || null,
        validThrough: typeof obj.validThrough === 'string' ? obj.validThrough : null,
      };
    }
    return visit(obj['@graph']);
  };
  for (const block of blocks) {
    try {
      const found = visit(JSON.parse(block));
      if (found) return found;
    } catch {
      // Malformed JSON-LD is common; ignore the block.
    }
  }
  return null;
}

const CLOSED_MARKERS = [
  'no longer accepting applications',
  'not accepting applications',
  'job you are looking for is no longer open',
  'job is no longer open',
  'position is no longer open',
  'job is no longer available',
  'position is no longer available',
  'posting is no longer available',
  'job is no longer active',
  'position has been filled',
  'role has been filled',
  'job has expired',
  'job posting has expired',
  'this job has been closed',
  'this position has been closed',
  'this job is closed',
  'this position is closed',
  'stelle ist nicht mehr verfügbar',
  'stellenanzeige ist nicht mehr verfügbar',
];

export function closedMarker(text: string): string | null {
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  return CLOSED_MARKERS.find((m) => lower.includes(m)) ?? null;
}

const APPLY_NAME =
  /(^|[\s"'«(])(apply|bewerben|postuler|candidatar|candidatura|aplicar|solliciteren|откликнуться|відгукнутися|подати заявку)/i;

/** A page with this many different apply targets on its own host is a job list. */
const LIST_THRESHOLD = 3;

interface ApplyPath {
  ok: boolean;
  note: string;
}

interface ApplyControl {
  href: string | null;
  frameUrl: string;
}

async function findApplyPath(page: Page, signal?: AbortSignal): Promise<ApplyPath> {
  for (const frame of page.frames()) {
    if (await hasApplicationForm(frame)) {
      return {
        ok: true,
        note:
          frame === page.mainFrame() ? 'apply form on page' : `apply form in frame ${frame.url()}`,
      };
    }
  }

  const controls: ApplyControl[] = [];
  for (const frame of page.frames()) controls.push(...(await applyControls(frame)));
  if (controls.length === 0) return { ok: false, note: 'no apply link or form found' };

  const mail = controls.find((c) => c.href?.startsWith('mailto:'));
  if (mail?.href) {
    return { ok: true, note: `apply by email to ${mail.href.slice(7).split('?')[0]}` };
  }

  const here = stripHash(page.url());
  const host = new URL(here).host;
  const sameHostTargets = new Set(
    controls
      .map((c) => c.href && stripHash(c.href))
      .filter(
        (h): h is string => !!h && /^https?:/.test(h) && h !== here && new URL(h).host === host,
      ),
  );
  if (sameHostTargets.size >= LIST_THRESHOLD) {
    return {
      ok: false,
      note: `looks like a list of jobs (${sameHostTargets.size} apply links), not one posting`,
    };
  }

  const link = controls.find(
    (c) => c.href && /^https?:/.test(c.href) && stripHash(c.href) !== here,
  );
  if (!link?.href) return { ok: true, note: 'apply button on page' };

  if (isRoot(link.href)) {
    return { ok: false, note: `apply link leads to the homepage ${link.href}` };
  }

  signal?.throwIfAborted();
  const target = await page.context().newPage();
  try {
    const response = await target.goto(link.href, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 200;
    if (status >= 400) return { ok: false, note: `apply link ${link.href} returns HTTP ${status}` };
    await settle(target);
    const landed = target.url();
    if (isRoot(landed)) {
      return { ok: false, note: `apply link redirects to the homepage ${landed}` };
    }
    for (const frame of target.frames()) {
      if (await hasApplicationForm(frame)) return { ok: true, note: `apply form at ${landed}` };
    }
    return { ok: true, note: `apply link to ${landed}` };
  } catch (err) {
    signal?.throwIfAborted();
    return { ok: true, note: `apply link to ${link.href} (not opened: ${navigationError(err)})` };
  } finally {
    await target.close().catch(() => {});
  }
}

/** A file upload, or an email field among at least three fillable controls. */
async function hasApplicationForm(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(() => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return style.visibility !== 'hidden' && style.display !== 'none' && r.width + r.height > 0;
      };
      const fillable = [
        ...document.querySelectorAll(
          'input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], input[type=file], textarea, select',
        ),
      ].filter((el) => !el.closest('[role=search]'));
      // File inputs are often visually hidden behind a styled button.
      const hasFile = fillable.some((el) => (el as HTMLInputElement).type === 'file');
      const shown = fillable.filter(
        (el) => visible(el) || (el as HTMLInputElement).type === 'file',
      );
      const hasEmail = shown.some((el) => {
        const input = el as HTMLInputElement;
        return (
          input.type === 'email' ||
          /email/i.test(input.name ?? '') ||
          /email/i.test(input.id ?? '') ||
          input.autocomplete === 'email'
        );
      });
      return hasFile || (hasEmail && shown.length >= 3);
    })
    .catch(() => false);
}

async function applyControls(frame: Frame): Promise<ApplyControl[]> {
  const found = await frame
    .evaluate((pattern) => {
      const re = new RegExp(pattern, 'i');
      const out: Array<{ href: string | null }> = [];
      for (const el of document.querySelectorAll('a, button, [role=button], input[type=submit]')) {
        const name =
          (el as HTMLElement).innerText?.trim() ||
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).value ||
          el.getAttribute('title') ||
          '';
        if (!re.test(name.slice(0, 80))) continue;
        const href = el instanceof HTMLAnchorElement ? el.href : null;
        out.push({ href: href && !href.startsWith('javascript:') ? href : null });
      }
      return out;
    }, APPLY_NAME.source)
    .catch(() => [] as Array<{ href: string | null }>);
  return found.map((c) => ({ ...c, frameUrl: frame.url() }));
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function navigationError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}
