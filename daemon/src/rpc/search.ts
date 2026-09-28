// Search RPCs: strategies, sources and runs. validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Conn } from '../db/client.ts';
import type { ResolvedSource, StrategyState } from '../db/schema.ts';
import {
  addSource,
  type KindView,
  listSources,
  parseSourceInput,
  SearchError,
  type SearchStats,
  type SourceView,
  setSourceEnabled,
} from '../domain/search/sources.ts';
import {
  addStrategy,
  deleteStrategy,
  listRuns,
  listStrategies,
  type RunView,
  requireStrategy,
  type StrategyPatch,
  type StrategyView,
  startSearchRun,
  strategyView,
  updateStrategy,
} from '../domain/search/strategies.ts';
import {
  type ApplyantService,
  type SearchStats as PbStats,
  type SearchRun,
  SearchRunSchema,
  type SearchSource,
  type SearchSourceKind,
  SearchSourceKindSchema,
  SearchSourceSchema,
  SearchStatsSchema,
  type SearchStrategy,
  SearchStrategySchema,
} from '../gen/applyant/v1/applyant_pb.js';
import { runInTx } from '../queue/tx.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

function statsToPb(s: SearchStats): PbStats {
  return create(SearchStatsSchema, { ...s });
}

export function runToPb(r: RunView): SearchRun {
  return create(SearchRunSchema, {
    id: BigInt(r.id),
    strategyId: BigInt(r.strategyId),
    strategyName: r.strategyName,
    trigger: r.trigger,
    status: r.status,
    startedAt: timestampFromDate(r.startedAt),
    finishedAt: r.finishedAt ? timestampFromDate(r.finishedAt) : undefined,
    listed: r.listed,
    added: r.added,
    note: r.note ?? undefined,
    sources: r.results.map((x) => ({
      ...x,
      error: x.error ?? undefined,
      note: x.note ?? undefined,
    })),
  });
}

export function strategyToPb(s: StrategyView): SearchStrategy {
  return create(SearchStrategySchema, {
    id: BigInt(s.id),
    name: s.name,
    queries: s.queries,
    locations: s.locations,
    sources: s.sources,
    everyMinutes: s.everyMinutes,
    state: s.state,
    origin: s.origin,
    lastRunAt: s.lastRunAt ? timestampFromDate(s.lastRunAt) : undefined,
    nextRunAt: timestampFromDate(s.nextRunAt),
    note: s.note ?? undefined,
    stats: statsToPb(s.stats),
    lastRun: s.lastRun ? runToPb({ ...s.lastRun, strategyName: s.name }) : undefined,
    sourceKeys: s.sourceKeys,
    running: s.running,
  });
}

export function describeResolved(r: ResolvedSource | null): string | undefined {
  if (!r) return undefined;
  if (r.via === 'feed') return `${r.format} feed ${r.url}`;
  if (r.via === 'ats') return `${r.ats} board ${r.token}`;
  return `Lever API ${r.apiHost}`;
}

export function sourceToPb(s: SourceView): SearchSource {
  return create(SearchSourceSchema, {
    id: BigInt(s.id),
    key: s.key,
    kind: s.kind,
    locator: s.locator,
    label: s.label,
    enabled: s.enabled,
    kindEnabled: s.kindEnabled,
    completeList: s.completeList,
    origin: s.origin,
    lastRunAt: s.lastRunAt ? timestampFromDate(s.lastRunAt) : undefined,
    lastCount: s.lastCount ?? undefined,
    lastComplete: s.lastComplete ?? undefined,
    lastNote: s.lastNote ?? undefined,
    resolved: describeResolved(s.resolved ?? null),
    stats: statsToPb(s.stats),
  });
}

function kindToPb(k: KindView): SearchSourceKind {
  return create(SearchSourceKindSchema, { ...k });
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    if (err instanceof SearchError) {
      const code = /^no (search )?(strategy|source)/.test(err.message)
        ? Code.NotFound
        : /already exists/.test(err.message)
          ? Code.AlreadyExists
          : Code.InvalidArgument;
      throw new ConnectError(err.message, code);
    }
    throw err;
  }
}

function sourceView(conn: Conn, key: string): SourceView | undefined {
  return listSources(conn).sources.find((s) => s.key === key);
}

function stateFrom(value: string): StrategyState {
  if (value !== 'active' && value !== 'paused') {
    throw new ConnectError(`state must be active or paused, not "${value}"`, Code.InvalidArgument);
  }
  return value;
}

export function searchRpcs(
  c: RpcContext,
): Pick<
  Impl,
  | 'listSearch'
  | 'addStrategy'
  | 'updateStrategy'
  | 'deleteStrategy'
  | 'runStrategy'
  | 'addSearchSource'
  | 'setSearchSourceEnabled'
  | 'listSearchRuns'
> {
  return {
    listSearch() {
      const { sources, kinds } = listSources(c.db);
      return {
        strategies: listStrategies(c.db).map(strategyToPb),
        sources: sources.map(sourceToPb),
        kinds: kinds.map(kindToPb),
      };
    },

    addStrategy(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const res = addStrategy(tx, {
            name: req.name,
            queries: req.queries,
            locations: req.locations,
            sources: req.sources,
            ...(req.everyMinutes > 0 ? { everyMinutes: req.everyMinutes } : {}),
            state: req.paused ? 'paused' : 'active',
          });
          return {
            strategy: strategyToPb(strategyView(tx.db, res.strategy)),
            runId: res.runId === null ? undefined : BigInt(res.runId),
          };
        }),
      );
    },

    updateStrategy(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const patch: StrategyPatch = {};
          if (req.name !== undefined) patch.name = req.name;
          if (req.queries) patch.queries = req.queries.values;
          if (req.locations) patch.locations = req.locations.values;
          if (req.sources) patch.sources = req.sources.values;
          if (req.everyMinutes !== undefined) patch.everyMinutes = req.everyMinutes;
          if (req.state !== undefined) patch.state = stateFrom(req.state);
          const row = updateStrategy(tx, req.strategy, patch);
          return { strategy: strategyToPb(strategyView(tx.db, row)) };
        }),
      );
    },

    deleteStrategy(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          deleteStrategy(tx, req.strategy);
          return {};
        }),
      );
    },

    runStrategy(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const row = requireStrategy(tx.db, req.strategy);
          const runId = startSearchRun(tx, row, 'manual');
          return {
            strategy: strategyToPb(strategyView(tx.db, requireStrategy(tx.db, row.id))),
            runId: runId === null ? undefined : BigInt(runId),
          };
        }),
      );
    },

    addSearchSource(req) {
      return guard(() => {
        const input = parseSourceInput(
          req.kind ? [req.kind, req.locator] : [req.locator],
          req.label ?? null,
        );
        const { source, created } = addSource(c.db, input, c.now());
        const view = sourceView(c.db, source.key);
        return { source: view ? sourceToPb(view) : undefined, created };
      });
    },

    setSearchSourceEnabled(req) {
      return guard(() => {
        const res = setSourceEnabled(c.db, req.target, req.enabled);
        const { sources, kinds } = listSources(c.db);
        const kind = res.kind ? kinds.find((k) => k.kind === res.kind) : undefined;
        const keys = new Set(res.sources.map((s) => s.key));
        return {
          kind: kind ? kindToPb(kind) : undefined,
          sources: sources
            .filter((s) => (res.kind ? s.kind === res.kind : keys.has(s.key)))
            .map(sourceToPb),
        };
      });
    },

    listSearchRuns(req) {
      return guard(() => {
        const strategyId =
          req.strategy !== undefined && req.strategy !== ''
            ? requireStrategy(c.db, req.strategy).id
            : undefined;
        const runs = listRuns(c.db, {
          ...(strategyId !== undefined ? { strategyId } : {}),
          limit: req.limit > 0 ? req.limit : 20,
        });
        return { runs: runs.map(runToPb) };
      });
    },
  };
}
