// Where applyantd keeps its state. Nothing secret lives here: secrets go through `Secrets`.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  /** The submission browser's persistent Chrome profile (phase 6): logged-in sessions live here. */
  browserDir: string;
  /** The candidate's CV template (index.html + style.css); the bundled "Clean" when absent. */
  cvTemplateDir: string;
  /** Downloaded models (EmbeddingGemma). APPLYANT_MODELS_DIR overrides. */
  modelsDir: string;
  /** Jev endpoint; APPLYANT_JEV_URL overrides it (tests point it nowhere). */
  jevUrl: string | null;
  /** gemma (default) · hash: an offline lexical stand-in (tests, machines without the model). */
  embedder: 'gemma' | 'hash';
  /**
   * applyant-native (macOS): APPLYANT_NATIVE_PATH ("off" disables it), else the bundle's
   * Contents/Helpers, else a `swift build` in the repo's native/. Null when none exists.
   */
  nativeHelperPath: string | null;
  /** Fetch the reader's Chromium headless shell at start (set by the app's launcher). */
  installBrowsers: boolean;
  /** Worker threads for heavy read queries. */
  readWorkers: number;
  host: '127.0.0.1';
  /** 0 picks a free port. */
  port: number;
  /** How often the scheduler looks for due search strategies (and on every wake). */
  schedulerMs: number;
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

function embedderKind(raw: string | undefined): Config['embedder'] {
  if (!raw || raw === 'gemma') return 'gemma';
  if (raw === 'hash') return 'hash';
  throw new Error('APPLYANT_EMBEDDER must be gemma or hash');
}

/**
 * The helper sits at Contents/Helpers/ in Applyant.app, while this file is at
 * Contents/Resources/daemon/src/; in the repo it's native/.build/<config>/.
 */
export function nativeHelperPath(
  env: Env = process.env,
  here = import.meta.dirname,
): string | null {
  // "off": never use the helper (tests, so they can't reach the real Keychain).
  if (env.APPLYANT_NATIVE_PATH === 'off') return null;
  if (env.APPLYANT_NATIVE_PATH) return env.APPLYANT_NATIVE_PATH;
  const candidates = [
    resolve(here, '..', '..', '..', 'Helpers', 'applyant-native'),
    resolve(here, '..', '..', 'native', '.build', 'release', 'applyant-native'),
    resolve(here, '..', '..', 'native', '.build', 'debug', 'applyant-native'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
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
    browserDir: join(home, 'browser'),
    cvTemplateDir: join(home, 'cv-template'),
    modelsDir: env.APPLYANT_MODELS_DIR || join(home, 'models'),
    jevUrl: env.APPLYANT_JEV_URL || null,
    embedder: embedderKind(env.APPLYANT_EMBEDDER),
    nativeHelperPath: nativeHelperPath(env),
    installBrowsers: env.APPLYANT_INSTALL_BROWSERS === '1',
    readWorkers: Math.max(1, int(env, 'APPLYANT_READ_WORKERS', 2)),
    host: '127.0.0.1',
    port: int(env, 'APPLYANT_PORT', 0),
    schedulerMs: Math.max(1_000, int(env, 'APPLYANT_SCHEDULER_MS', 60_000)),
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
