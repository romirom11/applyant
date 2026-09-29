// `applyant companies …`: company research profiles, one per company.
import type { Command } from 'commander';
import type { Company } from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table, truncate } from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

function state(c: Company): string {
  if (c.researching) return 'researching…';
  if (c.status === 'failed' && !c.summary) return 'failed';
  if (!c.summary) return 'queued';
  const when = iso(c.researchedAt)?.slice(0, 10) ?? '';
  return `${c.fresh ? 'researched' : 'stale'} ${when}`.trim();
}

function flags(c: Company): string {
  if (!c.summary) return '';
  if (c.redFlags.length === 0) return 'no red flags';
  return `${c.redFlags.length} red flag${c.redFlags.length === 1 ? '' : 's'}`;
}

export function companyJson(c: Company) {
  return {
    id: Number(c.id),
    name: c.name,
    status: c.status,
    researching: c.researching,
    fresh: c.fresh,
    trigger: c.trigger,
    website: c.website ?? null,
    summary: c.summary ?? null,
    redFlags: c.redFlags.map((f) => ({ ...f })),
    sections: c.sections.map((s) => ({
      key: s.key,
      label: s.label,
      findings: s.findings.map((f) => ({ text: f.text, date: f.date ?? null, sources: f.sources })),
    })),
    researchedAt: iso(c.researchedAt),
    note: c.note ?? null,
    postings: c.postings.map((p) => ({
      id: Number(p.id),
      title: p.title ?? null,
      score: p.score ?? null,
    })),
  };
}

export function companyLines(c: Company): string[] {
  const lines = [`${c.name} (company ${c.id}) · ${state(c)}${c.website ? ` · ${c.website}` : ''}`];
  if (c.summary) lines.push('', c.summary);
  if (c.redFlags.length) {
    lines.push('', 'Red flags:');
    for (const f of c.redFlags) {
      lines.push(`  ! ${f.kind} (${f.severity}): ${f.text}`);
      for (const u of f.sources) lines.push(`      ${u}`);
    }
  } else if (c.summary) {
    lines.push('', 'Red flags: none found');
  }
  for (const s of c.sections) {
    lines.push('', `${s.label}:`);
    for (const f of s.findings) {
      lines.push(`  - ${f.date ? `${f.date} · ` : ''}${f.text}`);
      for (const u of f.sources) lines.push(`      ${u}`);
    }
  }
  if (c.note) lines.push('', `Note: ${c.note}`);
  if (c.postings.length) {
    lines.push('', 'Postings:');
    for (const p of c.postings) {
      lines.push(`  ${p.id}  ${p.score ?? '–'}  ${p.title ?? '(untitled)'}`);
    }
  }
  return lines;
}

export function registerCompanies(program: Command, client: () => ApplyantClient): void {
  const companies = program
    .command('companies')
    .description('company research: one sourced profile per company, with red flags');

  companies
    .command('list', { isDefault: true })
    .description('researched companies')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listCompanies({});
      if (opts.json) return json(res.companies.map(companyJson));
      if (res.companies.length === 0) {
        return out(
          'No company researched yet. Preparing an application researches its company, or `applyant companies research <posting-id | name>`.',
        );
      }
      out(
        table(
          ['ID', 'COMPANY', 'RESEARCH', 'FLAGS', 'POSTINGS', 'SUMMARY'],
          res.companies.map((c) => [
            String(c.id),
            truncate(c.name, 28),
            state(c),
            flags(c),
            String(c.postings.length),
            truncate(c.summary ?? c.note ?? '', 60),
          ]),
        ),
      );
    });

  companies
    .command('show <company>')
    .description('a company’s profile: every finding with its sources (id or name)')
    .option('--posting', 'the argument is a posting id: show its company')
    .option('--json', 'print JSON')
    .action(async (ref: string, opts: { posting?: boolean; json?: boolean }) => {
      const res = await client().getCompany({
        target: opts.posting
          ? { case: 'postingId', value: BigInt(ref) }
          : { case: 'company', value: ref },
      });
      if (!res.company) return out(`${ref}: not researched yet (\`applyant companies research\`).`);
      if (opts.json) return json(companyJson(res.company));
      for (const line of companyLines(res.company)) out(line);
    });

  companies
    .command('research <company>')
    .description('research a company now (a posting id with --posting, or an id or name)')
    .option('--posting', 'the argument is a posting id: research its company')
    .option('--refresh', 'research again even when the profile is fresh')
    .action(async (ref: string, opts: { posting?: boolean; refresh?: boolean }) => {
      const res = await client().researchCompany({
        target: opts.posting
          ? { case: 'postingId', value: BigInt(ref) }
          : { case: 'company', value: ref },
        refresh: !!opts.refresh,
      });
      const c = res.company;
      if (!c) return;
      if (res.queued) {
        out(
          `Researching ${c.name} (company ${c.id}); \`applyant companies show ${c.id}\` when it's done.`,
        );
      } else if (c.researching) {
        out(`${c.name} is already being researched.`);
      } else {
        out(`${c.name} was researched recently; --refresh researches it again.`);
        for (const line of companyLines(c)) out(line);
      }
    });
}
