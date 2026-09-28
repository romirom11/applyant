// `applyant status`: is the daemon up, and can it reach what it needs on this machine?
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { Command } from 'commander';
import type { SetupStatus, ToolStatus } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const VIA: Record<string, string> = {
  env: 'from $APPLYANT_*_PATH',
  dir: 'fixed directory',
  shell: "login shell's PATH",
};

function toolLine(name: string, t: ToolStatus | undefined): string {
  const label = name.padEnd(9);
  if (!t?.found) return `${label} ✗ ${t?.error || 'not found'}`;
  const parts = [`${t.path} (${VIA[t.foundVia] ?? t.foundVia})`];
  if (t.version) parts.push(t.version);
  parts.push(t.signedIn ? 'signed in' : 'NOT signed in');
  const mark = t.signedIn && !t.error ? '✓' : '!';
  return `${label} ${mark} ${parts.join(' · ')}${t.error ? `\n${' '.repeat(12)}${t.error}` : ''}`;
}

export function statusJson(s: SetupStatus): unknown {
  const tool = (t: ToolStatus | undefined) =>
    t && {
      found: t.found,
      path: t.path || null,
      foundVia: t.foundVia || null,
      version: t.version || null,
      signedIn: t.signedIn,
      error: t.error || null,
    };
  return {
    daemon: {
      pid: Number(s.pid),
      home: s.home,
      startedAt: s.startedAt ? timestampDate(s.startedAt).toISOString() : null,
    },
    claude: tool(s.claude),
    codex: tool(s.codex),
    nativeHelper: s.nativeHelper,
    secretsBackend: s.secretsBackend,
    checkedAt: s.checkedAt ? timestampDate(s.checkedAt).toISOString() : null,
  };
}

export function statusText(s: SetupStatus): string {
  const since = s.startedAt ? timestampDate(s.startedAt).toLocaleString() : '?';
  return [
    `applyantd ✓ running (pid ${s.pid}, since ${since}) · ${s.home}`,
    toolLine('claude', s.claude),
    toolLine('codex', s.codex),
    `native    ${s.nativeHelper ? '✓ applyant-native answers' : '– applyant-native unavailable (macOS app only)'}`,
    `secrets   ${s.secretsBackend}`,
  ].join('\n');
}

export function registerStatus(program: Command, client: () => ApplyantClient): void {
  program
    .command('status')
    .description('daemon status, and where the agent CLIs were found')
    .option('--refresh', 're-run the CLI checks now (they are cached for a minute)')
    .option('--json', 'print JSON')
    .action(async (opts: { refresh?: boolean; json?: boolean }) => {
      const { status } = await client().getSetupStatus({ refresh: opts.refresh ?? false });
      if (!status) throw new Error('the daemon sent no status');
      out(opts.json ? JSON.stringify(statusJson(status), null, 2) : statusText(status));
    });
}
