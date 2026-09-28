// A scripted provider for tests: no CLI is spawned. Each run takes the next scripted reply
// (or asks a function), and every request is kept for assertions.
import type { ModelProvider, ProviderRequest, ProviderResult } from '../agent-runner.ts';
import type { Provider } from '../roles.ts';

export type FakeReply =
  | { output: unknown }
  | { limit: string; resetsAt?: Date }
  | { error: string }
  | ((req: ProviderRequest) => ProviderResult | Promise<ProviderResult>);

export class FakeProvider implements ModelProvider {
  readonly name: Provider;
  readonly requests: ProviderRequest[] = [];
  private readonly replies: FakeReply[];
  private readonly fallback: FakeReply | null;

  /** `fallback` answers once the scripted replies run out (otherwise that's an error). */
  constructor(name: Provider, replies: FakeReply[] = [], fallback: FakeReply | null = null) {
    this.name = name;
    this.replies = [...replies];
    this.fallback = fallback;
  }

  push(...replies: FakeReply[]): void {
    this.replies.push(...replies);
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(req);
    req.onEvent({ type: 'fake.request', role: req.role, model: req.model });
    const reply = this.replies.shift() ?? this.fallback;
    if (!reply) return { kind: 'error', message: 'fake provider: no scripted reply', usage: null };
    if (typeof reply === 'function') return reply(req);
    if ('output' in reply) {
      req.onEvent({ type: 'fake.output', output: reply.output });
      return {
        kind: 'ok',
        output: reply.output,
        model: req.model,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
      };
    }
    if ('limit' in reply) {
      return {
        kind: 'limit',
        resetsAt: reply.resetsAt ?? new Date(Date.now() + 3_600_000),
        message: reply.limit,
        usage: null,
      };
    }
    return { kind: 'error', message: reply.error, usage: null };
  }
}
