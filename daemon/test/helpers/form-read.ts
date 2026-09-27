// Runs Read on a page for tests: a fresh context with the read-only guard, the real FormJudge
// over AgentRunner.decide() with a scripted Jev (no claude: unsure answers stay unsure).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { guardReadOnly, type ReadFormResult, readForm } from '../../src/browser/form-read.ts';
import type { FieldSpec, FormRead } from '../../src/browser/form-types.ts';
import { FormJudge } from '../../src/domain/applications/form-judge.ts';
import type { StandardProfile } from '../../src/domain/knowledge/profile.ts';
import { AgentRunner } from '../../src/models/agent-runner.ts';
import type { Decide } from '../../src/models/decide.ts';
import { quietLog } from './deps.ts';
import { type FakeJevOptions, FIXTURE_MEANINGS, fakeJev } from './fake-jev.ts';

/** Synthetic candidate values used for fixtures (never anyone's real data). */
export const FIXTURE_PROFILE: StandardProfile = {
  full_name: 'Alex Placeholder',
  email: 'alex.placeholder@example.com',
  phone: '+30 210 000 0000',
  location: 'Athens, Greece',
  work_authorization: 'Yes',
  salary_expectation: '60000 EUR per year',
  notice_period: '1 month',
  'links.github': 'https://github.com/alex-placeholder',
  'links.website': 'https://alex.example.com',
  'links.linkedin': 'https://www.linkedin.com/in/alex-placeholder',
  base_cv_file: null,
};

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface ReadRun {
  result: ReadFormResult;
  read: FormRead;
  page: Page;
  context: BrowserContext;
  blocked: string[];
  close(): Promise<void>;
}

export interface ReadRunOptions {
  profile?: Partial<StandardProfile>;
  jev?: FakeJevOptions;
  /** Replaces the scripted Jev decisions (HAR replay answers from recorded decisions). */
  decide?: Decide;
  /** Called on the context before Read starts (routeFromHAR, …). */
  prepare?(context: BrowserContext): Promise<void>;
  /** Extra context options (recordHar when recording a fixture). */
  contextOptions?: BrowserContextOptions;
}

export async function runRead(
  browser: Browser,
  url: string,
  o: ReadRunOptions = {},
): Promise<ReadRun> {
  const dir = mkdtempSync(join(tmpdir(), 'applyant-read-'));
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    serviceWorkers: 'block',
    ...o.contextOptions,
  });
  context.setDefaultTimeout(10_000);
  await o.prepare?.(context);
  const guard = await guardReadOnly(context);
  const page = await context.newPage();
  const models = new AgentRunner({
    providers: [],
    runsDir: join(dir, 'runs'),
    workDir: join(dir, 'work'),
    record: () => {},
    log: quietLog,
    jev: fakeJev({ meanings: FIXTURE_MEANINGS, ...o.jev }),
  });
  const ac = new AbortController();
  const judge = new FormJudge({
    decide: o.decide ?? ((role, req) => models.decide(role, req)),
    profile: { ...FIXTURE_PROFILE, ...o.profile },
    job: { title: null, company: null },
    taskId: null,
    signal: ac.signal,
  });
  let result: ReadFormResult;
  try {
    result = await readForm(page, { url, judge, signal: ac.signal });
  } catch (err) {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  if (result.kind !== 'form') {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`no form read at ${url}: ${result.note}`);
  }
  return {
    result,
    read: result.read,
    page,
    context,
    blocked: guard.blocked,
    close: async () => {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The fields of all steps. */
export function allFields(read: FormRead): FieldSpec[] {
  return read.requirements.steps.flatMap((s) => s.fields);
}

export function field(read: FormRead, label: string | RegExp): FieldSpec {
  const f = allFields(read).find((x) =>
    typeof label === 'string' ? x.label === label : label.test(x.label),
  );
  if (!f) {
    throw new Error(
      `no field ${label}; fields: ${allFields(read)
        .map((x) => x.label)
        .join(' | ')}`,
    );
  }
  return f;
}
