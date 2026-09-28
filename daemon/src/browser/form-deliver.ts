// Deliver mode: fill the real, live application form with the prepared values and submit it.
// Shares `fillStep` with Read; the difference is what a missing or unfillable control means:
// Read just notes it, Deliver either escalates to the field/step agent or hands off.
import type { Page } from 'playwright';
import {
  type Advance,
  advanceDeterministic,
  type FillValue,
  fillStep,
  pickAdvance,
  submitFinal,
  waitForForm,
  waitForOutcome,
} from './form-engine.ts';
import { dismissConsent } from './form-read.ts';
import { refKey } from './form-types.ts';
import { formSignature, type SnapField, snapshotForm } from './snapshot.ts';

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
    }
  /** A control only live delivery revealed, resolvable from the profile: back to Prepare, not sent. */
  | { kind: 'new_field'; step: number; field: SnapField; value: string };

const CAPTCHA_HOST = /(^|\.)(recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com)$/;

/** Captchas go straight to hand-off (phase 14 adds a solver): detected by frame host or URL. */
export function detectCaptcha(page: Page): string | null {
  for (const frame of page.frames()) {
    try {
      const u = new URL(frame.url());
      if (CAPTCHA_HOST.test(u.hostname)) return u.hostname;
      if (u.hostname.endsWith('google.com') && u.pathname.startsWith('/recaptcha')) {
        return 'recaptcha';
      }
    } catch {
      // about:blank frames etc.
    }
  }
  return null;
}

async function settle(page: Page, ms = 200): Promise<void> {
  await page.waitForTimeout(ms);
}

export async function deliverForm(page: Page, o: DeliverFormOptions): Promise<DeliverFormResult> {
  const notes: string[] = [];
  o.progress?.(`opening ${o.url}`);
  await page.goto(o.url, { waitUntil: 'domcontentloaded' });
  await settle(page, 500);
  await dismissConsent(page);
  const found = await waitForForm(page, 10_000);
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
    const captcha = detectCaptcha(page);
    if (captcha) {
      return {
        kind: 'handoff',
        scope: 'captcha',
        step,
        fieldLabel: null,
        reason: `a captcha (${captcha}) is on this step`,
      };
    }
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
      let outcome = await submitFinal(page, latest, o.signal ? { signal: o.signal } : {});
      if (outcome.kind === 'stuck') {
        o.progress?.(`step ${step}: submission not accepted, escalating`);
        const before = { url: page.url(), sig: await formSignature(page) };
        const fixed = await o.agentStep(fieldsForAgent, outcome.errors, latest);
        outcome = fixed
          ? await waitForOutcome(page, before.url, before.sig, o.signal ? { signal: o.signal } : {})
          : outcome;
      }
      if (outcome.kind === 'stuck') {
        return {
          kind: 'handoff',
          scope: 'step',
          step,
          fieldLabel: null,
          reason: outcome.errors[0] ?? 'the final submission was not accepted',
        };
      }
      return { kind: 'submitted', url: outcome.url, confirmationText: outcome.text };
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
      const before = { url: page.url(), sig: await formSignature(page) };
      const fixed = await o.agentStep(fieldsForAgent, moved.errors, latest);
      moved = fixed
        ? await (async () => {
            const outcome = await waitForOutcome(
              page,
              before.url,
              before.sig,
              o.signal ? { signal: o.signal } : {},
            );
            return outcome.kind === 'confirmed' ? { kind: 'advanced' as const } : outcome;
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
