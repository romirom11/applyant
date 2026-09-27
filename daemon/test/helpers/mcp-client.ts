// Calls Applyant's MCP endpoint the way an agent CLI would: streamable HTTP with the per-task
// bearer token from a grant. Used by tests and by fake providers that "use tools".
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RunTools } from '../../src/models/agent-runner.ts';

export interface ToolReply {
  isError: boolean;
  text: string;
}

export interface TestMcpClient {
  tools(): Promise<string[]>;
  call(tool: string, args: Record<string, unknown>): Promise<ToolReply>;
  close(): Promise<void>;
}

export async function mcpClient(tools: RunTools, server = 'applyant'): Promise<TestMcpClient> {
  const cfg = tools.servers[server];
  if (!cfg) throw new Error(`no MCP server "${server}" in the grant`);
  const client = new Client({ name: 'applyant-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers: cfg.headers },
  });
  await client.connect(transport);
  return {
    async tools() {
      const res = await client.listTools();
      return res.tools.map((t) => t.name);
    },
    async call(tool, args) {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      return {
        isError: !!res.isError,
        text: res.content.map((c) => c.text ?? '').join('\n'),
      };
    },
    close: () => client.close(),
  };
}
