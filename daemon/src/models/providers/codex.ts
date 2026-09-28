// The codex provider: one thread of the Codex SDK per run, which spawns `codex exec` signed in on
// this machine (the candidate's ChatGPT subscription). It streams the exec JSONL events
// (thread.started · turn.* · item.*), and the final agent message is the structured output.
//
// It always passes `codexPathOverride`, so the SDK never falls back to the binary bundled in its
// npm package (codex-provider.test.ts checks the spawned path). The path comes from the daemon's
// resolver (cli-paths.ts), because a launchd agent has no shell PATH.
//
// A run is isolated from the candidate's own Codex setup as far as `codex exec` allows through
// the SDK: read-only sandbox in an empty directory, no approvals, no notify hook, the servers of
// their config.toml switched off (only Applyant's MCP servers, when a role has tools), and web
// search only for roles that search.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Codex,
  type CodexOptions,
  type Usage as CodexUsage,
  type ThreadEvent,
} from '@openai/codex-sdk';
import type { ModelProvider, ProviderRequest, ProviderResult, Usage } from '../agent-runner.ts';
import { defaultCliPaths } from '../cli-paths.ts';
import { parseLimitMessage } from '../limits.ts';

type Env = Record<string, string | undefined>;
type CodexConfigObject = NonNullable<CodexOptions['config']>;

export interface CodexProviderOptions {
  /** Resolved on every run, so installing `codex` doesn't need a daemon restart. */
  resolvePath?: () => Promise<string> | string;
  /** The CLI's environment; given the resolved path, so PATH can start at its directory. */
  env?: (path: string) => Env;
  /** The candidate's MCP server names (their servers are switched off in Applyant's runs). */
  userMcpServers?: () => string[];
  now?: () => Date;
}

/**
 * The environment for `codex exec`: ours, minus what a parent Codex or Claude Code session
 * sets, so a daemon started from inside one doesn't look like its child.
 */
export function codexEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === 'CODEX_THREAD_ID' || key === 'CODEX_SANDBOX' || key.startsWith('CODEX_SANDBOX_'))
      continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    out[key] = value;
  }
  return out;
}

/** `[mcp_servers.<name>]` table names in $CODEX_HOME/config.toml (names only, nothing else). */
export function userMcpServerNames(env: Env = process.env): string[] {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  let text: string;
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const names = new Set<string>();
  // [mcp_servers.<name>] and its sub-tables ([mcp_servers.<name>.tools.x]); quoted or bare.
  for (const m of text.matchAll(
    /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]\s*$/gm,
  )) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return [...names];
}

/** The structured output: the final agent message, as JSON (tolerating a code fence). */
export function parseFinalMessage(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return JSON.parse(fenced?.[1] ?? t);
}

function usageOf(u: CodexUsage | null): Usage | null {
  if (!u) return null;
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: null };
}

function firstLines(text: string): string {
  return text.trim().split('\n').slice(0, 6).join('\n').slice(0, 1000);
}

export class CodexProvider implements ModelProvider {
  readonly name = 'codex' as const;
  private readonly o: CodexProviderOptions;

  constructor(options: CodexProviderOptions = {}) {
    this.o = options;
  }

  /** `--config` overrides for one run. */
  config(req: ProviderRequest): CodexConfigObject {
    const servers: CodexConfigObject = {};
    for (const name of this.o.userMcpServers?.() ?? userMcpServerNames()) {
      servers[name] = { enabled: false };
    }
    for (const [name, s] of Object.entries(req.tools?.servers ?? {})) {
      const prefix = `mcp__${name}__`;
      servers[name] = {
        url: s.url,
        http_headers: s.headers,
        enabled_tools: (req.tools?.allowed ?? [])
          .filter((t) => t.startsWith(prefix))
          .map((t) => t.slice(prefix.length)),
      };
    }
    return {
      // The candidate's own turn-ended hook is theirs, not a background task's.
      notify: [],
      ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
    };
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const now = this.o.now ?? (() => new Date());
    let path: string;
    try {
      path = await (this.o.resolvePath ?? (() => defaultCliPaths().require('codex')))();
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, usage: null };
    }
    const env = (
      this.o.env ?? ((p) => codexEnv({ ...process.env, PATH: defaultCliPaths().childPath(p) }))
    )(path);
    const codex = new Codex({
      codexPathOverride: path,
      env: Object.fromEntries(
        Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      config: this.config(req),
    });
    const thread = codex.startThread({
      ...(req.model ? { model: req.model } : {}),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      workingDirectory: req.cwd,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: req.webSearch ? 'live' : 'disabled',
    });

    // codex exec has no system prompt of its own: the role's instructions lead the prompt.
    const prompt = `${req.system}\n\n---\n\n${req.prompt}`;
    let final: string | null = null;
    let usage: Usage | null = null;
    const errors: string[] = [];
    try {
      const { events } = await thread.runStreamed(prompt, {
        outputSchema: req.jsonSchema,
        signal: req.signal,
      });
      for await (const event of events as AsyncGenerator<ThreadEvent>) {
        req.onEvent(event);
        switch (event.type) {
          case 'thread.started':
            req.onProgress(`codex${req.model ? ` ${req.model}` : ''}`);
            break;
          case 'item.started':
            if (event.item.type === 'web_search') req.onProgress(`web search: ${event.item.query}`);
            if (event.item.type === 'mcp_tool_call') req.onProgress(`tool ${event.item.tool}`);
            if (event.item.type === 'command_execution') req.onProgress('command');
            break;
          case 'item.completed':
            if (event.item.type === 'agent_message') final = event.item.text;
            // Non-fatal notices ("ignoring an unrecognized setting") are items too: logged only.
            break;
          case 'turn.completed':
            usage = usageOf(event.usage);
            break;
          case 'turn.failed':
            errors.push(event.error.message);
            break;
          case 'error':
            errors.push(event.message);
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (req.signal.aborted) throw req.signal.reason;
      // A usage limit ends `codex exec` with exit 1 and the message on stderr.
      errors.push((err as Error).message);
    }

    const errorText = errors.join('\n');
    if (errorText) {
      const hit = parseLimitMessage(errorText, now());
      if (hit) return { kind: 'limit', resetsAt: hit.resetsAt, message: hit.message, usage };
      if (final === null) {
        return { kind: 'error', message: firstLines(`codex: ${errorText}`), usage };
      }
    }
    if (final === null) return { kind: 'error', message: 'codex returned no final message', usage };
    try {
      return { kind: 'ok', output: parseFinalMessage(final), model: req.model, usage };
    } catch {
      return {
        kind: 'error',
        message: firstLines(`codex returned no JSON: ${final.slice(0, 300)}`),
        usage,
      };
    }
  }
}
