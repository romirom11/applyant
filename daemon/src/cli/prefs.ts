// `applyant candidate prefs …`: what the score is measured against. Every change re-scores
// the postings already scored, without any model call.
import type { Command } from 'commander';
import type { Money, Preferences } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const COMPONENTS = [
  'must',
  'nice',
  'role',
  'location',
  'remote',
  'salary',
  'language',
  'employment',
];

function money(m: Money | undefined): string {
  if (!m) return '-';
  return `${Math.round(m.amount).toLocaleString('en-US')} ${m.currency}/${m.period}`;
}

export function prefsJson(p: Preferences) {
  return {
    roles: p.roles,
    seniority: p.seniority,
    basedIn: p.basedIn ?? null,
    basedCity: p.basedCity ?? null,
    locations: p.locations,
    remote: p.remote,
    salary: p.salary
      ? { amount: p.salary.amount, currency: p.salary.currency, period: p.salary.period }
      : null,
    salaryFloor: p.salaryFloor
      ? {
          amount: p.salaryFloor.amount,
          currency: p.salaryFloor.currency,
          period: p.salaryFloor.period,
        }
      : null,
    languages: p.languages,
    workingLanguages: p.workingLanguages,
    employment: p.employment,
    dealbreakers: p.dealbreakers,
    weights: p.weights,
    feedbackMultipliers: p.feedbackMultipliers,
    threshold: p.threshold,
    dailyCap: p.dailyCap,
  };
}

function print(p: Preferences): void {
  const list = (v: string[]) => (v.length ? v.join(', ') : 'any');
  const rows: Array<[string, string]> = [
    ['roles', list(p.roles)],
    ['seniority', list(p.seniority)],
    ['based_in', [p.basedCity, p.basedIn].filter(Boolean).join(', ') || '-'],
    ['locations', p.locations.join(', ') || '-'],
    ['remote', p.remote],
    ['salary', money(p.salary)],
    ['salary_floor', money(p.salaryFloor)],
    [
      'languages',
      Object.entries(p.languages)
        .map(([l, v]) => `${l}:${v}`)
        .join(', ') || '-',
    ],
    ['working_languages', p.workingLanguages.join(', ') || 'any'],
    ['employment', list(p.employment)],
    ['dealbreakers', p.dealbreakers.join(', ') || 'none'],
    ['threshold', String(p.threshold)],
    [
      'daily_cap',
      p.dailyCap === 0
        ? '0 (nothing is prepared on its own)'
        : `${p.dailyCap} applications started on their own per day`,
    ],
  ];
  for (const [k, v] of rows) out(`${k.padEnd(13)} ${v}`);
  const weights = COMPONENTS.map((c) => {
    const m = p.feedbackMultipliers[c] ?? 1;
    return `${c} ${p.weights[c] ?? 0}${m !== 1 ? ` (×${m} from feedback)` : ''}`;
  });
  out(`${'weights'.padEnd(13)} ${weights.join(' · ')}`);
}

export function registerPrefs(candidate: Command, client: () => ApplyantClient): void {
  const prefs = candidate
    .command('prefs')
    .description('what postings are scored against: roles, where, salary, languages, dealbreakers');

  prefs
    .command('show')
    .description('print preferences, weights and feedback nudges')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().getPreferences({});
      if (!res.preferences) throw new Error('daemon returned no preferences');
      if (opts.json) return out(JSON.stringify(prefsJson(res.preferences), null, 2));
      print(res.preferences);
    });

  prefs
    .command('set <key> [value...]')
    .description(
      [
        'set a preference (an empty value resets it):',
        '  roles "Backend Engineer; CFO; Chef" (any job titles) · seniority senior,staff',
        '  based_in GR · based_city Athens · locations GR,CY',
        '  remote required|preferred|any · salary "3000 EUR/month" · salary_floor "2000 EUR/month"',
        '  languages en:C1,el:native · working_languages de,uk (rather work in these) · employment full_time,contract',
        '  threshold 80',
        '  daily_cap 10 (applications started on their own per day; 0 = only the ones you ask for)',
        '  dealbreakers outstaffing,onsite,location,language,employment,seniority',
      ].join('\n'),
    )
    .action(async (key: string, value: string[]) => {
      const res = await client().setPreference({ key, value: value.join(' ') });
      out(`Saved. ${res.rescored} scores changed.`);
    });

  const dealbreaker = prefs.command('dealbreaker').description('add or remove a dealbreaker');
  for (const action of ['add', 'remove'] as const) {
    dealbreaker
      .command(`${action} <names...>`)
      .description(
        `${action} dealbreakers (outstaffing | onsite | location | language | employment | seniority)`,
      )
      .action(async (names: string[]) => {
        const current = (await client().getPreferences({})).preferences?.dealbreakers ?? [];
        const next =
          action === 'add'
            ? [...new Set([...current, ...names])]
            : current.filter((d) => !names.includes(d));
        const res = await client().setPreference({ key: 'dealbreakers', value: next.join(',') });
        out(`Dealbreakers: ${next.join(', ') || 'none'}. ${res.rescored} scores changed.`);
      });
  }

  prefs
    .command('weight <component> <weight>')
    .description(`set a component's base weight, 0–100 (${COMPONENTS.join(' | ')})`)
    .action(async (component: string, w: string) => {
      const res = await client().setPreference({ key: `weight.${component}`, value: w });
      out(`Saved. ${res.rescored} scores changed.`);
    });

  prefs
    .command('reset-weights')
    .description('restore the default weights')
    .action(async () => {
      const res = await client().setPreference({ key: 'weights', value: 'reset' });
      out(`Weights reset. ${res.rescored} scores changed.`);
    });
}
