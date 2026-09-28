// Calls the real Jev (TypeSafe System One) for the three decision roles, with no fallback
// model: field_classify over a fixture form, option_match, and posting_liveness.
//   APPLYANT_LIVE=1 pnpm test:live -t jev
//
// The key comes from APPLYANT_JEV_KEY, else the `jev` secret the daemon uses: the Keychain
// through applyant-native on a Mac, the file in APPLYANT_HOME elsewhere. It is never printed. The whole file costs a few thousand input tokens ($42 / billion).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import type { NewAgentRunRow } from '../../src/db/schema.ts';
import { FormJudge } from '../../src/domain/applications/form-judge.ts';
import { livenessCheck } from '../../src/domain/search/verify.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { JEV_SECRET, JevClient } from '../../src/models/providers/jev.ts';
import { openNative } from '../../src/native/client.ts';
import { openSecrets } from '../../src/secrets/keychain-backend.ts';
import { addRedaction } from '../../src/util/log.ts';
import { quietLog } from '../helpers/deps.ts';
import { FIXTURE_PROFILE, field, runRead } from '../helpers/form-read.ts';
import { type SiteServer, startSiteServer } from '../helpers/site-server.ts';

const live = process.env.APPLYANT_LIVE === '1';
const POSTING = fileURLToPath(new URL('../fixtures/postings/ai-engineer.txt', import.meta.url));

async function jevKey(): Promise<string | null> {
  const env = process.env.APPLYANT_JEV_KEY?.trim();
  if (env) return env;
  const config = loadConfig();
  const native = openNative({ path: config.nativeHelperPath, log: quietLog });
  try {
    const secrets = await openSecrets({ native, secretsFile: config.secretsFile, log: quietLog });
    return await secrets.get(JEV_SECRET);
  } catch {
    return null;
  } finally {
    await native.close();
  }
}

describe.skipIf(!live)('live jev (decision roles, no fallback)', () => {
  let dir: string;
  let site: SiteServer;
  let browser: Browser;
  let models: AgentRunner;
  const runs: NewAgentRunRow[] = [];

  beforeAll(async () => {
    const key = await jevKey();
    if (!key) throw new Error('no Jev key: set APPLYANT_JEV_KEY or `applyant secrets set jev`');
    addRedaction(key);
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-jev-'));
    models = new AgentRunner({
      // No claude: whatever Jev is unsure about stays unsure, so the test measures Jev alone.
      providers: [],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => {
        runs.push(row);
      },
      log: quietLog,
      jev: new JevClient({ secrets: { get: async (n) => (n === JEV_SECRET ? key : null) } }),
    });
    site = await startSiteServer();
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    const tokens = runs.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
    const cost = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    process.stderr.write(
      `jev: ${runs.length} requests, ${tokens} input tokens, $${cost.toFixed(6)}\n`,
    );
  });

  it('field_classify: Jev reads what a fixture form asks for', async () => {
    const run = await runRead(browser, site.url('/form-conditional.html'), {
      profile: { work_authorization: 'No' },
      decide: (role, req) => models.decide(role, req),
    });
    try {
      const meaning = (label: string) => field(run.read, label).meaning;
      expect(meaning('Are you legally authorized to work in the European Union?')).toBe(
        'work_authorization',
      );
      expect(meaning('Will you require visa sponsorship?')).toBe('visa_sponsorship');
      expect(meaning('Resume/CV')).toBe('resume');
      expect(meaning('LinkedIn Profile')).toBe('linkedin');
      expect(meaning('Why do you want to join Acme AI?')).toBe('question');
      expect(meaning('Gender')).toBe('eeo');
      expect(run.read.requirements.steps[0]?.isFinal).toBe(true);
    } finally {
      await run.close();
    }
    expect(site.writes).toEqual([]);
    expect(runs.every((r) => r.provider === 'jev' && r.outcome === 'ok')).toBe(true);
  });

  it('option_match: a free-text answer picks the right option', async () => {
    const judge = new FormJudge({
      decide: (role, req) => models.decide(role, req),
      profile: FIXTURE_PROFILE,
      job: { title: 'Senior AI Engineer', company: 'Acme AI' },
      taskId: null,
      signal: new AbortController().signal,
    });
    const workAuth = {
      label: 'Are you legally authorized to work in the European Union?',
    } as Parameters<FormJudge['matchOption']>[0];
    expect(
      await judge.matchOption(workAuth, ['Yes', 'No'], 'EU citizen, no sponsorship needed'),
    ).toBe('Yes');
    const country = { label: 'Which country will you work from?' } as Parameters<
      FormJudge['matchOption']
    >[0];
    expect(
      await judge.matchOption(
        country,
        ['Athens, Attica, Greece', 'Athens, Georgia, United States', 'Nicosia, Cyprus'],
        'Athens, Greece',
      ),
    ).toBe('Athens, Attica, Greece');
  });

  it('posting_liveness: an open posting stays, a closed one is dead', async () => {
    const decide = models.decide.bind(models);
    const o = { taskId: null, signal: new AbortController().signal };
    const text = readFileSync(POSTING, 'utf8');
    expect(
      await livenessCheck(
        decide,
        { url: 'https://jobs.example.com/1', title: 'Senior AI Engineer', text },
        o,
      ),
    ).toEqual({ dead: false, note: null });
    const closed = await livenessCheck(
      decide,
      {
        url: 'https://jobs.example.com/2',
        title: 'Senior AI Engineer',
        text: 'Senior AI Engineer at Acme AI.\nThis position has been filled and we are no longer accepting applications. Browse our other open roles.',
      },
      o,
    );
    expect(closed.dead).toBe(true);
    expect(closed.note).toMatch(/^jev: the page reads as closed/);
  });
});
