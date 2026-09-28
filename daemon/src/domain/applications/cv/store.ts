// The application's CV as stored, the Resume field that follows it, and what review does to it.
//
//   The Resume field's prepared value is the tailored PDF once it's rendered, the base CV when
//   the candidate chose it (or no tailored CV is possible), and empty while the tailored one is
//   still being written. An override on the field (`applications set-field`) still wins.
//   use-base / use-tailored   switch between them
//   edit      a line in the candidate's own words: saved as a confirmed review_edit fact (like
//             an answer edit), the line cites it, and the PDF is rendered again
import { eq } from 'drizzle-orm';
import type { FieldSpec } from '../../../browser/form-types.ts';
import type { Conn } from '../../../db/client.ts';
import {
  applications,
  type CvLine,
  type CvMode,
  type CvPlan,
  type CvRow,
  type CvStatus,
  cvs,
  fieldValues,
  projects,
} from '../../../db/schema.ts';
import type { Tx } from '../../../queue/types.ts';
import { enqueueEmbedFacts } from '../../knowledge/embed-index.ts';
import type { StandardProfile } from '../../knowledge/profile.ts';
import { reviewFact } from '../review-fact.ts';
import type { FieldDefault } from '../standard-fields.ts';
import {
  ApplicationError,
  type CitedFactView,
  citedFacts,
  emitStage,
  getApplicationRow,
  prepareQueued,
  settleStage,
} from '../store.ts';
import { planLines } from './select.ts';

export function isResumeField(spec: Pick<FieldSpec, 'kind' | 'meaning'>): boolean {
  return spec.kind === 'file' && spec.meaning === 'resume';
}

export function getCv(conn: Conn, applicationId: number): CvRow | null {
  return conn.select().from(cvs).where(eq(cvs.applicationId, applicationId)).get() ?? null;
}

/** The application's CV row, created (tailored, pending) when its form first takes a CV. */
export function ensureCv(tx: Tx, applicationId: number): CvRow {
  const row = getCv(tx.db, applicationId);
  if (row) return row;
  return tx.db
    .insert(cvs)
    .values({ applicationId, createdAt: tx.now, updatedAt: tx.now })
    .returning()
    .get();
}

export function updateCv(
  tx: Tx,
  id: number,
  set: Partial<
    Pick<CvRow, 'mode' | 'status' | 'plan' | 'pdfPath' | 'pdfHash' | 'note' | 'renderedAt'>
  >,
): CvRow {
  return tx.db
    .update(cvs)
    .set({ ...set, updatedAt: tx.now })
    .where(eq(cvs.id, id))
    .returning()
    .get();
}

/** What the Resume field gets from the CV (before any override). */
export function cvDefault(cv: CvRow | null, p: StandardProfile): FieldDefault {
  if (cv?.mode === 'tailored' && cv.status === 'ready' && cv.pdfPath) {
    return { value: cv.pdfPath, source: 'file', note: 'your tailored CV' };
  }
  if (cv?.mode === 'tailored' && (cv.status === 'pending' || cv.status === 'planned')) {
    return { value: null, source: 'none', note: 'your tailored CV is being prepared' };
  }
  const why = cv?.mode === 'tailored' && cv.status === 'skipped' && cv.note ? ` (${cv.note})` : '';
  return p.base_cv_file
    ? { value: p.base_cv_file, source: 'file', note: `your base CV${why}` }
    : { value: null, source: 'none', note: `no base_cv_file in your profile${why}` };
}

/** Points the application's Resume field(s) at what the CV now gives. */
export function applyCvToFields(tx: Tx, applicationId: number, p: StandardProfile): void {
  const d = cvDefault(getCv(tx.db, applicationId), p);
  const rows = tx.db
    .select()
    .from(fieldValues)
    .where(eq(fieldValues.applicationId, applicationId))
    .all()
    .filter((r) => isResumeField(r.spec));
  for (const row of rows) {
    tx.db
      .update(fieldValues)
      .set({
        defaultValue: d.value,
        defaultSource: d.source,
        note: d.note,
        ...(row.source === 'override' ? {} : { value: d.value, source: d.source }),
      })
      .where(eq(fieldValues.id, row.id))
      .run();
  }
}

/** The application goes back to `preparing` so its next pass writes or renders the CV. */
export function requestCvPass(tx: Tx, applicationId: number, why: string): void {
  const app = getApplicationRow(tx.db, applicationId);
  if (app.stage !== 'preparing') {
    const row = tx.db
      .update(applications)
      .set({ stage: 'preparing', note: why, updatedAt: tx.now })
      .where(eq(applications.id, applicationId))
      .returning()
      .get();
    emitStage(tx, row, 'preparing', `application ${applicationId}: ${why}`);
  }
  if (!prepareQueued(tx.db, applicationId)) tx.enqueue('prepare_application', applicationId);
}

// ---- the view -----------------------------------------------------------------------------

export interface CvLineView {
  /** The CLI's handle: s1 · p2.3 · e1 · d4. */
  handle: string;
  text: string;
  factIds: number[];
  facts: CitedFactView[];
}

export interface CvView {
  mode: CvMode;
  status: CvStatus;
  note: string | null;
  pdfPath: string | null;
  pdfHash: string | null;
  renderedAt: Date | null;
  summary: CvLineView[];
  projects: Array<{
    number: number;
    slug: string;
    name: string;
    period: string | null;
    bullets: CvLineView[];
  }>;
  education: CvLineView[];
  skills: string[];
  dropped: Array<CvLineView & { section: string; reason: string }>;
  /** Lines whose facts are no longer confirmed (a fact was rejected after the CV was made). */
  stale: string[];
}

export function cvView(conn: Conn, applicationId: number): CvView | null {
  const cv = getCv(conn, applicationId);
  if (!cv) return null;
  const plan = cv.plan;
  const ids = plan
    ? [...planLines(plan).flatMap((l) => l.line.factIds), ...plan.dropped.flatMap((d) => d.factIds)]
    : [];
  const cited = citedFacts(conn, ids);
  const line = (handle: string, l: CvLine): CvLineView => ({
    handle,
    text: l.text,
    factIds: l.factIds,
    facts: l.factIds.map(
      (id) =>
        cited.get(id) ?? {
          id,
          text: '(no longer exists)',
          status: 'missing',
          kind: null,
          origin: null,
          projectSlug: null,
        },
    ),
  });
  const view: CvView = {
    mode: cv.mode,
    status: cv.status,
    note: cv.note,
    pdfPath: cv.pdfPath,
    pdfHash: cv.pdfHash,
    renderedAt: cv.renderedAt,
    summary: (plan?.summary ?? []).map((l, i) => line(`s${i + 1}`, l)),
    projects: (plan?.projects ?? []).map((p, pi) => ({
      number: pi + 1,
      slug: p.slug,
      name: p.name,
      period: p.period,
      bullets: p.bullets.map((l, i) => line(`p${pi + 1}.${i + 1}`, l)),
    })),
    education: (plan?.education ?? []).map((l, i) => line(`e${i + 1}`, l)),
    skills: plan?.skills ?? [],
    dropped: (plan?.dropped ?? []).map((d, i) => ({
      ...line(`d${i + 1}`, d),
      section: d.section,
      reason: d.reason,
    })),
    stale: [],
  };
  if (cv.mode === 'tailored' && cv.status === 'ready') {
    const shown = [...view.summary, ...view.projects.flatMap((p) => p.bullets), ...view.education];
    view.stale = shown
      .filter((l) => l.facts.some((f) => f.status !== 'confirmed'))
      .map((l) => l.handle);
  }
  return view;
}

// ---- review -------------------------------------------------------------------------------

function editable(tx: Tx, applicationId: number): CvRow {
  const app = getApplicationRow(tx.db, applicationId);
  if (app.stage === 'approved' || app.stage === 'applied') {
    throw new ApplicationError(`application ${applicationId} is already ${app.stage}`);
  }
  const cv = getCv(tx.db, applicationId);
  if (!cv) throw new ApplicationError(`application ${applicationId}'s form takes no CV`);
  return cv;
}

/** `applications cv use-base` / `use-tailored`. */
export function setCvMode(tx: Tx, applicationId: number, mode: CvMode, p: StandardProfile): CvRow {
  const cv = editable(tx, applicationId);
  if (mode === 'base') {
    const row = updateCv(tx, cv.id, { mode });
    applyCvToFields(tx, applicationId, p);
    settleStage(tx, applicationId);
    return row;
  }
  // Back to tailored: a CV that couldn't be made is tried again; a planned one is rendered.
  const status: CvStatus = cv.status === 'skipped' ? 'pending' : cv.status;
  const row = updateCv(tx, cv.id, {
    mode,
    status,
    ...(status === 'pending' ? { note: null } : {}),
  });
  applyCvToFields(tx, applicationId, p);
  if (status === 'ready') settleStage(tx, applicationId);
  else requestCvPass(tx, applicationId, 'writing your tailored CV');
  return row;
}

type Located =
  | { kind: 'summary' | 'education'; index: number }
  | { kind: 'bullet'; project: number; index: number }
  | { kind: 'dropped'; index: number };

function locate(plan: CvPlan, handle: string): Located {
  const h = handle.trim().toLowerCase();
  const m = /^([sed])(\d+)$/.exec(h) ?? /^(p)(\d+)\.(\d+)$/.exec(h);
  if (!m)
    throw new ApplicationError(
      `"${handle}" is not a CV line (s1, p2.3, e1 or d4: see \`applications preview\`)`,
    );
  const n = Number(m[2]) - 1;
  const missing = () => new ApplicationError(`the CV has no line ${h}`);
  switch (m[1]) {
    case 's':
      if (!plan.summary[n]) throw missing();
      return { kind: 'summary', index: n };
    case 'e':
      if (!plan.education[n]) throw missing();
      return { kind: 'education', index: n };
    case 'd':
      if (!plan.dropped[n]) throw missing();
      return { kind: 'dropped', index: n };
    default: {
      const b = Number(m[3]) - 1;
      if (!plan.projects[n]?.bullets[b]) throw missing();
      return { kind: 'bullet', project: n, index: b };
    }
  }
}

export interface CvEditResult {
  cv: CvRow;
  /** The fact saved from the candidate's words, if any. */
  factId: number | null;
}

/**
 * Replaces a line with the candidate's words (null removes it). A dropped line given new words
 * goes back where it was written for. The PDF is rendered again on the next pass.
 */
export function editCvLine(
  tx: Tx,
  applicationId: number,
  handle: string,
  text: string | null,
): CvEditResult {
  const cv = editable(tx, applicationId);
  if (cv.mode !== 'tailored' || !cv.plan) {
    throw new ApplicationError(
      'there is no tailored CV to edit (`applications cv use-tailored` first)',
    );
  }
  const plan: CvPlan = structuredClone(cv.plan);
  const at = locate(plan, handle);
  const words = text?.replace(/\s+/g, ' ').trim() ?? null;
  if (text !== null && !words) throw new ApplicationError('the new line is empty');

  let factId: number | null = null;
  const save = (cited: number[], projectSlug: string | null): CvLine => {
    const projectId = projectSlug
      ? (tx.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.slug, projectSlug))
          .get()?.id ?? null)
      : null;
    factId = reviewFact(tx, applicationId, words as string, cited, projectId);
    return { text: words as string, factIds: [factId] };
  };

  switch (at.kind) {
    case 'summary':
    case 'education': {
      const list = plan[at.kind];
      if (words === null) list.splice(at.index, 1);
      else list[at.index] = save(list[at.index]?.factIds ?? [], null);
      break;
    }
    case 'bullet': {
      const p = plan.projects[at.project];
      if (!p) throw new ApplicationError('that project vanished');
      if (words === null) {
        p.bullets.splice(at.index, 1);
        if (!p.bullets.length) plan.projects.splice(at.project, 1);
      } else {
        p.bullets[at.index] = save(p.bullets[at.index]?.factIds ?? [], p.slug);
      }
      break;
    }
    case 'dropped': {
      const d = plan.dropped[at.index];
      if (!d) throw new ApplicationError('that line vanished');
      if (words === null) throw new ApplicationError(`${handle} is already left out of the CV`);
      plan.dropped.splice(at.index, 1);
      if (d.section === 'skills') {
        plan.skills.push(words);
      } else if (d.section === 'summary' || d.section === 'education') {
        plan[d.section].push(save(d.factIds, null));
      } else {
        const line = save(d.factIds, d.section);
        const p = plan.projects.find((x) => x.slug === d.section);
        if (p) p.bullets.push(line);
        else {
          const row = tx.db.select().from(projects).where(eq(projects.slug, d.section)).get();
          plan.projects.push({
            slug: d.section,
            name: row?.name ?? d.section,
            period: row?.period ?? null,
            bullets: [line],
          });
        }
      }
      break;
    }
  }
  if (factId !== null) enqueueEmbedFacts(tx);
  const row = updateCv(tx, cv.id, {
    plan,
    status: 'planned',
    pdfPath: null,
    pdfHash: null,
    note: 'edited by you',
  });
  requestCvPass(tx, applicationId, 'rendering your edited CV');
  return { cv: row, factId };
}

/** The application's CV row as it is right now, for a commit that must not clobber a newer one. */
export function sameCv(a: CvRow, b: CvRow | null): boolean {
  return !!b && a.id === b.id && a.updatedAt.getTime() === b.updatedAt.getTime();
}
