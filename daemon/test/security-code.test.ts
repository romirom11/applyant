// Greenhouse-style emailed security codes: the fixture form asks for a code after the first
// submit; delivery reads it from the (fake) mailbox, enters it and the application goes through.
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DeliverFormOptions, deliverForm } from '../src/browser/form-deliver.ts';
import {
  extractSecurityCode,
  waitForSecurityCode,
} from '../src/domain/applications/security-code.ts';
import { FakeMailbox } from './helpers/mail.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

const GREENHOUSE = `Hi Roman,

Copy and paste this code into the security code field on your application:

X7K2M9QA

After you enter the code, resubmit your application.`;

describe('extractSecurityCode', () => {
  it('reads codes the way ATS emails write them', () => {
    expect(
      extractSecurityCode({
        subject: 'Security code for your application to Code Co',
        text: GREENHOUSE,
      }),
    ).toBe('X7K2M9QA');
    expect(
      extractSecurityCode({
        subject: 'Verify',
        text: 'Your verification code: 482913. It expires in 10 minutes.',
      }),
    ).toBe('482913');
    expect(
      extractSecurityCode({ subject: 'Your one-time code', text: 'Use AB12CD to continue.' }),
    ).toBe('AB12CD');
    expect(
      extractSecurityCode({
        subject: 'Thanks for applying',
        text: 'We received your application for role 2024.',
      }),
    ).toBeNull();
    expect(
      extractSecurityCode({ subject: 'Security code', text: 'Your code is below.\n\nThanks' }),
    ).toBeNull();
  });

  it('waits for the code to arrive after the submission, ignoring older ones', async () => {
    const box = new FakeMailbox();
    const since = new Date();
    box.add({
      fromAddress: 'no-reply@greenhouse.io',
      subject: 'Security code',
      text: 'code: OLD12345',
      date: new Date(since.getTime() - 3_600_000),
    });
    box.onSync = (n) => {
      if (n === 3)
        box.add({
          fromAddress: 'no-reply@greenhouse.io',
          subject: 'Security code for your application',
          text: GREENHOUSE,
        });
    };
    const code = await waitForSecurityCode(box, {
      since,
      timeoutMs: 5_000,
      pollMs: 10,
      sleep: async () => {},
    });
    expect(code).toBe('X7K2M9QA');
    expect(box.syncs).toBe(3);
    const none = await waitForSecurityCode(new FakeMailbox(), {
      since,
      timeoutMs: 30,
      pollMs: 10,
      sleep: async () => {},
    });
    expect(none).toBeNull();
  });
});

describe('the security-code step in delivery', () => {
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

  function options(securityCode?: DeliverFormOptions['securityCode']): DeliverFormOptions {
    const values: Record<string, string> = { 'Full Name': 'Roman Kudin', Email: 'me@example.org' };
    return {
      url: site.url('/form-deliver-code.html'),
      judge: { classify: async () => {} },
      valueFor: (_ref, field) => {
        const v = values[field.label.replace(/\s*\*$/, '')];
        return v ? { kind: 'text', text: v } : undefined;
      },
      isKnown: () => true,
      resolveNewField: () => null,
      agentField: async () => false,
      agentStep: async () => false,
      ...(securityCode ? { securityCode } : {}),
    };
  }

  it('reads the code from the mailbox, enters it and submits', async () => {
    const page = await browser.newPage();
    const box = new FakeMailbox();
    let asked: Date | null = null;
    const result = await deliverForm(
      page,
      options(async (since) => {
        asked = since;
        box.add({
          fromAddress: 'no-reply@greenhouse.io',
          subject: 'Security code for your application to Code Co',
          text: GREENHOUSE,
        });
        return waitForSecurityCode(box, { since, timeoutMs: 2_000, pollMs: 10 });
      }),
    );
    expect(asked).toBeInstanceOf(Date);
    expect(result.kind).toBe('submitted');
    expect(
      await page.evaluate(() => (window as unknown as { __submitted: number }).__submitted),
    ).toBe(1);
    await page.close();
  }, 60_000);

  it('hands off when no mailbox is connected, or the code never comes', async () => {
    const page = await browser.newPage();
    const noMailbox = await deliverForm(page, options());
    expect(noMailbox).toMatchObject({ kind: 'handoff', fieldLabel: 'Security code' });
    if (noMailbox.kind === 'handoff') expect(noMailbox.reason).toMatch(/no mailbox is connected/);

    const late = await deliverForm(
      page,
      options(async () => null),
    );
    expect(late).toMatchObject({ kind: 'handoff', fieldLabel: 'Security code' });
    if (late.kind === 'handoff') expect(late.reason).toMatch(/didn't arrive/);
    await page.close();
  }, 60_000);
});
