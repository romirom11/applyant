// Application RPCs: validate → domain → proto. Review actions run in one short write
// transaction each and return the application as it now is.
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { applications, postings } from '../db/schema.ts';
import { editCvLine, setCvMode } from '../domain/applications/cv/store.ts';
import { markSubmittedByHand, setApplyForm } from '../domain/applications/deliver.ts';
import { emailsFor } from '../domain/applications/mail-status.ts';
import { StageRefused, setApplicationStage } from '../domain/applications/manual-stage.ts';
import {
  ApprovalBlocked,
  approveApplication,
  confirmApplicationFacts,
  editAnswer,
  findAnswer,
  redraftAnswer,
  setFieldValue,
  submitApplication,
} from '../domain/applications/review.ts';
import {
  ApplicationError,
  applicationView,
  ensureApplication,
  getApplicationRow,
  listApplications,
  requestPrepare,
} from '../domain/applications/store.ts';
import { confirmFact, FactError, getFact } from '../domain/knowledge/facts.ts';
import { getStandardProfile } from '../domain/knowledge/profile.ts';
import { type ApplyantService, ApplyForm, type Fact } from '../gen/applyant/v1/applyant_pb.js';
import { runInTx } from '../queue/tx.ts';
import type { Tx } from '../queue/types.ts';
import { factToPb } from './candidate.ts';
import { emailToPb } from './mail.ts';
import { answerToPb, applicationToPb, appStageFromPb, handOffToPb } from './mapping.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

function id(value: bigint | undefined, what: string): number {
  const n = Number(value ?? 0n);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConnectError(`${what} must be a positive id`, Code.InvalidArgument);
  }
  return n;
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    if (err instanceof ApprovalBlocked || err instanceof StageRefused)
      throw new ConnectError(err.message, Code.FailedPrecondition);
    if (err instanceof ApplicationError || err instanceof FactError) {
      const code = /^no (application|fact|posting)/.test(err.message)
        ? Code.NotFound
        : /already (approved|applied)/.test(err.message)
          ? Code.FailedPrecondition
          : Code.InvalidArgument;
      throw new ConnectError(err.message, code);
    }
    throw err;
  }
}

export function applicationRpcs(
  c: RpcContext,
): Pick<
  Impl,
  | 'listApplications'
  | 'getApplication'
  | 'prepareApplication'
  | 'setFieldValue'
  | 'editAnswer'
  | 'redraftAnswer'
  | 'approveApplication'
  | 'submitApplication'
  | 'setApplyForm'
  | 'markSubmitted'
  | 'setApplicationStage'
  | 'getHandOff'
  | 'setCvMode'
  | 'editCv'
  | 'confirmFact'
> {
  return {
    listApplications(req) {
      const rows = listApplications(c.db, appStageFromPb(req.stage));
      return {
        applications: rows.map((r) => applicationToPb(applicationView(c.db, r.id), false)),
      };
    },

    getApplication(req) {
      return guard(() => {
        const appId = id(req.id, 'id');
        // Opening it while it waits for the candidate starts the review clock (metric 3).
        markReviewStarted(c, appId);
        const application = applicationToPb(applicationView(c.db, appId));
        application.emails = emailsFor(c.db, appId).map((e) => emailToPb(e));
        return { application };
      });
    },

    prepareApplication(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          let created = false;
          let appId: number;
          if (req.applicationId !== undefined) {
            const app = getApplicationRow(tx.db, id(req.applicationId, 'application_id'));
            requestPrepare(tx, app, {
              rewrite: req.rewrite,
              why: req.rewrite ? 'redrafting every answer' : 'preparing again',
            });
            appId = app.id;
          } else {
            const postingId = id(req.postingId, 'posting_id');
            const posting = tx.db.select().from(postings).where(eq(postings.id, postingId)).get();
            if (!posting) throw new ApplicationError(`no posting ${postingId}`);
            if (
              posting.stage === 'found' ||
              posting.stage === 'failed_verification' ||
              posting.stage === 'closed'
            ) {
              throw new ConnectError(
                `posting ${postingId} is ${posting.stage}: only a verified, open posting can be applied to`,
                Code.FailedPrecondition,
              );
            }
            const res = ensureApplication(tx, postingId, 'you asked for it');
            created = res.created;
            if (!created) {
              requestPrepare(tx, res.app, {
                rewrite: req.rewrite,
                why: req.rewrite ? 'redrafting every answer' : 'preparing again',
              });
            }
            appId = res.app.id;
          }
          return { application: applicationToPb(applicationView(tx.db, appId)), created };
        }),
      );
    },

    setFieldValue(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          const res = setFieldValue(tx, appId, req.field, req.clear ? null : req.value);
          const view = applicationView(tx.db, appId);
          const field = applicationToPb(view).fields.find((f) => f.ref === res.field.ref);
          return { application: applicationToPb(view), field };
        }),
      );
    },

    editAnswer(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          if (req.sentence !== undefined && req.sentence < 0) {
            throw new ApplicationError('sentence numbers start at 1');
          }
          const res = editAnswer(tx, appId, {
            answer: req.answer,
            sentence: req.sentence ?? null,
            text: req.text ?? null,
          });
          const view = applicationView(tx.db, appId);
          return {
            application: applicationToPb(view),
            answer: answerToPb(findAnswer(view, `q${res.answer.number}`)),
            factIds: res.factIds.map((n) => BigInt(n)),
          };
        }),
      );
    },

    redraftAnswer(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          redraftAnswer(tx, appId, {
            answer: req.answer,
            shorter: req.shorter,
            project: req.project?.trim() || null,
          });
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    approveApplication(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.id, 'id');
          approveApplication(tx, appId);
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    submitApplication(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.id, 'id');
          submitApplication(tx, appId);
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    setApplyForm(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          const form =
            req.form === ApplyForm.PLATFORM
              ? 'platform'
              : req.form === ApplyForm.COMPANY
                ? 'company'
                : null;
          if (!form)
            throw new ConnectError('form must be platform or company', Code.InvalidArgument);
          try {
            setApplyForm(tx, getApplicationRow(tx.db, appId), form);
          } catch (err) {
            // No such form, or already approved: the request is fine, the state refuses it.
            if (err instanceof ApplicationError && !/^no application/.test(err.message))
              throw new ConnectError(err.message, Code.FailedPrecondition);
            throw err;
          }
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    markSubmitted(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          markSubmittedByHand(tx, appId);
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    getHandOff(req) {
      return guard(() => {
        const appId = id(req.applicationId, 'application_id');
        const view = applicationView(c.db, appId);
        return { handOff: view.handOff ? handOffToPb(view.handOff) : undefined };
      });
    },

    setCvMode(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          if (req.mode !== 'tailored' && req.mode !== 'base') {
            throw new ConnectError('mode is tailored or base', Code.InvalidArgument);
          }
          setCvMode(tx, appId, req.mode, getStandardProfile(tx.db));
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    editCv(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          const res = editCvLine(tx, appId, req.line, req.text ?? null);
          return {
            application: applicationToPb(applicationView(tx.db, appId)),
            factId: res.factId === null ? undefined : BigInt(res.factId),
          };
        }),
      );
    },

    setApplicationStage(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const appId = id(req.applicationId, 'application_id');
          const to = appStageFromPb(req.stage);
          if (!to) throw new ConnectError('give a stage', Code.InvalidArgument);
          setApplicationStage(tx, appId, to);
          return { application: applicationToPb(applicationView(tx.db, appId)) };
        }),
      );
    },

    // Replaces candidate.ts's ConfirmFact: plain ids as before, or an application's facts.
    confirmFact(req) {
      return guard(() => {
        const ids = req.ids.map((v) => id(v, 'fact id'));
        const views = runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          let done: number[];
          if (req.applicationId !== undefined) {
            const appId = id(req.applicationId, 'application_id');
            getApplicationRow(tx.db, appId);
            done = confirmApplicationFacts(tx, appId, ids);
          } else {
            if (ids.length === 0)
              throw new ConnectError('give at least one fact id', Code.InvalidArgument);
            done = ids;
            for (const fid of ids) {
              if (!getFact(tx.db, fid)) throw new FactError(`no fact ${fid}`);
            }
            confirmApplicationFactsPlain(tx, ids);
          }
          return done.map((fid) => getFact(tx.db, fid)).filter((f) => f !== null);
        });
        const out: Fact[] = views.map(factToPb);
        return { facts: out };
      });
    },
  };
}

function markReviewStarted(c: RpcContext, appId: number): void {
  c.db
    .update(applications)
    .set({ reviewStartedAt: c.now() })
    .where(
      and(
        eq(applications.id, appId),
        isNull(applications.reviewStartedAt),
        inArray(applications.stage, ['ready_for_review', 'needs_candidate']),
      ),
    )
    .run();
}

function confirmApplicationFactsPlain(tx: Tx, ids: number[]): void {
  for (const fid of ids) confirmFact(tx.db, fid, tx.now);
}
