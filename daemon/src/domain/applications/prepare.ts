// prepare_application: a value for every field of the real form, or a clear "needs you".
//
//   pass 1 (fields not prepared for this form read, a re-prepare was asked, or questions
//           without an answer):
//     slow:    standard fields ← profile (option_match for choices) · writer context →
//              application_writer (one run, ≤ 3 knowledge lookups over MCP)
//     commit:  field values (overrides kept) · answers with every sentence `unchecked` ·
//              enqueue prepare_application again
//   CV pass (the form takes a CV, the application uses a tailored one, and it isn't ready):
//     pending: application_writer plans the CV from confirmed facts → the same checks as
//              answers; a line that fails leaves the CV (listed as dropped)
//     planned: the plan is rendered to a PDF (reader pool) and the Resume field points at it
//   pass 2 (unchecked sentences):
//     slow:    numbers & dates (no model) → claim_verifier (sentences + cited facts only)
//     commit:  flags · stage ready_for_review, or needs_candidate when a required value or
//              answer only the candidate can give is missing
//
// Two passes, like scoring, so the writer's (expensive) output is kept when the verifier then
// hits a limit. A profile value that is missing is never invented: the field is left empty
// and the application waits for the candidate (`applications set-field`, or the profile and
// `applications prepare`). A missing fact becomes an interview question (once per form
// question); answering it saves facts and prepares the application again.
import { join } from 'node:path';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { type FormRead, refKey } from '../../browser/form-types.ts';
import {
  type AnswerRow,
  type ApplicationRow,
  answerSentences,
  answers,
  applications,
  type CompanyRow,
  type CvRow,
  cvs,
  type FieldSource,
  type FieldValueRow,
  fieldValues,
  type InterviewQuestionRow,
  type PostingRow,
  postings,
  tasks,
} from '../../db/schema.ts';
import type { Provider } from '../../models/roles.ts';
import type { Draft } from '../../models/schemas/application.ts';
import type { Handler, HandlerContext, Outcome, Task, Tx } from '../../queue/types.ts';
import {
  companyForPosting,
  companyKey,
  isFresh,
  RETRY_FAILED_MS,
  requestResearch,
  researchInFlight,
  researchPaused,
} from '../companies/store.ts';
import { factRefs } from '../knowledge/facts.ts';
import { applicationQuestion, askQuestion } from '../knowledge/interview.ts';
import { getStandardProfile, type StandardProfile } from '../knowledge/profile.ts';
import { checkSentences, type SentenceToCheck } from './checks/verify.ts';
import { cvHeader, cvHtml, loadTemplate, renderPdf, storePdf } from './cv/render.ts';
import {
  applyChecks,
  buildCvContext,
  excludeUnconfirmed,
  factStatuses,
  linesToCheck,
  planFromOutput,
  planIsEmpty,
  runCvWriter,
} from './cv/select.ts';
import { applyCvToFields, ensureCv, getCv, isResumeField, sameCv, updateCv } from './cv/store.ts';
import { READABLE_STAGES } from './read-form.ts';
import {
  activeRefs,
  type FieldDefault,
  type FormField,
  fieldRole,
  formFields,
  prepareStandardFields,
  profileText,
} from './standard-fields.ts';
import { applicationView, emitStage, loadAnswers, loadFieldRows } from './store.ts';
import { runWriter } from './writer.ts';
import { buildWriterContext, type WriterQuestion } from './writer-context.ts';

/** Failed writer / verifier runs are retried this many times, then the candidate is told. */
export const PREPARE_ATTEMPTS = 3;

/** Profile values an answer may state (and whose numbers need no fact). */
const CONTEXT_KEYS = [
  'location',
  'work_authorization',
  'visa_sponsorship',
  'relocation',
  'notice_period',
  'salary_expectation',
  'current_company',
  'current_title',
] as const;

type StoredAnswer = AnswerRow & { sentences: Array<{ text: string; factIds: number[] }> };

const noop: Outcome = { kind: 'done', commit: () => {} };

export const prepareApplication: Handler<'prepare_application'> = async (task, ctx) => {
  const app = ctx.read.select().from(applications).where(eq(applications.id, task.entityId)).get();
  if (!app || app.stage === 'approved') return noop;
  const posting = ctx.read.select().from(postings).where(eq(postings.id, app.postingId)).get();
  if (!posting) return noop;

  if (posting.formStatus === null) return waitForForm(app, posting);
  if (posting.formStatus !== 'verified' || !posting.form) return noForm(app, posting);

  const read: FormRead = posting.form;
  const fields = formFields(read);
  const takesCv = fields.some((f) => isResumeField(f.spec));
  const rows = new Map(loadFieldRows(ctx.read, app.id).map((r) => [r.fieldRef, r]));
  const stored = new Map<string, StoredAnswer>(
    loadAnswers(ctx.read, app.id).map((a) => [a.questionRef, a]),
  );
  const profile = getStandardProfile(ctx.read);
  const needFields =
    app.refreshFields ||
    app.fieldsFormAt?.getTime() !== posting.formReadAt?.getTime() ||
    fields.some((f) => !rows.has(f.ref));

  // Standard fields: from the profile (again) or as stored.
  let defaults: Map<string, FieldDefault>;
  if (needFields) {
    ctx.progress({ message: `preparing ${fields.length} fields` });
    const res = await prepareStandardFields(fields, {
      decide: (role, req) => ctx.deps.models.decide(role, req),
      profile,
      job: { title: posting.title, company: posting.company },
      taskId: task.id,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
    });
    if (res.limit) {
      return {
        kind: 'pause_provider',
        provider: res.limit.provider as Provider,
        until: res.limit.until,
      };
    }
    defaults = res.defaults;
  } else {
    defaults = new Map(
      [...rows.values()]
        .filter((r) => fieldRole(r.spec) !== 'question')
        .map((r) => [r.fieldRef, { value: r.defaultValue, source: r.defaultSource, note: r.note }]),
    );
  }

  const valueFor = (f: FormField): string | null => {
    const row = rows.get(f.ref);
    if (row?.source === 'override') return row.value;
    if (fieldRole(f.spec) === 'question') return answerValue(stored.get(f.ref) ?? null);
    return defaults.get(f.ref)?.value ?? null;
  };
  const toWrite = questionsToWrite(fields, { app, rows, stored, valueFor });

  if (needFields || toWrite.length) {
    // Company research runs once per company as part of preparing. Answers wait for research
    // the company has never had, so "Why us?" is written from its profile.
    const gate = companyGate(ctx, posting);
    if (gate.kind === 'start') return startResearch(app, posting, gate.wait && toWrite.length > 0);
    if (gate.kind === 'wait' && toWrite.length) return waitForResearch(app, gate.company);

    let drafts = new Map<string, Draft>();
    let questions: WriterQuestion[] = [];
    if (toWrite.length) {
      const wctx = await buildWriterContext(ctx.read, ctx.deps, {
        applicationId: app.id,
        posting,
        questions: writerQuestions(toWrite, fields),
        profile: contextProfile(profile, fields, rows),
        signal: ctx.signal,
        onEmbedError: (err) => ctx.deps.log.warn('question embedding failed', { err: err.message }),
      });
      questions = wctx.questions;
      ctx.progress({ message: `drafting ${questions.length} answer(s)` });
      const res = await runWriter(
        wctx,
        { models: ctx.deps.models, mcp: ctx.deps.mcp },
        { taskId: task.id, signal: ctx.signal, progress: (message) => ctx.progress({ message }) },
      );
      if (res.kind === 'limit')
        return { kind: 'pause_provider', provider: res.provider, until: res.until };
      if (res.kind === 'failed')
        return failOrRetry(task, app, `drafting answers failed: ${res.reason}`, ctx);
      drafts = new Map(res.output.drafts.map((d) => [d.question, d]));
      if (res.calls.length) {
        ctx.progress({
          message: `writer lookups: ${res.calls.map((c) => `${c.tool} ${c.outcome}`).join(', ')}`,
        });
      }
    }
    const written = questions.map((q) => ({ q, draft: drafts.get(q.id) ?? null }));
    return {
      kind: 'done',
      commit: (tx) => {
        const current = tx.db.select().from(applications).where(eq(applications.id, app.id)).get();
        if (!current || current.stage === 'approved') return;
        askInterview(tx, app.id, written);
        saveFields(tx, app.id, fields, defaults, written);
        syncCv(tx, app, takesCv, profile);
        tx.db
          .update(applications)
          .set({
            // A re-prepare asked while this pass ran is honoured by the next pass.
            refreshFields: current.refreshFields && !app.refreshFields,
            rewriteAnswers: current.rewriteAnswers && !app.rewriteAnswers,
            fieldsFormAt: posting.formReadAt,
            channel: 'web_form',
            note: written.length
              ? `drafted ${written.length} answer(s); checking them`
              : 'fields prepared',
            updatedAt: tx.now,
          })
          .where(eq(applications.id, app.id))
          .run();
        tx.enqueue('prepare_application', app.id);
      },
    };
  }

  // The CV pass: write the tailored CV's plan, then render it.
  if (takesCv) {
    const cv = getCv(ctx.read, app.id);
    if (!cv) {
      // Prepared before tailored CVs existed: start one now.
      return {
        kind: 'done',
        commit: (tx) => {
          if (getApplicationStage(tx, app.id) === 'approved') return;
          syncCv(tx, app, true, profile);
          tx.enqueue('prepare_application', app.id);
        },
      };
    }
    if (cv.mode === 'tailored' && (cv.status === 'pending' || cv.status === 'planned')) {
      return cvPass(task, app, posting, cv, profile, ctx);
    }
  }

  // Pass 2: check what was drafted.
  const unchecked: SentenceToCheck[] = [];
  const allAnswers = loadAnswers(ctx.read, app.id);
  const cited = factRefs(
    ctx.read,
    allAnswers.flatMap((a) => a.sentences.flatMap((s) => s.factIds)),
  );
  for (const a of allAnswers) {
    for (const s of a.sentences) {
      if (s.flag !== 'unchecked') continue;
      unchecked.push({
        key: `${s.id}`,
        text: s.text,
        facts: s.factIds.map((id) => {
          const f = cited.get(id);
          return { id, text: f?.text ?? '(no longer exists)', period: f?.period ?? null };
        }),
      });
    }
  }
  let results = new Map<string, { flag: string; note: string | null }>();
  if (unchecked.length) {
    ctx.progress({ message: `checking ${unchecked.length} sentence(s)` });
    const ctxProfile = contextProfile(profile, fields, rows);
    const res = await checkSentences(unchecked, ctx.deps.models, {
      taskId: task.id,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
      allowedNumbers: Object.values(ctxProfile),
    });
    if (res.kind === 'limit')
      return { kind: 'pause_provider', provider: res.provider, until: res.until };
    if (res.kind === 'failed')
      return failOrRetry(task, app, `checking answers failed: ${res.reason}`, ctx);
    results = res.results;
  }
  const before = applicationView(ctx.read, app.id);
  const commit = (tx: Tx) => {
    const current = tx.db.select().from(applications).where(eq(applications.id, app.id)).get();
    if (!current || current.stage === 'approved') return;
    for (const s of unchecked) {
      const r = results.get(s.key);
      if (!r) continue;
      // Only if the sentence is still the one that was checked.
      tx.db
        .update(answerSentences)
        .set({ flag: r.flag, note: r.note })
        .where(
          and(
            eq(answerSentences.id, Number(s.key)),
            eq(answerSentences.text, s.text),
            eq(answerSentences.flag, 'unchecked'),
          ),
        )
        .run();
    }
    finalize(tx, current);
  };
  if (before.missing.length) {
    return {
      kind: 'needs_candidate',
      commit,
      handOff: {
        reason: `needs you: ${before.missing.length} value(s) only you can give`,
        detail: before.missing.join('\n'),
      },
    };
  }
  return { kind: 'done', commit };
};

// ---- the CV --------------------------------------------------------------------------------

function getApplicationStage(tx: Tx, id: number): string | null {
  return (
    tx.db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, id))
      .get()?.stage ?? null
  );
}

/**
 * After pass 1: the CV row follows the form (created when it takes a CV, removed when it no
 * longer does); `prepare --rewrite` writes the tailored CV again, a re-prepare renders it again
 * (the profile's header may have changed) and retries one that couldn't be made.
 */
function syncCv(tx: Tx, app: ApplicationRow, takesCv: boolean, profile: StandardProfile): void {
  const existing = getCv(tx.db, app.id);
  if (!takesCv) {
    if (existing) tx.db.delete(cvs).where(eq(cvs.id, existing.id)).run();
    return;
  }
  const cv = existing ?? ensureCv(tx, app.id);
  if (cv.mode === 'tailored') {
    if (app.rewriteAnswers && existing) {
      updateCv(tx, cv.id, {
        status: 'pending',
        plan: null,
        pdfPath: null,
        pdfHash: null,
        note: null,
      });
    } else if (app.refreshFields && cv.status === 'ready') {
      updateCv(tx, cv.id, { status: 'planned', pdfPath: null, pdfHash: null });
    } else if (app.refreshFields && cv.status === 'skipped') {
      updateCv(tx, cv.id, { status: 'pending', note: null });
    }
  }
  applyCvToFields(tx, app.id, profile);
}

async function cvPass(
  task: Task<'prepare_application'>,
  app: ApplicationRow,
  posting: PostingRow,
  cv: CvRow,
  profile: StandardProfile,
  ctx: HandlerContext,
): Promise<Outcome> {
  const commitCv =
    (
      set: Parameters<typeof updateCv>[2],
      note: string,
      check?: (tx: Tx) => Parameters<typeof updateCv>[2],
    ) =>
    (tx: Tx) => {
      if (getApplicationStage(tx, app.id) === 'approved') return;
      if (!sameCv(cv, getCv(tx.db, app.id))) return;
      updateCv(tx, cv.id, check ? check(tx) : set);
      applyCvToFields(tx, app.id, profile);
      tx.db
        .update(applications)
        .set({ note, updatedAt: tx.now })
        .where(eq(applications.id, app.id))
        .run();
      tx.enqueue('prepare_application', app.id);
    };
  const skip = (why: string): Outcome => ({
    kind: 'done',
    commit: commitCv({ status: 'skipped', note: why }, `no tailored CV: ${why}`),
  });
  const failed = (reason: string) =>
    failOrRetry(
      task,
      app,
      `${reason} (\`applications cv use-base ${app.id}\` sends your base CV instead)`,
      ctx,
    );

  const header = cvHeader(profile);
  if (!header) return skip('full_name is not in your profile');

  if (cv.status === 'pending' || !cv.plan) {
    const cctx = buildCvContext(ctx.read, posting);
    if (!cctx.citable.size) return skip('no confirmed facts yet');
    ctx.progress({ message: `tailoring your CV from ${cctx.citable.size} confirmed facts` });
    const res = await runCvWriter(cctx, ctx.deps.models, {
      taskId: task.id,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
    });
    if (res.kind === 'limit')
      return { kind: 'pause_provider', provider: res.provider, until: res.until };
    if (res.kind === 'failed') return failed(`tailoring your CV failed: ${res.reason}`);
    let plan = planFromOutput(res.output, cctx);
    const items = linesToCheck(plan, cctx);
    if (items.length) {
      ctx.progress({ message: `checking ${items.length} CV line(s)` });
      const checked = await checkSentences(items, ctx.deps.models, {
        taskId: task.id,
        signal: ctx.signal,
        progress: (message) => ctx.progress({ message }),
      });
      if (checked.kind === 'limit')
        return { kind: 'pause_provider', provider: checked.provider, until: checked.until };
      if (checked.kind === 'failed') return failed(`checking your CV failed: ${checked.reason}`);
      plan = applyChecks(plan, checked.results);
    }
    return {
      kind: 'done',
      commit: commitCv({}, 'tailored CV written; rendering it', (tx) => {
        // A fact rejected while the writer ran: its lines leave the CV too.
        const final = excludeUnconfirmed(plan, factStatuses(tx.db, plan));
        return planIsEmpty(final)
          ? {
              status: 'skipped',
              plan: final,
              note: 'every line was left out (see the dropped lines)',
            }
          : { status: 'planned', plan: final, note: null };
      }),
    };
  }

  ctx.progress({ message: 'rendering your CV' });
  let stored: { path: string; hash: string };
  try {
    const html = cvHtml(cv.plan, header, loadTemplate(ctx.deps.dirs.cvTemplate ?? null));
    const pdf = await renderPdf(ctx.deps.reader, html, ctx.signal);
    stored = storePdf(join(ctx.deps.dirs.files, 'cv'), app.id, pdf);
  } catch (err) {
    ctx.signal.throwIfAborted();
    return failed(`rendering your CV failed: ${(err as Error).message.split('\n')[0]}`);
  }
  return {
    kind: 'done',
    commit: (tx) =>
      commitCv(
        { status: 'ready', pdfPath: stored.path, pdfHash: stored.hash, renderedAt: tx.now },
        'tailored CV ready',
      )(tx),
  };
}

// ---- pieces -------------------------------------------------------------------------------

function answerValue(a: StoredAnswer | null): string | null {
  if (a?.status !== 'answered') return null;
  if (a.kind === 'choice') return a.choice;
  const text = a.sentences
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');
  return text || null;
}

function draftValue(d: Draft, kind: 'text' | 'choice'): string | null {
  if (d.status !== 'answered') return null;
  if (kind === 'choice') return d.choice;
  return (
    d.sentences
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(' ') || null
  );
}

function questionKind(f: FormField): 'text' | 'choice' {
  const { spec } = f;
  if (spec.kind === 'checkbox' && (spec.options?.length ?? 0) <= 1) return 'choice';
  return spec.options?.length && ['select', 'radio', 'combobox', 'checkbox'].includes(spec.kind)
    ? 'choice'
    : 'text';
}

function questionOptions(f: FormField): string[] | null {
  const { spec } = f;
  if (spec.kind === 'checkbox' && (spec.options?.length ?? 0) <= 1) return ['checked', 'unchecked'];
  return questionKind(f) === 'choice' ? spec.options : null;
}

/** Required questions the form will ask (given the values) that need a draft. */
function questionsToWrite(
  fields: FormField[],
  s: {
    app: ApplicationRow;
    rows: Map<string, FieldValueRow>;
    stored: Map<string, StoredAnswer>;
    valueFor(f: FormField): string | null;
  },
): FormField[] {
  const active = activeRefs(
    fields.map((f) => ({ ref: f.ref, step: f.step, spec: f.spec, value: s.valueFor(f) })),
    true,
  );
  return fields.filter((f) => {
    if (fieldRole(f.spec) !== 'question' || !f.spec.required || !active.has(f.ref)) return false;
    if (s.rows.get(f.ref)?.source === 'override') return false;
    const a = s.stored.get(f.ref);
    if (!a) return true;
    if (s.app.rewriteAnswers) return true;
    if (a.edited) return false;
    if (a.question !== f.spec.label) return true;
    return a.status === 'needs_candidate' && s.app.refreshFields;
  });
}

function writerQuestions(
  toWrite: FormField[],
  fields: FormField[],
): Array<Omit<WriterQuestion, 'retrieved' | 'pointsBack'>> {
  const ids = new Map(toWrite.map((f, i) => [f.ref, `q${i + 1}`]));
  const byControl = new Map(fields.map((f) => [`${f.step}:${refKey(f.spec.ref)}`, f]));
  return toWrite.map((f) => {
    const by = f.spec.revealedBy;
    const revealer = by ? byControl.get(`${f.step}:${refKey(by.ref)}`) : undefined;
    const rid = revealer ? ids.get(revealer.ref) : undefined;
    return {
      id: ids.get(f.ref) ?? 'q?',
      fieldRef: f.ref,
      label: f.spec.label,
      kind: questionKind(f),
      options: questionOptions(f),
      required: f.spec.required,
      condition:
        by && rid
          ? `asked only if [${rid}] is answered ${by.value === '*' ? 'at all' : `"${by.value}"`}`
          : null,
    };
  });
}

/** The profile values answers may state, with this application's overrides applied. */
function contextProfile(
  profile: StandardProfile,
  fields: FormField[],
  rows: Map<string, FieldValueRow>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    const v = profile[key];
    if (v) out[key] = v;
  }
  for (const f of fields) {
    const row = rows.get(f.ref);
    if (row?.source !== 'override' || !row.value || !f.spec.meaning) continue;
    if (fieldRole(f.spec) !== 'standard') continue;
    const { key } = profileText(f.spec.meaning, f.spec, profile);
    if ((CONTEXT_KEYS as readonly string[]).includes(key)) out[key] = row.value;
  }
  return out;
}

/**
 * A question the writer couldn't answer from the facts goes to the interview, once per form
 * question: the answer becomes facts, and preparation resumes. Not asked again once answered
 * or dismissed (the candidate writes it then), and never for instructions the posting holds.
 */
function askInterview(
  tx: Tx,
  applicationId: number,
  written: Array<{ q: WriterQuestion; draft: Draft | null }>,
): void {
  for (const { q, draft } of written) {
    if (draft?.status !== 'needs_candidate' || q.pointsBack) continue;
    if (applicationQuestion(tx.db, applicationId, q.fieldRef)) continue;
    askQuestion(tx, {
      projectId: null,
      applicationId,
      fieldRef: q.fieldRef,
      text: q.label,
      // What the writer found missing; the job comes with the application.
      context: draft.missing,
      origin: 'application',
    });
  }
}

/** Where a question left to the candidate stands in the interview, for its field's note. */
function interviewNote(q: InterviewQuestionRow | null): string | null {
  if (!q) return null;
  switch (q.status) {
    case 'open':
    case 'processing':
      return `asked in the interview (question ${q.id})`;
    case 'dismissed':
      return `you skipped it in the interview (question ${q.id}): write the answer yourself`;
    case 'answered':
      return `your interview answer (question ${q.id}) didn't settle it: write the answer yourself`;
  }
}

function saveFields(
  tx: Tx,
  applicationId: number,
  fields: FormField[],
  defaults: Map<string, FieldDefault>,
  written: Array<{ q: WriterQuestion; draft: Draft | null }>,
): void {
  const refs = fields.map((f) => f.ref);
  tx.db
    .delete(fieldValues)
    .where(
      and(eq(fieldValues.applicationId, applicationId), notInArray(fieldValues.fieldRef, refs)),
    )
    .run();
  tx.db
    .delete(answers)
    .where(and(eq(answers.applicationId, applicationId), notInArray(answers.questionRef, refs)))
    .run();

  // Drafts replace their answers.
  const byRef = new Map(written.map((w) => [w.q.fieldRef, w]));
  for (const { q, draft } of written) {
    const old = tx.db
      .select({ id: answers.id })
      .from(answers)
      .where(and(eq(answers.applicationId, applicationId), eq(answers.questionRef, q.fieldRef)))
      .get();
    if (old) tx.db.delete(answers).where(eq(answers.id, old.id)).run();
    const status = draft?.status ?? 'needs_candidate';
    const row = tx.db
      .insert(answers)
      .values({
        applicationId,
        questionRef: q.fieldRef,
        question: q.label,
        kind: q.kind,
        status,
        choice: status === 'answered' ? (draft?.choice ?? null) : null,
        missing: status === 'answered' ? null : (draft?.missing ?? 'the writer gave no draft'),
        adaptedFrom: draft?.adaptedFrom ?? null,
        edited: false,
        createdAt: tx.now,
      })
      .returning({ id: answers.id })
      .get();
    if (status !== 'answered' || !draft) continue;
    draft.sentences
      .filter((s) => s.text.trim())
      .forEach((s, idx) => {
        tx.db
          .insert(answerSentences)
          .values({
            answerId: row.id,
            idx,
            text: s.text.trim(),
            factIds: [...new Set(s.factIds.map((n) => Math.trunc(n)))],
            flag: 'unchecked',
          })
          .run();
      });
  }

  const current = new Map(
    tx.db
      .select()
      .from(fieldValues)
      .where(eq(fieldValues.applicationId, applicationId))
      .all()
      .map((r) => [r.fieldRef, r]),
  );
  const answersNow = new Map(
    tx.db
      .select()
      .from(answers)
      .where(eq(answers.applicationId, applicationId))
      .all()
      .map((a) => [a.questionRef, a]),
  );
  const sentencesNow = answersNow.size
    ? tx.db
        .select()
        .from(answerSentences)
        .where(
          inArray(
            answerSentences.answerId,
            [...answersNow.values()].map((a) => a.id),
          ),
        )
        .all()
    : [];
  for (const f of fields) {
    let d: FieldDefault;
    if (fieldRole(f.spec) === 'question') {
      const w = byRef.get(f.ref);
      const a = answersNow.get(f.ref);
      if (w?.draft) {
        const value = draftValue(w.draft, w.q.kind);
        d = {
          value,
          source: value === null ? 'none' : 'answer',
          note: value === null ? w.draft.missing : null,
        };
      } else if (a) {
        const value = answerValue({
          ...a,
          sentences: sentencesNow.filter((s) => s.answerId === a.id).sort((x, y) => x.idx - y.idx),
        });
        d = {
          value,
          source: value === null ? 'none' : 'answer',
          note: value === null ? a.missing : null,
        };
      } else {
        d = {
          value: null,
          source: 'none',
          note: f.spec.required ? null : 'optional question: left empty',
        };
      }
      if (d.value === null) {
        const asked = interviewNote(applicationQuestion(tx.db, applicationId, f.ref));
        if (asked) d = { ...d, note: [d.note, asked].filter(Boolean).join(' · ') };
      }
    } else {
      d = defaults.get(f.ref) ?? { value: null, source: 'none', note: null };
    }
    const existing = current.get(f.ref);
    const overridden = existing?.source === 'override';
    const set = {
      position: f.position,
      spec: f.spec,
      defaultValue: d.value,
      defaultSource: d.source as FieldSource,
      value: overridden ? existing.value : d.value,
      source: overridden ? ('override' as const) : (d.source as FieldSource),
      note: d.note,
    };
    if (existing) {
      tx.db.update(fieldValues).set(set).where(eq(fieldValues.id, existing.id)).run();
    } else {
      tx.db
        .insert(fieldValues)
        .values({ applicationId, fieldRef: f.ref, ...set })
        .run();
    }
  }
}

/** Stage after preparation: ready for review, or waiting for what only the candidate can give. */
function finalize(tx: Tx, app: ApplicationRow): void {
  const view = applicationView(tx.db, app.id);
  const stage = view.missing.length ? 'needs_candidate' : 'ready_for_review';
  const note = view.missing.length ? `needs you: ${view.missing.slice(0, 4).join('; ')}` : null;
  tx.db
    .update(applications)
    .set({ stage, note, preparedAt: tx.now, updatedAt: tx.now })
    .where(eq(applications.id, app.id))
    .run();
  const flagged = view.answers.flatMap((a) => a.sentences).filter((s) => s.flag !== 'none').length;
  emitStage(
    tx,
    app,
    stage,
    stage === 'ready_for_review'
      ? `application ${app.id}: ready for review${flagged ? ` (${flagged} sentence(s) to look at)` : ''}`
      : `application ${app.id}: needs you (${view.missing.length})`,
  );
}

// ---- company research ------------------------------------------------------------------

type ResearchGate =
  | { kind: 'ready' }
  /** Research is needed; `wait` when there's no profile at all to write from meanwhile. */
  | { kind: 'start'; wait: boolean }
  | { kind: 'wait'; company: CompanyRow };

function companyGate(ctx: HandlerContext, posting: PostingRow): ResearchGate {
  if (!companyKey(posting.company)) return { kind: 'ready' };
  try {
    ctx.deps.models.routeFor('researcher');
  } catch {
    return { kind: 'ready' };
  }
  const now = ctx.now();
  const row = companyForPosting(ctx.read, posting);
  if (!row) return { kind: 'start', wait: true };
  if (researchInFlight(ctx.read, row.id)) {
    // Research held by a subscription limit, or an older profile to write from: go on.
    if (row.profile || researchPaused(ctx.read, row.id, now)) return { kind: 'ready' };
    return { kind: 'wait', company: row };
  }
  if (isFresh(row, now)) return { kind: 'ready' };
  const failedLately =
    row.status === 'failed' &&
    !!row.attemptedAt &&
    now.getTime() - row.attemptedAt.getTime() < RETRY_FAILED_MS;
  if (failedLately) return { kind: 'ready' };
  return { kind: 'start', wait: !row.profile };
}

/** Starts the company's research; the application goes on now, or when research is done. */
function startResearch(app: ApplicationRow, posting: PostingRow, wait: boolean): Outcome {
  return {
    kind: 'done',
    commit: (tx) => {
      if (getApplicationStage(tx, app.id) === 'approved') return;
      const { company } = requestResearch(tx, posting.company ?? '', { trigger: 'prepare' });
      if (wait && researchInFlight(tx.db, company.id)) {
        tx.db
          .update(applications)
          .set({ note: `waiting for company research on ${company.name}`, updatedAt: tx.now })
          .where(eq(applications.id, app.id))
          .run();
      } else {
        tx.enqueue('prepare_application', app.id);
      }
    },
  };
}

function waitForResearch(app: ApplicationRow, company: CompanyRow): Outcome {
  // research_company's commit starts preparation again (done or failed).
  return {
    kind: 'done',
    commit: (tx) => {
      tx.db
        .update(applications)
        .set({ note: `waiting for company research on ${company.name}`, updatedAt: tx.now })
        .where(eq(applications.id, app.id))
        .run();
    },
  };
}

function waitForForm(app: ApplicationRow, posting: PostingRow): Outcome {
  return {
    kind: 'done',
    commit: (tx) => {
      tx.db
        .update(applications)
        .set({ note: 'waiting for the application form to be read', updatedAt: tx.now })
        .where(eq(applications.id, app.id))
        .run();
      const busy = tx.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.kind, 'read_form'),
            eq(tasks.entityId, posting.id),
            inArray(tasks.status, ['queued', 'running']),
          ),
        )
        .get();
      // read_form's commit enqueues prepare_application again once the form is read.
      if (!busy && READABLE_STAGES.includes(posting.stage)) tx.enqueue('read_form', posting.id);
    },
  };
}

function noForm(app: ApplicationRow, posting: PostingRow): Outcome {
  const why =
    posting.formStatus === 'email'
      ? `${posting.formNote ?? 'applies by email'}: email applications arrive in a later phase`
      : posting.formStatus === 'no_form'
        ? `no application form: ${posting.formNote ?? 'none found'}`
        : `the application form couldn't be read: ${posting.formNote ?? ''}`;
  const commit = (tx: Tx) => {
    const row = tx.db
      .update(applications)
      .set({
        stage: 'needs_candidate',
        channel: posting.formStatus === 'email' ? 'email' : 'web_form',
        note: why,
        updatedAt: tx.now,
      })
      .where(eq(applications.id, app.id))
      .returning()
      .get();
    emitStage(tx, row, 'needs_candidate', `application ${app.id}: ${why}`);
  };
  return { kind: 'needs_candidate', commit, handOff: { reason: why, detail: null } };
}

function failOrRetry(
  task: Task<'prepare_application'>,
  app: ApplicationRow,
  reason: string,
  ctx: HandlerContext,
): Outcome {
  if (task.attempts + 1 < PREPARE_ATTEMPTS) {
    return {
      kind: 'retry',
      after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
      reason,
    };
  }
  const note = `preparation failed: ${reason}`.slice(0, 1000);
  return {
    kind: 'needs_candidate',
    handOff: { reason: note, detail: null },
    commit: (tx) => {
      const row = tx.db
        .update(applications)
        .set({ stage: 'needs_candidate', note, updatedAt: tx.now })
        .where(eq(applications.id, app.id))
        .returning()
        .get();
      emitStage(tx, row, 'needs_candidate', `application ${app.id}: ${note}`);
    },
  };
}
