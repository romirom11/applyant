// Read mode: what does this application form ask for, including its later steps?
//
//   open         the apply target; when it shows no form, follow its Apply link or button
//   per step     snapshot → field_classify → dry-fill (profile values for standard fields,
//                placeholders for questions, each option of small choice fields tried) →
//                pickAdvance. A final advance control is never pressed: Read stops there.
//                A non-final one ("Next", "Save and continue") is pressed to reach the next step.
//
// Read never sends anything: guardReadOnly() aborts every request that could write (any
// non-GET except GraphQL queries), so neither a mistaken submit nor an upload nor a wizard's
// draft-save reaches the employer. Placeholder files are uploaded only on non-final steps, and
// the candidate's own CV never is.
import type { BrowserContext, Page, Route } from 'playwright';
import {
  advanceDeterministic,
  type FillValue,
  fillStep,
  pickAdvance,
  waitForForm,
} from './form-engine.ts';
import type { FieldSpec, FormRead, FormStep } from './form-types.ts';
import { type SnapField, snapshotForm } from './snapshot.ts';

export interface ReadJudge {
  /** Sets `meaning` on each field (field_classify). */
  classify(fields: SnapField[]): Promise<void>;
  /** The dry-fill value for a field; undefined leaves it empty. */
  value(field: SnapField, step: { isFinal: boolean }): Promise<FillValue | undefined>;
}

export interface ReadFormOptions {
  url: string;
  judge: ReadJudge;
  signal?: AbortSignal;
  progress?(message: string): void;
  maxSteps?: number;
  /** Choice fields with at most this many options have every option tried. */
  exploreMaxOptions?: number;
  /** Total option tries per step. */
  exploreBudget?: number;
}

export type ReadFormResult =
  | { kind: 'form'; read: FormRead }
  | { kind: 'no_form'; note: string; url: string };

// ---- the read-only guard ------------------------------------------------------------------

const HEAVY = new Set(['image', 'media', 'font']);

/** A GraphQL request that only reads (Ashby loads its job board this way). */
export function isGraphqlQuery(body: string | null): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    const ops = Array.isArray(parsed) ? parsed : [parsed];
    return ops.every((op) => {
      const q = (op as { query?: unknown })?.query;
      return typeof q === 'string' && /^\s*(query\b|\{)/.test(q.replace(/^\s*#.*$/gm, ''));
    });
  } catch {
    return false;
  }
}

export interface ReadGuard {
  /** Requests aborted because they could have written something. */
  blocked: string[];
}

/**
 * Aborts every request that could send data (POST/PUT/PATCH/DELETE other than GraphQL
 * queries) and heavy resources Read doesn't need. Registered last, so it runs before any
 * other route (e.g. routeFromHAR) and falls back to it.
 */
export async function guardReadOnly(context: BrowserContext): Promise<ReadGuard> {
  const guard: ReadGuard = { blocked: [] };
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (!(method === 'POST' && isGraphqlQuery(req.postData()))) {
        guard.blocked.push(`${method} ${req.url().split('?')[0]}`);
        return route.abort('blockedbyclient');
      }
    }
    if (HEAVY.has(req.resourceType())) return route.abort('blockedbyclient');
    return route.fallback();
  });
  return guard;
}

// ---- opening the form ---------------------------------------------------------------------

const APPLY =
  /(^|[\s"'«(])(apply|bewerben|postuler|candidatar|candidatura|aplicar|solliciteren|откликнуться|відгукнутися|подати заявку)/i;
const NOT_APPLY = /linkedin|indeed|seek|with google|later|save|share|similar|refer/i;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

const CONSENT_ZONE =
  '#onetrust-consent-sdk, #CybotCookiebotDialog, [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i], [role=dialog], [aria-modal=true]';
const DECLINE =
  /^(decline|reject|deny|refuse)( all| optional( cookies)?)?$|only (necessary|essential)|necessary only|use necessary/i;
const ACCEPT = /^(accept|allow|agree|ok|got it)( all( cookies)?)?$/i;

/**
 * Closes a cookie banner that would block clicks: declines where it can (consent requests
 * are blocked by the guard anyway, so this only changes what the page shows).
 */
export async function dismissConsent(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    const zones = frame
      .locator(CONSENT_ZONE)
      .filter({ hasText: /cookie/i })
      .filter({ visible: true });
    if ((await zones.count().catch(() => 0)) === 0) continue;
    for (const pattern of [DECLINE, ACCEPT]) {
      const button = zones.getByRole('button', { name: pattern }).filter({ visible: true }).first();
      if ((await button.count().catch(() => 0)) === 0) continue;
      await button.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      return;
    }
  }
}

/** Follows the page's Apply link or button (not one inside a form). True if a form showed. */
async function followApply(page: Page, signal?: AbortSignal): Promise<boolean> {
  for (const frame of page.frames()) {
    const controls = frame
      .locator('a, button, [role=button]')
      .filter({ hasText: APPLY })
      .filter({ visible: true });
    const n = Math.min(await controls.count().catch(() => 0), 10);
    for (let i = 0; i < n; i++) {
      signal?.throwIfAborted();
      const c = controls.nth(i);
      const info = await c
        .evaluate((el) => ({
          text: (el as HTMLElement).innerText?.trim().slice(0, 80) ?? '',
          href: el instanceof HTMLAnchorElement ? el.href : null,
          inForm: !!el.closest('form'),
          submit: (el as HTMLButtonElement).type === 'submit',
        }))
        .catch(() => null);
      if (!info || info.inForm || info.submit || NOT_APPLY.test(info.text)) continue;
      if (info.href && /^https?:/.test(info.href) && !info.href.startsWith('mailto:')) {
        await page.goto(info.href, { waitUntil: 'domcontentloaded' });
      } else {
        const popup = page
          .context()
          .waitForEvent('page', { timeout: 2500 })
          .catch(() => null);
        await c.click({ timeout: 4000 }).catch(() => {});
        const opened = await popup;
        if (opened) {
          await opened.waitForLoadState('domcontentloaded').catch(() => {});
          await page.goto(opened.url(), { waitUntil: 'domcontentloaded' }).catch(() => {});
          await opened.close().catch(() => {});
        }
      }
      await settle(page);
      if (await waitForForm(page, 10_000)) return true;
      return false;
    }
  }
  return false;
}

// ---- reading ------------------------------------------------------------------------------

function toSpec(f: SnapField): FieldSpec {
  return {
    ref: f.ref,
    label: f.label,
    kind: f.kind,
    required: f.required,
    options: f.options,
    meaning: f.meaning,
    revealedBy: f.revealedBy,
  };
}

export async function readForm(page: Page, o: ReadFormOptions): Promise<ReadFormResult> {
  const notes: string[] = [];
  o.progress?.(`opening ${o.url}`);
  const res = await page.goto(o.url, { waitUntil: 'domcontentloaded' });
  const status = res?.status() ?? 200;
  if (status >= 400) return { kind: 'no_form', note: `HTTP ${status}`, url: page.url() };
  await settle(page);
  await dismissConsent(page);
  let found = await waitForForm(page, 10_000);
  if (!found) found = await followApply(page, o.signal);
  if (!found) return { kind: 'no_form', note: 'no application form found', url: page.url() };
  await dismissConsent(page);
  const url = page.url();
  const first = await snapshotForm(page);
  if (first?.signIn && first.fields.length <= 3) {
    return { kind: 'no_form', note: 'the apply page asks you to sign in first', url };
  }

  const steps: FormStep[] = [];
  const maxSteps = o.maxSteps ?? 8;
  for (let i = 0; i < maxSteps; i++) {
    o.signal?.throwIfAborted();
    const snap = await snapshotForm(page);
    if (!snap) {
      notes.push(`step ${i + 1}: the form disappeared`);
      break;
    }
    const advance = pickAdvance(snap.buttons);
    o.progress?.(`step ${i + 1}: ${snap.fields.length} fields`);
    const result = await fillStep(page, {
      mode: 'read',
      value: (field) => o.judge.value(field, { isFinal: advance.isFinal }),
      classify: (fields) => o.judge.classify(fields),
      explore: { maxOptions: o.exploreMaxOptions ?? 6, budget: o.exploreBudget ?? 40 },
      notes,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.progress ? { progress: o.progress } : {}),
    });
    const fields = result.fields.map(toSpec);
    // The advance control may have changed while filling (e.g. "Next" once answers are valid).
    const latest = result.kind === 'filled' ? pickAdvance(result.snapshot.buttons) : advance;
    const step: FormStep = { fields, advance: latest.ref, isFinal: latest.isFinal };
    steps.push(step);
    if (latest.isFinal || !latest.ref) break;
    o.progress?.(`step ${i + 1}: pressing "${latest.text}"`);
    const moved = await advanceDeterministic(page, latest, o.signal ? { signal: o.signal } : {});
    if (moved.kind === 'stuck') {
      notes.push(
        `step ${i + 1}: "${latest.text}" didn't lead to another step${
          moved.errors.length ? ` (${moved.errors.slice(0, 3).join(' · ')})` : ''
        }`,
      );
      break;
    }
    if (i === maxSteps - 1) notes.push(`stopped after ${maxSteps} steps`);
  }
  for (const f of steps.flatMap((st) => st.fields)) {
    if (POINTS_BACK.test(f.label)) {
      notes.push(`refers back to the job description: "${f.label.slice(0, 160)}"`);
    }
  }
  return { kind: 'form', read: { url, requirements: { steps }, notes } };
}

/**
 * Questions that point back at instructions hidden in the posting ("start your answer with the
 * exact phrase we asked for in the job description"): Prepare must read the posting for them.
 */
const POINTS_BACK =
  /\b(job|role|position) (description|posting|ad|advert)\b|exact (phrase|word)|\b(phrase|word|code) we asked\b|as (we )?asked (for )?in|mentioned in the (job|posting|description)|\b(secret|code) (word|phrase)\b/i;
