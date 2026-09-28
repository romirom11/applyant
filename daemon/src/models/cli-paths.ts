// Where the agent CLIs live. A launchd agent doesn't inherit the shell's PATH, so the daemon
// looks for `claude` and `codex` itself, at explicit places, and hands the SDKs the path:
//
//   $APPLYANT_<TOOL>_PATH → ~/.local/bin → ~/.npm-global/bin → /opt/homebrew/bin → /usr/local/bin
//     → the login shell's PATH (last resort)
//
// The login-shell probe is slow (nvm or pyenv in a profile can take 1–2 s), so it runs at most
// once per daemon, however many tasks resolve; its result is cached. The fixed places are
// checked on every call, so a CLI installed there later is found without a restart.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export type Tool = 'claude' | 'codex';
export const TOOLS: readonly Tool[] = ['claude', 'codex'];

type Env = Record<string, string | undefined>;

export interface ToolPath {
  tool: Tool;
  /** Absolute path of the executable, or null when it wasn't found. */
  path: string | null;
  /** Which step found it. */
  via: 'env' | 'dir' | 'shell' | null;
  /** Why it wasn't found (null when found). */
  error: string | null;
}

export class ToolNotFoundError extends Error {}

/** Runs a program and returns its stdout; rejects on a non-zero exit or the timeout. */
export type RunFile = (
  file: string,
  args: readonly string[],
  o: { env: Env; timeoutMs: number },
) => Promise<string>;

export interface CliPathsOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  run?: RunFile;
  isExecutable?: (path: string) => boolean;
  /** How long the login-shell probe may take. */
  probeTimeoutMs?: number;
}

export const PROBE_MARKER = '__APPLYANT__';

export const runFile: RunFile = (file, args, o) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: o.env, timeout: o.timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout, stderr) =>
        // The output travels with the error: a failed status check explains itself there.
        err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout),
    );
    // An interactive shell must never wait for input.
    child.stdin?.end();
  });

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const envName = (tool: Tool) => `APPLYANT_${tool.toUpperCase()}_PATH`;

/** The directories checked before the shell probe, in order. */
export function fixedDirs(home: string): string[] {
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/** The PATH the login shell printed after the marker line; profile noise before it is ignored. */
export function parseProbeOutput(stdout: string): string[] | null {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === PROBE_MARKER);
  if (at < 0) return null;
  const path = lines.slice(at + 1).find((l) => l.trim() !== '');
  if (!path) return null;
  return path
    .trim()
    .split(delimiter)
    .filter((d) => d.startsWith('/'));
}

export class CliPaths {
  private readonly env: Env;
  private readonly platform: NodeJS.Platform;
  private readonly run: RunFile;
  private readonly isExecutable: (path: string) => boolean;
  private readonly probeTimeoutMs: number;
  private probe: Promise<{ dirs: string[] } | { error: string }> | null = null;
  /** How many times the login shell was started (tests: at most once). */
  probeRuns = 0;

  constructor(o: CliPathsOptions = {}) {
    this.env = o.env ?? process.env;
    this.platform = o.platform ?? process.platform;
    this.run = o.run ?? runFile;
    this.isExecutable = o.isExecutable ?? isExecutableFile;
    this.probeTimeoutMs = o.probeTimeoutMs ?? 10_000;
  }

  private home(): string {
    return this.env.HOME || homedir();
  }

  /** Warms the cache at daemon start, so the first task doesn't wait for the shell. */
  async start(): Promise<void> {
    await Promise.all(TOOLS.map((t) => this.resolve(t)));
  }

  async resolve(tool: Tool): Promise<ToolPath> {
    const explicit = this.env[envName(tool)];
    if (explicit) {
      if (this.isExecutable(explicit)) return { tool, path: explicit, via: 'env', error: null };
      return {
        tool,
        path: null,
        via: null,
        error: `${envName(tool)}=${explicit} is not an executable file`,
      };
    }
    for (const dir of fixedDirs(this.home())) {
      const candidate = join(dir, tool);
      if (this.isExecutable(candidate)) return { tool, path: candidate, via: 'dir', error: null };
    }
    const probed = await this.probeOnce();
    if ('dirs' in probed) {
      for (const dir of probed.dirs) {
        const candidate = join(dir, tool);
        if (this.isExecutable(candidate)) {
          return { tool, path: candidate, via: 'shell', error: null };
        }
      }
    }
    const shellNote =
      'error' in probed
        ? `the login-shell probe failed (${probed.error})`
        : "the login shell's PATH";
    return {
      tool,
      path: null,
      via: null,
      error: `\`${tool}\` not found: checked ${envName(tool)} (unset), ${fixedDirs(this.home())
        .map((d) => join(d, tool))
        .join(', ')} and ${shellNote}`,
    };
  }

  /** The resolved path, or ToolNotFoundError with the reason. */
  async require(tool: Tool): Promise<string> {
    const found = await this.resolve(tool);
    if (!found.path) throw new ToolNotFoundError(found.error ?? `\`${tool}\` not found`);
    return found.path;
  }

  /**
   * PATH for the tool's own process: its directory first. An npm-installed CLI is a
   * `#!/usr/bin/env node` script, and under launchd `node` is only found next to it.
   */
  childPath(toolPath: string, env: Env = this.env): string {
    const rest = (env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(delimiter);
    const dir = dirname(toolPath);
    return [dir, ...rest.filter((d) => d && d !== dir)].join(delimiter);
  }

  /** Which shell the probe uses: $SHELL, unless unset, empty or /bin/sh; then dscl; then zsh. */
  async probeShell(): Promise<string> {
    const shell = this.env.SHELL;
    if (shell && shell !== '/bin/sh') return shell;
    if (this.platform === 'darwin') {
      const user = this.env.USER || userInfo().username;
      try {
        const out = await this.run('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'UserShell'], {
          env: this.env,
          timeoutMs: 5_000,
        });
        const m = /UserShell:\s*(\S+)/.exec(out);
        if (m?.[1] && m[1] !== '/bin/sh') return m[1];
      } catch {
        // No dscl answer: the macOS default below.
      }
    }
    return '/bin/zsh';
  }

  private probeOnce(): Promise<{ dirs: string[] } | { error: string }> {
    this.probe ??= (async () => {
      this.probeRuns++;
      const shell = await this.probeShell();
      try {
        // -i as well as -l: zsh reads ~/.zshrc (where nvm usually lives) only when interactive.
        // PATH rather than `command -v`, which prints an alias's definition instead of a path.
        const out = await this.run(
          shell,
          ['-ilc', `echo ${PROBE_MARKER}; printf '%s\\n' "$PATH"`],
          {
            env: { ...this.env, HOME: this.home() },
            timeoutMs: this.probeTimeoutMs,
          },
        );
        const dirs = parseProbeOutput(out);
        return dirs ? { dirs } : { error: `${shell} printed no PATH` };
      } catch (err) {
        const e = err as { killed?: boolean; code?: unknown; message?: string };
        if (e.killed) return { error: `${shell} timed out after ${this.probeTimeoutMs} ms` };
        return { error: `${shell}: ${e.message?.split('\n')[0] ?? String(err)}` };
      }
    })();
    return this.probe;
  }
}

let shared: CliPaths | null = null;

/** The daemon's one resolver (main.ts warms it; providers default to it). */
export function defaultCliPaths(): CliPaths {
  shared ??= new CliPaths();
  return shared;
}
