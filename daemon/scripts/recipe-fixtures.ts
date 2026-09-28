#!/usr/bin/env node
// Copies a stored listing recipe, with the page it was built from and what it read there, from
// a data directory into test/fixtures/listings/<name>/, so recipes.fixtures.test.ts replays it
// offline from then on. Read-only on the database; nothing is fetched.
//
//   APPLYANT_HOME=<data dir> node scripts/recipe-fixtures.ts <source key | id | locator> <name>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { closeDb, openReadDb } from '../src/db/client.ts';
import { recipeRow } from '../src/domain/search/recipes/store.ts';
import { findSource } from '../src/domain/search/sources.ts';

const OUT = fileURLToPath(new URL('../test/fixtures/listings', import.meta.url));

const [ref, name] = process.argv.slice(2);
if (!ref || !name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  process.stderr.write(
    'usage: APPLYANT_HOME=<dir> node scripts/recipe-fixtures.ts <source> <name (a-z0-9-)>\n',
  );
  process.exit(2);
}
const db = openReadDb(loadConfig().dbPath);
try {
  const source = findSource(db, ref);
  if (!source) throw new Error(`no search source "${ref}"`);
  const row = recipeRow(db, source.id);
  if (!row?.recipe || !row.fixtureHtml || !row.fixtureUrl || !row.expected) {
    throw new Error(
      `${source.key} has no stored recipe with its page (status ${row?.status ?? 'none'})`,
    );
  }
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.html'), row.fixtureHtml);
  writeFileSync(
    join(dir, 'recipe.json'),
    `${JSON.stringify(
      {
        url: row.fixtureUrl,
        source: source.key,
        builtAt: row.builtAt?.toISOString() ?? null,
        recipe: row.recipe,
        expected: row.expected,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${dir}: ${row.expected.length} listings\n`);
} finally {
  closeDb(db);
}
