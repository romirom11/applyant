// `applyant jobs …`: postings, their scores and the candidate's calls on them.
import type { Command } from 'commander';
import type { Posting } from '../gen/applyant/v1/applyant_pb.js';
import { appStageName } from './applications.ts';
import type { ApplyantClient } from './client.ts';
import { iso, parseStage, postingJson, stageName, table, truncate } from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

export function positiveInt(value: string): number {
  const n = Number(value.replace(/^#/, ''));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`"${value}" is not an id`);
  return n;
}

const COMPONENT_LABEL: Record<string, string> = {
  must: 'must-haves',
  nice: 'nice-to-haves',
  role: 'role & seniority',
  location: 'location',
  remote: 'remote',
  salary: 'salary',
  language: 'language',
  employment: 'employment',
};

const VERDICT_MARK: Record<string, string> = {
  strong: '✓',
  partial: '~',
  missing: '✗',
  unknown: '?',
};

function weight(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The PRD's breakdown: every component with its weight, value and why. */
export function breakdownLines(p: Posting): string[] {
  const rows = p.breakdown.map((c) => {
    const counted = c.weight > 0 && !c.uncertain;
    const why = c.note ?? '';
    const suffix = counted ? '' : c.uncertain ? ' (not counted: unknown)' : ' (not counted)';
    return [
      `  ${COMPONENT_LABEL[c.key] ?? c.key}`,
      c.weight > 0 ? weight(c.weight) : '-',
      counted
        ? `${Math.round(c.value * 100)}%${c.scale < 1 ? ` ×${c.scale}` : ''}`
        : c.uncertain
          ? '?'
          : '-',
      `${why}${suffix}`,
    ];
  });
  return table(['  COMPONENT', 'WEIGHT', 'VALUE', 'WHY'], rows).split('\n');
}

export function requirementLines(p: Posting): string[] {
  const lines: string[] = [];
  for (const m of p.requirements) {
    lines.push(`  ${VERDICT_MARK[m.verdict] ?? '?'} ${m.must ? 'must' : 'nice'}  ${m.text}`);
    for (const f of m.facts.slice(0, 3)) {
      const project = f.projectSlug ? ` (${f.projectSlug})` : '';
      lines.push(`          #${f.id} ${truncate(f.text, 100)}${project}`);
    }
    if (m.facts.length > 3) lines.push(`          +${m.facts.length - 3} more`);
    if (m.note && m.verdict !== 'strong') lines.push(`          ${truncate(m.note, 110)}`);
  }
  return lines;
}

function refLabel(ref: { role: string; name: string; css?: string | undefined }): string {
  return ref.name ? `"${truncate(ref.name, 60)}"` : (ref.css ?? ref.role);
}

/** One line for the posting's form status (jobs show). */
export function formStatusLine(p: Posting): string {
  const when = p.formReadAt ? iso(p.formReadAt) : null;
  switch (p.formStatus) {
    case 'verified':
      return `✓ apply form verified${when ? ` ${when}` : ''} · ${p.formNote ?? ''}`;
    case 'email':
      return `✓ ${p.formNote ?? 'applies by email'}`;
    case 'no_form':
      return `✗ no application form found${p.formNote ? `: ${p.formNote}` : ''}`;
    case 'failed':
      return `✗ couldn't read the form${p.formNote ? `: ${p.formNote}` : ''}`;
    default:
      return 'not read yet';
  }
}

/** The form Read found: every step, field, required flag, option list and conditional field. */
export function formLines(p: Posting): string[] {
  const form = p.form;
  if (!form) return ['  (no form read yet: `applyant jobs read-form <id>`)'];
  const lines: string[] = [
    `  ${form.url}`,
    '  * required · indented fields belong to one entry of the repeatable group above them',
  ];
  const steps = form.steps;
  const labels = new Map<string, string>();
  for (const st of steps) {
    for (const f of st.fields) {
      if (f.ref) labels.set(JSON.stringify(f.ref), f.label);
    }
  }
  steps.forEach((st, i) => {
    const advance = st.advance
      ? `${st.isFinal ? 'submits with' : 'moves on with'} ${refLabel(st.advance)}${st.isFinal ? ' (Read stops here)' : ''}`
      : 'no advance control found';
    lines.push('', `  Step ${i + 1} of ${steps.length} · ${st.fields.length} fields · ${advance}`);
    for (const f of st.fields) {
      const req = f.required ? '*' : ' ';
      const meaning = f.meaning ? ` [${f.meaning}]` : '';
      const kind = f.kind === 'group' ? 'repeatable group' : f.kind;
      const entry = f.revealedBy?.value === 'add' ? '    ' : '';
      lines.push(`   ${req} ${entry}${f.label || '(no label)'}  · ${kind}${meaning}`);
      if (f.hasOptions) {
        const shown = f.options.slice(0, 8).map((o) => truncate(o, 40));
        const more = f.options.length > 8 ? ` … +${f.options.length - 8} more` : '';
        lines.push(`       options: ${shown.join(' | ')}${more}`);
      } else if (f.kind === 'combobox') {
        lines.push('       options: load as you type');
      }
      if (f.revealedBy && f.revealedBy.value !== 'add') {
        const by = f.revealedBy.ref ? labels.get(JSON.stringify(f.revealedBy.ref)) : undefined;
        const value = f.revealedBy.value === '*' ? 'any answer' : `"${f.revealedBy.value}"`;
        // A conditional field's * means required on that branch only.
        const then = f.required ? ', and required then' : '';
        lines.push(
          `       ↳ shown when "${truncate(by ?? 'another field', 60)}" is ${value}${then}`,
        );
      }
    }
  });
  if (form.notes.length) {
    lines.push('', '  Notes');
    for (const n of form.notes) lines.push(`   - ${n}`);
  }
  return lines;
}

export function registerJobs(program: Command, client: () => ApplyantClient): void {
  const jobs = program.command('jobs').description('postings');

  jobs
    .command('add <url>')
    .description('add a posting by URL; it is verified and scored in the background')
    .option('--json', 'print JSON')
    .action(async (url: string, opts: { json?: boolean }) => {
      const res = await client().addPosting({ url });
      const p = res.posting;
      if (!p) throw new Error('daemon returned no posting');
      if (opts.json) return json({ created: res.created, posting: postingJson(p) });
      out(
        res.created
          ? `Added posting ${p.id} (${stageName(p.stage)}), verifying: ${p.canonicalUrl}`
          : `Already known as posting ${p.id} (${stageName(p.stage)}): ${p.canonicalUrl}`,
      );
    });

  jobs
    .command('list')
    .description('list postings, newest first (or by score)')
    .option(
      '--stage <stage>',
      'only this stage (found | verified | failed_verification | scored | skipped | closed)',
    )
    .option('--by-score', 'highest score first')
    .option('--json', 'print JSON')
    .action(async (opts: { stage?: string; byScore?: boolean; json?: boolean }) => {
      const stage = opts.stage ? parseStage(opts.stage) : undefined;
      const res = await client().listPostings({
        ...(stage === undefined ? {} : { stage }),
        byScore: !!opts.byScore,
      });
      if (opts.json) return json(res.postings.map(postingJson));
      if (res.postings.length === 0)
        return out('No postings yet. Add one with `applyant jobs add <url>`.');
      out(
        table(
          ['ID', 'SCORE', 'STAGE', 'COMPANY', 'TITLE', 'FLAGS', 'URL'],
          res.postings.map((p) => [
            String(p.id),
            p.score === undefined ? '-' : String(p.score),
            stageName(p.stage),
            truncate(p.company ?? '', 24),
            truncate(p.title ?? '', 44),
            p.dealbreakers.length ? `✗ ${truncate(p.dealbreakers[0] ?? '', 30)}` : '',
            p.canonicalUrl,
          ]),
        ),
      );
    });

  jobs
    .command('show <id>')
    .description('show one posting with its score breakdown and requirements')
    .option('--form', 'also print the application form: steps, fields, options, conditional fields')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { json?: boolean; form?: boolean }) => {
      const id = positiveInt(idArg);
      const res = await client().getPosting({ id: BigInt(id) });
      const p = res.posting;
      if (!p) throw new Error(`posting ${id} not found`);
      const j = postingJson(p);
      if (opts.json) return json(j);
      const score = j.score === null ? '' : `  ·  score ${j.score}`;
      out(`${j.title ?? '(untitled)'}${j.company ? ` · ${j.company}` : ''}${score}`);
      out(`Posting ${j.id} · ${j.stage}`);
      out(`URL          ${j.canonicalUrl}`);
      out(`First seen   ${j.firstSeenAt ?? '-'}`);
      out(`Verified     ${j.verifiedAt ? `${j.verifiedAt} · ${j.verifyNote ?? ''}` : '-'}`);
      if (j.stage !== 'found' && j.stage !== 'failed_verification') {
        out(`Apply form   ${formStatusLine(p)}`);
      }
      if (j.summary) out(`About        ${j.summary}`);
      if (j.salaryText) out(`Salary       ${j.salaryText}`);
      if (j.structuredFields.length) {
        out(`Structured   ${j.structuredFields.join(', ')} from the page's JobPosting data`);
      }
      if (j.decision) {
        out(`Decision     ${j.decision}${j.decisionReason ? `: ${j.decisionReason}` : ''}`);
      }
      if (j.scoreNote) out(`Scoring      ${j.scoreNote}`);
      if (p.applicationId !== undefined) {
        out(
          `Application  ${p.applicationId} · ${appStageName(p.applicationStage).replace(/_/g, ' ')} (\`applyant applications preview ${p.applicationId}\`)`,
        );
      }
      if (p.breakdown.length) {
        out('');
        out(`Score ${j.score}${j.scoredAt ? `  (scored ${j.scoredAt})` : ''}`);
        if (j.coreFit !== null) {
          const scaled = p.breakdown.find((c) => c.scale < 1)?.scale;
          out(
            `Core fit ${Math.round(j.coreFit * 100)}% (must-haves × role)${
              scaled !== undefined
                ? `: logistics count ×${scaled}, in full from 70%`
                : ': logistics count in full'
            }`,
          );
        }
        for (const line of breakdownLines(p)) out(line);
        out(`Dealbreakers ${j.dealbreakers.length ? j.dealbreakers.join('; ') : 'none'}`);
      } else if (j.stage === 'verified') {
        out('\nNot scored yet (follow with `applyant runs show --follow`).');
      }
      if (p.requirements.length) {
        out('');
        out('Requirements');
        for (const line of requirementLines(p)) out(line);
      }
      out('');
      out('Sources');
      for (const s of j.sources) {
        const via =
          s.searchSource && s.searchSource !== `${s.kind}:${s.url}` ? ` (${s.searchSource})` : '';
        const gone = s.closedAt ? `  · no longer listed since ${s.closedAt}` : '';
        out(`  ${s.kind.padEnd(10)} ${s.url}${via}${gone}`);
      }
      if (opts.form) {
        out('');
        out('Application form');
        for (const line of formLines(p)) out(line);
      }
    });

  jobs
    .command('apply <id>')
    .description(
      'prepare an application for this posting (it is also started by a score at or above your threshold, or `jobs interested`)',
    )
    .option('--rewrite', 'when it exists: redraft every answer')
    .action(async (idArg: string, opts: { rewrite?: boolean }) => {
      const res = await client().prepareApplication({
        postingId: BigInt(positiveInt(idArg)),
        rewrite: !!opts.rewrite,
      });
      const a = res.application;
      out(
        `${res.created ? 'Preparing' : 'Preparing again:'} application ${a?.id} for posting ${idArg}. Then \`applyant applications preview ${a?.id}\`.`,
      );
    });

  jobs
    .command('read-form [ids...]')
    .description(
      "read postings' application forms again (read-only: nothing is submitted); default: every live posting never read",
    )
    .action(async (idArgs: string[]) => {
      const res = await client().readForms({ ids: idArgs.map((v) => BigInt(positiveInt(v))) });
      out(
        res.enqueuedIds.length
          ? `Reading ${res.enqueuedIds.length} form(s): ${res.enqueuedIds.join(', ')}. Then \`applyant jobs show <id> --form\`.`
          : 'Nothing to read (or already in progress).',
      );
    });

  jobs
    .command('skip <id>')
    .description('skip a posting; the reason nudges the weights for similar postings')
    .option('-r, --reason <reason>', 'why, e.g. "salary too low"')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { reason?: string; json?: boolean }) => {
      const res = await client().skipPosting({
        id: BigInt(positiveInt(idArg)),
        reason: opts.reason ?? '',
      });
      const p = res.posting;
      if (!p) throw new Error('daemon returned no posting');
      if (opts.json) return json({ posting: postingJson(p), rescored: res.rescored });
      out(
        `Skipped posting ${p.id}${opts.reason ? ` (${opts.reason})` : ''}. ${res.rescored} scores changed.`,
      );
    });

  jobs
    .command('interested <id>')
    .description('mark a posting as one you want (undoes a skip)')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { json?: boolean }) => {
      const res = await client().markInterested({ id: BigInt(positiveInt(idArg)) });
      const p = res.posting;
      if (!p) throw new Error('daemon returned no posting');
      if (opts.json) return json({ posting: postingJson(p), rescored: res.rescored });
      out(`Marked posting ${p.id} as interested. ${res.rescored} scores changed.`);
    });

  jobs
    .command('score [ids...]')
    .description('score postings again (all verified ones by default); cached results are reused')
    .option('--refresh', 're-read the page and re-extract (matches are reused where unchanged)')
    .action(async (idArgs: string[], opts: { refresh?: boolean }) => {
      const res = await client().scorePostings({
        ids: idArgs.map((v) => BigInt(positiveInt(v))),
        refresh: !!opts.refresh,
      });
      out(
        res.enqueuedIds.length
          ? `Scoring ${res.enqueuedIds.length} posting(s): ${res.enqueuedIds.join(', ')}`
          : 'Nothing to score (or already in progress).',
      );
    });
}
