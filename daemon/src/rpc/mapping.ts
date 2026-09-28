// Domain rows → proto messages. The only place that knows both shapes.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { ElementRef, FormRead } from '../browser/form-types.ts';
import type {
  ApplicationRow,
  ApplicationStage,
  EventRow,
  PostingRow,
  PostingSourceRow,
  PostingStage,
} from '../db/schema.ts';
import type { ApplicationView, ReceiptView } from '../domain/applications/store.ts';
import { effectiveExtraction } from '../domain/scoring/structured.ts';
import type { CitedFact } from '../domain/search/postings.ts';
import {
  type Application,
  type ApplicationForm,
  ApplicationFormSchema,
  ApplicationSchema,
  ElementRefSchema,
  type Event,
  EventSchema,
  HandOffSchema,
  ApplicationStage as PbAppStage,
  type ElementRef as PbElementRef,
  FactStatus as PbFactStatus,
  type HandOff as PbHandOff,
  type Receipt as PbReceipt,
  PostingStage as PbStage,
  type Posting,
  PostingSchema,
  PostingSourceSchema,
  ReceiptSchema,
  RequirementMatchSchema,
  ScoreComponentSchema,
  TaskEventType,
} from '../gen/applyant/v1/applyant_pb.js';
import type { HandOff as HandOffRecord } from '../queue/types.ts';

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

const APP_STAGE_TO_PB: Record<ApplicationStage, PbAppStage> = {
  preparing: PbAppStage.PREPARING,
  ready_for_review: PbAppStage.READY_FOR_REVIEW,
  needs_candidate: PbAppStage.NEEDS_CANDIDATE,
  approved: PbAppStage.APPROVED,
  applied: PbAppStage.APPLIED,
};

export function receiptToPb(r: ReceiptView): PbReceipt {
  return create(ReceiptSchema, {
    finalUrl: r.finalUrl,
    confirmationText: r.confirmationText ?? undefined,
    cvPath: r.cvPath ?? undefined,
    cvHash: r.cvHash ?? undefined,
    salaryValue: r.salaryValue ?? undefined,
    submittedAt: timestampFromDate(r.submittedAt),
    fieldValues: r.fieldValues.map((f) => ({
      ref: f.ref,
      label: f.label,
      value: f.value ?? undefined,
      source: f.source,
    })),
  });
}

export function handOffToPb(h: HandOffRecord): PbHandOff {
  return create(HandOffSchema, {
    reason: h.reason,
    detail: h.detail ?? undefined,
    scope: h.browser?.scope ?? undefined,
    step: h.browser?.step ?? undefined,
    fieldLabel: h.browser?.fieldLabel ?? undefined,
    url: h.browser?.url ?? undefined,
    snapshotPath: h.browser?.snapshotPath ?? undefined,
  });
}

export function appStageToPb(stage: string | null | undefined): PbAppStage {
  return APP_STAGE_TO_PB[stage as ApplicationStage] ?? PbAppStage.UNSPECIFIED;
}

export function appStageFromPb(stage: PbAppStage): ApplicationStage | undefined {
  for (const [key, value] of Object.entries(APP_STAGE_TO_PB)) {
    if (value === stage) return key as ApplicationStage;
  }
  return undefined;
}

/** `full` adds every field and answer (GetApplication and the review RPCs). */
export function applicationToPb(view: ApplicationView, full = true): Application {
  const { app, posting } = view;
  return create(ApplicationSchema, {
    id: BigInt(app.id),
    postingId: BigInt(app.postingId),
    stage: appStageToPb(app.stage),
    channel: app.channel,
    note: app.note ?? undefined,
    title: posting.title ?? undefined,
    company: posting.company ?? undefined,
    score: posting.score ?? undefined,
    postingUrl: posting.canonicalUrl,
    formUrl: posting.formUrl ?? undefined,
    createdAt: timestampFromDate(app.createdAt),
    preparedAt: app.preparedAt ? timestampFromDate(app.preparedAt) : undefined,
    approvedAt: app.approvedAt ? timestampFromDate(app.approvedAt) : undefined,
    appliedAt: app.appliedAt ? timestampFromDate(app.appliedAt) : undefined,
    receipt: view.receipt ? receiptToPb(view.receipt) : undefined,
    handOff: view.handOff ? handOffToPb(view.handOff) : undefined,
    blockers: view.blockers,
    missing: view.missing,
    unconfirmedFactIds: view.unconfirmedFactIds.map((n) => BigInt(n)),
    fields: full
      ? view.fields.map((f) => ({
          number: f.number,
          ref: f.ref,
          step: f.step,
          label: f.label,
          kind: f.kind,
          meaning: f.meaning ?? undefined,
          required: f.required,
          options: f.options ?? [],
          hasOptions: f.options !== null,
          role: f.role,
          value: f.value ?? undefined,
          source: f.source,
          defaultValue: f.defaultValue ?? undefined,
          defaultSource: f.defaultSource,
          note: f.note ?? undefined,
          active: f.active,
          missing: f.missing,
          entryOf: f.entryOf ?? undefined,
          condition: f.condition ?? undefined,
        }))
      : [],
    answers: full ? view.answers.map(answerToPb) : [],
  });
}

export function answerToPb(a: ApplicationView['answers'][number]) {
  return {
    number: a.number,
    id: BigInt(a.id),
    fieldRef: a.ref,
    question: a.question,
    kind: a.kind,
    status: a.status,
    choice: a.choice ?? undefined,
    missing: a.missing ?? undefined,
    adaptedFrom: a.adaptedFrom ?? undefined,
    edited: a.edited,
    active: a.active,
    overridden: a.overridden,
    sentences: a.sentences.map((s) => ({
      index: s.idx,
      text: s.text,
      factIds: s.factIds.map((n) => BigInt(n)),
      flag: s.flag,
      note: s.note ?? undefined,
      facts: s.facts.map((f) => ({
        id: BigInt(f.id),
        text: f.text,
        status:
          f.status === 'confirmed'
            ? PbFactStatus.CONFIRMED
            : f.status === 'unconfirmed'
              ? PbFactStatus.UNCONFIRMED
              : f.status === 'rejected'
                ? PbFactStatus.REJECTED
                : PbFactStatus.UNSPECIFIED,
        projectSlug: f.projectSlug ?? undefined,
      })),
    })),
  };
}

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
  app: Pick<ApplicationRow, 'id' | 'stage'> | null = null,
): Posting {
  return create(PostingSchema, {
    applicationId: app ? BigInt(app.id) : undefined,
    applicationStage: appStageToPb(app?.stage),
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
  if (row.kind === 'application.stage') {
    return create(EventSchema, {
      ...base,
      payload: {
        case: 'application',
        value: {
          applicationId: BigInt(row.entityId ?? 0),
          postingId: BigInt(row.postingId ?? 0),
          stage: appStageToPb(row.stage),
        },
      },
    });
  }
  if (row.kind === 'handoff') {
    return create(EventSchema, {
      ...base,
      payload: {
        case: 'handoff',
        value: {
          applicationId: BigInt(row.entityId ?? 0),
          postingId: BigInt(row.postingId ?? 0),
          reason: row.message,
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
