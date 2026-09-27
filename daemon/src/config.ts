// Where applyantd keeps its state. Nothing secret lives here: secrets go through `Secrets`.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Data dir: APPLYANT_HOME, else the OS default. */
  home: string;
  dbPath: string;
  /** `{port, token, pid}` for clients, mode 0600. */
  endpointFile: string;
  /** File secrets backend (Linux); the Keychain replaces it on macOS in 8a. */
  secretsFile: string;
  filesDir: string;
  /** files/runs: one NDJSON log per agent run. */
  runsDir: string;
  /** files/work: empty per-run working directories for the agent CLIs. */
  workDir: string;
  /** Partial clones of GitHub sources. */
  reposDir: string;
  host: '127.0.0.1';
  /** 0 picks a free port. */
  port: number;
  worker: {
    concurrency: number;
    leaseMs: number;
    pollMs: number;
    maxAttempts: number;
  };
  reader: {
    /** Parallel throwaway contexts in the headless reader browser. */
    maxContexts: number;
    navigationTimeoutMs: number;
  };
}

type Env = Record<string, string | undefined>;

export function defaultHome(env: Env = process.env, platform = process.platform): string {
  const home = env.HOME || homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Applyant');
  if (platform === 'win32')
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Applyant');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applyant');
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const home = env.APPLYANT_HOME || defaultHome(env);
  return {
    home,
    dbPath: join(home, 'applyant.db'),
    endpointFile: join(home, 'endpoint.json'),
    secretsFile: join(home, 'secrets.json'),
    filesDir: join(home, 'files'),
    runsDir: join(home, 'files', 'runs'),
    workDir: join(home, 'files', 'work'),
    reposDir: join(home, 'repos'),
    host: '127.0.0.1',
    port: int(env, 'APPLYANT_PORT', 0),
    worker: {
      concurrency: int(env, 'APPLYANT_WORKERS', 2),
      leaseMs: int(env, 'APPLYANT_LEASE_MS', 120_000),
      pollMs: int(env, 'APPLYANT_POLL_MS', 1_000),
      maxAttempts: int(env, 'APPLYANT_MAX_ATTEMPTS', 5),
    },
    reader: {
      maxContexts: int(env, 'APPLYANT_READER_CONTEXTS', 3),
      navigationTimeoutMs: int(env, 'APPLYANT_NAV_TIMEOUT_MS', 30_000),
    },
  };
}
