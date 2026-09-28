// The five browser tools the form_agent role gets: thin wrappers over the same public
// Playwright API the deterministic form engine uses, bound to the task's own page (task-pages.ts
// keys the grant's taskId to a live Page). The agent can do what the deterministic code does
// and nothing more: it never sees a way to submit anything itself (deliver.ts presses the final
// control), and every ref it gives is the same {frame, role, name, nth} shape as a FieldSpec's,
// so a control it finds through `snapshot` is one the rest of the form engine can find again too.
import { z } from 'zod';
import type { ElementRef } from '../../browser/form-types.ts';
import { frameRoot, locate } from '../../browser/snapshot.ts';
import type { TaskPages } from '../../browser/task-pages.ts';
import type { McpTool } from '../server.ts';

const ACTION_MS = 5000;

const refShape = {
  frame: z
    .array(z.string())
    .default([])
    .describe('Iframe selectors from the top page down to the control; [] = the page itself'),
  role: z.string().describe('Accessible role from the snapshot, e.g. textbox, combobox, button'),
  name: z.string().describe('Accessible name from the snapshot (exact)'),
  nth: z.number().int().min(0).default(0).describe('Which match, if several share role and name'),
};

function toRef(a: Record<string, unknown>): ElementRef {
  return {
    frame: Array.isArray(a.frame) ? a.frame.map(String) : [],
    role: String(a.role ?? ''),
    name: String(a.name ?? ''),
    nth: Number(a.nth ?? 0),
    css: null,
  };
}

async function selectOnPage(
  page: import('playwright').Page,
  ref: ElementRef,
  option: string,
): Promise<void> {
  const loc = locate(page, ref).first();
  const tag = await loc.evaluate((el) => el.tagName).catch(() => '');
  if (tag === 'SELECT') {
    await loc.selectOption({ label: option }, { timeout: ACTION_MS });
    return;
  }
  await loc.click({ timeout: ACTION_MS }).catch(() => {});
  const root = frameRoot(page, ref.frame);
  const tries: Array<{ role: 'option' | 'radio' | 'checkbox'; check: boolean }> = [
    { role: 'option', check: false },
    { role: 'radio', check: true },
    { role: 'checkbox', check: true },
  ];
  for (const t of tries) {
    const candidate = root.getByRole(t.role, { name: option, exact: true }).first();
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    if (t.check) await candidate.check({ timeout: ACTION_MS });
    else await candidate.click({ timeout: ACTION_MS });
    return;
  }
  throw new Error(`no option "${option}" found near this control`);
}

export function browserTools(pages: TaskPages): McpTool[] {
  const page = (taskId: number | null) => {
    const p = pages.get(taskId);
    if (!p) throw new Error('no live page for this task (the delivery already moved on)');
    return p;
  };

  const snapshot: McpTool = {
    name: 'snapshot',
    description:
      "The current page's accessibility tree (all frames), the same shape the form engine reads: roles and accessible names you can use as the ref for fill / select / upload / click. Call it again after an action that might have changed the page.",
    input: {},
    async run(_args, _signal, taskId) {
      const p = page(taskId);
      const parts: string[] = [];
      for (const frame of p.frames()) {
        const text = await frame
          .locator('body')
          .ariaSnapshot({ timeout: ACTION_MS })
          .catch(() => '');
        if (!text.trim()) continue;
        parts.push(frame.parentFrame() ? `# frame ${frame.url()}\n${text}` : text);
      }
      const text = parts.join('\n\n').slice(0, 20_000) || '(no content)';
      return { text, items: [] };
    },
  };

  const fill: McpTool = {
    name: 'fill',
    description: 'Types text into a text/textarea/date control found in the snapshot.',
    input: { ...refShape, text: z.string().describe('The exact text to type') },
    async run(args, _signal, taskId) {
      const ref = toRef(args);
      await locate(page(taskId), ref)
        .first()
        .fill(String(args.text ?? ''), { timeout: ACTION_MS });
      return { text: 'filled', items: [] };
    },
  };

  const select: McpTool = {
    name: 'select',
    description:
      "Chooses one option of a select / radio / checkbox / combobox control found in the snapshot, by the option's visible text.",
    input: { ...refShape, option: z.string().describe("The option's visible text, exactly") },
    async run(args, _signal, taskId) {
      const ref = toRef(args);
      await selectOnPage(page(taskId), ref, String(args.option ?? ''));
      return { text: 'selected', items: [] };
    },
  };

  const upload: McpTool = {
    name: 'upload',
    description: 'Sets a file input found in the snapshot to an absolute file path given to you.',
    input: { ...refShape, path: z.string().describe('Absolute path of the file to attach') },
    async run(args, _signal, taskId) {
      await locate(page(taskId), toRef(args))
        .first()
        .setInputFiles(String(args.path ?? ''), { timeout: ACTION_MS });
      return { text: 'uploaded', items: [] };
    },
  };

  const click: McpTool = {
    name: 'click',
    description:
      'Clicks a control found in the snapshot (a button, a custom widget, a "confirm" prompt). Never the form\'s final submit control: that step is not yours to take.',
    input: refShape,
    async run(args, _signal, taskId) {
      await locate(page(taskId), toRef(args)).first().click({ timeout: ACTION_MS });
      return { text: 'clicked', items: [] };
    },
  };

  return [snapshot, fill, select, upload, click];
}
