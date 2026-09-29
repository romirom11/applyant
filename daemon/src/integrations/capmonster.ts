// CapMonster Cloud: captchas on application forms are sent here before any hand-off. A plain
// createTask / getTaskResult HTTP API (https://docs.capmonster.cloud/docs/api/methods), used
// proxyless: the token is solved for the page URL and site key, then injected into the page by
// browser/captcha.ts. The key is `applyant secrets set capmonster`; without it nothing is sent
// and the captcha goes to the candidate as before.
//
// Never used for LinkedIn or Xing: a challenge there pauses the platform and goes to the
// candidate (browser/guardrails.ts), which deliver.ts enforces by not passing a solver.
import type { Secrets } from '../secrets/secrets.ts';

export const CAPMONSTER_SECRET = 'capmonster';
const DEFAULT_URL = 'https://api.capmonster.cloud';

export type CaptchaType =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'recaptcha_v2_enterprise'
  | 'recaptcha_v3_enterprise'
  | 'hcaptcha'
  | 'turnstile';

/** A captcha found on a page, as much as a solver needs to solve it for that page. */
export interface CaptchaChallenge {
  type: CaptchaType;
  sitekey: string;
  /** The page the widget is on (the frame's URL when it sits in an ATS iframe). */
  pageUrl: string;
  invisible?: boolean;
  /** reCAPTCHA v3 / Turnstile action. */
  action?: string | null;
  /** Turnstile cData, hCaptcha rqdata, reCAPTCHA Enterprise `s` payload. */
  data?: string | null;
}

export interface CaptchaSolver {
  /** A token for the challenge; throws CaptchaSolveError when it can't. */
  solve(c: CaptchaChallenge, o?: { signal?: AbortSignal }): Promise<string>;
}

export class CaptchaSolveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The CapMonster task for one challenge (proxyless: CapMonster solves from its own IPs). */
export function capmonsterTask(c: CaptchaChallenge): Record<string, unknown> {
  const base = { websiteURL: c.pageUrl, websiteKey: c.sitekey };
  switch (c.type) {
    case 'recaptcha_v2':
      return {
        type: 'RecaptchaV2Task',
        ...base,
        ...(c.invisible ? { isInvisible: true } : {}),
        ...(c.data ? { recaptchaDataSValue: c.data } : {}),
      };
    case 'recaptcha_v2_enterprise':
      return {
        type: 'RecaptchaV2EnterpriseTask',
        ...base,
        ...(c.data ? { enterprisePayload: { s: c.data } } : {}),
      };
    case 'recaptcha_v3':
      return {
        type: 'RecaptchaV3TaskProxyless',
        ...base,
        minScore: 0.7,
        ...(c.action ? { pageAction: c.action } : {}),
      };
    case 'recaptcha_v3_enterprise':
      return {
        type: 'RecaptchaV3EnterpriseTask',
        ...base,
        minScore: 0.7,
        ...(c.action ? { pageAction: c.action } : {}),
      };
    case 'hcaptcha':
      return {
        type: 'HCaptchaTask',
        ...base,
        ...(c.invisible ? { isInvisible: true } : {}),
        ...(c.data ? { data: c.data } : {}),
      };
    case 'turnstile':
      return {
        type: 'TurnstileTask',
        ...base,
        ...(c.action ? { pageAction: c.action } : {}),
        ...(c.data ? { data: c.data } : {}),
      };
  }
}

interface ApiReply {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
  status?: 'processing' | 'ready';
  solution?: { gRecaptchaResponse?: string; token?: string };
  balance?: number;
}

export interface CapMonsterOptions {
  secrets: Secrets;
  /** `APPLYANT_CAPMONSTER_URL`: tests point this at a local fake. */
  url?: string;
  fetch?: typeof fetch;
  /** Wait before the first poll, and between polls (CapMonster asks for 2–3 s). */
  firstPollMs?: number;
  pollMs?: number;
  /** Give up after this long (a stuck solve becomes a hand-off, not a hang). */
  timeoutMs?: number;
}

export class CapMonster implements CaptchaSolver {
  private readonly o: CapMonsterOptions;

  constructor(o: CapMonsterOptions) {
    this.o = o;
  }

  /** Whether a key is stored: without one, captchas go straight to the candidate. */
  async configured(): Promise<boolean> {
    return (await this.o.secrets.get(CAPMONSTER_SECRET)) !== null;
  }

  private async call(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const f = this.o.fetch ?? fetch;
    const url = `${(this.o.url ?? DEFAULT_URL).replace(/\/$/, '')}/${path}`;
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new CaptchaSolveError('HTTP', `CapMonster ${path}: HTTP ${res.status}`);
    const reply = (await res.json()) as ApiReply;
    if (reply.errorId) {
      const code = reply.errorCode ?? 'ERROR';
      throw new CaptchaSolveError(
        code,
        `CapMonster: ${code}${reply.errorDescription ? ` (${reply.errorDescription})` : ''}`,
      );
    }
    return reply;
  }

  private async key(): Promise<string> {
    const key = await this.o.secrets.get(CAPMONSTER_SECRET);
    if (!key) {
      throw new CaptchaSolveError(
        'NO_KEY',
        'no CapMonster key stored (`applyant secrets set capmonster`)',
      );
    }
    return key;
  }

  async createTask(c: CaptchaChallenge, signal?: AbortSignal): Promise<number> {
    const reply = await this.call(
      'createTask',
      { clientKey: await this.key(), task: capmonsterTask(c) },
      signal,
    );
    if (typeof reply.taskId !== 'number') {
      throw new CaptchaSolveError('NO_TASK', 'CapMonster returned no task id');
    }
    return reply.taskId;
  }

  /** The token, or null while CapMonster is still working on it. */
  async getTaskResult(taskId: number, signal?: AbortSignal): Promise<string | null> {
    const reply = await this.call('getTaskResult', { clientKey: await this.key(), taskId }, signal);
    if (reply.status !== 'ready') return null;
    const token = reply.solution?.gRecaptchaResponse ?? reply.solution?.token;
    if (!token) throw new CaptchaSolveError('NO_SOLUTION', 'CapMonster returned no token');
    return token;
  }

  async solve(c: CaptchaChallenge, o: { signal?: AbortSignal } = {}): Promise<string> {
    const taskId = await this.createTask(c, o.signal);
    const deadline = Date.now() + (this.o.timeoutMs ?? 120_000);
    await sleep(this.o.firstPollMs ?? 3000, o.signal);
    for (;;) {
      const token = await this.getTaskResult(taskId, o.signal);
      if (token) return token;
      if (Date.now() > deadline) {
        throw new CaptchaSolveError('TIMEOUT', 'CapMonster did not solve the captcha in time');
      }
      await sleep(this.o.pollMs ?? 2000, o.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
