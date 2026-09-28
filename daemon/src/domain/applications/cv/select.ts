// The tailored CV's content: application_writer picks which projects lead, which facts become
// bullets, how the summary reads and which skills come first, for one posting. It sees
// confirmed facts only (never team_context: that is other people's work), and every line
// cites the facts it rests on. Lines are then checked like answer sentences (numbers without a
// model, then claim_verifier); a line that fails, or whose fact stops being confirmed, is left
// out of the CV and listed as dropped, rather than flagged for approval.
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Conn } from '../../../db/client.ts';
import {
  type CvDroppedLine,
  type CvLine,
  type CvPlan,
  type FactKind,
  type FactStatus,
  facts,
  type PostingRow,
  projects,
} from '../../../db/schema.ts';
import type { AgentRunner } from '../../../models/agent-runner.ts';
import type { Provider } from '../../../models/roles.ts';
import { type CvPlanOutput, cvPlanSchema } from '../../../models/schemas/cv.ts';
import { type FactRef, factLine } from '../../knowledge/retrieve.ts';
import type { SentenceResult, SentenceToCheck } from '../checks/verify.ts';
import { FLAG_TEXT } from '../store.ts';

/** Confirmed facts one CV run sees at most: the matcher's evidence first, then by kind. */
export const CV_FACT_LIMIT = 300;
export const CV_POSTING_TEXT_LIMIT = 6_000;

const KIND_ORDER: FactKind[] = [
  'personal_contribution',
  'impact',
  'role',
  'skill',
  'education',
  'other',
];

export interface CvProject {
  id: number;
  slug: string;
  name: string;
  period: string | null;
  facts: FactRef[];
}

export interface CvContext {
  job: {
    title: string | null;
    company: string | null;
    summary: string | null;
    requirements: Array<{ text: string; must: boolean }>;
    text: string | null;
  };
  /** Projects with at least one confirmed fact, in the candidate's order. */
  projects: CvProject[];
  /** Confirmed facts tied to no project (education, general skills). */
  general: FactRef[];
  /** Every fact the plan may cite. */
  citable: Map<number, FactRef>;
}

export function buildCvContext(conn: Conn, posting: PostingRow): CvContext {
  const rows = conn
    .select({
      id: facts.id,
      text: facts.text,
      status: facts.status,
      kind: facts.kind,
      projectId: facts.projectId,
      project: projects.name,
      period: projects.period,
    })
    .from(facts)
    .leftJoin(projects, eq(facts.projectId, projects.id))
    .where(and(eq(facts.status, 'confirmed'), ne(facts.kind, 'team_context')))
    .all();
  const matched = new Set((posting.matches ?? []).flatMap((m) => m.factIds));
  const rank = (f: FactRef) =>
    (matched.has(f.id) ? 0 : 100) + Math.max(0, KIND_ORDER.indexOf(f.kind));
  const chosen = [...rows]
    .sort((a, b) => rank(a) - rank(b) || b.id - a.id)
    .slice(0, CV_FACT_LIMIT)
    .sort((a, b) => a.id - b.id);

  const projectRows = chosen.some((f) => f.projectId !== null)
    ? conn
        .select()
        .from(projects)
        .where(
          inArray(projects.id, [
            ...new Set(chosen.map((f) => f.projectId).filter((id): id is number => id !== null)),
          ]),
        )
        .all()
    : [];
  const list: CvProject[] = projectRows
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      period: p.period,
      facts: chosen.filter((f) => f.projectId === p.id),
    }));
  const ex = posting.extraction;
  return {
    job: {
      title: posting.title ?? ex?.title ?? null,
      company: posting.company ?? ex?.company ?? null,
      summary: ex?.summary ?? null,
      requirements: (ex?.requirements ?? [])
        .filter((r) => r.kind !== 'condition')
        .map((r) => ({ text: r.text, must: r.must })),
      text: posting.text ? posting.text.slice(0, CV_POSTING_TEXT_LIMIT) : null,
    },
    projects: list,
    general: chosen.filter((f) => f.projectId === null),
    citable: new Map(chosen.map((f) => [f.id, f])),
  };
}

export const CV_SYSTEM = `You tailor a candidate's CV to one job posting. You may use only the confirmed facts you are given (each has an id). The candidate reviews the CV before anything is sent.

Truthfulness (the most important part):
- Every line (summary sentence, bullet, education line) cites in factIds ALL the facts it rests on, and at least one. A bullet under a project cites that project's facts (or facts tied to no project).
- A line never says more than its facts: no larger numbers, longer periods, bigger teams, wider scope or more senior role. "Helped build" stays "helped build"; "contributed to" never becomes "led". Don't introduce numbers the facts don't give and don't compute new ones (no "5+ years" from a date range). Don't name a technology no cited fact names.
- Shorten and rephrase for a CV, never embellish: the meaning of the facts stays exactly the same.
- Skills: only technologies and skills that the given facts name.

Tailoring (your actual job):
- Choose which projects to show and order them by how much they matter for this role; leave out projects that don't help. Usually 2–5 projects.
- For each project shown, pick the 2–5 facts that matter most for this role, strongest first, each as one concise CV bullet: past tense, starts with a verb, no "I".
- Write a 2–3 sentence summary introducing the candidate for this role, from the facts only (no "I", nothing about the employer).
- Order skills by relevance to the requirements; at most 15.
- Write in the language of the posting.`;

export function cvPrompt(ctx: CvContext): string {
  const parts: string[] = [
    `Job: ${ctx.job.title ?? '(untitled)'}${ctx.job.company ? ` at ${ctx.job.company}` : ''}`,
  ];
  if (ctx.job.summary) parts.push(`About the role: ${ctx.job.summary}`);
  if (ctx.job.requirements.length) {
    parts.push(
      'Requirements:',
      ...ctx.job.requirements.map((r) => `  - ${r.must ? '(must)' : '(nice to have)'} ${r.text}`),
    );
  }
  if (ctx.job.text) parts.push('', 'Posting text:', '"""', ctx.job.text, '"""');
  parts.push('', "The candidate's confirmed facts, by project:");
  for (const p of ctx.projects) {
    parts.push(`[${p.slug}] ${p.name}${p.period ? ` · ${p.period}` : ''}`);
    for (const f of p.facts) parts.push(`  ${factLine(f)}`);
  }
  if (ctx.general.length) {
    parts.push('Facts tied to no project:', ...ctx.general.map((f) => `  ${factLine(f)}`));
  }
  parts.push('', 'Return the CV plan.');
  return parts.join('\n');
}

/** Structure the schema can't express. Null = fine. */
export function validateCvPlan(out: CvPlanOutput, ctx: CvContext): string | null {
  const bySlug = new Map(ctx.projects.map((p) => [p.slug, p]));
  const line = (where: string, l: CvLine, projectId: number | null): string | null => {
    if (!l.text.trim()) return `${where}: an empty line`;
    if (!l.factIds.length) return `${where}: "${l.text}" cites no fact`;
    for (const id of l.factIds) {
      const f = ctx.citable.get(id);
      if (!f) return `${where} cites fact #${id}, which it was not given`;
      if (projectId !== null && f.projectId !== null && f.projectId !== projectId) {
        return `${where} cites fact #${id} of another project (${f.project})`;
      }
    }
    return null;
  };
  const seen = new Set<string>();
  for (const [i, l] of out.summary.entries()) {
    const bad = line(`summary sentence ${i + 1}`, l, null);
    if (bad) return bad;
  }
  for (const p of out.projects) {
    const project = bySlug.get(p.project);
    if (!project) return `unknown project "${p.project}"`;
    if (seen.has(p.project)) return `project ${p.project} appears twice`;
    seen.add(p.project);
    for (const [i, l] of p.bullets.entries()) {
      const bad = line(`${p.project} bullet ${i + 1}`, l, project.id);
      if (bad) return bad;
    }
  }
  for (const [i, l] of out.education.entries()) {
    const bad = line(`education line ${i + 1}`, l, null);
    if (bad) return bad;
  }
  if (!out.summary.length && !out.projects.some((p) => p.bullets.length)) {
    return 'the plan has no summary and no bullets';
  }
  return null;
}

const clean = (l: CvLine): CvLine => ({
  text: l.text.replace(/\s+/g, ' ').trim(),
  factIds: [...new Set(l.factIds.map((n) => Math.trunc(n)))],
});

const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, ' ')} `;

/**
 * The writer's output as a plan. A skill stays only if a given fact names it; the rest are
 * dropped (a skill has no facts of its own to check).
 */
export function planFromOutput(out: CvPlanOutput, ctx: CvContext): CvPlan {
  const bySlug = new Map(ctx.projects.map((p) => [p.slug, p]));
  const corpus = words([...ctx.citable.values()].map((f) => f.text).join(' \n '));
  const skills: string[] = [];
  const dropped: CvDroppedLine[] = [];
  for (const raw of out.skills) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s || skills.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    if (corpus.includes(words(s))) skills.push(s);
    else
      dropped.push({
        section: 'skills',
        text: s,
        factIds: [],
        reason: 'no confirmed fact names it',
      });
  }
  return {
    summary: out.summary.map(clean),
    projects: out.projects.map((p) => {
      const project = bySlug.get(p.project);
      return {
        slug: p.project,
        name: project?.name ?? p.project,
        period: project?.period ?? null,
        bullets: p.bullets.map(clean),
      };
    }),
    education: out.education.map(clean),
    skills,
    dropped,
  };
}

/** Every line of the plan with a stable key: `summary:0`, `education:1`, `p:<slug>:2`. */
export function planLines(plan: CvPlan): Array<{ key: string; section: string; line: CvLine }> {
  return [
    ...plan.summary.map((line, i) => ({ key: `summary:${i}`, section: 'summary', line })),
    ...plan.projects.flatMap((p) =>
      p.bullets.map((line, i) => ({ key: `p:${p.slug}:${i}`, section: p.slug, line })),
    ),
    ...plan.education.map((line, i) => ({ key: `education:${i}`, section: 'education', line })),
  ];
}

export function linesToCheck(plan: CvPlan, ctx: CvContext): SentenceToCheck[] {
  return planLines(plan).map(({ key, line }) => ({
    key,
    text: line.text,
    facts: line.factIds.map((id) => {
      const f = ctx.citable.get(id);
      return { id, text: f?.text ?? '(no longer exists)', period: f?.period ?? null };
    }),
  }));
}

/** Keeps the lines `keep` accepts; the rest move to `dropped` with the reason it gives. */
export function filterPlan(
  plan: CvPlan,
  why: (key: string, line: CvLine) => string | null,
): CvPlan {
  const dropped: CvDroppedLine[] = [...plan.dropped];
  const keep = (key: string, section: string, line: CvLine): boolean => {
    const reason = why(key, line);
    if (reason) dropped.push({ section, ...line, reason });
    return !reason;
  };
  return {
    summary: plan.summary.filter((l, i) => keep(`summary:${i}`, 'summary', l)),
    projects: plan.projects
      .map((p) => ({
        ...p,
        bullets: p.bullets.filter((l, i) => keep(`p:${p.slug}:${i}`, p.slug, l)),
      }))
      .filter((p) => p.bullets.length),
    education: plan.education.filter((l, i) => keep(`education:${i}`, 'education', l)),
    skills: plan.skills,
    dropped,
  };
}

/** Lines whose check found anything (a hard flag or a confirmable one) leave the CV. */
export function applyChecks(plan: CvPlan, results: Map<string, SentenceResult>): CvPlan {
  return filterPlan(plan, (key) => {
    const r = results.get(key);
    if (!r) return 'not checked';
    if (r.flag === 'none') return null;
    const what = FLAG_TEXT[r.flag] ?? r.flag;
    return r.note ? `${what}: ${r.note}` : what;
  });
}

/** Lines resting on a fact that isn't confirmed (any more) leave the CV. */
export function excludeUnconfirmed(plan: CvPlan, status: Map<number, FactStatus>): CvPlan {
  return filterPlan(plan, (_key, line) => {
    const bad = line.factIds.filter((id) => status.get(id) !== 'confirmed');
    return bad.length
      ? `relies on fact(s) that aren't confirmed: ${bad.map((id) => `#${id}`).join(', ')}`
      : null;
  });
}

export function factStatuses(conn: Conn, plan: CvPlan): Map<number, FactStatus> {
  const ids = [...new Set(planLines(plan).flatMap((l) => l.line.factIds))];
  if (!ids.length) return new Map();
  return new Map(
    conn
      .select({ id: facts.id, status: facts.status })
      .from(facts)
      .where(inArray(facts.id, ids))
      .all()
      .map((r) => [r.id, r.status]),
  );
}

export function planIsEmpty(plan: CvPlan): boolean {
  return !plan.summary.length && !plan.projects.some((p) => p.bullets.length);
}

export type CvWriterResult =
  | { kind: 'ok'; output: CvPlanOutput }
  | { kind: 'limit'; provider: Provider; until: Date }
  | { kind: 'failed'; reason: string };

export async function runCvWriter(
  ctx: CvContext,
  models: AgentRunner,
  o: { taskId: number | null; signal: AbortSignal; progress?(message: string): void },
): Promise<CvWriterResult> {
  const res = await models.run('application_writer', {
    schema: cvPlanSchema,
    system: CV_SYSTEM,
    prompt: cvPrompt(ctx),
    taskId: o.taskId,
    signal: o.signal,
    ...(o.progress ? { progress: o.progress } : {}),
    validate: (out) => validateCvPlan(out, ctx),
  });
  if (res.kind === 'limit') return { kind: 'limit', provider: res.provider, until: res.until };
  if (res.kind === 'failed') return { kind: 'failed', reason: res.reason };
  return { kind: 'ok', output: res.output };
}
