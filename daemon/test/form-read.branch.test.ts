// The candidate's real answers steer Read. With work authorisation "No" in the profile, the
// form ends on the "No" branch: its follow-ups are recorded with revealedBy "No", and a later
// wizard step shows the question that only "No" leads to. A placeholder answer would have
// recorded (and walked) the other branch.
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchOptionExact } from '../src/domain/applications/form-judge.ts';
import { field, runRead } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

// Real browser work: slower machines (CI) need more than the default minute.
vi.setConfig({ testTimeout: 120_000 });

let site: SiteServer;
let browser: Browser;

beforeAll(async () => {
  site = await startSiteServer();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const WORK_AUTH = 'Are you legally authorized to work in the European Union?';

describe('the profile decides the branch Read takes', () => {
  it('work authorisation "No": follow-ups recorded under "No", and the form is left on that branch', async () => {
    const run = await runRead(browser, site.url('/form-conditional.html'), {
      profile: { work_authorization: 'No' },
    });
    try {
      const workAuth = field(run.read, WORK_AUTH);
      const sponsorship = field(run.read, 'Will you require visa sponsorship?');
      expect(sponsorship.revealedBy).toEqual({ ref: workAuth.ref, value: 'No' });
      expect(field(run.read, 'Tell us about your visa situation').revealedBy?.value).toBe('No');
      // The "Yes" branch is known too, and marked as such.
      expect(field(run.read, 'Which country will you work from?').revealedBy?.value).toBe('Yes');
      // The page shows the candidate's branch.
      expect(await run.page.getByRole('combobox', { name: WORK_AUTH }).inputValue()).toBe('No');
      expect(
        await run.page
          .getByRole('group', { name: 'Will you require visa sponsorship?' })
          .isVisible(),
      ).toBe(true);
      expect(
        await run.page
          .getByRole('combobox', { name: 'Which country will you work from?' })
          .isVisible(),
      ).toBe(false);
    } finally {
      await run.close();
    }
    expect(site.writes).toEqual([]);
  });

  it('a later wizard step follows the answer given on step 1', async () => {
    const steps = async (work_authorization: string) => {
      const run = await runRead(browser, site.url('/form-wizard.html'), {
        profile: { work_authorization },
      });
      try {
        return run.read.requirements.steps.map((s) => s.fields.map((f) => f.label));
      } finally {
        await run.close();
      }
    };
    const no = await steps('No');
    const yes = await steps('Yes');
    expect(no[2]).toEqual([
      'Why do you want to work at Acme Corp?',
      'What are your salary expectations?',
      'Which visa would you need?',
    ]);
    expect(yes[2]).toEqual([
      'Why do you want to work at Acme Corp?',
      'What are your salary expectations?',
    ]);
    expect(site.writes).toEqual([]);
  });

  it('a free-text answer is matched to an option by option_match (Jev), not by a stray "no"', async () => {
    const answer = 'EU citizen, no sponsorship needed';
    // The code alone must not read "no" in that sentence as the option "No".
    expect(matchOptionExact(['Yes', 'No'], answer)).toBeNull();
    const asked: Array<{ label: string; answer: string }> = [];
    const run = await runRead(browser, site.url('/form-conditional.html'), {
      profile: { work_authorization: answer },
      jev: {
        match: (label, a, options) => {
          asked.push({ label, answer: a });
          if (/authori[sz]ed to work/i.test(label) && options.includes('Yes')) return 'Yes';
          if (/sponsorship/i.test(label) && options.includes('No')) return 'No';
          return null;
        },
      },
    });
    try {
      expect(asked).toContainEqual({ label: WORK_AUTH, answer });
      expect(await run.page.getByRole('combobox', { name: WORK_AUTH }).inputValue()).toBe('Yes');
      expect(field(run.read, 'Which country will you work from?').revealedBy?.value).toBe('Yes');
    } finally {
      await run.close();
    }
  });
});
