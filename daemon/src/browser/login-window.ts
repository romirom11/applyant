// The sign-in window: Applyant's own Chrome profile (`browser/`), opened as plain Chrome with no
// automation at all (no CDP port, no --enable-automation, no Patchright), so "Sign in with
// Google" and the sites' own bot checks see an ordinary browser. The candidate signs in to
// LinkedIn, Xing, Workday accounts and similar sites once; the session stays in the profile and
// later deliveries and searches reuse it.
//
// Chrome allows one process per profile directory, so the automated submission browser is closed
// first and deliveries wait until the window is closed (SubmitProfile.hold). While the window is
// open the candidate is "active in the profile", and guarded platforms wait too.
//
// Logins (username + password for an account Applyant should know about) are kept in Secrets as
// `login.<site>`, never in the database.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Secrets } from '../secrets/secrets.ts';
import type { Logger } from '../util/log.ts';
import { type PlatformKey, platformOf } from './guardrails.ts';

export const SIGN_IN_URLS: Record<PlatformKey, string> = {
  linkedin: 'https://www.linkedin.com/login',
  xing: 'https://login.xing.com/',
};

/**
 * Where Google Chrome is: `APPLYANT_CHROME` when set (and only there: a wrong path is an error,
 * never a silent fallback to the installed Chrome), else the usual install paths.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.APPLYANT_CHROME) return existsSync(env.APPLYANT_CHROME) ? env.APPLYANT_CHROME : null;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The arguments of a plain, unautomated Chrome on Applyant's profile. */
export function signInArgs(userDataDir: string, url: string): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ];
}

/** The target of a sign-in: a guarded platform's key, or any https URL (a Workday tenant…). */
export function signInTarget(target: string): { url: string; platform: PlatformKey | null } {
  const key = target.trim().toLowerCase();
  if (key in SIGN_IN_URLS) {
    const platform = key as PlatformKey;
    return { url: SIGN_IN_URLS[platform], platform };
  }
  let u: URL;
  try {
    u = new URL(target.trim());
  } catch {
    throw new Error(`sign in where? "${target}" is neither linkedin, xing nor a URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`sign in where? "${target}" is not a web address`);
  }
  return { url: u.href, platform: platformOf(u.href) };
}

/** Frees the profile for the window: resolves once no automation holds it; `done` gives it back. */
export interface ProfileHolder {
  hold(until: Promise<void>): Promise<void>;
  /** Pages the automated browser still has open (a hand-off waiting for the candidate). */
  openPages(): Promise<Array<{ url(): string }>>;
}

export interface LoginWindowOptions {
  userDataDir: string;
  profile: ProfileHolder;
  log: Logger;
  chrome?: string | null;
  /** The window closed: the platform (if any) counts as signed in. */
  onClosed?(o: { url: string; platform: PlatformKey | null }): void;
  spawn?: typeof spawn;
}

export class LoginWindowError extends Error {}

export class LoginWindow {
  private readonly o: LoginWindowOptions;
  private child: ChildProcess | null = null;
  private current: { url: string; platform: PlatformKey | null } | null = null;

  constructor(o: LoginWindowOptions) {
    this.o = o;
  }

  isOpen(): boolean {
    return this.child !== null;
  }

  /** What the open window was opened for, or null. */
  openFor(): { url: string; platform: PlatformKey | null } | null {
    return this.current;
  }

  /**
   * Opens the sign-in window and returns once Chrome has started (not when it closes). Refuses
   * while a hand-off window is open in the automated browser (closing it would lose the filled
   * form) unless `force`.
   */
  async open(
    target: string,
    o: { force?: boolean } = {},
  ): Promise<{ url: string; platform: PlatformKey | null }> {
    const t = signInTarget(target);
    if (this.child) {
      throw new LoginWindowError(
        `the sign-in window is already open (${this.current?.url}): close it first`,
      );
    }
    const chrome = this.o.chrome === undefined ? findChrome() : this.o.chrome;
    if (!chrome) {
      throw new LoginWindowError(
        'Google Chrome was not found (install it, or set APPLYANT_CHROME to its binary)',
      );
    }
    const open = await this.o.profile.openPages();
    if (open.length > 0 && !o.force) {
      throw new LoginWindowError(
        `Applyant's browser has ${open.length} window${open.length === 1 ? '' : 's'} left open for you (${open[0]?.url()}): finish ${open.length === 1 ? 'it' : 'them'} first, or sign in with --force (that closes ${open.length === 1 ? 'it' : 'them'})`,
      );
    }

    let closed = () => {};
    const window = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let started = () => {};
    let failed = (_err: Error) => {};
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    // The automated browser lets go of the profile; deliveries queue behind the window.
    const held = this.o.profile.hold(window);
    held.then(
      () => {
        if (this.child) return;
        const child = (this.o.spawn ?? spawn)(chrome, signInArgs(this.o.userDataDir, t.url), {
          stdio: 'ignore',
        });
        this.child = child;
        this.current = t;
        let settled = false;
        child.once('spawn', () => {
          settled = true;
          started();
        });
        child.once('error', (err) => {
          if (settled) return;
          this.child = null;
          this.current = null;
          closed();
          failed(new LoginWindowError(`Chrome didn't start: ${err.message}`));
        });
        child.once('exit', (code) => {
          this.child = null;
          this.current = null;
          closed();
          this.o.log.info('sign-in window closed', { url: t.url, code });
          if (settled) this.o.onClosed?.(t);
        });
      },
      (err: Error) => {
        closed();
        failed(err);
      },
    );
    await ready;
    this.o.log.info('sign-in window open', { url: t.url });
    return t;
  }

  /** Closes the window (daemon shutdown). */
  close(): void {
    this.child?.kill();
  }
}

/** A login for a site, kept in Secrets as `login.<site>`. */
export interface SiteLogin {
  username: string;
  password: string;
}

export function loginSecretName(site: string): string {
  const key = site
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return `login.${key}`;
}

export async function saveLogin(secrets: Secrets, site: string, login: SiteLogin): Promise<string> {
  const name = loginSecretName(site);
  await secrets.set(name, JSON.stringify(login));
  return name;
}

export async function readLogin(secrets: Secrets, site: string): Promise<SiteLogin | null> {
  const raw = await secrets.get(loginSecretName(site));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SiteLogin;
    return typeof v.username === 'string' && typeof v.password === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Guardrails' "is the candidate using the profile on this platform": the sign-in window is open,
 * or a page of the platform is open, visible and focused in Applyant's browser (a hand-off the
 * candidate is working in).
 */
export function profileActivity(
  login: Pick<LoginWindow, 'isOpen'>,
  profile: { openPages(): Promise<Array<{ url(): string; evaluate<R>(fn: () => R): Promise<R> }>> },
): { activeOn(platform: PlatformKey): Promise<boolean> } {
  return {
    async activeOn(platform) {
      if (login.isOpen()) return true;
      for (const page of await profile.openPages().catch(() => [])) {
        if (platformOf(page.url()) !== platform) continue;
        const focused = await page
          .evaluate(() => document.visibilityState === 'visible' && document.hasFocus())
          .catch(() => false);
        if (focused) return true;
      }
      return false;
    },
  };
}
