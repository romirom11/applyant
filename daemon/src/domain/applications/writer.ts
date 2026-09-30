// application_writer: one run per application answers every question it needs, sentence by
// sentence, each sentence with the ids of the facts it relies on. One run (rather than one per
// question) because questions refer to each other: "did you start your first written answer
// below with the exact phrase from the job description?" is about the next answer.
import type { McpAccess, ToolCall } from '../../mcp/server.ts';
import { GET_PROJECT, SEARCH_FACTS } from '../../mcp/tools/knowledge.ts';
import type { AgentRunner } from '../../models/agent-runner.ts';
import type { Provider } from '../../models/roles.ts';
import { type WriterOutput, writerSchema } from '../../models/schemas/application.ts';
import { type FactRef, factLine } from '../knowledge/retrieve.ts';
import { assertCitable, type WriterContext } from './writer-context.ts';

/** Knowledge lookups one writer run may make (enforced by the MCP endpoint). */
export const WRITER_TOOL_CALLS = 3;

export const WRITER_SYSTEM = `You draft answers to a job application's questions for a candidate. You write only from the facts about the candidate you are given (each has an id, a kind, a status and a project) and from the profile values given for this application. The candidate reviews every answer before anything is sent.

Truthfulness rules (the most important part):
- Every sentence that states anything about the candidate (experience, skills, role, what they built, results, numbers, dates, situation) cites in factIds ALL the facts that support it. A sentence that makes no claim about the candidate (interest in the company, what excites them about the role, courtesy) cites nothing.
- Never state more than the cited facts say: no larger numbers, longer periods, bigger teams, wider scope or more senior role than the facts give. "Helped build" stays "helped build"; "contributed to" never becomes "led". Don't introduce numbers that aren't in the facts; don't compute new ones (no "5+ years" from a date range).
- Facts of kind team_context describe other people's or the team's work: never present them as the candidate's own.
- If the facts and profile values can't answer a question honestly (it asks about the candidate's situation, history, preferences or experience that nothing given shows), return status "needs_candidate", no sentences, and say in "missing" exactly what the candidate has to tell. Never guess, never answer from what is typical.
- Prefer confirmed facts when an unconfirmed one says the same.
- Company research (when given) is about the company, not the candidate: use it for "why us" and interest in the company, stated plainly and only as the research says it. It never supports a claim about the candidate, and sentences that use only it cite nothing.

Writing:
- Choose the project that fits each question best from the list of all projects: tell that story concretely, don't retell the CV.
- First person, plain and specific, in the language of the question. Usually 3–6 sentences unless the question asks for something else; respect any length limit the question states.
- A choice question is answered by "choice" (exactly one of its options, copied exactly). Put the claim behind the choice in sentences with their facts (they are checked, not sent). A choice that states nothing about the candidate needs no sentences.
- Questions may point back at instructions in the job posting ("start with the exact phrase we asked for in the description"). Find the instruction in the posting text and follow it exactly. If you can't find it, the question is needs_candidate (say what you couldn't find).
- Questions marked "asked only if …" depend on another answer: answer them consistently with it.
- Prior answers show facts that were used and checked before; reuse their facts (not their wording) when they fit, and set adaptedFrom to that answer's id.
- You may call search_facts or get_project (at most ${WRITER_TOOL_CALLS} calls in total) when the given facts aren't enough; whatever they return can be cited.

Return one draft for every question, with its id.`;

function list<T>(items: T[], fn: (x: T) => string, empty = '  (none)'): string {
  return items.length ? items.map(fn).join('\n') : empty;
}

export function writerPrompt(ctx: WriterContext): string {
  const parts: string[] = [];
  parts.push(
    `Job: ${ctx.job.title ?? '(untitled)'}${ctx.job.company ? ` at ${ctx.job.company}` : ''}`,
    `URL: ${ctx.job.url}`,
  );
  if (ctx.job.summary) parts.push(`About the role: ${ctx.job.summary}`);
  if (ctx.job.text) {
    parts.push(
      '',
      'Posting text (for "why us" answers and for any instruction a question refers back to):',
      '"""',
      ctx.job.text,
      '"""',
    );
  }
  if (ctx.company) {
    parts.push(
      '',
      `About ${ctx.company.name} (company research, for "why us"; not facts about the candidate):`,
      `  ${ctx.company.summary}`,
      ...ctx.company.highlights.map((h) => `  - ${h}`),
    );
  }
  const profile = Object.entries(ctx.profile);
  parts.push(
    '',
    "The candidate's profile values for this application (may be stated as given):",
    list(profile, ([k, v]) => `  ${k}: ${v}`),
    '',
    `All of the candidate's projects (${ctx.projects.length}):`,
    list(
      ctx.projects,
      (p) =>
        `  - ${p.name} [${p.slug}]${p.period ? ` · ${p.period}` : ''}${p.role ? ` · ${p.role}` : ''}${
          p.stack.length ? ` · ${p.stack.slice(0, 8).join(', ')}` : ''
        } · ${p.factCount} facts${p.summary ? `\n      ${p.summary}` : ''}`,
    ),
    '',
    'How the candidate meets the posting (from scoring):',
    list(
      ctx.matched,
      (m) =>
        `  ${m.verdict === 'strong' ? '✓' : '~'} ${m.text}\n${m.facts.map((f) => `      ${factLine(f)}`).join('\n')}`,
    ),
    '',
    'Questions, in the order the form asks them:',
  );
  for (const q of ctx.questions) {
    const kind =
      q.kind === 'choice'
        ? `choice: ${(q.options ?? []).map((o) => `"${o}"`).join(' | ')}`
        : 'written';
    parts.push(
      `[${q.id}] (${kind}${q.required ? ', required' : ''}${q.condition ? `, ${q.condition}` : ''}) ${q.label}`,
    );
    if (q.redraft) {
      const asks = [
        q.redraft.shorter
          ? 'make it clearly shorter than before (about half, 2–3 sentences), same facts and rules'
          : null,
        q.redraft.project
          ? `answer it from the project "${q.redraft.project.name}" (its facts are listed below), not another project`
          : null,
      ].filter(Boolean);
      parts.push(`  The candidate asked to draft this answer again: ${asks.join('; ')}.`);
    }
    if (q.pointsBack) {
      parts.push('  (refers back to the job posting: find the instruction in the posting text)');
    }
    parts.push(
      '  Facts found for this question:',
      list(q.retrieved, (f) => `    ${factLine(f)}`, '    (none)'),
    );
  }
  if (ctx.priorAnswers.length) {
    parts.push('', 'Prior answers to similar questions (reuse their facts, not their wording):');
    for (const p of ctx.priorAnswers) {
      parts.push(`  [${p.id}] "${p.question}"${p.company ? ` (for ${p.company})` : ''}`);
      for (const s of p.sentences) {
        const ids = s.factIds.map((id) => `#${id}`).join(', ');
        parts.push(`    - ${s.text}${ids ? ` [${ids}]` : ''}`);
      }
    }
    const facts = [...ctx.citable.values()].filter((f) =>
      ctx.priorAnswers.some((p) => p.sentences.some((s) => s.factIds.includes(f.id))),
    );
    if (facts.length)
      parts.push(
        '  Their facts:',
        list(facts, (f) => `    ${factLine(f)}`),
      );
  }
  parts.push('', `Return one draft for each of the ${ctx.questions.length} questions.`);
  return parts.join('\n');
}

/** Structure the schema can't express: every question answered once, choices from the options. */
export function validateDrafts(out: WriterOutput, ctx: WriterContext): string | null {
  const seen = new Set<string>();
  for (const d of out.drafts) {
    const q = ctx.questions.find((x) => x.id === d.question);
    if (!q) return `unknown question "${d.question}"`;
    if (seen.has(d.question)) return `question ${d.question} answered twice`;
    seen.add(d.question);
    if (d.status === 'answered') {
      if (q.kind === 'choice') {
        if (!d.choice || !(q.options ?? []).includes(d.choice)) {
          return `question ${d.question}: "${d.choice}" is not one of its options`;
        }
      } else if (d.sentences.filter((s) => s.text.trim()).length === 0) {
        return `question ${d.question} is answered with no sentences`;
      }
    }
  }
  const missing = ctx.questions.filter((q) => !seen.has(q.id)).map((q) => q.id);
  if (missing.length) return `no draft for ${missing.join(', ')}`;
  return assertCitable(out, ctx);
}

export type WriterResult =
  | { kind: 'ok'; output: WriterOutput; calls: ToolCall[] }
  | { kind: 'limit'; provider: Provider; until: Date }
  | { kind: 'failed'; reason: string };

export async function runWriter(
  ctx: WriterContext,
  d: { models: AgentRunner; mcp: McpAccess | null },
  o: { taskId: number | null; signal: AbortSignal; progress?(message: string): void },
): Promise<WriterResult> {
  // Facts the tools return join the citable set, so the writer may cite them.
  const grant = d.mcp?.grant<FactRef>({
    taskId: o.taskId,
    tools: [SEARCH_FACTS, GET_PROJECT],
    maxCalls: WRITER_TOOL_CALLS,
    onResult: (_tool, items) => {
      for (const f of items) ctx.citable.set(f.id, f);
    },
  });
  try {
    const res = await d.models.run('application_writer', {
      schema: writerSchema,
      system: WRITER_SYSTEM,
      prompt: writerPrompt(ctx),
      taskId: o.taskId,
      signal: o.signal,
      ...(o.progress ? { progress: o.progress } : {}),
      tools: grant?.tools ?? null,
      validate: (out) => validateDrafts(out, ctx),
    });
    if (res.kind === 'limit') return { kind: 'limit', provider: res.provider, until: res.until };
    if (res.kind === 'failed') return { kind: 'failed', reason: res.reason };
    return { kind: 'ok', output: res.output, calls: grant?.calls() ?? [] };
  } finally {
    grant?.revoke();
  }
}
