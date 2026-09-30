// The audit's minor gaps: notes and contacts on an application, model runs, the CV template and
// searching postings by text.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, applications, companies, postings, tasks } from '../src/db/schema.ts';
import { loadTemplate } from '../src/domain/applications/cv/render.ts';
import { listPostings } from '../src/domain/search/postings.ts';
import { EventBus } from '../src/queue/events.ts';
import { listAgentRuns } from '../src/rpc/agent-runs.ts';
import { applicationRpcs } from '../src/rpc/applications.ts';
import { cvTemplateRpcs } from '../src/rpc/cv-template.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

// biome-ignore lint/suspicious/noExplicitAny: the handlers' second argument is unused
const ctx = {} as any;
const now = new Date('2026-09-30T10:00:00Z');

describe('minor gaps', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  const addApp = (title: string, company: string, n: number, text = '') => {
    const posting = t.db
      .insert(postings)
      .values({
        stage: 'scored',
        canonicalUrl: `https://jobs.example.com/${n}`,
        title,
        company,
        text,
      })
      .returning()
      .get();
    return t.db
      .insert(applications)
      .values({ postingId: posting.id, stage: 'applied' })
      .returning()
      .get();
  };

  it('keeps notes and contacts on an application, and refuses an empty or malformed contact', async () => {
    const rpc = applicationRpcs({ db: t.db, bus: new EventBus(), now: () => now }) as Required<
      ReturnType<typeof applicationRpcs>
    >;
    const app = addApp('Backend Engineer', 'Helix', 1);
    const noted = await rpc.setApplicationNotes(
      { applicationId: BigInt(app.id), notes: '  Call went well; ask about on-call.  ' } as never,
      ctx,
    );
    expect(noted.application?.notes).toBe('Call went well; ask about on-call.');
    const added = await rpc.addApplicationContact(
      {
        applicationId: BigInt(app.id),
        name: 'Anna Berg',
        role: 'recruiter',
        email: 'anna@helix.example',
        linkedin: 'linkedin.com/in/annaberg',
      } as never,
      ctx,
    );
    expect(added.contact?.linkedin).toBe('https://linkedin.com/in/annaberg');
    expect((added.application?.contacts ?? []).map((c) => c.name)).toEqual(['Anna Berg']);
    const got = await rpc.getApplication({ id: BigInt(app.id) } as never, ctx);
    expect(got.application?.contacts).toHaveLength(1);
    expect(got.application?.notes).toMatch(/on-call/);

    expect(() =>
      rpc.addApplicationContact({ applicationId: BigInt(app.id), role: 'recruiter' } as never, ctx),
    ).toThrow(/needs a name, an email or a LinkedIn/);
    expect(() =>
      rpc.addApplicationContact({ applicationId: BigInt(app.id), email: 'nope' } as never, ctx),
    ).toThrow(/isn't an email/);
    expect(() =>
      rpc.addApplicationContact({ applicationId: 999n, name: 'X' } as never, ctx),
    ).toThrow(/no application 999/);

    const removed = await rpc.deleteApplicationContact(
      { contactId: added.contact?.id ?? 0n } as never,
      ctx,
    );
    expect(removed.application?.contacts).toEqual([]);
    expect(() => rpc.deleteApplicationContact({ contactId: 77n } as never, ctx)).toThrow(
      /no contact 77/,
    );
    const cleared = await rpc.setApplicationNotes(
      { applicationId: BigInt(app.id), notes: '' } as never,
      ctx,
    );
    expect(cleared.application?.notes).toBeUndefined();
  });

  it('lists model runs newest first with the entity each task was for', () => {
    const app = addApp('Backend Engineer', 'Helix', 1);
    const company = t.db
      .insert(companies)
      .values({ key: 'helix', name: 'Helix' })
      .returning()
      .get();
    const task1 = t.db
      .insert(tasks)
      .values({ kind: 'prepare_application', entityId: app.id })
      .returning()
      .get();
    const task2 = t.db
      .insert(tasks)
      .values({ kind: 'research_company', entityId: company.id })
      .returning()
      .get();
    const base = { provider: 'claude', durationMs: 1200, outcome: 'ok' };
    t.db
      .insert(agentRuns)
      .values([
        {
          ...base,
          taskId: task1.id,
          role: 'application_writer',
          model: 'opus',
          startedAt: new Date(now.getTime() - 60_000),
          inputTokens: 1500,
          outputTokens: 300,
        },
        {
          ...base,
          taskId: task2.id,
          role: 'researcher',
          startedAt: now,
          outcome: 'error',
          error: 'limit',
        },
        { ...base, taskId: null, role: 'scorer', startedAt: new Date(now.getTime() - 120_000) },
      ])
      .run();
    const runs = listAgentRuns(t.db, { limit: 0 });
    expect(runs.map((r) => r.role)).toEqual(['researcher', 'application_writer', 'scorer']);
    expect(runs[0]?.entityLabel).toBe('Helix');
    expect(runs[0]?.error).toBe('limit');
    expect(runs[1]?.entityKind).toBe('application');
    expect(runs[1]?.entityLabel).toBe('Backend Engineer at Helix');
    expect(runs[1]?.inputTokens).toBe(1500n);
    expect(runs[2]?.taskKind).toBeUndefined();
    expect(listAgentRuns(t.db, { limit: 10, role: 'scorer' })).toHaveLength(1);
  });

  it('installs a custom CV template, reports a broken one and resets to Clean', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cv-template-'));
    const dir = join(home, 'cv-template');
    try {
      const rpc = cvTemplateRpcs(dir) as Required<ReturnType<typeof cvTemplateRpcs>>;
      const before = await rpc.getCvTemplate({} as never, ctx);
      expect(before.template?.custom).toBe(false);
      expect(before.template?.name).toBe('Clean');
      const enc = (s: string) => new TextEncoder().encode(s);
      const set = await rpc.setCvTemplate(
        {
          name: 'Letterhead',
          files: [
            { path: 'index.html', content: enc('<html><style>{{style}}</style>{{cv}}</html>') },
            { path: 'style.css', content: enc('body{color:#123}') },
            { path: 'fonts/Inter.woff2', content: new Uint8Array([1, 2, 3]) },
          ],
        } as never,
        ctx,
      );
      expect(set.template).toMatchObject({ custom: true, name: 'Letterhead', dir });
      expect(set.template?.files).toEqual(['fonts/Inter.woff2', 'index.html', 'style.css']);
      expect(loadTemplate(dir).css).toBe('body{color:#123}');

      for (const [files, why] of [
        [[{ path: 'style.css', content: enc('') }], /needs an index.html/],
        [[{ path: 'index.html', content: enc('<html/>') }], /needs a \{\{cv\}\}/],
        [[{ path: '../x.html', content: enc('{{cv}}') }], /isn't a file inside/],
      ] as const) {
        expect(() => rpc.setCvTemplate({ files } as never, ctx)).toThrow(why);
      }
      // A refused set leaves the installed template as it was.
      expect((await rpc.getCvTemplate({} as never, ctx)).template?.name).toBe('Letterhead');

      const reset = await rpc.resetCvTemplate({} as never, ctx);
      expect(reset.template).toMatchObject({ custom: false, name: 'Clean' });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('searches postings by every word over title, company, URL and text', () => {
    addApp('Backend Engineer', 'Helix', 1, 'Rust and Postgres, remote in Europe');
    addApp('iOS Engineer', 'Orbit', 2, 'Swift, Berlin');
    addApp('Data Scientist', 'Helix', 3, 'Python');
    const titles = (q: string) => listPostings(t.db, undefined, false, q).map((p) => p.title);
    expect(titles('helix')).toEqual(['Data Scientist', 'Backend Engineer']);
    expect(titles('ENGINEER rust')).toEqual(['Backend Engineer']);
    expect(titles('berlin')).toEqual(['iOS Engineer']);
    expect(titles('golang')).toEqual([]);
    expect(titles('  ')).toHaveLength(3);
  });
});
