// Reading a LinkedIn/Xing page for a task that isn't a search or an application: verifying a
// posting the platform's search found, reading its Easy Apply / Xing form, re-reading its text.
// Such pages are never opened in the headless reader: they open in Applyant's signed-in profile,
// inside the platform guardrails (its lane, pacing, the candidate-active wait and the pause) but
// not counted against the daily caps. A challenge on the page pauses the platform and leaves the
// page open for the candidate; the read then fails like any read that couldn't finish.
import type { Page } from 'playwright';
import { markSharedPage } from './form-read.ts';
import {
  type Guardrails,
  PlatformBusy,
  PlatformChallenge,
  PlatformPaused,
  platformName,
  platformOf,
} from './guardrails.ts';
import type { ReaderPool, WithPageOptions } from './reader-pool.ts';
import type { SubmitProfile } from './submit-profile.ts';

export type PageReader = Pick<ReaderPool, 'withPage'>;

export interface PlatformReaderDeps {
  reader: PageReader;
  submit?: Pick<SubmitProfile, 'deliver'> | null;
  guardrails?: Guardrails | null;
}

/** The guardrails refused the read for now (paused, or the candidate is using the platform). */
export function isPlatformHold(err: unknown): err is PlatformPaused | PlatformBusy {
  return err instanceof PlatformPaused || err instanceof PlatformBusy;
}

/** The reader for `url`: the headless reader, or the guarded signed-in profile on LinkedIn/Xing. */
export function readerFor(
  deps: PlatformReaderDeps,
  url: string,
  o: { taskId?: number; progress?(message: string): void } = {},
): PageReader {
  const platform = platformOf(url);
  if (!platform) return deps.reader;
  const { guardrails, submit } = deps;
  return {
    withPage<T>(fn: (page: Page) => Promise<T>, opts: WithPageOptions = {}): Promise<T> {
      if (!guardrails || typeof submit?.deliver !== 'function') {
        return Promise.reject(
          new Error(
            `${platformName(platform)} pages are read only in Applyant's signed-in browser, under the platform guardrails`,
          ),
        );
      }
      return guardrails.run(
        platform,
        'search',
        (session) =>
          submit
            .deliver<T | PlatformChallenge>(async (page) => {
              markSharedPage(page);
              const result = await fn(page);
              // Only the platform's own pages can challenge it (a company form it led to can't).
              if (platformOf(page.url()) === platform) {
                try {
                  await session.checkChallenge(page);
                } catch (err) {
                  if (err instanceof PlatformChallenge) return { result: err, keepOpen: true };
                  throw err;
                }
              }
              return { result, keepOpen: false };
            })
            .then((r) => {
              if (r instanceof PlatformChallenge) throw r;
              return r;
            }),
        {
          count: false,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(o.progress ? { progress: o.progress } : {}),
          ...(o.taskId !== undefined ? { taskId: o.taskId } : {}),
        },
      );
    },
  };
}
