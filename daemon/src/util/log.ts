// A tiny JSON-lines logger on stderr. Every line passes through the redactor, so a secret
// value that reached a log call by mistake is still never written.

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Sink = (line: string) => void;

const redactions = new Set<string>();

/** Registers a value that must never appear in logs. Values shorter than 4 chars are ignored. */
export function addRedaction(value: string): void {
  if (value.length >= 4) redactions.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const value of redactions) {
    if (out.includes(value)) out = out.split(value).join('[redacted]');
  }
  return out;
}

let sink: Sink = (line) => process.stderr.write(`${line}\n`);

/** For tests: capture log lines. Returns a restore function. */
export function setLogSink(next: Sink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function errorFields(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    const record: Record<string, unknown> = { t: new Date().toISOString(), level, msg, ...base };
    for (const [k, v] of Object.entries(fields ?? {})) record[k] = errorFields(v);
    sink(redact(JSON.stringify(record)));
  };
  return {
    debug: (msg, fields) => {
      if (process.env.APPLYANT_DEBUG) write('debug', msg, fields);
    },
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
