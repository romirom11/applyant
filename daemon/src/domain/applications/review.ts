// Review: what the candidate does between "ready for review" and "approved".
//
//   set-field   a value for one field of this application only (an override): the profile is
//               untouched, re-preparation keeps it, clearing it restores the prepared default
//   edit        a sentence (or a whole answer) in the candidate's own words: saved as a
//               confirmed `review_edit` fact, so the next writer cites it and the same
//               exaggeration doesn't come back. Their words aren't verified.
//   confirm     "true as written" for a sentence flagged for a number or by the verifier: the
//               same as an edit that keeps the text. Not for contradictions: those need an edit.
//   confirm facts   the unconfirmed facts the application relies on (candidate fact confirm)
//   approve     refused while anything required is missing, any sentence is flagged or
//               unchecked, or any relied-on fact is unconfirmed
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  type ApplicationRow,
  answerSentences,
  answers,
  applications,
  fieldValues,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { enqueueEmbedFacts } from '../knowledge/embed-index.ts';
import { confirmFact } from '../knowledge/facts.ts';
import { requestRematch } from '../scoring/rematch.ts';
import { getCv, requestCvPass, updateCv } from './cv/store.ts';
import { enqueueDelivery } from './deliver.ts';
import { reviewFact } from './review-fact.ts';
import { entries } from './standard-fields.ts';
import {
  type AnswerView,
  ApplicationError,
  applicationView,
  emitStage,
  type FieldView,
  settleStage,
} from './store.ts';

// ---- handles ------------------------------------------------------------------------------

/** A field by its number (#3 / 3), its meaning, its label or its ref. */
export function findField(fields: FieldView[], handle: string): FieldView {
  const h = handle.trim();
  const n = /^#?(\d+)$/.exec(h);
  if (n) {
    const f = fields.find((x) => x.number === Number(n[1]));
    if (f) return f;
    throw new ApplicationError(`no field #${n[1]} (see \`applications preview\`)`);
  }
  const exact = fields.find((x) => x.ref === h);
  if (exact) return exact;
  const pick = (list: FieldView[], what: string): FieldView | null => {
    if (list.length === 0) return null;
    const active = list.filter((f) => f.active);
    const pool = active.length ? active : list;
    if (pool.length === 1) return pool[0] ?? null;
    throw new ApplicationError(
      `"${h}" matches ${pool.length} fields by ${what}: use a number (${pool.map((f) => `#${f.number}`).join(', ')})`,
    );
  };
  const lower = h.toLowerCase();
  return (
    pick(
      fields.filter((f) => f.label.trim().toLowerCase() === lower),
      'label',
    ) ??
    // A meaning never names a field of a group's entry (the group is set as a whole).
    pick(
      fields.filter((f) => f.meaning === lower && f.role !== 'entry'),
      'meaning',
    ) ??
    (() => {
      throw new ApplicationError(`no field "${h}" (use its number from \`applications preview\`)`);
    })()
  );
}

/** An answer by q-number (q2 / 2) or by its question field's handle. */
export function findAnswer(
  view: { answers: AnswerView[]; fields: FieldView[] },
  handle: string,
): AnswerView {
  const q = /^q?(\d+)$/i.exec(handle.trim());
  if (q) {
    const a = view.answers.find((x) => x.number === Number(q[1]));
    if (a) return a;
    throw new ApplicationError(`no answer q${q[1]} (see \`applications preview\`)`);
  }
  const field = findField(view.fields, handle);
  const a = view.answers.find((x) => x.ref === field.ref);
  if (!a) throw new ApplicationError(`field #${field.number} has no drafted answer`);
  return a;
}

// ---- set-field ----------------------------------------------------------------------------

const YES = /^(yes|y|true|checked|on|1)$/i;
const NO = /^(no|n|false|unchecked|off|0)$/i;

/** The value as stored for this field's kind; throws on anything the form can't take. */
export function normaliseValue(field: FieldView, raw: string): string {
  const v = raw.trim();
  if (!v) throw new ApplicationError('give a value (or --clear to go back to the prepared one)');
  if (field.role === 'entry') {
    throw new ApplicationError(
      `#${field.number} belongs to an entry of a repeatable group: set the group's entries instead`,
    );
  }
  if (field.kind === 'group') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      throw new ApplicationError(
        'a repeatable group takes a JSON list of entries, e.g. [{"School": "…", "Degree": "…"}] ([] for none)',
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((e) => typeof e !== 'object' || e === null || Array.isArray(e))
    ) {
      throw new ApplicationError('a repeatable group takes a JSON list of objects (label → value)');
    }
    return JSON.stringify(
      parsed.map((e) => Object.fromEntries(Object.entries(e).map(([k, x]) => [k, String(x)]))),
    );
  }
  if (field.kind === 'file') {
    if (!isAbsolute(v) || !existsSync(v) || !statSync(v).isFile()) {
      throw new ApplicationError(`no file at ${v} (give an absolute path)`);
    }
    return v;
  }
  if (field.kind === 'checkbox' && (field.options?.length ?? 0) <= 1) {
    if (YES.test(v)) return 'checked';
    if (NO.test(v)) return 'unchecked';
    throw new ApplicationError('a checkbox takes yes or no');
  }
  const options = field.options ?? [];
  if (options.length && field.kind !== 'text' && field.kind !== 'textarea') {
    const wanted =
      field.kind === 'checkbox' && v.startsWith('[') ? (JSON.parse(v) as string[]) : [v];
    const matched = wanted.map((w) => {
      const exact =
        options.find((o) => o === w) ?? options.find((o) => o.toLowerCase() === w.toLowerCase());
      if (exact) return exact;
      const prefix = options.filter((o) => o.toLowerCase().startsWith(w.toLowerCase()));
      if (prefix.length === 1 && prefix[0]) return prefix[0];
      throw new ApplicationError(
        `"${w}" is not an option of #${field.number}: ${options
          .slice(0, 12)
          .map((o) => `"${o}"`)
          .join(', ')}${options.length > 12 ? ', …' : ''}`,
      );
    });
    return matched.length === 1 ? (matched[0] as string) : JSON.stringify(matched);
  }
  return v;
}

export interface SetFieldResult {
  field: FieldView;
  app: ApplicationRow;
}

/** Sets (or, with null, clears) this application's own value for one field. */
export function setFieldValue(
  tx: Tx,
  applicationId: number,
  handle: string,
  raw: string | null,
): SetFieldResult {
  const view = applicationView(tx.db, applicationId);
  if (view.app.stage === 'approved') {
    throw new ApplicationError(`application ${applicationId} is already approved`);
  }
  const field = findField(view.fields, handle);
  const row = tx.db
    .select()
    .from(fieldValues)
    .where(and(eq(fieldValues.applicationId, applicationId), eq(fieldValues.fieldRef, field.ref)))
    .get();
  if (!row) throw new ApplicationError(`field #${field.number} vanished`);
  if (raw === null) {
    tx.db
      .update(fieldValues)
      .set({ value: row.defaultValue, source: row.defaultSource })
      .where(eq(fieldValues.id, row.id))
      .run();
  } else {
    const value = normaliseValue(field, raw);
    if (field.kind === 'group') {
      const labels = new Set(
        view.fields.filter((f) => f.entryOf === field.ref).map((f) => f.label.trim().toLowerCase()),
      );
      for (const e of entries(value)) {
        for (const k of Object.keys(e)) {
          if (labels.size && !labels.has(k.trim().toLowerCase())) {
            throw new ApplicationError(
              `"${k}" is not a field of a ${field.label} entry (${[...labels].join(', ')})`,
            );
          }
        }
      }
    }
    tx.db
      .update(fieldValues)
      .set({ value, source: 'override' })
      .where(eq(fieldValues.id, row.id))
      .run();
  }
  const app = settleStage(tx, applicationId);
  const after = applicationView(tx.db, applicationId).fields.find((f) => f.ref === field.ref);
  if (!after) throw new ApplicationError('field vanished');
  return { field: after, app };
}

// ---- edits --------------------------------------------------------------------------------

/** Splits an answer the candidate wrote into sentences. */
export function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return (clean.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [clean])
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface EditResult {
  answer: AnswerView;
  /** Facts saved from the candidate's words. */
  factIds: number[];
}

/**
 * Replaces one sentence (sentence index given) or the whole answer (null) with the candidate's
 * text; or, with `text` null, confirms a sentence as written.
 */
export function editAnswer(
  tx: Tx,
  applicationId: number,
  input: { answer: string; sentence: number | null; text: string | null },
): EditResult {
  const view = applicationView(tx.db, applicationId);
  if (view.app.stage === 'approved')
    throw new ApplicationError(`application ${applicationId} is already approved`);
  const a = findAnswer(view, input.answer);
  const saved: number[] = [];

  if (input.text === null) {
    if (input.sentence === null)
      throw new ApplicationError('say which sentence is true as written (q1.2)');
    const s = a.sentences.find((x) => x.idx === input.sentence);
    if (!s) throw new ApplicationError(`q${a.number} has no sentence ${input.sentence + 1}`);
    if (s.checkFlag === 'contradiction') {
      throw new ApplicationError(
        `q${a.number}.${s.idx + 1} contradicts fact ${s.note ?? ''}: rewrite it (or fix the fact first)`,
      );
    }
    if (s.checkFlag === 'unchecked')
      throw new ApplicationError('this sentence is still being checked');
    const factId = reviewFact(tx, applicationId, s.text, s.factIds);
    saved.push(factId);
    tx.db
      .update(answerSentences)
      .set({
        factIds: [...new Set([...s.factIds, factId])],
        flag: 'none',
        note: 'confirmed as written',
      })
      .where(and(eq(answerSentences.answerId, a.id), eq(answerSentences.idx, s.idx)))
      .run();
  } else if (input.sentence !== null) {
    const s = a.sentences.find((x) => x.idx === input.sentence);
    if (!s) throw new ApplicationError(`q${a.number} has no sentence ${input.sentence + 1}`);
    const text = input.text.replace(/\s+/g, ' ').trim();
    if (!text) throw new ApplicationError('the new sentence is empty');
    const factId = reviewFact(tx, applicationId, text, s.factIds);
    saved.push(factId);
    tx.db
      .update(answerSentences)
      .set({ text, factIds: [factId], flag: 'none', note: 'your words' })
      .where(and(eq(answerSentences.answerId, a.id), eq(answerSentences.idx, s.idx)))
      .run();
  } else {
    const parts = splitSentences(input.text);
    if (parts.length === 0) throw new ApplicationError('the new answer is empty');
    const keep = new Map(a.sentences.map((s) => [s.text.trim(), s]));
    tx.db.delete(answerSentences).where(eq(answerSentences.answerId, a.id)).run();
    parts.forEach((text, idx) => {
      const same = keep.get(text);
      if (same) {
        // An unchanged sentence keeps its facts and its check.
        tx.db
          .insert(answerSentences)
          .values({
            answerId: a.id,
            idx,
            text,
            factIds: same.factIds,
            flag: same.checkFlag,
            note: same.note,
          })
          .run();
        return;
      }
      const factId = reviewFact(
        tx,
        applicationId,
        text,
        a.sentences.flatMap((s) => s.factIds),
      );
      saved.push(factId);
      tx.db
        .insert(answerSentences)
        .values({ answerId: a.id, idx, text, factIds: [factId], flag: 'none', note: 'your words' })
        .run();
    });
  }

  tx.db
    .update(answers)
    .set({ edited: true, status: 'answered', missing: null })
    .where(eq(answers.id, a.id))
    .run();
  // The field's prepared value follows the answer (an override on the field still wins).
  if (a.kind === 'text') {
    const text = tx.db
      .select({ text: answerSentences.text })
      .from(answerSentences)
      .where(eq(answerSentences.answerId, a.id))
      .orderBy(answerSentences.idx)
      .all()
      .map((r) => r.text)
      .join(' ');
    const row = tx.db
      .select()
      .from(fieldValues)
      .where(and(eq(fieldValues.applicationId, applicationId), eq(fieldValues.fieldRef, a.ref)))
      .get();
    if (row) {
      tx.db
        .update(fieldValues)
        .set({
          defaultValue: text,
          defaultSource: 'answer',
          note: null,
          ...(row.source === 'override' ? {} : { value: text, source: 'answer' as const }),
        })
        .where(eq(fieldValues.id, row.id))
        .run();
    }
  }
  if (saved.length) {
    enqueueEmbedFacts(tx);
    requestRematch(tx);
  }
  settleStage(tx, applicationId);
  const after = findAnswer(applicationView(tx.db, applicationId), `q${a.number}`);
  return { answer: after, factIds: saved };
}

// ---- confirm & approve --------------------------------------------------------------------

/** Confirms the unconfirmed facts the application relies on (all of them, or the given ids). */
export function confirmApplicationFacts(
  tx: Tx,
  applicationId: number,
  ids: number[] = [],
): number[] {
  const view = applicationView(tx.db, applicationId);
  const relied = new Set(view.unconfirmedFactIds);
  const todo = ids.length ? ids : [...relied];
  for (const id of todo) {
    if (!relied.has(id)) {
      throw new ApplicationError(
        `fact #${id} is not an unconfirmed fact this application relies on`,
      );
    }
    confirmFact(tx.db, id, tx.now);
  }
  // A tailored CV skipped for lack of confirmed facts can be written now.
  const cv = getCv(tx.db, applicationId);
  if (
    todo.length &&
    cv?.mode === 'tailored' &&
    cv.status === 'skipped' &&
    view.app.stage !== 'approved' &&
    view.app.stage !== 'applied'
  ) {
    updateCv(tx, cv.id, { status: 'pending', note: null });
    requestCvPass(tx, applicationId, 'writing your tailored CV with the facts you confirmed');
  }
  return todo;
}

export function approveApplication(tx: Tx, applicationId: number): ApplicationRow {
  const view = applicationView(tx.db, applicationId);
  if (view.app.stage === 'approved') return view.app;
  if (view.app.stage !== 'ready_for_review' || view.blockers.length) {
    const why = view.blockers.length
      ? view.blockers
      : [`it is ${view.app.stage.replace(/_/g, ' ')}`];
    throw new ApprovalBlocked(applicationId, why);
  }
  const row = tx.db
    .update(applications)
    .set({ stage: 'approved', approvedAt: tx.now, note: null, updatedAt: tx.now })
    .where(eq(applications.id, applicationId))
    .returning()
    .get();
  emitStage(tx, row, 'approved', `application ${applicationId}: approved`);
  // Approval is the human gate; delivery then runs on its own (candidate pulled in only on hand-off).
  enqueueDelivery(tx, applicationId);
  return row;
}

/** `applications submit`: approve if needed, then (re-)enqueue delivery either way. */
export function submitApplication(tx: Tx, applicationId: number): ApplicationRow {
  const row = approveApplication(tx, applicationId);
  enqueueDelivery(tx, applicationId);
  return row;
}

export class ApprovalBlocked extends ApplicationError {
  readonly blockers: string[];
  constructor(id: number, blockers: string[]) {
    super(`application ${id} can't be approved yet:\n- ${blockers.join('\n- ')}`);
    this.blockers = blockers;
  }
}
