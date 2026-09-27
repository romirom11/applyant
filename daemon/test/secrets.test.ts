import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import { createLogger, setLogSink } from '../src/util/log.ts';

const VALUE = 'jev_live_7f3a9c2e41b8d6f0';

describe('file secrets backend', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-secrets-'));
    path = join(dir, 'home', 'secrets.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mode = (p: string) => statSync(p).mode & 0o777;

  it('stores secrets in a 0600 file, even under a permissive umask', async () => {
    const old = process.umask(0);
    try {
      const secrets = new FileSecrets(path);
      await secrets.set('jev', VALUE);
      expect(mode(path)).toBe(0o600);
      expect(mode(join(dir, 'home'))).toBe(0o700);
      await secrets.set('capmonster', 'cm-123456');
      expect(mode(path)).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  it('round-trips, lists names only, and deletes', async () => {
    const secrets = new FileSecrets(path);
    expect(await secrets.get('jev')).toBeNull();
    await secrets.set('jev', VALUE);
    await secrets.set('capmonster', 'cm-123456');
    expect(await secrets.get('jev')).toBe(VALUE);
    expect(await secrets.list()).toEqual(['capmonster', 'jev']);
    expect(JSON.stringify(await secrets.list())).not.toContain(VALUE);
    expect(await secrets.delete('jev')).toBe(true);
    expect(await secrets.delete('jev')).toBe(false);
    expect(await new FileSecrets(path).get('jev')).toBeNull();
    expect(await new FileSecrets(path).get('capmonster')).toBe('cm-123456');
  });

  it('refuses a secrets file other users can read', async () => {
    const secrets = new FileSecrets(path);
    await secrets.set('jev', VALUE);
    chmodSync(path, 0o644);
    await expect(secrets.get('jev')).rejects.toThrow(/mode 644/);
  });

  it('rejects bad names and empty values', async () => {
    const secrets = new FileSecrets(path);
    await expect(secrets.set('../etc/passwd', 'x')).rejects.toThrow(/invalid secret name/);
    await expect(secrets.set('Jev', 'x')).rejects.toThrow(/invalid secret name/);
    await expect(secrets.set('jev', '')).rejects.toThrow(/empty/);
  });

  it('never puts secret values in the config', async () => {
    const home = join(dir, 'home');
    await new FileSecrets(join(home, 'secrets.json')).set('jev', VALUE);
    const config = loadConfig({ APPLYANT_HOME: home, HOME: dir });
    expect(JSON.stringify(config)).not.toContain(VALUE);
    expect(config.secretsFile).toBe(join(home, 'secrets.json'));
  });

  it('redacts secret values from log lines', async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      const secrets = new FileSecrets(path);
      await secrets.set('jev', VALUE);
      const log = createLogger({ svc: 'test' });
      // Even a careless log call cannot leak it.
      log.info(`calling Jev with key ${VALUE}`, { headers: { authorization: `Bearer ${VALUE}` } });
      log.error('request failed', { err: new Error(`401 for ${VALUE}`) });
    } finally {
      restore();
    }
    const out = lines.join('\n');
    expect(out).not.toContain(VALUE);
    expect(out).toContain('[redacted]');
  });

  it('redacts values that were only read, e.g. after a daemon restart', async () => {
    const stored = 'tg-session-9d8c7b6a5f4e';
    const file = join(dir, 'restart-secrets.json');
    writeFileSync(file, JSON.stringify({ version: 1, secrets: { telegram: stored } }), {
      mode: 0o600,
    });
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      await new FileSecrets(file).list();
      createLogger().warn(`session ${stored}`);
    } finally {
      restore();
    }
    expect(lines.join('\n')).not.toContain(stored);
  });
});

describe('secrets file content', () => {
  it('is JSON with names mapped to values (so a backup restore is obvious)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'applyant-secrets-'));
    try {
      const path = join(dir, 'secrets.json');
      await new FileSecrets(path).set('jev', VALUE);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        version: 1,
        secrets: { jev: VALUE },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
