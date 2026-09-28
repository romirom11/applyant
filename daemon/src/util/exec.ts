import { execFile } from 'node:child_process';

export class ExecError extends Error {
  readonly code: number | string | null;
  readonly stderr: string;
  constructor(message: string, code: number | string | null, stderr: string) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runs a program (no shell) and resolves with its stdout. */
export function run(cmd: string, args: string[], o: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: o.cwd,
        env: o.env,
        signal: o.signal,
        timeout: o.timeoutMs ?? 300_000,
        maxBuffer: 128 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          const detail = (stderr || err.message).trim().split('\n').slice(-3).join(' ');
          reject(new ExecError(`${cmd} ${args[0] ?? ''} failed: ${detail}`, code, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
