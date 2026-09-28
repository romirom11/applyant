import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliPaths,
  PROBE_MARKER,
  parseProbeOutput,
  type RunFile,
  ToolNotFoundError,
} from '../src/models/cli-paths.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'applyant-clipaths-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function exe(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho fake\n');
  chmodSync(path, 0o755);
  return path;
}

interface Call {
  file: string;
  args: readonly string[];
}

/** A fake runner: dscl answers `dscl`, every other program is the probed shell. */
function fakeRun(o: { shellOut?: string; dscl?: string | Error; shellError?: Error } = {}) {
  const calls: Call[] = [];
  const run: RunFile = async (file, args) => {
    calls.push({ file, args });
    if (file === '/usr/bin/dscl') {
      if (o.dscl instanceof Error || o.dscl === undefined) throw o.dscl ?? new Error('no dscl');
      return o.dscl;
    }
    // Let concurrent resolves pile up on the one probe.
    await new Promise((r) => setTimeout(r, 20));
    if (o.shellError) throw o.shellError;
    return o.shellOut ?? `${PROBE_MARKER}\n/usr/bin:/bin\n`;
  };
  const shells = () => calls.filter((c) => c.file !== '/usr/bin/dscl');
  return { run, calls, shells };
}

describe('CliPaths lookup order', () => {
  it('prefers $APPLYANT_<TOOL>_PATH, then ~/.local/bin, then ~/.npm-global/bin', async () => {
    const explicit = exe(join(home, 'custom', 'claude'));
    const local = exe(join(home, '.local', 'bin', 'claude'));
    const npm = exe(join(home, '.npm-global', 'bin', 'claude'));
    const { run, shells } = fakeRun();

    const withEnv = new CliPaths({
      env: { HOME: home, SHELL: '/bin/zsh', APPLYANT_CLAUDE_PATH: explicit },
      run,
    });
    expect(await withEnv.resolve('claude')).toEqual({
      tool: 'claude',
      path: explicit,
      via: 'env',
      error: null,
    });

    const paths = new CliPaths({ env: { HOME: home, SHELL: '/bin/zsh' }, run });
    expect((await paths.resolve('claude')).path).toBe(local);
    rmSync(local);
    expect((await paths.resolve('claude')).path).toBe(npm);
    // Found in a fixed place: the slow shell probe never ran.
    expect(shells()).toHaveLength(0);
  });

  it('checks /opt/homebrew/bin before /usr/local/bin, then the login shell', async () => {
    const present = new Set(['/usr/local/bin/codex', '/opt/homebrew/bin/codex']);
    const { run, shells } = fakeRun({ shellOut: `${PROBE_MARKER}\n/nvm/bin\n` });
    const paths = new CliPaths({
      env: { HOME: home, SHELL: '/bin/zsh' },
      run,
      isExecutable: (p) => present.has(p),
    });
    expect(await paths.resolve('codex')).toMatchObject({
      path: '/opt/homebrew/bin/codex',
      via: 'dir',
    });
    present.delete('/opt/homebrew/bin/codex');
    expect((await paths.resolve('codex')).path).toBe('/usr/local/bin/codex');
    present.delete('/usr/local/bin/codex');
    present.add('/nvm/bin/codex');
    expect(await paths.resolve('codex')).toMatchObject({ path: '/nvm/bin/codex', via: 'shell' });
    expect(shells()).toHaveLength(1);
  });

  it('reports a bad $APPLYANT_<TOOL>_PATH instead of looking elsewhere', async () => {
    exe(join(home, '.local', 'bin', 'claude'));
    const paths = new CliPaths({
      env: { HOME: home, APPLYANT_CLAUDE_PATH: join(home, 'nope') },
      run: fakeRun().run,
    });
    const found = await paths.resolve('claude');
    expect(found).toMatchObject({ path: null, via: null });
    expect(found.error).toMatch(/APPLYANT_CLAUDE_PATH=.*nope is not an executable file/);
    await expect(paths.require('claude')).rejects.toThrow(ToolNotFoundError);
  });

  it('says what it checked when a tool is missing everywhere', async () => {
    const paths = new CliPaths({ env: { HOME: home, SHELL: '/bin/zsh' }, run: fakeRun().run });
    const found = await paths.resolve('codex');
    expect(found.path).toBeNull();
    expect(found.error).toContain(join(home, '.local', 'bin', 'codex'));
    expect(found.error).toContain('/opt/homebrew/bin/codex');
    expect(found.error).toContain("the login shell's PATH");
  });
});

describe('CliPaths login-shell probe', () => {
  it('runs once, however many tasks resolve', async () => {
    const { run, shells } = fakeRun();
    const paths = new CliPaths({ env: { HOME: home, SHELL: '/bin/zsh' }, run });
    await Promise.all([
      paths.start(),
      ...Array.from({ length: 10 }, (_, i) => paths.resolve(i % 2 ? 'claude' : 'codex')),
    ]);
    await paths.resolve('claude');
    expect(shells()).toHaveLength(1);
    expect(paths.probeRuns).toBe(1);
    // -i as well as -l, so ~/.zshrc (nvm) is read.
    expect(shells()[0]).toMatchObject({ file: '/bin/zsh', args: ['-ilc', expect.any(String)] });
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['/bin/sh', '/bin/sh'],
  ])('uses the dscl shell when SHELL is %s', async (_name, shell) => {
    const { run, shells } = fakeRun({ dscl: 'UserShell: /opt/homebrew/bin/fish\n' });
    const paths = new CliPaths({
      env: { HOME: home, SHELL: shell, USER: 'me' },
      run,
      platform: 'darwin',
    });
    await paths.resolve('claude');
    expect(shells()[0]?.file).toBe('/opt/homebrew/bin/fish');
  });

  it('falls back to /bin/zsh when dscl has no answer', async () => {
    const { run, shells, calls } = fakeRun({ dscl: new Error('dscl: not found') });
    const paths = new CliPaths({ env: { HOME: home, USER: 'me' }, run, platform: 'darwin' });
    await paths.resolve('claude');
    expect(calls[0]).toMatchObject({
      file: '/usr/bin/dscl',
      args: ['.', '-read', '/Users/me', 'UserShell'],
    });
    expect(shells()[0]?.file).toBe('/bin/zsh');
  });

  it('ignores profile noise before the marker', () => {
    const out = [
      'Welcome back! (motd from .zshrc)',
      '/not/a/path/from/a/banner',
      PROBE_MARKER,
      '/Users/me/.nvm/versions/node/v22/bin:/usr/bin:relative/dir:/bin',
      'zsh: exit noise',
    ].join('\n');
    expect(parseProbeOutput(out)).toEqual([
      '/Users/me/.nvm/versions/node/v22/bin',
      '/usr/bin',
      '/bin',
    ]);
    expect(parseProbeOutput('no marker here\n/usr/bin')).toBeNull();
  });

  it('counts a failed or timed-out probe as not found, with the reason', async () => {
    const timeout = Object.assign(new Error('killed'), { killed: true });
    const paths = new CliPaths({
      env: { HOME: home, SHELL: '/bin/zsh' },
      run: fakeRun({ shellError: timeout }).run,
      probeTimeoutMs: 50,
    });
    const found = await paths.resolve('claude');
    expect(found.path).toBeNull();
    expect(found.error).toMatch(/login-shell probe failed \(\/bin\/zsh timed out after 50 ms\)/);
  });

  it('finds a tool that only a real login shell puts on PATH', async () => {
    const nvmBin = join(home, '.nvm', 'bin');
    const codex = exe(join(nvmBin, 'codex'));
    const profile = `echo "profile banner"\nexport PATH="${nvmBin}:$PATH"\n`;
    // bash -il reads ~/.bash_profile; zsh -il reads ~/.zshrc.
    writeFileSync(join(home, '.bash_profile'), profile);
    writeFileSync(join(home, '.zshrc'), profile);
    const paths = new CliPaths({
      env: { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin', ZDOTDIR: home },
    });
    expect(await paths.resolve('codex')).toMatchObject({ path: codex, via: 'shell' });
    // The tool's own directory leads its PATH (a `#!/usr/bin/env node` script needs it).
    expect(paths.childPath(codex).split(':')[0]).toBe(nvmBin);
  });
});
