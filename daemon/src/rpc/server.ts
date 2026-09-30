// The Connect server on 127.0.0.1, behind a bearer token.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { ApplyantService } from '../gen/applyant/v1/applyant_pb.js';
import type { TelegramService } from '../integrations/gramjs.ts';
import type { MailService } from '../integrations/mail-service.ts';
import type { Secrets } from '../secrets/secrets.ts';
import type { Logger } from '../util/log.ts';
import { agentRunRpcs } from './agent-runs.ts';
import { applicationRpcs } from './applications.ts';
import { candidateRpcs } from './candidate.ts';
import { companyRpcs } from './companies.ts';
import { configRpcs } from './config.ts';
import { cvTemplateRpcs } from './cv-template.ts';
import { interviewRpcs } from './interview.ts';
import { mailRpcs } from './mail.ts';
import { overviewRpcs } from './overview.ts';
import { type PlatformServices, platformRpcs } from './platforms.ts';
import { postingRpcs, type RpcContext } from './postings.ts';
import { prefsRpcs } from './prefs.ts';
import { searchRpcs } from './search.ts';
import { secretRpcs } from './secrets.ts';
import { type SetupContext, setupRpcs } from './setup.ts';
import { telegramRpcs } from './telegram.ts';

export interface RpcServerOptions extends RpcContext {
  secrets: Secrets;
  setup: SetupContext;
  /** The mailbox (phase 13); null in tests that don't need it. */
  mail?: MailService | null;
  /** LinkedIn/Xing guardrails, the sign-in window, the captcha key (phase 14). */
  platforms?: PlatformServices | null;
  /** The candidate's Telegram account (phase 15). */
  telegram?: TelegramService | null;
  /** $APPLYANT_HOME/cv-template/ (Settings → CV template); null: only the bundled one. */
  cvTemplateDir?: string | null;
  token: string;
  host: string;
  port: number;
  log: Logger;
}

export interface RpcServer {
  port: number;
  close(): Promise<void>;
}

export function bearerAuth(token: string): Interceptor {
  const expected = Buffer.from(`Bearer ${token}`);
  return (next) => async (req) => {
    const got = Buffer.from(req.header.get('authorization') ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      throw new ConnectError('missing or wrong bearer token', Code.Unauthenticated);
    }
    return next(req);
  };
}

/**
 * Logs what a handler threw that isn't a ConnectError: the client only sees "internal error",
 * so without this the cause is lost.
 */
export function logInternalErrors(log: Logger): Interceptor {
  return (next) => async (req) => {
    try {
      return await next(req);
    } catch (err) {
      if (!(err instanceof ConnectError)) {
        log.error('rpc failed', {
          method: req.method.name,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      }
      throw err;
    }
  };
}

export async function startRpcServer(o: RpcServerOptions): Promise<RpcServer> {
  const handler = connectNodeAdapter({
    interceptors: [bearerAuth(o.token), logInternalErrors(o.log)],
    routes: (router) =>
      router.service(ApplyantService, {
        ...postingRpcs(o),
        ...candidateRpcs(o),
        ...interviewRpcs(o),
        ...applicationRpcs(o),
        ...prefsRpcs(o),
        ...searchRpcs(o),
        ...companyRpcs(o),
        ...mailRpcs({ ...o, mail: o.mail ?? null }),
        ...platformRpcs(o.platforms ?? null),
        ...telegramRpcs(o.telegram ?? null),
        ...configRpcs(o),
        ...overviewRpcs(o),
        ...agentRunRpcs(o),
        ...cvTemplateRpcs(o.cvTemplateDir ?? null),
        ...secretRpcs(o.secrets),
        ...setupRpcs({ ...o.setup, db: o.db, bus: o.bus, now: o.now }),
      }),
  });
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  o.log.info('rpc listening', { host: o.host, port });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Streams (WatchEvents) keep connections open; end them so close() finishes.
        server.closeAllConnections();
      }),
  };
}
