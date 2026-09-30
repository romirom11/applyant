// Folder sources and removing a source: a local folder is read file by file (hidden, binary,
// dependency and oversized files left out) and its facts cite the file they came from; a Drive
// folder is listed page by page through a local fake of the Drive API; removing a source takes
// its evidence and the facts only it gave, and leaves the candidate's own words.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { events, evidence, facts, sources, tasks } from '../src/db/schema.ts';
import { addEvidence } from '../src/domain/knowledge/evidence.ts';
import { confirmFact, editFact, listFacts } from '../src/domain/knowledge/facts.ts';
import {
  type DriveAccess,
  driveLocator,
  GoogleDrive,
} from '../src/domain/knowledge/sources/drive.ts';
import { fileLocator, readFolderSource } from '../src/domain/knowledge/sources/folder.ts';
import {
  addSource,
  deleteSource,
  isFolderSource,
  SourceError,
} from '../src/domain/knowledge/sources/registry.ts';
import { syncSource } from '../src/domain/knowledge/sync.ts';
import { NodeTextExtractor } from '../src/domain/knowledge/text/extract.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { SourceExtraction } from '../src/models/schemas/index.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

const CV = fileURLToPath(new URL('./fixtures/cv/cv.pdf', import.meta.url));
const FOLDER_ID = '1PortfolioFolder0123456789abcdef';
const SUB_ID = '1TalksSubfolder0123456789abcdefg';
const DOC_ID = '1HarborCaseStudy0123456789abcdef';
const NOTES_ID = '1NotesTextFile0123456789abcdefgh';
const PNG_ID = '1DiagramImage0123456789abcdefghi';
const HIDDEN_ID = '1HiddenNotes0123456789abcdefghij';
const SLIDES_NOTES_ID = '1TalkNotesText0123456789abcdefgh';

/** A folder with what a real one has: documents, a nested dir, dot files, a binary, deps. */
function makeFolder(root: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(
    join(root, 'README.md'),
    '# Harbor\n\nI designed the streaming call-analysis pipeline that replaced the nightly batch.\n',
  );
  writeFileSync(
    join(root, 'notes', 'architecture.md'),
    '# Queue\n\nThe team moved the queue to Kafka in 2023.\n',
  );
  copyFileSync(CV, join(root, 'notes', 'cv.pdf'));
  writeFileSync(join(root, 'notes', 'todo'), 'Plain text without an extension: still read.\n');
  writeFileSync(join(root, '.secret.md'), 'hidden notes');
  writeFileSync(join(root, '.git', 'config'), '[core]');
  writeFileSync(join(root, 'node_modules', 'left-pad', 'README.md'), '# left-pad');
  writeFileSync(join(root, 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2]));
  writeFileSync(join(root, 'big.log'), 'x'.repeat(64 * 1024));
}

describe('folder material', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  it('reads documents in nested folders and leaves out hidden, binary and oversized files', async () => {
    const root = join(t.dir, 'portfolio');
    makeFolder(root);
    const m = await readFolderSource(`${root}/`, new NodeTextExtractor(), {
      maxFiles: 200,
      maxFileBytes: 40_000,
      maxTotalBytes: 10 * 1024 * 1024,
      maxDepth: 6,
    });
    expect(m.parts?.map((p) => p.path)).toEqual([
      'notes/architecture.md',
      'notes/cv.pdf',
      'notes/todo',
      'README.md',
    ]);
    expect(m.text).toContain('=== file: notes/cv.pdf (pdf) ===\n[page 1]');
    expect(m.text).toContain('=== file: notes/todo (text) ===');
    expect(m.text).not.toMatch(/hidden notes|left-pad|\[core\]/);
    expect(m.label).toBe('portfolio/ · 4 files · 2 skipped');
    expect(m.locatorRules).toContain('notes/architecture.md · section: Queue');
  });

  it('stops at the file and depth limits', async () => {
    const root = join(t.dir, 'portfolio');
    makeFolder(root);
    const m = await readFolderSource(root, new NodeTextExtractor(), {
      maxFiles: 1,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 1024 * 1024,
      maxDepth: 0,
    });
    expect(m.parts?.map((p) => p.path)).toEqual(['big.log']);
    expect(m.label).toBe('portfolio/ · 1 files · 3 skipped');
    await expect(readFolderSource(join(t.dir, 'missing'), new NodeTextExtractor())).rejects.toThrow(
      /folder not found/,
    );
    const empty = join(t.dir, 'empty');
    mkdirSync(empty);
    writeFileSync(join(empty, 'a.png'), Buffer.from([0, 1, 2]));
    await expect(readFolderSource(empty, new NodeTextExtractor())).rejects.toThrow(
      /no readable files .* skipped: a\.png \(binary\)/,
    );
  });

  it('puts the file in front of a locator that lacks it', () => {
    const parts = [
      { path: 'README.md', text: 'I designed the streaming pipeline' },
      { path: 'notes/a.md', text: 'The team moved the queue to Kafka' },
    ];
    expect(fileLocator(parts, 'notes/a.md · section: Queue', null)).toBe(
      'notes/a.md · section: Queue',
    );
    expect(fileLocator(parts, 'section: Queue', 'moved the  queue')).toBe(
      'notes/a.md · section: Queue',
    );
    expect(fileLocator(parts, null, 'streaming pipeline')).toBe('README.md');
    expect(fileLocator(parts, 'start', null)).toBe('start');
    expect(fileLocator(parts.slice(0, 1), 'start', null)).toBe('README.md · start');
  });
});

interface FakeDrive {
  origin: string;
  server: Server;
  requests: string[];
}

/** files.get, files.export, alt=media and files.list for one folder tree. */
async function fakeDrive(): Promise<FakeDrive> {
  const d: FakeDrive = { origin: '', server: null as never, requests: [] };
  const file = (id: string, name: string, mimeType: string, size?: number) => ({
    id,
    name,
    mimeType,
    modifiedTime: '2026-09-01T08:00:00.000Z',
    ...(size === undefined ? {} : { size: String(size) }),
  });
  const folder = 'application/vnd.google-apps.folder';
  const meta: Record<string, ReturnType<typeof file>> = {
    [FOLDER_ID]: file(FOLDER_ID, 'Portfolio', folder),
    [SUB_ID]: file(SUB_ID, 'Talks', folder),
    [DOC_ID]: file(DOC_ID, 'Harbor case study', 'application/vnd.google-apps.document'),
    [NOTES_ID]: file(NOTES_ID, 'notes.txt', 'text/plain', 40),
    [PNG_ID]: file(PNG_ID, 'diagram.png', 'image/png', 9),
    [HIDDEN_ID]: file(HIDDEN_ID, '.draft.txt', 'text/plain', 5),
    [SLIDES_NOTES_ID]: file(SLIDES_NOTES_ID, 'kafka-talk.md', 'text/markdown', 30),
  };
  // Two pages for the folder; one for the subfolder.
  const pages: Record<string, Array<Array<ReturnType<typeof file>>>> = {
    [FOLDER_ID]: [
      [meta[PNG_ID], meta[HIDDEN_ID], meta[DOC_ID]].filter((f) => f !== undefined),
      [meta[NOTES_ID], meta[SUB_ID]].filter((f) => f !== undefined),
    ],
    [SUB_ID]: [[meta[SLIDES_NOTES_ID]].filter((f) => f !== undefined)],
  };
  const bodies: Record<string, Buffer> = {
    [NOTES_ID]: Buffer.from('Mentored two junior engineers through their first on-call.'),
    [PNG_ID]: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2]),
    [HIDDEN_ID]: Buffer.from('draft'),
    [SLIDES_NOTES_ID]: Buffer.from('# Kafka at Harbor\n\nI gave the talk at PyCon Greece 2024.'),
  };
  d.server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    d.requests.push(`${u.pathname}${u.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/files') {
      const parent = /^'([\w-]+)' in parents and trashed = false$/.exec(
        u.searchParams.get('q') ?? '',
      )?.[1];
      const list = pages[parent ?? ''];
      if (!list) return json(404, { error: { message: 'File not found' } });
      const at = Number(u.searchParams.get('pageToken') ?? 0);
      return json(200, {
        files: list[at] ?? [],
        ...(at + 1 < list.length ? { nextPageToken: String(at + 1) } : {}),
      });
    }
    const m = /^\/files\/([\w-]+)(\/export)?$/.exec(u.pathname);
    const id = m?.[1] ?? '';
    if (!m || !meta[id]) return json(404, { error: { message: `File not found: ${id}.` } });
    if (m[2]) {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      return res.end('# What I built\n\nI designed the streaming pipeline for Harbor.');
    }
    if (u.searchParams.get('alt') === 'media') {
      res.writeHead(200);
      return res.end(bodies[id]);
    }
    return json(200, meta[id]);
  });
  await new Promise<void>((r) => d.server.listen(0, '127.0.0.1', r));
  d.origin = `http://127.0.0.1:${(d.server.address() as AddressInfo).port}`;
  return d;
}

const folderExtraction: SourceExtraction = {
  projects: [
    { name: 'Harbor', summary: 'Call analytics', role: null, period: null, stack: ['Python'] },
  ],
  facts: [
    {
      text: 'Designed the streaming call-analysis pipeline that replaced the nightly batch',
      kind: 'personal_contribution',
      project: 'Harbor',
      evidence: [{ locator: 'README.md · section: Harbor', quote: null }],
    },
    {
      text: 'The team moved the queue to Kafka in 2023',
      kind: 'team_context',
      project: 'Harbor',
      // No file in the locator: the quote finds it.
      evidence: [{ locator: 'section: Queue', quote: 'moved the queue to Kafka' }],
    },
    {
      text: 'Knows Python',
      kind: 'skill',
      project: null,
      evidence: [{ locator: 'notes/cv.pdf · page 2', quote: null }],
    },
  ],
};

describe('folder sources and removing a source', () => {
  let drive: FakeDrive;
  let t: TempDb;
  let bus: EventBus;
  let fake: FakeProvider;
  let worker: Worker;
  let access: DriveAccess;
  const now = new Date('2026-09-30T10:00:00Z');

  beforeAll(async () => {
    drive = await fakeDrive();
  });
  afterAll(() => {
    drive.server.close();
  });

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    fake = new FakeProvider('claude');
    drive.requests = [];
    access = {
      drive: async () =>
        new GoogleDrive({ auth: { accessToken: async () => 'drive-token' }, api: drive.origin }),
    };
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: {
        ...testDeps({ dir: t.dir, db: t.db, providers: [fake] }),
        drive: { drive: () => access.drive() },
      },
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
    t.db.select().from(sources).where(eq(sources.id, id)).get()?.syncNote ?? '';

  it('syncs a local folder into facts that cite their file', async () => {
    const root = join(t.dir, 'portfolio');
    makeFolder(root);
    fake.push({ output: folderExtraction });
    const { source } = addSource(t.db, bus, { project: null, kind: 'file', locator: root, now });
    expect(source.locator).toBe(`${root}/`);
    expect(isFolderSource(source)).toBe(true);
    await worker.idle();

    const prompt = fake.requests[0]?.prompt ?? '';
    expect(prompt).toContain('Source: portfolio/ · 5 files');
    expect(prompt).toContain('=== file: notes/architecture.md (text) ===');
    expect(prompt).not.toContain('hidden notes');
    const byText = (s: string) => listFacts(t.db).find((f) => f.text.includes(s));
    expect(byText('streaming')?.evidence[0]).toMatchObject({
      sourceKind: 'file',
      sourceLocator: `${root}/`,
      locator: 'README.md · section: Harbor',
    });
    expect(byText('Kafka')?.evidence[0]?.locator).toBe('notes/architecture.md · section: Queue');
    expect(byText('Python')?.evidence[0]?.locator).toBe('notes/cv.pdf · page 2');
    expect(note(source.id)).toMatch(/^3 new facts, 0 already known, 0 dropped/);
  });

  it('syncs a Drive folder, page by page and into its subfolders', async () => {
    const locator = driveLocator(
      `https://drive.google.com/drive/u/0/folders/${FOLDER_ID}?usp=sharing`,
    );
    expect(locator).toBe(`folder:${FOLDER_ID}`);
    fake.push({ output: { projects: [], facts: [] } });
    const { source } = addSource(t.db, bus, {
      project: null,
      kind: 'drive',
      locator: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      now,
    });
    expect(source.locator).toBe(`folder:${FOLDER_ID}`);
    expect(isFolderSource(source)).toBe(true);
    await worker.idle();

    const prompt = fake.requests[0]?.prompt ?? '';
    expect(prompt).toContain(
      'Source: Drive · Portfolio/ · edited 2026-09-01 · 3 files · 1 skipped',
    );
    expect(prompt).toContain('=== file: Harbor case study (markdown) ===\n# What I built');
    expect(prompt).toContain('=== file: notes.txt (text) ===\nMentored two junior engineers');
    expect(prompt).toContain('=== file: Talks/kafka-talk.md (text) ===\n# Kafka at Harbor');
    expect(prompt).not.toContain('draft');
    const lists = drive.requests.filter((r) => r.startsWith('/files?'));
    expect(lists).toHaveLength(3);
    expect(lists[1]).toContain('pageToken=1');
    // The hidden file is never downloaded; the image is, and is left out as binary.
    expect(drive.requests).not.toContain(`/files/${HIDDEN_ID}?supportsAllDrives=true&alt=media`);
    expect(note(source.id)).toMatch(/Drive · Portfolio\/ .* 3 files · 1 skipped$/);
  });

  it('removes a source with the facts only it gave, and keeps the candidate’s own', async () => {
    const root = join(t.dir, 'portfolio');
    makeFolder(root);
    fake.push({ output: folderExtraction });
    const { source } = addSource(t.db, bus, { project: null, kind: 'file', locator: root, now });
    await worker.idle();
    const byText = (s: string) => listFacts(t.db).find((f) => f.text.includes(s));
    const streaming = byText('streaming')?.id ?? 0;
    const kafka = byText('Kafka')?.id ?? 0;
    const python = byText('Python')?.id ?? 0;

    // The candidate confirmed one fact and edited another; a second source also gives Python.
    confirmFact(t.db, streaming, now);
    editFact(t.db, kafka, 'I moved the queue to Kafka in 2023', now);
    const other = t.db
      .insert(sources)
      .values({ projectId: null, kind: 'url', locator: 'https://me.dev', createdAt: now })
      .returning()
      .get();
    addEvidence(t.db, python, other.id, [{ locator: '#skills', excerpt: null }]);
    // And an interview answer, with no source at all.
    const interview = t.db
      .insert(facts)
      .values({
        projectId: null,
        text: 'I run the on-call rotation',
        kind: 'role',
        status: 'confirmed',
        origin: 'interview',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const res = deleteSource(t.db, bus, source.id, now);
    expect(res.factsRemoved).toBe(1);
    expect(t.db.select().from(sources).where(eq(sources.id, source.id)).get()).toBeUndefined();
    expect(t.db.select().from(evidence).where(eq(evidence.sourceId, source.id)).all()).toHaveLength(
      0,
    );
    const left = listFacts(t.db).map((f) => f.id);
    // Confirmed but only this source's: gone. Edited (the candidate's words): stays.
    expect(left).not.toContain(streaming);
    expect(left).toContain(kafka);
    expect(left).toContain(python);
    expect(left).toContain(interview.id);
    expect(byText('Python')?.evidence.map((e) => e.sourceId)).toEqual([other.id]);

    // Postings are matched again, and the removal is an event.
    expect(
      t.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.kind, 'rematch_postings'), eq(tasks.status, 'queued')))
        .all(),
    ).toHaveLength(1);
    expect(
      t.db.select().from(events).where(eq(events.kind, 'source.removed')).get()?.message,
    ).toMatch(/1 facts went with it/);

    expect(() => deleteSource(t.db, bus, source.id, now)).toThrow(SourceError);
  });
});
