// Plain HTTP GETs for readers: a timeout, an honest User-Agent, and errors that say what failed.
import type { Fetch } from './types.ts';

export const USER_AGENT = 'Applyant/0.1 (a personal job-search tool; one candidate)';
const TIMEOUT_MS = 30_000;
/** Lists larger than this are not read (a misconfigured source must not exhaust memory). */
const MAX_BYTES = 20_000_000;

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface Fetched {
  status: number;
  url: string;
  contentType: string;
  text: string;
}

/** GETs a URL; non-2xx statuses throw HttpError unless listed in `allow`. */
export async function get(
  fetch: Fetch,
  url: string,
  signal: AbortSignal,
  o: { accept?: string; allow?: number[] } = {},
): Promise<Fetched> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: o.accept ?? '*/*' },
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!res.ok && !(o.allow ?? []).includes(res.status)) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(res.status, url);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${url} returned more than ${MAX_BYTES} bytes`);
  return {
    status: res.status,
    url: res.url || url,
    contentType: res.headers.get('content-type') ?? '',
    text,
  };
}

export async function getJson<T = unknown>(
  fetch: Fetch,
  url: string,
  signal: AbortSignal,
  o: { allow?: number[] } = {},
): Promise<{ status: number; data: T | null }> {
  const res = await get(fetch, url, signal, { accept: 'application/json', ...o });
  if (res.status >= 400) return { status: res.status, data: null };
  try {
    return { status: res.status, data: JSON.parse(res.text) as T };
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
}

/** A fetch that refuses everything: the default in tests, so nothing reaches the network. */
export const noNetwork: Fetch = async (url) => {
  throw new Error(`no network here (tried ${url})`);
};
