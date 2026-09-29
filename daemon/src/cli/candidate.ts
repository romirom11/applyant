// `applyant candidate …`: the candidate's profile, projects, sources and facts.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  type Fact,
  FactStatus,
  type Project,
  type Source,
  SourceKind,
} from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table, truncate } from './format.ts';
import { registerInterview } from './interview.ts';
import { registerPrefs } from './prefs.ts';

/** Kept in step with domain/knowledge/profile.ts (importing it would load the DB layer into the CLI). */
const PROFILE_LIST_KEYS = ['github_logins', 'commit_emails', 'ai_agent_identities'];
const STANDARD_KEYS = [
  'full_name',
  'email',
  'phone',
  'location',
  'work_authorization',
  'visa_sponsorship',
  'relocation',
  'salary_expectation',
  'notice_period',
  'current_company',
  'current_title',
  'links.github',
  'links.website',
  'links.linkedin',
  'base_cv_file',
];

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

const SOURCE_KINDS: Record<string, SourceKind> = {
  file: SourceKind.FILE,
  url: SourceKind.URL,
  github: SourceKind.GITHUB,
  drive: SourceKind.DRIVE,
  manual: SourceKind.MANUAL,
};

const FACT_STATUSES: Record<string, FactStatus> = {
  unconfirmed: FactStatus.UNCONFIRMED,
  confirmed: FactStatus.CONFIRMED,
  rejected: FactStatus.REJECTED,
};

function kindName(kind: SourceKind): string {
  return Object.entries(SOURCE_KINDS).find(([, v]) => v === kind)?.[0] ?? 'unknown';
}

function statusName(status: FactStatus): string {
  return Object.entries(FACT_STATUSES).find(([, v]) => v === status)?.[0] ?? 'unknown';
}

function ids(values: string[]): bigint[] {
  return values.map((v) => {
    const n = Number(v.replace(/^#/, ''));
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`"${v}" is not a fact id`);
    return BigInt(n);
  });
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function projectJson(p: Project) {
  return {
    id: Number(p.id),
    slug: p.slug,
    name: p.name,
    summary: p.summary ?? null,
    role: p.role ?? null,
    period: p.period ?? null,
    stack: p.stack,
    sources: p.sourceCount,
    facts: p.factCount,
    unconfirmed: p.unconfirmedCount,
    confirmed: p.confirmedCount,
  };
}

export function sourceJson(s: Source) {
  return {
    id: Number(s.id),
    projectId: s.projectId === undefined ? null : Number(s.projectId),
    kind: kindName(s.kind),
    locator: s.locator,
    lastSyncedAt: iso(s.lastSyncedAt),
    syncNote: s.syncNote ?? null,
  };
}

export function factJson(f: Fact) {
  return {
    id: Number(f.id),
    project: f.projectSlug ?? null,
    text: f.text,
    kind: f.kind,
    status: statusName(f.status),
    origin: f.origin,
    editedAt: iso(f.editedAt),
    evidence: f.evidence.map((e) => ({
      sourceId: e.sourceId === undefined ? null : Number(e.sourceId),
      sourceKind: kindName(e.sourceKind),
      source: e.sourceLocator,
      locator: e.locator ?? null,
      excerpt: e.excerpt ?? null,
    })),
  };
}

function sourceLines(sources: Source[]): string[] {
  return sources.map((s) => {
    const synced = s.lastSyncedAt ? `synced ${iso(s.lastSyncedAt)}` : 'not synced yet';
    return `  #${s.id} ${kindName(s.kind).padEnd(6)} ${s.locator}\n         ${synced}${s.syncNote ? ` · ${s.syncNote}` : ''}`;
  });
}

function shortSource(kind: SourceKind, locator: string): string {
  if (kind === SourceKind.FILE) return locator.split('/').pop() ?? locator;
  return locator.replace(/^https?:\/\/(www\.)?/, '');
}

function factLines(f: Fact): string[] {
  const mark = { unconfirmed: '?', confirmed: '✓', rejected: '✗' }[statusName(f.status)] ?? ' ';
  const lines = [
    `  ${mark} #${f.id}  ${f.text}`,
    `        ${f.kind} · ${statusName(f.status)} · ${f.origin}`,
  ];
  for (const e of f.evidence) {
    const where = [shortSource(e.sourceKind, e.sourceLocator), e.locator]
      .filter(Boolean)
      .join(' · ');
    const quote = e.excerpt ? `  "${truncate(e.excerpt.replace(/\s+/g, ' '), 120)}"` : '';
    lines.push(`        ↳ ${where || 'no source'}${quote}`);
  }
  if (f.evidence.length === 0) lines.push('        ↳ (no evidence)');
  return lines;
}

export function registerCandidate(program: Command, client: () => ApplyantClient): void {
  const candidate = program
    .command('candidate')
    .description('what Applyant knows about you: profile, projects, sources and facts');

  candidate
    .command('show')
    .description('profile, projects and how many facts are waiting for confirmation')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().getCandidate({});
      if (opts.json) {
        return json({
          profile: Object.fromEntries(res.profile.map((e) => [e.key, e.values])),
          projects: res.projects.map(projectJson),
          profileSources: res.profileSources.map(sourceJson),
          profileFacts: res.profileFactCount,
        });
      }
      out('Profile');
      const profile = new Map(res.profile.map((e) => [e.key, e.values]));
      for (const key of ['github_logins', 'commit_emails', ...STANDARD_KEYS]) {
        out(`  ${key.padEnd(18)} ${(profile.get(key) ?? []).join(', ') || '(not set)'}`);
      }
      if (!(profile.get('github_logins')?.length || profile.get('commit_emails')?.length)) {
        out(
          '  Without these, no commit counts as yours: `applyant candidate profile set github_logins <login>`',
        );
      }
      out('');
      out(`Projects (${res.projects.length})`);
      if (res.projects.length === 0) out('  none yet: `applyant candidate project add <name>`');
      else {
        out(
          table(
            ['  SLUG', 'FACTS', 'UNCONFIRMED', 'SOURCES', 'NAME'],
            res.projects.map((p) => [
              `  ${p.slug}`,
              String(p.factCount),
              String(p.unconfirmedCount),
              String(p.sourceCount),
              p.name,
            ]),
          ),
        );
      }
      out('');
      out(
        `Profile-level sources (${res.profileSources.length}) · ${res.profileFactCount} profile facts`,
      );
      for (const line of sourceLines(res.profileSources)) out(line);
    });

  const profile = candidate.command('profile').description('profile values');
  profile
    .command('show')
    .description('print profile values')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().getCandidate({});
      const entries = Object.fromEntries(res.profile.map((e) => [e.key, e.values]));
      if (opts.json) return json(entries);
      const known = new Map(res.profile.map((e) => [e.key, e.values]));
      const keys = [...new Set([...PROFILE_LIST_KEYS, ...STANDARD_KEYS, ...known.keys()])];
      for (const key of keys)
        out(`${key.padEnd(20)} ${(known.get(key) ?? []).join(', ') || '(not set)'}`);
    });
  profile
    .command('set <key> [value...]')
    .description(
      `set a profile value (empty clears it). Lists (comma-separated): ${PROFILE_LIST_KEYS.join(', ')}. Form fields: ${STANDARD_KEYS.join(', ')}`,
    )
    .action(async (key: string, value: string[]) => {
      let raw = value.join(' ');
      if (key === 'base_cv_file' && raw) {
        raw = resolve(raw);
        if (!existsSync(raw)) throw new Error(`no file at ${raw}`);
      }
      const res = await client().setProfileValue({ key, value: raw });
      out(`${res.entry?.key}: ${res.entry?.values.join(', ') || '(cleared)'}`);
    });

  registerPrefs(candidate, client);
  registerInterview(program, candidate, client);

  const project = candidate.command('project').description('projects');
  project
    .command('add <name>')
    .description('add a project')
    .option('--slug <slug>', 'short handle (default: from the name)')
    .option('--summary <text>', 'what it is, in a sentence')
    .option('--role <text>', 'your role')
    .option('--period <text>', 'e.g. "2021–2023"')
    .option('--stack <list>', 'comma-separated technologies')
    .option('--json', 'print JSON')
    .action(
      async (
        name: string,
        opts: {
          slug?: string;
          summary?: string;
          role?: string;
          period?: string;
          stack?: string;
          json?: boolean;
        },
      ) => {
        const res = await client().createProject({
          name,
          slug: opts.slug,
          summary: opts.summary,
          role: opts.role,
          period: opts.period,
          stack: list(opts.stack),
        });
        const p = res.project;
        if (!p) throw new Error('daemon returned no project');
        if (opts.json) return json(projectJson(p));
        out(
          `Added project ${p.slug} (#${p.id}). Add sources with \`applyant candidate source add ${p.slug} …\``,
        );
      },
    );
  project
    .command('list')
    .description('list projects')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listProjects({});
      if (opts.json) return json(res.projects.map(projectJson));
      if (res.projects.length === 0)
        return out('No projects yet. Add one with `applyant candidate project add <name>`.');
      out(
        table(
          ['SLUG', 'FACTS', 'UNCONFIRMED', 'SOURCES', 'PERIOD', 'NAME'],
          res.projects.map((p) => [
            p.slug,
            String(p.factCount),
            String(p.unconfirmedCount),
            String(p.sourceCount),
            p.period ?? '',
            p.name,
          ]),
        ),
      );
    });
  project
    .command('show <project>')
    .description('show one project with its sources')
    .option('--json', 'print JSON')
    .action(async (ref: string, opts: { json?: boolean }) => {
      const res = await client().getProject({ ref });
      const p = res.project;
      if (!p) throw new Error(`no project "${ref}"`);
      if (opts.json) return json({ ...projectJson(p), sourceList: res.sources.map(sourceJson) });
      out(`${p.name} (${p.slug}, #${p.id})`);
      if (p.summary) out(p.summary);
      out(`Role     ${p.role ?? '-'}`);
      out(`Period   ${p.period ?? '-'}`);
      out(`Stack    ${p.stack.join(', ') || '-'}`);
      out(
        `Facts    ${p.factCount} (${p.unconfirmedCount} unconfirmed, ${p.confirmedCount} confirmed)`,
      );
      out(`Sources (${res.sources.length})`);
      for (const line of sourceLines(res.sources)) out(line);
      if (p.factCount) out(`\nSee the facts with \`applyant candidate fact list ${p.slug}\`.`);
    });

  const source = candidate.command('source').description('knowledge sources');
  source
    .command('add <project> <kind> <locator>')
    .description(
      'add a source and sync it: kind is file | url | github | drive (a Docs or Drive link, read through the Google account connected with `mail connect gmail`); project "profile" (or "-") for a CV that covers many projects',
    )
    .option('--json', 'print JSON')
    .action(
      async (projectRef: string, kindArg: string, locator: string, opts: { json?: boolean }) => {
        const kind = SOURCE_KINDS[kindArg];
        if (kind === undefined)
          throw new Error(`unknown source kind "${kindArg}" (file | url | github | drive)`);
        let value = locator;
        if (kind === SourceKind.FILE) {
          value = resolve(locator);
          if (!existsSync(value)) throw new Error(`no file at ${value}`);
        }
        const profileLevel = projectRef === '-' || projectRef === 'profile';
        const res = await client().addSource({
          project: profileLevel ? '' : projectRef,
          kind,
          locator: value,
        });
        const s = res.source;
        if (!s) throw new Error('daemon returned no source');
        if (opts.json) return json({ created: res.created, source: sourceJson(s) });
        out(
          res.created
            ? `Added source #${s.id} (${kindName(s.kind)}), syncing: ${s.locator}\nFollow it with \`applyant runs show --follow\`.`
            : `Already a source (#${s.id}): ${s.locator}. Re-sync with \`applyant candidate sync --force\`.`,
        );
      },
    );

  candidate
    .command('sync [target]')
    .description(
      're-read sources and extract facts: all, one project, "profile", or a kind (file | url | github | drive)',
    )
    .option('--force', 're-extract even when a source has not changed')
    .option('--json', 'print JSON')
    .action(async (target: string | undefined, opts: { force?: boolean; json?: boolean }) => {
      const res = await client().syncSources({ target: target ?? '', force: !!opts.force });
      if (opts.json) {
        return json({
          sources: res.sources.map(sourceJson),
          enqueued: res.enqueuedSourceIds.map(Number),
        });
      }
      if (res.sources.length === 0) return out('No sources to sync.');
      const queued = new Set(res.enqueuedSourceIds.map(Number));
      for (const s of res.sources) {
        out(
          `#${s.id} ${kindName(s.kind).padEnd(6)} ${queued.has(Number(s.id)) ? 'queued    ' : 'in progress'} ${s.locator}`,
        );
      }
    });

  const fact = candidate.command('fact').description('facts about you, with their evidence');
  fact
    .command('list [project]')
    .description('list facts (of one project, or "profile" for profile-level facts)')
    .option('--status <status>', 'unconfirmed | confirmed | rejected')
    .option('--json', 'print JSON')
    .action(async (projectRef: string | undefined, opts: { status?: string; json?: boolean }) => {
      let status = FactStatus.UNSPECIFIED;
      if (opts.status) {
        const s = FACT_STATUSES[opts.status];
        if (s === undefined)
          throw new Error(`unknown status "${opts.status}" (unconfirmed | confirmed | rejected)`);
        status = s;
      }
      const res = await client().listFacts({ project: projectRef ?? '', status });
      if (opts.json) return json(res.facts.map(factJson));
      if (res.facts.length === 0) return out('No facts yet.');
      let group: string | null | undefined;
      for (const f of res.facts) {
        const g = f.projectSlug ?? null;
        if (g !== group) {
          out(group === undefined ? (g ?? '(profile)') : `\n${g ?? '(profile)'}`);
          group = g;
        }
        for (const line of factLines(f)) out(line);
      }
      const open = res.facts.filter((f) => f.status === FactStatus.UNCONFIRMED).length;
      if (open) {
        out(
          `\n${open} unconfirmed. Confirm with \`applyant candidate fact confirm <id…>\`, fix with \`fact edit <id> "<text>"\`, or \`fact reject <id…>\`.`,
        );
      }
    });
  fact
    .command('confirm <ids...>')
    .description('confirm facts are true')
    .action(async (values: string[]) => {
      const res = await client().confirmFact({ ids: ids(values) });
      for (const f of res.facts) out(`✓ #${f.id} ${f.text}`);
    });
  fact
    .command('edit <id> <text...>')
    .description('rewrite a fact in your own words (this confirms it)')
    .action(async (idArg: string, text: string[]) => {
      const [id] = ids([idArg]);
      const res = await client().editFact({ id: id ?? 0n, text: text.join(' ') });
      out(`✓ #${res.fact?.id} ${res.fact?.text}`);
    });
  fact
    .command('reject <ids...>')
    .description('mark facts as untrue (a re-sync will not bring them back)')
    .action(async (values: string[]) => {
      const res = await client().rejectFact({ ids: ids(values) });
      for (const f of res.facts) out(`✗ #${f.id} ${f.text}`);
    });
}
