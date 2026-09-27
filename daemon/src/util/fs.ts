import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Creates a directory only the current user can enter. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Writes a file that is readable by the owner only, atomically: the content goes to a
 * temp file created with mode 0600 and is renamed over the target, so the file never
 * exists with wider permissions or half-written.
 */
export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
