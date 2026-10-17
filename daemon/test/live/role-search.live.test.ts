// The job searches across every company, on the real services: Workable's and SmartRecruiters'
// own job searches for a few titles, each listing with its company board. Plain public GETs, a
// few dozen in all. Web search is left out (its engines ask automated clients not to; it's the
// candidate's switch). Prints what each found for a human to look at.
//   APPLYANT_LIVE=1 pnpm test:live -t role-search
import { describe, expect, it } from 'vitest';
import {
  readSmartRecruitersSearch,
  readWorkableSearch,
} from '../../src/domain/search/readers/ats-search.ts';
import { SharedReads } from '../../src/domain/search/readers/shared.ts';
import type { ReaderContext } from '../../src/domain/search/readers/types.ts';
import { matchesStrategy } from '../../src/domain/search/strategies.ts';

const live = process.env.APPLYANT_LIVE === '1';

const STRATEGIES = [
  { queries: ['ai engineer -intern -junior'], locations: ['remote', 'greece', 'europe'] },
  { queries: ['laravel -intern -junior', 'senior php -intern'], locations: ['remote', 'greece'] },
  { queries: ['forward deployed engineer -intern'], locations: ['remote', 'germany', 'berlin'] },
];

describe.skipIf(!live)('live job searches across every company', () => {
  const shared = new SharedReads();
  const ctx = (s: (typeof STRATEGIES)[number]): ReaderContext => ({
    fetch: globalThis.fetch,
    signal: AbortSignal.timeout(5 * 60_000),
    queries: s.queries,
    locations: s.locations,
    reader: null,
    now: new Date(),
    wants: (l) => matchesStrategy(l, s),
    shared,
    turn: 0,
  });

  for (const s of STRATEGIES) {
    it(`role-search: ${s.queries[0]}`, async () => {
      for (const [name, read] of [
        ['Workable', readWorkableSearch],
        ['SmartRecruiters', readSmartRecruitersSearch],
      ] as const) {
        const run = await read(ctx(s));
        const fit = run.listings.filter((l) => matchesStrategy(l, s));
        const boards = new Set(fit.map((l) => `${l.board?.ats}:${l.board?.token}`));
        console.log(`${name}: ${run.note}\n  ${fit.length} fit, behind ${boards.size} boards`);
        for (const l of fit.slice(0, 5))
          console.log(`  ${l.title} · ${l.company} · ${l.location} · ${l.url}`);
        expect(run.complete).toBe(false);
        expect(run.listings.length).toBeGreaterThan(0);
        // Every listing that came from a board knows it (that's what joins the watch list).
        for (const l of run.listings)
          if (!l.url.includes('jobs.workable.com/view/')) expect(l.board).toBeTruthy();
      }
    });
  }
});
