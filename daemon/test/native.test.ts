// applyant-native's daemon side, against a fake helper that speaks the same JSON lines, so
// it runs on Linux CI: requests and errors, events, restarts, and what uses it (Keychain
// secrets with the one-time move from the file, text extraction with the pdfjs fallback).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeHelperPath } from '../src/config.ts';
import {
  NativeTextExtractor,
  NodeTextExtractor,
  type TextExtractor,
} from '../src/domain/knowledge/text/extract.ts';
import {
  NativeClient,
  type NativeEvent,
  NativeRequestError,
  NativeUnavailableError,
  openNative,
  UnavailableNative,
} from '../src/native/client.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import { KeychainSecrets, openSecrets } from '../src/secrets/keychain-backend.ts';
import { quietLog } from './helpers/deps.ts';

const FAKE_NATIVE = fileURLToPath(new URL('./fixtures/bin/applyant-native', import.meta.url));
const CV_PDF = fileURLToPath(new URL('./fixtures/cv/cv.pdf', import.meta.url));

let dir: string;
let clients: NativeClient[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'applyant-native-'));
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(dir, { recursive: true, force: true });
});

function client(o: { restartDelayMs?: number; timeoutMs?: number } = {}): NativeClient {
  const c = new NativeClient({ path: FAKE_NATIVE, log: quietLog, ...o });
  c.start();
  clients.push(c);
  return c;
}

describe('NativeClient', () => {
  it('matches answers to requests and reports helper errors', async () => {
    const c = client();
    expect(await c.ping()).toBe(true);
    const [a, b] = await Promise.all([
      c.request<{ version: string }>('ping'),
      c.request<{ names: string[] }>('keychain_list'),
    ]);
    expect(a.version).toBe('fake');
    expect(b.names).toEqual([]);
    await expect(c.request('nope')).rejects.toThrow(new NativeRequestError('unknown op nope'));
  });

  it('delivers unsolicited events (wake)', async () => {
    const c = client();
    const events: NativeEvent[] = [];
    c.onEvent((e) => events.push(e));
    await c.request('test_wake');
    expect(events).toEqual([{ event: 'wake' }]);
  });

  it('fails pending requests when the helper dies, then restarts it', async () => {
    const c = client({ restartDelayMs: 10 });
    await expect(c.request('test_crash')).rejects.toThrow(/exited \(3\)/);
    // Restarted on its own (it has to be running to hear wake events).
    await new Promise((r) => setTimeout(r, 300));
    expect(await c.ping()).toBe(true);
  });

  it('times out a request that gets no answer', async () => {
    const c = client();
    await expect(c.request('test_hang', {}, 100)).rejects.toThrow(/test_hang timed out/);
    expect(await c.ping()).toBe(true);
  });

  it('is a stub off macOS or without the helper binary', async () => {
    const linux = openNative({ path: FAKE_NATIVE, platform: 'linux', log: quietLog });
    expect(linux.available).toBe(false);
    expect(await linux.ping()).toBe(false);
    await expect(linux.request('ping')).rejects.toThrow(NativeUnavailableError);
    const missing = openNative({ path: join(dir, 'nope'), platform: 'darwin', log: quietLog });
    expect(missing.available).toBe(false);
    await expect(missing.request('ping')).rejects.toThrow(/no helper binary/);
  });

  it('finds the helper in the bundle, and can be switched off', () => {
    expect(nativeHelperPath({ APPLYANT_NATIVE_PATH: 'off' })).toBeNull();
    expect(nativeHelperPath({ APPLYANT_NATIVE_PATH: '/x/applyant-native' })).toBe(
      '/x/applyant-native',
    );
    // Applyant.app/Contents/Resources/daemon/src → Applyant.app/Contents/Helpers.
    const contents = join(dir, 'Applyant.app', 'Contents');
    const src = join(contents, 'Resources', 'daemon', 'src');
    const helper = join(contents, 'Helpers', 'applyant-native');
    expect(nativeHelperPath({}, src)).toBeNull();
    for (const d of [src, join(contents, 'Helpers')]) mkdirSync(d, { recursive: true });
    writeFileSync(helper, '');
    expect(nativeHelperPath({}, src)).toBe(helper);
  });
});

describe('KeychainSecrets', () => {
  it('stores, lists and deletes through the helper', async () => {
    const s = new KeychainSecrets(client());
    expect(s.backend).toBe('keychain');
    await s.set('jev', 'jev-key-123');
    await s.set('capmonster', 'cap-key-456');
    expect(await s.get('jev')).toBe('jev-key-123');
    expect(await s.list()).toEqual(['capmonster', 'jev']);
    expect(await s.delete('jev')).toBe(true);
    expect(await s.delete('jev')).toBe(false);
    expect(await s.get('jev')).toBeNull();
    await expect(s.set('Bad Name', 'x')).rejects.toThrow(/invalid secret name/);
  });

  it('moves an existing secrets file into the keychain once, then removes the file', async () => {
    const file = join(dir, 'secrets.json');
    await new FileSecrets(file).set('jev', 'jev-key-from-linux');
    const native = client();
    const secrets = await openSecrets({ native, secretsFile: file, log: quietLog });
    expect(secrets.backend).toBe('keychain');
    expect(existsSync(file)).toBe(false);
    expect(await secrets.get('jev')).toBe('jev-key-from-linux');
    // A second start finds no file and keeps what the keychain has.
    const again = await openSecrets({ native, secretsFile: file, log: quietLog });
    expect(await again.list()).toEqual(['jev']);
  });

  it('keeps the file backend when the helper is unavailable', async () => {
    const file = join(dir, 'secrets.json');
    await new FileSecrets(file).set('jev', 'jev-key');
    const secrets = await openSecrets({
      native: new UnavailableNative('only on macOS'),
      secretsFile: file,
      log: quietLog,
    });
    expect(secrets.backend).toBe('file');
    expect(await secrets.get('jev')).toBe('jev-key');
    expect(readFileSync(file, 'utf8')).toContain('jev-key');
  });
});

describe('NativeTextExtractor', () => {
  const fallback: TextExtractor = {
    extract: async (path) => ({ format: 'pdf', pages: [`node:${path}`], title: null }),
  };

  it('asks the helper for PDF and DOCX, with pdfjs as the fallback', async () => {
    const x = new NativeTextExtractor(client(), fallback, quietLog);
    expect((await x.extract(CV_PDF)).pages).toEqual(['native:pdf']);

    const docx = join(dir, 'cv.docx');
    writeFileSync(docx, Buffer.from('PK\u0003\u0004 not really a zip'));
    expect(await x.extract(docx)).toMatchObject({ format: 'docx', pages: ['native:docx'] });

    // The helper fails, or finds no text layer: the Node reader gets its chance.
    const broken = join(dir, 'cv.broken.pdf');
    const blank = join(dir, 'cv.blank.pdf');
    copyFileSync(CV_PDF, broken);
    copyFileSync(CV_PDF, blank);
    expect((await x.extract(broken)).pages).toEqual([`node:${broken}`]);
    expect((await x.extract(blank)).pages).toEqual([`node:${blank}`]);
  });

  it('leaves other formats to the Node readers, and works with the stub', async () => {
    const md = join(dir, 'notes.md');
    writeFileSync(md, '# Notes\nBuilt things.');
    const x = new NativeTextExtractor(client(), new NodeTextExtractor(), quietLog);
    expect(await x.extract(md)).toMatchObject({
      format: 'text',
      pages: ['# Notes\nBuilt things.'],
    });
    const stub = new NativeTextExtractor(new UnavailableNative('linux'), fallback, quietLog);
    expect((await stub.extract(CV_PDF)).pages).toEqual([`node:${CV_PDF}`]);
  });
});
