// The on-device provider: Apple's Foundation Models through applyant-native. It answers one
// role, email_classify, from the request's structured input (the email), so mail never leaves
// the Mac. It's registered only when the helper is reachable; without it the routing table has
// no fallback for `apple` (roles.ts), so email_classify fails and the email is asked about,
// never quietly sent to a cloud model.
import { classifyEmail, type NativeHelper } from '../../native/client.ts';
import type { ModelProvider, ProviderRequest, ProviderResult } from '../agent-runner.ts';

export class AppleProvider implements ModelProvider {
  readonly name = 'apple' as const;
  private readonly native: NativeHelper;

  constructor(native: NativeHelper) {
    this.native = native;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    if (req.role !== 'email_classify') {
      return {
        kind: 'error',
        message: `the on-device model doesn't answer ${req.role}`,
        usage: null,
      };
    }
    const input = req.input ?? {};
    const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
    try {
      req.onProgress('on-device');
      const output = await classifyEmail(this.native, {
        subject: text('subject'),
        body: text('body'),
        from: text('from'),
      });
      req.onEvent({ type: 'apple.output', output });
      return { kind: 'ok', output, model: 'foundation-models', usage: null };
    } catch (err) {
      return { kind: 'error', message: (err as Error).message, usage: null };
    }
  }
}
