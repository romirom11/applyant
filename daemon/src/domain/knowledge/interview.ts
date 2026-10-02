// The agent interview: fills in what sources can't show (the candidate's own role, what they
// personally built, the team, the results), and the facts preparation finds missing.
//
//   project interview:   gaps (below) → interview_open → first question → answer →
//                        interview_turn → facts (confirmed, origin interview) + next question …
//   application question: prepare's writer can't answer a form question from the facts → the
//                        form question is asked here → answer → facts → preparation resumes
//
// The transcript is Applyant's own (interview_turns), and every turn is a fresh agent run
// seeded with it. A question is never asked twice: the interviewer's next question is dropped
// when the transcript already has it, and an application question answered once isn't asked
// again for that form question.
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  answers,
  applications,
  evidence,
  type FactKind,
  type FactStatus,
  facts,
  type InterviewOrigin,
  type InterviewQuestionRow,
  type InterviewStatus,
  interviewQuestions,
  interviewTurns,
  type ProjectRow,
  postings,
  projects,
  tasks,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { PREPARABLE, requestPrepare } from '../applications/store.ts';
import { factKey } from './facts.ts';
import { requireProject } from './projects.ts';

export class InterviewError extends Error {}

/** Longest answer the interviewer is given (the rest is kept in the transcript only). */
export const MAX_ANSWER_LENGTH = 6000;
/** A project interview asks at most this many questions in a row (opener + follow-ups). */
export const MAX_QUESTIONS_PER_SESSION = 8;
/** An application question gets at most this many follow-ups. */
export const MAX_APPLICATION_FOLLOW_UPS = 1;

/** Evidence locator for a fact the candidate stated in answer to question `id`. */
export const interviewLocator = (id: number): string => `interview:${id}`;

// ---- gaps ---------------------------------------------------------------------------------

export const GAP_KEYS = ['personal_contribution', 'role', 'team', 'impact'] as const;
export type GapKey = (typeof GAP_KEYS)[number];

export interface Gap {
  key: GapKey;
  /** missing: nothing covers it · unconfirmed: only facts nobody confirmed yet. */
  status: 'missing' | 'unconfirmed';
  /** For prompts and screens: "what you personally built". */
  label: string;
}

const GAP_LABELS: Record<GapKey, string> = {
  personal_contribution: 'what the candidate personally built or did',
  role: "the candidate's own role and responsibilities",
  team: 'the team: its size, who did what, working alone or with others',
  impact: 'the results: users, revenue, time saved, what changed',
};

/**
 * Says who the candidate worked with: "a team of 4", "3 engineers", "alone", "co-founder".
 * A bare "team" doesn't ("the billing job for the finance team").
 */
const TEAM_WORDS =
  /\b(teams? of|\d+[- ]?(person|people|engineers?|developers?|designers?)|solo|alone|by myself|single-handed\w*|co-?founders?|headcount|(led|managed|ran|built|hired) (a|the|my) team)\b/i;

/**
 * What the project's facts don't show yet, most important first. Rejected facts don't count;
 * a gap covered only by unconfirmed facts is still asked about (to confirm or correct them).
 */
export function projectGaps(conn: Conn, project: ProjectRow): Gap[] {
  const rows = conn
    .select({ kind: facts.kind, status: facts.status, text: facts.text })
    .from(facts)
    .where(and(eq(facts.projectId, project.id), ne(facts.status, 'rejected')))
    .all();
  const status = (match: (r: { kind: FactKind; text: string }) => boolean) => {
    const hits = rows.filter(match);
    if (hits.some((r) => r.status === 'confirmed')) return null;
    return hits.length ? ('unconfirmed' as const) : ('missing' as const);
  };
  const found: Record<GapKey, Gap['status'] | null> = {
    personal_contribution: status((r) => r.kind === 'personal_contribution'),
    // The project's own role line (from a CV) counts as stated.
    role: project.role ? null : status((r) => r.kind === 'role'),
    // Not by kind: extractors file the product itself under team_context too.
    team: status((r) => TEAM_WORDS.test(r.text)),
    impact: status((r) => r.kind === 'impact'),
  };
  return GAP_KEYS.flatMap((key) => {
    const s = found[key];
    return s ? [{ key, status: s, label: GAP_LABELS[key] }] : [];
  });
}

// ---- views --------------------------------------------------------------------------------

export interface InterviewFactView {
  id: number;
  text: string;
  kind: FactKind;
  status: FactStatus;
  projectSlug: string | null;
}

export interface QuestionView {
  id: number;
  projectId: number | null;
  project: { id: number; slug: string; name: string } | null;
  applicationId: number | null;
  /** "Acme AI · Senior AI Engineer" for an application question. */
  application: string | null;
  fieldRef: string | null;
  text: string;
  context: string | null;
  status: InterviewStatus;
  origin: InterviewOrigin;
  note: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  /** The candidate's (latest) answer. */
  answer: string | null;
  /** Facts saved from the answer. */
  facts: InterviewFactView[];
}

export function getQuestionRow(conn: Conn, id: number): InterviewQuestionRow | null {
  return conn.select().from(interviewQuestions).where(eq(interviewQuestions.id, id)).get() ?? null;
}

function requireQuestion(conn: Conn, id: number): InterviewQuestionRow {
  const row = getQuestionRow(conn, id);
  if (!row) throw new InterviewError(`no interview question ${id}`);
  return row;
}

export function questionViews(conn: Conn, rows: InterviewQuestionRow[]): QuestionView[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is number => !!x))];
  const appIds = [...new Set(rows.map((r) => r.applicationId).filter((x): x is number => !!x))];
  const projectById = new Map(
    (projectIds.length
      ? conn
          .select({ id: projects.id, slug: projects.slug, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
      : []
    ).map((p) => [p.id, p]),
  );
  const appById = new Map(
    (appIds.length
      ? conn
          .select({ id: applications.id, title: postings.title, company: postings.company })
          .from(applications)
          .innerJoin(postings, eq(applications.postingId, postings.id))
          .where(inArray(applications.id, appIds))
          .all()
      : []
    ).map((a) => [a.id, [a.company, a.title].filter(Boolean).join(' · ') || `application ${a.id}`]),
  );
  const answers = new Map<number, string>();
  for (const t of conn
    .select({ questionId: interviewTurns.questionId, text: interviewTurns.text })
    .from(interviewTurns)
    .where(and(inArray(interviewTurns.questionId, ids), eq(interviewTurns.role, 'candidate')))
    .orderBy(asc(interviewTurns.id))
    .all()) {
    answers.set(t.questionId, t.text);
  }
  const saved = new Map<number, InterviewFactView[]>();
  const locators = ids.map(interviewLocator);
  for (const f of conn
    .select({
      locator: evidence.locator,
      id: facts.id,
      text: facts.text,
      kind: facts.kind,
      status: facts.status,
      projectSlug: projects.slug,
    })
    .from(evidence)
    .innerJoin(facts, eq(evidence.factId, facts.id))
    .leftJoin(projects, eq(facts.projectId, projects.id))
    .where(inArray(evidence.locator, locators))
    .orderBy(asc(facts.id))
    .all()) {
    const qid = Number(f.locator?.slice('interview:'.length));
    const list = saved.get(qid) ?? [];
    list.push({
      id: f.id,
      text: f.text,
      kind: f.kind,
      status: f.status,
      projectSlug: f.projectSlug ?? null,
    });
    saved.set(qid, list);
  }
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    project: r.projectId ? (projectById.get(r.projectId) ?? null) : null,
    applicationId: r.applicationId,
    application: r.applicationId ? (appById.get(r.applicationId) ?? null) : null,
    fieldRef: r.fieldRef,
    text: r.text,
    context: r.context,
    status: r.status,
    origin: r.origin,
    note: r.note,
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
    answer: answers.get(r.id) ?? null,
    facts: saved.get(r.id) ?? [],
  }));
}

export function questionView(conn: Conn, id: number): QuestionView {
  const [view] = questionViews(conn, [requireQuestion(conn, id)]);
  if (!view) throw new InterviewError(`no interview question ${id}`);
  return view;
}

/**
 * Questions waiting on the candidate (open) or on the interviewer (processing), application
 * questions first: an application is waiting on them. `all` lists every question.
 */
export function listQuestions(conn: Conn, o: { all?: boolean } = {}): QuestionView[] {
  const rows = conn
    .select()
    .from(interviewQuestions)
    .where(o.all ? undefined : inArray(interviewQuestions.status, ['open', 'processing']))
    .orderBy(
      sql`case when ${interviewQuestions.applicationId} is null then 1 else 0 end`,
      asc(interviewQuestions.id),
    )
    .all();
  return questionViews(conn, rows);
}

/** A project's interview so far, or an application question's thread, oldest first. */
export function threadRows(
  conn: Conn,
  q: Pick<InterviewQuestionRow, 'id' | 'projectId' | 'applicationId' | 'fieldRef'>,
) {
  if (q.projectId !== null && q.applicationId === null) {
    return conn
      .select()
      .from(interviewQuestions)
      .where(
        and(
          eq(interviewQuestions.projectId, q.projectId),
          isNull(interviewQuestions.applicationId),
        ),
      )
      .orderBy(asc(interviewQuestions.id))
      .all();
  }
  return conn
    .select()
    .from(interviewQuestions)
    .where(
      q.applicationId !== null && q.fieldRef !== null
        ? and(
            eq(interviewQuestions.applicationId, q.applicationId),
            eq(interviewQuestions.fieldRef, q.fieldRef),
          )
        : eq(interviewQuestions.id, q.id),
    )
    .orderBy(asc(interviewQuestions.id))
    .all();
}

export function projectThread(conn: Conn, projectId: number): InterviewQuestionRow[] {
  return threadRows(conn, { id: 0, projectId, applicationId: null, fieldRef: null });
}

export interface ProjectInterview {
  project: ProjectRow;
  gaps: Gap[];
  /** Questions waiting on the candidate. */
  open: number;
  /** Questions asked so far (any status). */
  asked: number;
  /** The interviewer is working on this project's interview (opening it or reading an answer). */
  busy: boolean;
}

export function projectInterviews(conn: Conn): ProjectInterview[] {
  const all = conn.select().from(projects).orderBy(asc(projects.name)).all();
  const questions = conn
    .select({ projectId: interviewQuestions.projectId, status: interviewQuestions.status })
    .from(interviewQuestions)
    .where(isNull(interviewQuestions.applicationId))
    .all();
  const openers = new Set(
    conn
      .select({ entityId: tasks.entityId })
      .from(tasks)
      .where(and(eq(tasks.kind, 'interview_open'), inArray(tasks.status, ['queued', 'running'])))
      .all()
      .map((t) => t.entityId),
  );
  return all.map((p) => {
    const mine = questions.filter((q) => q.projectId === p.id);
    return {
      project: p,
      gaps: projectGaps(conn, p),
      open: mine.filter((q) => q.status === 'open').length,
      asked: mine.length,
      busy: openers.has(p.id) || mine.some((q) => q.status === 'processing'),
    };
  });
}

// ---- asking -------------------------------------------------------------------------------

function emitQuestion(tx: Tx, q: InterviewQuestionRow, message: string, stage?: string): void {
  tx.emit({
    kind: 'interview',
    entityId: q.id,
    stage: stage ?? q.status,
    message,
  });
}

/** Stores a question (and its agent turn) waiting for the candidate. */
export function askQuestion(
  tx: Tx,
  input: {
    projectId: number | null;
    applicationId: number | null;
    fieldRef: string | null;
    text: string;
    context: string | null;
    origin: InterviewOrigin;
  },
): InterviewQuestionRow {
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text) throw new InterviewError('a question needs text');
  const row = tx.db
    .insert(interviewQuestions)
    .values({
      projectId: input.projectId,
      applicationId: input.applicationId,
      fieldRef: input.fieldRef,
      text,
      context: input.context,
      origin: input.origin,
      status: 'open',
      createdAt: tx.now,
    })
    .returning()
    .get();
  tx.db
    .insert(interviewTurns)
    .values({
      questionId: row.id,
      projectId: row.projectId,
      applicationId: row.applicationId,
      role: 'agent',
      text,
      createdAt: tx.now,
    })
    .run();
  emitQuestion(tx, row, `question ${row.id}: ${text}`);
  return row;
}

/** Whether the thread already asked this (case, spacing and punctuation don't matter). */
export function alreadyAsked(thread: Array<{ text: string }>, text: string): boolean {
  const key = factKey(text).replace(/[?]+$/, '');
  return thread.some((q) => factKey(q.text).replace(/[?]+$/, '') === key);
}

/** The candidate's answer: stored in the transcript, then read by the interviewer. */
export function answerQuestion(tx: Tx, id: number, answer: string): InterviewQuestionRow {
  const q = requireQuestion(tx.db, id);
  if (q.status !== 'open') {
    throw new InterviewError(
      q.status === 'processing'
        ? `question ${id} is already answered; its answer is being read`
        : `question ${id} is ${q.status}`,
    );
  }
  const text = answer.trim();
  if (!text) throw new InterviewError('the answer is empty (dismiss the question to skip it)');
  tx.db
    .insert(interviewTurns)
    .values({
      questionId: q.id,
      projectId: q.projectId,
      applicationId: q.applicationId,
      role: 'candidate',
      text,
      createdAt: tx.now,
    })
    .run();
  const row = tx.db
    .update(interviewQuestions)
    .set({ status: 'processing', note: null, answeredAt: tx.now })
    .where(eq(interviewQuestions.id, q.id))
    .returning()
    .get();
  tx.enqueue('interview_turn', q.id, { runId: null });
  emitQuestion(tx, row, `question ${q.id} answered; reading it`);
  return row;
}

/**
 * "Later" / not this one. An application question leaves its answer to the candidate; if the
 * application was only waiting for this one, the answers it did get are used now.
 */
export function dismissQuestion(tx: Tx, id: number): InterviewQuestionRow {
  const q = requireQuestion(tx.db, id);
  if (q.status !== 'open') throw new InterviewError(`question ${id} is ${q.status}`);
  const row = tx.db
    .update(interviewQuestions)
    .set({ status: 'dismissed', note: 'dismissed' })
    .where(eq(interviewQuestions.id, q.id))
    .returning()
    .get();
  emitQuestion(tx, row, `question ${q.id} dismissed`);
  if (q.applicationId !== null) resumePreparation(tx, q.applicationId);
  return row;
}

/**
 * Prepares the application again once none of its interview questions is waiting, if one of
 * them was answered and its form question still waits for the candidate (the writer then finds
 * the new facts). True if it did.
 */
export function resumePreparation(tx: Tx, applicationId: number): boolean {
  if (pendingApplicationQuestions(tx.db, applicationId) > 0) return false;
  const app = tx.db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!app || !PREPARABLE.includes(app.stage)) return false;
  const unused = tx.db
    .select({ id: interviewQuestions.id })
    .from(interviewQuestions)
    .innerJoin(
      answers,
      and(
        eq(answers.applicationId, interviewQuestions.applicationId),
        eq(answers.questionRef, interviewQuestions.fieldRef),
      ),
    )
    .where(
      and(
        eq(interviewQuestions.applicationId, applicationId),
        eq(interviewQuestions.status, 'answered'),
        eq(answers.status, 'needs_candidate'),
      ),
    )
    .get();
  if (!unused) return false;
  requestPrepare(tx, app, { rewrite: false, why: 'you answered its interview question(s)' });
  return true;
}

export type StartResult =
  | { kind: 'question'; question: QuestionView }
  | { kind: 'pending'; projectId: number | null; message: string }
  | { kind: 'nothing'; message: string };

/**
 * Where the interview goes next. For a project: its open question, or the interviewer is
 * asked for one. Without a project: open questions first (application questions before
 * project ones), then the project with the most to ask about that hasn't been interviewed yet.
 */
export function startInterview(tx: Tx, ref: string | null): StartResult {
  if (ref) {
    const project = requireProject(tx.db, ref);
    return startProject(tx, project, true);
  }
  const waiting = listQuestions(tx.db);
  const open = waiting.find((q) => q.status === 'open');
  if (open) return { kind: 'question', question: open };
  const busy = waiting.find((q) => q.status === 'processing');
  if (busy) {
    return {
      kind: 'pending',
      projectId: busy.projectId,
      message: `reading your answer to question ${busy.id}`,
    };
  }
  const next = projectInterviews(tx.db)
    .filter((p) => p.gaps.length && p.asked === 0)
    .sort((a, b) => b.gaps.length - a.gaps.length || a.project.id - b.project.id)[0];
  if (!next) {
    return {
      kind: 'nothing',
      message:
        'Nothing to ask: every project has been interviewed or has no gaps. Pick one to talk about more: `candidate interview <project>`.',
    };
  }
  return startProject(tx, next.project, false);
}

function startProject(tx: Tx, project: ProjectRow, explicit: boolean): StartResult {
  const thread = projectThread(tx.db, project.id);
  const open = thread.find((q) => q.status === 'open');
  if (open) return { kind: 'question', question: questionView(tx.db, open.id) };
  if (thread.some((q) => q.status === 'processing')) {
    return {
      kind: 'pending',
      projectId: project.id,
      message: `reading your last answer about ${project.name}`,
    };
  }
  const opening = tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'interview_open'),
        eq(tasks.entityId, project.id),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
  if (!opening) tx.enqueue('interview_open', project.id, { runId: null });
  return {
    kind: 'pending',
    projectId: project.id,
    message: `${explicit ? '' : 'Next up: '}${project.name}; the interviewer is writing a question`,
  };
}

// ---- application questions ----------------------------------------------------------------

/** The latest question asked for this form question of this application, if any. */
export function applicationQuestion(
  conn: Conn,
  applicationId: number,
  fieldRef: string,
): InterviewQuestionRow | null {
  return (
    conn
      .select()
      .from(interviewQuestions)
      .where(
        and(
          eq(interviewQuestions.applicationId, applicationId),
          eq(interviewQuestions.fieldRef, fieldRef),
        ),
      )
      .orderBy(desc(interviewQuestions.id))
      .get() ?? null
  );
}

/** Open or processing questions of this application: preparation waits for them. */
export function pendingApplicationQuestions(conn: Conn, applicationId: number): number {
  return conn
    .select({ id: interviewQuestions.id })
    .from(interviewQuestions)
    .where(
      and(
        eq(interviewQuestions.applicationId, applicationId),
        or(eq(interviewQuestions.status, 'open'), eq(interviewQuestions.status, 'processing')),
      ),
    )
    .all().length;
}

/** Facts the candidate gave for this form question of this application (writer context). */
export function interviewFactIds(conn: Conn, applicationId: number, fieldRef: string): number[] {
  const qids = conn
    .select({ id: interviewQuestions.id })
    .from(interviewQuestions)
    .where(
      and(
        eq(interviewQuestions.applicationId, applicationId),
        eq(interviewQuestions.fieldRef, fieldRef),
      ),
    )
    .all()
    .map((q) => interviewLocator(q.id));
  if (!qids.length) return [];
  return conn
    .select({ id: evidence.factId })
    .from(evidence)
    .innerJoin(facts, eq(evidence.factId, facts.id))
    .where(and(inArray(evidence.locator, qids), ne(facts.status, 'rejected')))
    .all()
    .map((r) => r.id);
}
