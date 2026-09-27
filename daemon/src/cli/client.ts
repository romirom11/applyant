// The CLI's connection to applyantd, from the endpoint file the daemon writes.
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { loadConfig } from '../config.ts';
import { readEndpoint } from '../endpoint.ts';
import { ApplyantService } from '../gen/applyant/v1/applyant_pb.js';

export type ApplyantClient = Client<typeof ApplyantService>;

export class CliError extends Error {}

export function connect(): ApplyantClient {
  const config = loadConfig();
  const endpoint = readEndpoint(config.endpointFile);
  if (!endpoint) {
    throw new CliError(
      `applyantd isn't running for ${config.home} (no ${config.endpointFile}). Start it with \`applyantd\`.`,
    );
  }
  const auth: Interceptor = (next) => (req) => {
    req.header.set('authorization', `Bearer ${endpoint.token}`);
    return next(req);
  };
  const transport = createConnectTransport({
    baseUrl: `http://${endpoint.host}:${endpoint.port}`,
    httpVersion: '1.1',
    interceptors: [auth],
  });
  return createClient(ApplyantService, transport);
}

/** Turns transport errors into one readable line. */
export function describeError(err: unknown): string {
  if (err instanceof CliError) return err.message;
  if (err instanceof ConnectError) {
    if (err.code === Code.Unavailable || /ECONNREFUSED/.test(err.message)) {
      return 'applyantd is not reachable (is it running?)';
    }
    return err.rawMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
