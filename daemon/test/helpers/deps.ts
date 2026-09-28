// Handler dependencies for tests: a fake model provider, file secrets and quiet logs under a
// temp dir. Anything a test cares about is passed in.
import { join } from 'node:path';
import type { ReaderPool } from '../../src/browser/reader-pool.ts';
import { SubmitProfile } from '../../src/browser/submit-profile.ts';
import { TaskPages } from '../../src/browser/task-pages.ts';
import type { Channel } from '../../src/channels/channel.ts';
import type { Db, ReadDb } from '../../src/db/client.ts';
import { directExec, type ReadExec } from '../../src/db/read-pool.ts';
import { agentRuns } from '../../src/db/schema.ts';
import type { Deps } from '../../src/deps.ts';
import type { GithubApi } from '../../src/domain/knowledge/sources/github.ts';
import { NodeTextExtractor } from '../../src/domain/knowledge/text/extract.ts';
import type { FxRates, FxSource } from '../../src/domain/scoring/fx.ts';
import type { McpAccess } from '../../src/mcp/server.ts';
import {
  AgentRunner,
  type AgentRunnerOptions,
  type ModelProvider,
} from '../../src/models/agent-runner.ts';
import { type Embedder, HashEmbedder } from '../../src/models/embeddings.ts';
import { FakeProvider } from '../../src/models/providers/fake.ts';
import type { Handler, Handlers } from '../../src/queue/types.ts';
import { FileSecrets } from '../../src/secrets/file-backend.ts';
import { createLogger, type Logger } from '../../src/util/log.ts';

const base = createLogger({ test: true });
export const quietLog: Logger = {
  ...base,
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => quietLog,
};

export interface TestDepsOptions {
  dir: string;
  /** Where agent runs are recorded; omitted = not recorded. */
  db?: Db;
  providers?: ModelProvider[];
  reader?: ReaderPool;
  now?: () => Date;
  github?: GithubApi | null;
  embedder?: Embedder;
  /** Read connection for retrieval (run in this thread); a pool can be passed instead. */
  read?: ReadDb;
  readPool?: ReadExec;
  fx?: FxSource;
  jev?: AgentRunnerOptions['jev'];
  mcp?: McpAccess | null;
  submit?: SubmitProfile;
  taskPages?: TaskPages;
  channels?: Record<string, Channel>;
}

/** Fixed reference rates (no network). */
export const TEST_RATES: FxRates = {
  asOf: '2026-09-25',
  perEur: { EUR: 1, USD: 1.1, GBP: 0.85, CHF: 0.95 },
};

export const fixedFx = (rates: FxRates = TEST_RATES): FxSource & { calls: number } => {
  const fx = {
    calls: 0,
    async fetch() {
      fx.calls++;
      return rates;
    },
  };
  return fx;
};

export function testRunner(o: TestDepsOptions): AgentRunner {
  return new AgentRunner({
    providers: o.providers ?? [new FakeProvider('claude')],
    runsDir: join(o.dir, 'files', 'runs'),
    workDir: join(o.dir, 'files', 'work'),
    record: (row) => {
      o.db?.insert(agentRuns).values(row).run();
    },
    log: quietLog,
    ...(o.now ? { now: o.now } : {}),
    ...(o.jev ? { jev: o.jev } : {}),
  });
}

export function testDeps(o: TestDepsOptions): Deps {
  return {
    reader: o.reader ?? ({} as ReaderPool),
    submit: o.submit ?? new SubmitProfile({ userDataDir: join(o.dir, 'browser'), log: quietLog }),
    taskPages: o.taskPages ?? new TaskPages(),
    channels: o.channels ?? {},
    secrets: new FileSecrets(join(o.dir, 'secrets.json')),
    models: testRunner(o),
    embedder: o.embedder ?? new HashEmbedder(),
    readPool:
      o.readPool ??
      (o.read
        ? directExec(o.read)
        : {
            all: async () => {
              throw new Error('no read connection in this test');
            },
          }),
    fx: o.fx ?? fixedFx(),
    mcp: o.mcp ?? null,
    text: new NodeTextExtractor(),
    dirs: { repos: join(o.dir, 'repos'), files: join(o.dir, 'files') },
    log: quietLog,
    ...(o.github !== undefined ? { github: o.github } : {}),
  };
}

const never: Handler<never> = async () => {
  throw new Error('no handler in this test');
};

/** A full handler map where only the given handlers do anything. */
export function handlers(partial: Partial<Handlers>): Handlers {
  return {
    verify_posting: never as Handler<'verify_posting'>,
    score_posting: never as Handler<'score_posting'>,
    read_form: never as Handler<'read_form'>,
    sync_source: never as Handler<'sync_source'>,
    embed_facts: never as Handler<'embed_facts'>,
    prepare_application: never as Handler<'prepare_application'>,
    deliver_application: never as Handler<'deliver_application'>,
    ...partial,
  };
}
