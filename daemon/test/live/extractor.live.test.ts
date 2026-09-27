// Runs the real `claude` CLI (this machine's subscription) once, as the extractor role, on
// the fixture CV. APPLYANT_LIVE=1 pnpm test:live -t extractor
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRACTOR_SYSTEM, extractorPrompt } from '../../src/domain/knowledge/extract-prompt.ts';
import { readFileSource } from '../../src/domain/knowledge/sources/file.ts';
import { prepareFacts, validateExtraction } from '../../src/domain/knowledge/sync.ts';
import { NodeTextExtractor } from '../../src/domain/knowledge/text/extract.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import { ClaudeProvider } from '../../src/models/providers/claude.ts';
import { sourceExtractionSchema } from '../../src/models/schemas/index.ts';
import { quietLog } from '../helpers/deps.ts';

const CV = fileURLToPath(new URL('../fixtures/cv/cv.pdf', import.meta.url));
const live = process.env.APPLYANT_LIVE === '1';

describe.skipIf(!live)('live extractor (real claude)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-live-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extractor turns the fixture CV into faithful facts with page evidence', async () => {
    const material = await readFileSource(CV, new NodeTextExtractor());
    const runs: Array<Record<string, unknown>> = [];
    const runner = new AgentRunner({
      providers: [new ClaudeProvider()],
      runsDir: join(dir, 'runs'),
      workDir: join(dir, 'work'),
      record: (row) => runs.push(row),
      log: quietLog,
    });
    const progress: string[] = [];
    const res = await runner.run('extractor', {
      schema: sourceExtractionSchema,
      system: EXTRACTOR_SYSTEM,
      prompt: extractorPrompt({ kind: 'file', material, project: null, knownProjects: [] }),
      taskId: null,
      signal: new AbortController().signal,
      progress: (m) => progress.push(m),
      validate: validateExtraction,
    });
    if (res.kind !== 'ok') {
      const log = runs[0]?.logPath
        ? readFileSync(String(runs[0].logPath), 'utf8').slice(-4000)
        : '';
      throw new Error(`extractor did not succeed: ${JSON.stringify(res)}\n${log}`);
    }
    const out = res.output;
    const { facts } = prepareFacts(out, material);
    process.stdout.write(
      `\n${out.projects.map((p) => `project ${p.name} · ${p.role} · ${p.period}`).join('\n')}\n${facts
        .map(
          (f) =>
            `${f.kind.padEnd(22)} ${f.project ?? '-'} · ${f.text}  [${f.evidence.map((e) => e.locator).join('; ')}]`,
        )
        .join('\n')}\n${JSON.stringify(runs[0])}\n`,
    );

    // Projects: both positions, with their periods as written.
    const project = (s: string) => out.projects.find((p) => p.name.toLowerCase().includes(s));
    expect(project('nightingale')?.period).toMatch(/2021.2024/);
    expect(project('ledgerly')?.period).toMatch(/2018.2021/);

    expect(facts.length).toBeGreaterThanOrEqual(8);
    // Every fact cites a page of the CV.
    for (const f of facts) {
      expect(f.evidence.length, f.text).toBeGreaterThan(0);
      expect(
        f.evidence.some((e) => /page [12]/i.test(e.locator ?? '')),
        f.text,
      ).toBe(true);
    }
    // Numbers are never invented or changed: every number in a fact is in the CV.
    const cvNumbers = new Set(material.text.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+/g) ?? []);
    for (const f of facts) {
      for (const n of f.text.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+/g) ?? []) {
        expect(cvNumbers.has(n), `"${n}" in "${f.text}"`).toBe(true);
      }
    }
    const texts = facts.map((f) => f.text.toLowerCase());
    expect(texts.some((t) => t.includes('team of 4'))).toBe(true);
    expect(texts.some((t) => /20,?000/.test(t))).toBe(true);
    expect(facts.some((f) => f.kind === 'education')).toBe(true);
    expect(
      facts.find((f) => f.text.toLowerCase().includes('pipeline'))?.project?.toLowerCase(),
    ).toContain('nightingale');

    expect(runs[0]).toMatchObject({ role: 'extractor', provider: 'claude', outcome: 'ok' });
    expect(String(runs[0]?.model)).toMatch(/sonnet/);
    // A two-page CV is a few thousand tokens. Far more means something (claude.ai connectors,
    // user settings) leaked into the run's context.
    expect(Number(runs[0]?.inputTokens)).toBeLessThan(60_000);
    expect(progress[0]).toMatch(/extractor · claude:sonnet · started/);
  });
});
