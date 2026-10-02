// The form engine: one deterministic pass over a step, shared by Read and (phase 6) Deliver.
//
//   fillStep     field by field; after every fill a cheap controls signature says whether
//                fields appeared or disappeared, and only then the form is snapshotted again
//                and new fields merged in (conditional fields remember what revealed them).
//                Read also tries each option of small choice fields, so the fields each
//                answer reveals are known before Prepare.
//   pickAdvance  the step's next / submit control and whether it submits (isFinal)
//   advanceDeterministic  press a non-final advance control and wait for the next step
//
// In Deliver a field the code can't operate goes to the field agent (`agentField`); a step
// that won't advance goes to the step agent (form-deliver.ts). Read only notes such a field.
import type { Locator, Page } from 'playwright';
import type { ElementRef, FieldSpec, RevealedBy } from './form-types.ts';
import { refKey } from './form-types.ts';
import {
  asksSignIn,
  type FormSnapshot,
  formSignature,
  frameRoot,
  locate,
  type SnapButton,
  type SnapField,
  signatureHasControls,
  signatureOf,
  snapshotForm,
} from './snapshot.ts';

export type FormMode = 'read' | 'deliver';

export type FillValue =
  | { kind: 'text'; text: string }
  /** One option of a select, radio group, combobox or checkbox group. */
  | { kind: 'option'; option: string }
  /** Several options of a checkbox group / multi-select. */
  | { kind: 'options'; options: string[] }
  | { kind: 'check'; checked: boolean }
  | { kind: 'file'; file: { name: string; mimeType: string; buffer: Buffer } | string }
  /** For comboboxes whose options appear only once opened or typed into: pick from what shows. */
  | { kind: 'choose'; text: string | null; pick(options: string[]): Promise<string | null> }
  | { kind: 'skip' };

export type FillResult =
  | {
      ok: true /** Options discovered by opening the control (static lists only). */;
      options?: string[] | null;
    }
  | { ok: false; reason: string };

// Playwright's actionability wait for one action (visible, stable, enabled, receiving events).
// 4 s was too tight on a busy Mac (load average 20–30): a press of the submit button timed out,
// the delivery threw and was retried later. A control that never becomes usable costs this long
// once before the agent or a hand-off takes over.
const ACTION_MS = 10_000;

async function settle(page: Page, ms = 150): Promise<void> {
  await page.waitForTimeout(ms);
}

/** The option controls of a group field, in the same order as `field.options`. */
function groupMembers(page: Page, field: FieldSpec): Locator {
  const ref = field.ref;
  if (ref.css) return locate(page, ref);
  const container = locate(page, ref);
  return container.getByRole(field.kind === 'checkbox' ? 'checkbox' : 'radio');
}

async function clickChoice(member: Locator, want: boolean): Promise<boolean> {
  const tag = await member.evaluate((el) => el.tagName).catch(() => '');
  if (tag !== 'INPUT') {
    // Toggle buttons and custom checkboxes: aria-pressed / aria-checked follows the click.
    const state = async () =>
      ((await member.getAttribute('aria-pressed').catch(() => null)) ??
        (await member.getAttribute('aria-checked').catch(() => null))) === 'true';
    if ((await state()) !== want) await member.click({ timeout: ACTION_MS });
    return (await state()) === want || (await member.getAttribute('aria-checked')) === null;
  }
  try {
    if (want) await member.check({ timeout: ACTION_MS });
    else await member.uncheck({ timeout: ACTION_MS });
    return true;
  } catch {
    // Custom-styled inputs are often covered by their decoration: click the element itself.
    await member.evaluate((el, w) => {
      const input = el as HTMLInputElement;
      if (input.checked !== w) input.click();
    }, want);
    return (await member.isChecked().catch(() => !want)) === want;
  }
}

/** Options shown by an open combobox (its listbox, else any visible options in the frame). */
async function openOptions(
  page: Page,
  field: FieldSpec,
  control: Locator,
): Promise<{ list: Locator; texts: string[] }> {
  const root = frameRoot(page, field.ref.frame);
  const controls =
    (await control.getAttribute('aria-controls').catch(() => null)) ||
    (await control.getAttribute('aria-owns').catch(() => null));
  const scoped = controls ? root.locator(`[id="${controls.replace(/"/g, '\\"')}"]`) : null;
  const list = (scoped && (await scoped.count().catch(() => 0)) > 0 ? scoped : root.locator('body'))
    .getByRole('option')
    .filter({ visible: true });
  await list
    .first()
    .waitFor({ state: 'visible', timeout: 1500 })
    .catch(() => {});
  // Long menus render in pieces: read them once the number of options stops changing.
  let texts: string[] = [];
  for (let i = 0; i < 12; i++) {
    const next = (await list.allInnerTexts().catch(() => [] as string[])).map((t) =>
      t.replace(/\s+/g, ' ').trim(),
    );
    const done = next.length === 0 || (i > 0 && next.length === texts.length);
    texts = next;
    if (done) break;
    await page.waitForTimeout(150);
  }
  return { list, texts };
}

async function fillCombobox(
  page: Page,
  field: FieldSpec,
  control: Locator,
  text: string | null,
  pick: (options: string[]) => Promise<string | null>,
): Promise<FillResult> {
  await control.click({ timeout: ACTION_MS });
  let { list, texts } = await openOptions(page, field, control);
  let typed = false;
  if (texts.length === 0 && text) {
    // Options load as you type (location search). Searches often find nothing for the whole
    // value ("Athens, Greece") but do for its first part ("Athens").
    const tries = [
      ...new Set(
        [text, text.split(',')[0] ?? text, text.split(/\s+/)[0] ?? text].map((t) =>
          t.trim().slice(0, 30),
        ),
      ),
    ].filter(Boolean);
    for (const attempt of tries) {
      await control.fill('').catch(() => {});
      await control.pressSequentially(attempt, { delay: 20, timeout: ACTION_MS });
      await settle(page, 900);
      ({ list, texts } = await openOptions(page, field, control));
      typed = true;
      if (texts.length) break;
    }
  }
  if (texts.length === 0) {
    await control.press('Escape').catch(() => {});
    return { ok: false, reason: 'no options appeared' };
  }
  const known = texts.filter(Boolean);
  const choice = await pick(known);
  if (!choice) {
    await control.press('Escape').catch(() => {});
    return { ok: false, reason: 'no option matches' };
  }
  const i = texts.indexOf(choice);
  await list.nth(i).click({ timeout: ACTION_MS });
  await settle(page);
  if ((await control.getAttribute('aria-expanded').catch(() => null)) === 'true') {
    await control.press('Escape').catch(() => {});
  }
  return { ok: true, options: typed ? null : known };
}

/** Operates one control with the Playwright API. Never presses a submit button. */
export async function fillField(
  page: Page,
  field: FieldSpec,
  value: FillValue,
): Promise<FillResult> {
  if (value.kind === 'skip') return { ok: true };
  try {
    switch (field.kind) {
      case 'text':
      case 'textarea':
      case 'date': {
        if (value.kind !== 'text') return { ok: false, reason: `${field.kind} needs text` };
        await locate(page, field.ref).first().fill(value.text, { timeout: ACTION_MS });
        return { ok: true };
      }
      case 'select': {
        const control = locate(page, field.ref).first();
        if (value.kind === 'option') {
          await control.selectOption({ label: value.option }, { timeout: ACTION_MS });
        } else if (value.kind === 'options') {
          await control.selectOption(
            value.options.map((label) => ({ label })),
            { timeout: ACTION_MS },
          );
        } else return { ok: false, reason: 'select needs an option' };
        return { ok: true };
      }
      case 'radio':
      case 'checkbox': {
        if (
          field.kind === 'checkbox' &&
          (!field.options || field.options.length <= 1) &&
          !field.ref.css?.includes('input[type="checkbox"]')
        ) {
          // A single checkbox (consent, "I have a portfolio").
          const want = value.kind === 'check' ? value.checked : value.kind === 'option';
          const ok = await clickChoice(locate(page, field.ref).first(), want);
          return ok ? { ok: true } : { ok: false, reason: 'checkbox did not change' };
        }
        const wanted =
          value.kind === 'option'
            ? [value.option]
            : value.kind === 'options'
              ? value.options
              : null;
        if (!wanted || !field.options)
          return { ok: false, reason: `${field.kind} needs an option` };
        const members = groupMembers(page, field);
        for (const option of wanted) {
          const i = field.options.indexOf(option);
          if (i < 0) return { ok: false, reason: `no option "${option}"` };
          if (!(await clickChoice(members.nth(i), true))) {
            return { ok: false, reason: `option "${option}" did not stick` };
          }
        }
        return { ok: true };
      }
      case 'combobox': {
        const control = locate(page, field.ref).first();
        if (value.kind === 'choose')
          return await fillCombobox(page, field, control, value.text, value.pick);
        if (value.kind === 'option' || value.kind === 'text') {
          const want = value.kind === 'option' ? value.option : value.text;
          return await fillCombobox(page, field, control, want, async (options) =>
            options.includes(want)
              ? want
              : (options.find((o) => o.toLowerCase() === want.toLowerCase()) ?? null),
          );
        }
        return { ok: false, reason: 'combobox needs an option' };
      }
      case 'file': {
        if (value.kind !== 'file') return { ok: false, reason: 'file needs a file' };
        await locate(page, field.ref).first().setInputFiles(value.file, { timeout: ACTION_MS });
        return { ok: true };
      }
      default:
        return { ok: false, reason: `can't operate a ${field.kind} control` };
    }
  } catch (err) {
    return { ok: false, reason: firstLine(err) };
  }
}

// ---- advancing --------------------------------------------------------------------------

const NEXT =
  /^(next|continue|weiter|suivant|siguiente|avanti|próximo|proximo|volgende|dalej|далі|далее|продовжити|продолжить|proceed|review)\b|save (and|&) continue|next step|continue to/i;
const FINAL =
  /\b(submit|apply|send|finish|complete)\b|bewerb|absenden|senden|envoyer|postuler|enviar|inviare|invia|verzenden|отправить|надіслати|подати/i;
/**
 * Words that say the button sends the form. "Weiter zur Bewerbung" and "Continue to apply" name
 * the application without sending it, so a "next" button stays next unless one of these is in it.
 */
const SENDS =
  /\b(submit|send|finish|complete)\b|absenden|senden|envoyer|enviar|inviare|invia|verzenden|отправить|надіслати|подати|jetzt bewerben|apply now/i;
/** Buttons that are never a step's advance control, whatever their words. */
const NOT_ADVANCE =
  /linkedin|indeed|seek|google|import|autofill|upload|attach|choose file|add (another|more)|^\+|^add\b|save (as|for) (draft|later)|cancel|back|previous|clear|remove|delete|toggle|cookie|accept all|decline/i;

export interface Advance {
  ref: ElementRef | null;
  text: string | null;
  isFinal: boolean;
}

/**
 * The step's advance control. A button is "next" only when its words clearly say so and
 * nothing in them says submit; anything else that could send the form counts as final, so
 * Read never presses it.
 */
export function pickAdvance(buttons: SnapButton[]): Advance {
  const candidates = buttons.filter((b) => !NOT_ADVANCE.test(b.text));
  const inRootFirst = (list: SnapButton[]) => [
    ...list.filter((b) => b.inRoot),
    ...list.filter((b) => !b.inRoot),
  ];
  const next = inRootFirst(candidates.filter((b) => NEXT.test(b.text) && !SENDS.test(b.text)));
  if (next[0]) return { ref: next[0].ref, text: next[0].text, isFinal: false };
  const final = inRootFirst(
    candidates.filter((b) => FINAL.test(b.text) || (b.submit && b.inRoot)),
  ).sort((a, b) => Number(b.submit) - Number(a.submit));
  // Prefer the last submit-like control of the form (page headers often repeat "Apply").
  const inRoot = final.filter((b) => b.inRoot);
  const chosen = inRoot.at(-1) ?? final[0];
  if (chosen) return { ref: chosen.ref, text: chosen.text, isFinal: true };
  return { ref: null, text: null, isFinal: true };
}

export type AdvanceResult = { kind: 'advanced' } | { kind: 'stuck'; errors: string[] };

/** Presses a non-final advance control and waits for the next step to show. */
export async function advanceDeterministic(
  page: Page,
  advance: Advance,
  o: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AdvanceResult> {
  if (!advance.ref || advance.isFinal) {
    throw new Error('refusing to press a final or missing advance control');
  }
  const before = await formSignature(page);
  const url = page.url();
  await locate(page, advance.ref).first().click({ timeout: ACTION_MS });
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  let last = '';
  while (Date.now() < deadline) {
    o.signal?.throwIfAborted();
    await settle(page, 250);
    if (page.url() !== url) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await waitForForm(page, 8000);
      return { kind: 'advanced' };
    }
    const sig = await formSignature(page).catch(() => '');
    if (sig && sig !== before) {
      // Wait until it stops changing (the next step renders in pieces).
      if (sig === last) return { kind: 'advanced' };
      last = sig;
    }
  }
  const snap = await snapshotForm(page).catch(() => null);
  return { kind: 'stuck', errors: snap?.errors ?? [] };
}

export type SubmitResult =
  | { kind: 'confirmed'; url: string; text: string | null }
  /**
   * The press led to another form instead of a confirmation: the control wasn't the final one
   * after all (or the site asks for a sign-in). Nothing says the application was sent.
   */
  | { kind: 'moved'; url: string }
  /**
   * `unclear`: the page showed neither a confirmation nor an error by the deadline, so the
   * submission may or may not have gone through.
   */
  | { kind: 'stuck'; errors: string[]; unclear: boolean };

const CONFIRMED_TEXT =
  /\b(thank you|thanks for (applying|your application)|application (has been |was )?(submitted|received|sent)|we('| ha)ve received|we('ll| will) be in touch|confirmation|vielen dank|bewerbung (ist |wurde )?(eingegangen|gesendet|abgeschickt|erhalten)|merci|gracias|grazie)\b|дякуємо|спасибо|заявк[ау] (отримано|надіслано|отправлена|получена)/gi;

/** Confirmation wording the page shows now and didn't show before the press. */
export function newConfirmation(before: string | null, after: string | null): boolean {
  if (!after) return false;
  const found = (text: string) =>
    new Set((text.match(CONFIRMED_TEXT) ?? []).map((m) => m.toLowerCase()));
  const was = found(before ?? '');
  for (const phrase of found(after)) if (!was.has(phrase)) return true;
  return false;
}

/** The page's address without its fragment: `#step-2` alone is not a navigation. */
function place(url: string): string {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
}

export interface SubmitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Called right before the press, so the caller can record durably that a submission was
   * attempted (a delivery interrupted after the press must not submit a second time).
   */
  beforeSubmit?(): void | Promise<void>;
}

/** What the page looked like before a press, for `waitForOutcome` to compare against. */
export interface PageBefore {
  url: string;
  signature: string;
  text: string | null;
}

export async function pageBefore(page: Page): Promise<PageBefore> {
  return { url: page.url(), signature: await formSignature(page), text: await bodyText(page) };
}

/**
 * Presses the step's final (submit) control and waits for a sign the application went through:
 * the page left for one without a form, the form's controls disappeared, or confirmation
 * wording appeared that wasn't there before. Another form showing up is `moved`; anything else
 * by the deadline is `stuck`, with whatever the page shows as an error.
 */
export async function submitFinal(
  page: Page,
  advance: Advance,
  o: SubmitOptions = {},
): Promise<SubmitResult> {
  if (!advance.ref) throw new Error('no submit control to press');
  const before = await pageBefore(page);
  await o.beforeSubmit?.();
  await locate(page, advance.ref).first().click({ timeout: ACTION_MS });
  return waitForOutcome(page, before, o);
}

/**
 * Waits for the same signs of success `submitFinal` looks for, without pressing anything itself:
 * used to check what a step-scoped agent's own click already did.
 */
export async function waitForOutcome(
  page: Page,
  before: PageBefore,
  o: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SubmitResult> {
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  let gone = 0;
  while (Date.now() < deadline) {
    o.signal?.throwIfAborted();
    await settle(page, 250);
    if (place(page.url()) !== place(before.url)) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await settle(page, 500);
      const text = await bodyText(page);
      if (newConfirmation(before.text, text)) return { kind: 'confirmed', url: page.url(), text };
      // A new page that is itself a form (the next step, a sign-in) is not a confirmation.
      const sig = await formSignature(page).catch(() => '');
      if (signatureHasControls(sig) || (await asksSignIn(page).catch(() => false))) {
        return { kind: 'moved', url: page.url() };
      }
      return { kind: 'confirmed', url: page.url(), text };
    }
    const sig = await formSignature(page).catch(() => '');
    const text = await bodyText(page);
    if (!signatureHasControls(sig)) {
      // The form's controls are gone: a confirmation replaced it in place. Seen twice in a
      // row, because a page in the middle of navigating away also reads as "no controls".
      if (++gone >= 2) return { kind: 'confirmed', url: page.url(), text };
      continue;
    }
    gone = 0;
    if (sig !== before.signature) {
      // Something changed but a form is still here: give it a moment to settle. With errors
      // on the page it's a validation failure, whatever else the page says.
      await settle(page, 500);
      const snap = await snapshotForm(page).catch(() => null);
      const alerts = await visibleAlerts(page);
      if (snap?.errors.length || alerts.length) {
        return { kind: 'stuck', errors: [...(snap?.errors ?? []), ...alerts], unclear: false };
      }
    }
    if (newConfirmation(before.text, text)) return { kind: 'confirmed', url: page.url(), text };
  }
  const snap = await snapshotForm(page).catch(() => null);
  const alerts = await visibleAlerts(page);
  const errors = [...(snap?.errors ?? []), ...alerts];
  return { kind: 'stuck', errors, unclear: errors.length === 0 };
}

async function bodyText(page: Page): Promise<string | null> {
  return page
    .locator('body')
    .innerText({ timeout: 2000 })
    .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 4000))
    .catch(() => null);
}

/** Visible `role=alert` text anywhere on the page (a "click again to confirm" prompt, etc.). */
async function visibleAlerts(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const frame of page.frames()) {
    const alerts = frame.locator('[role=alert]').filter({ visible: true });
    const n = Math.min(await alerts.count().catch(() => 0), 5);
    for (let i = 0; i < n; i++) {
      const text = (
        await alerts
          .nth(i)
          .innerText()
          .catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.push(text.slice(0, 200));
    }
  }
  return out;
}

/** Waits until the page shows form controls and they stop changing; false if none show. */
export async function waitForForm(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const sig = await formSignature(page).catch(() => '');
    const hasControls = signatureHasControls(sig);
    if (hasControls && sig === last) {
      if (++stable >= 2) return true;
    } else stable = 0;
    last = sig;
    await settle(page, 300);
  }
  return signatureHasControls(last);
}

// ---- one step ---------------------------------------------------------------------------

export interface FillStepOptions {
  mode: FormMode;
  /** The value for a field; undefined = no value (Deliver hands off on a required one). */
  value(field: SnapField): Promise<FillValue | undefined>;
  /** Sets `meaning` on newly seen fields (field_classify). */
  classify?(fields: SnapField[]): Promise<void>;
  /** Read: try each option of choice fields with at most `maxOptions` options. */
  explore?: { maxOptions: number; budget: number };
  /**
   * Deliver: a control the deterministic pass couldn't operate gets one field-scoped agent run
   * (≤ N tool calls). `reason` is why the deterministic attempt failed. Returns whether the
   * field now holds `value`; false ends the step in a field hand-off.
   */
  agentField?(field: SnapField, value: FillValue, reason: string): Promise<boolean>;
  signal?: AbortSignal;
  notes: string[];
  progress?(message: string): void;
}

export type StepResult =
  | { kind: 'filled'; fields: SnapField[]; snapshot: FormSnapshot }
  | { kind: 'missing_value'; field: SnapField; fields: SnapField[] }
  | { kind: 'handoff'; scope: 'field'; field: SnapField; reason: string; fields: SnapField[] };

const CHOICE_KINDS = new Set(['select', 'radio', 'combobox']);

const shape = (f: SnapField) => `${f.kind}\u0000${f.label}\u0000${f.ref.role}\u0000${f.ref.name}`;

/**
 * A snapshot taken once the form stops changing: React forms re-render in pieces, and a
 * snapshot of a half-rendered form would make the rest look newly revealed.
 */
async function settledSnapshot(page: Page, timeoutMs = 3000): Promise<FormSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  let last = await formSignature(page);
  for (;;) {
    await settle(page, 200);
    const sig = await formSignature(page);
    if (sig === last || Date.now() > deadline) {
      const snap = await snapshotForm(page);
      if (!snap || signatureOf(snap.frame.url(), snap.signature) === sig || Date.now() > deadline) {
        return snap;
      }
      last = await formSignature(page);
      continue;
    }
    last = sig;
  }
}

/** The option (or "checked") a fill value stands for, as recorded in revealedBy. */
function valueLabel(value: FillValue): string {
  switch (value.kind) {
    case 'option':
      return value.option;
    case 'options':
      return value.options.join(', ');
    case 'check':
      return value.checked ? 'checked' : 'unchecked';
    default:
      return '*';
  }
}

/**
 * Fills the current step. Fields are taken in order; after each fill, fields that appeared are
 * merged in with `revealedBy`. Returns every field the step showed, including (Read) the ones
 * other answers would reveal.
 */
export async function fillStep(page: Page, o: FillStepOptions): Promise<StepResult> {
  let snap = await snapshotForm(page);
  if (!snap) throw new Error('no form on the page');
  const list: SnapField[] = [];
  const byKey = new Map<string, SnapField>();
  const identity = (f: SnapField) =>
    `${refKey(f.ref)}${f.revealedBy ? `<${refKey(f.revealedBy.ref)}=${f.revealedBy.value}` : ''}`;
  const add = async (fields: SnapField[], after: SnapField | null) => {
    const fresh = fields.filter((f) => !byKey.has(identity(f)));
    if (fresh.length === 0) return;
    for (const f of fresh) byKey.set(identity(f), f);
    let at = after ? list.indexOf(after) : -1;
    if (at < 0) at = list.length;
    else {
      // After the field and whatever it already revealed.
      const k = refKey(after?.ref ?? fresh[0]?.ref ?? ({} as ElementRef));
      at++;
      while (list[at]?.revealedBy && refKey(list[at]?.revealedBy?.ref as ElementRef) === k) at++;
    }
    list.splice(at, 0, ...fresh);
    await o.classify?.(fresh);
  };
  const visibleKeys = (s: FormSnapshot) => new Set(s.fields.map((f) => refKey(f.ref)));
  await add(snap.fields, null);
  let visible = visibleKeys(snap);
  const done = new Set<SnapField>();
  let budget = o.explore?.budget ?? 0;

  /** Re-snapshots when controls changed since `before`; returns fields that weren't visible. */
  const refresh = async (before: string): Promise<SnapField[]> => {
    const sig = await formSignature(page);
    if (sig === before) return [];
    const next = await settledSnapshot(page);
    if (!next) return [];
    const old = visible;
    const oldShapes = new Set(snap?.fields.map(shape) ?? []);
    snap = next;
    visible = visibleKeys(next);
    // A field is new only if nothing with its label and kind was showing before (a ref can
    // change when a control is re-rendered).
    return next.fields.filter((f) => !old.has(refKey(f.ref)) && !oldShapes.has(shape(f)));
  };

  for (;;) {
    o.signal?.throwIfAborted();
    const field = list.find((f) => !done.has(f) && visible.has(refKey(f.ref)));
    if (!field) break;
    done.add(field);
    if (field.kind === 'group') {
      if (o.mode === 'read' && o.explore && budget > 0) {
        budget--;
        await exploreGroup(field);
      }
      continue;
    }
    const value = await o.value(field);
    if (value === undefined) {
      if (o.mode === 'deliver' && field.required)
        return { kind: 'missing_value', field, fields: list };
      continue;
    }
    if (value.kind === 'skip') continue;
    // "filling 3/16: Email" — the app shows "Filling 3/16 fields" from it.
    const total = list.filter((f) => f.kind !== 'group' && visible.has(refKey(f.ref))).length;
    const filled = [...done].filter((f) => f.kind !== 'group').length;
    o.progress?.(`filling ${filled}/${Math.max(total, filled)}: ${field.label || field.kind}`);

    const before = await formSignature(page);
    let res = await fillField(page, field, value);
    if (!res.ok) {
      o.notes.push(`${field.label || field.kind}: ${res.reason}`);
      const fixed = o.mode === 'deliver' && (await o.agentField?.(field, value, res.reason));
      if (!fixed) {
        if (o.mode === 'deliver') {
          return { kind: 'handoff', scope: 'field', field, reason: res.reason, fields: list };
        }
        continue;
      }
      // The agent operated the control itself; there's no discovered option list to record.
      res = { ok: true };
    }
    if (res.options !== undefined && res.options !== null) field.options = res.options;
    if (field.kind === 'file' && o.mode === 'deliver')
      o.progress?.(`uploaded ${field.label || 'a file'}`);
    const chosen: FillValue =
      value.kind === 'choose'
        ? { kind: 'option', option: (await currentChoice(page, field)) ?? '*' }
        : value;
    const appeared = await refresh(before);
    const revealedBy: RevealedBy = { ref: field.ref, value: valueLabel(chosen) };
    for (const f of appeared) f.revealedBy = revealedBy;
    await add(appeared, field);

    if (
      o.mode === 'read' &&
      o.explore &&
      CHOICE_KINDS.has(field.kind) &&
      field.options &&
      field.options.length >= 2 &&
      field.options.length <= o.explore.maxOptions &&
      budget >= field.options.length
    ) {
      budget -= field.options.length;
      await explore(field, chosen);
    }
  }
  return { kind: 'filled', fields: list, snapshot: snap };

  /**
   * Opens one entry of a repeatable group to learn its fields (revealedBy "add"), then closes
   * it again with the entry's own Cancel / Remove, so the form is left as it was.
   */
  async function exploreGroup(field: SnapField): Promise<void> {
    const before = await formSignature(page);
    const known = new Set((snap?.buttons ?? []).map((b) => refKey(b.ref)));
    try {
      await locate(page, field.ref).first().click({ timeout: ACTION_MS });
    } catch (err) {
      o.notes.push(`${field.label}: couldn't add an entry (${firstLine(err)})`);
      return;
    }
    const appeared = await refresh(before);
    if (appeared.length === 0) {
      o.notes.push(`${field.label}: adding an entry showed no fields`);
      return;
    }
    const revealedBy: RevealedBy = { ref: field.ref, value: 'add' };
    for (const f of appeared) {
      f.revealedBy = revealedBy;
      done.add(f);
    }
    await add(appeared, field);
    const close = snap?.buttons.find(
      (b) => !known.has(refKey(b.ref)) && /^(cancel|remove|discard|delete|close)\b/i.test(b.text),
    );
    if (close) {
      const sig = await formSignature(page);
      await locate(page, close.ref)
        .first()
        .click({ timeout: ACTION_MS })
        .catch(() => {});
      await refresh(sig);
    }
  }

  /**
   * Tries each option of `field`, notes the fields each one reveals, and ends on `chosen`.
   * A field revealed by every option gets revealedBy "*".
   */
  async function explore(field: SnapField, chosen: FillValue): Promise<void> {
    if (!field.options) return;
    const final = valueLabel(chosen);
    const self = refKey(field.ref);
    // What shows without this field's answer: everything visible but what it revealed.
    const revealedHere = new Set(
      list
        .filter((x) => x.revealedBy && refKey(x.revealedBy.ref) === self)
        .map((x) => refKey(x.ref)),
    );
    const base = new Set([...visible].filter((k) => !revealedHere.has(k)));
    const shownBy = new Map<string, { field: SnapField; options: string[] }>();
    for (const option of field.options) {
      o.signal?.throwIfAborted();
      const before = await formSignature(page);
      const res = await fillField(page, field, { kind: 'option', option });
      if (!res.ok) continue;
      await refresh(before);
      for (const f of snap?.fields ?? []) {
        const k = refKey(f.ref);
        if (base.has(k) || k === self) continue;
        const entry = shownBy.get(k) ?? { field: f, options: [] };
        entry.options.push(option);
        shownBy.set(k, entry);
      }
    }
    const before = await formSignature(page);
    if (chosen.kind !== 'choose') await fillField(page, field, chosen);
    await refresh(before);
    const revealed: SnapField[] = [];
    for (const { field: f, options } of shownBy.values()) {
      const value =
        options.length === field.options.length
          ? '*'
          : options.includes(final)
            ? final
            : (options[0] ?? '*');
      const existing = list.find((x) => refKey(x.ref) === refKey(f.ref));
      if (existing) {
        existing.revealedBy = { ref: field.ref, value };
        // An option other than the chosen one revealed it: it isn't filled on this branch.
        if (value !== '*' && value !== final) done.add(existing);
        continue;
      }
      revealed.push({ ...f, revealedBy: { ref: field.ref, value } });
    }
    await add(revealed, field);
  }
}

async function currentChoice(page: Page, field: FieldSpec): Promise<string | null> {
  const v = await locate(page, field.ref)
    .first()
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      const shown = el
        .closest('[class*="container" i]')
        ?.querySelector('[class*="single-value" i], [class*="singleValue" i]');
      return (shown?.textContent || input.value || '').trim();
    })
    .catch(() => '');
  return v || null;
}

function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return (m.split('\n')[0] ?? m).slice(0, 200);
}
