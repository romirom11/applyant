// `applyant handoff …`: what a stuck delivery left for the candidate to finish by hand.
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { ApplyantClient } from './client.ts';
import { positiveInt } from './jobs.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

export function registerHandoff(program: Command, client: () => ApplyantClient): void {
  const handoff = program
    .command('handoff')
    .description("a delivery that got stuck: what's left for you to finish");

  handoff
    .command('show <id>')
    .description('the hand-off reason, the page/step, what was filled, and what is left')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { json?: boolean }) => {
      const applicationId = BigInt(positiveInt(idArg));
      const res = await client().getHandOff({ applicationId });
      const h = res.handOff;
      if (opts.json) return json(h ? handOffJson(h) : null);
      if (!h) {
        out(
          `Application ${idArg}: no hand-off waiting. Check \`applyant applications preview ${idArg}\`.`,
        );
        return;
      }
      out(`Application ${idArg}: ${h.reason}`);
      if (h.scope) out(`Where     ${h.scope}${h.step !== undefined ? ` (step ${h.step})` : ''}`);
      if (h.fieldLabel) out(`Field     ${h.fieldLabel}`);
      if (h.url) out(`Window    left open, restored, at ${h.url}`);
      if (h.detail) out(`Detail    ${h.detail}`);
      if (h.snapshotPath) {
        out('');
        out(`Page snapshot (${h.snapshotPath}):`);
        try {
          out(readFileSync(h.snapshotPath, 'utf8').slice(0, 4000));
        } catch {
          out('  (snapshot file not readable from here)');
        }
      }
      out('');
      out('Finish it in the window left open, or fix what it needs and run:');
      out(`  applyant applications submit ${idArg}`);
    });
}

function handOffJson(h: NonNullable<Awaited<ReturnType<ApplyantClient['getHandOff']>>['handOff']>) {
  return {
    reason: h.reason,
    detail: h.detail ?? null,
    scope: h.scope ?? null,
    step: h.step ?? null,
    fieldLabel: h.fieldLabel ?? null,
    url: h.url ?? null,
    snapshotPath: h.snapshotPath ?? null,
  };
}
