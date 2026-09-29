// The real researcher (codex with live web search) on a well-known company: a sourced profile
// the validation accepts, with its red flags (if any) printed for a human to check.
//   APPLYANT_LIVE=1 pnpm test:live -t researcher
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewAgentRunRow } from '../../src/db/schema.ts';
import {
  normaliseResearch,
  RESEARCHER_SYSTEM,
  researchPrompt,
  validateResearch,
} from '../../src/domain/companies/research.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { CodexProvider } from '../../src/models/providers/codex.ts';
import { COMPANY_SECTIONS, companyResearchSchema } from '../../src/models/schemas/company.ts';
import { quietLog } from '../helpers/deps.ts';

const live = process.env.APPLYANT_LIVE === '1';

describe.skipIf(!live)('live researcher (real codex CLI, web search)', () => {
  let dir: string;
  let runner: AgentRunner;
  const runs: NewAgentRunRow[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-researcher-'));
    runner = new AgentRunner({
      providers: [new CodexProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => runs.push(row),
      log: quietLog,
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('researches a company: every finding sourced, red flags in their own block', async () => {
    const res = await runner.run('researcher', {
      schema: companyResearchSchema,
      system: RESEARCHER_SYSTEM,
      prompt: researchPrompt({ name: 'Grafana Labs' }, [
        {
          title: 'Senior Software Engineer, Loki',
          url: 'https://job-boards.greenhouse.io/grafanalabs',
          summary: 'Build the Loki log aggregation system; remote in EMEA.',
        },
      ]),
      taskId: null,
      signal: new AbortController().signal,
      validate: validateResearch,
      webSearch: true,
    });
    expect(res.kind, res.kind === 'failed' ? res.reason : '').toBe('ok');
    if (res.kind !== 'ok') return;
    expect(runs.at(-1)).toMatchObject({ role: 'researcher', provider: 'codex', outcome: 'ok' });
    const p = normaliseResearch(res.output);
    expect(p.summary.toLowerCase()).toMatch(/observab|grafana|monitor/);
    const findings = COMPANY_SECTIONS.flatMap((s) => p[s]);
    expect(findings.length).toBeGreaterThanOrEqual(5);
    for (const f of [...findings, ...p.redFlags]) {
      expect(f.sources.length).toBeGreaterThan(0);
      for (const u of f.sources) expect(u).toMatch(/^https?:\/\//);
    }
    process.stdout.write(
      `researcher: ${findings.length} findings in ${COMPANY_SECTIONS.filter((s) => p[s].length).join(', ')}\n` +
        `summary: ${p.summary}\n` +
        `red flags: ${p.redFlags.map((f) => `${f.kind}/${f.severity}: ${f.text} <${f.sources.join(' ')}>`).join(' | ') || 'none'}\n` +
        `note: ${p.note ?? '-'}\n` +
        `duration: ${((runs.at(-1)?.durationMs ?? 0) / 1000).toFixed(0)} s\n`,
    );
  });
});
