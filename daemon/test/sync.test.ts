// sync_source on file sources: a CV drafts projects and facts; re-syncs respect what the
// candidate already confirmed, edited or rejected.
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects, sources } from '../src/db/schema.ts';
import { getCvSuggestions } from '../src/domain/knowledge/cv-header.ts';
import { confirmFact, editFact, listFacts, rejectFact } from '../src/domain/knowledge/facts.ts';
import {
  getIdentities,
  getStandardProfile,
  setProfileValue,
} from '../src/domain/knowledge/profile.ts';
import { createProject, listProjects } from '../src/domain/knowledge/projects.ts';
import { addSource, requestSync } from '../src/domain/knowledge/sources/registry.ts';
import { syncSource } from '../src/domain/knowledge/sync.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { SourceExtraction } from '../src/models/schemas/index.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

const CV = fileURLToPath(new URL('./fixtures/cv/cv.pdf', import.meta.url));

const fact = (
  text: string,
  kind: SourceExtraction['facts'][number]['kind'],
  project: string | null,
  locator = 'page 1 · Experience',
) => ({ text, kind, project, evidence: [{ locator, quote: null }] });

const cvExtraction: SourceExtraction = {
  projects: [
    {
      name: 'Nightingale',
      kind: 'position',
      summary: 'Call analytics at Acme Voice',
      role: 'Senior Backend Engineer',
      period: '2021–2024',
      stack: ['Python', 'FastAPI'],
    },
    {
      name: 'Ledgerly',
      kind: 'position',
      summary: null,
      role: 'Backend Engineer',
      period: '2018–2021',
      stack: ['Go', 'PostgreSQL'],
    },
  ],
  facts: [
    fact(
      'Designed and built the asynchronous call-analysis pipeline in Python and FastAPI',
      'personal_contribution',
      'Nightingale',
    ),
    fact('Led a team of 4 engineers', 'role', 'Nightingale'),
    fact(
      'Cut transcription cost by 35% by moving batch jobs to spot instances',
      'impact',
      'Nightingale',
    ),
    fact(
      'Wrote the invoice reconciliation service in Go and PostgreSQL',
      'personal_contribution',
      'Ledgerly',
    ),
    fact(
      'MSc Computer Science, National Technical University of Athens, 2017',
      'education',
      null,
      'page 2 · Education',
    ),
  ],
};

describe('sync_source on a CV', () => {
  let t: TempDb;
  let bus: EventBus;
  let fake: FakeProvider;
  let worker: Worker;
  const now = new Date('2026-09-27T10:00:00Z');

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    fake = new FakeProvider('claude');
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir, db: t.db, providers: [fake] }),
      handlers: handlers({ sync_source: syncSource }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    t.cleanup();
  });

  const note = (id: number) =>
    t.db.select().from(sources).where(eq(sources.id, id)).get()?.syncNote;

  it('drafts projects and unconfirmed facts with page evidence', async () => {
    // A project the candidate already created is reused, not duplicated.
    createProject(t.db, { name: 'Nightingale', role: 'Tech lead' }, now);
    fake.push({ output: cvExtraction });
    const cv = join(t.dir, 'cv.pdf');
    copyFileSync(CV, cv);
    const { source } = addSource(t.db, bus, { project: null, kind: 'file', locator: cv, now });
    await worker.idle();

    const prompt = fake.requests[0]?.prompt ?? '';
    expect(prompt).toContain('This source is about the candidate as a whole');
    expect(prompt).toContain('"Nightingale"');
    expect(prompt).toContain('[page 2]\nSkills');

    const ps = listProjects(t.db);
    expect(ps.map((p) => p.slug)).toEqual(['ledgerly', 'nightingale']);
    // What the candidate typed stays; missing fields are filled.
    expect(ps.find((p) => p.slug === 'nightingale')).toMatchObject({
      role: 'Tech lead',
      period: '2021–2024',
      stack: ['Python', 'FastAPI'],
      facts: 3,
      unconfirmed: 3,
    });
    const all = listFacts(t.db);
    expect(all.every((f) => f.status === 'unconfirmed' && f.origin === 'extracted')).toBe(true);
    expect(all.find((f) => f.kind === 'education')).toMatchObject({ projectId: null });
    expect(all.find((f) => f.text.includes('pipeline'))?.evidence[0]).toMatchObject({
      sourceKind: 'file',
      sourceLocator: cv,
      locator: 'page 1 · Experience',
    });
    expect(note(source.id)).toMatch(
      /^5 new facts, 0 already known, 0 dropped · 1 projects created · cv\.pdf · pdf · 2 pages$/,
    );
  });

  it("reads the CV's header once: the profile's empty fields, and what the draft suggests", async () => {
    // What the candidate typed is never replaced.
    setProfileValue(t.db, 'email', 'typed@example.org', now);
    fake.push(
      { output: cvExtraction },
      {
        output: {
          fullName: 'Alex Example',
          email: 'alex@example.com',
          phone: '+30 690 000 0000',
          location: 'Athens, Greece',
          city: 'Athens',
          country: 'gr',
          github: 'https://github.com/alex-example',
          linkedin: 'not a link',
          website: null,
          currentTitle: 'Senior Backend Engineer',
          currentCompany: 'Acme Voice',
          languages: [
            { code: 'EN', level: 'C1' },
            { code: 'el', level: 'native' },
          ],
          targetRoles: ['Backend Engineer', ' Platform Engineer ', 'Tech Lead'],
        },
      },
    );
    const cv = join(t.dir, 'cv.pdf');
    copyFileSync(CV, cv);
    const { source } = addSource(t.db, bus, { project: null, kind: 'file', locator: cv, now });
    await worker.idle();

    expect(fake.requests.map((r) => r.role)).toEqual(['extractor', 'extractor']);
    expect(getStandardProfile(t.db)).toMatchObject({
      full_name: 'Alex Example',
      email: 'typed@example.org',
      phone: '+30 690 000 0000',
      location: 'Athens, Greece',
      'links.github': 'https://github.com/alex-example',
      // Not a LinkedIn URL: left out rather than stored wrong.
      'links.linkedin': null,
      current_title: 'Senior Backend Engineer',
      current_company: 'Acme Voice',
    });
    expect(getIdentities(t.db).logins).toEqual(['alex-example']);
    expect(getCvSuggestions(t.db)).toMatchObject({
      city: 'Athens',
      country: 'GR',
      languages: [
        { code: 'en', level: 'C1' },
        { code: 'el', level: 'native' },
      ],
      roles: ['Backend Engineer', 'Platform Engineer', 'Tech Lead'],
    });
    expect(note(source.id)).toContain('profile filled from the CV: full_name, phone, location');

    // The same CV text is never read a second time.
    requestSync(t.db, bus, { target: null, force: false, now });
    await worker.idle();
    expect(fake.requests).toHaveLength(2);

    // Another document about the candidate (an assistant's notes) only adds what was missing.
    const notes = join(t.dir, 'assistant-notes.md');
    writeFileSync(
      notes,
      '# About me\nI live in Piraeus and also speak German. I want to be a CTO.',
    );
    fake.push(
      { output: { projects: [], facts: [] } },
      {
        output: {
          fullName: 'A. Example',
          email: null,
          phone: null,
          location: 'Piraeus',
          city: 'Piraeus',
          country: 'GR',
          github: null,
          linkedin: 'https://www.linkedin.com/in/alex-example',
          website: null,
          currentTitle: null,
          currentCompany: null,
          languages: [
            { code: 'en', level: 'B2' },
            { code: 'de', level: 'B1' },
          ],
          targetRoles: ['CTO', 'tech lead'],
        },
      },
    );
    addSource(t.db, bus, { project: null, kind: 'file', locator: notes, now });
    await worker.idle();
    expect(getStandardProfile(t.db)).toMatchObject({
      full_name: 'Alex Example',
      location: 'Athens, Greece',
      'links.linkedin': 'https://www.linkedin.com/in/alex-example',
    });
    expect(getCvSuggestions(t.db)).toMatchObject({
      city: 'Athens',
      languages: [
        { code: 'en', level: 'C1' },
        { code: 'el', level: 'native' },
        { code: 'de', level: 'B1' },
      ],
      roles: ['Backend Engineer', 'Platform Engineer', 'Tech Lead', 'CTO'],
    });
    // Neither text is read again.
    requestSync(t.db, bus, { target: null, force: false, now });
    await worker.idle();
    expect(fake.requests).toHaveLength(4);
  });

  it('does not call the model again for unchanged material, unless forced', async () => {
    fake.push({ output: cvExtraction });
    const cv = join(t.dir, 'cv.pdf');
    copyFileSync(CV, cv);
    const { source } = addSource(t.db, bus, { project: null, kind: 'file', locator: cv, now });
    await worker.idle();

    // Two runs so far: the facts, and the CV's header (not scripted here, so it's given up).
    expect(fake.requests).toHaveLength(2);
    requestSync(t.db, bus, { target: null, force: false, now });
    await worker.idle();
    expect(fake.requests).toHaveLength(2);
    expect(note(source.id)).toMatch(/^unchanged since the last sync/);

    // The candidate works through the draft.
    const facts = listFacts(t.db);
    const byText = (s: string) => facts.find((f) => f.text.includes(s))?.id ?? 0;
    confirmFact(t.db, byText('call-analysis pipeline'), now);
    rejectFact(t.db, byText('team of 4'), now);
    editFact(t.db, byText('35%'), 'Cut transcription cost by about a third', now);

    // A forced re-sync with a different extraction.
    fake.push({
      output: {
        projects: cvExtraction.projects,
        facts: [
          fact(
            'Designed and built the asynchronous call-analysis pipeline in Python and FastAPI.',
            'personal_contribution',
            'Nightingale',
          ),
          fact('Led a team of 4 engineers', 'role', 'Nightingale'),
          fact(
            'Maintained the Kafka event bus shared by 6 product teams',
            'personal_contribution',
            'Ledgerly',
          ),
        ],
      },
    });
    const res = requestSync(t.db, bus, { target: 'profile', force: true, now });
    expect(res.enqueued).toEqual([source.id]);
    await worker.idle();
    // The facts again; the same CV text's header is not read a second time.
    expect(fake.requests).toHaveLength(3);

    const after = listFacts(t.db);
    const texts = after.map((f) => `${f.status}: ${f.text}`).sort();
    expect(texts).toEqual(
      [
        'confirmed: Cut transcription cost by about a third', // edited: kept, although no longer extracted
        'confirmed: Designed and built the asynchronous call-analysis pipeline in Python and FastAPI', // same fact, new evidence
        'rejected: Led a team of 4 engineers', // stays rejected, not re-added
        'unconfirmed: Maintained the Kafka event bus shared by 6 product teams',
      ].sort(),
    );
    // Unconfirmed facts the source no longer supports were dropped.
    expect(note(source.id)).toMatch(/^1 new facts, 1 already known, 2 dropped/);
    const pipeline = after.find((f) => f.text.includes('pipeline'));
    expect(pipeline?.evidence).toHaveLength(1);
  });

  it('records a permanent read failure on the source without retrying', async () => {
    const cv = join(t.dir, 'cv.pdf');
    copyFileSync(CV, cv);
    const { source } = addSource(t.db, bus, { project: null, kind: 'file', locator: cv, now });
    rmSync(cv);
    await worker.idle();
    expect(fake.requests).toHaveLength(0);
    expect(note(source.id)).toBe(`sync failed: file not found: ${cv}`);
    expect(t.db.select().from(projects).all()).toHaveLength(0);
  });

  it('rejects sources it cannot read before any task runs', () => {
    expect(() =>
      addSource(t.db, bus, { project: null, kind: 'file', locator: 'relative.pdf', now }),
    ).toThrow(/absolute path/);
    expect(() =>
      addSource(t.db, bus, {
        project: null,
        kind: 'github',
        locator: 'https://github.com/a/b',
        now,
      }),
    ).toThrow(/belongs to a project/);
    expect(() => addSource(t.db, bus, { project: null, kind: 'drive', locator: 'x', now })).toThrow(
      /not a Google Drive link/,
    );
    expect(() =>
      addSource(t.db, bus, { project: null, kind: 'manual', locator: 'x', now }),
    ).toThrow(/can't be read yet/);
    expect(() =>
      addSource(t.db, bus, { project: 'nope', kind: 'url', locator: 'https://x.dev', now }),
    ).toThrow(/no project "nope"/);
  });
});
