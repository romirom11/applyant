// Whether each agent CLI can actually be used: found (cli-paths.ts), runs (`--version`) and
// is signed in (`claude auth status` · `codex login status`). Checks spawn processes, so the
// result is cached for a minute; the menu bar asks often.
import { type CliPaths, type RunFile, runFile, TOOLS, type Tool } from './cli-paths.ts';
import { claudeEnv } from './providers/claude.ts';

type Env = Record<string, string | undefined>;

export interface ToolCheck {
  tool: Tool;
  found: boolean;
  path: string | null;
  via: 'env' | 'dir' | 'shell' | null;
  version: string | null;
  signedIn: boolean;
  error: string | null;
}

export interface ToolChecks {
  tools: Record<Tool, ToolCheck>;
  checkedAt: Date;
}

const SIGN_IN: Record<Tool, readonly string[]> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
};

const LOGIN: Record<Tool, string> = { claude: 'claude auth login', codex: 'codex login' };

const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 300) ?? '';

function errorText(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
  if (e.killed) return 'timed out';
  return firstLine(e.stderr || e.stdout || e.message || String(err));
}

/** `claude auth status` prints JSON ({"loggedIn": true, …}); `codex login status` exits 0. */
export function parseSignIn(tool: Tool, stdout: string): boolean {
  if (tool === 'codex') return true;
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

export class CliStatus {
  private readonly paths: CliPaths;
  private readonly run: RunFile;
  private readonly env: Env;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private cached: Promise<ToolChecks> | null = null;
  private cachedAt = 0;

  constructor(o: {
    paths: CliPaths;
    run?: RunFile;
    env?: Env;
    ttlMs?: number;
    now?: () => Date;
  }) {
    this.paths = o.paths;
    this.run = o.run ?? runFile;
    this.env = o.env ?? process.env;
    this.ttlMs = o.ttlMs ?? 60_000;
    this.now = o.now ?? (() => new Date());
  }

  check(refresh = false): Promise<ToolChecks> {
    const now = this.now().getTime();
    if (!this.cached || refresh || now - this.cachedAt > this.ttlMs) {
      this.cachedAt = now;
      this.cached = this.checkAll();
    }
    return this.cached;
  }

  private async checkAll(): Promise<ToolChecks> {
    const checks = await Promise.all(TOOLS.map((t) => this.checkTool(t)));
    return {
      tools: Object.fromEntries(checks.map((c) => [c.tool, c])) as Record<Tool, ToolCheck>,
      checkedAt: this.now(),
    };
  }

  private async checkTool(tool: Tool): Promise<ToolCheck> {
    const found = await this.paths.resolve(tool);
    const base: ToolCheck = {
      tool,
      found: found.path !== null,
      path: found.path,
      via: found.via,
      version: null,
      signedIn: false,
      error: found.error,
    };
    if (!found.path) return base;
    // The same environment the providers give the CLI: its own directory first on PATH.
    const env = claudeEnv({ ...this.env, PATH: this.paths.childPath(found.path, this.env) });
    try {
      base.version = firstLine(
        await this.run(found.path, ['--version'], { env, timeoutMs: 15_000 }),
      );
    } catch (err) {
      return { ...base, error: `\`${tool} --version\` failed: ${errorText(err)}` };
    }
    try {
      const out = await this.run(found.path, SIGN_IN[tool], { env, timeoutMs: 15_000 });
      base.signedIn = parseSignIn(tool, out);
      if (!base.signedIn) base.error = `not signed in: run \`${LOGIN[tool]}\``;
    } catch (err) {
      base.error = `not signed in (${errorText(err)}): run \`${LOGIN[tool]}\``;
    }
    return base;
  }
}
