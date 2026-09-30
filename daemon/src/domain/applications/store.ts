// Applications as stored, and the view review, the approve gate and the RPCs all read.
//
// Which fields apply is derived, never stored: it depends on the effective values (overrides
// included), so an override that changes a branch changes what the form will ask. Likewise
// "relies on an unconfirmed fact" is derived from the cited facts' current status, so
// confirming a fact anywhere clears it everywhere.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type ElementRef, refKey } from '../../browser/form-types.ts';
import { platformOf } from '../../browser/guardrails.ts';
import type { Conn } from '../../db/client.ts';
import {
  type AnswerRow,
  type AnswerSentenceRow,
  type ApplicationRow,
  type ApplicationStage,
  type ApplyForm,
  answerSentences,
  answers,
  applications,
  type FieldSource,
  type FieldValueRow,
  facts,
  fieldValues,
  interviewQuestions,
  type PostingRow,
  postingSources,
  postings,
  projects,
  type ReceiptFieldValue,
  receipts,
  tasks,
} from '../../db/schema.ts';
import type { HandOff, Tx } from '../../queue/types.ts';
import { type CompanyView, companyForPosting, companyView } from '../companies/store.ts';
import { atsJobKey } from '../search/readers/ats-embed.ts';
import { type CvView, cvView } from './cv/store.ts';
import { activeRefs, type FieldRole, fieldRole } from './standard-fields.ts';

export class ApplicationError extends Error {}

/** Flags that block approve. `unconfirmed` and `rejected_fact` are derived from the facts. */
export type SentenceFlag = string;

export interface CitedFactView {
  id: number;
  text: string;
  status: 'unconfirmed' | 'confirmed' | 'rejected' | 'missing';
  kind: string | null;
  origin: string | null;
  projectSlug: string | null;
}

export interface SentenceView {
  idx: number;
  text: string;
  factIds: number[];
  /** The effective flag: the check's, else unconfirmed / rejected_fact from the facts, else none. */
  flag: SentenceFlag;
  /** What the check stored (none · unchecked · absent_number · contradiction · verifier:…). */
  checkFlag: string;
  note: string | null;
  facts: CitedFactView[];
}

export interface AnswerView {
  /** 1-based, in form order: the CLI's q1, q2, … */
  number: number;
  id: number;
  ref: string;
  question: string;
  kind: 'text' | 'choice';
  status: 'answered' | 'needs_candidate';
  choice: string | null;
  missing: string | null;
  adaptedFrom: string | null;
  edited: boolean;
  /** The form will ask it (its branch applies). */
  active: boolean;
  /** The candidate set the field's value directly: this draft isn't used. */
  overridden: boolean;
  /** needs_candidate: the interview question waiting on the candidate for it (open or being read). */
  interviewQuestionId: number | null;
  sentences: SentenceView[];
}

export interface FieldView {
  /** 1-based position: the CLI's #n. */
  number: number;
  ref: string;
  step: number;
  label: string;
  kind: string;
  meaning: string | null;
  required: boolean;
  options: string[] | null;
  role: FieldRole;
  value: string | null;
  source: FieldSource;
  defaultValue: string | null;
  defaultSource: FieldSource;
  note: string | null;
  active: boolean;
  /** Required, applies, and has no value. */
  missing: boolean;
  /** For entry fields: their group's ref. */
  entryOf: string | null;
  /** Conditional: "shown when <label> is <value>". */
  condition: string | null;
}

export interface ReceiptView {
  finalUrl: string;
  confirmationText: string | null;
  cvPath: string | null;
  cvHash: string | null;
  salaryValue: string | null;
  submittedAt: Date;
  fieldValues: ReceiptFieldValue[];
}

export interface ApplicationView {
  app: ApplicationRow;
  posting: Pick<PostingRow, 'id' | 'title' | 'company' | 'score' | 'canonicalUrl' | 'formNote'> & {
    formUrl: string | null;
  };
  fields: FieldView[];
  answers: AnswerView[];
  /** Why approve is refused; empty = approvable. */
  blockers: string[];
  /** What only the candidate can give (fields and answers). */
  missing: string[];
  /** Unconfirmed facts the application relies on. */
  unconfirmedFactIds: number[];
  /** The CV its form takes (tailored or base), or null when the form takes none. */
  cv: CvView | null;
  /** Set once delivery has submitted the application. */
  receipt: ReceiptView | null;
  /** The most recent delivery hand-off still waiting on the candidate, if any. */
  handOff: HandOff | null;
  /** The form it goes through, and whether the posting has both (platform's and company's). */
  applyForm: { form: ApplyForm; switchable: boolean };
  /** The company's research (phase 12), once asked for (postings left out). */
  company: CompanyView | null;
}

// ---- creating and (re-)preparing ------------------------------------------------------------

function emitStage(
  tx: Tx,
  app: Pick<ApplicationRow, 'id' | 'postingId'>,
  stage: string,
  message: string,
  /** `sync_mail` when a reply the mailbox read moved it (ApplicationEvent.from_mail). */
  taskKind: string | null = null,
) {
  tx.emit({
    kind: 'application.stage',
    entityId: app.id,
    postingId: app.postingId,
    stage,
    message,
    taskKind,
  });
}

export function prepareQueued(conn: Conn, id: number): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'prepare_application'),
        eq(tasks.entityId, id),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
}

/**
 * The posting's application, created at `preparing` (with a prepare task) when it has none.
 * Called when a score reaches the threshold, when the candidate marks a posting interested,
 * and by `applications prepare`.
 */
export function ensureApplication(
  tx: Tx,
  postingId: number,
  why: string,
): { app: ApplicationRow; created: boolean } {
  const existing = tx.db
    .select()
    .from(applications)
    .where(eq(applications.postingId, postingId))
    .get();
  if (existing) return { app: existing, created: false };
  const app = tx.db
    .insert(applications)
    .values({
      postingId,
      stage: 'preparing',
      note: why,
      refreshFields: true,
      createdAt: tx.now,
      updatedAt: tx.now,
    })
    .returning()
    .get();
  emitStage(tx, app, 'preparing', `application ${app.id}: preparing (${why})`);
  tx.enqueue('prepare_application', app.id);
  return { app, created: true };
}

/**
 * Prepares an application again: standard fields are recomputed from the current profile
 * (overrides stay), answers that are missing or were left to the candidate are drafted again
 * (every answer with `rewrite`). Edits the candidate made stay unless `rewrite`.
 */
export function requestPrepare(
  tx: Tx,
  app: ApplicationRow,
  o: { rewrite: boolean; why: string },
): ApplicationRow {
  if (app.stage === 'approved') {
    throw new ApplicationError(`application ${app.id} is already approved`);
  }
  const row = tx.db
    .update(applications)
    .set({
      stage: 'preparing',
      refreshFields: true,
      rewriteAnswers: app.rewriteAnswers || o.rewrite,
      note: o.why,
      updatedAt: tx.now,
    })
    .where(eq(applications.id, app.id))
    .returning()
    .get();
  if (app.stage !== 'preparing') emitStage(tx, row, 'preparing', `application ${app.id}: ${o.why}`);
  if (!prepareQueued(tx.db, app.id)) tx.enqueue('prepare_application', app.id);
  return row;
}

/**
 * At start: postings that qualified before applications existed (scored at or above the
 * threshold with no dealbreaker, or marked interested) get theirs. Returns how many started.
 */
export function catchUpApplications(tx: Tx, threshold: number): number {
  const have = applicationsByPosting(tx.db);
  let n = 0;
  for (const p of tx.db.select().from(postings).where(eq(postings.stage, 'scored')).all()) {
    if (have.has(p.id)) continue;
    const qualifies =
      p.decision === 'interested' ||
      (p.decision === null &&
        p.score !== null &&
        p.score >= threshold &&
        !(p.dealbreakers ?? []).length);
    if (!qualifies) continue;
    ensureApplication(
      tx,
      p.id,
      p.decision === 'interested' ? 'you marked it interested' : `score ${p.score} ≥ ${threshold}`,
    );
    n++;
  }
  return n;
}

/** After a form (re-)read: an application waiting for it, or not yet approved, is prepared. */
export function formReadFor(tx: Tx, postingId: number): void {
  const app = tx.db.select().from(applications).where(eq(applications.postingId, postingId)).get();
  if (!app || app.stage === 'approved') return;
  requestPrepare(tx, app, { rewrite: false, why: 'the application form was read' });
}

/**
 * The forms a posting can be applied through: the company's own (its apply URL, or — when that
 * is on LinkedIn/Xing — the same job on the company's ATS, from another of its source URLs or
 * its canonical URL) and the platform's (LinkedIn Easy Apply, Xing apply: the apply URL or a
 * source URL on the platform). Either may be missing.
 */
export function applyTargets(
  read: Conn,
  posting: Pick<PostingRow, 'id' | 'applyUrl' | 'canonicalUrl'>,
): { company: string | null; platform: string | null } {
  const own = posting.applyUrl ?? posting.canonicalUrl;
  const urls = [
    own,
    posting.canonicalUrl,
    ...read
      .select({ url: postingSources.url })
      .from(postingSources)
      .where(eq(postingSources.postingId, posting.id))
      .all()
      .map((r) => r.url),
  ];
  const platform = urls.find((u) => platformOf(u) !== null) ?? null;
  const company = !platformOf(own)
    ? own
    : (urls.find((u) => !platformOf(u) && !u.startsWith('mailto:') && atsJobKey(u)) ?? null);
  return { company, platform };
}

/**
 * Where a posting is applied to (Read and Deliver agree on it): the company's own form (PRD:
 * "the company's own form is the default"), unless the candidate switched its application to
 * the platform's form (`applications form <id> platform`); the apply URL when there's no other.
 */
export function applyTarget(
  read: Conn,
  posting: Pick<PostingRow, 'id' | 'applyUrl' | 'canonicalUrl'>,
): string {
  const targets = applyTargets(read, posting);
  const choice = read
    .select({ form: applications.applyForm })
    .from(applications)
    .where(eq(applications.postingId, posting.id))
    .get()?.form;
  const picked = choice === 'platform' ? targets.platform : targets.company;
  return picked ?? targets.company ?? targets.platform ?? posting.applyUrl ?? posting.canonicalUrl;
}

/** The form an application goes through now, and whether the candidate can switch it. */
export function applyFormOf(
  read: Conn,
  app: Pick<ApplicationRow, 'postingId'>,
): { form: ApplyForm; switchable: boolean } {
  const posting = read.select().from(postings).where(eq(postings.id, app.postingId)).get();
  if (!posting) return { form: 'company', switchable: false };
  const targets = applyTargets(read, posting);
  const target = applyTarget(read, posting);
  return {
    form: targets.platform !== null && target === targets.platform ? 'platform' : 'company',
    switchable: targets.company !== null && targets.platform !== null,
  };
}

export function getApplicationRow(conn: Conn, id: number): ApplicationRow {
  const row = conn.select().from(applications).where(eq(applications.id, id)).get();
  if (!row) throw new ApplicationError(`no application ${id}`);
  return row;
}

/** posting id → its application (id, stage), for posting lists. */
export function applicationsByPosting(
  conn: Conn,
): Map<number, Pick<ApplicationRow, 'id' | 'stage'>> {
  return new Map(
    conn
      .select({ id: applications.id, stage: applications.stage, postingId: applications.postingId })
      .from(applications)
      .all()
      .map((r) => [r.postingId, { id: r.id, stage: r.stage }]),
  );
}

export function listApplications(conn: Conn, stage?: ApplicationStage): ApplicationRow[] {
  const q = conn.select().from(applications);
  return (stage ? q.where(eq(applications.stage, stage)) : q).orderBy(desc(applications.id)).all();
}

// ---- the view -----------------------------------------------------------------------------

export function citedFacts(conn: Conn, ids: number[]): Map<number, CitedFactView> {
  const out = new Map<number, CitedFactView>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = conn
      .select({
        id: facts.id,
        text: facts.text,
        status: facts.status,
        kind: facts.kind,
        origin: facts.origin,
        projectSlug: projects.slug,
      })
      .from(facts)
      .leftJoin(projects, eq(facts.projectId, projects.id))
      .where(inArray(facts.id, unique.slice(i, i + 500)))
      .all();
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

export function effectiveFlag(checkFlag: string, cited: CitedFactView[]): SentenceFlag {
  if (checkFlag !== 'none') return checkFlag;
  if (cited.some((f) => f.status === 'rejected' || f.status === 'missing')) return 'rejected_fact';
  if (cited.some((f) => f.status === 'unconfirmed')) return 'unconfirmed';
  return 'none';
}

export const FLAG_TEXT: Record<string, string> = {
  unchecked: 'not checked yet',
  unconfirmed: 'relies on an unconfirmed fact',
  rejected_fact: 'cites a fact you rejected (or that no longer exists)',
  absent_number: 'a number not in the cited facts',
  contradiction: 'contradicts a cited fact',
  'verifier:quantity': 'the verifier: overstates a quantity',
  'verifier:role': 'the verifier: overstates the role',
  'verifier:scope': 'the verifier: overstates the scope',
  'verifier:timeframe': 'the verifier: wrong timeframe',
  'verifier:unsupported': 'the verifier: no cited fact shows this',
};

export function loadFieldRows(conn: Conn, applicationId: number): FieldValueRow[] {
  return conn
    .select()
    .from(fieldValues)
    .where(eq(fieldValues.applicationId, applicationId))
    .orderBy(asc(fieldValues.position))
    .all();
}

export function loadAnswers(
  conn: Conn,
  applicationId: number,
): Array<AnswerRow & { sentences: AnswerSentenceRow[] }> {
  const rows = conn.select().from(answers).where(eq(answers.applicationId, applicationId)).all();
  if (rows.length === 0) return [];
  const sentences = conn
    .select()
    .from(answerSentences)
    .where(
      inArray(
        answerSentences.answerId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(answerSentences.idx))
    .all();
  return rows.map((r) => ({ ...r, sentences: sentences.filter((s) => s.answerId === r.id) }));
}

export function applicationView(conn: Conn, id: number): ApplicationView {
  const app = getApplicationRow(conn, id);
  const posting = conn.select().from(postings).where(eq(postings.id, app.postingId)).get();
  if (!posting) throw new ApplicationError(`application ${id} has no posting`);
  const rows = loadFieldRows(conn, id);
  const active = activeRefs(
    rows.map((r) => ({ ref: r.fieldRef, step: stepOf(r.fieldRef), spec: r.spec, value: r.value })),
  );
  const labelOf = new Map<string, string>();
  for (const r of rows)
    labelOf.set(`${stepOf(r.fieldRef)}:${controlKey(r.spec.ref)}`, r.spec.label);

  const fields: FieldView[] = rows.map((r, i) => {
    const role = fieldRole(r.spec);
    const isActive = active.has(r.fieldRef);
    const by = r.spec.revealedBy;
    let missing = false;
    if (isActive && r.spec.required && role !== 'entry')
      missing = r.value === null || r.value === '';
    return {
      number: i + 1,
      ref: r.fieldRef,
      step: stepOf(r.fieldRef),
      label: r.spec.label,
      kind: r.spec.kind,
      meaning: r.spec.meaning,
      required: r.spec.required,
      options: r.spec.options,
      role,
      value: r.value,
      source: r.source,
      defaultValue: r.defaultValue,
      defaultSource: r.defaultSource,
      note: r.note,
      active: isActive,
      missing,
      entryOf: by?.value === 'add' ? `${stepOf(r.fieldRef)}:${controlKey(by.ref)}` : null,
      condition:
        by && by.value !== 'add'
          ? `shown when "${labelOf.get(`${stepOf(r.fieldRef)}:${controlKey(by.ref)}`) ?? 'another field'}" is ${by.value === '*' ? 'answered' : `"${by.value}"`}`
          : null,
    };
  });
  const fieldByRef = new Map(fields.map((f) => [f.ref, f]));

  const stored = loadAnswers(conn, id).sort(
    (a, b) =>
      (fieldByRef.get(a.questionRef)?.number ?? 1e9) -
      (fieldByRef.get(b.questionRef)?.number ?? 1e9),
  );
  const cited = citedFacts(
    conn,
    stored.flatMap((a) => a.sentences.flatMap((s) => s.factIds)),
  );
  const asked = new Map(
    conn
      .select({ id: interviewQuestions.id, fieldRef: interviewQuestions.fieldRef })
      .from(interviewQuestions)
      .where(
        and(
          eq(interviewQuestions.applicationId, id),
          inArray(interviewQuestions.status, ['open', 'processing']),
        ),
      )
      .orderBy(asc(interviewQuestions.id))
      .all()
      .map((q) => [q.fieldRef, q.id]),
  );
  const answerViews: AnswerView[] = stored.map((a, i) => {
    const field = fieldByRef.get(a.questionRef);
    return {
      number: i + 1,
      id: a.id,
      ref: a.questionRef,
      question: a.question,
      kind: a.kind,
      status: a.status,
      choice: a.choice,
      missing: a.missing,
      adaptedFrom: a.adaptedFrom,
      edited: a.edited,
      active: field?.active ?? false,
      overridden: field?.source === 'override',
      interviewQuestionId:
        a.status === 'needs_candidate' ? (asked.get(a.questionRef) ?? null) : null,
      sentences: a.sentences.map((s) => {
        const f = s.factIds.map(
          (fid): CitedFactView =>
            cited.get(fid) ?? {
              id: fid,
              text: '(no longer exists)',
              status: 'missing',
              kind: null,
              origin: null,
              projectSlug: null,
            },
        );
        return {
          idx: s.idx,
          text: s.text,
          factIds: s.factIds,
          flag: effectiveFlag(s.flag, f),
          checkFlag: s.flag,
          note: s.note,
          facts: f,
        };
      }),
    };
  });

  // What only the candidate can give, and everything else that blocks approve.
  const missing: string[] = [];
  const answered = new Set(answerViews.filter((a) => a.status === 'answered').map((a) => a.ref));
  for (const f of fields) {
    if (!f.missing) continue;
    if (f.role === 'question' && answered.has(f.ref)) continue;
    missing.push(`#${f.number} ${f.label || f.kind}${f.note ? ` (${f.note})` : ''}`);
  }
  const blockers: string[] = [];
  if (app.stage === 'preparing') blockers.push('still being prepared');
  if (missing.length) {
    blockers.push(
      `${missing.length} required field(s) need a value: ${missing.slice(0, 6).join('; ')}`,
    );
  }
  const counted = answerViews.filter((a) => a.active && !a.overridden);
  const unconfirmed = new Set<number>();
  const flagged: string[] = [];
  let unchecked = 0;
  for (const a of counted) {
    for (const s of a.sentences) {
      for (const f of s.facts) if (f.status === 'unconfirmed') unconfirmed.add(f.id);
      if (s.flag === 'unchecked') unchecked++;
      else if (s.flag !== 'none' && s.flag !== 'unconfirmed') {
        flagged.push(`q${a.number}.${s.idx + 1} ${FLAG_TEXT[s.flag] ?? s.flag}`);
      }
    }
  }
  if (unchecked) blockers.push(`${unchecked} sentence(s) not checked yet`);
  if (flagged.length)
    blockers.push(`${flagged.length} flagged sentence(s): ${flagged.slice(0, 6).join('; ')}`);
  if (unconfirmed.size) {
    blockers.push(
      `${unconfirmed.size} unconfirmed fact(s): ${[...unconfirmed].map((n) => `#${n}`).join(', ')}`,
    );
  }
  const cv = cvView(conn, id);
  if (cv?.stale.length) {
    blockers.push(
      `the tailored CV cites facts that are no longer confirmed (${cv.stale.join(', ')}): edit or remove those lines, or \`applications prepare ${id} --rewrite\``,
    );
  }
  if (app.stage === 'approved' || app.stage === 'applied') blockers.length = 0;

  const receiptRow = conn.select().from(receipts).where(eq(receipts.applicationId, id)).get();
  const hoTask = conn
    .select({ note: tasks.note })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'deliver_application'),
        eq(tasks.entityId, id),
        eq(tasks.status, 'needs_candidate'),
      ),
    )
    .orderBy(desc(tasks.id))
    .get();
  let handOff: HandOff | null = null;
  if (hoTask?.note) {
    try {
      handOff = JSON.parse(hoTask.note) as HandOff;
    } catch {
      handOff = null;
    }
  }

  return {
    app,
    posting: {
      id: posting.id,
      title: posting.title,
      company: posting.company,
      score: posting.score,
      canonicalUrl: posting.canonicalUrl,
      formNote: posting.formNote,
      formUrl: posting.form?.url ?? null,
    },
    fields,
    answers: answerViews,
    cv,
    receipt: receiptRow
      ? {
          finalUrl: receiptRow.finalUrl,
          confirmationText: receiptRow.confirmationText,
          cvPath: receiptRow.cvPath,
          cvHash: receiptRow.cvHash,
          salaryValue: receiptRow.salaryValue,
          submittedAt: receiptRow.submittedAt,
          fieldValues: receiptRow.fieldValues,
        }
      : null,
    handOff,
    applyForm: applyFormOf(conn, app),
    company: companyBriefView(conn, posting),
    blockers,
    missing,
    unconfirmedFactIds: [...unconfirmed],
  };
}

function companyBriefView(conn: Conn, posting: Pick<PostingRow, 'company'>): CompanyView | null {
  const row = companyForPosting(conn, posting);
  return row ? { ...companyView(conn, row, new Date()), postings: [] } : null;
}

export function stepOf(fieldRef: string): number {
  return Number(fieldRef.slice(0, fieldRef.indexOf(':'))) || 1;
}

function controlKey(ref: ElementRef): string {
  return refKey(ref);
}

/**
 * After a review action: ready_for_review when nothing is missing, needs_candidate when
 * something is. Preparing and approved applications are left alone.
 */
export function settleStage(tx: Tx, id: number): ApplicationRow {
  const view = applicationView(tx.db, id);
  const app = view.app;
  if (app.stage !== 'ready_for_review' && app.stage !== 'needs_candidate') return app;
  const stage: ApplicationStage = view.missing.length ? 'needs_candidate' : 'ready_for_review';
  const note = view.missing.length ? `needs you: ${view.missing.slice(0, 4).join('; ')}` : null;
  const row = tx.db
    .update(applications)
    .set({ stage, note, updatedAt: tx.now })
    .where(eq(applications.id, id))
    .returning()
    .get();
  if (stage !== app.stage) {
    emitStage(
      tx,
      row,
      stage,
      stage === 'ready_for_review'
        ? `application ${id}: ready for review`
        : `application ${id}: needs you (${view.missing.length})`,
    );
  }
  return row;
}

export { emitStage };
