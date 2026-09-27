import { existsSync, readFileSync, statSync } from 'node:fs';
import { writePrivateFile } from '../util/fs.ts';
import { addRedaction } from '../util/log.ts';
import { assertSecretName, type Secrets } from './secrets.ts';

interface Store {
  version: 1;
  secrets: Record<string, string>;
}

/**
 * Secrets in one JSON file with mode 0600. Every write replaces the file atomically.
 * Values are registered with the log redactor as soon as they are read or written.
 */
export class FileSecrets implements Secrets {
  readonly backend = 'file';
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private load(): Store {
    if (!existsSync(this.path)) return { version: 1, secrets: {} };
    const mode = statSync(this.path).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `refusing to read ${this.path}: mode ${mode.toString(8)} lets other users read it (expected 600)`,
      );
    }
    const store = JSON.parse(readFileSync(this.path, 'utf8')) as Store;
    for (const value of Object.values(store.secrets)) addRedaction(value);
    return store;
  }

  private save(store: Store): void {
    writePrivateFile(this.path, `${JSON.stringify(store, null, 2)}\n`);
  }

  async get(name: string): Promise<string | null> {
    assertSecretName(name);
    return this.load().secrets[name] ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    if (value === '') throw new Error('secret value is empty');
    addRedaction(value);
    const store = this.load();
    store.secrets[name] = value;
    this.save(store);
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    const store = this.load();
    if (!(name in store.secrets)) return false;
    delete store.secrets[name];
    this.save(store);
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(this.load().secrets).sort();
  }
}
