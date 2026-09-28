// The real reader_builder (claude:sonnet) writes listing recipes for three local career pages,
// each checked on its page by the build itself: a div-soup page with generated class names and
// department groups, a paged table ("Next page"), and a page of plain text lines (a text pattern).
// With APPLYANT_RECORD_RECIPES=1 the recipes it built are copied into test/fixtures/listings/,
// where recipes.fixtures.test.ts replays them offline from then on.
//   APPLYANT_LIVE=1 pnpm test:live -t reader_builder
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../../src/browser/reader-pool.ts';
import { buildRecipe } from '../../src/domain/search/recipes/build.ts';
import { recipeRow, requestRecipe } from '../../src/domain/search/recipes/store.ts';
import { addSource } from '../../src/domain/search/sources.ts';
import { ClaudeProvider } from '../../src/models/providers/claude.ts';
import { EventBus } from '../../src/queue/events.ts';
import { runInTx } from '../../src/queue/tx.ts';
import { Worker } from '../../src/queue/worker.ts';
import { type TempDb, tempDb } from '../helpers/db.ts';
import { handlers, quietLog, testDeps } from '../helpers/deps.ts';
import { type SiteServer, startSiteServer } from '../helpers/site-server.ts';

const live = process.env.APPLYANT_LIVE === '1';
const LISTINGS = fileURLToPath(new URL('../fixtures/listings', import.meta.url));

describe.skipIf(!live)('live reader_builder (real claude:sonnet)', () => {
  let site: SiteServer;
  let reader: ReaderPool;
  let t: TempDb;
  let bus: EventBus;
  let worker: Worker;
  beforeAll(async () => {
    site = await startSiteServer();
    reader = new ReaderPool({ maxContexts: 2, navigationTimeoutMs: 20_000, log: quietLog });
    t = tempDb();
    bus = new EventBus();
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({ build_recipe: buildRecipe }),
      deps: testDeps({ dir: t.dir, db: t.db, providers: [new ClaudeProvider()], reader }),
      log: quietLog,
      concurrency: 3,
      leaseMs: 15 * 60_000,
      pollMs: 50,
      maxAttempts: 1,
    });
    worker.start();
  });
  afterAll(async () => {
    await worker.stop();
    await reader.close();
    await site.close();
    t.cleanup();
  });

  const build = async (path: string, record: string) => {
    const { source } = addSource(t.db, { kind: 'page', locator: site.url(path) }, new Date());
    runInTx(t.db, bus, { now: new Date() }, (tx) =>
      requestRecipe(tx, source, { kind: 'none', detail: 'live test' }),
    );
    await worker.idle();
    const row = recipeRow(t.db, source.id);
    if (process.env.APPLYANT_RECORD_RECIPES === '1' && row?.status === 'ok' && row.fixtureHtml) {
      const dir = join(LISTINGS, record);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'page.html'), row.fixtureHtml);
      writeFileSync(
        join(dir, 'recipe.json'),
        `${JSON.stringify(
          {
            url: row.fixtureUrl,
            source: `live reader_builder test: ${path}`,
            builtAt: row.builtAt?.toISOString() ?? null,
            recipe: row.recipe,
            expected: row.expected,
          },
          null,
          2,
        )}\n`,
      );
    }
    return row;
  };

  it('reads a div-soup page with department groups (and skips the hidden one)', async () => {
    const row = await build('/careers-hard.html', 'synthetic-div-soup');
    expect(row?.status, row?.note ?? '').toBe('ok');
    expect(row?.expected?.map((l) => l.title)).toEqual([
      'Robotics Software Engineer',
      'ML Engineer, Perception',
      'Senior Backend Engineer',
      'Field Service Technician',
      'Account Executive, DACH',
      'Solutions Engineer',
    ]);
    expect(row?.expected?.[1]?.url).toBe(site.url('/careers/7b3e1d22-ml-engineer-perception'));
  });

  it('follows a paged table to its last page', async () => {
    const row = await build('/careers-paged.html', 'synthetic-paged-table');
    expect(row?.status, row?.note ?? '').toBe('ok');
    expect(row?.expected?.map((l) => l.title)).toEqual([
      'Founding Engineer',
      'Staff Backend Engineer',
      'Engineering Manager',
    ]);
    expect(row?.lastCount).toBe(5);
    expect(row?.recipe).toMatchObject({
      kind: 'locators',
      pagination: { next: expect.anything() },
    });
  });

  it('reads plain text lines', async () => {
    const row = await build('/careers-text.html', 'synthetic-text-lines');
    expect(row?.status, row?.note ?? '').toBe('ok');
    expect(row?.expected?.map((l) => [l.title, l.url])).toEqual([
      ['Backend Engineer', site.url('/jobs/k1')],
      ['Frontend Engineer', site.url('/jobs/k2')],
      ['ML Engineer', site.url('/jobs/k3')],
    ]);
  });
});
