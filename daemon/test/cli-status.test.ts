// The GitHub CLI's place in the status: found by path (a launchd agent's PATH has no
// Homebrew), signed in or not, and as which account.
import { describe, expect, it } from 'vitest';
import { CliPaths, type RunFile } from '../src/models/cli-paths.ts';
import { CliStatus, parseGhAccount } from '../src/models/cli-status.ts';

const GH = '/opt/homebrew/bin/gh';

function status(run: RunFile) {
  const paths = new CliPaths({
    env: { HOME: '/Users/nobody', SHELL: '/bin/zsh' },
    platform: 'darwin',
    isExecutable: (p) => p === GH,
    run: async () => '',
  });
  return new CliStatus({ paths, run, env: {} });
}

describe('gh in the setup status', () => {
  it('reads the account from `gh auth status`', () => {
    expect(
      parseGhAccount('github.com\n  ✓ Logged in to github.com account romirom11 (keyring)\n'),
    ).toBe('romirom11');
    expect(parseGhAccount('✓ Logged in to github.com as old-style (oauth_token)')).toBe(
      'old-style',
    );
    expect(parseGhAccount('You are not logged into any GitHub hosts.')).toBeNull();
  });

  it('signed in: the path it was found at and the account', async () => {
    const calls: string[] = [];
    const s = status(async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (args[0] === '--version') return 'gh version 2.60.1 (2026-01-01)\n';
      return 'github.com\n  ✓ Logged in to github.com account romirom11 (keyring)\n';
    });
    const gh = (await s.check()).tools.gh;
    expect(gh).toMatchObject({ found: true, path: GH, signedIn: true, account: 'romirom11' });
    expect(gh.error).toBeNull();
    expect(calls).toContain(`${GH} auth status --hostname github.com`);
  });

  it('an older gh that prints the status to stderr still names the account', async () => {
    const s = status(async (_file, args) => {
      if (args[0] === '--version') return 'gh version 2.20.0';
      return args[0] === 'config' ? 'work-login\n' : '';
    });
    expect((await s.check()).tools.gh).toMatchObject({ signedIn: true, account: 'work-login' });
  });

  it('not signed in, and not installed, each say what to do', async () => {
    const out = status(async (_file, args) => {
      if (args[0] === '--version') return 'gh version 2.60.1';
      throw Object.assign(new Error('exit 1'), {
        stderr: 'You are not logged into any GitHub hosts.',
      });
    });
    expect((await out.check()).tools.gh).toMatchObject({
      found: true,
      signedIn: false,
      account: null,
    });
    expect((await out.check()).tools.gh.error).toMatch(/run `gh auth login`/);

    const missing = new CliStatus({
      paths: new CliPaths({
        env: { HOME: '/Users/nobody', SHELL: '/bin/zsh' },
        platform: 'darwin',
        isExecutable: () => false,
        run: async () => '',
      }),
      run: async () => '',
      env: {},
    });
    expect((await missing.check()).tools.gh).toMatchObject({ found: false, signedIn: false });
  });
});
