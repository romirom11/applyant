// The submission browser: one persistent Chrome profile, used for delivery and for signing
// into sites once (LinkedIn, Xing, Workday accounts). Patchright avoids the automation signals
// that Chrome and reCAPTCHA/Turnstile look for; branded Chrome carries the most ordinary
// fingerprint. Deliveries are serialised (one at a time), because they share the one profile.
//
// Patchright is a separate package with its own driver and its own (structurally identical)
// types, so it's isolated here: everywhere else sees only Playwright's public `Page` /
// `BrowserContext` types. `page.on('console')` never fires under Patchright (it disables the
// Console domain), so nothing in the delivery path may depend on it.
import type { BrowserContext, Page } from 'playwright';
import { chromium as playwrightChromium } from 'playwright';
import type { Logger } from '../util/log.ts';
import { minimizeWindow } from './window.ts';

export interface SubmitProfileOptions {
  /** The persistent profile directory (`<data dir>/browser/`). */
  userDataDir: string;
  log: Logger;
  /** Tests only: run headless (no window to minimise/restore meaningfully). */
  headless?: boolean;
  /**
   * Branded Chrome keeps its cookie key in the macOS Keychain, like the sign-in window, so a
   * sign-in there carries over. Default: on, except headless (tests run throwaway profiles and
   * leave the Keychain alone).
   */
  keychain?: boolean;
}

export interface DeliveryOutcome<T> {
  result: T;
  /** Hand-off: leave the page open (restored) instead of closing it. */
  keepOpen: boolean;
}

/**
 * Playwright and Patchright start Chrome with a mock Keychain (and a "basic" password store on
 * Linux). Chrome encrypts cookies with a key from the Keychain, so under the mock one every
 * cookie the sign-in window (plain Chrome) wrote is unreadable: each site looks signed out, and
 * the automation's own cookies then replace the real session. Branded Chrome is the binary the
 * sign-in window runs, so it may use the real Keychain without a prompt.
 */
export const MOCK_KEYCHAIN_ARGS = ['--use-mock-keychain', '--password-store=basic'];

/** The launch options of the profile's browser: branded Chrome, or the bundled Chromium. */
export function launchOptions(
  browser: 'chrome' | 'bundled',
  o: { headless: boolean; keychain: boolean },
) {
  // The bundled Chromium is another binary: the Keychain would ask before handing it Chrome's
  // key, so it keeps the mock one (and sign-ins from the window don't carry over to it).
  if (browser === 'bundled') return { headless: o.headless, viewport: null };
  return {
    channel: 'chrome' as const,
    headless: o.headless,
    viewport: null,
    ...(o.keychain ? { ignoreDefaultArgs: MOCK_KEYCHAIN_ARGS } : {}),
  };
}

/** Launches the persistent context: Patchright + real Chrome, else Playwright's own chromium. */
async function launch(
  o: SubmitProfileOptions,
): Promise<{ context: BrowserContext; branded: boolean }> {
  const headless = o.headless ?? false;
  const opts = launchOptions('chrome', { headless, keychain: o.keychain ?? !headless });
  try {
    const { chromium: patchrightChromium } = await import('patchright');
    const context = await patchrightChromium.launchPersistentContext(o.userDataDir, opts);
    return { context: context as unknown as BrowserContext, branded: true };
  } catch (err) {
    o.log.warn('Patchright/Chrome unavailable for the submission profile; falling back', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const context = await playwrightChromium.launchPersistentContext(o.userDataDir, opts);
    return { context, branded: true };
  } catch {
    // Chrome for Testing fallback: Playwright's own bundled chromium, still headed.
    o.log.warn(
      "Google Chrome didn't start for the submission profile: using the bundled Chromium, which can't read the sign-in window's cookies (sign-ins don't carry over)",
    );
    const context = await playwrightChromium.launchPersistentContext(
      o.userDataDir,
      launchOptions('bundled', { headless, keychain: false }),
    );
    return { context, branded: false };
  }
}

/** One shared, persistent submission browser; deliveries run one at a time. */
export class SubmitProfile {
  private readonly o: SubmitProfileOptions;
  private context: Promise<{ context: BrowserContext; branded: boolean }> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SubmitProfileOptions) {
    this.o = options;
  }

  /**
   * The running browser, launched when there is none. A launch that failed, and a browser that
   * closed (the candidate quit Chrome after a hand-off, or it crashed), are forgotten, so the
   * next delivery starts a new one instead of failing on the dead one until the daemon restarts.
   */
  private ensure(): Promise<{ context: BrowserContext; branded: boolean }> {
    if (!this.context) {
      const launched = launch(this.o);
      const forget = () => {
        if (this.context === launched) this.context = null;
      };
      launched.then(({ context }) => context.on('close', forget), forget);
      this.context = launched;
    }
    return this.context;
  }

  /**
   * Runs `fn` on a fresh page of the shared profile, one delivery at a time. The window starts
   * minimised; `fn` decides (via `keepOpen`) whether the page is closed afterwards or left open
   * (hand-off), restored so the candidate sees it. Never runs two deliveries concurrently.
   */
  async deliver<T>(fn: (page: Page) => Promise<DeliveryOutcome<T>>): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const page = await this.newPage();
      try {
        await minimizeWindow(page);
      } catch (err) {
        this.o.log.warn('could not minimise the submission window', { err });
      }
      try {
        const { result, keepOpen } = await fn(page);
        if (!keepOpen) await page.close().catch(() => {});
        return result;
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
    } finally {
      release();
    }
  }

  /** A fresh page; a browser that turns out to be gone is relaunched once. */
  private async newPage(): Promise<Page> {
    const first = await this.ensure();
    try {
      return await first.context.newPage();
    } catch (err) {
      this.o.log.warn('the submission browser was gone; starting it again', {
        err: err instanceof Error ? err.message : String(err),
      });
      if (this.context) {
        const stale = this.context;
        this.context = null;
        await stale.then(({ context }) => context.close()).catch(() => {});
      }
      return (await this.ensure()).context.newPage();
    }
  }

  /**
   * Lets go of the profile for the unautomated sign-in window: waits for the running delivery,
   * closes the automated browser (Chrome allows one process per profile), and keeps later
   * deliveries queued until `until` settles; they then relaunch it. Resolves once it's closed.
   */
  hold(until: Promise<void>): Promise<void> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await previous;
      try {
        await this.close();
      } catch (err) {
        release();
        throw err;
      }
      until.then(release, release);
    })();
  }

  /** Pages currently open in the profile (tests: what a hand-off left behind). */
  async openPages(): Promise<Page[]> {
    if (!this.context) return [];
    const { context } = await this.context;
    return context.pages();
  }

  async close(): Promise<void> {
    const pending = this.context;
    this.context = null;
    if (!pending) return;
    const { context } = await pending.catch(() => ({ context: null as unknown as BrowserContext }));
    await context?.close().catch(() => {});
  }
}
