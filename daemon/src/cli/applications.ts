// `applyant applications …`: review a prepared application and approve it.
import type { Command } from 'commander';
import {
  type Answer,
  type Application,
  type ApplicationField,
  ApplicationStage,
  ApplyForm,
  type Cv,
  type CvLine,
  FactStatus,
} from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table, truncate } from './format.ts';
import { positiveInt } from './jobs.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

const STAGES: Record<string, ApplicationStage> = {
  preparing: ApplicationStage.PREPARING,
  ready_for_review: ApplicationStage.READY_FOR_REVIEW,
  needs_candidate: ApplicationStage.NEEDS_CANDIDATE,
  approved: ApplicationStage.APPROVED,
  applied: ApplicationStage.APPLIED,
  interview: ApplicationStage.INTERVIEW,
  rejected: ApplicationStage.REJECTED,
  offer: ApplicationStage.OFFER,
  withdrawn: ApplicationStage.WITHDRAWN,
};

/** " (the company's form; `applications form <id> platform` switches)" when both exist. */
function formChoice(a: Application): string {
  const platform = a.applyForm === ApplyForm.PLATFORM;
  const which = platform ? "the platform's form" : "the company's form";
  if (!a.applyFormSwitchable) return platform ? ` (${which})` : '';
  return ` (${which}; \`applications form ${a.id} ${platform ? 'company' : 'platform'}\` switches)`;
}

export function appStageName(stage: ApplicationStage): string {
  return Object.entries(STAGES).find(([, v]) => v === stage)?.[0] ?? 'unknown';
}

const SOURCE_LABEL: Record<string, string> = {
  profile: 'profile',
  override: 'this application',
  answer: 'answer',
  file: 'file',
  rule: 'rule',
  none: '-',
};

const FLAG_LABEL: Record<string, string> = {
  unchecked: 'not checked yet',
  unconfirmed: 'relies on an unconfirmed fact',
  rejected_fact: 'cites a rejected or deleted fact',
  absent_number: 'a number not in the cited facts',
  contradiction: 'contradicts a cited fact',
  'verifier:quantity': 'verifier: overstated quantity',
  'verifier:role': 'verifier: overstated role',
  'verifier:scope': 'verifier: overstated scope',
  'verifier:timeframe': 'verifier: wrong timeframe',
  'verifier:unsupported': 'verifier: not shown by the cited facts',
};

const FACT_MARK: Record<number, string> = {
  [FactStatus.CONFIRMED]: '✓',
  [FactStatus.UNCONFIRMED]: '?',
  [FactStatus.REJECTED]: '✗',
};

function receiptJson(r: NonNullable<Application['receipt']>) {
  return {
    finalUrl: r.finalUrl,
    confirmationText: r.confirmationText ?? null,
    cvPath: r.cvPath ?? null,
    cvHash: r.cvHash ?? null,
    salaryValue: r.salaryValue ?? null,
    submittedAt: iso(r.submittedAt),
    fieldValues: r.fieldValues.map((f) => ({
      ref: f.ref,
      label: f.label,
      value: f.value ?? null,
      source: f.source,
    })),
  };
}

function cvLineJson(l: CvLine) {
  return {
    handle: l.handle,
    text: l.text,
    factIds: l.factIds.map(Number),
    facts: l.facts.map((f) => ({
      id: Number(f.id),
      text: f.text,
      status: FACT_MARK[f.status] ?? '',
      project: f.projectSlug ?? null,
    })),
  };
}

export function cvJson(cv: Cv) {
  return {
    mode: cv.mode,
    status: cv.status,
    note: cv.note ?? null,
    pdfPath: cv.pdfPath ?? null,
    pdfHash: cv.pdfHash ?? null,
    renderedAt: iso(cv.renderedAt),
    summary: cv.summary.map(cvLineJson),
    projects: cv.projects.map((p) => ({
      number: p.number,
      slug: p.slug,
      name: p.name,
      period: p.period ?? null,
      bullets: p.bullets.map(cvLineJson),
    })),
    education: cv.education.map(cvLineJson),
    skills: cv.skills,
    dropped: cv.dropped.map((d) => ({
      ...(d.line ? cvLineJson(d.line) : {}),
      section: d.section,
      reason: d.reason,
    })),
    stale: cv.stale,
  };
}

const factMarks = (l: CvLine) =>
  l.facts.map((f) => `${FACT_MARK[f.status] ?? '·'}#${f.id}`).join(' ');

/** The CV card: which CV goes out and, for a tailored one, what it emphasises. */
export function cvLines(cv: Cv, id: number): string[] {
  const lines: string[] = [];
  if (cv.mode === 'base') {
    lines.push(
      `CV · your base CV (\`applyant applications cv use-tailored ${id}\` for a tailored one)`,
    );
    return lines;
  }
  if (cv.status === 'pending' || (cv.status === 'planned' && !cv.pdfPath)) {
    lines.push(`CV · tailored · ${cv.status === 'pending' ? 'being written' : 'being rendered'}`);
  } else if (cv.status === 'skipped') {
    lines.push(`CV · no tailored CV: ${cv.note ?? 'not possible'}; your base CV is sent instead`);
  } else {
    lines.push(`CV · tailored · ${cv.pdfPath ?? ''}`);
  }
  const bullets = cv.projects.reduce((n, p) => n + p.bullets.length, 0);
  if (cv.projects.length || cv.summary.length) {
    lines.push(
      `  leads with ${cv.projects.map((p) => p.name).join(', ') || '(no projects)'} · ${bullets} bullet(s) · ${cv.skills.length} skill(s)`,
    );
  }
  for (const l of cv.summary) lines.push(`  ${l.handle.padEnd(5)} ${l.text}   ${factMarks(l)}`);
  for (const p of cv.projects) {
    lines.push(`  ${p.number}. ${p.name}${p.period ? ` (${p.period})` : ''}`);
    for (const b of p.bullets) lines.push(`     ${b.handle.padEnd(5)} ${b.text}   ${factMarks(b)}`);
  }
  for (const l of cv.education) lines.push(`  ${l.handle.padEnd(5)} ${l.text}   ${factMarks(l)}`);
  if (cv.skills.length) lines.push(`  Skills: ${cv.skills.join(' · ')}`);
  if (cv.dropped.length) {
    lines.push(`  Left out (${cv.dropped.length}):`);
    for (const d of cv.dropped) {
      lines.push(
        `     ${(d.line?.handle ?? '').padEnd(5)} "${truncate(d.line?.text ?? '', 90)}" (${d.section}): ${d.reason}`,
      );
    }
  }
  if (cv.stale.length)
    lines.push(`  ⚠ ${cv.stale.join(', ')} cite facts that are no longer confirmed`);
  return lines;
}

export function handOffJson(h: NonNullable<Application['handOff']>) {
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

export function applicationJson(a: Application) {
  return {
    id: Number(a.id),
    postingId: Number(a.postingId),
    stage: appStageName(a.stage),
    channel: a.channel,
    note: a.note ?? null,
    title: a.title ?? null,
    company: a.company ?? null,
    score: a.score ?? null,
    postingUrl: a.postingUrl,
    formUrl: a.formUrl ?? null,
    applyForm: a.applyForm === ApplyForm.PLATFORM ? 'platform' : 'company',
    applyFormSwitchable: a.applyFormSwitchable,
    createdAt: iso(a.createdAt),
    preparedAt: iso(a.preparedAt),
    approvedAt: iso(a.approvedAt),
    appliedAt: iso(a.appliedAt),
    receipt: a.receipt ? receiptJson(a.receipt) : null,
    handOff: a.handOff ? handOffJson(a.handOff) : null,
    blockers: a.blockers,
    missing: a.missing,
    unconfirmedFactIds: a.unconfirmedFactIds.map(Number),
    fields: a.fields.map(fieldJson),
    answers: a.answers.map(answerJson),
    cv: a.cv ? cvJson(a.cv) : null,
  };
}

export function fieldJson(f: ApplicationField) {
  return {
    number: f.number,
    ref: f.ref,
    step: f.step,
    label: f.label,
    kind: f.kind,
    meaning: f.meaning ?? null,
    required: f.required,
    options: f.hasOptions ? f.options : null,
    role: f.role,
    value: f.value ?? null,
    source: f.source,
    defaultValue: f.defaultValue ?? null,
    defaultSource: f.defaultSource,
    note: f.note ?? null,
    active: f.active,
    missing: f.missing,
    entryOf: f.entryOf ?? null,
    condition: f.condition ?? null,
  };
}

function answerJson(a: Answer) {
  return {
    number: a.number,
    id: Number(a.id),
    fieldRef: a.fieldRef,
    question: a.question,
    kind: a.kind,
    status: a.status,
    choice: a.choice ?? null,
    missing: a.missing ?? null,
    adaptedFrom: a.adaptedFrom ?? null,
    edited: a.edited,
    active: a.active,
    overridden: a.overridden,
    sentences: a.sentences.map((s) => ({
      index: s.index,
      text: s.text,
      factIds: s.factIds.map(Number),
      flag: s.flag,
      note: s.note ?? null,
      facts: s.facts.map((f) => ({
        id: Number(f.id),
        text: f.text,
        status: FACT_MARK[f.status] ?? '',
        project: f.projectSlug ?? null,
      })),
    })),
  };
}

function shownValue(f: ApplicationField, answers: Map<string, Answer>): string {
  const a = answers.get(f.ref);
  if (a && f.source === 'answer') return a.kind === 'choice' ? (a.choice ?? '') : `→ q${a.number}`;
  if (f.value === undefined) return f.missing ? '(needed)' : '';
  if (f.kind === 'group') {
    try {
      const n = (JSON.parse(f.value) as unknown[]).length;
      return `${n} entr${n === 1 ? 'y' : 'ies'}`;
    } catch {
      return f.value;
    }
  }
  return truncate(f.value.replace(/\s+/g, ' '), 44);
}

export function previewLines(a: Application, o: { all?: boolean } = {}): string[] {
  const lines: string[] = [];
  const id = Number(a.id);
  lines.push(
    `Application ${id} · ${a.title ?? '(untitled)'}${a.company ? ` · ${a.company}` : ''} · ${appStageName(a.stage).replace(/_/g, ' ')}`,
    `Posting ${a.postingId}${a.score !== undefined ? ` · score ${a.score}` : ''} · ${a.postingUrl}`,
  );
  if (a.formUrl) lines.push(`Form    ${a.formUrl}${formChoice(a)}`);
  if (a.note) lines.push(`Note    ${a.note}`);
  if (a.receipt) {
    lines.push(
      '',
      `Applied ${iso(a.appliedAt) ?? ''} → ${a.receipt.finalUrl}`,
      a.receipt.confirmationText
        ? `  "${truncate(a.receipt.confirmationText, 200)}"`
        : '  (no confirmation text captured)',
      `  ${a.receipt.fieldValues.length} field value(s) sent${a.receipt.cvPath ? ` · CV ${a.receipt.cvHash ? `(${a.receipt.cvHash.slice(0, 12)}…)` : ''}` : ''}${a.receipt.salaryValue ? ` · salary "${a.receipt.salaryValue}"` : ''}`,
    );
  }
  if (a.handOff) {
    lines.push(
      '',
      `Needs you: ${a.handOff.reason}`,
      a.handOff.url
        ? `  window left open at ${a.handOff.url}${a.handOff.step ? ` (step ${a.handOff.step})` : ''}`
        : '',
      `  \`applyant handoff show ${id}\` for details`,
    );
  }

  const answers = new Map(a.answers.map((x) => [x.fieldRef, x]));
  const shown = a.fields.filter((f) => (o.all || f.active) && f.entryOf === undefined);
  const count = (source: string) => shown.filter((f) => f.source === source).length;
  lines.push(
    '',
    `Fields (${shown.length}: ${count('profile')} from your profile · ${count('override')} set for this application · ${count('answer')} answer(s) · ${a.missing.length} need you)`,
  );
  const rows = shown.map((f) => [
    `  ${String(f.number).padStart(2)}${f.required ? '*' : ' '}`,
    truncate(f.label || f.kind, 38) + (f.active ? '' : ' (not asked)'),
    shownValue(f, answers),
    f.missing ? 'NEEDS YOU' : (SOURCE_LABEL[f.source] ?? f.source),
  ]);
  lines.push(...table(['   #', 'FIELD', 'VALUE', 'FROM'], rows).split('\n'));
  for (const f of shown) {
    const entryFields = a.fields.filter((e) => e.entryOf === f.ref);
    if (f.kind === 'group' && entryFields.length) {
      lines.push(
        `      #${f.number} entries have: ${entryFields.map((e) => `${e.label}${e.required ? '*' : ''}`).join(', ')}`,
      );
    }
  }
  const hidden = a.fields.filter((f) => !f.active && f.entryOf === undefined).length;
  if (!o.all && hidden)
    lines.push(
      `  (${hidden} conditional field(s) the form won't ask with these values: --all shows them)`,
    );

  const needs = a.fields.filter((f) => f.missing && !(answers.get(f.ref)?.status === 'answered'));
  if (needs.length) {
    lines.push('', 'Needs you');
    for (const f of needs) {
      const opts = f.hasOptions
        ? ` (one of: ${f.options
            .slice(0, 6)
            .map((x) => `"${truncate(x, 30)}"`)
            .join(', ')}${f.options.length > 6 ? ', …' : ''})`
        : '';
      lines.push(`  #${f.number} ${f.label}${f.note ? `: ${f.note}` : ''}${opts}`);
    }
  }

  const active = a.answers.filter((x) => x.active || o.all);
  if (active.length) lines.push('', 'Answers');
  for (const ans of active) {
    const kind = ans.kind === 'choice' ? 'choice' : 'written';
    const tag = [
      kind,
      ans.overridden ? 'replaced by your value' : null,
      ans.edited ? 'edited' : null,
      ans.active ? null : 'not asked',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`q${ans.number} [${tag}] ${ans.question}`);
    if (ans.status === 'needs_candidate') {
      lines.push(`   NEEDS YOU: ${ans.missing ?? "the facts can't answer this"}`);
      continue;
    }
    if (ans.kind === 'choice')
      lines.push(`   → ${ans.choice ?? ''}${ans.sentences.length ? '   because:' : ''}`);
    for (const s of ans.sentences) {
      const flag =
        s.flag !== 'none'
          ? `   ⚠ ${FLAG_LABEL[s.flag] ?? s.flag}${s.note ? ` (${s.note})` : ''}`
          : '';
      lines.push(`   ${s.index + 1}. ${s.text}${flag}`);
      for (const f of s.facts) {
        lines.push(
          `        ${FACT_MARK[f.status] ?? '·'} #${f.id} ${truncate(f.text, 100)}${f.projectSlug ? ` (${f.projectSlug})` : ''}`,
        );
      }
    }
    if (ans.adaptedFrom) lines.push(`   adapted from ${ans.adaptedFrom}`);
  }

  if (a.cv) lines.push('', ...cvLines(a.cv, id));

  lines.push('');
  if (a.stage === ApplicationStage.APPLIED) {
    lines.push(`Applied ${iso(a.appliedAt) ?? ''}.`);
  } else if (a.stage === ApplicationStage.APPROVED) {
    lines.push(
      a.handOff
        ? `Approved ${iso(a.approvedAt) ?? ''}; delivery needs you (see above).`
        : `Approved ${iso(a.approvedAt) ?? ''}; delivering.`,
    );
  } else if (a.blockers.length === 0) {
    lines.push(`Ready: \`applyant applications approve ${id}\``);
  } else {
    lines.push('Approve is blocked:');
    for (const b of a.blockers) lines.push(`  - ${b}`);
    lines.push('', 'Next:');
    if (needs.length)
      lines.push(
        `  applyant applications set-field ${id} <#> <value>     a value for this application only`,
      );
    if (a.unconfirmedFactIds.length) {
      lines.push(
        `  applyant applications confirm ${id} [fact ids]      confirm the facts it relies on`,
      );
    }
    if (
      a.answers.some((x) => x.sentences.some((s) => s.flag !== 'none' && s.flag !== 'unconfirmed'))
    ) {
      lines.push(
        `  applyant applications edit ${id} q<n>.<s> "<text>"   rewrite a sentence in your words`,
      );
      lines.push(
        `  applyant applications edit ${id} q<n>.<s> --confirm  it's true as written (not for contradictions)`,
      );
    }
    if (a.cv?.stale.length) {
      lines.push(
        `  applyant applications cv edit ${id} <line> "<text>"  rewrite a CV line in your words (or --remove)`,
      );
    }
  }
  return lines;
}

/** "q2.3" → answer "q2", sentence index 2; "q2" → whole answer. */
export function parseAnswerRef(ref: string): { answer: string; sentence: number | undefined } {
  const m = /^(q?\d+|[^.]+)\.(\d+)$/i.exec(ref.trim());
  if (!m) return { answer: ref.trim(), sentence: undefined };
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${ref}": sentence numbers start at 1`);
  return { answer: m[1] ?? ref, sentence: n - 1 };
}

export function registerApplications(program: Command, client: () => ApplyantClient): void {
  const apps = program
    .command('applications')
    .description('prepared applications: review, edit, approve');

  apps
    .command('list')
    .description('list applications, newest first')
    .option('--stage <stage>', 'preparing | ready_for_review | needs_candidate | approved')
    .option('--json', 'print JSON')
    .action(async (opts: { stage?: string; json?: boolean }) => {
      let stage = ApplicationStage.UNSPECIFIED;
      if (opts.stage) {
        const s = STAGES[opts.stage];
        if (s === undefined)
          throw new Error(`unknown stage "${opts.stage}" (${Object.keys(STAGES).join(' | ')})`);
        stage = s;
      }
      const res = await client().listApplications({ stage });
      if (opts.json) return json(res.applications.map(applicationJson));
      if (res.applications.length === 0) {
        return out(
          'No applications yet. They start when a posting scores at or above your threshold, or with `applyant jobs apply <id>`.',
        );
      }
      out(
        table(
          ['ID', 'POSTING', 'STAGE', 'SCORE', 'COMPANY', 'TITLE', 'BLOCKERS'],
          res.applications.map((a) => [
            String(a.id),
            String(a.postingId),
            appStageName(a.stage),
            a.score === undefined ? '-' : String(a.score),
            truncate(a.company ?? '', 22),
            truncate(a.title ?? '', 40),
            a.stage === ApplicationStage.APPROVED ? '' : String(a.blockers.length),
          ]),
        ),
      );
    });

  apps
    .command('prepare <id>')
    .description(
      'prepare an application again: fields from your current profile (your per-application values stay), missing answers drafted',
    )
    .option('--rewrite', 'redraft every answer and the tailored CV (your edits too)')
    .action(async (idArg: string, opts: { rewrite?: boolean }) => {
      const res = await client().prepareApplication({
        applicationId: BigInt(positiveInt(idArg)),
        rewrite: !!opts.rewrite,
      });
      out(
        `Preparing application ${res.application?.id} again. Follow with \`applyant runs show --follow\`.`,
      );
    });

  apps
    .command('preview <id>')
    .description(
      'what review shows: every field with its value and where it came from, answers with their facts and flags',
    )
    .option('--all', 'also show conditional fields the form will not ask')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { all?: boolean; json?: boolean }) => {
      const res = await client().getApplication({ id: BigInt(positiveInt(idArg)) });
      const a = res.application;
      if (!a) throw new Error(`application ${idArg} not found`);
      if (opts.json) return json(applicationJson(a));
      for (const line of previewLines(a, { all: !!opts.all })) out(line);
    });

  apps
    .command('set-field <id> <field> [value...]')
    .description(
      'a value for one field of this application only (your profile is unchanged); field = #number, meaning (salary) or label',
    )
    .option(
      '--clear',
      "drop this application's value: the prepared one (from your profile) applies again",
    )
    .option('--json', 'print JSON')
    .action(
      async (
        idArg: string,
        field: string,
        value: string[],
        opts: { clear?: boolean; json?: boolean },
      ) => {
        const res = await client().setFieldValue({
          applicationId: BigInt(positiveInt(idArg)),
          field,
          value: value.join(' '),
          clear: !!opts.clear,
        });
        const f = res.field;
        if (opts.json) {
          return json({
            field: f ? fieldJson(f) : null,
            application: res.application ? applicationJson(res.application) : null,
          });
        }
        if (!f) throw new Error('daemon returned no field');
        out(
          opts.clear
            ? `#${f.number} ${f.label}: back to ${f.value ?? '(no value)'} (${SOURCE_LABEL[f.source] ?? f.source})`
            : `#${f.number} ${f.label} = ${f.value ?? ''} (for this application only)`,
        );
        if (res.application)
          out(
            `Application ${res.application.id}: ${appStageName(res.application.stage).replace(/_/g, ' ')}${res.application.blockers.length ? `, ${res.application.blockers.length} blocker(s) left` : ', ready to approve'}`,
          );
      },
    );

  apps
    .command('edit <id> <answer> [text...]')
    .description(
      'rewrite an answer (q2) or one sentence (q2.3) in your own words: saved as confirmed facts',
    )
    .option(
      '--confirm',
      'the sentence is true as written (for a flagged number or verifier finding)',
    )
    .action(
      async (idArg: string, answerRef: string, text: string[], opts: { confirm?: boolean }) => {
        const { answer, sentence } = parseAnswerRef(answerRef);
        if (opts.confirm && text.length)
          throw new Error('--confirm keeps the sentence as it is: give no text');
        if (!opts.confirm && text.length === 0)
          throw new Error('give the new text (or --confirm for a sentence)');
        const res = await client().editAnswer({
          applicationId: BigInt(positiveInt(idArg)),
          answer,
          ...(sentence !== undefined ? { sentence } : {}),
          ...(opts.confirm ? {} : { text: text.join(' ') }),
        });
        const a = res.answer;
        out(
          opts.confirm
            ? `Confirmed ${answerRef} as written (saved as fact ${res.factIds.map((n) => `#${n}`).join(', ')}).`
            : `Updated q${a?.number}; saved your words as fact(s) ${res.factIds.map((n) => `#${n}`).join(', ') || '(unchanged)'}.`,
        );
        if (res.application)
          out(
            `${res.application.blockers.length ? `${res.application.blockers.length} blocker(s) left.` : 'Nothing blocks approve now.'}`,
          );
      },
    );

  const cv = apps
    .command('cv')
    .description("the application's CV: tailored for the posting, or your base CV");

  cv.command('show <id>')
    .description(
      'which CV goes out and what the tailored one emphasises, with the facts behind each line',
    )
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { json?: boolean }) => {
      const res = await client().getApplication({ id: BigInt(positiveInt(idArg)) });
      const a = res.application;
      if (!a) throw new Error(`application ${idArg} not found`);
      if (!a.cv) return out(`Application ${a.id}'s form takes no CV.`);
      if (opts.json) return json(cvJson(a.cv));
      for (const line of cvLines(a.cv, Number(a.id))) out(line);
    });

  cv.command('use-base <id>')
    .description('send your base CV (profile base_cv_file) with this application instead')
    .action(async (idArg: string) => {
      const res = await client().setCvMode({
        applicationId: BigInt(positiveInt(idArg)),
        mode: 'base',
      });
      const f = res.application?.fields.find((x) => x.meaning === 'resume' && x.kind === 'file');
      out(
        f?.value
          ? `Application ${idArg} sends your base CV (${f.value}).`
          : `Application ${idArg} uses your base CV, but your profile has none: \`applyant candidate profile set base_cv_file <path>\`.`,
      );
    });

  cv.command('use-tailored <id>')
    .description('send the CV tailored for this posting (the default)')
    .action(async (idArg: string) => {
      const res = await client().setCvMode({
        applicationId: BigInt(positiveInt(idArg)),
        mode: 'tailored',
      });
      out(
        res.application?.cv?.status === 'ready'
          ? `Application ${idArg} sends its tailored CV (${res.application.cv.pdfPath}).`
          : `Writing the tailored CV for application ${idArg}; follow with \`applyant runs show --follow\`.`,
      );
    });

  cv.command('edit <id> <line> [text...]')
    .description(
      'rewrite a CV line (s1, p2.3, e1; a left-out d4 goes back in) in your own words, saved as a confirmed fact',
    )
    .option('--remove', 'take the line out of the CV')
    .action(async (idArg: string, line: string, text: string[], opts: { remove?: boolean }) => {
      if (opts.remove && text.length) throw new Error('--remove takes no text');
      if (!opts.remove && text.length === 0) throw new Error('give the new text (or --remove)');
      const res = await client().editCv({
        applicationId: BigInt(positiveInt(idArg)),
        line,
        ...(opts.remove ? {} : { text: text.join(' ') }),
      });
      out(
        opts.remove
          ? `Removed ${line} from the CV; rendering it again.`
          : `Updated ${line}; saved your words as fact #${res.factId}. Rendering the CV again.`,
      );
    });

  apps
    .command('confirm <id> [factIds...]')
    .description(
      'confirm the unconfirmed facts this application relies on (all of them, or the given ids)',
    )
    .action(async (idArg: string, factArgs: string[]) => {
      const res = await client().confirmFact({
        applicationId: BigInt(positiveInt(idArg)),
        ids: factArgs.map((v) => BigInt(positiveInt(v))),
      });
      if (res.facts.length === 0) return out('No unconfirmed facts to confirm.');
      for (const f of res.facts) out(`✓ #${f.id} ${f.text}`);
    });

  apps
    .command('approve <id>')
    .description(
      'approve the application (refused while anything required is missing, flagged or unconfirmed); delivery then runs on its own',
    )
    .action(async (idArg: string) => {
      const res = await client().approveApplication({ id: BigInt(positiveInt(idArg)) });
      const a = res.application;
      out(
        `Approved application ${a?.id}${a?.title ? ` (${a.title}${a.company ? ` · ${a.company}` : ''})` : ''}. Delivering through its channel; follow with \`applyant runs show --follow\`.`,
      );
    });

  apps
    .command('mark-submitted <id>')
    .description('you finished a hand-off in the browser and pressed submit: record it as applied')
    .action(async (idArg: string) => {
      const res = await client().markSubmitted({ applicationId: BigInt(positiveInt(idArg)) });
      const a = res.application;
      out(`Application ${a?.id}: applied (submitted by you in the browser).`);
    });

  apps
    .command('notes <id> [text...]')
    .description(
      'show your notes on an application, or replace them with text (--clear empties them)',
    )
    .option('--clear', 'remove the notes')
    .action(async (idArg: string, words: string[], opts: { clear?: boolean }) => {
      const applicationId = BigInt(positiveInt(idArg));
      const text = words.join(' ').trim();
      if (!text && !opts.clear) {
        const { application: a } = await client().getApplication({ id: applicationId });
        return out(a?.notes ?? '(no notes)');
      }
      await client().setApplicationNotes({ applicationId, notes: opts.clear ? '' : text });
      out(
        opts.clear ? `Application ${idArg}: notes removed.` : `Application ${idArg}: notes saved.`,
      );
    });

  const contacts = apps
    .command('contacts')
    .description('company contacts on an application (recruiter, hiring manager…)');
  contacts
    .command('list <id>')
    .option('--json', 'print JSON')
    .action(async (idArg: string, opts: { json?: boolean }) => {
      const { application: a } = await client().getApplication({ id: BigInt(positiveInt(idArg)) });
      const list = a?.contacts ?? [];
      if (opts.json)
        return out(
          JSON.stringify(
            list.map((c) => ({
              id: Number(c.id),
              name: c.name ?? null,
              role: c.role ?? null,
              email: c.email ?? null,
              linkedin: c.linkedin ?? null,
              note: c.note ?? null,
            })),
            null,
            2,
          ),
        );
      if (list.length === 0) return out('No contacts yet.');
      for (const c of list) {
        out(
          `${c.id}  ${[c.name, c.role, c.email, c.linkedin].filter(Boolean).join(' · ')}${c.note ? `\n    ${c.note}` : ''}`,
        );
      }
    });
  contacts
    .command('add <id>')
    .description('add a contact: at least --name, --email or --linkedin')
    .option('--name <name>')
    .option('--role <role>', 'e.g. recruiter, hiring manager')
    .option('--email <email>')
    .option('--linkedin <url>')
    .option('--note <text>')
    .action(
      async (
        idArg: string,
        o: { name?: string; role?: string; email?: string; linkedin?: string; note?: string },
      ) => {
        const { contact } = await client().addApplicationContact({
          applicationId: BigInt(positiveInt(idArg)),
          ...o,
        });
        out(`Contact ${contact?.id} added to application ${idArg}.`);
      },
    );
  contacts.command('remove <contactId>').action(async (idArg: string) => {
    await client().deleteApplicationContact({ contactId: BigInt(positiveInt(idArg)) });
    out(`Contact ${idArg} removed.`);
  });

  apps
    .command('status <id> <stage>')
    .description(
      'correct the status by hand: applied (sent outside Applyant, or a misread reply undone) | interview | offer | rejected | withdrawn, or ready_for_review to take an approval back after a hand-off; never sends anything',
    )
    .action(async (idArg: string, stageArg: string) => {
      const stage = STAGES[stageArg];
      if (stage === undefined)
        throw new Error(
          `unknown stage "${stageArg}" (applied | interview | offer | rejected | withdrawn | ready_for_review)`,
        );
      const res = await client().setApplicationStage({
        applicationId: BigInt(positiveInt(idArg)),
        stage,
      });
      const a = res.application;
      out(
        `Application ${a?.id}${a?.title ? ` (${a.title}${a.company ? ` · ${a.company}` : ''})` : ''}: ${a ? appStageName(a.stage) : stageArg} (set by hand).`,
      );
    });

  apps
    .command('form <id> <which>')
    .description(
      "which form it goes through, before approval: platform (LinkedIn Easy Apply, Xing apply) or company (the company's own form, the default); the form is read again and the application prepared for it",
    )
    .action(async (idArg: string, which: string) => {
      const form =
        which === 'platform' ? ApplyForm.PLATFORM : which === 'company' ? ApplyForm.COMPANY : null;
      if (form === null) throw new Error('which form: platform or company');
      const res = await client().setApplyForm({
        applicationId: BigInt(positiveInt(idArg)),
        form,
      });
      const a = res.application;
      out(
        `Application ${a?.id}: ${which === 'platform' ? "the platform's form" : "the company's own form"}${a?.note ? ` (${a.note})` : ''}. Follow with \`applyant runs show --follow\`.`,
      );
    });

  apps
    .command('submit <id>')
    .description(
      'approve (if needed) and deliver: same refusal rules as approve; also retries a delivery stuck on a hand-off',
    )
    .action(async (idArg: string) => {
      const res = await client().submitApplication({ id: BigInt(positiveInt(idArg)) });
      const a = res.application;
      out(
        `Application ${a?.id}${a?.title ? ` (${a.title}${a.company ? ` · ${a.company}` : ''})` : ''}: delivering. Follow with \`applyant runs show --follow\`.`,
      );
    });
}
