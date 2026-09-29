// The daemon's side of applyant-native, the Swift helper that reaches Apple-only frameworks
// (PDFKit/AppKit text extraction, the Keychain, sleep/wake). It runs as a child process and
// speaks JSON lines over stdin/stdout:
//
//   → {"id": 1, "op": "keychain_get", "name": "jev"}
//   ← {"id": 1, "ok": true, "result": {"value": "…"}}        or  {"id": 1, "ok": false, "error": "…"}
//   ← {"event": "wake"}                                       (unsolicited)
//
// Off macOS, or without the helper binary, the daemon gets UnavailableNative: every request
// fails with NativeUnavailableError and callers use their fallbacks.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Logger } from '../util/log.ts';

export interface NativeEvent {
  event: string;
  [key: string]: unknown;
}

export interface NativeHelper {
  /** False for the stub: nothing will ever answer. */
  readonly available: boolean;
  request<T>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Unsolicited events (`wake`). Returns an unsubscribe function. */
  onEvent(listener: (e: NativeEvent) => void): () => void;
  /** True when the helper answers a ping. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class NativeUnavailableError extends Error {}
export class NativeRequestError extends Error {}

export class UnavailableNative implements NativeHelper {
  readonly available = false;
  private readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
  async request<T>(): Promise<T> {
    throw new NativeUnavailableError(`applyant-native is unavailable: ${this.reason}`);
  }
  onEvent(): () => void {
    return () => {};
  }
  async ping(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface NativeClientOptions {
  path: string;
  log: Logger;
  /** Per-request default. Text extraction of a long PDF is the slowest op. */
  timeoutMs?: number;
  /** Delay before restarting a helper that exited on its own. */
  restartDelayMs?: number;
}

export class NativeClient implements NativeHelper {
  readonly available = true;
  private readonly o: Required<NativeClientOptions>;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: NativeEvent) => void>();
  private closing = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts = 0;

  constructor(o: NativeClientOptions) {
    this.o = { timeoutMs: 60_000, restartDelayMs: 2_000, ...o };
  }

  /** Starts the helper now (so `wake` is heard before the first request). */
  start(): void {
    this.ensureChild();
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn(this.o.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => this.onLine(line));
    const errLines = createInterface({ input: child.stderr as NodeJS.ReadableStream });
    errLines.on('line', (line) => this.o.log.warn('applyant-native stderr', { line }));
    child.on('error', (err) => {
      this.o.log.error('applyant-native failed to start', { err, path: this.o.path });
      this.onExit(child, err);
    });
    child.on('exit', (code, signal) => {
      if (!this.closing) this.o.log.warn('applyant-native exited', { code, signal });
      this.onExit(child, new NativeRequestError(`applyant-native exited (${signal ?? code})`));
    });
    return child;
  }

  private onExit(child: ChildProcess, err: Error): void {
    if (this.child !== child) return;
    this.child = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    if (this.closing || this.restartTimer) return;
    // Keep it running for wake events; back off when it keeps dying.
    const delay = Math.min(this.o.restartDelayMs * 2 ** this.restarts, 60_000);
    this.restarts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.closing) this.ensureChild();
    }, delay);
    this.restartTimer.unref();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: {
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
      event?: string;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      this.o.log.warn('applyant-native wrote a line that is not JSON', {
        line: line.slice(0, 200),
      });
      return;
    }
    if (typeof msg.event === 'string') {
      for (const listener of this.listeners) {
        try {
          listener(msg as NativeEvent);
        } catch (err) {
          this.o.log.error('native event listener failed', { err });
        }
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    this.restarts = 0;
    if (msg.ok) p.resolve(msg.result ?? null);
    else p.reject(new NativeRequestError(msg.error ?? 'applyant-native request failed'));
  }

  request<T>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.closing) return Promise.reject(new NativeUnavailableError('applyant-native closed'));
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeRequestError(`applyant-native ${op} timed out`));
      }, timeoutMs ?? this.o.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin?.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
  }

  onEvent(listener: (e: NativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('ping', {}, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.stdin?.end();
      setTimeout(() => child.kill('SIGTERM'), 2_000).unref();
    });
  }
}

// ---- classify_email (phase 13) --------------------------------------------------------------
//
//   → {"id": 7, "op": "classify_email", "subject": "…", "body": "…"}
//   ← {"id": 7, "ok": true, "result": {"label": "interview", "confidence": 0.86, "language": "en"}}
//
// Foundation Models on the Mac (native/ClassifyEmail.swift). The helper answers "unknown" with
// confidence 0 when Apple Intelligence is off, the language isn't supported or it can't tell;
// it never sends mail anywhere. Labels are EMAIL_LABELS (db/schema.ts).

export interface EmailClassification {
  label: string;
  confidence: number;
  language: string | null;
}

/** The body is cut to what the on-device model's context holds comfortably. */
export const CLASSIFY_BODY_CHARS = 6000;

export async function classifyEmail(
  native: NativeHelper,
  email: { subject: string; body: string; from: string },
  timeoutMs = 60_000,
): Promise<EmailClassification> {
  const res = await native.request<Partial<EmailClassification>>(
    'classify_email',
    { subject: email.subject, body: email.body.slice(0, CLASSIFY_BODY_CHARS), from: email.from },
    timeoutMs,
  );
  return {
    label: typeof res?.label === 'string' ? res.label : 'unknown',
    confidence: typeof res?.confidence === 'number' ? res.confidence : 0,
    language: typeof res?.language === 'string' ? res.language : null,
  };
}

/**
 * The helper for this platform: the real one on macOS when its binary exists, the stub
 * otherwise (Linux, or a dev checkout where `swift build` hasn't run).
 */
export function openNative(o: {
  path: string | null;
  platform?: NodeJS.Platform;
  log: Logger;
}): NativeHelper {
  const platform = o.platform ?? process.platform;
  if (platform !== 'darwin') return new UnavailableNative('only on macOS');
  if (!o.path || !existsSync(o.path)) {
    return new UnavailableNative(`no helper binary${o.path ? ` at ${o.path}` : ''}`);
  }
  const client = new NativeClient({ path: o.path, log: o.log });
  client.start();
  return client;
}
