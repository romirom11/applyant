// Heavy reads (FTS, vector and hybrid retrieval) run on read-only connections in
// worker_threads, which WAL allows next to the single writer. better-sqlite3 is synchronous,
// so this keeps them off the main thread, which also hosts Playwright and WatchEvents.
// This is the only async database path.
import { Worker } from 'node:worker_threads';
import type { SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { Logger } from '../util/log.ts';
import type { ReadDb } from './client.ts';

/** Where heavy read queries run. */
export interface ReadExec {
  all<T>(query: SQL): Promise<T[]>;
}

const dialect = new SQLiteSyncDialect();

interface Pending {
  resolve(rows: unknown[]): void;
  reject(err: Error): void;
}

interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
}

export interface ReadPoolOptions {
  path: string;
  size: number;
  log: Logger;
}

export class ReadPool implements ReadExec {
  private readonly o: ReadPoolOptions;
  private readonly slots: Slot[] = [];
  private next = 0;
  private seq = 0;
  private closed = false;

  constructor(options: ReadPoolOptions) {
    this.o = options;
  }

  all<T>(query: SQL): Promise<T[]> {
    if (this.closed) return Promise.reject(new Error('read pool is closed'));
    const { sql, params } = dialect.sqlToQuery(query);
    const slot = this.slot();
    const id = ++this.seq;
    return new Promise<T[]>((resolve, reject) => {
      slot.pending.set(id, { resolve: (rows) => resolve(rows as T[]), reject });
      slot.worker.postMessage({ id, sql, params });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const slots = this.slots.splice(0);
    await Promise.all(slots.map((s) => s.worker.terminate()));
    for (const s of slots) {
      for (const p of s.pending.values()) p.reject(new Error('read pool is closed'));
    }
  }

  /** Workers start lazily and round-robin; a crashed worker is replaced on the next query. */
  private slot(): Slot {
    const i = this.next++ % Math.max(1, this.o.size);
    const existing = this.slots[i];
    if (existing) return existing;
    const worker = new Worker(new URL('./read-worker.ts', import.meta.url), {
      workerData: { path: this.o.path },
    });
    const slot: Slot = { worker, pending: new Map() };
    worker.on('message', (m: { id: number; rows?: unknown[]; error?: string }) => {
      const p = slot.pending.get(m.id);
      if (!p) return;
      slot.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.rows ?? []);
    });
    const fail = (err: Error) => {
      if (this.slots[i] === slot) delete this.slots[i];
      for (const p of slot.pending.values()) p.reject(err);
      slot.pending.clear();
    };
    worker.on('error', (err) => {
      this.o.log.error('read worker failed', { err });
      fail(err);
    });
    worker.on('exit', (code) => {
      if (!this.closed) fail(new Error(`read worker exited with code ${code}`));
    });
    worker.unref();
    this.slots[i] = slot;
    return slot;
  }
}

/** Runs queries on a connection in this thread (tests and tiny databases). */
export function directExec(conn: ReadDb): ReadExec {
  return {
    all: async <T>(query: SQL) => conn.all<T>(query),
  };
}
