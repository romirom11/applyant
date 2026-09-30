// The interviewer's turns. Each one is a fresh agent run seeded from SQLite: the project's facts
// and gaps (or the application's form question), the transcript, and the latest answer.
//
//   interview_open (project):          → the first question about the project's gaps
//   interview_turn (answered question): → facts the answer states (confirmed, origin interview,
//                                         evidence interview:<question>) + the next question
//
// An application question's answer resumes preparation once nothing else of that application
// is waiting on the interview; the writer then finds the new facts (they're given to it for
// that form question directly, not only through retrieval).
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  applications,
  evidence,
  FACT_KINDS,
  facts,
  type InterviewQuestionRow,
  interviewQuestions,
  interviewTurns,
  type ProjectRow,
  postings,
  projects,
} from '../../db/schema.ts';
import { type InterviewOutput, interviewSchema } from '../../models/schemas/interview.ts';
import type { Handler, HandlerContext, Outcome, Task, Tx } from '../../queue/types.ts';
import { requestRematch } from '../scoring/rematch.ts';
import { enqueueEmbedFacts } from './embed-index.ts';
import { factKey, MAX_FACT_LENGTH } from './facts.ts';
import {
  alreadyAsked,
  askQuestion,
  type Gap,
  getQuestionRow,
  interviewLocator,
  MAX_ANSWER_LENGTH,
  MAX_APPLICATION_FOLLOW_UPS,
  MAX_QUESTIONS_PER_SESSION,
  projectGaps,
  projectThread,
  resumePreparation,
  threadRows,
} from './interview.ts';

/** A failed interviewer run is retried this many times, then the candidate is told. */
export const INTERVIEW_ATTEMPTS = 3;
/** Facts of the project shown to the interviewer (confirmed first). */
export const FACTS_IN_PROMPT = 80;

export const INTERVIEW_SYSTEM = `You interview a job candidate to fill in what their sources (CV, repositories, documents) can't show: their own role, what they personally built, the team, and the results. Applyant writes job applications only from facts, and every fact you save is treated as the candidate's own confirmed statement, so facts must say exactly what the candidate said, never more.

Facts from the latest answer (read it together with the question it answers):
- Only what the answer states. Keep the candidate's numbers, names, scope and hedges ("helped build", "about 5 people"); never round, infer, combine with other facts or upgrade ("helped" never becomes "led").
- One atomic claim per fact, short, without a subject or pronouns for the candidate, past tense for past work: "Designed the queue for the call-analysis pipeline", "Worked in a team of 4 engineers", "Wrote the scoring API alone" (not "on their own").
- kind: personal_contribution = something the candidate built, designed, wrote or did; role = title, position, responsibility; skill = a technology or method they used; impact = a result of their work; team_context = the team or other people's work; education; other = anything else worth keeping, including a plain "no" ("Has not led a team") when that answers the question.
- project: the slug of the project the fact is about (from the list; usually the one being discussed), or null for facts about the candidate in general.
- Nothing to save when the candidate declined, didn't know or went off topic. Don't repeat facts that already exist.

The next question:
- One question, short and specific, grounded in what the facts already show ("The repository shows a call-analysis pipeline. Which part of it did you build yourself?"). Never a question the transcript already asked, or one the facts already answer.
- Go through the gaps given, most important first. Ask a follow-up only when the answer was vague about something that matters (who built what, how big, what result), at most one follow-up per topic.
- null when the gaps are covered, the candidate declined or wants to stop, or you are told not to ask more.
- Write the question in the language the candidate answers in (English when there is no answer yet). Facts are always written in English.`;

interface ProjectEntry {
  id: number;
  slug: string;
  name: string;
  period: string | null;
  role: string | null;
  summary: string | null;
}

export interface InterviewContext {
  projects: ProjectEntry[];
  /** The project being discussed (project interviews). */
  project: ProjectEntry | null;
  facts: Array<{ id: number; kind: string; status: string; project: string | null; text: string }>;
  gaps: Gap[];
  /** Application question: the job and the form question it's for. */
  application: { job: string; question: string; missing: string | null } | null;
  transcript: Array<{ question: string; answer: string | null }>;
  /** The answer this turn reads; null when opening. */
  latest: { question: string; answer: string } | null;
  /** Whether a next question may be asked. */
  mayAsk: boolean;
}

function projectEntries(conn: Conn): ProjectEntry[] {
  return conn
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      period: projects.period,
      role: projects.role,
      summary: projects.summary,
    })
    .from(projects)
    .orderBy(asc(projects.name))
    .all();
}

function projectFacts(conn: Conn, projectId: number): InterviewContext['facts'] {
  return conn
    .select({
      id: facts.id,
      kind: facts.kind,
      status: facts.status,
      project: projects.slug,
      text: facts.text,
    })
    .from(facts)
    .leftJoin(projects, eq(facts.projectId, projects.id))
    .where(and(eq(facts.projectId, projectId), ne(facts.status, 'rejected')))
    .orderBy(sql`case when ${facts.status} = 'confirmed' then 0 else 1 end`, asc(facts.id))
    .limit(FACTS_IN_PROMPT)
    .all();
}

/** The transcript of the thread: each question with the candidate's answer (if any). */
function transcriptOf(conn: Conn, thread: InterviewQuestionRow[]): InterviewContext['transcript'] {
  const answers = new Map<number, string>();
  for (const q of thread) {
    const turn = conn
      .select({ text: interviewTurns.text })
      .from(interviewTurns)
      .where(and(eq(interviewTurns.questionId, q.id), eq(interviewTurns.role, 'candidate')))
      .orderBy(asc(interviewTurns.id))
      .all()
      .at(-1);
    if (turn) answers.set(q.id, turn.text);
  }
  return thread.map((q) => ({
    question: q.text,
    answer: q.status === 'dismissed' ? '(skipped)' : (answers.get(q.id) ?? null),
  }));
}

export function interviewPrompt(c: InterviewContext): string {
  const parts: string[] = [];
  parts.push(
    `The candidate's projects (${c.projects.length}):`,
    ...(c.projects.length
      ? c.projects.map(
          (p) =>
            `  [${p.slug}] ${p.name}${p.period ? ` · ${p.period}` : ''}${p.role ? ` · ${p.role}` : ''}${
              p.summary ? `\n      ${p.summary}` : ''
            }`,
        )
      : ['  (none)']),
  );
  if (c.project) {
    parts.push('', `This interview is about [${c.project.slug}] ${c.project.name}.`);
    parts.push(
      '',
      `What its facts say so far (${c.facts.length}):`,
      ...(c.facts.length
        ? c.facts.map((f) => `  #${f.id} [${f.kind} · ${f.status}] ${f.text}`)
        : ['  (nothing yet)']),
      '',
      'Gaps (what the facts don’t show, most important first):',
      ...(c.gaps.length
        ? c.gaps.map(
            (g) =>
              `  - ${g.label}${g.status === 'unconfirmed' ? ' (only unconfirmed facts: ask to confirm or correct them)' : ''}`,
          )
        : ['  (none left)']),
    );
  }
  if (c.application) {
    parts.push(
      '',
      `A job application (${c.application.job}) asks the candidate: "${c.application.question}"`,
      `Nothing Applyant knows answers it${c.application.missing ? `; what's missing: ${c.application.missing}` : ''}. The facts you save let the application be written, and are kept for later applications.`,
    );
  }
  const earlier = c.latest ? c.transcript.slice(0, -1) : c.transcript;
  if (earlier.length) {
    parts.push(
      '',
      'The interview so far:',
      ...earlier.map((t) => `  Q: ${t.question}\n  A: ${t.answer ?? '(not answered)'}`),
    );
  }
  if (c.latest) {
    parts.push(
      '',
      `The question: ${c.latest.question}`,
      "The candidate's answer:",
      '"""',
      c.latest.answer.slice(0, MAX_ANSWER_LENGTH),
      '"""',
      '',
      c.mayAsk
        ? 'Save the facts this answer states, then ask the next question (or null).'
        : 'Save the facts this answer states. Ask nothing more: question must be null.',
    );
  } else {
    parts.push(
      '',
      c.mayAsk
        ? 'The interview starts now: save no facts, and ask the first question (or null if there is nothing worth asking).'
        : 'Ask nothing: facts empty, question null.',
    );
  }
  return parts.join('\n');
}

/** What the schema can't check: known project slugs, fact length, no facts before an answer. */
export function validateInterview(
  out: InterviewOutput,
  c: Pick<InterviewContext, 'projects' | 'latest'>,
): string | null {
  const slugs = new Set(c.projects.map((p) => p.slug));
  if (!c.latest && out.facts.length) return 'facts were returned before the candidate answered';
  for (const f of out.facts) {
    if (!f.text.trim()) return 'a fact has no text';
    if (f.text.length > MAX_FACT_LENGTH)
      return `a fact is longer than ${MAX_FACT_LENGTH} characters`;
    if (f.project !== null && !slugs.has(f.project)) return `unknown project "${f.project}"`;
  }
  return null;
}

// ---- interview_open ------------------------------------------------------------------------

export const interviewOpen: Handler<'interview_open'> = async (task, ctx) => {
  const project = ctx.read.select().from(projects).where(eq(projects.id, task.entityId)).get();
  if (!project) return noop;
  const thread = projectThread(ctx.read, project.id);
  if (thread.some((q) => q.status === 'open' || q.status === 'processing')) return noop;

  const c: InterviewContext = {
    projects: projectEntries(ctx.read),
    project: entry(project),
    facts: projectFacts(ctx.read, project.id),
    gaps: projectGaps(ctx.read, project),
    application: null,
    transcript: transcriptOf(ctx.read, thread),
    latest: null,
    mayAsk: true,
  };
  ctx.progress({ message: `opening the interview about ${project.name}` });
  const res = await ctx.deps.models.run('interviewer', {
    schema: interviewSchema,
    system: INTERVIEW_SYSTEM,
    prompt: interviewPrompt(c),
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    validate: (out) => validateInterview(out, c),
  });
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'failed') {
    return failOrRetry(task, ctx, res.reason, (tx, reason) =>
      tx.emit({
        kind: 'interview',
        stage: 'failed',
        message: `the interview about ${project.name} couldn't start: ${reason}`,
      }),
    );
  }
  const { question, about } = res.output;
  return {
    kind: 'done',
    commit: (tx) => {
      const now = projectThread(tx.db, project.id);
      if (now.some((q) => q.status === 'open' || q.status === 'processing')) return;
      if (!question || alreadyAsked(now, question)) {
        tx.emit({
          kind: 'interview',
          stage: 'done',
          message: `nothing to ask about ${project.name}`,
        });
        return;
      }
      askQuestion(tx, {
        projectId: project.id,
        applicationId: null,
        fieldRef: null,
        text: question,
        context: about,
        origin: 'project',
      });
    },
  };
};

// ---- interview_turn ------------------------------------------------------------------------

export const interviewTurn: Handler<'interview_turn'> = async (task, ctx) => {
  const q = getQuestionRow(ctx.read, task.entityId);
  if (q?.status !== 'processing') return noop;
  const answerTurn = ctx.read
    .select({ id: interviewTurns.id, text: interviewTurns.text })
    .from(interviewTurns)
    .where(and(eq(interviewTurns.questionId, q.id), eq(interviewTurns.role, 'candidate')))
    .orderBy(asc(interviewTurns.id))
    .all()
    .at(-1);
  if (!answerTurn) return noop;

  const thread = threadRows(ctx.read, q);
  const project = q.projectId
    ? (ctx.read.select().from(projects).where(eq(projects.id, q.projectId)).get() ?? null)
    : null;
  const c: InterviewContext = {
    projects: projectEntries(ctx.read),
    project: project ? entry(project) : null,
    facts: project ? projectFacts(ctx.read, project.id) : [],
    gaps: project ? projectGaps(ctx.read, project) : [],
    application: q.applicationId ? applicationContext(ctx.read, q) : null,
    transcript: transcriptOf(
      ctx.read,
      thread.filter((x) => x.id <= q.id),
    ),
    latest: { question: q.text, answer: answerTurn.text },
    mayAsk: mayFollowUp(thread, q),
  };
  ctx.progress({ message: `reading your answer to question ${q.id}` });
  const res = await ctx.deps.models.run('interviewer', {
    schema: interviewSchema,
    system: INTERVIEW_SYSTEM,
    prompt: interviewPrompt(c),
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    validate: (out) => validateInterview(out, c),
  });
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'failed') {
    return failOrRetry(task, ctx, res.reason, (tx, reason) => {
      // Back to the candidate: the answer stays in the transcript; they can answer again.
      const row = tx.db
        .update(interviewQuestions)
        .set({
          status: 'open',
          note: `couldn't read your answer (${reason.slice(0, 300)}); answer again, or dismiss it`,
        })
        .where(and(eq(interviewQuestions.id, q.id), eq(interviewQuestions.status, 'processing')))
        .returning()
        .get();
      if (row) {
        tx.emit({
          kind: 'interview',
          entityId: q.id,
          stage: 'open',
          message: `question ${q.id}: couldn't read the answer`,
        });
      }
    });
  }
  const out = res.output;
  const slugs = new Map(c.projects.map((p) => [p.slug, p.id]));
  return {
    kind: 'done',
    commit: (tx) => {
      const current = getQuestionRow(tx.db, q.id);
      if (current?.status !== 'processing') return;
      const saved = saveFacts(tx, q.id, answerTurn.text, out.facts, (slug) =>
        slug === null ? null : (slugs.get(slug) ?? null),
      );
      const note =
        saved.length === 0
          ? 'nothing saved from this answer'
          : `saved ${saved.length} fact(s): ${saved.map((id) => `#${id}`).join(', ')}`;
      tx.db
        .update(interviewQuestions)
        .set({ status: 'answered', note })
        .where(eq(interviewQuestions.id, q.id))
        .run();
      if (saved.length) {
        enqueueEmbedFacts(tx);
        requestRematch(tx);
      }
      tx.emit({
        kind: 'interview',
        entityId: q.id,
        stage: 'answered',
        message: `question ${q.id}: ${note}`,
      });

      const now = threadRows(tx.db, q);
      const next = out.question?.trim();
      if (next && c.mayAsk && !alreadyAsked(now, next)) {
        askQuestion(tx, {
          projectId: q.projectId,
          applicationId: q.applicationId,
          fieldRef: q.fieldRef,
          text: next,
          context: out.about ?? q.context,
          origin: 'follow_up',
        });
        return;
      }
      if (q.applicationId !== null) {
        const resumed = resumePreparation(tx, q.applicationId);
        tx.emit({
          kind: 'interview',
          entityId: q.id,
          stage: 'done',
          message: resumed
            ? `application ${q.applicationId} is being prepared again with your answer`
            : `application ${q.applicationId} waits for your other interview question(s)`,
        });
        return;
      }
      tx.emit({
        kind: 'interview',
        entityId: q.id,
        stage: 'done',
        message: `nothing more to ask${project ? ` about ${project.name}` : ''} for now`,
      });
    },
  };
};

// ---- pieces -------------------------------------------------------------------------------

const noop: Outcome = { kind: 'done', commit: () => {} };

function entry(p: ProjectRow): ProjectEntry {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    period: p.period,
    role: p.role,
    summary: p.summary,
  };
}

function applicationContext(conn: Conn, q: InterviewQuestionRow): InterviewContext['application'] {
  const job = q.applicationId
    ? conn
        .select({ title: postings.title, company: postings.company })
        .from(applications)
        .innerJoin(postings, eq(applications.postingId, postings.id))
        .where(eq(applications.id, q.applicationId))
        .get()
    : undefined;
  // The first question of the thread is the form's own; its context says what was missing.
  const first = threadRows(conn, q)[0] ?? q;
  return {
    job:
      [job?.title, job?.company].filter(Boolean).join(' at ') || `application ${q.applicationId}`,
    question: first.text,
    missing: first.context,
  };
}

/** Follow-ups are capped: a project session asks at most MAX_QUESTIONS_PER_SESSION in a row. */
export function mayFollowUp(thread: InterviewQuestionRow[], q: InterviewQuestionRow): boolean {
  const upTo = thread.filter((x) => x.id <= q.id);
  if (q.applicationId !== null) {
    return upTo.filter((x) => x.origin === 'follow_up').length < MAX_APPLICATION_FOLLOW_UPS;
  }
  let session = 0;
  for (const x of [...upTo].reverse()) {
    session++;
    if (x.origin !== 'follow_up') break;
  }
  return session < MAX_QUESTIONS_PER_SESSION;
}

/**
 * The answer's facts, confirmed (the candidate said them), with the answer as their evidence.
 * A fact that already exists in the same project is confirmed and gains the evidence instead.
 */
function saveFacts(
  tx: Tx,
  questionId: number,
  answer: string,
  found: InterviewOutput['facts'],
  projectOf: (slug: string | null) => number | null,
): number[] {
  const ids: number[] = [];
  const locator = interviewLocator(questionId);
  const excerpt = answer.replace(/\s+/g, ' ').trim().slice(0, 400);
  for (const f of found) {
    const text = f.text.replace(/\s+/g, ' ').trim();
    if (!text || !FACT_KINDS.includes(f.kind)) continue;
    const projectId = projectOf(f.project);
    const key = factKey(text);
    const same = tx.db
      .select({ id: facts.id, text: facts.text })
      .from(facts)
      .where(projectId === null ? sql`${facts.projectId} is null` : eq(facts.projectId, projectId))
      .all()
      .find((row) => factKey(row.text) === key);
    let id: number;
    if (same) {
      id = same.id;
      tx.db
        .update(facts)
        .set({ status: 'confirmed', updatedAt: tx.now })
        .where(eq(facts.id, id))
        .run();
    } else {
      id = tx.db
        .insert(facts)
        .values({
          projectId,
          text: text.slice(0, MAX_FACT_LENGTH),
          kind: f.kind,
          status: 'confirmed',
          origin: 'interview',
          createdAt: tx.now,
          updatedAt: tx.now,
        })
        .returning({ id: facts.id })
        .get().id;
    }
    if (ids.includes(id)) continue;
    tx.db.insert(evidence).values({ factId: id, sourceId: null, locator, excerpt }).run();
    ids.push(id);
  }
  return ids;
}

function failOrRetry(
  task: Task<'interview_open' | 'interview_turn'>,
  ctx: HandlerContext,
  reason: string,
  giveUp: (tx: Tx, reason: string) => void,
): Outcome {
  if (task.attempts + 1 < INTERVIEW_ATTEMPTS) {
    return {
      kind: 'retry',
      after: new Date(ctx.now().getTime() + 30_000 * 2 ** task.attempts),
      reason,
    };
  }
  return { kind: 'done', commit: (tx) => giveUp(tx, reason) };
}
