// Telegram job channels as a source (phase 15).
//
//   public channel    its web preview, https://t.me/s/<channel>: plain HTML, no login, the
//                     latest ~20 posts. The page is turned into linked text (phase 11's form:
//                     each link's address after it as <…>) and read by the built-in textPattern
//                     recipe below, one match per post.
//   private channel   the candidate's own account over MTProto (integrations/gramjs.ts), when
//                     one is connected: the channel's latest posts.
//   posts → postings  the extractor judges the posts not judged before, in one call: which are
//                     job postings, and for those the role, company, salary, location and the
//                     contact. Posts that aren't jobs (ads, news, digests) are skipped. What it
//                     said is kept on the source (`resolved.posts`), so a post is judged once.
//
// A channel shows its latest posts, never all of them: the list is never complete, so absence
// never closes a posting (a deleted post is found by verification instead).

import { telegramContactUrl } from '../../../channels/telegram.ts';
import type { TelegramPostVerdict } from '../../../db/schema.ts';
import type { TelegramAccess } from '../../../integrations/gramjs.ts';
import type { ListingRecipe } from '../recipes/types.ts';
import { decodeEntities, type Listing, type ReaderContext, type ReaderRun } from './types.ts';

/** One post, as the preview or MTProto gives it. */
export interface TelegramPost {
  /** The post's number in its channel. */
  id: string;
  /** https://t.me/<channel>/<id>: the posting's own page. */
  url: string;
  /** The post's text, with each link's address after it as <…>. */
  text: string;
  postedAt: string | null;
}

/** What the extractor said about a batch of posts: a verdict per job post, null for the rest. */
export type JudgePosts = (
  channel: string,
  posts: TelegramPost[],
) => Promise<Map<string, TelegramPostVerdict | null>>;

/** What a Telegram read needs besides the ordinary reader context. */
export interface TelegramReading {
  judge: JudgePosts;
  /** The candidate's account (private channels), or null when none is connected. */
  account: TelegramAccess | null;
}

/** Posts judged per read at most (the preview shows about 20). */
export const MAX_POSTS_PER_READ = 30;
/** Verdicts kept on the source: enough to cover what the preview still shows. */
const KEEP_VERDICTS = 200;

const CHANNEL = /^[a-z][a-z0-9_]{3,31}$/i;

/**
 * A channel as the candidate or the planner writes it: `@name`, `name`, `t.me/name`,
 * `https://t.me/s/name`, a post link, or a private invite (`t.me/+hash`, `t.me/joinchat/hash`),
 * which only the connected account can read. Returns the source's locator (`name` or `+hash`).
 */
export function telegramChannelOf(input: string): string | null {
  const s = input.trim();
  const at = /^@?([a-z][a-z0-9_]{3,31})$/i.exec(s);
  if (at?.[1]) return at[1];
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const [first, second] = parts;
  if (!first) return null;
  if (first.startsWith('+') && first.length > 5) return first;
  if (first === 'joinchat' && second) return `+${second}`;
  const name = first === 's' ? second : first;
  return name && CHANNEL.test(name) ? name : null;
}

export function isPrivateChannel(locator: string): boolean {
  return locator.startsWith('+');
}

export function previewUrl(channel: string): string {
  return `https://t.me/s/${channel}`;
}

/**
 * The preview's built-in recipe. It runs over `previewText`, where each post is a block
 * `[post <url> <time>]` + its linked text + `[/post]`: group 1 is the post's link, group 3 its
 * text (the "title" the extractor turns into a role).
 */
export const TELEGRAM_PREVIEW_RECIPE: Extract<ListingRecipe, { kind: 'textPattern' }> = {
  kind: 'textPattern',
  pattern: '^\\[post (https://t\\.me/\\S+) (\\S+)\\]\\n([\\s\\S]*?)\\n\\[/post\\]$',
  flags: 'gm',
  groups: { title: 3, url: 1, location: null },
};

/** HTML → linked text: links become `text <href>`, line breaks stay, tags go. */
function linked(html: string): string {
  // Link addresses are held as \uE000…\uE001 while tags are stripped (they look like tags).
  return decodeEntities(
    html
      .replace(/<i class="emoji"[^>]*>(.*?)<\/i>/gi, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(
        /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, text: string) => {
          const label = text.replace(/<[^>]+>/g, '').trim();
          const url = decodeEntities(href);
          // Hashtag links (`?q=%23python`) are just the tag.
          if (url.startsWith('?')) return label;
          return label && label !== url ? `${label} \uE000${url}\uE001` : `\uE000${url}\uE001`;
        },
      )
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\uE000/g, '<')
    .replace(/\uE001/g, '>')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * The preview page as the recipe reads it: one block per post (its link, time, text, and the
 * post's link buttons, which is where "Apply" links often are). Posts with no text are left out.
 */
export function previewText(html: string): string {
  const blocks: string[] = [];
  const parts = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  for (const part of parts) {
    const post = /data-post="([^"/]+)\/(\d+)"/.exec(part);
    if (!post) continue;
    const body = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(part);
    const text = body?.[1] ? linked(body[1]) : '';
    if (!text) continue;
    const time = /<time[^>]*datetime="([^"]+)"/.exec(part)?.[1] ?? '-';
    const buttons = [
      ...part.matchAll(
        /<a class="tgme_widget_message_inline_button[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      ),
    ].map((m) => `${linked(m[2] ?? '')} <${decodeEntities(m[1] ?? '')}>`);
    const lines = [text, ...buttons].join('\n').replace(/^\[\/?post\b/gm, '($&');
    blocks.push(`[post https://t.me/${post[1]}/${post[2]} ${time}]\n${lines}\n[/post]`);
  }
  return blocks.join('\n');
}

/** Runs a textPattern recipe over text (the built-in, trusted pattern: in-process is fine). */
export function matchPosts(
  text: string,
  recipe: Extract<ListingRecipe, { kind: 'textPattern' }> = TELEGRAM_PREVIEW_RECIPE,
): TelegramPost[] {
  const flags = recipe.flags.includes('g') ? recipe.flags : `${recipe.flags}g`;
  const out: TelegramPost[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(recipe.pattern, flags))) {
    const url = recipe.groups.url !== null ? m[recipe.groups.url] : null;
    const body = m[recipe.groups.title]?.trim();
    const id = url ? /\/(\d+)$/.exec(url)?.[1] : null;
    if (!url || !id || !body || seen.has(url)) continue;
    seen.add(url);
    const time = m[2] && m[2] !== '-' ? m[2] : null;
    out.push({ id, url, text: body, postedAt: time });
  }
  return out;
}

/** The posts on a channel's preview page, oldest first as the page shows them. */
export function previewPosts(html: string): TelegramPost[] {
  return matchPosts(previewText(html));
}

async function readPreview(channel: string, ctx: ReaderContext): Promise<TelegramPost[]> {
  const res = await ctx.fetch(previewUrl(channel), {
    signal: ctx.signal,
    headers: { 'accept-language': 'en' },
    redirect: 'manual',
  });
  // t.me/s/<name> redirects to t.me/<name> when the channel has no public preview.
  if (res.status >= 300 && res.status < 400) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status} ${previewUrl(channel)}`);
  return previewPosts(await res.text());
}

async function readAccount(
  locator: string,
  account: TelegramAccess | null,
): Promise<TelegramPost[] | null> {
  const client = await account?.open();
  if (!client) return null;
  try {
    const peer = isPrivateChannel(locator) ? `https://t.me/${locator}` : locator;
    const list = await client.getMessages(peer, { limit: MAX_POSTS_PER_READ });
    const base = isPrivateChannel(locator) ? null : `https://t.me/${locator}`;
    return list
      .filter((m) => m.message.trim())
      .map((m) => ({
        id: String(m.id),
        // A private channel's posts have no public page; the invite link + id stays unique.
        url: `${base ?? `https://t.me/${locator}`}/${m.id}`,
        text: m.message.trim(),
        postedAt: m.date ? new Date(m.date * 1000).toISOString() : null,
      }))
      .reverse();
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Where to apply for a job post: its own job page, else an address, else the Telegram contact. */
export function applyUrlOf(v: { applyUrl: string | null; contact: string | null }): string | null {
  const link = v.applyUrl?.trim().replace(/^<|>$/g, '') ?? '';
  if (/^https?:\/\//i.test(link)) {
    const tg = telegramContactUrl(link);
    if (tg) return tg;
    if (!/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i.test(link)) return link;
  }
  const contact = v.contact?.trim() ?? '';
  const email = /^(?:mailto:)?([^@\s<>]+@[^@\s<>]+\.[a-z]{2,})$/i.exec(contact)?.[1];
  if (email) return `mailto:${email}`;
  return telegramContactUrl(contact);
}

/** The listing text: the extractor's fields first (the scorer reads salary from here), then the post. */
function listingText(v: TelegramPostVerdict, post: TelegramPost): string {
  const head = [
    `Role: ${v.role}`,
    v.company ? `Company: ${v.company}` : null,
    v.salary ? `Salary: ${v.salary}` : null,
    v.location ? `Location: ${v.location}` : null,
    v.contact ? `Contact: ${v.contact}` : null,
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${post.text}`;
}

function toListing(channel: string, post: TelegramPost, v: TelegramPostVerdict): Listing {
  const tags = [...post.text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]).join(' ');
  return {
    url: post.url,
    sourceUrl: post.url,
    externalId: `telegram:${channel}/${post.id}`,
    title: v.role,
    company: v.company,
    location: v.location,
    remote: v.remote,
    team: null,
    description: listingText(v, post),
    applyUrl: v.applyUrl,
    postedAt: post.postedAt,
    matchText: `${v.role} ${tags}`,
  };
}

export interface TelegramRun extends ReaderRun {
  /** The verdicts to keep on the source: the earlier ones plus this read's. */
  posts: Record<string, TelegramPostVerdict | null>;
}

/**
 * Reads a channel: the preview (or the account for a private channel, or a channel with no
 * preview), then the extractor for posts it hasn't judged yet. Job posts become listings.
 */
export async function readTelegram(
  locator: string,
  ctx: ReaderContext,
  known: Record<string, TelegramPostVerdict | null> = {},
): Promise<TelegramRun> {
  const tg = ctx.telegram;
  if (!tg) throw new Error("Telegram channels need the extractor, which isn't available here");
  let posts: TelegramPost[] = [];
  let via = 'preview';
  if (!isPrivateChannel(locator)) posts = await readPreview(locator, ctx);
  if (posts.length === 0) {
    const mine = await readAccount(locator, tg.account);
    if (mine === null) {
      throw new Error(
        isPrivateChannel(locator)
          ? 'a private channel: connect your Telegram account to read it (Settings → Telegram)'
          : `t.me/s/${locator} shows no posts (a private channel, or not a channel): connect your Telegram account to read it`,
      );
    }
    posts = mine;
    via = 'your account';
  }
  posts = posts.slice(-MAX_POSTS_PER_READ);
  const fresh = posts.filter((p) => !(p.id in known));
  const verdicts = { ...known };
  if (fresh.length) {
    const judged = await tg.judge(locator, fresh);
    for (const p of fresh) {
      // A post the extractor didn't answer for is judged again next time.
      if (judged.has(p.id)) verdicts[p.id] = judged.get(p.id) ?? null;
    }
  }
  const listings: Listing[] = [];
  let skipped = 0;
  for (const p of posts) {
    const v = verdicts[p.id];
    if (v) listings.push(toListing(locator, p, v));
    else if (v === null) skipped++;
  }
  const ids = Object.keys(verdicts)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, KEEP_VERDICTS);
  const kept = Object.fromEntries(ids.map((id) => [String(id), verdicts[String(id)] ?? null]));
  const unjudged = posts.length - listings.length - skipped;
  return {
    listings,
    complete: false,
    posts: kept,
    note: `@${locator} (${via}): ${posts.length} posts, ${listings.length} job${listings.length === 1 ? '' : 's'}, ${skipped} not a job${fresh.length ? ` · ${fresh.length} new judged` : ''}${unjudged ? ` · ${unjudged} left for the next read` : ''}`,
  };
}

// ---- The extractor over posts -------------------------------------------------------------

export const TELEGRAM_POSTS_SYSTEM = `You read posts from a Telegram job channel and decide, for each post, whether it is a job posting, and if so extract its facts. A program turns your output into job postings, so be faithful and never invent.

- job: true only when the post offers one specific job or role someone can apply for (a vacancy). false for ads, courses, promotions, news, career advice, channel announcements, digests or lists of several jobs, and people looking for work.
- role: the role title as written (e.g. "Senior Backend Engineer (Python)"). Keep it short; no emojis, hashtags or company.
- company: the hiring company (not the channel, not a recruiting agency's channel name unless it is the employer as stated); null if not stated.
- salary: the stated pay with currency and period exactly as written ("$5000–7000/month", "€80–95k gross"); null if none.
- location: where the work is, as stated ("Remote (EU)", "Berlin, Germany", "Remote, Ukraine"). remote: true / false / null as stated.
- contact: the Telegram @username or email address the post says to write to; null if none. Never the channel itself.
- applyUrl: the link to the job's own page or application form, copied exactly from the <…> after it; null if none. Not the channel, not a hashtag, not an unrelated link.
Answer for every post given, with the post id exactly as given.`;

export function telegramPostsPrompt(channel: string, posts: TelegramPost[]): string {
  return `Channel: @${channel}

${posts.map((p) => `<post ${p.id}>\n${p.text.slice(0, 4000)}\n</post>`).join('\n\n')}`;
}
