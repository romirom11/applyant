#!/usr/bin/env node
// pnpm -C daemon fixtures:record <url> [--name <name>] [--about <text>] [--source public|synthetic]
//                                      [--no-claude]
//
// Records an application form for the offline corpus (test/fixtures/forms/<name>/):
// runs Read on the live page with a synthetic profile and the real decision models (Jev,
// falling back to claude:haiku), keeps the network as a HAR and the decisions as JSON, and
// then replays it offline to check the recording reproduces the same result.
//
// Read never sends anything (browser/form-read.ts guardReadOnly): nothing is submitted, typed
// values aren't autosaved, files aren't uploaded. Only public application forms belong here.
//
// The Jev key comes from APPLYANT_JEV_KEY or the `jev` secret of APPLYANT_HOME (default data
// dir); it is only ever sent to Jev.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.ts';
import { AgentRunner } from '../src/models/agent-runner.ts';
import type { Decision } from '../src/models/decide.ts';
import { ClaudeProvider } from '../src/models/providers/claude.ts';
import { JEV_SECRET, JevClient } from '../src/models/providers/jev.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import { addRedaction, createLogger } from '../src/util/log.ts';
import {
  FORMS_DIR,
  type FormFixture,
  recordingDecide,
  replayFixture,
} from '../test/helpers/form-fixtures.ts';
import { FIXTURE_PROFILE, runRead } from '../test/helpers/form-read.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    about: { type: 'string' },
    source: { type: 'string', default: 'public' },
    'no-claude': { type: 'boolean', default: false },
  },
});
const url = positionals[0];
if (!url) {
  process.stderr.write('usage: pnpm fixtures:record <url> [--name <name>] [--about <text>]\n');
  process.exit(2);
}
const source = values.source === 'synthetic' ? 'synthetic' : 'public';
const name =
  values.name ??
  new URL(url).pathname
    .split('/')
    .filter(Boolean)
    .slice(0, 2)
    .concat(new URL(url).hostname.split('.').slice(-2, -1))
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
const dir = join(FORMS_DIR, name);
mkdirSync(dir, { recursive: true });

const log = createLogger({ svc: 'fixtures-record' });
const envKey = process.env.APPLYANT_JEV_KEY?.trim();
if (envKey) addRedaction(envKey);
const secrets = envKey
  ? { get: async (n: string) => (n === JEV_SECRET ? envKey : null) }
  : new FileSecrets(loadConfig().secretsFile);
const work = mkdtempSync(join(tmpdir(), 'applyant-record-'));
const models = new AgentRunner({
  providers: values['no-claude'] ? [] : [new ClaudeProvider()],
  runsDir: join(work, 'runs'),
  workDir: join(work, 'work'),
  record: (row) =>
    process.stderr.write(
      `  ${row.role} · ${row.provider} · ${row.inputTokens ?? '?'} tokens · ${row.outcome}\n`,
    ),
  log,
  jev: new JevClient({ secrets }),
});
if (!(await new JevClient({ secrets }).available())) {
  process.stderr.write('No Jev key: decisions go to the fallback model only.\n');
}

const decisions: Record<string, Decision> = {};
const browser = await chromium.launch({ headless: true });
try {
  process.stderr.write(`Reading ${url} (read-only)…\n`);
  const run = await runRead(browser, url, {
    profile: FIXTURE_PROFILE,
    decide: recordingDecide((role, req) => models.decide(role, req), decisions),
    contextOptions: { recordHar: { path: join(dir, 'page.har.zip'), mode: 'minimal' } },
  });
  const read = run.read;
  const blocked = run.blocked.length;
  await run.close(); // writes the HAR
  const fixture: FormFixture = {
    name,
    url,
    source,
    about: values.about ?? new URL(url).hostname,
    recordedAt: new Date().toISOString(),
    profile: FIXTURE_PROFILE,
    decisions,
    expected: read,
  };
  writeFileSync(join(dir, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  const fields = read.requirements.steps.flatMap((s) => s.fields);
  process.stderr.write(
    `Recorded ${name}: ${read.requirements.steps.length} step(s), ${fields.length} fields, ${Object.keys(decisions).length} decisions, ${blocked} write request(s) blocked.\n`,
  );

  process.stderr.write('Replaying offline…\n');
  const replay = await replayFixture(browser, dir, fixture);
  const same = JSON.stringify(replay.read) === JSON.stringify(read);
  if (replay.misses.length)
    process.stderr.write(`  decisions missing on replay: ${replay.misses.length}\n`);
  if (!same || replay.misses.length) {
    process.stderr.write('  replay differs from the live read: this fixture is not reproducible\n');
    process.exitCode = 1;
  } else {
    process.stderr.write(`  replay matches. Fixture: ${dir}\n`);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
