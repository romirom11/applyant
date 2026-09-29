// The web-form Channel: read is the phase-4 reader (unchanged); deliver opens the application
// in the submission profile, fills every step with the application's field values and answers
// in `deliver` mode, uploads the CV, submits, waits for confirmation and records a receipt.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { agentFillField, agentFixAndAdvance } from '../browser/form-agent.ts';
import { deliverForm } from '../browser/form-deliver.ts';
import type { FillValue } from '../browser/form-engine.ts';
import {
  type ReadFormOptions,
  type ReadFormResult,
  readForm,
  toSpec,
} from '../browser/form-read.ts';
import { refKey } from '../browser/form-types.ts';
import type { ReaderPool } from '../browser/reader-pool.ts';
import type { SnapField } from '../browser/snapshot.ts';
import type { SubmitProfile } from '../browser/submit-profile.ts';
import type { TaskPages } from '../browser/task-pages.ts';
import { restoreWindow } from '../browser/window.ts';
import type { ApplicationRow, PostingRow } from '../db/schema.ts';
import { entries, optionList, profileText } from '../domain/applications/standard-fields.ts';
import type { ApplicationView, FieldView } from '../domain/applications/store.ts';
import type { StandardProfile } from '../domain/knowledge/profile.ts';
import type { McpAccess } from '../mcp/server.ts';
import type { AgentRunner } from '../models/agent-runner.ts';
import type {
  Channel,
  DeliverContext,
  DeliverOutcome,
  DeliveryReceipt,
  ReceiptFieldSent,
} from './channel.ts';

export interface WebFormChannelDeps {
  reader: ReaderPool;
  submit: SubmitProfile;
  taskPages: TaskPages;
  models: AgentRunner;
  mcp: McpAccess | null;
  /** Where hand-off snapshots are saved (files/handoffs). */
  snapshotsDir: string;
}

/** The stored field value, as `FillValue` for the live control it belongs to. */
export function toFillValue(
  f: Pick<FieldView, 'kind' | 'options'>,
  raw: string | null,
): FillValue | undefined {
  if (raw === null || raw === '') return undefined;
  switch (f.kind) {
    case 'text':
    case 'textarea':
    case 'date':
      return { kind: 'text', text: raw };
    case 'file':
      return { kind: 'file', file: raw };
    case 'select':
    case 'combobox': {
      const list = optionList(raw);
      return list.length > 1
        ? { kind: 'options', options: list }
        : { kind: 'option', option: list[0] ?? raw };
    }
    case 'radio':
      return { kind: 'option', option: raw };
    case 'checkbox':
      if (f.options && f.options.length > 1) {
        const list = optionList(raw);
        return list.length > 1
          ? { kind: 'options', options: list }
          : { kind: 'option', option: list[0] ?? raw };
      }
      return { kind: 'check', checked: raw === 'checked' };
    default:
      // 'group' never reaches here (skipped before delivery starts); 'unknown' is exactly what
      // the field agent is for — the deterministic pass rejects it by the control's own kind,
      // whatever the value's shape, so a plain text value is enough to drive the escalation.
      return { kind: 'text', text: raw };
  }
}

/** A control only live delivery revealed: resolvable only when it's a plain-text standard field. */
function resolveNewField(field: SnapField, profile: StandardProfile): string | null {
  if (!field.meaning) return null;
  if (field.options && field.options.length > 0) return null;
  if (field.kind !== 'text' && field.kind !== 'textarea') return null;
  return profileText(field.meaning, field, profile).value;
}

async function snapshotText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const frame of page.frames()) {
    const text = await frame
      .locator('body')
      .ariaSnapshot({ timeout: 5000 })
      .catch(() => '');
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n\n');
}

export class WebFormChannel implements Channel {
  private readonly d: WebFormChannelDeps;

  constructor(deps: WebFormChannelDeps) {
    this.d = deps;
  }

  read(o: ReadFormOptions): Promise<ReadFormResult> {
    return this.d.reader.withPage((page) => readForm(page, o));
  }

  async deliver(
    _app: ApplicationRow,
    posting: PostingRow,
    view: ApplicationView,
    ctx: DeliverContext,
  ): Promise<DeliverOutcome> {
    const url = posting.applyUrl ?? posting.canonicalUrl;
    const profile = ctx.profile;

    // Repeatable groups aren't filled by delivery yet: hand off before opening a browser at all.
    const group = view.fields.find(
      (f) => f.kind === 'group' && f.active && f.value && entries(f.value).length > 0,
    );
    if (group) {
      return {
        kind: 'needs_candidate',
        handOff: {
          reason: `"${group.label}" is a repeatable section with entries: delivery doesn't fill those in yet — finish this application yourself`,
          detail: null,
          browser: {
            scope: 'step',
            step: group.step,
            fieldLabel: group.label,
            url,
            snapshotPath: null,
          },
        },
      };
    }

    const byRef = new Map(view.fields.map((f) => [f.ref, f]));

    const result = await this.d.submit.deliver<
      | { kind: 'submitted'; url: string; confirmationText: string | null }
      | { kind: 'new_field'; ref: string; spec: ReturnType<typeof toSpec>; value: string }
      | {
          kind: 'handoff';
          reason: string;
          scope: 'field' | 'step' | 'captcha';
          step: number;
          fieldLabel: string | null;
          snapshotPath: string | null;
        }
    >(async (page) => {
      const deps = { models: this.d.models, mcp: this.d.mcp, taskPages: this.d.taskPages };
      const agentCtx = { taskId: ctx.taskId, page, signal: ctx.signal, progress: ctx.progress };
      const outcome = await deliverForm(page, {
        url,
        judge: {
          classify: async (fields, step) => {
            // Prepare already knows most of these (from Read): reuse that meaning instead of
            // asking field_classify again. Only a control live delivery revealed for the first
            // time (a conditional field, or one Read never reached) needs classifying now.
            const unclassified = fields.filter((field) => {
              const known = byRef.get(`${step}:${refKey(field.ref)}`);
              if (!known?.meaning) return true;
              field.meaning = known.meaning as SnapField['meaning'];
              return false;
            });
            if (unclassified.length === 0) return;
            const { FormJudge } = await import('../domain/applications/form-judge.ts');
            const judge = new FormJudge({
              decide: (role, req) => this.d.models.decide(role, req),
              profile,
              job: { title: posting.title, company: posting.company },
              taskId: ctx.taskId,
              signal: ctx.signal,
              progress: ctx.progress,
            });
            await judge.classify(unclassified);
          },
        },
        // Pure lookup: the receipt is built afterwards from `view.fields` directly, not from
        // how many times (or where) this is called — `deliverForm` also calls it just to
        // describe a step to the step agent, not only to actually fill a control.
        valueFor: (ref) => {
          const f = byRef.get(ref);
          return f ? toFillValue(f, f.value) : undefined;
        },
        isKnown: (ref) => byRef.has(ref),
        resolveNewField: (field) => resolveNewField(field, profile),
        agentField: agentFillField(deps, agentCtx),
        agentStep: (fields, errors, advance) =>
          agentFixAndAdvance(deps, agentCtx, fields, errors, advance),
        ...(ctx.securityCode ? { securityCode: ctx.securityCode } : {}),
        signal: ctx.signal,
        progress: ctx.progress,
      });
      this.d.taskPages.unbind(ctx.taskId);

      if (outcome.kind === 'submitted') {
        return {
          result: {
            kind: 'submitted',
            url: outcome.url,
            confirmationText: outcome.confirmationText,
          },
          keepOpen: false,
        };
      }
      if (outcome.kind === 'new_field') {
        return {
          result: {
            kind: 'new_field',
            ref: `${outcome.step}:${refKey(outcome.field.ref)}`,
            spec: toSpec(outcome.field),
            value: outcome.value,
          },
          keepOpen: false,
        };
      }
      // Hand-off: save a snapshot, restore the window, and leave it open.
      const snapshotPath = await saveSnapshot(page, this.d.snapshotsDir, ctx.taskId).catch(
        () => null,
      );
      await restoreWindow(page).catch(() => {});
      return {
        result: {
          kind: 'handoff',
          reason: outcome.reason,
          scope: outcome.scope,
          step: outcome.step,
          fieldLabel: outcome.fieldLabel,
          snapshotPath,
        },
        keepOpen: true,
      };
    });

    if (result.kind === 'submitted') {
      // Exactly what was sent: every field a value actually went to, once each.
      const sent: ReceiptFieldSent[] = view.fields
        .filter((f) => toFillValue(f, f.value) !== undefined)
        .map((f) => ({ ref: f.ref, label: f.label, value: f.value, source: f.source }));
      const cv = sent.find((s) => byRef.get(s.ref)?.meaning === 'resume');
      const salary = sent.find((s) => byRef.get(s.ref)?.meaning === 'salary');
      const receipt: DeliveryReceipt = {
        finalUrl: result.url,
        confirmationText: result.confirmationText,
        confirmationSnapshotPath: null,
        cvPath: cv?.value ?? null,
        cvHash: cv?.value ? hashFile(cv.value) : null,
        salaryValue: salary?.value ?? null,
        fieldValues: sent,
        submittedAt: new Date(),
      };
      return { kind: 'applied', receipt };
    }
    if (result.kind === 'new_field') {
      return {
        kind: 'new_field',
        field: { ref: result.ref, spec: result.spec, value: result.value },
      };
    }
    return {
      kind: 'needs_candidate',
      handOff: {
        reason: result.reason,
        detail: null,
        browser: {
          scope: result.scope,
          step: result.step,
          fieldLabel: result.fieldLabel,
          url,
          snapshotPath: result.snapshotPath,
        },
      },
    };
  }
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

async function saveSnapshot(page: Page, dir: string, taskId: number): Promise<string> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `handoff-${taskId}-${Date.now()}.txt`);
  writeFileSync(path, await snapshotText(page), { mode: 0o600 });
  return path;
}
