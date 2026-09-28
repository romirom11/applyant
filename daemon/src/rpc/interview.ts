// Interview RPCs: validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Conn } from '../db/client.ts';
import { getFact } from '../domain/knowledge/facts.ts';
import {
  answerQuestion,
  dismissQuestion,
  getQuestionRow,
  InterviewError,
  listQuestions,
  type ProjectInterview,
  projectInterviews,
  projectThread,
  type QuestionView,
  questionView,
  questionViews,
  startInterview,
  threadRows,
} from '../domain/knowledge/interview.ts';
import {
  listProjects,
  ProjectError,
  type ProjectSummary,
  requireProject,
} from '../domain/knowledge/projects.ts';
import {
  type ApplyantService,
  type InterviewQuestion,
  InterviewQuestionSchema,
  type ProjectInterview as PbProjectInterview,
  ProjectInterviewSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import { runInTx } from '../queue/tx.ts';
import { factToPb, projectToPb } from './candidate.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

function questionToPb(conn: Conn, q: QuestionView): InterviewQuestion {
  return create(InterviewQuestionSchema, {
    id: BigInt(q.id),
    projectId: q.project ? BigInt(q.project.id) : undefined,
    projectSlug: q.project?.slug,
    projectName: q.project?.name,
    applicationId: q.applicationId === null ? undefined : BigInt(q.applicationId),
    application: q.application ?? undefined,
    fieldRef: q.fieldRef ?? undefined,
    text: q.text,
    context: q.context ?? undefined,
    status: q.status,
    origin: q.origin,
    note: q.note ?? undefined,
    createdAt: timestampFromDate(q.createdAt),
    answeredAt: q.answeredAt ? timestampFromDate(q.answeredAt) : undefined,
    answer: q.answer ?? undefined,
    facts: q.facts
      .map((f) => getFact(conn, f.id))
      .filter((f) => f !== null)
      .map(factToPb),
  });
}

function projectInterviewToPb(
  p: ProjectInterview,
  summaries: Map<number, ProjectSummary>,
): PbProjectInterview {
  const summary = summaries.get(p.project.id);
  return create(ProjectInterviewSchema, {
    project: summary ? projectToPb(summary) : undefined,
    gaps: p.gaps.map((g) => g.key),
    gapLabels: p.gaps.map((g) => g.label),
    open: p.open,
    asked: p.asked,
    busy: p.busy,
  });
}

function projectSummaries(conn: Conn): Map<number, ProjectSummary> {
  return new Map(listProjects(conn).map((p) => [p.id, p]));
}

function questionId(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConnectError('a question id must be a positive number', Code.InvalidArgument);
  }
  return n;
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    if (err instanceof InterviewError || err instanceof ProjectError) {
      const code = /^no (interview question|project)/.test(err.message)
        ? Code.NotFound
        : /^question \d+ is /.test(err.message)
          ? Code.FailedPrecondition
          : Code.InvalidArgument;
      throw new ConnectError(err.message, code);
    }
    throw err;
  }
}

export function interviewRpcs(
  c: RpcContext,
): Pick<
  Impl,
  | 'listInterview'
  | 'getInterview'
  | 'startInterview'
  | 'answerInterviewQuestion'
  | 'dismissInterviewQuestion'
> {
  return {
    listInterview(req) {
      const summaries = projectSummaries(c.db);
      return {
        questions: listQuestions(c.db, { all: req.all }).map((q) => questionToPb(c.db, q)),
        projects: projectInterviews(c.db).map((p) => projectInterviewToPb(p, summaries)),
      };
    },

    getInterview(req) {
      return guard(() => {
        const target = req.target;
        if (target.case === 'project') {
          const project = requireProject(c.db, target.value);
          const rows = projectThread(c.db, project.id);
          const summary = projectInterviews(c.db).find((p) => p.project.id === project.id);
          return {
            questions: questionViews(c.db, rows).map((q) => questionToPb(c.db, q)),
            project: summary ? projectInterviewToPb(summary, projectSummaries(c.db)) : undefined,
            pending: summary?.busy ?? false,
          };
        }
        if (target.case === 'questionId') {
          const row = getQuestionRow(c.db, questionId(target.value));
          if (!row) throw new InterviewError(`no interview question ${target.value}`);
          const rows = threadRows(c.db, row);
          const summary =
            row.projectId !== null && row.applicationId === null
              ? projectInterviews(c.db).find((p) => p.project.id === row.projectId)
              : undefined;
          return {
            questions: questionViews(c.db, rows).map((q) => questionToPb(c.db, q)),
            project: summary ? projectInterviewToPb(summary, projectSummaries(c.db)) : undefined,
            pending: summary?.busy ?? rows.some((q) => q.status === 'processing'),
          };
        }
        throw new ConnectError('give a project or a question id', Code.InvalidArgument);
      });
    },

    startInterview(req) {
      return guard(() => {
        const res = runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
          startInterview(tx, req.project.trim() || null),
        );
        switch (res.kind) {
          case 'question':
            return {
              question: questionToPb(c.db, res.question),
              pending: false,
              projectId:
                res.question.projectId === null ? undefined : BigInt(res.question.projectId),
              message: '',
            };
          case 'pending':
            return {
              pending: true,
              projectId: res.projectId === null ? undefined : BigInt(res.projectId),
              message: res.message,
            };
          case 'nothing':
            return { pending: false, message: res.message };
        }
      });
    },

    answerInterviewQuestion(req) {
      return guard(() => {
        const id = questionId(req.id);
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => answerQuestion(tx, id, req.text));
        return { question: questionToPb(c.db, questionView(c.db, id)) };
      });
    },

    dismissInterviewQuestion(req) {
      return guard(() => {
        const id = questionId(req.id);
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => dismissQuestion(tx, id));
        return { question: questionToPb(c.db, questionView(c.db, id)) };
      });
    },
  };
}
