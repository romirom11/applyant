// Gmail through its REST API (Google accounts), behind the one Mailbox interface. Plain fetch
// over the four endpoints needed instead of `googleapis` (a very large package for this).
//   first sync     messages.list q=after:<since> → each message (format=raw); cursor = profile historyId
//   later syncs    history.list startHistoryId=<cursor> (messageAdded, INBOX) → the new messages
//   history gone   (404: the cursor is older than Gmail keeps) → the date window again
//   send           messages.send { raw } (the composed MIME message)
import type { GoogleAuth } from './google-oauth.ts';
import {
  type Cursor,
  composeMessage,
  type Mailbox,
  MailboxError,
  type MailMessage,
  type OutgoingMessage,
  parseMessage,
  type SentReceipt,
  type SyncOptions,
} from './mailbox.ts';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

type FetchFn = typeof fetch;

export class GmailMailbox implements Mailbox {
  readonly address: string;
  private readonly o: { auth: Pick<GoogleAuth, 'accessToken'>; api: string; fetch: FetchFn };

  constructor(o: {
    address: string;
    auth: Pick<GoogleAuth, 'accessToken'>;
    api?: string;
    fetch?: FetchFn;
  }) {
    this.address = o.address;
    this.o = { auth: o.auth, api: o.api ?? GMAIL_API, fetch: o.fetch ?? fetch };
  }

  private async call<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<{ status: number; json: T }> {
    const token = await this.o.auth.accessToken();
    const res = await this.o.fetch(`${this.o.api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok && res.status !== 404) {
      const msg = (json as { error?: { message?: string } }).error?.message;
      throw new MailboxError(
        `Gmail ${path.split('?')[0]}: HTTP ${res.status}${msg ? ` ${msg}` : ''}`,
      );
    }
    return { status: res.status, json };
  }

  /** The account's address (connect uses it). */
  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return (await this.call<{ emailAddress: string; historyId: string }>('/profile')).json;
  }

  async sync(cursor: Cursor, s: SyncOptions): Promise<{ messages: MailMessage[]; next: Cursor }> {
    const limit = s.limit ?? 500;
    let ids: string[] | null = null;
    let next: string | null = null;
    if (cursor) {
      const found: string[] = [];
      let page: string | undefined;
      let latest = cursor;
      let gone = false;
      do {
        const q = new URLSearchParams({
          startHistoryId: cursor,
          historyTypes: 'messageAdded',
          labelId: 'INBOX',
          ...(page ? { pageToken: page } : {}),
        });
        const { status, json } = await this.call<{
          history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
          historyId?: string;
          nextPageToken?: string;
        }>(`/history?${q}`, {}, s.signal);
        if (status === 404) {
          gone = true;
          break;
        }
        for (const h of json.history ?? []) {
          for (const m of h.messagesAdded ?? []) found.push(m.message.id);
        }
        if (json.historyId) latest = json.historyId;
        page = json.nextPageToken;
      } while (page);
      if (!gone) {
        ids = [...new Set(found)];
        next = latest;
      }
    }
    if (ids === null) {
      next = (await this.profile()).historyId;
      const found: string[] = [];
      let page: string | undefined;
      const after = Math.floor(s.since.getTime() / 1000);
      do {
        const q = new URLSearchParams({
          q: `after:${after} in:inbox`,
          maxResults: '100',
          ...(page ? { pageToken: page } : {}),
        });
        const { json } = await this.call<{
          messages?: Array<{ id: string }>;
          nextPageToken?: string;
        }>(`/messages?${q}`, {}, s.signal);
        for (const m of json.messages ?? []) found.push(m.id);
        page = found.length < limit ? json.nextPageToken : undefined;
      } while (page);
      ids = found;
    }
    const messages: MailMessage[] = [];
    for (const id of ids.slice(0, limit)) {
      s.signal?.throwIfAborted();
      const { status, json } = await this.call<{ raw?: string }>(
        `/messages/${encodeURIComponent(id)}?format=raw`,
        {},
        s.signal,
      );
      if (status === 404 || !json.raw) continue;
      messages.push(await parseMessage(id, Buffer.from(json.raw, 'base64url')));
    }
    messages.sort((a, b) => a.date.getTime() - b.date.getTime());
    return { messages, next };
  }

  async send(msg: OutgoingMessage): Promise<SentReceipt> {
    const { raw, messageId } = await composeMessage(this.address, msg);
    await this.call('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: raw.toString('base64url') }),
    });
    return { messageId, raw, accepted: [msg.to] };
  }
}
