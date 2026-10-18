// Reads more than one run wants: a company board that several strategies read within minutes,
// the Workable account behind a company, a web search's results. A read is kept for its time
// and shared (also while it's still running); a failed read isn't kept. The search handler keeps
// one for the daemon's real network; an injected fetch (tests) gets a fresh one per run.
//
// A lane paces the reads that go through it: Workable's board API answers a burst of reads
// (a few dozen a minute) with 429, so the daemon starts them a second apart.

/** A company board's list is shared this long (shorter than any strategy's schedule). */
export const BOARD_READ_MS = 30 * 60_000;

interface Entry {
  at: number;
  keepMs: number;
  value: Promise<unknown>;
}

export interface SharedOptions {
  /** Entries kept at most; the oldest go first. */
  max?: number;
  /** Per lane, the time between two reads' starts. */
  gapMs?: Record<string, number>;
}

export class SharedReads {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly gapMs: Record<string, number>;
  private readonly nextAt = new Map<string, number>();

  constructor(o: SharedOptions = {}) {
    this.max = o.max ?? 2000;
    this.gapMs = o.gapMs ?? {};
  }

  /** Reads kept now. */
  get size(): number {
    return this.entries.size;
  }

  /** The read kept under `key` if it's younger than `keepMs` at `now`, else a new one. */
  memo<T>(key: string, keepMs: number, now: Date, read: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && now.getTime() - hit.at < hit.keepMs) return hit.value as Promise<T>;
    // Reads past their time go: a board's whole list is megabytes, and most aren't asked again.
    for (const [k, e] of this.entries) {
      if (now.getTime() - e.at >= e.keepMs) this.entries.delete(k);
    }
    const value = read();
    this.entries.delete(key);
    this.entries.set(key, { at: now.getTime(), keepMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    // The oldest go first once there are too many.
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(k);
    }
    return value;
  }

  /** Waits for the lane's next turn (at once when the lane has no gap). */
  async turn(lane: string, signal: AbortSignal): Promise<void> {
    const gap = this.gapMs[lane] ?? 0;
    if (gap <= 0) return;
    signal.throwIfAborted();
    const now = Date.now();
    const at = Math.max(now, this.nextAt.get(lane) ?? 0);
    this.nextAt.set(lane, at + gap);
    if (at > now) await sleep(at - now, signal);
  }
}

/**
 * Waits `ms`, or until the signal aborts. The abort listener goes when the wait ends: one run
 * waits its turn hundreds of times on the same signal.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The daemon's own, over the real network: strategies read the same watched boards within
 * minutes of each other and share those reads, and the ATS index's crawler takes its Workable
 * reads through the same lane. An injected fetch (tests) gets fresh ones per run.
 */
export const DAEMON_READS = new SharedReads({ gapMs: { workable: 1_000 } });
