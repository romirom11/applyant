#!/usr/bin/env node
// applyantd: the composition root. Opens the database, starts the queue worker, the reader
// browser and the Connect server, then writes {port, token} for clients.
import { randomBytes } from 'node:crypto';
import { ReaderPool } from './browser/reader-pool.ts';
import { type Config, loadConfig } from './config.ts';
import { closeDb, openDb, openReadDb } from './db/client.ts';
import type { Deps } from './deps.ts';
import { verifyPosting } from './domain/search/verify.ts';
import { isAlive, readEndpoint, removeEndpoint, writeEndpoint } from './endpoint.ts';
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
  const deps: Deps = { reader, secrets, log };
  const handlers: Handlers = { verify_posting: verifyPosting };

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
