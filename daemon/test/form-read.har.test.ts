// Every recorded form (test/fixtures/forms/*, made by `pnpm fixtures:record <url>`) is read
// again offline: the page from its HAR (anything not recorded is aborted, so no network), the
// decisions from the recording (no model). The result must equal what was recorded, so any
// change to the form reader runs against the whole corpus.
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFixtures, replayFixture } from './helpers/form-fixtures.ts';
import { allFields } from './helpers/form-read.ts';

const fixtures = listFixtures();
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe('recorded application forms replay offline', () => {
  it('has recordings of each ATS', () => {
    const hosts = fixtures.map((f) => new URL(f.fixture.url).hostname);
    expect(hosts).toEqual(
      expect.arrayContaining([
        'job-boards.greenhouse.io',
        'jobs.ashbyhq.com',
        'jobs.lever.co',
        'apply.workable.com',
      ]),
    );
  });

  for (const { dir, fixture } of fixtures) {
    it(`${fixture.name} (${fixture.source}: ${fixture.about})`, async () => {
      const replay = await replayFixture(browser, dir, fixture);
      expect(replay.misses).toEqual([]);
      expect(replay.read).toEqual(fixture.expected);
      // Sanity on what was recorded: a form with a final step Read did not press.
      const steps = fixture.expected.requirements.steps;
      expect(steps.at(-1)?.isFinal).toBe(true);
      expect(allFields(fixture.expected).length).toBeGreaterThan(5);
    }, 180_000);
  }
});
