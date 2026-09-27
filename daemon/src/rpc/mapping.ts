// Domain rows → proto messages. The only place that knows both shapes.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EventRow, PostingRow, PostingSourceRow, PostingStage } from '../db/schema.ts';
import {
  type Event,
  EventSchema,
  PostingStage as PbStage,
  type Posting,
  PostingSchema,
  PostingSourceSchema,
  TaskEventType,
} from '../gen/applyant/v1/applyant_pb.js';

const STAGE_TO_PB: Record<PostingStage, PbStage> = {
  found: PbStage.FOUND,
  verified: PbStage.VERIFIED,
  failed_verification: PbStage.FAILED_VERIFICATION,
};

export function stageToPb(stage: string | null): PbStage {
  return STAGE_TO_PB[stage as PostingStage] ?? PbStage.UNSPECIFIED;
}

export function stageFromPb(stage: PbStage): PostingStage | undefined {
  for (const [key, value] of Object.entries(STAGE_TO_PB)) {
    if (value === stage) return key as PostingStage;
  }
  return undefined;
}

export function postingToPb(row: PostingRow, sources: PostingSourceRow[] = []): Posting {
  return create(PostingSchema, {
    id: BigInt(row.id),
    stage: stageToPb(row.stage),
    canonicalUrl: row.canonicalUrl,
    title: row.title ?? undefined,
    company: row.company ?? undefined,
    firstSeenAt: timestampFromDate(row.firstSeenAt),
    verifiedAt: row.verifiedAt ? timestampFromDate(row.verifiedAt) : undefined,
    verifyNote: row.verifyNote ?? undefined,
    sources: sources.map((s) =>
      create(PostingSourceSchema, {
        kind: s.kind,
        url: s.url,
        firstSeenAt: timestampFromDate(s.firstSeenAt),
      }),
    ),
  });
}

const TASK_EVENT_TYPES: Record<string, TaskEventType> = {
  'task.queued': TaskEventType.QUEUED,
  'task.started': TaskEventType.STARTED,
  'task.progress': TaskEventType.PROGRESS,
  'task.done': TaskEventType.DONE,
  'task.retry': TaskEventType.RETRY,
  'task.failed': TaskEventType.FAILED,
  'task.provider_paused': TaskEventType.PROVIDER_PAUSED,
  'task.needs_candidate': TaskEventType.NEEDS_CANDIDATE,
  'task.lease_lost': TaskEventType.LEASE_LOST,
  'task.requeued': TaskEventType.REQUEUED,
};

export function eventToPb(row: EventRow): Event {
  const base = {
    id: BigInt(row.id),
    at: timestampFromDate(row.at),
    runId: row.runId === null ? undefined : BigInt(row.runId),
    message: row.message,
  };
  const taskType = TASK_EVENT_TYPES[row.kind];
  if (taskType !== undefined) {
    return create(EventSchema, {
      ...base,
      payload: {
        case: 'task',
        value: {
          taskId: BigInt(row.taskId ?? 0),
          taskKind: row.taskKind ?? '',
          entityId: BigInt(row.entityId ?? 0),
          type: taskType,
          attempts: row.attempts ?? 0,
        },
      },
    });
  }
  if (row.kind === 'posting.stage') {
    return create(EventSchema, {
      ...base,
      payload: {
        case: 'posting',
        value: { postingId: BigInt(row.postingId ?? 0), stage: stageToPb(row.stage) },
      },
    });
  }
  return create(EventSchema, base);
}
