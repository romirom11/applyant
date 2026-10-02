// Every application target (a web form, later email and Telegram) implements the same
// contract, so preparation, review and delivery are identical whatever the channel. The TDD's
// `interface Channel { read, deliver }`: `read` is the phase-4 reader (kept as a plain function
// there too, since `read_form`'s handler already calls it directly and nothing here should
// risk that path); `deliver` is new in this phase.
import type { Page } from 'playwright';
import type { CaptchaStep } from '../browser/captcha.ts';
import type { ReadFormOptions, ReadFormResult } from '../browser/form-read.ts';
import type { FieldSpec } from '../browser/form-types.ts';
import type { ApplicationRow, FieldSource, PostingRow } from '../db/schema.ts';
import type { ApplicationView } from '../domain/applications/store.ts';
import type { StandardProfile } from '../domain/knowledge/profile.ts';
import type { HandOff } from '../queue/types.ts';

export interface ReceiptFieldSent {
  ref: string;
  label: string;
  value: string | null;
  source: FieldSource;
}

export interface DeliveryReceipt {
  finalUrl: string;
  confirmationText: string | null;
  confirmationSnapshotPath: string | null;
  cvPath: string | null;
  cvHash: string | null;
  salaryValue: string | null;
  fieldValues: ReceiptFieldSent[];
  submittedAt: Date;
  /** Email applications: the sent message's Message-ID (replies thread to it). */
  messageId?: string | null;
}

/** A control Prepare never saw, resolved from the profile: nothing was sent yet. */
export interface NewFieldFound {
  /** `<step>:<refKey>`, as `field_values.field_ref` (formFields()'s convention). */
  ref: string;
  spec: FieldSpec;
  value: string;
}

export type DeliverOutcome =
  | { kind: 'applied'; receipt: DeliveryReceipt }
  /** `challenge`: a guarded platform's own check was on the page (the platform pauses). */
  | { kind: 'needs_candidate'; handOff: HandOff; challenge?: string }
  | { kind: 'new_field'; field: NewFieldFound };

/** The application stopped waiting for delivery while this one was queued: nothing to send. */
export class DeliveryStale extends Error {
  constructor() {
    super('the application is no longer waiting to be delivered');
    this.name = 'DeliveryStale';
  }
}

export interface DeliverContext {
  taskId: number;
  signal: AbortSignal;
  progress(message: string): void;
  /**
   * Called once the channel is about to start for real (for the web form: inside the one-at-a-
   * time browser lock). Throws `DeliveryStale` when the application is no longer waiting to be
   * sent, so a delivery that queued behind another one never sends it a second time.
   */
  begin(): void;
  /**
   * Called right before the irreversible step (pressing submit, sending the email or the
   * Telegram message): records durably that a submission was attempted. Throws if it couldn't
   * be recorded; nothing may be sent then.
   */
  submitting(): void;
  /** The candidate's standard-field profile, for a value a control found only at delivery needs. */
  profile: StandardProfile;
  /**
   * An emailed security code for a submission made at `since`, read from the connected
   * mailbox (phase 13); absent when no mailbox is connected.
   */
  securityCode?(since: Date): Promise<string | null>;
  /**
   * The captcha step once a step is filled (phase 14): CapMonster, or on LinkedIn/Xing a
   * challenge for the candidate. Absent: captchas go to the candidate (phase 6).
   */
  captcha?(page: Page): Promise<CaptchaStep>;
  /** A guarded platform: whether the page delivery stopped on is its challenge. */
  challenge?(page: Page): Promise<string | null>;
}

/** What a channel needs to deliver: the application as review left it, and its posting. */
export interface Channel {
  read(o: ReadFormOptions): Promise<ReadFormResult>;
  deliver(
    app: ApplicationRow,
    posting: PostingRow,
    view: ApplicationView,
    ctx: DeliverContext,
  ): Promise<DeliverOutcome>;
}
