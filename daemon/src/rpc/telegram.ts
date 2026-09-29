// Telegram (phase 15): the candidate's own account for private channels and Telegram
// applications. The session stays in Secrets; nothing here returns it.
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  type ApplyantService,
  type Telegram,
  TelegramSchema,
  TelegramState,
} from '../gen/applyant/v1/applyant_pb.js';
import {
  TelegramError,
  type TelegramService,
  type TelegramStatus,
} from '../integrations/gramjs.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

const STATES: Record<TelegramStatus['state'], TelegramState> = {
  disconnected: TelegramState.DISCONNECTED,
  waiting_code: TelegramState.WAITING_CODE,
  waiting_password: TelegramState.WAITING_PASSWORD,
  connected: TelegramState.CONNECTED,
};

export function toTelegram(s: TelegramStatus): Telegram {
  return create(TelegramSchema, {
    state: STATES[s.state],
    ...(s.account ? { account: s.account } : {}),
    apiConfigured: s.apiConfigured,
    ...(s.note ? { note: s.note } : {}),
  });
}

async function run(fn: () => Promise<TelegramStatus>): Promise<{ telegram: Telegram }> {
  try {
    return { telegram: toTelegram(await fn()) };
  } catch (err) {
    if (err instanceof TelegramError) {
      throw new ConnectError(err.message, Code.FailedPrecondition);
    }
    throw err;
  }
}

export function telegramRpcs(
  telegram: TelegramService | null,
): Pick<Impl, 'getTelegram' | 'connectTelegram' | 'disconnectTelegram'> {
  const need = (): TelegramService => {
    if (!telegram) throw new ConnectError("Telegram isn't available", Code.Unavailable);
    return telegram;
  };
  return {
    getTelegram: () => run(() => need().status()),
    connectTelegram: (req) =>
      run(async () => {
        const t = need();
        const step = req.step;
        switch (step.case) {
          case 'start':
            return t.startSignIn(step.value.phone, {
              apiId: step.value.apiId ?? null,
              apiHash: step.value.apiHash ?? null,
            });
          case 'code':
            return t.submitCode(step.value);
          case 'password':
            return t.submitPassword(step.value);
          case 'cancel':
            await t.cancel();
            return t.status();
          default:
            throw new ConnectError(
              'which step? start, code, password or cancel',
              Code.InvalidArgument,
            );
        }
      }),
    disconnectTelegram: () => run(() => need().disconnect()),
  };
}
