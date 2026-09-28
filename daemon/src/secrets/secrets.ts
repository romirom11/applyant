// The one way to reach credentials (Jev key, CapMonster key, OAuth tokens, sessions).
// Linux: a 0600 JSON file under APPLYANT_HOME. macOS (8a): the Keychain via applyant-native.

export interface Secrets {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /** Returns false when there was nothing to delete. */
  delete(name: string): Promise<boolean>;
  /** Names only; values never leave through listings. */
  list(): Promise<string[]>;
  /** "file" | "keychain", reported by setup status later. */
  readonly backend: string;
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function assertSecretName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `invalid secret name "${name}": use 1-64 lowercase letters, digits, "_", "-" or "."`,
    );
  }
}
