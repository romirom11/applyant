// `applyant overview`: the funnel and the PRD's success metrics over a window.
import type { Command } from 'commander';
import { type GetOverviewResponse, OverviewWindow } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table } from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const WINDOWS: Record<string, OverviewWindow> = {
  '7d': OverviewWindow.OVERVIEW_WINDOW_7_DAYS,
  '30d': OverviewWindow.OVERVIEW_WINDOW_30_DAYS,
  all: OverviewWindow.OVERVIEW_WINDOW_ALL,
};

export function overviewJson(res: GetOverviewResponse) {
  return {
    since: iso(res.since) ?? null,
    funnel: res.funnel.map((s) => ({ key: s.key, count: Number(s.count) })),
    metrics: res.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      target: m.target || null,
      display: m.display,
      met: m.met ?? null,
      value: m.value ?? null,
    })),
  };
}

export function overviewLines(res: GetOverviewResponse): string[] {
  const lines = [res.since ? `Since ${iso(res.since)?.slice(0, 10)}` : 'All time', ''];
  const found = Number(res.funnel[0]?.count ?? 0n);
  lines.push(
    table(
      ['FUNNEL', 'COUNT', 'OF FOUND'],
      res.funnel.map((s) => [
        s.label,
        String(s.count),
        found > 0 ? `${Math.round((Number(s.count) / found) * 100)}%` : '-',
      ]),
    ),
    '',
    table(
      ['METRIC', 'VALUE', 'TARGET', ''],
      res.metrics.map((m) => [
        m.label,
        m.display,
        m.target || '(watched)',
        m.met === undefined ? '' : m.met ? 'met' : 'NOT MET',
      ]),
    ),
  );
  return lines;
}

export function registerOverview(program: Command, client: () => ApplyantClient): void {
  program
    .command('overview')
    .description('the funnel (found → … → offer) and the success metrics over a window')
    .option('--window <window>', '7d | 30d | all', '30d')
    .option('--json', 'print JSON')
    .action(async (opts: { window: string; json?: boolean }) => {
      const window = WINDOWS[opts.window];
      if (window === undefined) throw new Error(`unknown window "${opts.window}" (7d | 30d | all)`);
      const res = await client().getOverview({ window });
      if (opts.json) return out(JSON.stringify(overviewJson(res), null, 2));
      for (const line of overviewLines(res)) out(line);
    });
}
