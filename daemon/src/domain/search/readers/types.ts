// What every search reader returns. A reader fetches a source's list and nothing else: which
// listings a strategy wants, and which postings they are, is decided after (handlers.ts,
// dedupe.ts). Posting text is read at verification, not here.
import type { ReaderPool } from '../../../browser/reader-pool.ts';
import type { PlatformAccess } from './platform.ts';
import type { TelegramReading } from './telegram.ts';

/** One job as a source lists it. */
export interface Listing {
  /** The posting's own page, which verification opens: an ATS job page when the source links one. */
  url: string;
  /** Where the source lists it (a board's page, an HN comment); often the same as `url`. */
  sourceUrl: string;
  /** The source's own id for it (ATS job id, board id); absence is judged by this. */
  externalId: string | null;
  title: string;
  company: string | null;
  location: string | null;
  /** The source says remote (true) or on-site/hybrid (false); null when it doesn't say. */
  remote: boolean | null;
  team: string | null;
  /** Plain-text description, when the list carries one (dedupe compares them). */
  description: string | null;
  /** Where to apply, when the source gives a separate link (boards linking to an ATS). */
  applyUrl: string | null;
  postedAt: string | null;
  /** Text a strategy's queries are matched against instead of the title (HN: the first line). */
  matchText?: string | null;
}

/**
 * A reader's result. `complete` is true only when the source gives its full list (a feed, an
 * ATS list API) AND the read finished: only then does absence from it close a posting.
 */
export interface ReaderRun {
  listings: Listing[];
  complete: boolean;
  /** What the read did ("GitLab on Greenhouse: 198 jobs"), or why it is partial. */
  note: string | null;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReaderContext {
  fetch: Fetch;
  signal: AbortSignal;
  /** The strategy's queries: boards that search server-side get them; lists ignore them. */
  queries: string[];
  /** The headless reader, for career pages that only show their ATS embed once rendered. */
  reader?: ReaderPool | null;
  now: Date;
  /** The strategy's locations (LinkedIn/Xing put the first place in their search). */
  locations?: string[];
  /** LinkedIn/Xing: Applyant's signed-in browser and the platform guardrails (phase 14). */
  platform?: PlatformAccess | null;
  /** Telegram channels (phase 15): the extractor over posts, and the candidate's account. */
  telegram?: TelegramReading | null;
}

/** The longest description kept per listing (dedupe needs a sample, not the whole page). */
export const MAX_DESCRIPTION = 6000;

/** HTML → plain text, for descriptions in list APIs (no DOM needed). */
export function plainText(html: string | null | undefined, max = MAX_DESCRIPTION): string | null {
  if (!html) return null;
  let text = html;
  // Some lists escape their HTML once more (Greenhouse, some boards): tags survive one pass.
  for (let pass = 0; pass < 2; pass++) {
    text = decodeEntities(
      text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        // A cut-off tag at the end of a truncated description.
        .replace(/<[a-z/][^>]*$/i, ''),
    );
    if (!/<\/?[a-z][^>]*>/i.test(text)) break;
  }
  text = text
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text ? text.slice(0, max) : null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  euro: '€',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Trims, and turns an empty string into null. */
export function str(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s : null;
}
