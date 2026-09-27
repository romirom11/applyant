// Handler dependencies for tests: a fake model provider, file secrets and quiet logs under a
// temp dir. Anything a test cares about is passed in.
import { join } from 'node:path';
import type { ReaderPool } from '../../src/browser/reader-pool.ts';
import type { Db } from '../../src/db/client.ts';
import { agentRuns } from '../../src/db/schema.ts';
import type { Deps } from '../../src/deps.ts';
import type { GithubApi } from '../../src/domain/knowledge/sources/github.ts';
import { NodeTextExtractor } from '../../src/domain/knowledge/text/extract.ts';
import { AgentRunner, type ModelProvider } from '../../src/models/agent-runner.ts';
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
}

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
  });
}

export function testDeps(o: TestDepsOptions): Deps {
  return {
    reader: o.reader ?? ({} as ReaderPool),
    secrets: new FileSecrets(join(o.dir, 'secrets.json')),
    models: testRunner(o),
    text: new NodeTextExtractor(),
    dirs: { repos: join(o.dir, 'repos') },
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
    sync_source: never as Handler<'sync_source'>,
    ...partial,
  };
}
