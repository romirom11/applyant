#!/usr/bin/env node
// applyantd: the composition root. Opens the database, starts the queue worker, the reader
// browser and the Connect server, then writes {port, token} for clients.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { installReaderBrowser } from './browser/install.ts';
import { ReaderPool } from './browser/reader-pool.ts';
import { SubmitProfile } from './browser/submit-profile.ts';
import { TaskPages } from './browser/task-pages.ts';
import { EmailChannel } from './channels/email.ts';
import { WebFormChannel } from './channels/web-form.ts';
import { type Config, loadConfig } from './config.ts';
import { closeDb, openDb, openReadDb } from './db/client.ts';
import { ReadPool } from './db/read-pool.ts';
import { agentRuns } from './db/schema.ts';
import type { Deps } from './deps.ts';
import { catchUpDeliveries, deliverApplication } from './domain/applications/deliver.ts';
import { requestMailSync, syncMail } from './domain/applications/mail-status.ts';
import { prepareApplication } from './domain/applications/prepare.ts';
import { readFormHandler, requestFormRead } from './domain/applications/read-form.ts';
import { catchUpApplications } from './domain/applications/store.ts';
import { researchCompany } from './domain/companies/research.ts';
import { embedFacts, ensureFactIndex } from './domain/knowledge/embed-index.ts';
import { interviewOpen, interviewTurn } from './domain/knowledge/interview-agent.ts';
import { syncSource } from './domain/knowledge/sync.ts';
import { NativeTextExtractor, NodeTextExtractor } from './domain/knowledge/text/extract.ts';
import { EcbFx } from './domain/scoring/fx.ts';
import { scorePosting } from './domain/scoring/handlers.ts';
import { getPreferences } from './domain/scoring/prefs.ts';
import { requestScoring, unscoredPostings } from './domain/scoring/store.ts';
import { searchHandler } from './domain/search/handlers.ts';
import { planSearch } from './domain/search/planner.ts';
import { buildRecipe } from './domain/search/recipes/build.ts';
import { ensureBuiltinSources } from './domain/search/sources.ts';
import { verifyPosting } from './domain/search/verify.ts';
import { isAlive, readEndpoint, removeEndpoint, writeEndpoint } from './endpoint.ts';
import { MailService } from './integrations/mail-service.ts';
import { McpHub } from './mcp/server.ts';
import { browserTools } from './mcp/tools/browser.ts';
import { knowledgeTools } from './mcp/tools/knowledge.ts';
import { AgentRunner } from './models/agent-runner.ts';
import { defaultCliPaths } from './models/cli-paths.ts';
import { CliStatus } from './models/cli-status.ts';
import { type Embedder, GemmaEmbedder, HashEmbedder } from './models/embeddings.ts';
import { AppleProvider } from './models/providers/apple.ts';
import { ClaudeProvider, claudeEnv } from './models/providers/claude.ts';
import { CodexProvider, codexEnv } from './models/providers/codex.ts';
import { JevClient } from './models/providers/jev.ts';
import { loadRouting } from './models/roles.ts';
import { openNative } from './native/client.ts';
import { EventBus } from './queue/events.ts';
import { Scheduler } from './queue/scheduler.ts';
import { runInTx } from './queue/tx.ts';
import type { Handlers } from './queue/types.ts';
import { Worker } from './queue/worker.ts';
import { startRpcServer } from './rpc/server.ts';
import { openSecrets } from './secrets/keychain-backend.ts';
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

  const startedAt = new Date();
  const db = openDb(config.dbPath);
  const read = openReadDb(config.dbPath);
  const bus = new EventBus();
  // applyant-native (macOS): Keychain, PDFKit text, wake events. A stub elsewhere.
  const native = openNative({ path: config.nativeHelperPath, log: log.child({ part: 'native' }) });
  const secrets = await openSecrets({ native, secretsFile: config.secretsFile, log });
  // A launchd agent has no shell PATH: start looking for the agent CLIs now (the login-shell
  // probe, if one is needed, runs once here), so tasks rarely wait for it.
  const cliPaths = defaultCliPaths();
  void cliPaths.start();
  const cli = new CliStatus({ paths: cliPaths });
  const reader = new ReaderPool({
    ...config.reader,
    log: log.child({ part: 'reader' }),
    ...(config.installBrowsers
      ? { ready: installReaderBrowser(log.child({ part: 'reader' })) }
      : {}),
  });
  const models = new AgentRunner({
    providers: [
      new ClaudeProvider({
        resolvePath: () => cliPaths.require('claude'),
        env: (path) => claudeEnv({ ...process.env, PATH: cliPaths.childPath(path) }),
      }),
      new CodexProvider({
        resolvePath: () => cliPaths.require('codex'),
        env: (path) => codexEnv({ ...process.env, PATH: cliPaths.childPath(path) }),
      }),
      // On-device email_classify (Foundation Models), only where the helper runs. Without it
      // `apple` has no fallback, so mail is asked about rather than sent to a cloud model.
      ...(native.available ? [new AppleProvider(native)] : []),
    ],
    // The candidate's routing (`applyant config roles`), read for every run.
    routing: () => loadRouting(read),
    // Decision roles ask Jev when its key is stored (`applyant secrets set jev`).
    jev: new JevClient({ secrets, ...(config.jevUrl ? { url: config.jevUrl } : {}) }),
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
  // The submission browser (phase 6): one persistent Chrome profile, deliveries serialised.
  const submit = new SubmitProfile({
    userDataDir: config.browserDir,
    log: log.child({ part: 'submit' }),
  });
  const taskPages = new TaskPages();
  // Tools for agent runs (the writer's knowledge lookups, the form agent's browser control),
  // on 127.0.0.1 behind per-task tokens.
  const mcp = new McpHub({
    tools: [...knowledgeTools({ read, readPool, embedder }), ...browserTools(taskPages)],
    log: log.child({ part: 'mcp' }),
  });
  await mcp.start();
  // The mailbox (phase 13): Gmail (Google consent) or IMAP/SMTP, credentials in Secrets.
  const g = config.google;
  const mail = new MailService({
    read,
    secrets,
    google: {
      clientId: g.clientId,
      clientSecret: g.clientSecret,
      ...(g.authUrl ? { authUrl: g.authUrl } : {}),
      ...(g.tokenUrl ? { tokenUrl: g.tokenUrl } : {}),
      ...(g.gmailApi ? { gmailApi: g.gmailApi } : {}),
    },
    sinceDays: config.mail.sinceDays,
  });
  const deps: Deps = {
    reader,
    submit,
    taskPages,
    channels: {
      web_form: new WebFormChannel({
        reader,
        submit,
        taskPages,
        models,
        mcp,
        snapshotsDir: join(config.filesDir, 'handoffs'),
      }),
      email: new EmailChannel({ mail, sentDir: join(config.filesDir, 'sent') }),
    },
    secrets,
    mail,
    models,
    embedder,
    readPool,
    mcp,
    fx: new EcbFx(),
    text: new NativeTextExtractor(native, new NodeTextExtractor(), log.child({ part: 'text' })),
    dirs: { repos: config.reposDir, files: config.filesDir, cvTemplate: config.cvTemplateDir },
    log,
  };
  const handlers: Handlers = {
    verify_posting: verifyPosting,
    score_posting: scorePosting,
    read_form: readFormHandler,
    prepare_application: prepareApplication,
    deliver_application: deliverApplication,
    sync_source: syncSource,
    embed_facts: embedFacts,
    interview_open: interviewOpen,
    interview_turn: interviewTurn,
    search: searchHandler,
    build_recipe: buildRecipe,
    plan_search: planSearch,
    research_company: researchCompany,
    sync_mail: syncMail,
  };

  // Catch up: vectors for facts that have none (or were made by another embedder), and a
  // score for postings verified before scoring existed.
  ensureFactIndex(db, bus, embedder.id, new Date());
  const unscored = unscoredPostings(db);
  if (unscored.length) requestScoring(db, bus, unscored, new Date());
  // …and a read of the application form for live postings verified before Read existed.
  requestFormRead(db, bus, [], new Date());
  // …and an application for postings that qualified before applications existed.
  runInTx(db, bus, { now: new Date() }, (tx) =>
    catchUpApplications(tx, getPreferences(tx.db).threshold),
  );
  // …and delivery for an approved application that never got one (a restart mid-delivery).
  runInTx(db, bus, { now: new Date() }, (tx) => catchUpDeliveries(tx));

  // Search (phase 10): the built-in boards are sources from the start; the scheduler starts
  // each strategy's runs when they're due.
  ensureBuiltinSources(db, new Date());
  const scheduler = new Scheduler({
    db,
    bus,
    log: log.child({ part: 'scheduler' }),
    intervalMs: config.schedulerMs,
  });

  // Sleep/wake (macOS): logged, put on the event stream, and every search strategy whose time
  // came while the Mac slept runs now, once.
  native.onEvent((e) => {
    if (e.event !== 'wake') return;
    log.info('the Mac woke from sleep');
    runInTx(db, bus, { now: new Date() }, (tx) =>
      tx.emit({ kind: 'system.wake', message: 'the Mac woke from sleep' }),
    );
    scheduler.tick('wake');
  });

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
  scheduler.start();
  // Replies: the connected mailbox is read every few minutes (and once now).
  const syncMailNow = () => {
    try {
      requestMailSync(db, bus, new Date());
    } catch (err) {
      log.warn('mail sync not queued', { err });
    }
  };
  syncMailNow();
  const mailTimer = setInterval(syncMailNow, config.mail.syncMs);
  mailTimer.unref();

  const token = randomBytes(32).toString('base64url');
  const rpc = await startRpcServer({
    db,
    bus,
    secrets,
    setup: { cli, native, secrets, home: config.home, startedAt },
    mail,
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
      clearInterval(mailTimer);
      scheduler.stop();
      await worker.stop();
      await mcp.close();
      await submit.close();
      await reader.close();
      await readPool.close();
      await native.close();
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
