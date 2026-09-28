// `applyant search …`: strategies, sources and runs.
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { Command } from 'commander';
import type {
  SearchRun,
  SearchSource,
  SearchStats,
  SearchStrategy,
} from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table, truncate } from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

const collect = (value: string, previous: string[]): string[] => [...previous, value];
const list = (value: string): string[] =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** "6h" · "90m" · "1d" → minutes (the daemon checks the minimum). */
export function everyMinutes(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|d)?\s*$/i.exec(text);
  if (!m) throw new Error(`"${text}" is not a schedule (e.g. 6h, 90m, 1d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase()[0];
  return Math.round(unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n);
}

export function formatEvery(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function when(ts: Parameters<typeof timestampDate>[0] | undefined): string {
  if (!ts) return '-';
  const d = timestampDate(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "12 (41%)": interested, as a share of verified. */
export function interestedText(s: SearchStats | undefined): string {
  if (!s || s.interested === 0) return '0';
  return s.verified
    ? `${s.interested} (${Math.round((100 * s.interested) / s.verified)}%)`
    : String(s.interested);
}

function stats(s: SearchStats | undefined) {
  return {
    found: s?.found ?? 0,
    verified: s?.verified ?? 0,
    interested: s?.interested ?? 0,
    skipped: s?.skipped ?? 0,
  };
}

function runJson(r: SearchRun) {
  return {
    id: Number(r.id),
    strategyId: Number(r.strategyId),
    strategy: r.strategyName,
    trigger: r.trigger,
    status: r.status,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    listed: r.listed,
    added: r.added,
    note: r.note ?? null,
    sources: r.sources.map((s) => ({
      source: s.sourceKey,
      label: s.label,
      listed: s.listed,
      matched: s.matched,
      added: s.added,
      attached: s.attached,
      complete: s.complete,
      closed: s.closed,
      reopened: s.reopened,
      reverify: s.reverify,
      error: s.error ?? null,
      note: s.note ?? null,
    })),
  };
}

export function strategyJson(s: SearchStrategy) {
  return {
    id: Number(s.id),
    name: s.name,
    state: s.state,
    origin: s.origin,
    queries: s.queries,
    locations: s.locations,
    sources: s.sources,
    sourceKeys: s.sourceKeys,
    everyMinutes: s.everyMinutes,
    lastRunAt: iso(s.lastRunAt),
    nextRunAt: iso(s.nextRunAt),
    running: s.running,
    stats: stats(s.stats),
    lastRun: s.lastRun ? runJson(s.lastRun) : null,
  };
}

function sourceJson(s: SearchSource) {
  return {
    id: Number(s.id),
    key: s.key,
    kind: s.kind,
    label: s.label,
    locator: s.locator,
    enabled: s.enabled,
    kindEnabled: s.kindEnabled,
    completeList: s.completeList,
    origin: s.origin,
    lastRunAt: iso(s.lastRunAt),
    lastCount: s.lastCount ?? null,
    lastComplete: s.lastComplete ?? null,
    lastNote: s.lastNote ?? null,
    resolved: s.resolved ?? null,
    stats: stats(s.stats),
  };
}

function runSourceLine(s: SearchRun['sources'][number]): string {
  if (s.error) return `failed: ${s.error}`;
  const parts = [
    `${s.listed} listed`,
    `${s.matched} matched`,
    `${s.added} new`,
    ...(s.attached ? [`${s.attached} known`] : []),
    s.complete ? 'complete list' : 'partial list',
    ...(s.closed ? [`${s.closed} closed`] : []),
    ...(s.reopened ? [`${s.reopened} reopened`] : []),
    ...(s.reverify ? [`${s.reverify} to re-verify`] : []),
  ];
  return parts.join(' · ');
}

export function runLines(r: SearchRun): string[] {
  const lines = [
    `Run ${r.id} · ${r.strategyName} · ${r.trigger} · ${r.status} · ${when(r.startedAt)}${r.note ? ` · ${r.note}` : ''}`,
  ];
  const width = Math.max(0, ...r.sources.map((s) => s.sourceKey.length));
  for (const s of r.sources) lines.push(`  ${s.sourceKey.padEnd(width)}  ${runSourceLine(s)}`);
  return lines;
}

function strategyLines(s: SearchStrategy): string[] {
  const st = s.stats;
  return [
    `Strategy ${s.id} · ${s.name} · ${s.state}${s.origin === 'agent' ? ' · agent-generated' : ''}${s.running ? ' · running' : ''}`,
    `Queries      ${s.queries.length ? s.queries.map((q) => `"${q}"`).join(', ') : '(every listing)'}`,
    `Locations    ${s.locations.length ? s.locations.join(', ') : '(anywhere)'}`,
    `Sources      ${s.sources.join(', ')}  →  ${s.sourceKeys.length ? s.sourceKeys.join(', ') : 'none switched on'}`,
    `Schedule     every ${formatEvery(s.everyMinutes)} · last run ${when(s.lastRunAt)} · next ${s.state === 'paused' ? '(paused)' : when(s.nextRunAt)}`,
    `Results      ${st?.found ?? 0} found · ${st?.verified ?? 0} verified · ${interestedText(st)} interested · ${st?.skipped ?? 0} skipped`,
  ];
}

export function registerSearch(program: Command, client: () => ApplyantClient): void {
  const search = program
    .command('search')
    .description('search strategies, the sources they read, and their runs');

  // ---- strategies ----
  const strategies = search
    .command('strategies')
    .description('what is searched, where and how often');

  strategies
    .command('list', { isDefault: true })
    .description('every strategy with its schedule and found / verified / interested counts')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listSearch({});
      if (opts.json) return json(res.strategies.map(strategyJson));
      if (res.strategies.length === 0) {
        return out(
          'No search strategies yet. Add one, e.g.\n  applyant search strategies add "AI Engineer · Remote EU" --query "ai engineer" --query "llm engineer" --location remote --sources greenhouse,ashby,lever,board --every 6h',
        );
      }
      out(
        table(
          [
            'ID',
            'NAME',
            'STATE',
            'EVERY',
            'LAST RUN',
            'FOUND',
            'VERIFIED',
            'INTERESTED',
            'SOURCES',
          ],
          res.strategies.map((s) => [
            String(s.id),
            truncate(s.name, 32),
            s.state + (s.running ? '*' : '') + (s.origin === 'agent' ? ' (agent)' : ''),
            formatEvery(s.everyMinutes),
            when(s.lastRunAt),
            String(s.stats?.found ?? 0),
            String(s.stats?.verified ?? 0),
            interestedText(s.stats),
            truncate(s.sourceKeys.join(', ') || '(none on)', 60),
          ]),
        ),
      );
      if (res.strategies.some((s) => s.running)) out('* a run is waiting or running');
    });

  strategies
    .command('show <strategy>')
    .description('one strategy and its recent runs')
    .option('-n, --runs <n>', 'how many runs', '5')
    .option('--json', 'print JSON')
    .action(async (ref: string, opts: { runs: string; json?: boolean }) => {
      const c = client();
      const res = await c.listSearch({});
      const s = res.strategies.find((x) => String(x.id) === ref || x.name === ref);
      if (!s) throw new Error(`no search strategy "${ref}"`);
      const runs = await c.listSearchRuns({
        strategy: String(s.id),
        limit: Number(opts.runs) || 5,
      });
      if (opts.json) return json({ ...strategyJson(s), runs: runs.runs.map(runJson) });
      for (const line of strategyLines(s)) out(line);
      if (runs.runs.length) {
        out('');
        for (const r of runs.runs) for (const line of runLines(r)) out(line);
      }
    });

  strategies
    .command('add <name>')
    .description('add a strategy; it runs right away, then on its schedule')
    .option(
      '-q, --query <phrase>',
      'title words to look for (repeatable; "-word" excludes)',
      collect,
      [],
    )
    .option(
      '-l, --location <place>',
      'where (repeatable; "remote" matches remote jobs)',
      collect,
      [],
    )
    .option(
      '-s, --sources <list>',
      'comma-separated: all, a kind (greenhouse, ashby, lever, workable, page, board) or source keys (board:hn)',
      'all',
    )
    .option('-e, --every <interval>', 'how often: 6h, 90m, 1d', '6h')
    .option('--paused', "add it paused (it doesn't run until resumed)")
    .option('--json', 'print JSON')
    .action(
      async (
        name: string,
        opts: {
          query: string[];
          location: string[];
          sources: string;
          every: string;
          paused?: boolean;
          json?: boolean;
        },
      ) => {
        const res = await client().addStrategy({
          name,
          queries: opts.query,
          locations: opts.location,
          sources: list(opts.sources),
          everyMinutes: everyMinutes(opts.every),
          paused: !!opts.paused,
        });
        const s = res.strategy;
        if (!s) throw new Error('daemon returned no strategy');
        if (opts.json)
          return json({
            ...strategyJson(s),
            runId: res.runId === undefined ? null : Number(res.runId),
          });
        out(`Added strategy ${s.id} "${s.name}".`);
        for (const line of strategyLines(s).slice(1)) out(line);
        out(
          res.runId !== undefined
            ? `Running now as run ${res.runId} (\`applyant runs show ${res.runId} --follow\`).`
            : 'Paused: `applyant search strategies resume` starts it.',
        );
      },
    );

  strategies
    .command('edit <strategy>')
    .description('change a strategy (only what you pass)')
    .option('--name <name>', 'rename it')
    .option('-q, --query <phrase>', 'replace the queries (repeatable)', collect, [])
    .option('--no-queries', 'clear the queries (every listing matches)')
    .option('-l, --location <place>', 'replace the locations (repeatable)', collect, [])
    .option('--no-locations', 'clear the locations (anywhere)')
    .option('-s, --sources <list>', 'replace the sources (comma-separated)')
    .option('-e, --every <interval>', 'how often: 6h, 90m, 1d')
    .option('--json', 'print JSON')
    .action(
      async (
        ref: string,
        opts: {
          name?: string;
          query: string[];
          queries: boolean;
          location: string[];
          locations: boolean;
          sources?: string;
          every?: string;
          json?: boolean;
        },
      ) => {
        const res = await client().updateStrategy({
          strategy: ref,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.query.length
            ? { queries: { values: opts.query } }
            : !opts.queries
              ? { queries: { values: [] } }
              : {}),
          ...(opts.location.length
            ? { locations: { values: opts.location } }
            : !opts.locations
              ? { locations: { values: [] } }
              : {}),
          ...(opts.sources !== undefined ? { sources: { values: list(opts.sources) } } : {}),
          ...(opts.every !== undefined ? { everyMinutes: everyMinutes(opts.every) } : {}),
        });
        const s = res.strategy;
        if (!s) throw new Error('daemon returned no strategy');
        if (opts.json) return json(strategyJson(s));
        for (const line of strategyLines(s)) out(line);
      },
    );

  for (const [verb, state, done] of [
    ['pause', 'paused', 'Paused'],
    ['resume', 'active', 'Resumed'],
  ] as const) {
    strategies
      .command(`${verb} <strategy>`)
      .description(
        verb === 'pause' ? 'stop running it on its schedule' : 'run it on its schedule again',
      )
      .action(async (ref: string) => {
        const res = await client().updateStrategy({ strategy: ref, state });
        const s = res.strategy;
        out(
          `${done} strategy ${s?.id} "${s?.name}".${state === 'active' && s ? ` Next run ${when(s.nextRunAt)}.` : ''}`,
        );
      });
  }

  strategies
    .command('run <strategy>')
    .description('run it now, outside its schedule')
    .action(async (ref: string) => {
      const res = await client().runStrategy({ strategy: ref });
      out(
        res.runId !== undefined
          ? `Running "${res.strategy?.name}" as run ${res.runId} (\`applyant runs show ${res.runId} --follow\`).`
          : `"${res.strategy?.name}" already has a run waiting or running.`,
      );
    });

  strategies
    .command('delete <strategy>')
    .description('delete a strategy (the postings it found stay)')
    .action(async (ref: string) => {
      await client().deleteStrategy({ strategy: ref });
      out(`Deleted strategy "${ref}".`);
    });

  // ---- sources ----
  const sources = search
    .command('sources')
    .description('where postings are listed; each can be switched off');

  sources
    .command('list', { isDefault: true })
    .description('every source and kind, on or off, with found / verified / interested counts')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listSearch({});
      if (opts.json) {
        return json({
          kinds: res.kinds.map((k) => ({
            kind: k.kind,
            label: k.label,
            enabled: k.enabled,
            sources: k.sources,
          })),
          sources: res.sources.map(sourceJson),
        });
      }
      out(
        `Kinds: ${res.kinds.map((k) => `${k.kind} ${k.enabled ? 'on' : 'OFF'} (${k.sources})`).join(' · ')}`,
      );
      out('');
      out(
        table(
          ['KEY', 'LABEL', 'ON', 'LIST', 'LAST READ', 'FOUND', 'VERIFIED', 'INTERESTED', 'NOTE'],
          res.sources.map((s) => [
            truncate(s.key, 48),
            truncate(s.label, 28),
            s.enabled && s.kindEnabled ? 'on' : s.enabled ? 'off (kind)' : 'off',
            s.completeList ? 'complete' : 'partial',
            when(s.lastRunAt),
            String(s.stats?.found ?? 0),
            String(s.stats?.verified ?? 0),
            interestedText(s.stats),
            truncate(s.lastNote ?? s.resolved ?? '', 70),
          ]),
        ),
      );
    });

  sources
    .command('add <what> [locator]')
    .description(
      'add a company board (`greenhouse gitlab`, `lever acme`, `ashby acme`, `workable acme`) or a career page / feed URL',
    )
    .option('--label <label>', 'how it is shown (the company name)')
    .option('--json', 'print JSON')
    .action(
      async (
        what: string,
        locator: string | undefined,
        opts: { label?: string; json?: boolean },
      ) => {
        const res = await client().addSearchSource({
          kind: locator === undefined ? '' : what,
          locator: locator ?? what,
          ...(opts.label ? { label: opts.label } : {}),
        });
        const s = res.source;
        if (!s) throw new Error('daemon returned no source');
        if (opts.json) return json({ created: res.created, source: sourceJson(s) });
        out(
          `${res.created ? 'Added' : 'Already there:'} ${s.key} (${s.label}). Strategies that select "${s.kind}", "${s.key}" or "all" read it from their next run.`,
        );
      },
    );

  for (const [verb, enabled] of [
    ['off', false],
    ['on', true],
  ] as const) {
    sources
      .command(`${verb} <source>`)
      .description(
        enabled
          ? 'switch a source (key, e.g. board:hn) or a whole kind (greenhouse, board, …) back on'
          : 'switch a source (key, e.g. board:hn) or a whole kind (greenhouse, board, …) off: it is never queried',
      )
      .action(async (target: string) => {
        const res = await client().setSearchSourceEnabled({ target, enabled });
        if (res.kind) {
          out(
            `${res.kind.label} (${res.kind.kind}, ${res.kind.sources} sources) switched ${verb}.`,
          );
        } else {
          for (const s of res.sources) out(`${s.key} switched ${verb}.`);
        }
      });
  }

  // ---- runs ----
  search
    .command('runs')
    .description('recent search runs, with what every source gave')
    .option('--strategy <strategy>', 'only this strategy (id or name)')
    .option('-n, --limit <n>', 'how many', '10')
    .option('--json', 'print JSON')
    .action(async (opts: { strategy?: string; limit: string; json?: boolean }) => {
      const res = await client().listSearchRuns({
        ...(opts.strategy ? { strategy: opts.strategy } : {}),
        limit: Number(opts.limit) || 10,
      });
      if (opts.json) return json(res.runs.map(runJson));
      if (res.runs.length === 0) return out('No search runs yet.');
      for (const r of res.runs) for (const line of runLines(r)) out(line);
      out('');
      out("Each run's tasks and events: `applyant runs show <run>`.");
    });
}
