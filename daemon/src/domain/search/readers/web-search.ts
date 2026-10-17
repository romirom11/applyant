// Web search for job pages on the ATSs that have no job search of their own (Greenhouse, Ashby,
// Lever): `site:` queries on Brave Search's result page, and on DuckDuckGo's lite page when Brave
// turns a query away. Bing ignores `site:` for clients like this one; Mojeek, Startpage and
// Qwant answer with a captcha or 403.
//
// Both pages ask automated clients not to read them (robots.txt), so the source built on this
// starts switched off. Switched on, it stays far below a person searching: one query at a time
// across the daemon, PACE_MS apart, at most PER_DAY a day, and an engine that turns a query away
// (HTTP 429, a challenge page) rests for REST_MS. Results are kept for a day (ats-search.ts).
import { get } from './http.ts';
import { sleep } from './shared.ts';
import { decodeEntities, type ReaderContext } from './types.ts';

export type Engine = 'brave' | 'duckduckgo';
export const ENGINES: readonly Engine[] = ['brave', 'duckduckgo'];

export interface SearchHit {
  url: string;
  /** The result's title ("AI Engineer @ Acme"), when the page gives one. */
  title: string | null;
}

export interface WebResult {
  hits: SearchHit[];
  engine: Engine;
}

/** Between two queries to the same engine (Brave answers 429 after a few quick ones). */
export const PACE_MS = 60_000;
/** Queries a day, for every strategy together. */
export const PER_DAY = 40;
/** How long an engine that turned a query away is left alone. */
export const REST_MS = 2 * 3_600_000;

/** No engine takes a query now: the day's budget is spent, or every engine is resting. */
export class NoSearchNow extends Error {}

function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Brave's result page: its web results' links and titles, in order. */
export function braveHits(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const part of html
    .split(/<div class="snippet\b[^"]*"[^>]*\bdata-type="web"[^>]*>/)
    .slice(1)) {
    const href = part.match(/<a href="(https?:\/\/[^"]+)"/)?.[1];
    if (!href) continue;
    const title = part.match(/<div class="title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    out.push({ url: decodeEntities(href), title: title ? text(title) || null : null });
  }
  return out;
}

/** DuckDuckGo's lite page: its result links (behind its redirect) and titles. */
export function duckduckgoHits(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = decodeEntities(m[1] ?? '');
    const target = new URL(
      href.startsWith('//') ? `https:${href}` : href,
      'https://duckduckgo.com',
    ).searchParams.get('uddg');
    if (!target || !/^https?:\/\//.test(target)) continue;
    out.push({ url: target, title: text(m[2] ?? '') || null });
  }
  return out;
}

const SEARCH: Record<Engine, { url: (q: string) => string; hits: (html: string) => SearchHit[] }> =
  {
    brave: {
      url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
      hits: braveHits,
    },
    duckduckgo: {
      url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
      hits: duckduckgoHits,
    },
  };

/** A page that asks for a captcha instead of results: a block, not "nothing found". */
export function challenge(engine: Engine, html: string): boolean {
  return engine === 'duckduckgo'
    ? /anomaly(\.js|-modal)/.test(html)
    : /page:"\/captcha"/.test(html);
}

export interface GateOptions {
  paceMs?: number;
  perDay?: number;
  restMs?: number;
  /** The wall clock (tests move it). */
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The daemon's one way to the engines: queries one at a time, paced, counted per day. */
export class WebSearchGate {
  private readonly paceMs: number;
  private readonly perDay: number;
  private readonly restMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly nextAt = new Map<Engine, number>();
  private readonly restingUntil = new Map<Engine, number>();
  private day = '';
  private used = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: GateOptions = {}) {
    this.paceMs = o.paceMs ?? PACE_MS;
    this.perDay = o.perDay ?? PER_DAY;
    this.restMs = o.restMs ?? REST_MS;
    this.clock = o.clock ?? Date.now;
    this.sleep = o.sleep ?? sleep;
  }

  /** Queries left today. */
  left(): number {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    return day === this.day ? Math.max(0, this.perDay - this.used) : this.perDay;
  }

  /** The engine is resting until then (it turned a query away), or null. */
  resting(engine: Engine): Date | null {
    const until = this.restingUntil.get(engine) ?? 0;
    return until > this.clock() ? new Date(until) : null;
  }

  /**
   * Runs one query on the first engine that takes it. Throws NoSearchNow when none takes it now
   * (the day's budget is used, every engine rests or turned it away).
   */
  search(query: string, ctx: Pick<ReaderContext, 'fetch' | 'signal'>): Promise<WebResult> {
    const run = this.queue.then(() => this.searchNow(query, ctx));
    this.queue = run.catch(() => {});
    return run;
  }

  private async searchNow(
    query: string,
    ctx: Pick<ReaderContext, 'fetch' | 'signal'>,
  ): Promise<WebResult> {
    // A run cancelled while its query waited in line spends none of the day's budget.
    ctx.signal.throwIfAborted();
    const problems: string[] = [];
    let failed = false;
    for (const engine of ENGINES) {
      if (this.left() === 0) {
        problems.push(`today's ${this.perDay} web searches are used`);
        break;
      }
      const resting = this.resting(engine);
      if (resting) {
        problems.push(`${engine} rests until ${resting.toISOString()}`);
        continue;
      }
      const wait = (this.nextAt.get(engine) ?? 0) - this.clock();
      if (wait > 0) await this.sleep(wait, ctx.signal);
      this.count();
      this.nextAt.set(engine, this.clock() + this.paceMs);
      const res = await get(ctx.fetch, SEARCH[engine].url(query), ctx.signal, {
        accept: 'text/html',
        allow: [403, 429],
      }).catch((err: Error) => err);
      if (res instanceof Error) {
        ctx.signal.throwIfAborted();
        failed = true;
        problems.push(`${engine}: ${res.message}`);
        continue;
      }
      const blocked =
        res.status === 403 || res.status === 429
          ? `HTTP ${res.status}`
          : challenge(engine, res.text)
            ? 'a challenge page'
            : null;
      if (blocked) {
        this.restingUntil.set(engine, this.clock() + this.restMs);
        problems.push(`${engine} turned the query away (${blocked})`);
        continue;
      }
      return { hits: SEARCH[engine].hits(res.text), engine };
    }
    const why = problems.join('; ') || 'no web search engine';
    // A network error is a failed read; a budget, a block or a rest is a later run's turn.
    throw failed ? new Error(why) : new NoSearchNow(why);
  }

  private count(): void {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    this.used++;
  }
}
