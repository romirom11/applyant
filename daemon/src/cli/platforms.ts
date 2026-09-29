// `applyant platforms …`: LinkedIn and Xing under the candidate's session — daily caps, the
// pause after a challenge, and the one-time sign-in in Applyant's own browser profile. Captcha
// solving off those platforms needs a CapMonster key: `applyant secrets set capmonster`.
import type { Command } from 'commander';
import { loginSecretName } from '../browser/login-window.ts';
import type { Platform } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table } from './format.ts';
import { positiveInt } from './jobs.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

function platformJson(p: Platform) {
  return {
    platform: p.platform,
    name: p.name,
    searchesPerDay: p.searchesPerDay,
    applicationsPerDay: p.applicationsPerDay,
    searchesToday: p.searchesToday,
    applicationsToday: p.applicationsToday,
    pausedAt: iso(p.pausedAt),
    pauseReason: p.pauseReason ?? null,
    signedInAt: iso(p.signedInAt),
  };
}

function capArg(value: string): number {
  return value === '0' ? 0 : positiveInt(value);
}

export function registerPlatforms(
  program: Command,
  client: () => ApplyantClient,
  readSecretValue: (name: string) => Promise<string>,
): void {
  const platforms = program
    .command('platforms')
    .description('LinkedIn and Xing: daily caps, pauses after a challenge, signing in');

  platforms
    .command('list', { isDefault: true })
    .description('each platform: caps, use in the last 24 h, paused or not, signed in or not')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listPlatforms({});
      if (opts.json) {
        return json({
          platforms: res.platforms.map(platformJson),
          captchaSolver: res.captchaSolver,
          signInOpen: res.signInOpen ?? null,
        });
      }
      out(
        table(
          ['PLATFORM', 'SEARCHES', 'APPLICATIONS', 'SIGNED IN', 'STATE'],
          res.platforms.map((p) => [
            p.platform,
            `${p.searchesToday}/${p.searchesPerDay}`,
            `${p.applicationsToday}/${p.applicationsPerDay}`,
            iso(p.signedInAt)?.slice(0, 16).replace('T', ' ') ?? 'no',
            p.pausedAt ? `paused: ${p.pauseReason ?? 'a challenge'}` : 'active',
          ]),
        ),
      );
      out('');
      out(
        res.captchaSolver
          ? 'Captchas: solved by CapMonster first (never on LinkedIn or Xing).'
          : 'Captchas: go to you. `applyant secrets set capmonster` lets CapMonster try first.',
      );
      if (res.signInOpen) out(`The sign-in window is open at ${res.signInOpen}.`);
      if (res.platforms.some((p) => p.pausedAt)) {
        out(
          'A paused platform waits for you: answer its check, then `applyant platforms resume <platform>`.',
        );
      }
    });

  platforms
    .command('caps <platform>')
    .description('daily caps (rolling 24 h): `caps linkedin --searches 6 --applications 10`')
    .option('--searches <n>', 'searches a day', capArg)
    .option('--applications <n>', 'applications a day', capArg)
    .action(async (platform: string, opts: { searches?: number; applications?: number }) => {
      if (opts.searches === undefined && opts.applications === undefined) {
        throw new Error('give --searches and/or --applications');
      }
      const res = await client().setPlatformCaps({
        platform,
        ...(opts.searches !== undefined ? { searchesPerDay: opts.searches } : {}),
        ...(opts.applications !== undefined ? { applicationsPerDay: opts.applications } : {}),
      });
      const p = res.platform;
      if (!p) throw new Error('daemon returned no platform');
      out(
        `${p.name}: ${p.searchesPerDay} searches and ${p.applicationsPerDay} applications a day.`,
      );
    });

  platforms
    .command('resume <platform>')
    .description('end the pause after you answered its check in the browser')
    .action(async (platform: string) => {
      const res = await client().resumePlatform({ platform });
      out(`${res.platform?.name ?? platform} resumed.`);
    });

  platforms
    .command('signin <target>')
    .description(
      "open Applyant's browser profile (plain Chrome, no automation) to sign in once: linkedin, xing or a URL",
    )
    .option('--force', "close windows left open for you in Applyant's browser first")
    .option(
      '--save-login <username>',
      "also keep this site's login in Secrets (the password is read from stdin, or prompted)",
    )
    .action(async (target: string, opts: { force?: boolean; saveLogin?: string }) => {
      if (opts.saveLogin) {
        const name = loginSecretName(target);
        const password = await readSecretValue(`${name} password`);
        if (!password) throw new Error('empty password, nothing stored');
        await client().setSecret({
          name,
          value: JSON.stringify({ username: opts.saveLogin, password }),
        });
        out(`Stored the login as secret "${name}".`);
      }
      const res = await client().signIn({ target, force: opts.force ?? false });
      out(`Sign in at ${res.url} in the Chrome window that opened, then close that window.`);
      out("Deliveries wait until it is closed; the session stays in Applyant's profile.");
    });
}
