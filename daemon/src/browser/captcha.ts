// The captcha step of delivery: find the captcha on the filled step (type + site key), have the
// solver (CapMonster) produce a token for this page, put the token where the site reads it
// (`g-recaptcha-response` / `h-captcha-response` / `cf-turnstile-response`, and the page's own
// `grecaptcha.execute` for score-based reCAPTCHA), and call the widget's callback, as a solved
// widget would. Anything unrecognised or unsolved goes to the candidate, the step still filled.
import type { Frame, Page } from 'playwright';
import type { CaptchaChallenge, CaptchaSolver, CaptchaType } from '../integrations/capmonster.ts';

export interface FoundCaptcha extends CaptchaChallenge {
  frame: Frame;
}

/** What the captcha step decided: carry on to submit, or hand the step to the candidate. */
export type CaptchaStep =
  | { kind: 'none' }
  | { kind: 'solved'; type: CaptchaType }
  /** `challenge`: a guarded platform's own check (LinkedIn/Xing), which pauses that platform. */
  | { kind: 'handoff'; reason: string; challenge?: string };

const CAPTCHA_HOST = /(^|\.)(recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com)$/;

/** A captcha frame by its host or URL, whether or not its widget can be read (phase 6). */
export function detectCaptcha(page: Page): string | null {
  for (const frame of page.frames()) {
    try {
      const u = new URL(frame.url());
      if (CAPTCHA_HOST.test(u.hostname)) return u.hostname;
      if (u.hostname.endsWith('google.com') && u.pathname.startsWith('/recaptcha')) {
        return 'recaptcha';
      }
    } catch {
      // about:blank frames etc.
    }
  }
  return null;
}

interface RawWidget {
  type: CaptchaType;
  sitekey: string;
  invisible: boolean;
  action: string | null;
  data: string | null;
}

/**
 * Reads one frame's document for a captcha widget: the vendors' own markup (`.g-recaptcha`,
 * `.h-captcha`, `.cf-turnstile` with `data-sitekey`), their iframes (the key is in the URL), and
 * the script tags that load them (reCAPTCHA v3 has no widget, only `api.js?render=<key>`).
 * Runs in the page, so it's self-contained.
 */
function readWidgets(): RawWidget | null {
  const attr = (el: Element | null, name: string) => el?.getAttribute(name) ?? null;
  const enterprise = Array.from(document.scripts).some((s) =>
    /recaptcha\/enterprise\.js/.test(s.src),
  );

  const ts = document.querySelector('.cf-turnstile[data-sitekey], [data-turnstile-sitekey]');
  if (ts) {
    return {
      type: 'turnstile',
      sitekey: attr(ts, 'data-sitekey') ?? attr(ts, 'data-turnstile-sitekey') ?? '',
      invisible: false,
      action: attr(ts, 'data-action'),
      data: attr(ts, 'data-cdata'),
    };
  }
  const hc = document.querySelector('.h-captcha[data-sitekey]');
  if (hc) {
    return {
      type: 'hcaptcha',
      sitekey: attr(hc, 'data-sitekey') ?? '',
      invisible: attr(hc, 'data-size') === 'invisible',
      action: null,
      data: null,
    };
  }
  const rc = document.querySelector('.g-recaptcha[data-sitekey]');
  if (rc) {
    return {
      type: enterprise ? 'recaptcha_v2_enterprise' : 'recaptcha_v2',
      sitekey: attr(rc, 'data-sitekey') ?? '',
      invisible: attr(rc, 'data-size') === 'invisible',
      action: attr(rc, 'data-action'),
      data: attr(rc, 'data-s'),
    };
  }
  for (const f of Array.from(document.querySelectorAll('iframe[src]'))) {
    let u: URL;
    try {
      u = new URL((f as HTMLIFrameElement).src, location.href);
    } catch {
      continue;
    }
    if (u.hostname === 'challenges.cloudflare.com') {
      const key = u.pathname.split('/').find((p) => /^0x[0-9A-Za-z_-]{10,}$/.test(p));
      if (key)
        return { type: 'turnstile', sitekey: key, invisible: false, action: null, data: null };
    }
    if (/(^|\.)hcaptcha\.com$/.test(u.hostname)) {
      const params = new URLSearchParams(u.hash.slice(1) || u.search);
      const key = params.get('sitekey');
      if (key) {
        return {
          type: 'hcaptcha',
          sitekey: key,
          invisible: params.get('size') === 'invisible',
          action: null,
          data: null,
        };
      }
    }
    if (
      /(^|\.)(google\.com|recaptcha\.net)$/.test(u.hostname) &&
      u.pathname.startsWith('/recaptcha')
    ) {
      const key = u.searchParams.get('k');
      if (key) {
        return {
          type: u.pathname.includes('/enterprise/') ? 'recaptcha_v2_enterprise' : 'recaptcha_v2',
          sitekey: key,
          invisible: u.searchParams.get('size') === 'invisible',
          action: u.searchParams.get('sa'),
          data: null,
        };
      }
    }
  }
  // Score-based reCAPTCHA: no widget, only the script with the key as `render`.
  for (const s of Array.from(document.scripts)) {
    if (!/recaptcha\/(api|enterprise)\.js/.test(s.src)) continue;
    const render = new URL(s.src, location.href).searchParams.get('render');
    if (render && render !== 'explicit' && render !== 'onload') {
      return {
        type: enterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3',
        sitekey: render,
        invisible: true,
        action: attr(document.querySelector('[data-recaptcha-action]'), 'data-recaptcha-action'),
        data: null,
      };
    }
  }
  return null;
}

/** The first captcha widget in any frame of the page, with the site key a solver needs. */
export async function findCaptcha(page: Page): Promise<FoundCaptcha | null> {
  for (const frame of page.frames()) {
    const raw = await frame.evaluate(readWidgets).catch(() => null);
    if (!raw?.sitekey) continue;
    return {
      frame,
      type: raw.type,
      sitekey: raw.sitekey,
      pageUrl: frame.url(),
      invisible: raw.invisible,
      action: raw.action,
      data: raw.data,
    };
  }
  return null;
}

/**
 * Puts the token where the site reads it and calls what the widget would have called: the
 * `data-callback` named on the widget, else (reCAPTCHA) the callbacks registered in
 * `___grecaptcha_cfg`; for score-based reCAPTCHA, `grecaptcha.execute` now answers the token.
 * Returns the callback's name, or null when there was none to call.
 */
export async function injectToken(found: FoundCaptcha, token: string): Promise<string | null> {
  return found.frame.evaluate(
    ({ type, token }) => {
      const w = window as unknown as Record<string, unknown>;
      const widget = document.querySelector(
        type === 'turnstile'
          ? '.cf-turnstile, [data-turnstile-sitekey]'
          : type === 'hcaptcha'
            ? '.h-captcha'
            : '.g-recaptcha',
      );
      const host = widget ?? document.querySelector('form') ?? document.body;
      const put = (name: string, tag: 'textarea' | 'input') => {
        let els = Array.from(document.querySelectorAll<HTMLInputElement>(`[name="${name}"]`));
        if (els.length === 0) {
          const el = document.createElement(tag) as HTMLInputElement;
          el.name = name;
          if (tag === 'input') el.type = 'hidden';
          else el.style.display = 'none';
          host.appendChild(el);
          els = [el];
        }
        for (const el of els) {
          el.value = token;
          if (el.tagName === 'TEXTAREA') el.textContent = token;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      if (type === 'turnstile') put('cf-turnstile-response', 'input');
      else if (type === 'hcaptcha') {
        put('h-captcha-response', 'textarea');
        put('g-recaptcha-response', 'textarea');
      } else put('g-recaptcha-response', 'textarea');

      // Score-based reCAPTCHA reads its token at submit through grecaptcha.execute.
      if (type.startsWith('recaptcha')) {
        const g = w.grecaptcha as Record<string, unknown> | undefined;
        const answer = () => Promise.resolve(token);
        if (g) {
          g.execute = answer;
          const ent = g.enterprise as Record<string, unknown> | undefined;
          if (ent) ent.execute = answer;
        }
      }

      const named = widget?.getAttribute('data-callback');
      if (named) {
        const fn = named
          .split('.')
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], w);
        if (typeof fn === 'function') {
          (fn as (t: string) => void)(token);
          return named;
        }
      }
      if (type.startsWith('recaptcha')) {
        // Widgets rendered from script keep their callback in ___grecaptcha_cfg.clients.
        const cfg = w.___grecaptcha_cfg as { clients?: Record<string, unknown> } | undefined;
        const seen = new Set<unknown>();
        const walk = (o: unknown, depth: number): ((t: string) => void) | null => {
          if (!o || typeof o !== 'object' || depth > 5 || seen.has(o)) return null;
          seen.add(o);
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            if (k === 'callback' && typeof v === 'function') return v as (t: string) => void;
            const hit = walk(v, depth + 1);
            if (hit) return hit;
          }
          return null;
        };
        for (const client of Object.values(cfg?.clients ?? {})) {
          const fn = walk(client, 0);
          if (fn) {
            fn(token);
            return 'grecaptcha';
          }
        }
      }
      return null;
    },
    { type: found.type, token },
  );
}

export interface CaptchaStepOptions {
  signal?: AbortSignal;
  progress?(message: string): void;
}

/**
 * The captcha step with a solver: nothing on the page → carry on; a widget with a site key →
 * solve and inject; a captcha frame whose widget can't be read, or a failed solve → hand-off.
 * Without a solver, the phase-6 rule: a captcha frame goes to the candidate.
 */
export async function captchaStep(
  page: Page,
  solver: CaptchaSolver | null,
  o: CaptchaStepOptions = {},
): Promise<CaptchaStep> {
  const found = await findCaptcha(page);
  const frame = detectCaptcha(page);
  if (!solver) {
    // Score-based reCAPTCHA shows nothing to solve by hand: submit as before.
    const visible =
      found && found.type !== 'recaptcha_v3' && found.type !== 'recaptcha_v3_enterprise';
    const what = frame ?? (visible ? found.type : null);
    return what
      ? {
          kind: 'handoff',
          reason: `a captcha (${what}) is on this step; everything else is filled`,
        }
      : { kind: 'none' };
  }
  if (!found) {
    return frame
      ? {
          kind: 'handoff',
          reason: `a captcha (${frame}) is on this step and its type couldn't be read; everything else is filled`,
        }
      : { kind: 'none' };
  }
  o.progress?.(`solving a ${found.type.replace(/_/g, ' ')} captcha`);
  let token: string;
  try {
    token = await solver.solve(found, o.signal ? { signal: o.signal } : {});
  } catch (err) {
    o.signal?.throwIfAborted();
    return {
      kind: 'handoff',
      reason: `a captcha (${found.type}) couldn't be solved: ${(err as Error).message}; everything else is filled`,
    };
  }
  await injectToken(found, token);
  o.progress?.(`captcha solved (${found.type.replace(/_/g, ' ')})`);
  return { kind: 'solved', type: found.type };
}
