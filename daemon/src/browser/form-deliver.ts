// Deliver mode: fill the real, live application form with the prepared values and submit it.
// Shares `fillStep` with Read; the difference is what a missing or unfillable control means:
// Read just notes it, Deliver either escalates to the field/step agent or hands off.
import type { Locator, Page } from 'playwright';
import { type CaptchaStep, captchaStep } from './captcha.ts';
import {
  type Advance,
  advanceDeterministic,
  type FillValue,
  fillStep,
  pageBefore,
  pickAdvance,
  submitFinal,
  waitForForm,
  waitForOutcome,
} from './form-engine.ts';
import { dismissConsent, followApply } from './form-read.ts';
import { refKey } from './form-types.ts';
import { type SnapField, snapshotForm } from './snapshot.ts';

export interface DeliverJudge {
  /** field_classify for controls Read never saw (a conditional field only live delivery shows). */
  classify(fields: SnapField[], step: number): Promise<void>;
}

export interface DeliverFormOptions {
  url: string;
  judge: DeliverJudge;
  /** The prepared value for `<step>:<refKey>`, or undefined (required blocks; optional is skipped). */
  valueFor(ref: string, field: SnapField): FillValue | undefined;
  /** Whether `<step>:<refKey>` is a field Prepare already knew about. */
  isKnown(ref: string): boolean;
  /**
   * A control Prepare never saw: if it's a standard field the profile answers on its own
   * (no options to match), the value to add; null hands off instead.
   */
  resolveNewField(field: SnapField): string | null;
  agentField(field: SnapField, value: FillValue, reason: string): Promise<boolean>;
  agentStep(
    fields: Array<{ field: SnapField; value: FillValue | undefined }>,
    errors: string[],
    advance: Advance,
  ): Promise<boolean>;
  /**
   * An emailed security code for a submission made at `since` (read from the connected
   * mailbox), or null when it didn't come. Unset: no mailbox, so a code step hands off.
   */
  securityCode?(since: Date): Promise<string | null>;
  /**
   * The captcha step, run once the step is filled (phase 14: CapMonster, or a guarded
   * platform's challenge rule). Unset: a captcha goes to the candidate (phase 6).
   */
  captcha?(page: Page): Promise<CaptchaStep>;
  /**
   * Called right before anything presses the final submit control (the engine, or the step
   * agent): the caller records that a submission was attempted before it can happen.
   */
  beforeSubmit?(): void | Promise<void>;
  signal?: AbortSignal;
  progress?(message: string): void;
  maxSteps?: number;
}

export type DeliverFormResult =
  | { kind: 'submitted'; url: string; confirmationText: string | null }
  | {
      kind: 'handoff';
      scope: 'field' | 'step' | 'captcha';
      step: number;
      fieldLabel: string | null;
      reason: string;
      /** A guarded platform's challenge (LinkedIn/Xing checkpoint): the platform pauses. */
      challenge?: string;
      /** The submit control was pressed before this: the application may have been sent. */
      afterSubmit?: boolean;
    }
  /** A control only live delivery revealed, resolvable from the profile: back to Prepare, not sent. */
  | { kind: 'new_field'; step: number; field: SnapField; value: string };

export { detectCaptcha } from './captcha.ts';

const CODE_FIELD =
  /(security|verification|confirmation|one[- ]?time|access)[\s_-]*(code|pin)|\botp\b|security_code|verification_code/i;

/**
 * A visible field asking for an emailed code (Greenhouse's "Security code" step), or null.
 * Matched on the field's label, name, id, placeholder and autocomplete.
 */
export async function findSecurityCodeField(page: Page): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const inputs = frame
      .locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])')
      .filter({ visible: true });
    const n = Math.min(await inputs.count().catch(() => 0), 30);
    for (let i = 0; i < n; i++) {
      const input = inputs.nth(i);
      const desc = await input
        .evaluate((e) => {
          const el = e as HTMLInputElement;
          const label = el.labels?.[0]?.textContent ?? '';
          return [
            label,
            el.name,
            el.id,
            el.placeholder,
            el.autocomplete,
            el.getAttribute('aria-label'),
          ]
            .filter(Boolean)
            .join(' ');
        })
        .catch(() => '');
      if (CODE_FIELD.test(desc) || /one-time-code/.test(desc)) return input;
    }
  }
  return null;
}

async function settle(page: Page, ms = 200): Promise<void> {
  await page.waitForTimeout(ms);
}

/** What the candidate reads when delivery stops after the submit control was pressed. */
export const AFTER_SUBMIT =
  'Submit was already pressed, so this application may have been sent: check the page and your inbox before sending it again. ';

export async function deliverForm(page: Page, o: DeliverFormOptions): Promise<DeliverFormResult> {
  const pressed = { submit: false };
  const result = await deliverSteps(page, o, pressed);
  return result.kind === 'handoff' && pressed.submit
    ? { ...result, reason: AFTER_SUBMIT + result.reason, afterSubmit: true }
    : result;
}

async function deliverSteps(
  page: Page,
  o: DeliverFormOptions,
  pressed: { submit: boolean },
): Promise<DeliverFormResult> {
  const notes: string[] = [];
  o.progress?.(`opening ${o.url}`);
  await page.goto(o.url, { waitUntil: 'domcontentloaded' });
  await settle(page, 500);
  await dismissConsent(page);
  // A job page whose form opens from its Apply button (LinkedIn's Easy Apply modal, Xing's
  // apply dialog): pressed like Read pressed it.
  const found = (await waitForForm(page, 10_000)) || (await followApply(page, o.signal));
  if (!found) {
    return {
      kind: 'handoff',
      scope: 'step',
      step: 1,
      fieldLabel: null,
      reason: 'no application form found at the apply URL',
    };
  }

  const maxSteps = o.maxSteps ?? 8;
  for (let i = 0; i < maxSteps; i++) {
    o.signal?.throwIfAborted();
    const step = i + 1;
    const snap = await snapshotForm(page);
    if (!snap) {
      return {
        kind: 'handoff',
        scope: 'step',
        step,
        fieldLabel: null,
        reason: 'the form disappeared',
      };
    }

    o.progress?.(`step ${step}: ${snap.fields.length} fields`);
    const result = await fillStep(page, {
      mode: 'deliver',
      value: async (field) => {
        const ref = `${step}:${refKey(field.ref)}`;
        return o.isKnown(ref) ? o.valueFor(ref, field) : undefined;
      },
      classify: (fields) => o.judge.classify(fields, step),
      agentField: o.agentField,
      notes,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.progress ? { progress: o.progress } : {}),
    });

    if (result.kind === 'handoff') {
      return {
        kind: 'handoff',
        scope: 'field',
        step,
        fieldLabel: result.field.label,
        reason: result.reason,
      };
    }
    if (result.kind === 'missing_value') {
      const ref = `${step}:${refKey(result.field.ref)}`;
      if (!o.isKnown(ref)) {
        const resolved = o.resolveNewField(result.field);
        if (resolved !== null)
          return { kind: 'new_field', step, field: result.field, value: resolved };
      }
      return {
        kind: 'handoff',
        scope: 'field',
        step,
        fieldLabel: result.field.label,
        reason: `a required value is missing for "${result.field.label || result.field.kind}"`,
      };
    }

    // The captcha step runs only now, with the step filled: solved (CapMonster), or handed to
    // the candidate, who then only solves it and presses the button.
    const captcha = o.captcha ? await o.captcha(page) : await captchaStep(page, null);
    if (captcha.kind === 'handoff') {
      return {
        kind: 'handoff',
        scope: 'captcha',
        step,
        fieldLabel: null,
        reason: captcha.reason,
        ...(captcha.challenge ? { challenge: captcha.challenge } : {}),
      };
    }

    const latest = pickAdvance(result.snapshot.buttons);
    const fieldsForAgent = result.fields.map((field) => ({
      field,
      value: o.valueFor(`${step}:${refKey(field.ref)}`, field),
    }));

    if (latest.isFinal) {
      if (!latest.ref) {
        return {
          kind: 'handoff',
          scope: 'step',
          step,
          fieldLabel: null,
          reason: 'no submit control found',
        };
      }
      const submittedAt = new Date();
      const wait = o.signal ? { signal: o.signal } : {};
      let outcome = await submitFinal(page, latest, {
        ...wait,
        ...(o.beforeSubmit ? { beforeSubmit: o.beforeSubmit } : {}),
      });
      // With an error on the page the step agent fixes it and presses again. With neither an
      // error nor a confirmation nobody presses a second time: that could send it twice.
      if (outcome.kind === 'stuck' && !outcome.unclear) {
        o.progress?.(`step ${step}: submission not accepted, escalating`);
        const before = await pageBefore(page);
        const fixed = await o.agentStep(fieldsForAgent, outcome.errors, latest);
        outcome = fixed ? await waitForOutcome(page, before, wait) : outcome;
      }
      // The control led to another form: it wasn't the last step after all. Carry on there.
      // Without an error on the page, the press may well have sent it.
      if (outcome.kind === 'moved' || (outcome.kind === 'stuck' && outcome.unclear)) {
        pressed.submit = true;
      }
      if (outcome.kind === 'moved') {
        o.progress?.(`step ${step}: "${latest.text}" led to another form`);
        await waitForForm(page, 8000);
        continue;
      }
      // An emailed security code (Greenhouse): read it from the mailbox, enter it, submit again.
      const codeField = await findSecurityCodeField(page);
      if (codeField) {
        if (!o.securityCode) {
          return {
            kind: 'handoff',
            scope: 'step',
            step,
            fieldLabel: 'Security code',
            reason:
              'the site emailed a security code and no mailbox is connected: enter the code yourself',
          };
        }
        o.progress?.(`step ${step}: the site emailed a security code, reading it from the mailbox`);
        const code = await o.securityCode(submittedAt);
        if (!code) {
          return {
            kind: 'handoff',
            scope: 'step',
            step,
            fieldLabel: 'Security code',
            reason:
              "the site emailed a security code and it didn't arrive in the connected mailbox",
          };
        }
        await codeField.fill(code);
        const snap2 = await snapshotForm(page);
        const again = snap2 ? pickAdvance(snap2.buttons) : null;
        if (!again?.ref) {
          return {
            kind: 'handoff',
            scope: 'step',
            step,
            fieldLabel: 'Security code',
            reason: 'the security code is filled in, but there is no button to send it',
          };
        }
        outcome = await submitFinal(page, again, wait);
        if (outcome.kind !== 'stuck' && (await findSecurityCodeField(page))) {
          outcome = {
            kind: 'stuck',
            errors: ['the site did not accept the emailed security code'],
            unclear: false,
          };
        }
      }
      if (outcome.kind === 'confirmed') {
        return { kind: 'submitted', url: outcome.url, confirmationText: outcome.text };
      }
      return {
        kind: 'handoff',
        scope: 'step',
        step,
        fieldLabel: codeField ? 'Security code' : null,
        reason:
          outcome.kind === 'moved'
            ? 'the site showed another form instead of a confirmation'
            : (outcome.errors[0] ??
              'the page showed neither a confirmation nor an error after submit was pressed'),
      };
    }

    if (!latest.ref) {
      return {
        kind: 'handoff',
        scope: 'step',
        step,
        fieldLabel: null,
        reason: 'no way to move to the next step',
      };
    }
    o.progress?.(`step ${step}: pressing "${latest.text}"`);
    let moved = await advanceDeterministic(page, latest, o.signal ? { signal: o.signal } : {});
    if (moved.kind === 'stuck') {
      const before = await pageBefore(page);
      const fixed = await o.agentStep(fieldsForAgent, moved.errors, latest);
      moved = fixed
        ? await (async () => {
            const outcome = await waitForOutcome(
              page,
              before,
              o.signal ? { signal: o.signal } : {},
            );
            return outcome.kind === 'stuck' ? outcome : { kind: 'advanced' as const };
          })()
        : moved;
    }
    if (moved.kind === 'stuck') {
      return {
        kind: 'handoff',
        scope: 'step',
        step,
        fieldLabel: null,
        reason: moved.errors[0] ?? `"${latest.text}" didn't move to the next step`,
      };
    }
    if (i === maxSteps - 1) {
      return {
        kind: 'handoff',
        scope: 'step',
        step,
        fieldLabel: null,
        reason: `stopped after ${maxSteps} steps`,
      };
    }
  }
  return {
    kind: 'handoff',
    scope: 'step',
    step: maxSteps,
    fieldLabel: null,
    reason: 'ran out of steps',
  };
}
