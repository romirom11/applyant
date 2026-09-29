// verify_posting for a Telegram post (phase 15). The post is the posting's page, but it has no
// form: what it names is where to apply. So:
//
//   the post       still there? (its public embed, t.me/<channel>/<id>?embed=1): deleted → dead.
//                  A private channel's post can't be checked without the account: kept as live.
//   apply path     a job page the post links → verified like any posting (its verdict decides);
//                  an address → the email channel; a @contact → the Telegram channel;
//                  nothing → dead ("names no way to apply").

import { parseTelegramContact } from '../../channels/telegram.ts';
import type { PostingRow } from '../../db/schema.ts';
import { isPrivateChannel, previewPosts } from './readers/telegram.ts';
import type { Fetch } from './readers/types.ts';
import type { Verdict } from './verify.ts';

/** `https://t.me/<channel>/<id>` → its parts; null for any other URL. */
export function telegramPostOf(url: string): { channel: string; id: string } | null {
  const m = /^https:\/\/t\.me\/(\+?[A-Za-z0-9_-]{4,})\/(\d+)$/.exec(url);
  return m?.[1] && m[2] ? { channel: m[1], id: m[2] } : null;
}

/** The post's embed page, which Telegram serves for public channels without a login. */
export function embedUrl(channel: string, id: string): string {
  return `https://t.me/${channel}/${id}?embed=1&mode=tme`;
}

/** The post's text on its embed page; null when the page says the post isn't there. */
export function embedText(html: string): string | null {
  if (/tgme_widget_message_error/.test(html)) return null;
  // The embed page has one message in the preview's markup.
  const wrapped = html.includes('tgme_widget_message_wrap')
    ? html
    : html.replace(
        /<div class="tgme_widget_message /,
        '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message ',
      );
  return previewPosts(wrapped)[0]?.text ?? null;
}

export interface TelegramCheck {
  fetch: Fetch;
  signal: AbortSignal;
  /** The ordinary verification of a web page (the job page a post links). */
  open(url: string): Promise<Verdict>;
}

export async function checkTelegramPost(
  posting: Pick<PostingRow, 'canonicalUrl' | 'applyUrl' | 'title' | 'company' | 'listingText'>,
  o: TelegramCheck,
): Promise<Verdict> {
  const post = telegramPostOf(posting.canonicalUrl);
  if (!post) return { kind: 'dead', note: 'not a Telegram post', title: null, company: null };
  const { title, company } = posting;
  let text = posting.listingText;
  if (!isPrivateChannel(post.channel)) {
    const res = await o.fetch(embedUrl(post.channel, post.id), { signal: o.signal });
    if (res.status === 429 || res.status >= 500) {
      return { kind: 'transient', note: `HTTP ${res.status} ${embedUrl(post.channel, post.id)}` };
    }
    if (!res.ok) return { kind: 'dead', note: `HTTP ${res.status}`, title, company };
    const body = embedText(await res.text());
    if (body === null) {
      return { kind: 'dead', note: 'the Telegram post was deleted', title, company };
    }
    text ??= body;
  }
  const apply = posting.applyUrl;
  if (!apply) {
    return { kind: 'dead', note: 'the post names no way to apply', title, company };
  }
  if (apply.startsWith('mailto:')) {
    return {
      kind: 'live',
      note: `Telegram post; apply by email to ${apply.slice(7)}`,
      title,
      company,
      text,
      jsonLd: null,
      applyUrl: apply,
    };
  }
  const contact = parseTelegramContact(apply);
  if (contact) {
    return {
      kind: 'live',
      note: `Telegram post; apply by writing to @${contact}`,
      title,
      company,
      text,
      jsonLd: null,
      applyUrl: apply,
    };
  }
  // The job's own page: it decides, and its text is the fuller one.
  const page = await o.open(apply);
  if (page.kind !== 'live') {
    return page.kind === 'dead'
      ? { ...page, note: `the post's job page: ${page.note}`, title, company }
      : page;
  }
  return {
    ...page,
    note: `Telegram post → ${page.note}`,
    title: title ?? page.title,
    company: company ?? page.company,
    text: page.text ?? text,
  };
}
