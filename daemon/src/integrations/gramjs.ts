// The candidate's own Telegram account over MTProto (GramJS, the `telegram` package): the
// sign-in flow (phone → code → the 2FA password when the account has one), the session kept in
// `Secrets`, reading a channel's recent posts (private channels the account has joined), and
// sending a message with a file (the Telegram delivery channel).
//
// Everything goes through `TelegramClientLike`, the few GramJS calls used here, so tests run a
// fake client and nothing ever talks to Telegram. The real client is imported only when an
// account is actually used (GramJS is large and the daemon rarely needs it).
import type { Secrets } from '../secrets/secrets.ts';
import type { Logger } from '../util/log.ts';

/** The StringSession of the signed-in account. */
export const TELEGRAM_SESSION_SECRET = 'telegram.session';
/** Who is signed in ("@handle · Name"), for the status line only. */
export const TELEGRAM_ACCOUNT_SECRET = 'telegram.account';
/** The owner's app credentials from my.telegram.org (or APPLYANT_TELEGRAM_API_ID / _HASH). */
export const TELEGRAM_API_ID_SECRET = 'telegram.api_id';
export const TELEGRAM_API_HASH_SECRET = 'telegram.api_hash';

export class TelegramError extends Error {}

/** One post as MTProto gives it. */
export interface TelegramMessage {
  id: number;
  message: string;
  /** Unix seconds. */
  date: number;
}

export interface SignInCallbacks {
  phoneNumber(): Promise<string>;
  phoneCode(): Promise<string>;
  password(hint?: string): Promise<string>;
  onError(err: Error): Promise<boolean> | boolean | undefined;
}

/** The GramJS calls Applyant makes. */
export interface TelegramClientLike {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  /** GramJS `client.start`: runs the whole sign-in through the callbacks. */
  start(cb: SignInCallbacks): Promise<unknown>;
  getMe(): Promise<{ username?: string | null; firstName?: string | null; phone?: string | null }>;
  getMessages(peer: string, o: { limit: number }): Promise<TelegramMessage[]>;
  sendMessage(peer: string, o: { message: string }): Promise<{ id: number }>;
  sendFile(
    peer: string,
    o: { file: string; caption?: string; forceDocument?: boolean },
  ): Promise<{ id: number }>;
  /** The StringSession, once signed in. */
  saveSession(): string;
}

export type TelegramClientFactory = (o: {
  session: string;
  apiId: number;
  apiHash: string;
}) => Promise<TelegramClientLike>;

/** The real GramJS client, wrapped to `TelegramClientLike`. */
export const gramjsClient: TelegramClientFactory = async ({ session, apiId, apiHash }) => {
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const { LogLevel } = await import('telegram/extensions/Logger.js');
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });
  client.setLogLevel(LogLevel.NONE);
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    start: (cb) =>
      client.start({
        phoneNumber: cb.phoneNumber,
        phoneCode: cb.phoneCode,
        password: cb.password,
        onError: async (err) => (await cb.onError(err)) ?? false,
      }),
    async getMe() {
      const me = await client.getMe();
      return {
        username: me.username ?? null,
        firstName: me.firstName ?? null,
        phone: me.phone ?? null,
      };
    },
    async getMessages(peer, o) {
      const list = await client.getMessages(peer, { limit: o.limit });
      return list.map((m) => ({ id: m.id, message: m.message ?? '', date: m.date ?? 0 }));
    },
    async sendMessage(peer, o) {
      const m = await client.sendMessage(peer, { message: o.message });
      return { id: m.id };
    },
    async sendFile(peer, o) {
      const m = await client.sendFile(peer, {
        file: o.file,
        ...(o.caption !== undefined ? { caption: o.caption } : {}),
        forceDocument: o.forceDocument ?? true,
      });
      return { id: m.id };
    },
    saveSession: () => String(client.session.save()),
  };
};

/** The account as the app and CLI show it. */
export interface TelegramStatus {
  state: 'disconnected' | 'waiting_code' | 'waiting_password' | 'connected';
  account: string | null;
  /** Whether the app credentials (api id + hash) are there. */
  apiConfigured: boolean;
  note: string | null;
}

/** What handlers use: the channel reader for private channels and the Telegram channel. */
export interface TelegramAccess {
  /** A signed-in client, or null when no account is connected. The caller disconnects. */
  open(): Promise<TelegramClientLike | null>;
}

class Deferred<T> {
  resolve!: (v: T) => void;
  reject!: (e: Error) => void;
  readonly promise = new Promise<T>((res, rej) => {
    this.resolve = res;
    this.reject = rej;
  });
}

interface PendingSignIn {
  client: TelegramClientLike;
  code: Deferred<string>;
  password: Deferred<string>;
  /** Settles when the flow stops asking: the next state, or the error. */
  step: Deferred<TelegramStatus['state']>;
  hint: string | null;
}

export interface TelegramServiceOptions {
  secrets: Secrets;
  log?: Logger;
  client?: TelegramClientFactory;
  env?: NodeJS.ProcessEnv;
}

/**
 * The account: sign-in (one flow at a time, kept in memory between the RPC calls that answer
 * it), status and sign-out. Only the session string is kept, in `Secrets`.
 */
export class TelegramService implements TelegramAccess {
  private readonly o: TelegramServiceOptions;
  private pending: PendingSignIn | null = null;
  private lastNote: string | null = null;

  constructor(o: TelegramServiceOptions) {
    this.o = o;
  }

  private get factory(): TelegramClientFactory {
    return this.o.client ?? gramjsClient;
  }

  private async api(): Promise<{ apiId: number; apiHash: string } | null> {
    const env = this.o.env ?? process.env;
    const id = env.APPLYANT_TELEGRAM_API_ID ?? (await this.o.secrets.get(TELEGRAM_API_ID_SECRET));
    const hash =
      env.APPLYANT_TELEGRAM_API_HASH ?? (await this.o.secrets.get(TELEGRAM_API_HASH_SECRET));
    const apiId = Number(id);
    if (!id || !hash || !Number.isInteger(apiId) || apiId <= 0) return null;
    return { apiId, apiHash: hash.trim() };
  }

  async status(): Promise<TelegramStatus> {
    const apiConfigured = (await this.api()) !== null;
    if (this.pending) {
      return {
        state: this.pendingState ?? 'waiting_code',
        account: null,
        apiConfigured,
        note: this.pending.hint ? `password hint: ${this.pending.hint}` : this.lastNote,
      };
    }
    const session = await this.o.secrets.get(TELEGRAM_SESSION_SECRET);
    return {
      state: session ? 'connected' : 'disconnected',
      account: session ? await this.o.secrets.get(TELEGRAM_ACCOUNT_SECRET) : null,
      apiConfigured,
      note: this.lastNote,
    };
  }

  private pendingState: TelegramStatus['state'] | null = null;

  /**
   * Starts signing in: Telegram sends a code to the account's other sessions (or by SMS).
   * `apiId`/`apiHash` are stored first when given.
   */
  async startSignIn(
    phone: string,
    creds: { apiId?: string | null; apiHash?: string | null } = {},
  ): Promise<TelegramStatus> {
    const number = phone.replace(/[\s()-]/g, '');
    if (!/^\+?\d{7,15}$/.test(number)) {
      throw new TelegramError(`"${phone}" isn't a phone number (+<country><number>)`);
    }
    if (creds.apiId?.trim()) await this.o.secrets.set(TELEGRAM_API_ID_SECRET, creds.apiId.trim());
    if (creds.apiHash?.trim()) {
      await this.o.secrets.set(TELEGRAM_API_HASH_SECRET, creds.apiHash.trim());
    }
    const api = await this.api();
    if (!api) {
      throw new TelegramError(
        'Telegram needs an api id and hash from my.telegram.org (API development tools) first',
      );
    }
    await this.cancel();
    const client = await this.factory({ session: '', ...api });
    const p: PendingSignIn = {
      client,
      code: new Deferred(),
      password: new Deferred(),
      step: new Deferred(),
      hint: null,
    };
    this.pending = p;
    this.pendingState = 'waiting_code';
    this.lastNote = null;
    client
      .start({
        phoneNumber: async () => number,
        phoneCode: async () => {
          this.pendingState = 'waiting_code';
          p.step.resolve('waiting_code');
          return p.code.promise;
        },
        password: async (hint) => {
          p.hint = hint ?? null;
          this.pendingState = 'waiting_password';
          p.step.resolve('waiting_password');
          return p.password.promise;
        },
        // Any error ends the flow (a wrong code is asked again only by starting over).
        onError: (err) => {
          p.step.reject(err);
          return true;
        },
      })
      .then(async () => {
        await this.finish(p);
      })
      .catch((err: Error) => {
        this.lastNote = `sign-in failed: ${err.message}`;
        p.step.reject(err);
        if (this.pending === p) this.drop();
      });
    return this.wait(p);
  }

  private async finish(p: PendingSignIn): Promise<void> {
    const me = await p.client.getMe().catch(() => null);
    const account =
      [me?.username ? `@${me.username}` : null, me?.firstName ?? null]
        .filter(Boolean)
        .join(' · ') || (me?.phone ? `+${me.phone}` : 'your account');
    await this.o.secrets.set(TELEGRAM_SESSION_SECRET, p.client.saveSession());
    await this.o.secrets.set(TELEGRAM_ACCOUNT_SECRET, account);
    this.lastNote = null;
    await p.client.disconnect().catch(() => {});
    if (this.pending === p) {
      this.pending = null;
      this.pendingState = null;
    }
    p.step.resolve('connected');
    this.o.log?.info('telegram: signed in', { account });
  }

  private drop(): void {
    const p = this.pending;
    this.pending = null;
    this.pendingState = null;
    if (p) void p.client.disconnect().catch(() => {});
  }

  private async wait(p: PendingSignIn): Promise<TelegramStatus> {
    try {
      await p.step.promise;
    } catch (err) {
      throw new TelegramError(`Telegram sign-in: ${(err as Error).message}`);
    }
    return this.status();
  }

  /** Answers the code Telegram sent. */
  async submitCode(code: string): Promise<TelegramStatus> {
    const p = this.pending;
    if (!p || this.pendingState !== 'waiting_code') {
      throw new TelegramError('no Telegram sign-in is waiting for a code; start one first');
    }
    p.step = new Deferred();
    p.code.resolve(code.replace(/\s/g, ''));
    return this.wait(p);
  }

  /** Answers the account's two-step verification password. */
  async submitPassword(password: string): Promise<TelegramStatus> {
    const p = this.pending;
    if (!p || this.pendingState !== 'waiting_password') {
      throw new TelegramError('no Telegram sign-in is waiting for a password');
    }
    p.step = new Deferred();
    p.password.resolve(password);
    return this.wait(p);
  }

  /** Stops a sign-in that is waiting. */
  async cancel(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    p.code.reject(new Error('cancelled'));
    p.password.reject(new Error('cancelled'));
    this.drop();
  }

  /** Signs out of Applyant only: the stored session is deleted (the account itself is untouched). */
  async disconnect(): Promise<TelegramStatus> {
    await this.cancel();
    await this.o.secrets.delete(TELEGRAM_SESSION_SECRET);
    await this.o.secrets.delete(TELEGRAM_ACCOUNT_SECRET);
    this.lastNote = null;
    return this.status();
  }

  async open(): Promise<TelegramClientLike | null> {
    const session = await this.o.secrets.get(TELEGRAM_SESSION_SECRET);
    const api = await this.api();
    if (!session || !api) return null;
    const client = await this.factory({ session, ...api });
    await client.connect();
    return client;
  }
}
