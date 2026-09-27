#!/usr/bin/env node
// applyantd: the composition root. Opens the database, starts the queue worker, the reader
// browser and the Connect server, then writes {port, token} for clients.
import { randomBytes } from 'node:crypto';
import { ReaderPool } from './browser/reader-pool.ts';
import { type Config, loadConfig } from './config.ts';
import { closeDb, openDb, openReadDb } from './db/client.ts';
import { ReadPool } from './db/read-pool.ts';
import { agentRuns } from './db/schema.ts';
import type { Deps } from './deps.ts';
import { embedFacts, ensureFactIndex } from './domain/knowledge/embed-index.ts';
import { syncSource } from './domain/knowledge/sync.ts';
import { NodeTextExtractor } from './domain/knowledge/text/extract.ts';
import { EcbFx } from './domain/scoring/fx.ts';
import { scorePosting } from './domain/scoring/handlers.ts';
import { requestScoring, unscoredPostings } from './domain/scoring/store.ts';
import { verifyPosting } from './domain/search/verify.ts';
import { isAlive, readEndpoint, removeEndpoint, writeEndpoint } from './endpoint.ts';
import { AgentRunner } from './models/agent-runner.ts';
import { type Embedder, GemmaEmbedder, HashEmbedder } from './models/embeddings.ts';
import { ClaudeProvider } from './models/providers/claude.ts';
import { EventBus } from './queue/events.ts';
import type { Handlers } from './queue/types.ts';
import { Worker } from './queue/worker.ts';
import { startRpcServer } from './rpc/server.ts';
import { FileSecrets } from './secrets/file-backend.ts';
import { ensurePrivateDir } from './util/fs.ts';
import { createLogger } from './util/log.ts';

export async function runDaemon(config: Config = loadConfig()): Promise<() => Promise<void>> {
  const log = createLogger({ svc: 'applyantd' });
  // The database, files and logs are personal data: nothing the daemon creates is group/world readable.
  process.umask(0o077);
  ensurePrivateDir(config.home);
  ensurePrivateDir(config.filesDir);

  const running = readEndpoint(config.endpointFile);
  if (running && running.pid !== process.pid && isAlive(running.pid)) {
    throw new Error(`applyantd is already running (pid ${running.pid}) for ${config.home}`);
  }

  const db = openDb(config.dbPath);
  const read = openReadDb(config.dbPath);
  const bus = new EventBus();
  const secrets = new FileSecrets(config.secretsFile);
  const reader = new ReaderPool({ ...config.reader, log: log.child({ part: 'reader' }) });
  const models = new AgentRunner({
    providers: [new ClaudeProvider()],
    runsDir: config.runsDir,
    workDir: config.workDir,
    // Run bookkeeping is the runner's own short write, like task progress events;
    // handlers still never hold a write handle.
    record: (row) => {
      db.insert(agentRuns).values(row).run();
    },
    log: log.child({ part: 'models' }),
  });
  const embedder: Embedder =
    config.embedder === 'hash'
      ? new HashEmbedder()
      : new GemmaEmbedder({ cacheDir: config.modelsDir, log: log.child({ part: 'embeddings' }) });
  const readPool = new ReadPool({
    path: config.dbPath,
    size: config.readWorkers,
    log: log.child({ part: 'read-pool' }),
  });
  const deps: Deps = {
    reader,
    secrets,
    models,
    embedder,
    readPool,
    fx: new EcbFx(),
    text: new NodeTextExtractor(),
    dirs: { repos: config.reposDir },
    log,
  };
  const handlers: Handlers = {
    verify_posting: verifyPosting,
    score_posting: scorePosting,
    sync_source: syncSource,
    embed_facts: embedFacts,
  };

  // Catch up: vectors for facts that have none (or were made by another embedder), and a
  // score for postings verified before scoring existed.
  ensureFactIndex(db, bus, embedder.id, new Date());
  const unscored = unscoredPostings(db);
  if (unscored.length) requestScoring(db, bus, unscored, new Date());

  const worker = new Worker({
    db,
    read,
    bus,
    handlers,
    deps,
    log: log.child({ part: 'worker' }),
    ...config.worker,
  });
  worker.start();

  const token = randomBytes(32).toString('base64url');
  const rpc = await startRpcServer({
    db,
    bus,
    secrets,
    now: () => new Date(),
    token,
    host: config.host,
    port: config.port,
    log,
  });
  writeEndpoint(config.endpointFile, {
    version: 1,
    host: config.host,
    port: rpc.port,
    token,
    pid: process.pid,
  });
  log.info('applyantd started', { home: config.home, pid: process.pid, worker: worker.owner });

  let stopping: Promise<void> | null = null;
  return () => {
    stopping ??= (async () => {
      log.info('applyantd stopping');
      removeEndpoint(config.endpointFile, process.pid);
      await rpc.close();
      await worker.stop();
      await reader.close();
      await readPool.close();
      await embedder.close?.();
      closeDb(read);
      closeDb(db);
      log.info('applyantd stopped');
    })();
    return stopping;
  };
}

if (import.meta.main) {
  runDaemon().then(
    (stop) => {
      const shutdown = () => {
        stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
    (err) => {
      createLogger({ svc: 'applyantd' }).error('applyantd failed to start', { err });
      process.exit(1);
    },
  );
}
