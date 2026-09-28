// The claude provider: one `query()` of the Claude Agent SDK per run, which spawns the
// `claude` CLI signed in on this machine (the candidate's subscription).
//
// It always passes `pathToClaudeCodeExecutable`, so the SDK never falls back to the binary
// bundled in its npm package (agent-runner.test.ts checks the spawned path). The path is a
// PATH lookup for now; phase 8a replaces it with the resolver launchd needs.
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelProvider, ProviderRequest, ProviderResult, Usage } from '../agent-runner.ts';
import { parseLimitMessage, resetFromEpoch } from '../limits.ts';

type Env = Record<string, string | undefined>;

export class ClaudeNotFoundError extends Error {}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `$APPLYANT_CLAUDE_PATH`, then `claude` on PATH, then `~/.local/bin/claude`. */
export function resolveClaudePath(env: Env = process.env): string {
  const explicit = env.APPLYANT_CLAUDE_PATH;
  if (explicit) {
    if (isExecutable(explicit)) return explicit;
    throw new ClaudeNotFoundError(`APPLYANT_CLAUDE_PATH=${explicit} is not an executable file`);
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  const local = join(env.HOME || homedir(), '.local', 'bin', 'claude');
  if (isExecutable(local)) return local;
  throw new ClaudeNotFoundError(
    'the `claude` CLI was not found (set APPLYANT_CLAUDE_PATH or put it on PATH)',
  );
}

/**
 * The environment for the CLI: ours, minus the variables a parent Claude Code session sets
 * (so a daemon started from inside a Claude session doesn't look like a nested child).
 */
export function claudeEnv(env: Env = process.env): Env {
  const keep = new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]);
  const out: Env = {};
  for (const [key, value] of Object.entries(env)) {
    const inherited =
      key === 'CLAUDECODE' ||
      key === 'CLAUDE_PID' ||
      key === 'CLAUDE_EFFORT' ||
      key.startsWith('CLAUDE_CODE_') ||
      key.startsWith('CLAUDE_AGENT_SDK_') ||
      key.startsWith('CLAUDE_BASH_');
    if (inherited && !keep.has(key)) continue;
    out[key] = value;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'applyant/0.1';
  // Second guard (with strictMcpConfig) against the account's claude.ai connectors.
  out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return out;
}

export interface ClaudeProviderOptions {
  /** Resolved on every run, so installing `claude` doesn't need a daemon restart. */
  resolvePath?: () => string;
  env?: () => Env;
  now?: () => Date;
}

export class ClaudeProvider implements ModelProvider {
  readonly name = 'claude' as const;
  private readonly o: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions = {}) {
    this.o = options;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const now = this.o.now ?? (() => new Date());
    let path: string;
    try {
      path = (this.o.resolvePath ?? resolveClaudePath)();
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, usage: null };
    }

    const ac = new AbortController();
    const onAbort = () => ac.abort(req.signal.reason);
    if (req.signal.aborted) onAbort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    let stderr = '';

    const options: Options = {
      pathToClaudeCodeExecutable: path,
      ...(req.model ? { model: req.model } : {}),
      systemPrompt: req.system,
      outputFormat: { type: 'json_schema', schema: req.jsonSchema },
      // No built-in tools: roles that need tools get Applyant's MCP tools (the writer's
      // search_facts / get_project), allowed by name; `dontAsk` denies anything else.
      tools: [],
      // Only MCP servers Applyant passes. Without this the account's claude.ai connectors
      // are attached as tools too: hundreds of schemas, ~550k tokens on every run.
      mcpServers: req.tools?.servers ?? {},
      ...(req.tools ? { allowedTools: req.tools.allowed } : {}),
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      // Nothing from ~/.claude or a project directory leaks into a task.
      settingSources: [],
      persistSession: false,
      cwd: req.cwd,
      env: (this.o.env ?? claudeEnv)(),
      abortController: ac,
      stderr: (data) => {
        stderr = (stderr + data).slice(-4000);
      },
    };

    let limitAt: Date | null = null;
    let limitText: string | null = null;
    let model: string | null = null;
    let result: Extract<SDKMessage, { type: 'result' }> | null = null;

    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        req.onEvent(message);
        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              model = message.model;
              req.onProgress(`claude ${message.model}`);
            }
            break;
          case 'rate_limit_event': {
            const info = message.rate_limit_info;
            if (info.status === 'rejected') {
              limitAt = info.resetsAt ? resetFromEpoch(info.resetsAt) : limitAt;
              limitText ??= `claude ${info.rateLimitType ?? 'usage'} limit reached`;
            }
            break;
          }
          case 'assistant': {
            for (const block of message.message.content) {
              if (block.type === 'tool_use') req.onProgress(`tool ${block.name}`);
              if (block.type === 'text' && message.error === 'rate_limit') {
                limitText = block.text;
              }
            }
            break;
          }
          case 'result':
            result = message;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (req.signal.aborted) throw req.signal.reason;
      const text = `${(err as Error).message}\n${stderr}`;
      const limit = this.limit(text, limitAt, now());
      if (limit) return { ...limit, usage: null };
      return { kind: 'error', message: firstLines(text), usage: null };
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }

    if (!result) {
      const limit = this.limit(`${limitText ?? ''}\n${stderr}`, limitAt, now());
      if (limit) return { ...limit, usage: null };
      return {
        kind: 'error',
        message: firstLines(`claude ended without a result\n${stderr}`),
        usage: null,
      };
    }

    const usage = usageOf(result);
    const errorText =
      result.subtype === 'success'
        ? result.is_error
          ? result.result
          : null
        : result.errors.join('\n');
    if (errorText !== null) {
      const limit = this.limit(`${errorText}\n${limitText ?? ''}`, limitAt, now());
      if (limit) return { ...limit, usage };
      return {
        kind: 'error',
        message: firstLines(`claude ${result.subtype}: ${errorText || stderr}`),
        usage,
      };
    }
    if (result.subtype === 'success' && result.structured_output === undefined) {
      return { kind: 'error', message: 'claude returned no structured output', usage };
    }
    return {
      kind: 'ok',
      output: result.subtype === 'success' ? result.structured_output : null,
      // The main loop's model; modelUsage also lists helper calls (e.g. a Haiku summary).
      model: model ?? Object.keys(result.modelUsage)[0] ?? null,
      usage,
    };
  }

  private limit(
    text: string,
    limitAt: Date | null,
    now: Date,
  ): { kind: 'limit'; resetsAt: Date; message: string } | null {
    const hit = parseLimitMessage(text, now);
    if (hit) return { kind: 'limit', resetsAt: limitAt ?? hit.resetsAt, message: hit.message };
    if (limitAt) return { kind: 'limit', resetsAt: limitAt, message: 'claude usage limit reached' };
    return null;
  }
}

function usageOf(result: Extract<SDKMessage, { type: 'result' }>): Usage {
  let input = 0;
  let output = 0;
  for (const m of Object.values(result.modelUsage ?? {})) {
    input += m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
    output += m.outputTokens;
  }
  if (input === 0 && output === 0 && result.usage) {
    input = result.usage.input_tokens ?? 0;
    output = result.usage.output_tokens ?? 0;
  }
  return { inputTokens: input, outputTokens: output, costUsd: result.total_cost_usd ?? null };
}

function firstLines(text: string): string {
  return text.trim().split('\n').slice(0, 6).join('\n').slice(0, 1000);
}
