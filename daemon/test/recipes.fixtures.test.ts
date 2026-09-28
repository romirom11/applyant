// Every stored recipe replays against its fixture offline: the page as it was when the recipe
// was built (test/fixtures/listings/<name>/page.html) must still give what the recipe read there
// then (recipe.json's expected), with no network. Fixtures come from real builds, copied out of
// a data directory with scripts/recipe-fixtures.ts, so a change to how recipes run is checked
// against every page a recipe was ever written for.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import { openFixture } from '../src/domain/search/recipes/page.ts';
import { checkInvariants, runRecipe } from '../src/domain/search/recipes/run.ts';
import type { ListingRecipe, RecipeListing } from '../src/domain/search/recipes/types.ts';
import { quietLog } from './helpers/deps.ts';

const DIR = fileURLToPath(new URL('./fixtures/listings', import.meta.url));

interface Fixture {
  url: string;
  source: string;
  recipe: ListingRecipe;
  expected: RecipeListing[];
}

const names = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DIR, d.name, 'recipe.json')))
  .map((d) => d.name)
  .sort();

describe('stored recipes replay against their fixtures offline', () => {
  let reader: ReaderPool;
  beforeAll(() => {
    reader = new ReaderPool({ maxContexts: 2, navigationTimeoutMs: 15_000, log: quietLog });
  });
  afterAll(() => reader.close());

  it('has fixtures', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(name, async () => {
      const f = JSON.parse(readFileSync(join(DIR, name, 'recipe.json'), 'utf8')) as Fixture;
      const html = readFileSync(join(DIR, name, 'page.html'), 'utf8');
      const requests: string[] = [];
      const listings = await reader.withPage(async (page) => {
        page.on('requestfinished', (r) => requests.push(r.url()));
        await openFixture(page, f.url, html);
        return (await runRecipe(page, f.recipe, { paginate: false })).listings;
      });
      expect(listings).toEqual(f.expected);
      expect(checkInvariants({ listings, pageUrl: f.url, lastCount: null })).toEqual([]);
      // Nothing but the stored page was served.
      expect(requests.filter((u) => u !== f.url)).toEqual([]);
    });
  }
});
