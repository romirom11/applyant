// Google sign-in for a "Desktop app" OAuth client: the installed-app flow (RFC 8252). The
// consent opens in the system browser, Google redirects to a one-shot loopback listener on
// 127.0.0.1, and the code is exchanged with a PKCE verifier. One consent covers Gmail
// (read + send) and Calendar (interview events), so the candidate clicks through Google's
// "unverified app" screen once. Drive isn't asked for: a document is added as a downloaded file. Tokens go to `Secrets` (the Keychain on the Mac).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Secrets } from '../secrets/secrets.ts';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
] as const;

/** Where the tokens are kept in `Secrets`. */
export const GOOGLE_TOKENS_SECRET = 'google.oauth';
/** The client secret of the owner's Desktop client (not confidential for installed apps). */
export const GOOGLE_CLIENT_SECRET_SECRET = 'google.client_secret';

export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

export interface GoogleClient extends GoogleEndpoints {
  clientId: string;
  /** Google issues one to Desktop clients and expects it at the token endpoint. */
  clientSecret: string | null;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
  scope: string;
}

export class GoogleAuthError extends Error {}

type FetchFn = typeof fetch;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface Consent {
  /** Open this in the system browser. */
  url: string;
  /** The loopback redirect the listener waits on. */
  redirectUri: string;
  /** Resolves with stored tokens once Google redirects back (or rejects: denied, timeout). */
  done: Promise<GoogleTokens>;
  cancel(): void;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,sans-serif;margin:3em"><h2>${title}</h2><p>${body}</p></body>`;

/**
 * Starts the consent: a listener on 127.0.0.1 (a free port) and the URL to open. The listener
 * takes exactly one redirect with the right `state`, exchanges the code, stores the tokens and
 * closes. Nothing is stored when the candidate declines.
 */
export async function startGoogleConsent(o: {
  client: GoogleClient;
  secrets: Secrets;
  fetch?: FetchFn;
  timeoutMs?: number;
  now?: () => number;
}): Promise<Consent> {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  let settle!: { resolve(t: GoogleTokens): void; reject(e: Error): void };
  const done = new Promise<GoogleTokens>((resolve, reject) => {
    settle = { resolve, reject };
  });
  let finished = false;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/' || finished) {
      res.writeHead(404).end();
      return;
    }
    const error = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end(PAGE('Applyant', 'This sign-in link is not the one Applyant started.'));
      return;
    }
    finished = true;
    const end = (ok: boolean, text: string) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE(ok ? 'Applyant is connected to Google' : 'Google sign-in failed', text));
      close();
    };
    if (error || !code) {
      end(false, `Google said: ${error ?? 'no code'}. You can close this window.`);
      settle.reject(
        new GoogleAuthError(`Google sign-in was not completed (${error ?? 'no code'})`),
      );
      return;
    }
    exchangeCode({ client: o.client, code, verifier, redirectUri, fetch: doFetch, now })
      .then(async (tokens) => {
        await storeTokens(o.secrets, tokens);
        end(true, 'You can close this window and go back to Applyant.');
        settle.resolve(tokens);
      })
      .catch((err: Error) => {
        end(false, 'The code could not be exchanged. You can close this window.');
        settle.reject(err);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const timer = setTimeout(
    () => {
      if (finished) return;
      finished = true;
      settle.reject(new GoogleAuthError('Google sign-in timed out'));
      close();
    },
    o.timeoutMs ?? 10 * 60_000,
  );
  timer.unref();
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }

  const url = new URL(o.client.authUrl);
  url.search = new URLSearchParams({
    client_id: o.client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // A refresh token every time, so a re-consent never leaves the daemon without one.
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return {
    url: url.toString(),
    redirectUri,
    done,
    cancel() {
      if (finished) return;
      finished = true;
      settle.reject(new GoogleAuthError('Google sign-in was cancelled'));
      close();
    },
  };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  client: GoogleClient,
  params: Record<string, string>,
  doFetch: FetchFn,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    ...params,
  });
  const res = await doFetch(client.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new GoogleAuthError(
      `Google token endpoint: ${json.error ?? `HTTP ${res.status}`}${json.error_description ? ` (${json.error_description})` : ''}`,
    );
  }
  return json;
}

export async function exchangeCode(o: {
  client: GoogleClient;
  code: string;
  verifier: string;
  redirectUri: string;
  fetch?: FetchFn;
  now?: () => number;
}): Promise<GoogleTokens> {
  const json = await tokenRequest(
    o.client,
    {
      grant_type: 'authorization_code',
      code: o.code,
      code_verifier: o.verifier,
      redirect_uri: o.redirectUri,
    },
    o.fetch ?? fetch,
  );
  if (!json.access_token || !json.refresh_token) {
    throw new GoogleAuthError('Google returned no refresh token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: (o.now ?? Date.now)() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? GOOGLE_SCOPES.join(' '),
  };
}

export async function storeTokens(secrets: Secrets, tokens: GoogleTokens): Promise<void> {
  await secrets.set(GOOGLE_TOKENS_SECRET, JSON.stringify(tokens));
}

export async function loadTokens(secrets: Secrets): Promise<GoogleTokens | null> {
  const raw = await secrets.get(GOOGLE_TOKENS_SECRET);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GoogleTokens;
  } catch {
    return null;
  }
}

/** Access tokens for API calls, refreshed (and stored again) a minute before they expire. */
export class GoogleAuth {
  private readonly o: { client: GoogleClient; secrets: Secrets; fetch: FetchFn; now: () => number };
  private refreshing: Promise<string> | null = null;

  constructor(o: { client: GoogleClient; secrets: Secrets; fetch?: FetchFn; now?: () => number }) {
    this.o = { ...o, fetch: o.fetch ?? fetch, now: o.now ?? Date.now };
  }

  async accessToken(): Promise<string> {
    const tokens = await loadTokens(this.o.secrets);
    if (!tokens)
      throw new GoogleAuthError('Google is not connected: run `applyant mail connect gmail`');
    if (tokens.expiresAt - 60_000 > this.o.now()) return tokens.accessToken;
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(tokens: GoogleTokens): Promise<string> {
    const json = await tokenRequest(
      this.o.client,
      { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
      this.o.fetch,
    );
    if (!json.access_token) throw new GoogleAuthError('Google returned no access token');
    await storeTokens(this.o.secrets, {
      accessToken: json.access_token,
      // Google keeps the refresh token unless it sends a new one.
      refreshToken: json.refresh_token ?? tokens.refreshToken,
      expiresAt: this.o.now() + (json.expires_in ?? 3600) * 1000,
      scope: json.scope ?? tokens.scope,
    });
    return json.access_token;
  }
}
