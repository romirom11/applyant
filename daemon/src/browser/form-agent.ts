// form_agent: the field-scoped and step-scoped escalations the deterministic Deliver pass falls
// back to. Both get Applyant's five browser MCP tools (bound to the task's own live page) and
// only the prepared values already computed by Prepare — never a chance to invent one. One run
// per level: a second attempt on the same input would just reproduce the same failure, so a
// failed run here always ends in a hand-off.

import type { Page } from 'playwright';
import { z } from 'zod';
import type { McpAccess } from '../mcp/server.ts';
import type { AgentRunner } from '../models/agent-runner.ts';
import type { Advance, FillValue } from './form-engine.ts';
import type { SnapField } from './snapshot.ts';
import type { TaskPages } from './task-pages.ts';

export const FIELD_AGENT_CALLS = 6;
export const STEP_AGENT_CALLS = 12;
export const BROWSER_TOOLS = ['snapshot', 'fill', 'select', 'upload', 'click'];

const outcomeSchema = z.object({ done: z.boolean(), note: z.string() }).strict();
type AgentOutcome = z.infer<typeof outcomeSchema>;

export function fillValueText(value: FillValue): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'option':
      return value.option;
    case 'options':
      return value.options.join(', ');
    case 'check':
      return value.checked ? 'checked' : 'unchecked';
    case 'file':
      return typeof value.file === 'string' ? value.file : value.file.name;
    case 'choose':
      return value.text ?? '(pick whichever option fits, from what the control shows)';
    case 'skip':
      return '(nothing: leave this control as it is)';
  }
}

export interface FormAgentDeps {
  models: AgentRunner;
  mcp: McpAccess | null;
  taskPages: TaskPages;
}

export interface FormAgentRunContext {
  taskId: number;
  page: Page;
  signal: AbortSignal;
  progress?(message: string): void;
}

const TOOLS_LINE =
  'Use `snapshot` first to see the page (all frames, roles and accessible names). Then `fill`, `select`, `upload` or `click` on what you find, using the same ref shape (frame, role, name, nth) the snapshot shows. Call `snapshot` again after anything that might change the page. Never invent a value: use only the one given to you. Never click a control that would submit or finish the whole application.';

const FIELD_AGENT_SYSTEM = `You operate one control of a job application form that ordinary automation (getByRole + fill/selectOption/click) could not. ${TOOLS_LINE}

Return { done: true, note } once the control holds the given value (or is in the given state), or { done: false, note } explaining what stopped you. You get at most ${FIELD_AGENT_CALLS} tool calls in this run.`;

function fieldAgentPrompt(field: SnapField, value: FillValue, reason: string): string {
  return [
    `The control: "${field.label || '(no visible label)'}" (kind: ${field.kind}${field.options?.length ? `, options: ${field.options.map((o) => `"${o}"`).join(', ')}` : ''}).`,
    `Plain automation failed on it: ${reason}.`,
    `The value it must hold: ${fillValueText(value)}`,
    'Find this control in the snapshot by its label and role, then operate it however it actually works (it may be a custom widget: a button group, a slider, a drag target, …).',
  ].join('\n');
}

/** Returns a `fillStep` `agentField` callback bound to one delivery's page and task. */
export function agentFillField(
  d: FormAgentDeps,
  ctx: FormAgentRunContext,
): (field: SnapField, value: FillValue, reason: string) => Promise<boolean> {
  return async (field, value, reason) => {
    d.taskPages.bind(ctx.taskId, ctx.page);
    const grant = d.mcp?.grant<never>({
      taskId: ctx.taskId,
      tools: BROWSER_TOOLS,
      maxCalls: FIELD_AGENT_CALLS,
    });
    try {
      const res = await d.models.run<AgentOutcome>('form_agent', {
        schema: outcomeSchema,
        system: FIELD_AGENT_SYSTEM,
        prompt: fieldAgentPrompt(field, value, reason),
        taskId: ctx.taskId,
        signal: ctx.signal,
        ...(ctx.progress ? { progress: ctx.progress } : {}),
        tools: grant?.tools ?? null,
      });
      return res.kind === 'ok' && res.output.done;
    } finally {
      grant?.revoke();
    }
  };
}

const STEP_AGENT_SYSTEM = `You get one step of a job application form unstuck: either it wouldn't move to the next step, or its final submission was rejected. ${TOOLS_LINE}

Read the error messages you're given (and whatever the snapshot shows) to see what's wrong, fix only the fields that need it (using only the given values), then press the given control to try again. Return { done: true, note } once it succeeds (the page moved on, or shows a confirmation), or { done: false, note } if it still won't go through. You get at most ${STEP_AGENT_CALLS} tool calls in this run.`;

function stepAgentPrompt(
  fields: Array<{ field: SnapField; value: FillValue | undefined }>,
  errors: string[],
  advance: Advance,
): string {
  const parts = [
    errors.length
      ? `What the page currently says is wrong:\n${errors.map((e) => `  - ${e}`).join('\n')}`
      : 'The page gave no specific error message; the control below simply did not move things forward.',
    '',
    "This step's fields and their values (only these are true; do not invent anything else):",
    ...fields.map(
      ({ field, value }) =>
        `  - "${field.label || field.kind}" (${field.kind}${field.required ? ', required' : ''}): ${
          value === undefined ? '(no value: leave it)' : fillValueText(value)
        }`,
    ),
    '',
    advance.isFinal
      ? `The control to press once everything is right: "${advance.text}" — this submits the whole application. Press it only once you believe the step is correct.`
      : `The control to press once everything is right: "${advance.text}" — this moves to the next step.`,
  ];
  return parts.join('\n');
}

/** One step-scoped agent run: fix what's wrong, then press `advance` again. */
export async function agentFixAndAdvance(
  d: FormAgentDeps,
  ctx: FormAgentRunContext,
  fields: Array<{ field: SnapField; value: FillValue | undefined }>,
  errors: string[],
  advance: Advance,
): Promise<boolean> {
  d.taskPages.bind(ctx.taskId, ctx.page);
  const grant = d.mcp?.grant<never>({
    taskId: ctx.taskId,
    tools: BROWSER_TOOLS,
    maxCalls: STEP_AGENT_CALLS,
  });
  try {
    const res = await d.models.run<AgentOutcome>('form_agent', {
      schema: outcomeSchema,
      system: STEP_AGENT_SYSTEM,
      prompt: stepAgentPrompt(fields, errors, advance),
      taskId: ctx.taskId,
      signal: ctx.signal,
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      tools: grant?.tools ?? null,
    });
    return res.kind === 'ok' && res.output.done;
  } finally {
    grant?.revoke();
  }
}
