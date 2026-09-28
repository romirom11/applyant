// The reader's browser (Chromium headless shell), fetched on the app's first launch into
// PLAYWRIGHT_BROWSERS_PATH (Applyant's data dir; the bundle's launcher sets both). Playwright's
// own installer does it, and returns at once when the browser is already there.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../util/log.ts';

const PLAYWRIGHT_CLI = fileURLToPath(
  new URL('./cli.js', import.meta.resolve('playwright/package.json')),
);

/** Resolves when the install finished or failed (a failure is logged; launching reports it). */
export function installReaderBrowser(log: Logger): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PLAYWRIGHT_CLI, 'install', '--only-shell', 'chromium'],
      { timeout: 15 * 60_000, maxBuffer: 16 << 20 },
      (err, stdout) => {
        if (err) log.error('could not install the reader browser', { err });
        else if (stdout.trim()) {
          log.info('reader browser installed', {
            ms: Date.now() - started,
            into: process.env.PLAYWRIGHT_BROWSERS_PATH,
          });
        }
        resolve();
      },
    );
  });
}
