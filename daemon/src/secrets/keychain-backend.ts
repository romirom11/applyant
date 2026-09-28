// Secrets in the macOS Keychain, through applyant-native (generic passwords under the
// service "com.applyant"; the secret name is the account). Chosen on darwin when the helper
// is there; the 0600 file backend stays for Linux.
import { existsSync, unlinkSync } from 'node:fs';
import type { NativeHelper } from '../native/client.ts';
import type { Logger } from '../util/log.ts';
import { addRedaction } from '../util/log.ts';
import { FileSecrets } from './file-backend.ts';
import { assertSecretName, type Secrets } from './secrets.ts';

export class KeychainSecrets implements Secrets {
  readonly backend = 'keychain';

  private readonly native: NativeHelper;

  constructor(native: NativeHelper) {
    this.native = native;
  }

  async get(name: string): Promise<string | null> {
    assertSecretName(name);
    const { value } = await this.native.request<{ value: string | null }>('keychain_get', { name });
    if (value !== null) addRedaction(value);
    return value;
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    if (value === '') throw new Error('secret value is empty');
    addRedaction(value);
    await this.native.request('keychain_set', { name, value });
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    const { deleted } = await this.native.request<{ deleted: boolean }>('keychain_delete', {
      name,
    });
    return deleted;
  }

  async list(): Promise<string[]> {
    const { names } = await this.native.request<{ names: string[] }>('keychain_list');
    return [...names].sort();
  }
}

/**
 * Moves the secrets of an existing 0600 file (the Jev key from before the Mac app) into the
 * Keychain, once. The file is removed only after every value is stored.
 */
export async function migrateFileSecrets(
  file: string,
  to: Secrets,
  log: Logger,
): Promise<string[]> {
  if (!existsSync(file)) return [];
  const from = new FileSecrets(file);
  const names = await from.list();
  for (const name of names) {
    const value = await from.get(name);
    if (value !== null) await to.set(name, value);
  }
  unlinkSync(file);
  log.info('moved secrets into the keychain', { names, from: file });
  return names;
}

/** The Keychain when applyant-native answers, else the file backend. */
export async function openSecrets(o: {
  native: NativeHelper;
  secretsFile: string;
  log: Logger;
}): Promise<Secrets> {
  if (o.native.available && (await o.native.ping())) {
    const keychain = new KeychainSecrets(o.native);
    try {
      await migrateFileSecrets(o.secretsFile, keychain, o.log);
      return keychain;
    } catch (err) {
      // Half-moved secrets would be invisible to the keychain: keep using the file until it works.
      o.log.error('could not move file secrets into the keychain; using the file', { err });
      return new FileSecrets(o.secretsFile);
    }
  }
  if (o.native.available) {
    o.log.warn('applyant-native did not answer; secrets stay in the file backend');
  }
  return new FileSecrets(o.secretsFile);
}
