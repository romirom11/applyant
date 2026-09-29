// Applications for tests: a synthetic form, a synthetic candidate (never anyone's real data),
// facts, and a scripted `claude` that plays application_writer, claim_verifier, the
// option_match fallback, form_agent and the interviewer. Everything runs through the real
// queue and handlers.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldKind, FieldMeaning, FieldSpec, FormRead } from '../../src/browser/form-types.ts';
import { ReaderPool } from '../../src/browser/reader-pool.ts';
import { SubmitProfile } from '../../src/browser/submit-profile.ts';
import { TaskPages } from '../../src/browser/task-pages.ts';
import { WebFormChannel } from '../../src/channels/web-form.ts';
import type { Db } from '../../src/db/client.ts';
import { directExec } from '../../src/db/read-pool.ts';
import { facts, postings } from '../../src/db/schema.ts';
import type { Deps } from '../../src/deps.ts';
import { CV_SYSTEM } from '../../src/domain/applications/cv/select.ts';
import { deliverApplication } from '../../src/domain/applications/deliver.ts';
import { prepareApplication } from '../../src/domain/applications/prepare.ts';
import { researchCompany } from '../../src/domain/companies/research.ts';
import { embedFacts } from '../../src/domain/knowledge/embed-index.ts';
import { interviewOpen, interviewTurn } from '../../src/domain/knowledge/interview-agent.ts';
import { type StandardKey, setProfileValue } from '../../src/domain/knowledge/profile.ts';
import { createProject } from '../../src/domain/knowledge/projects.ts';
import { McpHub } from '../../src/mcp/server.ts';
import { browserTools } from '../../src/mcp/tools/browser.ts';
import { knowledgeTools } from '../../src/mcp/tools/knowledge.ts';
import type { ProviderRequest, ProviderResult } from '../../src/models/agent-runner.ts';
import { HashEmbedder } from '../../src/models/embeddings.ts';
import { FakeProvider } from '../../src/models/providers/fake.ts';
import type { Draft } from '../../src/models/schemas/application.ts';
import type { CvPlanOutput } from '../../src/models/schemas/cv.ts';
import type { InterviewOutput } from '../../src/models/schemas/interview.ts';
import { EventBus } from '../../src/queue/events.ts';
import { Worker } from '../../src/queue/worker.ts';
import type { TempDb } from './db.ts';
import { handlers, quietLog, testDeps } from './deps.ts';

const ROLE: Record<FieldKind, string> = {
  text: 'textbox',
  textarea: 'textbox',
  select: 'combobox',
  combobox: 'combobox',
  radio: 'radiogroup',
  checkbox: 'checkbox',
  file: 'button',
  date: 'textbox',
  group: 'button',
  unknown: 'generic',
};

export function spec(
  label: string,
  kind: FieldKind,
  o: {
    meaning?: FieldMeaning | null;
    required?: boolean;
    options?: string[];
    revealedBy?: { label: string; kind: FieldKind; value: string };
  } = {},
): FieldSpec {
  return {
    ref: { frame: [], role: ROLE[kind], name: label, nth: 0, css: null },
    label,
    kind,
    required: o.required ?? false,
    options: o.options ?? null,
    meaning: o.meaning === undefined ? null : o.meaning,
    revealedBy: o.revealedBy
      ? {
          ref: {
            frame: [],
            role: ROLE[o.revealedBy.kind],
            name: o.revealedBy.label,
            nth: 0,
            css: null,
          },
          value: o.revealedBy.value,
        }
      : null,
  };
}

export function form(
  fields: FieldSpec[],
  url = 'https://jobs.example.test/acme/1/apply',
): FormRead {
  return {
    url,
    requirements: { steps: [{ fields, advance: null, isFinal: true }] },
    notes: [],
  };
}

/** A synthetic candidate; tests set only what they need. */
export const SYNTHETIC_PROFILE: Partial<Record<StandardKey, string>> = {
  full_name: 'Jordan Testperson',
  email: 'jordan.testperson@example.test',
  phone: '+30 210 555 0100',
  location: 'Thessaloniki, Greece',
  work_authorization: 'EU citizen, authorised to work anywhere in the EU',
  salary_expectation: '60000 EUR per year',
  notice_period: '1 month',
  'links.github': 'https://github.com/jordan-testperson',
  'links.linkedin': 'https://www.linkedin.com/in/jordan-testperson',
  'links.website': 'https://jordan.example.test',
};

export function setProfile(db: Db, values: Partial<Record<StandardKey, string | null>>, now: Date) {
  for (const [k, v] of Object.entries(values)) setProfileValue(db, k, v ?? null, now);
}

export interface SeededFacts {
  projectId: number;
  pipeline: number;
  team: number;
  oss: number;
  other: number;
}

/** Project "Harbor" (2021–2024) with a few facts of different status. */
export function seedFacts(db: Db, now: Date): SeededFacts {
  const p = createProject(db, { name: 'Harbor', period: '2021–2024', stack: ['Python'] }, now);
  createProject(db, { name: 'Lantern', period: '2019–2020', summary: 'A side project' }, now);
  const add = (text: string, status: 'confirmed' | 'unconfirmed', kind = 'personal_contribution') =>
    db
      .insert(facts)
      .values({
        projectId: p.id,
        text,
        kind: kind as 'personal_contribution',
        status,
        origin: 'extracted',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: facts.id })
      .get().id;
  return {
    projectId: p.id,
    pipeline: add(
      'Built the Python call-analysis pipeline that transcribes and scores support calls',
      'confirmed',
    ),
    team: add('Led a team of 4 engineers on the call-analysis platform', 'unconfirmed', 'role'),
    oss: add(
      'Maintains an open-source Python library for audio chunking with merged outside pull requests',
      'confirmed',
    ),
    other: add('Wrote the billing export job for the finance team', 'confirmed'),
  };
}

export function seedPosting(
  db: Db,
  read: FormRead,
  o: {
    text?: string;
    now: Date;
    stage?: 'scored' | 'verified';
    /** Requirement matches from scoring (the writer's "matched" layer). */
    matches?: Array<{ text: string; factIds: number[] }>;
  },
): number {
  return db
    .insert(postings)
    .values({
      stage: o.stage ?? 'scored',
      canonicalUrl: `https://jobs.example.test/acme/${Math.random().toString(36).slice(2)}`,
      title: 'Senior AI Engineer',
      company: 'Acme AI',
      verifiedAt: o.now,
      text:
        o.text ??
        'Acme AI builds call analytics. You will build production LLM systems in Python. Start your first written answer with the phrase "Harbor lights ahead".',
      score: 86,
      form: read,
      formStatus: 'verified',
      formNote: '1 step',
      formReadAt: o.now,
      applyUrl: read.url,
      matches: (o.matches ?? []).map((m, i) => ({
        text: m.text,
        must: true,
        verdict: 'strong' as const,
        factIds: m.factIds,
        note: null,
        key: `k${i}`,
      })),
    })
    .returning({ id: postings.id })
    .get().id;
}

// ---- the scripted claude ------------------------------------------------------------------

export interface WriterQuestionSeen {
  id: string;
  label: string;
  kind: string;
}

export interface Script {
  /** Drafts per question; the default answers written questions with one uncited sentence. */
  drafts?(questions: WriterQuestionSeen[], req: ProviderRequest): Draft[] | Promise<Draft[]>;
  /** Verifier verdict per sentence text; default: supported. */
  verdict?(sentence: string): { supported: boolean; issue: string; note: string };
  /** option_match: which option the profile answer means; default: the "doesn't settle it" option. */
  option?(label: string, answer: string, options: string[]): string | null;
  /** form_agent (phase 6): the field- or step-scoped run; default: refuses (done: false). */
  formAgent?(req: ProviderRequest): ProviderResult | Promise<ProviderResult>;
  /** The CV plan (phase 7); default: `defaultCvPlan` over the facts the prompt lists. */
  cv?(seen: CvPromptSeen, req: ProviderRequest): CvPlanOutput | Promise<CvPlanOutput>;
  /** The interviewer (phase 9); default: saves nothing and asks nothing more. */
  interview?(req: ProviderRequest): InterviewOutput | Promise<InterviewOutput>;
}

export interface CvPromptSeen {
  projects: Array<{ slug: string; facts: Array<{ id: number; text: string }> }>;
  general: Array<{ id: number; text: string }>;
}

/** The projects and facts a CV prompt lists (`[slug] Name` then `  #12 [kind · …] text`). */
export function cvPromptSeen(prompt: string): CvPromptSeen {
  const seen: CvPromptSeen = { projects: [], general: [] };
  let into: Array<{ id: number; text: string }> | null = null;
  for (const line of prompt.split('\n')) {
    const p = /^\[([^\]]+)\] /.exec(line);
    if (p) {
      const project = { slug: p[1] ?? '', facts: [] as Array<{ id: number; text: string }> };
      seen.projects.push(project);
      into = project.facts;
      continue;
    }
    if (line.startsWith('Facts tied to no project')) {
      into = seen.general;
      continue;
    }
    const f = /^ {2}#(\d+) \[[^\]]*\] (.+)$/.exec(line);
    if (f && into) into.push({ id: Number(f[1]), text: f[2] ?? '' });
  }
  return seen;
}

/** Each project's facts as its bullets (verbatim), the first fact as the summary. */
export function defaultCvPlan(seen: CvPromptSeen): CvPlanOutput {
  const first = seen.projects.flatMap((p) => p.facts)[0] ?? seen.general[0];
  return {
    summary: first ? [{ text: first.text, factIds: [first.id] }] : [],
    projects: seen.projects
      .filter((p) => p.facts.length)
      .map((p) => ({
        project: p.slug,
        bullets: p.facts.map((f) => ({ text: f.text, factIds: [f.id] })),
      })),
    education: [],
    skills: ['Python'],
  };
}

export function writerQuestions(prompt: string): WriterQuestionSeen[] {
  return [...prompt.matchAll(/^\[(q\d+)\] \(([^,)]+)[^)]*\) (.+)$/gm)].map((m) => ({
    id: m[1] ?? '',
    kind: (m[2] ?? '').startsWith('choice') ? 'choice' : 'text',
    label: m[3] ?? '',
  }));
}

export function scriptedClaude(script: Script = {}) {
  const requests: ProviderRequest[] = [];
  const reply = async (req: ProviderRequest): Promise<ProviderResult> => {
    requests.push(req);
    const ok = (output: unknown): ProviderResult => ({
      kind: 'ok',
      output,
      model: req.model,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    });
    if (req.role === 'application_writer' && req.system === CV_SYSTEM) {
      const seen = cvPromptSeen(req.prompt);
      return ok((await script.cv?.(seen, req)) ?? defaultCvPlan(seen));
    }
    if (req.role === 'application_writer') {
      const questions = writerQuestions(req.prompt);
      const drafts =
        (await script.drafts?.(questions, req)) ??
        questions.map((q) => ({
          question: q.id,
          status: 'answered' as const,
          choice: null,
          sentences: [{ text: 'I would love to work on this.', factIds: [] }],
          missing: null,
          adaptedFrom: null,
        }));
      return ok({ drafts });
    }
    if (req.role === 'claim_verifier') {
      const sentences = [...req.prompt.matchAll(/^Sentence (\d+): (.+)$/gm)];
      return ok({
        checks: sentences.map((m) => {
          const v = script.verdict?.(m[2] ?? '') ?? { supported: true, issue: 'none', note: 'ok' };
          return { sentence: Number(m[1]), ...v };
        }),
      });
    }
    if (req.role === 'option_match') {
      const blocks = req.prompt.split(/\n(?=\[o\d+\] )/).filter((b) => /^\[o\d+\] /.test(b));
      const answers = blocks.map((b) => {
        const id = /^\[(o\d+)\]/.exec(b)?.[1] ?? '';
        const label = /"form_field": "([^"]*)"/.exec(b)?.[1] ?? '';
        const answer = /"applicants_answer_on_file": "([^"]*)"/.exec(b)?.[1] ?? '';
        const options = [...b.matchAll(/^ {2}- ([^:\n]+?)(?::.*)?$/gm)].map((m) => m[1] ?? '');
        const real = options.filter((x) => x !== '__none__');
        const pick = script.option?.(label, answer, real) ?? null;
        return { question: id, choice: pick && real.includes(pick) ? pick : '__none__' };
      });
      return ok({ answers });
    }
    if (req.role === 'interviewer') {
      return ok((await script.interview?.(req)) ?? { facts: [], question: null, about: null });
    }
    if (req.role === 'form_agent') {
      return (
        (await script.formAgent?.(req)) ??
        ok({ done: false, note: 'no script for this form_agent run' })
      );
    }
    return { kind: 'error', message: `scripted claude: no script for ${req.role}`, usage: null };
  };
  return { provider: new FakeProvider('claude', [], reply), requests };
}

// ---- a worker with the prepare handler ----------------------------------------------------

export interface PrepareHarness {
  worker: Worker;
  bus: EventBus;
  hub: McpHub;
  claude: ReturnType<typeof scriptedClaude>;
  submit: SubmitProfile;
  taskPages: TaskPages;
  /** The headless reader (launched on first use): tailored CVs are printed through it. */
  reader: ReaderPool;
  stop(): Promise<void>;
}

export interface PrepareHarnessOptions {
  /** The submission browser runs headless unless a test needs to see (or minimise) a window. */
  headless?: boolean;
  /** A scripted codex (researcher, phase 12); without one there's no provider for research. */
  codex?: FakeProvider;
  /** Extra handler dependencies (phase 14: the captcha solver, platform guardrails). */
  deps?: Partial<Deps>;
}

/**
 * A worker with prepare_application and deliver_application, so a test can run the whole
 * pipeline: prepare → review → approve → deliver. The submission browser is real (Playwright
 * chromium, headless by default) so delivery tests exercise the actual form engine.
 */
export async function prepareHarness(
  t: TempDb,
  script: Script = {},
  o: PrepareHarnessOptions = {},
): Promise<PrepareHarness> {
  const bus = new EventBus();
  const claude = scriptedClaude(script);
  const embedder = new HashEmbedder();
  const taskPages = new TaskPages();
  const hub = new McpHub({
    tools: [
      ...knowledgeTools({ read: t.read, readPool: directExec(t.read), embedder }),
      ...browserTools(taskPages),
    ],
    log: quietLog,
  });
  await hub.start();
  const submit = new SubmitProfile({
    userDataDir: join(t.dir, 'browser'),
    log: quietLog,
    headless: o.headless ?? true,
  });
  const reader = new ReaderPool({ maxContexts: 1, navigationTimeoutMs: 15_000, log: quietLog });
  const deps = testDeps({
    dir: t.dir,
    db: t.db,
    providers: [claude.provider, ...(o.codex ? [o.codex] : [])],
    read: t.read,
    embedder,
    mcp: hub,
    submit,
    taskPages,
    reader,
  });
  deps.channels.web_form = new WebFormChannel({
    reader: deps.reader,
    submit,
    taskPages,
    models: deps.models,
    mcp: hub,
    snapshotsDir: join(t.dir, 'handoffs'),
  });
  Object.assign(deps, o.deps ?? {});
  const worker = new Worker({
    db: t.db,
    read: t.read,
    bus,
    deps,
    handlers: handlers({
      prepare_application: prepareApplication,
      deliver_application: deliverApplication,
      embed_facts: embedFacts,
      interview_open: interviewOpen,
      interview_turn: interviewTurn,
      research_company: researchCompany,
    }),
    log: quietLog,
    concurrency: 1,
    leaseMs: 60_000,
    pollMs: 10,
    maxAttempts: 3,
  });
  worker.start();
  return {
    worker,
    bus,
    hub,
    claude,
    submit,
    taskPages,
    reader,
    async stop() {
      await worker.stop();
      await hub.close();
      await submit.close();
      await reader.close();
    },
  };
}

/** A small real file to stand in for the candidate's CV. */
export function cvFile(dir: string): string {
  const path = join(dir, 'cv.pdf');
  writeFileSync(path, '%PDF-1.4\n%%EOF\n');
  return path;
}
