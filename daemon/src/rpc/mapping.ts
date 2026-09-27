// Domain rows → proto messages. The only place that knows both shapes.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { ElementRef, FormRead } from '../browser/form-types.ts';
import type { EventRow, PostingRow, PostingSourceRow, PostingStage } from '../db/schema.ts';
import { effectiveExtraction } from '../domain/scoring/structured.ts';
import type { CitedFact } from '../domain/search/postings.ts';
import {
  type ApplicationForm,
  ApplicationFormSchema,
  ElementRefSchema,
  type Event,
  EventSchema,
  type ElementRef as PbElementRef,
  FactStatus as PbFactStatus,
  PostingStage as PbStage,
  type Posting,
  PostingSchema,
  PostingSourceSchema,
  RequirementMatchSchema,
  ScoreComponentSchema,
  TaskEventType,
} from '../gen/applyant/v1/applyant_pb.js';

const FACT_STATUS_TO_PB = {
  unconfirmed: PbFactStatus.UNCONFIRMED,
  confirmed: PbFactStatus.CONFIRMED,
  rejected: PbFactStatus.REJECTED,
} as const;

const STAGE_TO_PB: Record<PostingStage, PbStage> = {
  found: PbStage.FOUND,
  verified: PbStage.VERIFIED,
  failed_verification: PbStage.FAILED_VERIFICATION,
  scored: PbStage.SCORED,
  skipped: PbStage.SKIPPED,
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

function refToPb(ref: ElementRef): PbElementRef {
  return create(ElementRefSchema, {
    frame: ref.frame,
    role: ref.role,
    name: ref.name,
    nth: ref.nth,
    css: ref.css ?? undefined,
  });
}

export function formToPb(read: FormRead): ApplicationForm {
  return create(ApplicationFormSchema, {
    url: read.url,
    notes: read.notes,
    steps: read.requirements.steps.map((step) => ({
      advance: step.advance ? refToPb(step.advance) : undefined,
      isFinal: step.isFinal,
      fields: step.fields.map((f) => ({
        ref: refToPb(f.ref),
        label: f.label,
        kind: f.kind,
        required: f.required,
        options: f.options ?? [],
        hasOptions: f.options !== null,
        meaning: f.meaning ?? undefined,
        revealedBy: f.revealedBy
          ? { ref: refToPb(f.revealedBy.ref), value: f.revealedBy.value }
          : undefined,
      })),
    })),
  });
}

/**
 * `sources` and `facts` are only passed for GetPosting; with `facts`, the requirement
 * matches are included with the facts they cite (and the form Read found).
 */
export function postingToPb(
  row: PostingRow,
  sources: PostingSourceRow[] = [],
  facts: Map<number, CitedFact> | null = null,
): Posting {
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
    score: row.score ?? undefined,
    breakdown: (row.breakdown ?? []).map((c) =>
      create(ScoreComponentSchema, {
        key: c.key,
        weight: c.weight,
        value: c.value,
        note: c.note ?? undefined,
        uncertain: c.uncertain,
        scale: c.scale ?? 1,
      }),
    ),
    dealbreakers: row.dealbreakers ?? [],
    scoredAt: row.scoredAt ? timestampFromDate(row.scoredAt) : undefined,
    scoreNote: row.scoreNote ?? undefined,
    decision: row.decision ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
    summary: row.extraction?.summary || undefined,
    salaryText: effectiveExtraction(row)?.extraction.salary?.text || undefined,
    coreFit: row.coreFit ?? undefined,
    structuredFields: effectiveExtraction(row)?.decided ?? [],
    applyUrl: row.applyUrl ?? undefined,
    formStatus: row.formStatus ?? undefined,
    formNote: row.formNote ?? undefined,
    formReadAt: row.formReadAt ? timestampFromDate(row.formReadAt) : undefined,
    form: facts && row.form ? formToPb(row.form) : undefined,
    requirements: facts
      ? (row.matches ?? []).map((m) =>
          create(RequirementMatchSchema, {
            text: m.text,
            must: m.must,
            verdict: m.verdict,
            factIds: m.factIds.map((id) => BigInt(id)),
            note: m.note ?? undefined,
            facts: m.factIds
              .map((id) => facts.get(id))
              .filter((f) => f !== undefined)
              .map((f) => ({
                id: BigInt(f.id),
                text: f.text,
                status: FACT_STATUS_TO_PB[f.status],
                projectSlug: f.projectSlug ?? undefined,
              })),
          }),
        )
      : [],
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
  if (row.kind === 'posting.stage' || row.kind === 'posting.form') {
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
