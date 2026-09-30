// Candidate knowledge RPCs: validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { isNull, sql } from 'drizzle-orm';
import { type FactStatus, facts, type SourceKind, type SourceRow } from '../db/schema.ts';
import { enqueueEmbedFacts } from '../domain/knowledge/embed-index.ts';
import type { EvidenceView } from '../domain/knowledge/evidence.ts';
import {
  editFact,
  FactError,
  type FactView,
  getFact,
  listFacts,
  rejectFact,
} from '../domain/knowledge/facts.ts';
import {
  getProfile,
  ProfileError,
  parseProfileValue,
  setProfileValue,
} from '../domain/knowledge/profile.ts';
import {
  createProject,
  deleteProject,
  listProjects,
  ProjectError,
  type ProjectSummary,
  requireProject,
  updateProject,
} from '../domain/knowledge/projects.ts';
import {
  addSource,
  listSources,
  requestSync,
  SourceError,
} from '../domain/knowledge/sources/registry.ts';
import {
  type ApplyantService,
  EvidenceSchema,
  type Fact,
  FactSchema,
  FactStatus as PbFactStatus,
  SourceKind as PbSourceKind,
  type Project,
  ProjectSchema,
  type Source,
  SourceSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import { runInTx } from '../queue/tx.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

const KIND_TO_PB: Record<SourceKind, PbSourceKind> = {
  file: PbSourceKind.FILE,
  url: PbSourceKind.URL,
  github: PbSourceKind.GITHUB,
  drive: PbSourceKind.DRIVE,
  manual: PbSourceKind.MANUAL,
};

const STATUS_TO_PB: Record<FactStatus, PbFactStatus> = {
  unconfirmed: PbFactStatus.UNCONFIRMED,
  confirmed: PbFactStatus.CONFIRMED,
  rejected: PbFactStatus.REJECTED,
};

function kindFromPb(kind: PbSourceKind): SourceKind {
  for (const [k, v] of Object.entries(KIND_TO_PB)) if (v === kind) return k as SourceKind;
  throw new ConnectError('source kind is required (file | url | github)', Code.InvalidArgument);
}

function statusFromPb(status: PbFactStatus): FactStatus | undefined {
  for (const [k, v] of Object.entries(STATUS_TO_PB)) if (v === status) return k as FactStatus;
  return undefined;
}

export function projectToPb(p: ProjectSummary): Project {
  return create(ProjectSchema, {
    id: BigInt(p.id),
    slug: p.slug,
    name: p.name,
    summary: p.summary ?? undefined,
    role: p.role ?? undefined,
    period: p.period ?? undefined,
    stack: p.stack,
    sourceCount: p.sources,
    factCount: p.facts,
    unconfirmedCount: p.unconfirmed,
    confirmedCount: p.confirmed,
  });
}

export function sourceToPb(s: SourceRow): Source {
  return create(SourceSchema, {
    id: BigInt(s.id),
    projectId: s.projectId === null ? undefined : BigInt(s.projectId),
    kind: KIND_TO_PB[s.kind],
    locator: s.locator,
    lastSyncedAt: s.lastSyncedAt ? timestampFromDate(s.lastSyncedAt) : undefined,
    syncNote: s.syncNote ?? undefined,
  });
}

function evidenceToPb(e: EvidenceView) {
  return create(EvidenceSchema, {
    sourceId: e.sourceId === null ? undefined : BigInt(e.sourceId),
    sourceKind: e.sourceKind ? KIND_TO_PB[e.sourceKind] : PbSourceKind.UNSPECIFIED,
    sourceLocator: e.sourceLocator ?? '',
    locator: e.locator ?? undefined,
    excerpt: e.excerpt ?? undefined,
  });
}

export function factToPb(f: FactView): Fact {
  return create(FactSchema, {
    id: BigInt(f.id),
    projectId: f.projectId === null ? undefined : BigInt(f.projectId),
    projectSlug: f.project?.slug,
    text: f.text,
    kind: f.kind,
    status: STATUS_TO_PB[f.status],
    origin: f.origin,
    evidence: f.evidence.map(evidenceToPb),
    editedAt: f.editedAt ? timestampFromDate(f.editedAt) : undefined,
  });
}

function ids(values: bigint[]): number[] {
  if (values.length === 0)
    throw new ConnectError('give at least one fact id', Code.InvalidArgument);
  return values.map((v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new ConnectError(`${v} is not a fact id`, Code.InvalidArgument);
    }
    return n;
  });
}

/** Domain validation errors become InvalidArgument / NotFound; everything else is internal. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    if (err instanceof ProjectError || err instanceof FactError) {
      const code = /^no (project|fact)/.test(err.message) ? Code.NotFound : Code.InvalidArgument;
      throw new ConnectError(err.message, code);
    }
    if (err instanceof SourceError || err instanceof ProfileError) {
      throw new ConnectError(err.message, Code.InvalidArgument);
    }
    throw err;
  }
}

function profileEntries(profile: Record<string, unknown>) {
  return Object.entries(profile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      values: Array.isArray(value) ? value.map(String) : value === null ? [] : [String(value)],
    }));
}

export function candidateRpcs(
  c: RpcContext,
): Pick<
  Impl,
  | 'getCandidate'
  | 'setProfileValue'
  | 'createProject'
  | 'listProjects'
  | 'getProject'
  | 'updateProject'
  | 'deleteProject'
  | 'addSource'
  | 'syncSources'
  | 'listFacts'
  | 'editFact'
  | 'rejectFact'
> {
  return {
    getCandidate() {
      const profileFacts = c.db
        .select({ n: sql<number>`count(*)` })
        .from(facts)
        .where(isNull(facts.projectId))
        .get();
      return {
        profile: profileEntries(getProfile(c.db)),
        projects: listProjects(c.db).map(projectToPb),
        profileSources: listSources(c.db, null).map(sourceToPb),
        profileFactCount: Number(profileFacts?.n ?? 0),
      };
    },

    setProfileValue(req) {
      return guard(() => {
        const value = parseProfileValue(req.key, req.value);
        setProfileValue(c.db, req.key, value, c.now());
        return { entry: profileEntries({ [req.key]: value })[0] };
      });
    },

    createProject(req) {
      return guard(() => {
        const row = createProject(
          c.db,
          {
            name: req.name,
            slug: req.slug ?? null,
            summary: req.summary ?? null,
            role: req.role ?? null,
            period: req.period ?? null,
            stack: req.stack,
          },
          c.now(),
        );
        const summary = listProjects(c.db).find((p) => p.id === row.id);
        if (!summary) throw new Error('project vanished');
        return { project: projectToPb(summary) };
      });
    },

    listProjects() {
      return { projects: listProjects(c.db).map(projectToPb) };
    },

    getProject(req) {
      return guard(() => {
        const row = requireProject(c.db, req.ref);
        const summary = listProjects(c.db).find((p) => p.id === row.id);
        if (!summary) throw new Error('project vanished');
        return {
          project: projectToPb(summary),
          sources: listSources(c.db, row.id).map(sourceToPb),
        };
      });
    },

    updateProject(req) {
      return guard(() => {
        const row = updateProject(
          c.db,
          req.project,
          {
            ...(req.name === undefined ? {} : { name: req.name }),
            ...(req.summary === undefined ? {} : { summary: req.summary }),
            ...(req.role === undefined ? {} : { role: req.role }),
            ...(req.period === undefined ? {} : { period: req.period }),
            ...(req.stack === undefined ? {} : { stack: req.stack.values }),
          },
          c.now(),
        );
        const summary = listProjects(c.db).find((p) => p.id === row.id);
        if (!summary) throw new Error('project vanished');
        return { project: projectToPb(summary) };
      });
    },

    deleteProject(req) {
      return guard(() => {
        const res = runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
          deleteProject(tx.db, req.project),
        );
        return { sourcesRemoved: res.sources, factsRemoved: res.facts };
      });
    },

    addSource(req) {
      return guard(() => {
        const { source, created } = addSource(c.db, c.bus, {
          project: req.project.trim() || null,
          kind: kindFromPb(req.kind),
          locator: req.locator,
          now: c.now(),
        });
        return { source: sourceToPb(source), created };
      });
    },

    syncSources(req) {
      return guard(() => {
        const res = requestSync(c.db, c.bus, {
          target: req.target.trim() || null,
          force: req.force,
          now: c.now(),
        });
        return {
          sources: res.sources.map(sourceToPb),
          enqueuedSourceIds: res.enqueued.map((id) => BigInt(id)),
        };
      });
    },

    listFacts(req) {
      return guard(() => {
        const ref = req.project.trim();
        const projectId =
          ref === '' ? undefined : ref === 'profile' ? null : requireProject(c.db, ref).id;
        const status = statusFromPb(req.status);
        return {
          facts: listFacts(c.db, {
            ...(projectId === undefined ? {} : { projectId }),
            ...(status ? { status } : {}),
          }).map(factToPb),
        };
      });
    },

    rejectFact(req) {
      return guard(() => changeFacts(c, ids(req.ids), rejectFact));
    },

    editFact(req) {
      return guard(() => {
        const [id] = ids([req.id]);
        const fact = runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          editFact(tx.db, id as number, req.text, tx.now);
          // The trigger dropped the old vector; embed the new text.
          enqueueEmbedFacts(tx);
          return getFact(tx.db, id as number);
        });
        if (!fact) throw new ConnectError(`no fact ${id}`, Code.NotFound);
        return { fact: factToPb(fact) };
      });
    },
  };
}

function changeFacts(
  c: RpcContext,
  factIds: number[],
  change: typeof rejectFact,
): { facts: Fact[] } {
  const views = runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
    factIds.map((id) => {
      change(tx.db, id, tx.now);
      const view = getFact(tx.db, id);
      if (!view) throw new FactError(`no fact ${id}`);
      return view;
    }),
  );
  return { facts: views.map(factToPb) };
}
