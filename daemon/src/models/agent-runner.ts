// AgentRunner: the one way task handlers reach a model.
//
//   role → provider/model (roles.ts) · strict JSON Schema from the role's zod schema
//   provider run: a fresh CLI process, its event stream → files/runs/<task>-….ndjson + progress
//   structured output → zod validation (+ the caller's post-parse checks)
//   summary → agent_runs (through the `record` sink, a short write of its own; the handler
//             itself never holds a write handle)
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { NewAgentRunRow } from '../db/schema.ts';
import { ensurePrivateDir } from '../util/fs.ts';
import type { Logger } from '../util/log.ts';
import {
  DEFAULT_ROUTING,
  describeRoute,
  type Provider,
  type Role,
  type Route,
  type RoutingTable,
  routeFor,
} from './roles.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface ProviderRequest {
  role: Role;
  /** Provider-specific model name or alias; null = the provider's default. */
  model: string | null;
  system: string;
  prompt: string;
  /** Strict JSON Schema of the expected output. */
  jsonSchema: Record<string, unknown>;
  /** An empty private directory the CLI runs in. */
  cwd: string;
  signal: AbortSignal;
  /** Every raw provider event, in order; the runner writes them to the run log. */
  onEvent(event: unknown): void;
  /** Short human-readable progress ("tool Read", "thinking"). */
  onProgress(message: string): void;
}

export type ProviderResult =
  | { kind: 'ok'; output: unknown; model: string | null; usage: Usage | null }
  | { kind: 'limit'; resetsAt: Date; message: string; usage: Usage | null }
  | { kind: 'error'; message: string; usage: Usage | null };

export interface ModelProvider {
  readonly name: Provider;
  run(req: ProviderRequest): Promise<ProviderResult>;
}

export interface RunRequest<T> {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  taskId: number | null;
  /** Aborted on shutdown or lease loss: the runner rethrows, so the queue releases the task. */
  signal: AbortSignal;
  progress?(message: string): void;
  /** Checks the zod type can't express (lengths, cross-references). Returns a problem or null. */
  validate?(output: T): string | null;
}

export type RunResult<T> =
  | { kind: 'ok'; output: T; route: Route }
  | { kind: 'limit'; provider: Provider; until: Date; message: string }
  | { kind: 'failed'; reason: string; route: Route | null };

export interface AgentRunnerOptions {
  providers: ModelProvider[];
  /** files/runs */
  runsDir: string;
  /** files/work: per-run empty working directories for the CLIs. */
  workDir: string;
  record(row: NewAgentRunRow): void;
  log: Logger;
  now?: () => Date;
  routing?: RoutingTable;
}

/**
 * Strict JSON Schema for a role's zod schema: draft-07, every property required,
 * `additionalProperties: false` (the zod schemas are `.strict()` with `.nullable()` fields).
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export class AgentRunner {
  private readonly o: AgentRunnerOptions;
  private readonly providers = new Map<Provider, ModelProvider>();
  private readonly now: () => Date;
  private seq = 0;

  constructor(options: AgentRunnerOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
    for (const p of options.providers) this.providers.set(p.name, p);
  }

  get available(): ReadonlySet<Provider> {
    return new Set(this.providers.keys());
  }

  routeFor(role: Role): Route {
    return routeFor(role, this.available, this.o.routing ?? DEFAULT_ROUTING);
  }

  async run<T>(role: Role, req: RunRequest<T>): Promise<RunResult<T>> {
    req.signal.throwIfAborted();
    let route: Route;
    try {
      route = this.routeFor(role);
    } catch (err) {
      return { kind: 'failed', reason: (err as Error).message, route: null };
    }
    const provider = this.providers.get(route.provider);
    if (!provider) return { kind: 'failed', reason: `provider ${route.provider} missing`, route };

    const table = this.o.routing ?? DEFAULT_ROUTING;
    const started = this.now();
    const stamp = `${started.getTime()}-${++this.seq}`;
    ensurePrivateDir(this.o.runsDir);
    ensurePrivateDir(this.o.workDir);
    const logPath = join(this.o.runsDir, `task-${req.taskId ?? 'none'}-${role}-${stamp}.ndjson`);
    const cwd = join(this.o.workDir, `${role}-${stamp}`);
    ensurePrivateDir(cwd);
    const log = new RunLog(logPath);
    const jsonSchema = toStrictJsonSchema(req.schema);
    log.write({
      type: 'applyant.request',
      at: started.toISOString(),
      taskId: req.taskId,
      role,
      route: describeRoute(route),
      system: req.system,
      prompt: req.prompt,
      schema: jsonSchema,
    });

    const timeout = AbortSignal.timeout(table.roles[role].timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    req.progress?.(`${role} · ${describeRoute(route)} · started`);

    let result: ProviderResult;
    try {
      result = await provider.run({
        role,
        model: route.model,
        system: req.system,
        prompt: req.prompt,
        jsonSchema,
        cwd,
        signal,
        onEvent: (event) => log.write(event),
        onProgress: (message) => req.progress?.(`${role} · ${message}`),
      });
    } catch (err) {
      result = { kind: 'error', message: errorMessage(err), usage: null };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    const durationMs = this.now().getTime() - started.getTime();
    const finish = (
      outcome: string,
      error: string | null,
      usage: Usage | null,
      model?: string | null,
    ) => {
      log.write({ type: 'applyant.outcome', outcome, error, durationMs, usage });
      log.close();
      try {
        this.o.record({
          taskId: req.taskId,
          role,
          provider: route.provider,
          model: model ?? route.model,
          startedAt: started,
          durationMs,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          costUsd: usage?.costUsd ?? null,
          outcome,
          error,
          logPath,
        });
      } catch (err) {
        this.o.log.warn('agent run not recorded', { role, err });
      }
    };

    if (req.signal.aborted) {
      finish('aborted', errorMessage(req.signal.reason), result.usage);
      throw req.signal.reason;
    }
    if (timeout.aborted && result.kind !== 'ok') {
      const reason = `${role} timed out after ${Math.round(table.roles[role].timeoutMs / 1000)} s`;
      finish('error', reason, result.usage);
      return { kind: 'failed', reason, route };
    }

    switch (result.kind) {
      case 'limit': {
        finish('limit', result.message, result.usage);
        req.progress?.(
          `${role} · waiting for ${route.provider} limit, resumes at ${result.resetsAt.toISOString()}`,
        );
        return {
          kind: 'limit',
          provider: route.provider,
          until: result.resetsAt,
          message: result.message,
        };
      }
      case 'error': {
        finish('error', result.message, result.usage);
        return { kind: 'failed', reason: result.message, route };
      }
      case 'ok': {
        const parsed = req.schema.safeParse(result.output);
        if (!parsed.success) {
          const reason = `invalid ${role} output: ${z.prettifyError(parsed.error).slice(0, 500)}`;
          finish('invalid_output', reason, result.usage, result.model);
          return { kind: 'failed', reason, route };
        }
        const problem = req.validate?.(parsed.data) ?? null;
        if (problem) {
          const reason = `invalid ${role} output: ${problem}`;
          finish('invalid_output', reason, result.usage, result.model);
          return { kind: 'failed', reason, route };
        }
        finish('ok', null, result.usage, result.model);
        const tokens = result.usage
          ? ` · ${result.usage.inputTokens + result.usage.outputTokens} tokens`
          : '';
        req.progress?.(`${role} · done in ${(durationMs / 1000).toFixed(1)} s${tokens}`);
        return { kind: 'ok', output: parsed.data, route };
      }
    }
  }
}

/** Append-only NDJSON file, mode 0600, written synchronously so a crash keeps what happened. */
class RunLog {
  private fd: number | null;

  constructor(path: string) {
    this.fd = openSync(path, 'a', 0o600);
  }

  write(event: unknown): void {
    if (this.fd === null) return;
    try {
      writeSync(this.fd, `${JSON.stringify(event)}\n`);
    } catch {
      // The run log is best effort; the run itself matters more.
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
