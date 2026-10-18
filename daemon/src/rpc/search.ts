// Search RPCs: strategies, sources and runs. validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Conn } from '../db/client.ts';
import type {
  AtsDiscoveryRow,
  ListingRecipeRow,
  ResolvedSource,
  SearchPlanRow,
  StrategyState,
} from '../db/schema.ts';
import { startDiscovery } from '../domain/search/ats-index/discover.ts';
import { knowWatched } from '../domain/search/ats-index/store.ts';
import {
  type AtsView,
  type CompanyView,
  indexView,
  listCompanies,
  setCompanyEnabled,
} from '../domain/search/ats-index/views.ts';
import { latestPlans, startPlan } from '../domain/search/planner.ts';
import { boardUrl } from '../domain/search/readers/ats-embed.ts';
import { recipeRow, recipeSummaries, requestRecipe } from '../domain/search/recipes/store.ts';
import { describeRecipe } from '../domain/search/recipes/types.ts';
import {
  addSource,
  findSource,
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
  type AtsIndexAts,
  AtsIndexAtsSchema,
  type AtsIndexDiscovery,
  AtsIndexDiscoverySchema,
  type IndexCompany,
  IndexCompanySchema,
  type ListingRecipe,
  ListingRecipeSchema,
  type SearchStats as PbStats,
  type SearchPlan,
  SearchPlanSchema,
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
    effectiveEveryMinutes: s.cadence.everyMinutes,
    cadenceNote: s.cadence.note ?? undefined,
  });
}

type RecipeSummary = Omit<ListingRecipeRow, 'fixtureHtml' | 'expected' | 'fixtureUrl'> &
  Partial<Pick<ListingRecipeRow, 'expected'>>;

export function recipeToPb(r: RecipeSummary): ListingRecipe {
  return create(ListingRecipeSchema, {
    status: r.status,
    builtAt: r.builtAt ? timestampFromDate(r.builtAt) : undefined,
    lastCount: r.lastCount ?? undefined,
    note: r.note ?? undefined,
    description: r.recipe ? describeRecipe(r.recipe) : [],
    builds: r.builds,
    listings: (r.expected ?? []).map((l) => ({
      title: l.title,
      url: l.url,
      location: l.location ?? undefined,
      team: l.team ?? undefined,
    })),
    lastSampledAt: r.lastSampledAt ? timestampFromDate(r.lastSampledAt) : undefined,
  });
}

export function planToPb(p: SearchPlanRow): SearchPlan {
  return create(SearchPlanSchema, {
    id: BigInt(p.id),
    trigger: p.trigger,
    status: p.status,
    startedAt: timestampFromDate(p.startedAt),
    finishedAt: p.finishedAt ? timestampFromDate(p.finishedAt) : undefined,
    strategyIds: p.strategies.map((id) => BigInt(id)),
    boardKeys: p.boards,
    searches: p.searches,
    note: p.note ?? undefined,
  });
}

export function describeResolved(r: ResolvedSource | null): string | undefined {
  if (!r) return undefined;
  if (r.via === 'feed') return `${r.format} feed ${r.url}`;
  if (r.via === 'ats') return `${r.ats} board ${r.token}`;
  if (r.via === 'recipe') return 'listing recipe';
  if (r.via === 'telegram') {
    const judged = Object.values(r.posts);
    const jobs = judged.filter(Boolean).length;
    return `Telegram channel: ${judged.length} posts judged, ${jobs} job${jobs === 1 ? '' : 's'}`;
  }
  return `Lever API ${r.apiHost}`;
}

export function sourceToPb(s: SourceView, recipe?: RecipeSummary | null): SearchSource {
  return create(SearchSourceSchema, {
    note: s.note ?? undefined,
    recipe: recipe ? recipeToPb(recipe) : undefined,
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

function atsToPb(a: AtsView): AtsIndexAts {
  return create(AtsIndexAtsSchema, {
    ...a,
    lastReadAt: a.lastReadAt ? timestampFromDate(a.lastReadAt) : undefined,
  });
}

function discoveryToPb(d: AtsDiscoveryRow): AtsIndexDiscovery {
  return create(AtsIndexDiscoverySchema, {
    id: BigInt(d.id),
    trigger: d.trigger,
    status: d.status,
    startedAt: timestampFromDate(d.startedAt),
    finishedAt: d.finishedAt ? timestampFromDate(d.finishedAt) : undefined,
    found: d.found,
    added: d.added,
    note: d.note ?? undefined,
  });
}

export function indexCompanyToPb(c: CompanyView): IndexCompany {
  return create(IndexCompanySchema, {
    id: BigInt(c.id),
    ats: c.ats,
    token: c.token,
    name: c.name ?? undefined,
    enabled: c.enabled,
    status: c.status,
    jobs: c.jobs,
    matching: c.matching,
    lastReadAt: c.lastReadAt ? timestampFromDate(c.lastReadAt) : undefined,
    nextReadAt: timestampFromDate(c.nextReadAt),
    foundVia: c.foundVia,
    lastNote: c.lastNote ?? undefined,
    boardUrl: boardUrl(c),
    watched: c.sourceKey !== null,
    sourceKey: c.sourceKey ?? undefined,
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
      const code = /^no (search )?(strategy|source|company)/.test(err.message)
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

function requireSource(conn: Conn, ref: string) {
  const row = findSource(conn, ref.trim());
  if (!row)
    throw new SearchError(`no search source "${ref}" (see \`applyant search sources list\`)`);
  return row;
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
  | 'planSearch'
  | 'getSearchSource'
  | 'rebuildRecipe'
  | 'getAtsIndex'
  | 'listIndexCompanies'
  | 'setIndexCompanyEnabled'
  | 'discoverIndexCompanies'
> {
  return {
    getAtsIndex() {
      const v = indexView(c.db, c.now());
      return {
        enabled: v.enabled,
        ats: v.ats.map(atsToPb),
        discoveries: v.discoveries.map(discoveryToPb),
        companies: v.companies,
        jobs: v.jobs,
        matching: v.matching,
      };
    },

    listIndexCompanies(req) {
      return guard(() => {
        const res = listCompanies(c.db, {
          ats: req.ats ?? null,
          query: req.query,
          matchingOnly: req.matchingOnly,
          limit: req.limit,
          offset: req.offset,
        });
        return { companies: res.companies.map(indexCompanyToPb), total: res.total };
      });
    },

    setIndexCompanyEnabled(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => ({
          company: indexCompanyToPb(setCompanyEnabled(tx.db, Number(req.id), req.enabled)),
        })),
      );
    },

    discoverIndexCompanies() {
      const id = runInTx(c.db, c.bus, { now: c.now() }, (tx) => startDiscovery(tx, 'manual'));
      return { discoveryId: id === null ? undefined : BigInt(id) };
    },

    listSearch() {
      const { sources, kinds } = listSources(c.db);
      const recipes = recipeSummaries(c.db);
      return {
        strategies: listStrategies(c.db).map(strategyToPb),
        sources: sources.map((s) => sourceToPb(s, recipes.get(s.id))),
        kinds: kinds.map(kindToPb),
        plans: latestPlans(c.db, 5).map(planToPb),
      };
    },

    planSearch() {
      const planId = runInTx(c.db, c.bus, { now: c.now() }, (tx) => startPlan(tx, 'manual'));
      return { planId: planId === null ? undefined : BigInt(planId) };
    },

    getSearchSource(req) {
      return guard(() => {
        const row = requireSource(c.db, req.source);
        const view = sourceView(c.db, row.key);
        const recipe = recipeRow(c.db, row.id);
        return { source: view ? sourceToPb(view, recipe) : undefined };
      });
    },

    rebuildRecipe(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const row = requireSource(tx.db, req.source);
          if (row.kind !== 'page') {
            throw new SearchError(
              `${row.key} is read through its ${row.kind === 'board' ? 'API' : 'ATS list API'}: only career pages have listing recipes`,
            );
          }
          if (row.resolved && row.resolved.via !== 'recipe') {
            throw new SearchError(
              `${row.key} is read as ${describeResolved(row.resolved)}: it needs no listing recipe`,
            );
          }
          const queued = requestRecipe(
            tx,
            row,
            { kind: 'broken', detail: 'rebuild asked for by you' },
            { force: true },
          );
          const view = sourceView(tx.db, row.key);
          return {
            queued,
            source: view ? sourceToPb(view, recipeRow(tx.db, row.id)) : undefined,
          };
        }),
      );
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
        // A watched ATS board is a company of the index from the start.
        const { source, created } = runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const res = addSource(tx.db, input, tx.now);
          knowWatched(tx, [res.source]);
          return res;
        });
        const view = sourceView(c.db, source.key);
        return { source: view ? sourceToPb(view, recipeRow(c.db, source.id)) : undefined, created };
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
            .map((s) => sourceToPb(s)),
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
