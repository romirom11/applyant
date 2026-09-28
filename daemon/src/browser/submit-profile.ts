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
}

export interface DeliveryOutcome<T> {
  result: T;
  /** Hand-off: leave the page open (restored) instead of closing it. */
  keepOpen: boolean;
}

/** Launches the persistent context: Patchright + real Chrome, else Playwright's own chromium. */
async function launch(
  o: SubmitProfileOptions,
): Promise<{ context: BrowserContext; branded: boolean }> {
  const opts = { channel: 'chrome' as const, headless: o.headless ?? false, viewport: null };
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
    const context = await playwrightChromium.launchPersistentContext(o.userDataDir, {
      headless: o.headless ?? false,
      viewport: null,
    });
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

  private ensure(): Promise<{ context: BrowserContext; branded: boolean }> {
    if (!this.context) this.context = launch(this.o);
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
      const { context } = await this.ensure();
      const page = await context.newPage();
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
