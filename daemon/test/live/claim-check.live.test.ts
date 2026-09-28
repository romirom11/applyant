// The real claim_verifier (claude:haiku) on the laundering fixture: the candidate's unrelated
// dashboard commit must not support another author's features, and a matching commit must.
//   APPLYANT_LIVE=1 pnpm test:live -t claim_verifier
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/domain/knowledge/claim-check.ts';
import { readGithubSource } from '../../src/domain/knowledge/sources/github.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { ClaudeProvider } from '../../src/models/providers/claude.ts';
import { quietLog } from '../helpers/deps.ts';
import {
  buildLaunderingRepo,
  CANDIDATE_IDS,
  CONTROL_CLAIM,
  FEATURE_CLAIM,
  type LaunderingRepo,
} from '../helpers/laundering-repo.ts';

const live = process.env.APPLYANT_LIVE === '1';

describe.skipIf(!live)('live claim_verifier (real claude:haiku)', () => {
  let dir: string;
  let repo: LaunderingRepo;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-claims-'));
    repo = buildLaunderingRepo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('claim_verifier rejects an unrelated candidate commit cited for others’ work', async () => {
    const m = await readGithubSource(repo.path, {
      reposDir: join(dir, 'repos'),
      identities: CANDIDATE_IDS,
      signal: new AbortController().signal,
      log: quietLog,
      gh: repo.gh,
    });
    const refs = m.authorship?.refs ?? new Map();
    const detail = (key: string | undefined) => {
      const r = refs.get(key ?? '');
      if (!r) throw new Error(`no ref ${key}`);
      return r;
    };
    const runs: Array<Record<string, unknown>> = [];
    const runner = new AgentRunner({
      providers: [new ClaudeProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => runs.push(row),
      log: quietLog,
    });
    const res = await checkClaims(
      [
        { text: FEATURE_CLAIM, kind: 'personal_contribution', refs: [detail(repo.shas[0])] },
        { text: CONTROL_CLAIM, kind: 'personal_contribution', refs: [detail(repo.shas[4])] },
        // Via the candidate's real PR: still only the dashboard fix.
        {
          text: 'Added cross-call prompt caching with a static-prefix request layout',
          kind: 'personal_contribution',
          refs: [detail('pr:131')],
        },
      ],
      runner,
      { taskId: null, signal: new AbortController().signal },
    );
    process.stdout.write(`\n${JSON.stringify(res, null, 1)}\n${JSON.stringify(runs[0])}\n`);
    if (res.kind !== 'ok') throw new Error(`claim check did not run: ${JSON.stringify(res)}`);
    expect(res.verdicts[0]?.supported).toBe(false);
    expect(res.verdicts[1]?.supported).toBe(true);
    expect(res.verdicts[2]?.supported).toBe(false);
    expect(runs[0]).toMatchObject({ role: 'claim_verifier', provider: 'claude', outcome: 'ok' });
    expect(String(runs[0]?.model)).toMatch(/haiku/);
  });
});
