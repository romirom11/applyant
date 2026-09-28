// Applyant's MCP endpoint: streamable HTTP on 127.0.0.1, one long-lived server in the daemon.
//
//   grant(task)  → a per-task bearer token that says which tools this run may call and how
//                  many calls it has left; the token goes to the agent CLI as a header
//   POST /mcp    → token → grant → a stateless MCP server with only the granted tools
//
// The call cap lives here, keyed by the token, not in the prompt: the writer gets at most
// three knowledge lookups, then every further call is refused. Everything a tool returns is
// reported back through the grant (the writer's citable set grows with it), and every call is
// kept for the run's record. Tokens die with the run (`revoke`).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { z } from 'zod';
import type { RunTools } from '../models/agent-runner.ts';
import type { Logger } from '../util/log.ts';

/** What the endpoint is called in the agent's tool names: mcp__applyant__<tool>. */
export const MCP_SERVER_NAME = 'applyant';

export interface ToolResult<R = unknown> {
  /** What the agent reads. */
  text: string;
  /** Structured results, handed to the grant's onResult (e.g. the facts it returned). */
  items: R[];
}

export interface McpTool<R = unknown> {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  /** `taskId` is the grant's: browser tools use it to find the task's live page. */
  run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    taskId: number | null,
  ): Promise<ToolResult<R>>;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** refused: over the cap (or not granted). */
  outcome: 'ok' | 'refused' | 'error';
  items: number;
}

export interface GrantOptions<R = unknown> {
  taskId: number | null;
  /** Tool names (without the mcp__ prefix). */
  tools: string[];
  /** Total calls across the granted tools. */
  maxCalls: number;
  onResult?(tool: string, items: R[]): void;
}

export interface Grant {
  /** What the provider passes to the agent CLI. */
  tools: RunTools;
  calls(): ToolCall[];
  revoke(): void;
}

/** What handlers see (deps.mcp). */
export interface McpAccess {
  grant<R>(o: GrantOptions<R>): Grant;
}

interface Live {
  token: Buffer;
  options: GrantOptions<unknown>;
  used: number;
  calls: ToolCall[];
  ac: AbortController;
}

export interface McpHubOptions {
  tools: McpTool[];
  log: Logger;
  host?: string;
  port?: number;
}

export class McpHub implements McpAccess {
  private readonly o: McpHubOptions;
  private readonly grants = new Map<string, Live>();
  private readonly tools = new Map<string, McpTool>();
  private server: Server | null = null;
  private port = 0;

  constructor(options: McpHubOptions) {
    this.o = options;
    for (const t of options.tools) this.tools.set(t.name, t);
  }

  get url(): string {
    if (!this.server) throw new Error('the MCP endpoint is not started');
    return `http://${this.o.host ?? '127.0.0.1'}:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      this.handle(req)
        .then((handled) => {
          if (!handled.ok) {
            res.writeHead(handled.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: handled.error }));
            return;
          }
          const { live, body } = handled;
          const mcp = this.serverFor(live);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          res.on('close', () => {
            transport.close().catch(() => {});
            mcp.close().catch(() => {});
          });
          return mcp.connect(transport).then(() => transport.handleRequest(req, res, body));
        })
        .catch((err) => {
          this.o.log.warn('mcp request failed', { err });
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.o.port ?? 0, this.o.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    this.o.log.info('mcp listening', { url: this.url });
  }

  async close(): Promise<void> {
    for (const live of this.grants.values()) live.ac.abort();
    this.grants.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  grant<R>(options: GrantOptions<R>): Grant {
    for (const name of options.tools) {
      if (!this.tools.has(name)) throw new Error(`no MCP tool "${name}"`);
    }
    const token = randomBytes(24).toString('base64url');
    const live: Live = {
      token: Buffer.from(`Bearer ${token}`),
      options: options as GrantOptions<unknown>,
      used: 0,
      calls: [],
      ac: new AbortController(),
    };
    this.grants.set(token, live);
    return {
      tools: {
        servers: {
          [MCP_SERVER_NAME]: {
            type: 'http',
            url: this.url,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
        allowed: options.tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`),
      },
      calls: () => [...live.calls],
      revoke: () => {
        live.ac.abort();
        this.grants.delete(token);
      },
    };
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<
    { ok: true; live: Live; body: unknown } | { ok: false; status: number; error: string }
  > {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return { ok: false, status: 404, error: 'not found' };
    const header = Buffer.from(req.headers.authorization ?? '');
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const live = this.grants.get(token);
    if (!live || live.token.length !== header.length || !timingSafeEqual(live.token, header)) {
      return { ok: false, status: 401, error: 'missing or unknown task token' };
    }
    // Stateless: no sessions, no server-initiated streams.
    if (req.method !== 'POST') return { ok: false, status: 405, error: 'POST only' };
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return { ok: false, status: 413, error: 'request too large' };
    }
    try {
      return { ok: true, live, body: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false, status: 400, error: 'invalid JSON' };
    }
  }

  /** A fresh MCP server exposing only this grant's tools, each counted against its cap. */
  private serverFor(live: Live): McpServer {
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
    for (const name of live.options.tools) {
      const tool = this.tools.get(name);
      if (!tool) continue;
      mcp.registerTool(
        name,
        { description: tool.description, inputSchema: tool.input },
        async (args: Record<string, unknown>) => {
          if (live.used >= live.options.maxCalls) {
            live.calls.push({ tool: name, args, outcome: 'refused', items: 0 });
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Refused: this task may make at most ${live.options.maxCalls} lookups and has used them all. Write the answer from the facts you already have.`,
                },
              ],
            };
          }
          live.used++;
          try {
            const result = await tool.run(args, live.ac.signal, live.options.taskId);
            live.calls.push({ tool: name, args, outcome: 'ok', items: result.items.length });
            live.options.onResult?.(name, result.items);
            return { content: [{ type: 'text' as const, text: result.text }] };
          } catch (err) {
            live.calls.push({ tool: name, args, outcome: 'error', items: 0 });
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
            };
          }
        },
      );
    }
    return mcp;
  }
}
