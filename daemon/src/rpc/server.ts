// The Connect server on 127.0.0.1, behind a bearer token.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { ApplyantService } from '../gen/applyant/v1/applyant_pb.js';
import type { Secrets } from '../secrets/secrets.ts';
import type { Logger } from '../util/log.ts';
import { applicationRpcs } from './applications.ts';
import { candidateRpcs } from './candidate.ts';
import { interviewRpcs } from './interview.ts';
import { postingRpcs, type RpcContext } from './postings.ts';
import { prefsRpcs } from './prefs.ts';
import { secretRpcs } from './secrets.ts';
import { type SetupContext, setupRpcs } from './setup.ts';

export interface RpcServerOptions extends RpcContext {
  secrets: Secrets;
  setup: SetupContext;
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

export async function startRpcServer(o: RpcServerOptions): Promise<RpcServer> {
  const handler = connectNodeAdapter({
    interceptors: [bearerAuth(o.token)],
    routes: (router) =>
      router.service(ApplyantService, {
        ...postingRpcs(o),
        ...candidateRpcs(o),
        ...interviewRpcs(o),
        ...applicationRpcs(o),
        ...prefsRpcs(o),
        ...secretRpcs(o.secrets),
        ...setupRpcs(o.setup),
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
