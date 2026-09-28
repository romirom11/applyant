import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  ApplicationStage,
  type ElementRef,
  type Event,
  type Posting,
  PostingStage,
  TaskEventType,
} from '../gen/applyant/v1/applyant_pb.js';

export function stageName(stage: PostingStage): string {
  switch (stage) {
    case PostingStage.FOUND:
      return 'found';
    case PostingStage.VERIFIED:
      return 'verified';
    case PostingStage.FAILED_VERIFICATION:
      return 'failed_verification';
    case PostingStage.SCORED:
      return 'scored';
    case PostingStage.SKIPPED:
      return 'skipped';
    default:
      return 'unknown';
  }
}

export function parseStage(name: string): PostingStage {
  const stage = {
    found: PostingStage.FOUND,
    verified: PostingStage.VERIFIED,
    failed_verification: PostingStage.FAILED_VERIFICATION,
    scored: PostingStage.SCORED,
    skipped: PostingStage.SKIPPED,
  }[name];
  if (stage === undefined) {
    throw new Error(
      `unknown stage "${name}" (found | verified | failed_verification | scored | skipped)`,
    );
  }
  return stage;
}

const APP_STAGE: Record<number, string> = {
  [ApplicationStage.PREPARING]: 'preparing',
  [ApplicationStage.READY_FOR_REVIEW]: 'ready_for_review',
  [ApplicationStage.NEEDS_CANDIDATE]: 'needs_candidate',
  [ApplicationStage.APPROVED]: 'approved',
  [ApplicationStage.APPLIED]: 'applied',
};

const TASK_TYPE: Record<number, string> = {
  [TaskEventType.QUEUED]: 'queued',
  [TaskEventType.STARTED]: 'started',
  [TaskEventType.PROGRESS]: 'progress',
  [TaskEventType.DONE]: 'done',
  [TaskEventType.RETRY]: 'retry',
  [TaskEventType.FAILED]: 'failed',
  [TaskEventType.PROVIDER_PAUSED]: 'paused',
  [TaskEventType.NEEDS_CANDIDATE]: 'needs candidate',
  [TaskEventType.LEASE_LOST]: 'lease lost',
  [TaskEventType.REQUEUED]: 'requeued',
};

export function iso(ts: Parameters<typeof timestampDate>[0] | undefined): string | null {
  return ts ? timestampDate(ts).toISOString() : null;
}

export function postingJson(p: Posting) {
  return {
    id: Number(p.id),
    stage: stageName(p.stage),
    canonicalUrl: p.canonicalUrl,
    title: p.title ?? null,
    company: p.company ?? null,
    firstSeenAt: iso(p.firstSeenAt),
    verifiedAt: iso(p.verifiedAt),
    verifyNote: p.verifyNote ?? null,
    sources: p.sources.map((s) => ({ kind: s.kind, url: s.url, firstSeenAt: iso(s.firstSeenAt) })),
    score: p.score ?? null,
    breakdown: p.breakdown.map((c) => ({
      key: c.key,
      weight: c.weight,
      value: c.value,
      note: c.note ?? null,
      uncertain: c.uncertain,
      scale: c.scale,
    })),
    coreFit: p.coreFit ?? null,
    structuredFields: p.structuredFields,
    dealbreakers: p.dealbreakers,
    scoredAt: iso(p.scoredAt),
    scoreNote: p.scoreNote ?? null,
    decision: p.decision ?? null,
    decisionReason: p.decisionReason ?? null,
    summary: p.summary ?? null,
    salaryText: p.salaryText ?? null,
    applyUrl: p.applyUrl ?? null,
    formStatus: p.formStatus ?? null,
    formNote: p.formNote ?? null,
    formReadAt: iso(p.formReadAt),
    applicationId: p.applicationId === undefined ? null : Number(p.applicationId),
    form: p.form
      ? {
          url: p.form.url,
          notes: p.form.notes,
          steps: p.form.steps.map((st) => ({
            isFinal: st.isFinal,
            advance: st.advance ? refJson(st.advance) : null,
            fields: st.fields.map((f) => ({
              label: f.label,
              kind: f.kind,
              required: f.required,
              options: f.hasOptions ? f.options : null,
              meaning: f.meaning ?? null,
              revealedBy: f.revealedBy
                ? {
                    ref: f.revealedBy.ref ? refJson(f.revealedBy.ref) : null,
                    value: f.revealedBy.value,
                  }
                : null,
              ref: f.ref ? refJson(f.ref) : null,
            })),
          })),
        }
      : null,
    requirements: p.requirements.map((m) => ({
      text: m.text,
      must: m.must,
      verdict: m.verdict,
      factIds: m.factIds.map(Number),
      note: m.note ?? null,
      facts: m.facts.map((f) => ({
        id: Number(f.id),
        text: f.text,
        project: f.projectSlug ?? null,
      })),
    })),
  };
}

function refJson(r: ElementRef) {
  return { frame: r.frame, role: r.role, name: r.name, nth: r.nth, css: r.css ?? null };
}

export function eventJson(e: Event) {
  const base = {
    id: Number(e.id),
    at: iso(e.at),
    runId: e.runId === undefined ? null : Number(e.runId),
    message: e.message,
  };
  if (e.payload.case === 'task') {
    const t = e.payload.value;
    return {
      ...base,
      type: 'task',
      taskId: Number(t.taskId),
      taskKind: t.taskKind,
      entityId: Number(t.entityId),
      event: TASK_TYPE[t.type] ?? 'unknown',
      attempts: t.attempts,
    };
  }
  if (e.payload.case === 'posting') {
    const p = e.payload.value;
    return { ...base, type: 'posting', postingId: Number(p.postingId), stage: stageName(p.stage) };
  }
  if (e.payload.case === 'application') {
    const a = e.payload.value;
    return {
      ...base,
      type: 'application',
      applicationId: Number(a.applicationId),
      postingId: Number(a.postingId),
      stage: APP_STAGE[a.stage] ?? 'unknown',
    };
  }
  if (e.payload.case === 'handoff') {
    const h = e.payload.value;
    return {
      ...base,
      type: 'handoff',
      applicationId: Number(h.applicationId),
      postingId: Number(h.postingId),
      reason: h.reason,
    };
  }
  return { ...base, type: 'unknown' };
}

function time(e: Event): string {
  return e.at ? timestampDate(e.at).toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--';
}

export function eventLine(e: Event): string {
  const run = e.runId === undefined ? '' : ` run ${e.runId}`;
  const msg = e.message ? `  ${e.message}` : '';
  if (e.payload.case === 'task') {
    const t = e.payload.value;
    return `${time(e)}${run}  task ${t.taskId} ${t.taskKind}(${t.entityId})  ${TASK_TYPE[t.type] ?? 'unknown'}${msg}`;
  }
  if (e.payload.case === 'posting') {
    const p = e.payload.value;
    return `${time(e)}${run}  posting ${p.postingId} → ${stageName(p.stage)}${msg}`;
  }
  if (e.payload.case === 'application') {
    const a = e.payload.value;
    return `${time(e)}${run}  application ${a.applicationId} → ${APP_STAGE[a.stage] ?? 'unknown'}${msg}`;
  }
  if (e.payload.case === 'handoff') {
    const h = e.payload.value;
    return `${time(e)}${run}  application ${h.applicationId} needs you: ${h.reason}`;
  }
  return `${time(e)}${run}${msg}`;
}

/** Plain aligned columns; the last column is never padded. */
export function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((r) =>
      r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '),
    )
    .join('\n');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
