import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
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
    default:
      return 'unknown';
  }
}

export function parseStage(name: string): PostingStage {
  const stage = {
    found: PostingStage.FOUND,
    verified: PostingStage.VERIFIED,
    failed_verification: PostingStage.FAILED_VERIFICATION,
  }[name];
  if (stage === undefined)
    throw new Error(`unknown stage "${name}" (found | verified | failed_verification)`);
  return stage;
}

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
  };
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
