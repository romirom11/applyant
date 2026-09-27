// Background reading: one Chromium headless shell, many throwaway contexts.
// Nothing here is logged in and nothing persists between pages.
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import type { Logger } from '../util/log.ts';

export interface ReaderPoolOptions {
  maxContexts: number;
  navigationTimeoutMs: number;
  log: Logger;
}

export interface WithPageOptions {
  signal?: AbortSignal;
}

export class ReaderPool {
  private readonly o: ReaderPoolOptions;
  private browser: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private closed = false;

  constructor(options: ReaderPoolOptions) {
    this.o = options;
  }

  get navigationTimeoutMs(): number {
    return this.o.navigationTimeoutMs;
  }

  /** Runs `fn` on a fresh page in its own context; the context is closed afterwards. */
  async withPage<T>(fn: (page: Page) => Promise<T>, opts: WithPageOptions = {}): Promise<T> {
    opts.signal?.throwIfAborted();
    await this.acquire();
    let context: BrowserContext | null = null;
    const onAbort = () => {
      void context?.close().catch(() => {});
    };
    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({
        userAgent: userAgentFor(browser.version()),
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      context.setDefaultNavigationTimeout(this.o.navigationTimeoutMs);
      context.setDefaultTimeout(Math.min(this.o.navigationTimeoutMs, 10_000));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      opts.signal?.throwIfAborted();
      const page = await context.newPage();
      return await fn(page);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await context?.close().catch(() => {});
      this.releaseSlot();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    if (browser) await (await browser.catch(() => null))?.close().catch(() => {});
  }

  private getBrowser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new Error('reader pool is closed'));
    if (!this.browser) {
      const launching = chromium.launch({ headless: true });
      this.browser = launching;
      launching.then(
        (browser) => {
          this.o.log.info('reader browser started', { version: browser.version() });
          browser.on('disconnected', () => {
            if (this.browser === launching) this.browser = null;
          });
        },
        (err) => {
          this.o.log.error('reader browser failed to start', { err });
          if (this.browser === launching) this.browser = null;
        },
      );
    }
    return this.browser;
  }

  private acquire(): Promise<void> {
    if (this.active < this.o.maxContexts) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

/** An ordinary desktop Chrome UA for the same major version, without "HeadlessChrome". */
function userAgentFor(version: string): string {
  const major = version.split('.')[0] ?? '140';
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
