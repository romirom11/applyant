#!/usr/bin/env node
// applyant: a thin client. Every command is one or two RPCs to applyantd.
import { Command } from 'commander';
import { registerCandidate } from './candidate.ts';
import { type ApplyantClient, connect, describeError } from './client.ts';
import {
  eventJson,
  eventLine,
  parseStage,
  postingJson,
  stageName,
  table,
  truncate,
} from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`"${value}" is not an id`);
  return n;
}

async function readSecretValue(name: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  // Interactive: read one line without echoing it.
  stderr.write(`Value for ${name}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

export function buildCli(client: () => ApplyantClient): Command {
  const program = new Command('applyant')
    .description('Applyant: your job-search harness (talks to applyantd)')
    .showHelpAfterError();

  const jobs = program.command('jobs').description('postings');

  jobs
    .command('add <url>')
    .description('add a posting by URL; it is verified in the background')
    .option('--json', 'print JSON')
    .action(async (url: string, opts: { json?: boolean }) => {
      const res = await client().addPosting({ url });
      const p = res.posting;
      if (!p) throw new Error('daemon returned no posting');
      if (opts.json) return json({ created: res.created, posting: postingJson(p) });
      out(
        res.created
          ? `Added posting ${p.id} (${stageName(p.stage)}), verifying: ${p.canonicalUrl}`
          : `Already known as posting ${p.id} (${stageName(p.stage)}): ${p.canonicalUrl}`,
      );
    });

  jobs
    .command('list')
    .description('list postings, newest first')
    .option('--stage <stage>', 'only this stage (found | verified | failed_verification)')
    .option('--json', 'print JSON')
    .action(async (opts: { stage?: string; json?: boolean }) => {
      const stage = opts.stage ? parseStage(opts.stage) : undefined;
      const res = await client().listPostings(stage === undefined ? {} : { stage });
      if (opts.json) return json(res.postings.map(postingJson));
      if (res.postings.length === 0)
        return out('No postings yet. Add one with `applyant jobs add <url>`.');
      out(
        table(
          ['ID', 'STAGE', 'COMPANY', 'TITLE', 'URL'],
          res.postings.map((p) => [
            String(p.id),
            stageName(p.stage),
            truncate(p.company ?? '', 24),
            truncate(p.title ?? '', 48),
            p.canonicalUrl,
          ]),
        ),
      );
    });

  jobs
    .command('show <id>')
    .description('show one posting')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { json?: boolean }) => {
      const id = positiveInt(idArg);
      const res = await client().getPosting({ id: BigInt(id) });
      const p = res.posting;
      if (!p) throw new Error(`posting ${id} not found`);
      const j = postingJson(p);
      if (opts.json) return json(j);
      out(`${j.title ?? '(untitled)'}${j.company ? ` · ${j.company}` : ''}`);
      out(`Posting ${j.id} · ${j.stage}`);
      out(`URL          ${j.canonicalUrl}`);
      out(`First seen   ${j.firstSeenAt ?? '-'}`);
      out(`Verified     ${j.verifiedAt ? `${j.verifiedAt} · ${j.verifyNote ?? ''}` : '-'}`);
      out('Sources');
      for (const s of j.sources) out(`  ${s.kind.padEnd(8)} ${s.url}`);
    });

  registerCandidate(program, client);

  const runs = program.command('runs').description('task activity');
  runs
    .command('show [run]')
    .description('show task events (of one run, or all); --follow streams new ones')
    .option('-f, --follow', 'keep streaming new events')
    .option('--posting <id>', 'only events about this posting')
    .option('-n, --limit <n>', 'how many past events to print', '50')
    .option('--json', 'print JSON lines')
    .action(
      async (
        runArg: string | undefined,
        opts: { follow?: boolean; posting?: string; limit: string; json?: boolean },
      ) => {
        const c = client();
        const filter = {
          ...(runArg ? { runId: BigInt(positiveInt(runArg)) } : {}),
          ...(opts.posting ? { postingId: BigInt(positiveInt(opts.posting)) } : {}),
        };
        const print = (e: Parameters<typeof eventLine>[0]) =>
          out(opts.json ? JSON.stringify(eventJson(e)) : eventLine(e));
        const past = await c.listEvents({ ...filter, limit: positiveInt(opts.limit) });
        for (const e of past.events) print(e);
        if (!opts.follow) return;
        const last = past.events.at(-1)?.id ?? 0n;
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          for await (const res of c.watchEvents(
            { ...filter, afterEventId: last },
            { signal: ac.signal },
          )) {
            if (res.event) print(res.event);
          }
        } catch (err) {
          if (!ac.signal.aborted) throw err;
        }
      },
    );

  const secrets = program
    .command('secrets')
    .description('API keys and tokens (values are write-only)');
  secrets
    .command('set <name>')
    .description('store a secret; the value is read from stdin (or prompted, without echo)')
    .action(async (name: string) => {
      const value = await readSecretValue(name);
      if (!value) throw new Error('empty value, nothing stored');
      await client().setSecret({ name, value });
      out(`Stored secret "${name}".`);
    });
  secrets
    .command('list')
    .description('list secret names')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listSecrets({});
      if (opts.json) return json(res.names);
      out(res.names.length ? res.names.join('\n') : 'No secrets stored.');
    });
  secrets
    .command('delete <name>')
    .description('delete a secret')
    .action(async (name: string) => {
      const res = await client().deleteSecret({ name });
      out(res.deleted ? `Deleted secret "${name}".` : `No secret named "${name}".`);
    });

  return program;
}

if (import.meta.main) {
  let cached: ApplyantClient | null = null;
  buildCli(() => {
    cached ??= connect();
    return cached;
  })
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.stderr.write(`applyant: ${describeError(err)}\n`);
      process.exitCode = 1;
    });
}
