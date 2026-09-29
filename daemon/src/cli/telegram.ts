// `applyant telegram …`: the candidate's own Telegram account, for private job channels and
// Telegram applications. Public channels need no account: `applyant search sources add
// telegram <channel>` (or a t.me link) reads their t.me/s preview.
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { type Telegram, TelegramState } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const STATE: Record<TelegramState, string> = {
  [TelegramState.UNSPECIFIED]: 'unknown',
  [TelegramState.DISCONNECTED]: 'not connected',
  [TelegramState.WAITING_CODE]: 'waiting for the code Telegram sent',
  [TelegramState.WAITING_PASSWORD]: 'waiting for the two-step verification password',
  [TelegramState.CONNECTED]: 'connected',
};

export function telegramLine(t: Telegram | undefined): string {
  if (!t) return 'Telegram: unknown';
  const who = t.state === TelegramState.CONNECTED && t.account ? ` as ${t.account}` : '';
  const api = t.apiConfigured ? '' : ' · no api id/hash yet (my.telegram.org)';
  return `Telegram: ${STATE[t.state]}${who}${api}${t.note ? ` · ${t.note}` : ''}`;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function registerTelegram(
  program: Command,
  client: () => ApplyantClient,
  readSecretValue: (name: string) => Promise<string>,
): void {
  const telegram = program
    .command('telegram')
    .description('your Telegram account: private job channels and Telegram applications');

  telegram
    .command('status', { isDefault: true })
    .description('whether an account is connected')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().getTelegram({});
      if (opts.json) {
        return out(
          JSON.stringify(
            {
              state: STATE[res.telegram?.state ?? TelegramState.UNSPECIFIED],
              account: res.telegram?.account ?? null,
              apiConfigured: res.telegram?.apiConfigured ?? false,
              note: res.telegram?.note ?? null,
            },
            null,
            2,
          ),
        );
      }
      out(telegramLine(res.telegram));
    });

  telegram
    .command('connect <phone>')
    .description(
      'sign in (phone → the code Telegram sends → the 2FA password if set); the session stays in Secrets',
    )
    .option('--api-id <id>', 'your app api_id from my.telegram.org (stored once)')
    .option('--api-hash', 'read your app api_hash from stdin or a prompt (stored once)')
    .action(async (phone: string, opts: { apiId?: string; apiHash?: boolean }) => {
      const c = client();
      const apiHash = opts.apiHash ? await readSecretValue('telegram.api_hash') : undefined;
      let res = await c.connectTelegram({
        step: {
          case: 'start',
          value: {
            phone,
            ...(opts.apiId ? { apiId: opts.apiId } : {}),
            ...(apiHash ? { apiHash } : {}),
          },
        },
      });
      if (res.telegram?.state === TelegramState.WAITING_CODE) {
        const code = await ask('The code Telegram sent: ');
        res = await c.connectTelegram({ step: { case: 'code', value: code } });
      }
      if (res.telegram?.state === TelegramState.WAITING_PASSWORD) {
        if (res.telegram.note) out(res.telegram.note);
        const password = await readSecretValue('telegram 2FA password');
        res = await c.connectTelegram({ step: { case: 'password', value: password } });
      }
      out(telegramLine(res.telegram));
    });

  telegram
    .command('disconnect')
    .description("forget Applyant's session (the account itself is untouched)")
    .action(async () => {
      const res = await client().disconnectTelegram({});
      out(telegramLine(res.telegram));
    });
}
